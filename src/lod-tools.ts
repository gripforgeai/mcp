/**
 * The mesh levels (LOD) and optimised textures of a model, made on the developer's machine: the MCP side of `gripforge lod`.
 * The work is lod-local.generated.ts — the same code as the CLI, which runs the LOD kit (the compute service's manufacture,
 * the Rust simplifier of native/gripforge-lod). A model, a folder, or the bound models of a game (project_id): the server says
 * what each needs, only the missing copies are made here and handed back, so the service finds them and makes nothing.
 * Registered by `server.ts` only: the hosted MCP never reaches the caller's disk.
 */
import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';
import { ensureLodKit, glbsOf, lodFile, lodGame, LOD_PROFILES, type LodTransport } from './lod-local.generated.js';

export const LOD_TOOL_NAMES = ['gripforge_lod_build'] as const;

const ok = (data: object): CallToolResult => ({ structuredContent: data as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (error: unknown): CallToolResult => ({ isError: true, content: [{ type: 'text', text: String(error instanceof Error ? error.message : error).slice(0, 2000) }] });

function transport(options: { apiUrl: string; getApiKey: () => string | null | undefined }, workspace?: string): LodTransport {
  const origin = options.apiUrl.replace(/\/$/, '');
  const headers = (): Record<string, string> => {
    const key = options.getApiKey();
    if (!key) throw Error('GripForge API key required (GRIPFORGE_API_KEY) to read a game.');
    return { 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(workspace ? { 'x-workspace-id': workspace } : {}) };
  };
  const url = (path: string) => { if (!path.startsWith('/') || path.startsWith('//')) throw Error('Invalid API path.'); return new URL(path, origin); };
  return {
    origin,
    async json<T>(path: string) {
      const res = await fetch(url(path), { headers: { ...headers(), accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60_000) });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) throw Error(String(data.message || data.error || `GripForge returned HTTP ${res.status}.`));
      return data as T;
    },
    async bytes(path: string) {
      const res = await fetch(url(path), { headers: headers(), redirect: 'error', signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw Error(`GripForge returned HTTP ${res.status} for ${path}.`);
      return Buffer.from(await res.arrayBuffer());
    },
    async put(path: string, body: Buffer) {
      const res = await fetch(url(path), { method: 'PUT', headers: { ...headers(), 'content-type': 'model/gltf-binary' }, body: new Uint8Array(body), redirect: 'error', signal: AbortSignal.timeout(300_000) });
      return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
    },
  };
}

export function registerLodTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const abs = schema.string().min(1).max(4096);
  const shape = {
    path: abs.optional().describe('Absolute path of a model (.glb) or of a folder of models. Use this, or project_id.'),
    project_id: schema.string().regex(/^gkp_[A-Za-z0-9_-]{1,76}$/).optional().describe('A Game Kit project (gkp_…): its bound models. The server says what each needs (effective passport: global, then the game\'s own asset_passports); the missing copies are made here and kept by the server.'),
    passport: abs.optional().describe('Absolute path of the global passport of the model (.gfmesh.json). Default: <name>.gfmesh.json beside the model.'),
    override: schema.record(schema.string(), schema.unknown()).optional().describe('The game\'s keys over the passport (kits.lod): ratios, minTriangles, fit, maxError, screenSizes, castShadows, shadowLevel, shadowFit, minDistance, rule…'),
    kind: schema.string().max(40).optional().describe('prop, character, enemy, creatures… decides the defaults (default: character if the model is skinned, else prop).'),
    profiles: schema.array(schema.enum(['game', 'bevy'])).min(1).max(2).optional().describe('Which copies: game (KTX2 textures when the encoder is there) and bevy (WebP, the Rust web player). Default both.'),
    max_texture: schema.number().int().min(128).max(4096).optional().describe('Texture budget in pixels (default 1024).'),
    extra: abs.optional().describe('A locomotion pack (.glb on the same skeleton) to merge, as the service does for a champion\'s kit.'),
    out: abs.optional().describe('Folder of the copies (default <model folder>/gripforge-lod/<name>/).'),
    dry_run: schema.boolean().optional().describe('true: say what is missing, make nothing.'),
    push: schema.boolean().optional().describe('project_id only; default true: send the copies made to the server, which then makes nothing for them.'),
    kit: abs.optional().describe('A LOD kit folder you have (lod-kit.mjs); default: the release published with the CLI, checked and cached.'),
    bin: abs.optional().describe('The simplifier binary gripforge-lod, for a platform without a prebuilt one.'),
    workspace_id: schema.string().max(100).optional(),
  };
  register(LOD_TOOL_NAMES[0], {
    title: 'Mesh levels (LOD) and optimised textures, made locally',
    description: 'Make the mesh levels (LOD) and the optimised textures of a model on this machine, with the SAME code as the GripForge service (same Rust simplifier meshoptimizer, same file, same cache key). From the passport of the model (kits.lod: defaults of the usage, the global passport, then the game\'s override). Use it when an asset arrives and before delivery; with project_id it reads what each bound model needs, makes only the missing copies and gives them to the server. A copy already current is not made again. Guide: gripforge_docs { topic: "lod" }. 0 credits.',
    inputSchema: shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return fail(parsed.error.message);
    const a = parsed.data;
    try {
      if (!a.path === !a.project_id) throw Error('Pass path (a model or a folder) or project_id, not both.');
      for (const [label, p] of Object.entries({ path: a.path, passport: a.passport, extra: a.extra, out: a.out, kit: a.kit, bin: a.bin })) if (p && !isAbsolute(p)) throw Error(`${label} must be an absolute path (got ${p}).`);
      const kit = await ensureLodKit({ kit: a.kit, bin: a.bin });
      const profiles = a.profiles ?? [...LOD_PROFILES];
      if (a.project_id) return ok(await lodGame(transport(options, a.workspace_id), a.project_id, { kit, push: a.push !== false, out: a.out, profiles, dryRun: a.dry_run === true }));
      const path = resolve(a.path!);
      if (!existsSync(path)) throw Error(`${path} does not exist.`);
      const files = /\.glb$/i.test(path) ? [path] : await glbsOf(path);
      if (!files.length) throw Error(`No .glb in ${path}.`);
      const results = [];
      for (const file of files) results.push(await lodFile(file, { kit, out: files.length === 1 ? a.out : undefined, passport: a.passport, override: a.override, kind: a.kind, extra: a.extra, maxTexture: a.max_texture, profiles, dryRun: a.dry_run === true }));
      return ok({ models: results });
    } catch (error) { return fail(error); }
  });
}
