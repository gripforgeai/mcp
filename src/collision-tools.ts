/**
 * The collision of models, made on the developer's machine: the MCP side of `gripforge collision`.
 * The work is collision-local.generated.ts — the same code as the CLI, which runs the LOD kit's `collision` op (the compute
 * service's `buildCollision` and the Rust tool of native/gripforge-collision). A model, a folder, or the bound models of a
 * game (`game`, a gkp_ id): the server says what each needs, the missing descriptions are made here and handed back (or made
 * by the service with `server`). Each answer carries the CHOICE (method, score) and its reason. Registered by `server.ts`
 * only: the hosted MCP never reaches the caller's disk.
 */
import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';
import { ensureLodKit, glbsOf, type LodTransport } from './lod-local.generated.js';
import { COLLISION_SHAPE_NAMES, COLLISION_USAGE_NAMES, collisionFile, collisionGame, type CollisionBuilt } from './collision-local.generated.js';

export const COLLISION_TOOL_NAMES = ['gripforge_collision_build', 'gripforge_collision_check'] as const;

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
    async json<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const res = await fetch(url(path), { method: init.method ?? 'GET', headers: { ...headers(), accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) }, body: init.body === undefined ? undefined : JSON.stringify(init.body), redirect: 'error', signal: AbortSignal.timeout(300_000) });
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

