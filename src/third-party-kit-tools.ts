/**
 * Third-party kits of a game on the local files (this npm client only): declare, verify, list, remove. The work is
 * third-party-kit.generated.ts — the same code as `gripforge kit add|verify|list|remove` of the CLI. No API key,
 * no upload: the tools read and write the game file and the module named in the arguments, nothing else.
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';
import { addKit, listKits, removeKit, verifyKits } from './third-party-kit.generated.js';

export const THIRD_PARTY_KIT_TOOL_NAMES = ['gripforge_third_party_kit_add', 'gripforge_third_party_kit_verify', 'gripforge_third_party_kit_list', 'gripforge_third_party_kit_remove'] as const;

const GUIDE = 'Guide: gripforge_docs { topic: "kit-third-party" }.';
const ok = (data: object): CallToolResult => ({ structuredContent: data as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (error: unknown): CallToolResult => { const issues = String(error instanceof Error ? error.message : error).split('\n'); return { isError: true, structuredContent: { error: issues[0], issues }, content: [{ type: 'text', text: issues.join('\n') }] }; };
const absolute = (label: string, path: string) => { if (!isAbsolute(path)) throw Error(`${label} must be an absolute path (got ${path}).`); return path; };
const fileOrUrl = (label: string, value: string) => (/^https?:\/\//i.test(value) ? value : absolute(label, value));

export function registerThirdPartyKitTools(register: VfxProjectRegister, schema: typeof z = z) {
  const game = schema.string().min(1).max(4096).describe('Absolute path of the game: its game.json ({ "project": …, "lock": … }), or the folder that holds it (an exported web game).');
  const modules = schema.string().min(1).max(4096).optional().describe('Absolute path of a folder of kit modules (kit-modules.json) to check against and to install the module in. Default: <game folder>/runtime-rust/kit-modules, else <game folder>/kit-modules, when present.');
  const kitId = schema.string().min(3).max(120).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).describe('Id of the third-party kit, dotted, as its kit.json says (e.g. acme.streak).');

  register('gripforge_third_party_kit_add', {
    title: 'Declare a third-party kit in a game',
    description: `Declare a third-party kit — a kit of game logic compiled alone into one .wasm (a kit module), not one of GripForge's — in a local game. Reads the module (file or http(s) URL) and its kit.json, checks them (the binary against the manifest; against the core and the kits of the game's kit modules when the game has them; the kits it requires against the game), then writes: project.thirdPartyKits (source, sha256, manifest), its entry in project.installed (config), its place at the end of lock.order, and lock.thirdParty (version and sha256 frozen). A module given as a file is copied beside the game (third-party-kits/). A third-party module is loaded only when the game declares it; the page then plays the kit modules by itself. Use GripForge's kits first (gripforge_gamekit_search): a third-party kit is for a rule no kit has. check=true writes nothing. Calling it again with a new build replaces the kit. ${GUIDE}`,
    inputSchema: {
      game,
      wasm: schema.string().min(1).max(4096).describe('The kit module: absolute path of the .wasm, or an http(s) URL.'),
      manifest: schema.string().min(1).max(4096).describe('The kit.json of the kit: absolute path, or an http(s) URL.'),
      config: schema.record(schema.string(), schema.unknown()).optional().describe('Config of the kit in the game (what kx.config() returns). Kept from the previous declaration when omitted.'),
      modules,
      check: schema.boolean().optional().describe('true: check everything, write nothing.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    try {
      return ok(await addKit({ game: absolute('game', String(args.game)), wasm: fileOrUrl('wasm', String(args.wasm)), manifest: fileOrUrl('manifest', String(args.manifest)),
        config: args.config as Record<string, unknown> | undefined, modules: typeof args.modules === 'string' ? absolute('modules', args.modules) : undefined, check: args.check === true, signal: extra?.signal }));
    } catch (error) { return fail(error); }
  });

  register('gripforge_third_party_kit_verify', {
    title: 'Verify the third-party kits of a game',
    description: `Verify the third-party kits a local game declares (one with id): each module is read again from its source and must have the sha256 the game declares and its lock froze; its manifest must be what the binary says; the declaration, project.installed, the lock and the kit modules of the game must agree on the version. Answers ok and, per kit, the issues (each says what differs). Run it before an export and after fetching a game. ${GUIDE}`,
    inputSchema: { game, id: kitId.optional(), modules },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    try {
      const report = await verifyKits({ game: absolute('game', String(args.game)), id: typeof args.id === 'string' ? args.id : undefined, modules: typeof args.modules === 'string' ? absolute('modules', args.modules) : undefined, signal: extra?.signal });
      return { ...ok(report), ...(report.ok ? {} : { isError: true }) };
    } catch (error) { return fail(error); }
  });

  register('gripforge_third_party_kit_list', {
    title: 'List the third-party kits of a game',
    description: `The third-party kits a local game declares: id, version, source, sha256, whether each is installed, enabled and frozen by the lock, the kits it requires and the services it serves. ${GUIDE}`,
    inputSchema: { game },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try { return ok(listKits({ game: absolute('game', String(args.game)) })); } catch (error) { return fail(error); }
  });

  register('gripforge_third_party_kit_remove', {
    title: 'Remove a third-party kit from a game',
    description: `Remove a declared third-party kit from a local game: its declaration, its entry in project.installed, its lock lines, the copy of its module beside the game and its kit module. GripForge's kits are not removed by this tool (gripforge_gamekit_remove). ${GUIDE}`,
    inputSchema: { game, id: kitId, modules },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    try { return ok(removeKit({ game: absolute('game', String(args.game)), id: String(args.id), modules: typeof args.modules === 'string' ? absolute('modules', args.modules) : undefined })); } catch (error) { return fail(error); }
  });
}
