/**
 * Third-party kits on the local files (this npm client only): build a kit of one's own on the build base, declare
 * it in a game (isolated, or trusted with the common memory), verify, list, remove. The work is
 * third-party-kit.generated.ts and kit-build.generated.ts — the same code as `gripforge kit build|socle|add|verify|
 * list|remove` of the CLI. No API key, no upload: the tools read and write the kit folder, the game file and the
 * module named in the arguments, nothing else. The build runs cargo on this machine (rustup, the pinned toolchain).
 */
import { isAbsolute } from 'node:path';
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';
import { addKit, listKits, removeKit, trustOf, verifyBuild, verifyKits } from './third-party-kit.generated.js';
import { buildKit, checkToolchain, findKitSdk } from './kit-build.generated.js';

export const THIRD_PARTY_KIT_TOOL_NAMES = ['gripforge_third_party_kit_build', 'gripforge_third_party_kit_socle', 'gripforge_third_party_kit_verify_build', 'gripforge_third_party_kit_add', 'gripforge_third_party_kit_verify', 'gripforge_third_party_kit_list', 'gripforge_third_party_kit_remove'] as const;

const GUIDE = 'Guide: gripforge_docs { topic: "kit-third-party" }.';
const ok = (data: object): CallToolResult => ({ structuredContent: data as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (error: unknown): CallToolResult => { const issues = String(error instanceof Error ? error.message : error).split('\n'); return { isError: true, structuredContent: { error: issues[0], issues }, content: [{ type: 'text', text: issues.join('\n') }] }; };
const absolute = (label: string, path: string) => { if (!isAbsolute(path)) throw Error(`${label} must be an absolute path (got ${path}).`); return path; };
const fileOrUrl = (label: string, value: string) => (/^https?:\/\//i.test(value) ? value : absolute(label, value));

export function registerThirdPartyKitTools(register: VfxProjectRegister, schema: typeof z = z) {
  const game = schema.string().min(1).max(4096).describe('Absolute path of the game: its game.json ({ "project": …, "lock": … }), or the folder that holds it (an exported web game).');
  const modules = schema.string().min(1).max(4096).optional().describe('Absolute path of a folder of kit modules (kit-modules.json) to check against and to install the module in. Default: <game folder>/runtime-rust/kit-modules, else <game folder>/kit-modules, when present.');
  const kitId = schema.string().min(3).max(120).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).describe('Id of the third-party kit, dotted, as its kit.json says (e.g. acme.streak).');

  const trust = schema.enum(['isolated', 'common']).optional().describe('How far the game trusts this kit. "common" (default): the kit is placed in the memory of the core and of the other kits, as a GripForge kit is — faster, and NOT isolated. "isolated": the kit keeps a memory of its own and cannot read or corrupt the game — choose it explicitly for a kit you do not trust. The build declared must be the one of that mode.');
  const sdk = schema.string().min(1).max(4096).optional().describe('Absolute path of the kit SDK: the kit-sdk folder of the GripForge CLI, or a GripForge checkout. Default: GRIPFORGE_KIT_SDK, else the SDK of the gripforge CLI found on PATH.');
  const build = schema.string().min(1).max(4096).optional().describe('Absolute path of the output folder of gripforge_third_party_kit_build (it holds build.json): the build of the trust asked is taken from it. Use this, or wasm + manifest.');

  register('gripforge_third_party_kit_build', {
    title: 'Build a kit of your own on the build base',
    description: `The common build tool of the kit logic modules: compiles the source of a kit of your own (a folder with kit.json — { "schema": "gripforge.kit-module/1", "id", "version", "services"?, "requires"?, "optional"? } — and src/lib.rs giving "pub fn module() -> Rc<dyn KitModule>"; no Cargo.toml, no export macro) on the base GripForge fixes: the pinned Rust toolchain with its components, the locked crates, the options of each mode. Writes, per mode, <id>-<version>.<mode>.wasm and its manifest .kit.json (provides/consumes read from the binary, sha256), plus build.json; checks each binary against the base (its mode, its structures table, the links it takes). Both modes by default: "isolated" (a memory of its own) and "common" (relocatable, for a game that trusts the kit). Runs cargo locally: the first build of the common mode rebuilds the standard library (a minute or two). When the toolchain is missing the error gives the one rustup command to run (install: true runs it; it adds a toolchain beside the others and never changes the default one). Then declare a build with gripforge_third_party_kit_add. ${GUIDE}`,
    inputSchema: {
      kit: schema.string().min(1).max(4096).describe('Absolute path of the kit folder (kit.json and the Rust source).'),
      out: schema.string().min(1).max(4096).optional().describe('Absolute path of the output folder. Default: <kit>/build.'),
      mode: schema.enum(['isolated', 'common', 'both']).optional().describe('Which build(s) to make. Default: both.'),
      install: schema.boolean().optional().describe('true: install the pinned toolchain with rustup when it is missing.'),
      target_dir: schema.string().min(1).max(4096).optional().describe('Absolute path of the cargo target folder. Default: <kit>/target/gripforge-kit.'),
      jobs: schema.number().int().min(1).max(64).optional().describe('Parallel jobs of cargo.'),
      sdk,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      return ok(buildKit({ kit: absolute('kit', String(args.kit)), out: typeof args.out === 'string' ? absolute('out', args.out) : undefined, mode: args.mode as 'isolated' | 'common' | 'both' | undefined, install: args.install === true,
        targetDir: typeof args.target_dir === 'string' ? absolute('target_dir', args.target_dir) : undefined, jobs: typeof args.jobs === 'number' ? args.jobs : undefined, sdk: typeof args.sdk === 'string' ? absolute('sdk', args.sdk) : undefined, quiet: true }));
    } catch (error) { return fail(error); }
  });

  register('gripforge_third_party_kit_socle', {
    title: 'The build base of the kit modules',
    description: `The build base a kit is compiled on (what gripforge_third_party_kit_build uses): the contract and the structures version, the pinned Rust toolchain with its components and target, the profile, the options of each mode, the locked crate versions, the links an isolated kit may take — and whether this machine is ready for it (toolchain.ok, toolchain.missing, toolchain.install: the one rustup command). ${GUIDE}`,
    inputSchema: { sdk, install: schema.boolean().optional().describe('true: install what is missing with rustup (the default toolchain is not changed).') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const found = findKitSdk(typeof args.sdk === 'string' ? absolute('sdk', args.sdk) : undefined);
      return ok({ sdk: found.root, bundled: found.bundled, toolchain: checkToolchain(found.socle, { install: args.install === true }), socle: found.socle });
    } catch (error) { return fail(error); }
  });

  register('gripforge_third_party_kit_verify_build', {
    title: 'Verify one build of a kit against a core',
    description: `Verify one build of a third-party kit — no game needed — against the core it is meant for (modules: a folder of kit modules, e.g. <exported game>/runtime-rust/kit-modules): the version of the contract and of every interface it consumes, then the structures of the contract, each compared with the core's. Answers ok, mode (isolated or common), contract { expected, found }, structs { expected, found } and the issues, each naming what was expected and what was found. ${GUIDE}`,
    inputSchema: {
      kit: build,
      wasm: schema.string().min(1).max(4096).optional().describe('The kit module: absolute path of the .wasm, or an http(s) URL (with manifest).'),
      manifest: schema.string().min(1).max(4096).optional().describe('Its .kit.json: absolute path, or an http(s) URL.'),
      trust,
      modules: schema.string().min(1).max(4096).optional().describe('Absolute path of the folder of kit modules (kit-modules.json) whose core the build is checked against.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    try {
      const report = await verifyBuild({ kit: typeof args.kit === 'string' ? absolute('kit', args.kit) : undefined, wasm: typeof args.wasm === 'string' ? fileOrUrl('wasm', args.wasm) : undefined, manifest: typeof args.manifest === 'string' ? fileOrUrl('manifest', args.manifest) : undefined,
        trust: trustOf(args.trust), modules: typeof args.modules === 'string' ? absolute('modules', args.modules) : undefined, signal: extra?.signal });
      return { ...ok(report), ...(report.ok ? {} : { isError: true }) };
    } catch (error) { return fail(error); }
  });

  register('gripforge_third_party_kit_add', {
    title: 'Declare a third-party kit in a game',
    description: `Declare a third-party kit — a kit of game logic compiled alone into one .wasm (a kit module), not one of GripForge's — in a local game, in the COMMON memory of the game by default (not isolated) or, with trust "isolated", with a memory of its own. Reads one build of gripforge_third_party_kit_build (kit: its output folder; or wasm + manifest, file or http(s) URL), checks it (the binary against the manifest; against the core and the kits of the game's kit modules when the game has them; the kits it requires against the game), then writes: project.thirdPartyKits (source, sha256, manifest), its entry in project.installed (config), its place at the end of lock.order, and lock.thirdParty (version and sha256 frozen). A module given as a file is copied beside the game (third-party-kits/). A third-party module is loaded only when the game declares it; the page then plays the kit modules by itself. Use GripForge's kits first (gripforge_gamekit_search): a third-party kit is for a rule no kit has. check=true writes nothing. Calling it again with a new build replaces the kit. ${GUIDE}`,
    inputSchema: {
      game,
      kit: build,
      wasm: schema.string().min(1).max(4096).optional().describe('The kit module: absolute path of the .wasm, or an http(s) URL (with manifest; or give kit instead).'),
      manifest: schema.string().min(1).max(4096).optional().describe('The .kit.json written beside the module by the build: absolute path, or an http(s) URL.'),
      trust,
      config: schema.record(schema.string(), schema.unknown()).optional().describe('Config of the kit in the game (what kx.config() returns). Kept from the previous declaration when omitted.'),
      modules,
      check: schema.boolean().optional().describe('true: check everything, write nothing.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    try {
      return ok(await addKit({ game: absolute('game', String(args.game)), kit: typeof args.kit === 'string' ? absolute('kit', args.kit) : undefined, wasm: typeof args.wasm === 'string' ? fileOrUrl('wasm', args.wasm) : undefined, manifest: typeof args.manifest === 'string' ? fileOrUrl('manifest', args.manifest) : undefined, trust: trustOf(args.trust),
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