export function registerCollisionTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const abs = schema.string().min(1).max(4096);
  const gkp = schema.string().regex(/^gkp_[A-Za-z0-9_-]{1,76}$/);
  const buildShape = {
    path: abs.optional().describe('Absolute path of a model (.glb) or of a folder of models. Use this, or game.'),
    game: gkp.optional().describe('A Game Kit project (gkp_…): its bound models. The server says what each needs (effective passport: global, then the game\'s own asset_passports); the missing collisions are made here and kept by the server (or made by the service with server: true).'),
    shape: schema.enum(COLLISION_SHAPE_NAMES).optional().describe('Impose a method (kits.collision.shape): auto (the tool chooses, default), none (traversable), box, compound, convex, convex_decomposition, trimesh (static decor only).'),
    usage: schema.enum(COLLISION_USAGE_NAMES).optional().describe('What the asset is (default: from its kind and category): decides the choice (ground, wall and structure → mesh or boxes; small objects stay traversable).'),
    mobile: schema.boolean().optional().describe('A moving object: never a triangle mesh.'),
    passport: abs.optional().describe('Absolute path of the global passport of the model (.gfmesh.json). Default: <name>.gfmesh.json beside the model.'),
    override: schema.record(schema.string(), schema.unknown()).optional().describe('The game\'s keys over the passport (kits.collision): shape, usage, mobile, maxParts, maxHullPoints, maxTriangles, resolution, small, parts.'),
    kind: schema.string().max(40).optional().describe('prop, character, enemy, creatures… decides the usage defaults.'),
    out: abs.optional().describe('Folder of collision.json (default <model folder>/gripforge-collision/<name>/).'),
    server: schema.boolean().optional().describe('game only: the GripForge service makes the missing ones instead of this machine.'),
    push: schema.boolean().optional().describe('game only; default true: send the descriptions made to the server.'),
    dry_run: schema.boolean().optional().describe('game only: say what is missing, make nothing.'),
    advice: schema.boolean().optional().describe('game only: ask the optional AI advice of the service on the ambiguous choices (on request only; the reason then says "AI advice: …").'),
    force_advice: schema.boolean().optional().describe('game only, with advice: ask it for every model, not only the ambiguous ones.'),
    check: schema.boolean().optional().describe('Only the level check: the warnings (massive fixed decor without collision), nothing made for a game.'),
    kit: abs.optional().describe('A LOD kit folder you have (lod-kit.mjs); default: the release published with the CLI, checked and cached.'),
    bin: abs.optional().describe('The collision binary gripforge-collision, for a platform without a prebuilt one.'),
    workspace_id: schema.string().max(100).optional(),
  };
  const checkShape = {
    game: gkp.describe('The Game Kit project (gkp_…) to check.'),
    workspace_id: schema.string().max(100).optional(),
  };
  register(COLLISION_TOOL_NAMES[0], {
    title: 'Collision of models, made locally (with the choice and its reason)',
    description: 'Make the collision of a model on this machine with the SAME code as the GripForge service (same Rust tool, same description gripforge.collision/1, same cache key). The tool analyses the model (concavity, proportions, size, usage, static or mobile) and CHOOSES the method (none, box, compound, convex, convex_decomposition, trimesh) unless the passport imposes one; the answer carries the method, the score and the reason. From the passport of the model (kits.collision, then the game\'s override). With game it reads what each bound model needs, makes only the missing ones and gives them to the server; it also returns the level check (warnings). Never add a collision by hand to a game: fix the passport. Guide: gripforge_docs { topic: "collision" }. 0 credits.',
    inputSchema: buildShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const parsed = schema.object(buildShape).strict().safeParse(args);
    if (!parsed.success) return fail(parsed.error.message);
    const a = parsed.data;
    try {
      if (!a.path === !a.game) throw Error('Pass path (a model or a folder) or game, not both.');
      for (const [label, p] of Object.entries({ path: a.path, passport: a.passport, out: a.out, kit: a.kit, bin: a.bin })) if (p && !isAbsolute(p)) throw Error(`${label} must be an absolute path (got ${p}).`);
      const override = { ...(a.override ?? {}), ...(a.shape ? { shape: a.shape } : {}), ...(a.usage ? { usage: a.usage } : {}), ...(a.mobile ? { mobile: true } : {}) };
      if (a.game) {
        const need = !a.server && !a.check && !a.dry_run;
        const kit = need ? await ensureLodKit({ kit: a.kit, bin: a.bin, tool: 'collision' }) : undefined;
        const report = await collisionGame(transport(options, a.workspace_id), a.game, { kit, push: a.push !== false, out: a.out, server: a.server === true, check: a.check === true, dryRun: a.dry_run === true, advice: a.advice === true || a.force_advice === true, force: a.force_advice === true });
        return ok(report);
      }
      const kit = await ensureLodKit({ kit: a.kit, bin: a.bin, tool: 'collision' });
      const path = resolve(a.path!);
      if (!existsSync(path)) throw Error(`${path} does not exist.`);
      const files = /\.glb$/i.test(path) ? [path] : await glbsOf(path);
      if (!files.length) throw Error(`No .glb in ${path}.`);
      const results: CollisionBuilt[] = [];
      for (const file of files) results.push(await collisionFile(file, { kit, out: files.length === 1 ? a.out : undefined, passport: a.passport, override: Object.keys(override).length ? override : undefined, kind: a.kind }));
      const warnings = results.flatMap((r) => (r.warning ? [r.warning] : []));
      return ok(a.check ? { warnings } : { models: results, warnings });
    } catch (error) { return fail(error); }
  });
  register(COLLISION_TOOL_NAMES[1], {
    title: 'Collision level check of a game',
    description: 'The level check of a game: fixed decor larger than 1.5 m that collides with nothing (its passport or the tool said none, or no collision was made yet) — a character would walk through it. Returns the warnings with the model, its size, the method and the reason; builds nothing. Fix by gripforge_collision_build, or by kits.collision.shape in the passport (never by hand in the game). Run it before delivering a level. 0 credits.',
    inputSchema: checkShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    const parsed = schema.object(checkShape).strict().safeParse(args);
    if (!parsed.success) return fail(parsed.error.message);
    try {
      const report = await collisionGame(transport(options, parsed.data.workspace_id), parsed.data.game, { check: true });
      return ok({ project: report.project, ok: report.warnings.length === 0, warnings: report.warnings, models: report.models });
    } catch (error) { return fail(error); }
  });
}
