/** Modular Game Kits tools. Studio and MCP call the same Core HTTP API. */
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';
import { LOOK_VALUES, LOOK_DESCRIPTION } from './look.js';

export const GAMEKIT_TOOL_NAMES = [
  'gripforge_gamekit_search',
  'gripforge_gamekit_get',
  'gripforge_gamekit_installed',
  'gripforge_gamekit_install',
  'gripforge_gamekit_remove',
  'gripforge_gamekit_configure',
  'gripforge_gamekit_dependencies',
  'gripforge_gamekit_update',
  'gripforge_gamekit_deliver',
  'gripforge_game_capabilities',
  'gripforge_game_project',
  'gripforge_game_art_direction',
  'gripforge_game_asset_plan',
  'gripforge_gamekit_creatures',
  'gripforge_game_engine',
  'gripforge_game_content',
  'gripforge_game_play_url',
  'gripforge_game_test',
  'gripforge_game_audit',
  'gripforge_game_web_export',
  'gripforge_moba_roster',
  'gripforge_ability_vfx',
  'gripforge_moba_map',
  'gripforge_terrain_map_use',
] as const;

/**
 * Where each tool stands in the making of a game, appended to its description: when to call it, and the audit it
 * leads to. One table, so the journey reads the same from every tool — and one place to change it.
 */
export const TOOL_JOURNEY: Record<string, string> = {
  gripforge_gamekit_search: 'Journey — first: find the preset of the genre. Its `done` says what a finished game of that genre has beyond the request, and gripforge_game_audit checks it at the end.',
  gripforge_gamekit_installed: 'Journey — first on an existing project; gripforge_game_audit then says what stands between it and a finished game.',
  gripforge_gamekit_install: 'Journey — while composing. A kit installed and left empty is not done (audio.core without a sound, ui.endscreen without an end condition): gripforge_game_audit names them.',
  gripforge_gamekit_configure: 'Journey — while composing, and to fix what gripforge_game_audit reports (its defects carry the exact config to write).',
  gripforge_game_capabilities: 'Journey — while composing; gripforge_game_audit includes this report, with the creatures, the controls, the playtest and the definition of done of the genre.',
  gripforge_game_project: 'Journey — create, then bind a model to every creature slot (get carries the creatures report) and set the controls: action=controls applies the control scheme of the gameplay, a proposal to adapt. Before telling the user the game is done: gripforge_game_audit.',
  gripforge_gamekit_creatures: 'Journey — right after creating or binding: no unit stays a capsule, every model gets its movement and action clips. gripforge_game_audit folds this report with the rest and applies the free steps with fix=true.',
  gripforge_game_engine: 'Journey — the build order of the content; its last step is gripforge_game_audit, not "it loads".',
  gripforge_game_content: 'Journey — the content of the game. Once written, gripforge_game_audit says what a finished game of the genre still lacks (a quest, a way to win and to lose, dialogues…).',
  gripforge_game_test: 'Journey — after each change. A playtest that passes is not a finished game: gripforge_game_audit (playtest="run" runs this test) gives the verdict and everything the tester cannot see.',
  gripforge_game_play_url: 'Journey — to look at the running game. Share it as finished only when gripforge_game_audit says complete; otherwise say what is left.',
  gripforge_game_web_export: 'Journey — last. Run gripforge_game_audit first: export a game whose verdict is complete, or tell the user what is left.',
  gripforge_gamekit_deliver: 'Journey — last. Run gripforge_game_audit first: deliver a game whose verdict is complete, or tell the user what is left.',
  gripforge_moba_roster: 'Journey — a MOBA needs distinct heroes; then gripforge_game_audit for the minions, towers, jungle monsters and the rest of a finished MOBA.',
  gripforge_ability_vfx: 'Journey — after the roster; gripforge_game_audit lists it among what a finished MOBA has.',
};

/** The tool's place in the journey, then its description (whose closing credit rule stays last). */
function withJourney(name: string, description: string): string {
  const journey = TOOL_JOURNEY[name];
  return journey ? `${journey} ${description}` : description;
}

const enc = (v: unknown) => encodeURIComponent(String(v));

const HOSTED_DELIVERY_NOTE =
  'This hosted endpoint cannot write into your project: write bundle.files following plan.actions in order, or use npx @gripforgeai/mcp with gripforge_gamekit_deliver_local { project_dir }, or the editor bridge.';

export function registerGameKitTools(
  register: VfxProjectRegister,
  options: { apiUrl: string; getApiKey: () => string | null | undefined },
  schema: typeof z = z,
) {
  const workspace = {
    workspace_id: schema
      .string()
      .max(100)
      .optional()
      .describe('Workspace authorized by the current key. Never infer another user’s workspace.'),
  };
  const projectId = schema.string().min(4).max(80).describe('Game Kit project id (gkp_…). Not a dedicated-server project (gpj_…) nor a Library item.');
  const kitId = schema
    .string()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/i)
    .describe('Kit id from the catalogue, dotted (e.g. vehicle.driveable, mission.objectives).');
  const config = schema
    .record(schema.string(), schema.unknown())
    .optional()
    .describe('Kit config values, validated against the kit configSchema returned by gripforge_gamekit_get. Merged over the current config.');

  async function api(
    path: string,
    args: Record<string, unknown>,
    method: string,
    signal?: AbortSignal,
    query?: Record<string, string | number | boolean | undefined>,
    timeoutMs = 120_000,
  ): Promise<CallToolResult> {
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    const { workspace_id, ...body } = args;
    const url = new URL(`${options.apiUrl.replace(/\/$/, '')}/api/v1/${path.replace(/^\//, '')}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'x-gripforge-client': 'mcp',
          ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}),
        },
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
      const data = (await res.json()) as Record<string, unknown>;
      return {
        ...(res.ok ? {} : { isError: true }),
        structuredContent: data,
        content: [{ type: 'text', text: JSON.stringify(data) }],
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Game Kits API failed.' }] };
    }
  }

  function tool(
    name: string,
    title: string,
    description: string,
    inputSchema: z.ZodRawShape,
    opts: { readOnly: boolean; destructive?: boolean },
    callback: Parameters<VfxProjectRegister>[2],
  ) {
    register(
      name,
      {
        title,
        description: withJourney(name, description),
        inputSchema: { ...inputSchema, ...workspace },
        annotations: {
          readOnlyHint: opts.readOnly,
          destructiveHint: Boolean(opts.destructive),
          idempotentHint: opts.readOnly,
          openWorldHint: false,
        },
      },
      callback,
    );
  }

  const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
  /** Body for project-scoped writes: keep workspace_id (header), drop routing-only fields. */
  const body = (args: Record<string, unknown>, ...drop: string[]) => {
    const out: Record<string, unknown> = { ...args };
    for (const k of ['project_id', 'id', 'action', 'confirm', ...drop]) delete out[k];
    return out;
  };

  tool(
    'gripforge_game_web_export',
    'Prepare a standalone local web game',
    'Prepare a download manifest for an existing web Game Kit project in the current workspace. Reuses the same player and HUD as hosted play, compiles only installed enabled kit runtimes, and lists the game configuration, static resources and Library assets to download. Does not publish the project or change its visibility. The hosted MCP cannot write local files: use gripforge game-export <project_id> <folder> locally, then npm run dev. The CLI verifies downloads and preserves local edits on updates (--check previews conflicts; --force backs up and replaces edits only when authorized). The delivered versions remain fixed until an explicit export update. Legacy kits and unpublished source overlays cannot be exported. net.* kits still need their online services. 0 credits.',
    { project_id: projectId },
    { readOnly: false },
    (args, extra) => api(`gamekit-projects/${enc(args.project_id)}/export/web`, body(args), 'POST', extra?.signal),
  );

  tool(
    'gripforge_gamekit_search',
    'Search the Game Kit catalogue',
    'Start here. Search the modular Game Kit catalogue (vehicle.driveable, mission.objectives, npc.wanted, …) by free text, capability, tag or engine target. Pass project_id to score kits against that project: each hit then carries state { installed, enabled, fills, reason } and kits that fill one of its missing capabilities rank first. Kits are bricks that go together: a kit handling the same thing as an installed one is a same-scene overlap (only one active in a scene), never a reason to skip it. Returns { kits, presets }; each kit carries its presentation: name, tagline (one-line hook), tags, targets and status per engine (web / godot / unity / unreal), and cover / coverUrl, the featured landscape image (WebP) to show the user when proposing kits. legacy.* kits play through their existing client. Kart Racing is native: compose world.racetrack + vehicle.driveable + race.kart; edit race_tracks through project data. world.lighting adds shared sun/fill, point lights and spots, presets, bounded light budgets and bloom; edit world_lights through project data. world.fluids adds interactive mud / blood surfaces, displaced 3D wheel ruts and footprints; edit fluid_surfaces through project data (web renderer). world.terrain adds a seeded large landscape (terrain_edits data), movement.traversal climbing / swimming / gliding with stamina, world.elements data-driven fire, water, ice, electricity and poison (element_rules, element_materials, element_climates data). Also returns packs: content packs (ready-made game content — documents and kit configs, e.g. a realistic atmosphere, a tree of life, a star system) that gripforge_gamekit_install { pack } installs into a project. Call this BEFORE gripforge_gamekit_install. 0 credits.',
    {
      q: schema.string().max(200).optional().describe('Free text matched on id, name, description and tags (e.g. "drive a car", "wanted level").'),
      capability: schema.string().max(120).optional().describe('Capability the kit must provide (exact id or prefix, e.g. vehicle.drive).'),
      tag: schema.string().max(60).optional().describe('Tag filter (e.g. vehicle, mission, npc, legacy).'),
      target: schema.enum(['web', 'godot', 'unity', 'unreal']).optional().describe('Engine target the kit must support. For game creation, use the engine chosen by the user or identified in their project; ask Unity / Godot / Unreal Engine / Three.js if unknown. The API web default is not user consent.'),
      project_id: projectId.optional().describe('Game Kit project id (gkp_…) to score results against. Default: the workspace’s most recently updated project.'),
      limit: schema.number().int().min(1).max(100).optional().describe('Max kits returned (default 20).'),
    },
    { readOnly: true },
    (args, extra) =>
      api('gamekits', args, 'GET', extra?.signal, {
        q: typeof args.q === 'string' ? args.q : undefined,
        capability: typeof args.capability === 'string' ? args.capability : undefined,
        tag: typeof args.tag === 'string' ? args.tag : undefined,
        target: typeof args.target === 'string' ? args.target : undefined,
        project: typeof args.project_id === 'string' ? args.project_id : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }),
  );

  tool(
    'gripforge_gamekit_get',
    'Read one Game Kit',
    'Read one Game Kit: its manifest (provides / requires capabilities, asset slots, data collections, events), README docs, config JSON schema with defaults, version and changelog (information only: projects always run the latest version), and summary { tagline, tags, targets, status, cover, coverUrl } with the featured image URL. Pass with_usage=true to also list the workspace projects that have it installed. Call this BEFORE gripforge_gamekit_configure to know which config keys exist. 0 credits.',
    {
      id: kitId,
      version: schema.string().max(40).optional().describe('Exact version to read (e.g. 1.0.0). Default: latest.'),
      with_usage: schema.boolean().optional().describe('true to include usedBy: the workspace projects where this kit is installed.'),
    },
    { readOnly: true },
    (args, extra) =>
      api(`gamekits/${enc(args.id)}`, args, 'GET', extra?.signal, {
        version: typeof args.version === 'string' ? args.version : undefined,
        with: args.with_usage === true ? 'usage' : undefined,
      }),
  );

  tool(
    'gripforge_gamekit_installed',
    'Installed kits of a project (use these first)',
    'Start here for an existing project. Lists the kits installed in a Game Kit project (gkp_…), first and marked priority: id, name, enabled, addedBy (user / agent / auto / preset / default — the interface kits every new game gets), provides, requires and config, plus the rule that goes with them. Versions are for your information (projects always follow the latest): each kit also has version (in the project), latest, delivered { godot | unity | unreal } (the version the last engine delivery carries — a delivered game can run an older one) and pendingMigrations (manual migrations left to you). Installed kits are choices already made for this game: build on them for what they cover and configure them as needed; search the catalogue only for what they do not cover. 0 credits.',
    { project_id: projectId },
    { readOnly: true },
    (args, extra) => api(`gamekit-projects/${enc(args.project_id)}/kits`, args, 'GET', extra?.signal),
  );

  tool(
    'gripforge_gamekit_install',
    'Install a Game Kit into a project',
    'Add a gameplay kit (a brick) to a Game Kit project (gkp_…); installing marks that the game uses it. Decide it yourself, no confirmation needed. Always the latest version; dependencies are added automatically and listed in added [{ kit, version, requiredBy, capability }] (e.g. game.engine for a kit that requires it). Kits are bricks that go together: two kits handling the same thing (e.g. two lightings) are a same-scene overlap, never a game-level conflict — only one is active in a scene. Returns { plan, applied, added, project }; dry_run=true previews without writing. Check gripforge_gamekit_installed first, then gripforge_gamekit_search; tune with gripforge_gamekit_configure. Legacy genre kits (legacy.*) use gripforge_kit. 0 credits.',
    {
      project_id: projectId,
      id: kitId.optional().describe('Kit id to install (e.g. vehicle.driveable). Required unless pack is given.'),
      pack: schema.string().max(80).optional().describe('Instead of id: a content pack listed by gripforge_gamekit_search (packs[].id, e.g. tree-of-life) — its kits are installed, its configs merged and its documents upserted by id (the project\'s own documents are kept). Returns { pack, applied, plan: { installed, configured, data }, added, project }.'),
      existing: schema.enum(['replace', 'keep']).optional().describe('With pack: a pack document whose id the project already has — replace (default) or keep the project\'s.'),
      config,
      dry_run: schema.boolean().optional().describe('true to return the install plan without writing the project.'),
      allow_planned: schema.boolean().optional().describe('true to accept kits still marked planned (0.x, no runtime yet). Default false.'),
      reason: schema.string().max(300).optional().describe('One sentence: why you do this, recorded in the project history (required in spirit when you go against the installed-kits rule).'),
    },
    { readOnly: false },
    (args, extra) => typeof args.pack === 'string' && args.pack
      ? api(`gamekit-projects/${enc(args.project_id)}/packs`, { pack: args.pack, existing: args.existing, dry_run: args.dry_run, reason: args.reason }, 'POST', extra?.signal)
      : api(`gamekit-projects/${enc(args.project_id)}/kits`, { ...body(args), id: args.id }, 'POST', extra?.signal),
  );

  tool(
    'gripforge_gamekit_remove',
    'Uninstall a Game Kit from a project',
    'Uninstall a kit from a Game Kit project (gkp_…). Remove a kit the user installed (addedBy user in gripforge_gamekit_installed) only when the user asks. game.engine (the engine of the game) and the default kits (ui.menu, input.remap, settings.graphics, ui.prompts, ui.endscreen, save.persistence, audio.core, i18n.text, ui.theme, input.virtualpad, addedBy default) are removed only when the user explicitly asks — never to "clean up". A kit other kits depend on, and game.engine always, is not removed by a first call: it answers 409 (kit_in_use, or confirm_required) with details { dependents, confirm } — nothing applied; show the user the dependents, then call again with with_dependents=true and confirm=<token> to remove the kit and its dependents together (the token is bound to the project revision). dry_run=true returns the plan, the dependents and the token without writing. force=true (legacy) removes it and disables its dependents instead; prune=true also drops the dependencies nothing else needs (never game.engine nor a default kit). Returns { applied, removed[], dependents, project }. 0 credits.',
    {
      project_id: projectId,
      id: kitId,
      dry_run: schema.boolean().optional().describe('true to return the removal plan (with the dependents and the confirm token) without writing.'),
      with_dependents: schema.boolean().optional().describe('true to remove the kit AND the kits that depend on it (needs confirm).'),
      confirm: schema.string().max(80).optional().describe('The confirm token of the previous answer, after the user saw the dependents.'),
      force: schema.boolean().optional().describe('Legacy: remove even when other kits depend on it; they are disabled, not removed.'),
      prune: schema.boolean().optional().describe('true to also remove dependencies that no remaining kit requires (never game.engine nor a default kit).'),
      reason: schema.string().max(300).optional().describe('One sentence: why you do this, recorded in the project history (required in spirit when you go against the installed-kits rule).'),
    },
    { readOnly: false, destructive: true },
    (args, extra) =>
      api(`gamekit-projects/${enc(args.project_id)}/kits/${enc(args.id)}`, args, 'DELETE', extra?.signal, {
        force: args.force === true ? 1 : undefined,
        prune: args.prune === true ? 1 : undefined,
        dry_run: args.dry_run === true ? 1 : undefined,
        with_dependents: args.with_dependents === true ? 1 : undefined,
        confirm: typeof args.confirm === 'string' && args.confirm ? args.confirm : undefined,
        reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason : undefined,
      }),
  );

  tool(
    'gripforge_gamekit_configure',
    'Configure an installed Game Kit',
    'Tune an installed kit: merge config values validated against the kit configSchema (read it with gripforge_gamekit_get), or toggle enabled to switch the kit off without uninstalling it. Configure installed kits freely rather than recoding what they do (game.engine: startScene, startEntry, flow.title, story flags). Switching game.engine off follows the confirmation of a removal: the first call answers 409 confirm_required with details.confirm; send it back with enabled=false after the user agreed — never on your own. Returns { kit, project } with the new project revision. Call this AFTER gripforge_gamekit_install. 0 credits.',
    {
      project_id: projectId,
      id: kitId,
      config,
      enabled: schema.boolean().optional().describe('false to disable the kit at runtime while keeping it installed; true to re-enable.'),
      confirm: schema.string().max(80).optional().describe('game.engine enabled=false: the confirm token of the previous answer.'),
      reason: schema.string().max(300).optional().describe('One sentence: why you do this, recorded in the project history (required in spirit when you go against the installed-kits rule).'),
    },
    { readOnly: false },
    (args, extra) => api(`gamekit-projects/${enc(args.project_id)}/kits/${enc(args.id)}`, { ...body(args), ...(typeof args.confirm === 'string' ? { confirm: args.confirm } : {}) }, 'PATCH', extra?.signal),
  );

  tool(
    'gripforge_gamekit_dependencies',
    'Dependency graph of a project or kit',
    'Dependency graph of a Game Kit project: nodes (installed kits with version, provides, requires), edges labelled by capability, same-scene overlaps (conflicts: several enabled providers of one exclusive capability) and unresolved requirements. Pass project_id for the installed graph; pass a kit id instead to read the declared requires / provides tree of a catalogue kit before installing it. Call this BEFORE gripforge_gamekit_remove with force. 0 credits.',
    {
      project_id: projectId.optional().describe('Game Kit project id (gkp_…). Default: the workspace’s most recently updated project when id is not given.'),
      id: kitId.optional().describe('Catalogue kit id to inspect instead of a project (returns its manifest tree).'),
    },
    { readOnly: true },
    (args, extra) => {
      if (typeof args.id === 'string' && typeof args.project_id !== 'string') return api(`gamekits/${enc(args.id)}`, args, 'GET', extra?.signal);
      if (typeof args.project_id !== 'string') return Promise.resolve(fail('Pass project_id (gkp_…) or a kit id.'));
      return api(`gamekit-projects/${enc(args.project_id)}/dependencies`, args, 'GET', extra?.signal);
    },
  );

  tool(
    'gripforge_gamekit_update',
    'Bring Game Kits to their latest version',
    'Projects always follow the latest version of their kits: the studio updates them automatically when a project is opened. Use this to do it now. Dry-run by default: returns the plan (from / to version, migrations). Pass apply=true to apply it. A migration with auto=false is never applied by itself: it is your task — apply its note (config, data) then call again. Omit id to check every installed kit. 0 credits.',
    {
      project_id: projectId,
      id: kitId.optional().describe('Installed kit to update. Omit to check every installed kit.'),
      apply: schema.boolean().optional().describe('true to apply the update to the latest version (automatic migrations run). Default false = plan only.'),
    },
    { readOnly: false },
    async (args, extra) => {
      const project = enc(args.project_id);
      const payload = body(args);
      if (typeof args.id === 'string') return api(`gamekit-projects/${project}/kits/${enc(args.id)}/update`, payload, 'POST', extra?.signal);
      const detail = await api(`gamekit-projects/${project}`, args, 'GET', extra?.signal);
      if (detail.isError) return detail;
      const installed = (detail.structuredContent as { installed?: unknown } | undefined)?.installed;
      const ids = Array.isArray(installed)
        ? installed.map((k) => (typeof k === 'string' ? k : (k as { id?: unknown })?.id)).filter((k): k is string => typeof k === 'string')
        : installed && typeof installed === 'object'
          ? Object.keys(installed)
          : [];
      const kits: Record<string, unknown>[] = [];
      let isError = false;
      for (const id of ids) {
        const r = await api(`gamekit-projects/${project}/kits/${enc(id)}/update`, payload, 'POST', extra?.signal);
        isError ||= Boolean(r.isError);
        const first = r.content[0];
        kits.push({ id, ...(r.structuredContent ?? { error: first?.type === 'text' ? first.text : 'update failed' }) });
      }
      const data = { project_id: args.project_id, kits };
      return { ...(isError ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    },
  );

  tool(
    'gripforge_gamekit_deliver',
    'Deliver Game Kits into an engine project',
    'Turn catalogue kits, or the enabled kits of a Game Kit project, into engine files: Godot gets GDScript, scenes and config under gripforge/kits/<kit>/, Unity gets an embedded UPM package plus C# files and Unreal a Blueprint-first plugin for every kit with an engine delivery (gameplay and net.* kits; recipes otherwise), web needs nothing. Kits always deliver at their latest version; a kit the project copied locally is delivered from its copy. Call with dry_run=true FIRST: it returns the plan (files to add / keep / modify / delete, conflicts, dependencies, post-install steps) and never charges. Pass project_state (the current gripforge/gamekits.lock.json, path → sha256 of the files under gripforge/, engineVersion) so updates keep your edits and detect conflicts. Then call without dry_run to get the bundle. The hosted endpoint cannot write into your project: write bundle.files following plan.actions in order (backup, write, writeBin from bundle.binaries, delete with .uid / .import siblings, writeLock with bundle.lock), or use the npm client with project_dir (gripforge_gamekit_deliver_local), or the editor bridge. A blocked plan answers 409 with the plan: a file edited in the engine project is reported (modified_file), never overwritten silently; force backs it up then overwrites it. Credits: the first delivery of a kit major version to an engine costs 1 credit per workspace; re-deliveries, updates within a major, dry runs and the web target are free.',
    {
      target: schema.enum(['godot', 'unity', 'unreal', 'web']).describe('Engine to deliver to: godot (addon + kit files), unity (UPM package + C# files), unreal (plugins), web (native, nothing to write). Kits without an engine delivery get recipes.'),
      kits: schema
        .array(
          schema.object({
            id: kitId,
            config: schema.record(schema.string(), schema.unknown()).optional().describe('Kit config, validated against its configSchema.'),
            bindings: schema.record(schema.string(), schema.string()).optional().describe('Asset slot → Library item id (lib_…).'),
          }),
        )
        .max(16)
        .optional()
        .describe('Kits to deliver (at most 16). Omit to deliver the enabled kits of project_id.'),
      project_id: projectId.optional().describe('Game Kit project (gkp_…) whose enabled kits, config and slot bindings are delivered when kits is omitted.'),
      mode: schema.enum(['install', 'update', 'uninstall']).optional().describe('install (default), update to the latest catalogue version, or uninstall (needs project_state.lock).'),
      project_state: schema
        .object({
          engineVersion: schema.string().max(80).optional().describe('Engine version, e.g. 4.3.stable.'),
          lock: schema.record(schema.string(), schema.unknown()).nullable().optional().describe('Current gripforge/gamekits.lock.json content, null when absent.'),
          files: schema.record(schema.string(), schema.string()).optional().describe('path → sha256 hex of every file under gripforge/ and assets/gripforge/ (at most 5000).'),
        })
        .optional()
        .describe('What the engine project contains now. Without it the plan assumes an empty project (add-only).'),
      dry_run: schema.boolean().optional().describe('true → plan only: no bundle, never charged. Do this first.'),
      force: schema.boolean().optional().describe('true → back up then overwrite edited managed files and existing seed files.'),
    },
    { readOnly: false },
    async (args, extra) => {
      const kits = Array.isArray(args.kits) ? args.kits : [];
      const state = args.project_state as { lock?: unknown } | undefined;
      if (!kits.length && typeof args.project_id !== 'string' && !(args.mode === 'uninstall' && state?.lock)) return fail('Pass kits [{ id }] or project_id (gkp_…).');
      const result = await api(
        'gamekits/deliver',
        {
          workspace_id: args.workspace_id,
          target: args.target,
          ...(kits.length ? { kits } : {}),
          projectId: args.project_id,
          mode: args.mode,
          project: args.project_state,
          dryRun: args.dry_run === true,
          force: args.force === true,
        },
        'POST',
        extra?.signal,
      );
      const data = result.structuredContent as Record<string, unknown> | undefined;
      if (result.isError || !data?.bundle) return result;
      const withNote = { ...data, note: HOSTED_DELIVERY_NOTE };
      return { structuredContent: withNote, content: [{ type: 'text', text: JSON.stringify(withNote) }] };
    },
  );

  tool(
    'gripforge_game_capabilities',
    'Capabilities report of a project',
    'Report the capabilities a Game Kit project provides, what is still missing for a goal (a preset id from gripforge_gamekit_search or a comma-separated list of capabilities) and which catalogue kits would fill each gap. The installed kits (gripforge_gamekit_installed) come first; call this BEFORE gripforge_gamekit_install to pick the next kit. 0 credits.',
    {
      project_id: projectId,
      goal: schema.string().max(400).optional().describe('Preset id (e.g. from gripforge_gamekit_search presets) or comma-separated capabilities to reach. Default: the project’s own preset.'),
    },
    { readOnly: true },
    (args, extra) =>
      api(`gamekit-projects/${enc(args.project_id)}/capabilities`, args, 'GET', extra?.signal, {
        goal: typeof args.goal === 'string' ? args.goal : undefined,
      }),
  );

  tool(
    'gripforge_game_art_direction',
    'Read or update the shared art direction of a game',
    'Store artistic intent on the existing Game Kit project (game.engine), separately from gameplay: look, world/theme, palette, proportions/materials/lighting notes and device budget. Read first, then set with expected_revision. Unspecified fields are preserved; null clears a field or the profile. Existing assets and rendering are not modified. Use this direction with map wizard.look, VFX look, asset prompts, lighting and UI tools, then inspect gripforge_game_asset_plan and actual-engine captures. 0 credits.',
    {
      project_id: projectId,
      action: schema.enum(['get', 'set']).describe('get reads the profile/revision; set applies a partial profile update.'),
      expected_revision: schema.number().int().positive().optional().describe('set: revision returned by get; stale changes are refused.'),
      art_direction: schema.object({
        look: schema.enum(LOOK_VALUES).nullable().optional().describe(LOOK_DESCRIPTION),
        theme: schema.string().max(120).nullable().optional(),
        palette: schema.array(schema.string().regex(/^#[a-f\d]{6}$/i)).max(12).nullable().optional(),
        notes: schema.string().max(1600).nullable().optional(),
        device: schema.enum(['mobile', 'desktop']).nullable().optional(),
      }).strict().nullable().optional().describe('set: shared project art direction patch. Null clears the profile or an individual field.'),
    },
    { readOnly: false },
    (args, extra) => {
      const path = `gamekit-projects/${enc(args.project_id)}/art-direction`;
      if (args.action === 'get') return api(path, args, 'GET', extra?.signal);
      if (args.art_direction === undefined || args.expected_revision === undefined) return Promise.resolve(fail('set needs art_direction and expected_revision from get.'));
      return api(path, { workspace_id: args.workspace_id, artDirection: args.art_direction, expected_revision: args.expected_revision }, 'PATCH', extra?.signal);
    },
  );

  tool(
    'gripforge_game_asset_plan',
    'Audit project asset roles or search compatible candidates',
    'Read asset requirements from enabled Game Kits and game.engine archetypes. Without slot: report missing files/bindings, template defaults, metadata style/theme conflicts, unknown classifications and technical ranking concerns. With slot: search accessible Library/Community candidates for that role and the saved art direction; known visual conflicts are excluded. No purchase, generation or binding. Metadata checks do not replace visual/animation/gameplay review in the actual engine. 0 credits.',
    {
      project_id: projectId,
      slot: schema.string().max(160).optional().describe('Omit for the audit; pass a role id from the audit to search candidates.'),
      q: schema.string().max(400).optional().describe('Optional candidate search terms for this slot.'),
      source: schema.enum(['all', 'workspace', 'community']).optional().describe('Search scope; default all accessible assets.'),
      limit: schema.number().int().min(1).max(48).optional().describe('Maximum candidates, default 12.'),
    },
    { readOnly: true },
    (args, extra) => api(`gamekit-projects/${enc(args.project_id)}/assets`, args, 'GET', extra?.signal, {
      slot: args.slot as string | undefined, q: args.q as string | undefined, source: args.source as string | undefined, limit: args.limit as number | undefined,
    }),
  );

  tool(
    'gripforge_game_project',
    'List, create, read, bind, feed, set the controls of or delete Game Kit projects',
    'Manage Game Kit projects (gkp_…): the container holding installed kits, their lockfile, asset bindings and data collections. action=list lists the workspace projects; create needs name and takes a preset (see gripforge_gamekit_search; adventure is the reference game of game.engine) or an explicit kits map — every new project gets game.engine first (the engine of the game: scenes, archetypes, scripts, life cycle; its answer carries the engine start pack { structure, scene, blocks, order, next, rules } and added, the kits installed for dependencies), then the default kits ui.menu (title / pause / options / load and save screen), input.remap (key remapping), settings.graphics (graphics options), ui.prompts (on-screen key prompts that follow remapping and the gamepad), ui.endscreen (end screen and credits), save.persistence (save slots, quick save, autosave), audio.core (game audio: mixer, music, effects, event → sound table), i18n.text (game texts in the player’s language: translation tables in the translations collection, ICU plurals) ui.theme (the design of every interface as kit config: colours, font, shapes, key glyphs; unset = built-in look) and input.virtualpad (the on-screen gamepad of touch screens, mode auto: shown on a touch screen without a gamepad, Touch controls tab), addedBy default: keep and configure them, leave one out ({ "ui.menu": false }) or remove it only if the user asks; get returns the full ProjectDetail (installed kits, bindings, capabilities, missing, playUrl); bind maps asset slots to Library items (lib_…, null to clear); data reads a collection or upserts / removes documents validated against the kits’ schemas (replace=true swaps the whole collection); controls reads or sets the controls: without scheme it returns the control schemes of the catalogue (fps, third_person, moba_click, top_down, platformer, fighting, vehicle, rts, point_click: movement by keys or by click, what the mouse is for, expected actions and keys, touch layout), the project scheme, the one its kits suggest, every action with its effective key and the keys two actions share in one mode (warnings with a proposed reassignment, never a refusal — also in get → report.controls); with scheme and dry_run=true it returns the diff of keys the scheme would write; with scheme alone it applies it (input.actions overrides marked source: scheme, the touch layout of input.virtualpad, the help bar of ui.prompts). A scheme is a starting proposal: a preset applies its own at creation (create takes controls to pick another one, or none), and any key stays changeable with gripforge_gamekit_configure input.actions { overrides: [{ action, keys, buttons?, disabled? }] } — the action of any kit; those entries always win over the scheme. delete needs confirm=true. Call this first to create or pick the project, then gripforge_gamekit_installed (existing project) or gripforge_gamekit_install. 0 credits.',
    {
      action: schema.enum(['list', 'create', 'get', 'bind', 'data', 'controls', 'delete']).describe('list | create | get | bind | data | controls | delete.'),
      project_id: projectId.optional().describe('Game Kit project id (gkp_…). Required for get, bind, data, controls and delete.'),
      name: schema.string().min(1).max(120).optional().describe('create: project name.'),
      preset: schema.string().max(80).optional().describe('create: preset id whose default kits are installed (gripforge_gamekit_search returns presets).'),
      kits: schema.record(schema.string(), schema.boolean()).optional().describe('create: explicit kit toggles { "vehicle.driveable": true, … } on top of the preset. Unchecking a required kit fails with toggle_requires. The default kits (ui.menu, input.remap, settings.graphics, ui.prompts, ui.endscreen, save.persistence, audio.core, i18n.text, ui.theme, input.virtualpad) are included unless set to false here — only when the user asked for it.'),
      target: schema.enum(['web', 'godot', 'unity', 'unreal']).optional().describe('create: pass the confirmed engine explicitly (Three.js=web). Ask the user to choose Unity / Godot / Unreal Engine / Three.js before creating if unknown. API default web is for compatibility, not an engine choice.'),
      bindings: schema.record(schema.string(), schema.string().nullable()).optional().describe('bind: { slot: lib_… | null } — Library item per asset slot declared by the installed kits, null clears. A model bound to a creature slot gets its animations by itself as far as that is free (the answer carries the chain in creatures); see gripforge_gamekit_creatures.'),
      collection: schema.string().max(80).optional().describe('data: collection name declared by an installed kit (e.g. missions, npcs, zones).'),
      documents: schema.array(schema.record(schema.string(), schema.unknown())).max(500).optional().describe('data: documents to upsert (each with its id), validated against the kit schema.'),
      remove: schema.array(schema.string().max(120)).max(500).optional().describe('data: document ids to remove.'),
      replace: schema.boolean().optional().describe('data: true to replace the whole collection with documents.'),
      scheme: schema.string().max(40).optional().describe('controls: the control scheme to show (dry_run) or apply — fps, third_person, moba_click, top_down, platformer, fighting, vehicle, rts, point_click. Omit to read the schemes and the project controls.'),
      dry_run: schema.boolean().optional().describe('controls: true returns the diff of keys without writing.'),
      force: schema.boolean().optional().describe('controls: also replace a touch layout or a help bar the game edited (kept by default).'),
      reset: schema.boolean().optional().describe('controls: also drop the key overrides the game wrote itself (kept by default), so the game ends exactly on the scheme — what a game made before the schemes needs to move to one. Preview with dry_run.'),
      controls: schema.string().max(40).optional().describe('create: control scheme applied at creation instead of the preset’s own (or of the one the kits suggest); none keeps the kits’ own keys.'),
      confirm: schema.boolean().optional().describe('delete: must be true. The project, its revisions and data are removed.'),
    },
    { readOnly: false },
    (args, extra) => {
      const action = String(args.action);
      if (action === 'list') return api('gamekit-projects', args, 'GET', extra?.signal);
      if (action === 'create') {
        if (typeof args.name !== 'string' || !args.name.trim()) return Promise.resolve(fail('create needs name.'));
        return api('gamekit-projects', body(args, 'bindings', 'collection', 'documents', 'remove', 'replace', 'scheme', 'dry_run', 'force', 'reset'), 'POST', extra?.signal);
      }
      if (typeof args.project_id !== 'string') return Promise.resolve(fail(`${action} needs project_id (gkp_…).`));
      const project = enc(args.project_id);
      // creatures=1: the answer carries ranked models for every creature slot that would draw a capsule.
      if (action === 'get') return api(`gamekit-projects/${project}`, args, 'GET', extra?.signal, { creatures: 1 });
      if (action === 'bind') {
        if (!args.bindings || typeof args.bindings !== 'object') return Promise.resolve(fail('bind needs bindings { slot: lib_… | null }.'));
        return api(`gamekit-projects/${project}/bindings`, { workspace_id: args.workspace_id, bindings: args.bindings }, 'PATCH', extra?.signal);
      }
      if (action === 'data') {
        if (typeof args.collection !== 'string') return Promise.resolve(fail('data needs collection.'));
        const writes = Array.isArray(args.documents) || Array.isArray(args.remove) || args.replace === true;
        if (!writes) return api(`gamekit-projects/${project}/data`, args, 'GET', extra?.signal, { collection: args.collection });
        return api(
          `gamekit-projects/${project}/data`,
          { workspace_id: args.workspace_id, collection: args.collection, upsert: args.documents, remove: args.remove, replace: args.replace },
          'PATCH',
          extra?.signal,
        );
      }
      if (action === 'controls') {
        if (typeof args.scheme === 'string' && args.scheme) {
          return api(`gamekit-projects/${project}/controls`, { workspace_id: args.workspace_id, scheme: args.scheme, dry_run: args.dry_run, force: args.force, reset: args.reset }, 'POST', extra?.signal);
        }
        return (async () => {
          const [schemes, current] = await Promise.all([api('gamekits/control-schemes', args, 'GET', extra?.signal), api(`gamekit-projects/${project}/controls`, args, 'GET', extra?.signal)]);
          if (current.isError) return current;
          const data = { ...(current.structuredContent as Record<string, unknown>), schemes: (schemes.structuredContent as { schemes?: unknown } | undefined)?.schemes ?? [] };
          return { structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
        })();
      }
      if (action === 'delete') {
        if (args.confirm !== true) return Promise.resolve(fail('delete needs confirm=true.'));
        return api(`gamekit-projects/${project}`, args, 'DELETE', extra?.signal, { confirm: 1 });
      }
      return Promise.resolve(fail(`Unknown action ${action}.`));
    },
  );

  tool(
    'gripforge_gamekit_creatures',
    'Creatures of a project: a model and its animations for every unit',
    'The living units of a Game Kit project (gkp_…) — player, heroes, enemies, bosses, minions, monsters, NPCs: the creature slots its kits declare. Two rules: NO creature ships as a capsule, and a model ships WITH its animations (movement AND action). action=report (default): every creature slot with its status (bound | fallback = a capsule in game), the model bound, the clips the slot plays (locomotion, action), the ones the model lacks, and its chain (steps: clone | rig | animate | more_clips, each done / running / proposed with its tool, free or its credits). action=propose: ranked Library models for each unbound slot — the workspace first, then the Community — with the reasons of the rank (source, slot and role words, game theme, size, rigged, animated, triangle budget). YOU judge: read the reasons, pick the model that fits the game (any monster beats a capsule), bind it with gripforge_game_project { action: "bind" }; nothing is final, rebind any time. A slot with no proposal at all carries defect creature_no_model: generate a model (paid — quote and ask first), never leave the capsule. action=animate: run the free steps of the chain now for the bound models (a free Community model is copied into the workspace and bound in place of the original; the standard clip pack is retargeted, 0 credits; wait=true waits for the result, else it runs in the background — read report again). action=fill: bind the best free proposal to every unbound creature slot, then animate (what the hosted creation does). Nothing here spends credits: the automatic rig, a priced Community asset and generated motions always come back as proposed steps for you to quote and ask about. Binding a model through gripforge_game_project already starts its chain. 0 credits.',
    {
      project_id: projectId,
      action: schema.enum(['report', 'propose', 'animate', 'fill']).optional().describe('report (default) | propose | animate | fill.'),
      slot: schema.string().max(80).optional().describe('report / propose: only this creature slot (e.g. enemy_grunt, moba_hero_3).'),
      slots: schema.array(schema.string().max(120)).max(64).optional().describe('animate: only these slots (slot or slot:variant). Default: every bound creature slot.'),
      limit: schema.number().int().min(1).max(12).optional().describe('propose: models per slot (default 5).'),
      wait: schema.boolean().optional().describe('animate / fill: wait for the retargets instead of running them in the background.'),
      brief: schema.string().max(2000).optional().describe('fill: what the game is about, to rank the models (theme, mood).'),
    },
    { readOnly: false },
    (args, extra) => {
      const action = typeof args.action === 'string' ? args.action : 'report';
      const path = `gamekit-projects/${enc(args.project_id)}/creatures`;
      if (action === 'report' || action === 'propose') {
        return api(path, args, 'GET', extra?.signal, { propose: action === 'propose' ? 1 : undefined, slot: typeof args.slot === 'string' ? args.slot : undefined, limit: typeof args.limit === 'number' ? args.limit : undefined });
      }
      return api(path, { workspace_id: args.workspace_id, action, slots: args.slots, wait: args.wait, brief: args.brief }, 'POST', extra?.signal);
    },
  );

  tool(
    'gripforge_game_engine',
    'The engine of a game: structure, bricks, report, next steps',
    'Read game.engine of a Game Kit project (gkp_…) — a direction, never a gate. action=start (default): the start pack { version, active, structure { engine, kits, content counts, code }, scene, blocks digest, order (scene → playable → assets → archetypes → story → scripts → ui → validate → deliver → code), next [{ step, tool, args, why }], code (where game code goes per engine), rules } and the full content report. action=blocks: the brick catalogue computed from the manifests — entity kinds, archetype components (kit, schema, example), script verbs (conditions / actions with arguments and shorthand), script sugars (interact, enter, leave, scene, talked, quest, state, gives), quest step types, NPC behaviours, worlds, layers, events, variables; scope=catalog adds the bricks of kits not installed (install <kit>). action=report: { ok, errors, warnings, stats } — an error means that piece is left out of the game (the rest plays), a warning that it loads with something missing; each issue may carry a fix { tool, args }. action=next: the next steps only. A game with everything in code is valid: content first, kits second, code for the rest. 0 credits.',
    {
      project_id: projectId,
      action: schema.enum(['start', 'structure', 'blocks', 'report', 'next']).optional().describe('start (default) | structure | blocks | report | next.'),
      scope: schema.enum(['installed', 'catalog']).optional().describe('blocks: installed (default) or catalog.'),
      scene: schema.string().max(64).optional().describe('start: also return this scene document.'),
    },
    { readOnly: true },
    async (args, extra) => {
      const action = typeof args.action === 'string' ? args.action : 'start';
      const project = enc(args.project_id);
      if (action === 'blocks') return api(`gamekit-projects/${project}/engine/blocks`, args, 'GET', extra?.signal, { scope: typeof args.scope === 'string' ? args.scope : undefined });
      const res = await api(`gamekit-projects/${project}/engine`, args, 'GET', extra?.signal, { scene: typeof args.scene === 'string' ? args.scene : undefined });
      if (res.isError || action === 'start') return res;
      const data = res.structuredContent as { engine?: Record<string, unknown>; report?: unknown } | undefined;
      const picked = action === 'report' ? { report: data?.report } : action === 'next' ? { next: data?.engine?.next, order: data?.engine?.order } : { structure: data?.engine?.structure, scene: data?.engine?.scene, active: data?.engine?.active };
      return { structuredContent: picked as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(picked) }] };
    },
  );

  tool(
    'gripforge_game_content',
    'Drop content into a game: scenes, archetypes, scripts, quests…',
    'Read and write the content of a Game Kit project (gkp_…) — what game.engine builds the game from, no engine code needed. kind: archetype (an entity template: kind prop|npc|…, asset { item: lib_… } bound to content:<id> | { slot }, components claimed by kits — see gripforge_game_engine blocks — and gives { quest, offer, progress?, thanks? } for "this NPC gives this quest"), scene (world { kit, config?, doc? }, entries, instances [{ id, archetype, at, yaw?, place?, set? }], zones, layers, ui), script (gripforge.script/1: { id, on: <instance> | archetype:<id> | scene:<id>, rules: [{ when, if?, then, else?, once? }] } with sugars { "interact": "self" }, { "enter": zone }, { "state": { open: false } }, { "quest": id, "is": "completed" }, { "talked": npc }, engine verbs set_state, play_clip, set_solid, show, hide, enable_script, disable_script, load_scene, end_game, call, set_talk and kit verbs as shorthand { "give_item": "key" }), mission (alias quest), dialogue, npc, item, translations, code_module (what game code registers: verbs, components, services, entity kinds), zone, trigger. action=list (kind optional: counts), get (kind, id), put (kind, doc or docs: upsert, validated against the declaring kit schema), remove (kind, id), validate (dry run of a put: the report it would give), place (scene, archetype or asset lib_…, at, yaw?, id?, place ground|none: the placement on the ground is baked once on the server, the same on every engine), bake (re-bake the placements of a scene after its world changed). Writes return the content report after the change; the report never refuses a write — only a document invalid for its schema is. 0 credits.',
    {
      project_id: projectId,
      action: schema.enum(['list', 'get', 'put', 'remove', 'validate', 'place', 'bake']).describe('list | get | put | remove | validate | place | bake.'),
      kind: schema.enum(['archetype', 'scene', 'script', 'mission', 'quest', 'dialogue', 'npc', 'item', 'translations', 'code_module', 'zone', 'trigger']).optional().describe('The content kind (list without kind: counts per kind).'),
      id: schema.string().max(120).optional().describe('get / remove: the document id; place: the instance id (default <archetype>_<n>).'),
      doc: schema.record(schema.string(), schema.unknown()).optional().describe('put / validate: the document (with its id).'),
      docs: schema.array(schema.record(schema.string(), schema.unknown())).max(200).optional().describe('put / validate: several documents of the same kind.'),
      scene: schema.string().max(64).optional().describe('place / bake: the scene id (place default: the first scene).'),
      archetype: schema.string().max(64).optional().describe('place: the archetype of the instance.'),
      asset: schema.string().max(64).optional().describe('place: a Library asset (lib_…) instead of an archetype: its archetype is the one using it, or a new prop.'),
      at: schema.array(schema.number()).length(3).optional().describe('place: position [x, y, z] in metres (+Y up).'),
      yaw: schema.number().optional().describe('place: rotation around +Y in radians.'),
      place: schema.enum(['ground', 'none']).optional().describe('place: ground (default) snaps to the scene ground; none keeps y.'),
      set: schema.record(schema.string(), schema.unknown()).optional().describe('place: component overrides of this instance.'),
      dry_run: schema.boolean().optional().describe('put / remove: validate and report without writing.'),
    },
    { readOnly: false },
    (args, extra) => {
      const action = String(args.action);
      const project = enc(args.project_id);
      if (action === 'list' || action === 'get') {
        if (action === 'get' && (typeof args.kind !== 'string' || typeof args.id !== 'string')) return Promise.resolve(fail('get needs kind and id.'));
        return api(`gamekit-projects/${project}/content`, args, 'GET', extra?.signal, { kind: typeof args.kind === 'string' ? args.kind : undefined, id: typeof args.id === 'string' ? args.id : undefined });
      }
      const { project_id: _p, ...payload } = args;
      if (action === 'place') return api(`gamekit-projects/${project}/content/place`, payload, 'POST', extra?.signal);
      return api(`gamekit-projects/${project}/content`, payload, 'POST', extra?.signal);
    },
  );

  tool(
    'gripforge_game_play_url',
    'Play URL of a Game Kit project',
    'Get the browser play URL of a Game Kit project so a human (or a screenshot step) can run its current revision in the web runtime. Reads the project bundle and returns { url, absolute }; absolute is built on the GripForge origin of this key. Call it AFTER gripforge_gamekit_install or gripforge_game_project bind to check the result live. 0 credits.',
    { project_id: projectId },
    { readOnly: true },
    async (args, extra) => {
      const res = await api(`gamekit-projects/${enc(args.project_id)}/bundle`, args, 'GET', extra?.signal);
      if (res.isError) return res;
      const playUrl = (res.structuredContent as { playUrl?: unknown } | undefined)?.playUrl;
      if (typeof playUrl !== 'string' || !playUrl) return fail('Bundle has no playUrl yet — install at least one kit first.');
      let absolute = playUrl;
      try {
        absolute = new URL(playUrl, options.apiUrl).href;
      } catch {
        /* keep the raw value */
      }
      const data = { url: playUrl, absolute };
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    },
  );

  tool(
    'gripforge_game_test',
    'Playtest a Game Kit project',
    'Play the project headless and report what works and what is broken. Run it after building or changing a game, before telling the user it is done. An automatic player spawns, walks, follows the mission waypoints, uses what offers a prompt, picks things up and attacks enemies. Probes check each capability the game provides (character control, combat, XP and levels, inventory, interactions, missions, needs, gathering, crafting, building, machines, world counters). Detectors flag a stuck player, unreachable goals, kit exceptions, NaN positions, a player under the ground, enemies that never reach the player, and step time. Returns { summary, text, report, next }: text has one line per result, ✓ pass, ⚠ warning, ✕ failure, · not checked, each with its time, position, entity or kit; "provoked" means the tester set the condition up through the kit service. Fix the ✕ lines first, then run it again. report.notCovered lists the capabilities no probe looks at. report.replay replays the same inputs; pass it back as replay to check a fix against the same run. Deterministic: same project, seed and budget, same report. Runs in the compute service, about 5–20 s. 0 credits.',
    {
      project_id: projectId,
      budget_seconds: schema.number().int().min(5).max(300).optional().describe('Game time to play, in seconds (default 120).'),
      seed: schema.number().int().optional().describe('Seed of the run (default 1). The same seed gives the same report.'),
      replay: schema.record(schema.string(), schema.unknown()).optional().describe('report.replay of an earlier run: plays the same inputs again (seed and budget come from it).'),
      lang: schema.enum(['en', 'fr']).optional().describe('Language of text (default en).'),
    },
    { readOnly: true },
    (args, extra) => api(`gamekit-projects/${enc(args.project_id)}/playtest`, body(args), 'POST', extra?.signal),
  );

  tool(
    'gripforge_game_audit',
    'Audit a game: what is left before it is finished',
    'One report of everything that stands between a Game Kit project (gkp_…) and a FINISHED game of its genre — run it before telling the user a game is done, and again after each round of fixes. It aggregates, by severity (blocker / major / minor): creatures (slots drawn as a capsule, models without a skeleton, missing movement or action clips, the animation chain in progress), controls (no control scheme, the suggested one, keys shared by two actions in one mode, playable actions without a key), content (missing capabilities, required slots, the game.engine report), the last headless playtest (failures, warnings, the keys / models / animations probes, capabilities no probe covers) and completeness: what a finished game of the genre has beyond the literal request (MOBA: distinct heroes with Q/W/E/R, minions, towers, jungle monsters, shop, respawn; FPS: weapon, ammo, reload, crosshair, enemies; platformer: checkpoints, collectibles, end of level; racing: laps, ranking, AI opponents… and for every game a way to win AND to lose, title / pause / end screens, sound, a HUD, touch controls), checked against facts of the project, never a declaration. Each defect carries fix { tool, args, note, auto?, credits? }: call it as given. Returns { verdict: complete | playable_with_defects | incomplete, headline, genre, counts, defects, next (ordered calls), sections, text, play_url }. fix=true first applies what is free and safe (the best free Library model on each capsule — rebind at will —, the free standard clips, the suggested control scheme) and reports it in fixes. playtest="run" plays the game headless first (5–20 s); the default reads the last playtest and says when it is stale. Never refuses a write and never spends: paid fixes (a priced model, a rig, a generation) come back with their price to ask the user about. Aim for verdict complete; if you stop before, tell the user exactly what is left. 0 credits.',
    {
      project_id: projectId,
      fix: schema.boolean().optional().describe('true: apply the free and safe fixes first (free models on capsules, standard clips, suggested control scheme), then read. Nothing paid is ever done.'),
      playtest: schema.enum(['last', 'run']).optional().describe('last (default): read the stored playtest of the project. run: play it headless now, then read.'),
      brief: schema.string().max(2000).optional().describe('Free words about the game (theme, setting): they weigh in the model proposals.'),
    },
    { readOnly: false },
    (args, extra) => (args.fix === true || args.playtest === 'run'
      ? api(`gamekit-projects/${enc(args.project_id)}/audit`, body(args), 'POST', extra?.signal, undefined, 280_000)
      : api(`gamekit-projects/${enc(args.project_id)}/audit`, { workspace_id: args.workspace_id }, 'GET', extra?.signal, { brief: typeof args.brief === 'string' ? args.brief : undefined })),
  );

  tool(
    'gripforge_moba_roster',
    'Set the champions of a MOBA project',
    'Turn champions into the playable roster of a moba project (preset "moba"). Pass the Library ids of 1 to 10 champions that carry an ability pack (the items made by gripforge_abilities_generate: rigged model + basic_attack and ability_q…r clips). Writes the moba_heroes and abilities collections (ids <hero>__ability_q), binds each champion to moba_hero_<n> and the player\'s champion (player, else the first) to player_character. Bots play the other champions. Returns the heroes with their attack and Q/W/E/R. Then gripforge_game_play_url to play. 0 credits.',
    {
      project_id: projectId,
      heroes: schema.array(schema.string()).min(1).max(10).describe('Library ids (lib_…) of champions with an ability pack, in roster order.'),
      player: schema.string().optional().describe('The champion the player controls (one of heroes); default the first.'),
    },
    { readOnly: false },
    async (args, extra) => {
      const { project_id, ...body } = args as { project_id: string; heroes: string[]; player?: string };
      return api(`gamekit-projects/${enc(project_id)}/moba-roster`, body, 'PUT', extra?.signal);
    },
  );

  tool(
    'gripforge_ability_vfx',
    'Give every ability of a game its cast effect',
    'Write and bind a cast effect for each ability of a Game Kit project that has none: an area gets a ground shockwave, a line a bolt and its trail, an arc a sweeping crescent, a self cast a rising aura; colour from the ability\'s words (fire, frost, wind, holy…), size from its range, ultimates larger. The project needs the fx.ability_vfx kit (the moba preset installs it) and an abilities collection (gripforge_moba_roster writes it). Effects are procedural sources saved as VFX items and bound to ability_vfx:<ability id>, immediately. replace: true rewrites the existing ones; abilities limits to some ids. A hand-made or generated VFX bound to the same slot takes over. 0 credits.',
    {
      project_id: projectId,
      replace: schema.boolean().optional().describe('Rewrite abilities that already have an effect (default: keep them).'),
      abilities: schema.array(schema.string()).max(80).optional().describe('Only these ability ids (default: all).'),
    },
    { readOnly: false },
    async (args, extra) => {
      const { project_id, ...body } = args as { project_id: string; replace?: boolean; abilities?: string[] };
      return api(`gamekit-projects/${enc(project_id)}/ability-vfx`, body, 'POST', extra?.signal);
    },
  );

  tool(
    'gripforge_moba_map',
    'Generate, dress, check and set the map of a MOBA project',
    'The map of a moba project as a gameplay plan: bounds, team bases and spawns, 1 to 5 lanes (the minions\' paths), structure slots (towers, inhibitors, nexus), jungle zones and camp slots, objective zones, the divider (river: walkable; chasm, lava, void: crossed only at bridges), crossings, bush zones, walls, camera limits and symmetry. action "generate" builds a fair map (mirrored through the centre) from lanes, divider, size, team_size, camps_per_jungle, objectives, bushes, walls and returns it with a playability report; apply: true puts it in the project (moba_maps, the match\'s map and team size, the camera turn). action "validate" checks a map you pass, or the project\'s: every lane open end to end, spawns, structures and camps reachable, nothing out of bounds, the declared symmetry respected. action "set" stores an edited map document (refused while it has errors, unless force). action "get" returns the current map and its report. New maps default to style {theme: "sanctum", detail: "high", seed: 11, relief: "landscape"}. action "dress" previews a reusable procedural finish for the current map: jungle plateaus, river banks and paved fords, terraced bases, walkable staircases, carved structures, clustered forests, stone guardians and lilies; apply: true saves only the map document, keeping its lane layout and camera configuration; relief updates the shared terrain mesh, ground queries and stair collisions; landscape is the default, terraced keeps base terraces only, flat keeps a level arena. Themes: sanctum, wildwood, ashen; detail: low, medium, high; seed makes the finish repeatable. Bound Library models and textures take precedence. The scenery kit dresses walls and bushes with the bound models. 0 credits.',
    {
      project_id: projectId,
      action: schema.enum(['get', 'generate', 'dress', 'validate', 'set']).optional().describe('Default: get. dress previews a finish for the existing map, without rebuilding its layout; apply: true saves it.'),
      style: schema.object({
        relief: schema.enum(['landscape', 'terraced', 'flat']).optional().describe('Default landscape: jungle plateaus, river banks and terraced gardens; shared terrain mesh, physics and unit heights. terraced keeps only the gardens; flat keeps a level map.'),
        theme: schema.enum(['sanctum', 'wildwood', 'ashen']).optional().describe('sanctum: pale carved stone, gold, contrasting groves and lilies; wildwood: mossy forest; ashen: weathered volcanic stone. Default: sanctum.'),
        detail: schema.enum(['low', 'medium', 'high']).optional().describe('Procedural decoration budget, default high. Navigation is identical at all levels.'),
        seed: schema.number().int().min(0).max(2147483646).optional().describe('Repeatable finish, default 11.'),
      }).strict().optional().describe('generate / dress: art direction stored with the map. Paved lanes, inset seals, bevelled stone borders, banks, plants, lilies and entrance lights. Bound Library models and textures take precedence.'),
      lanes: schema.number().int().min(1).max(5).optional().describe('generate: number of lanes (default 3).'),
      divider: schema.enum(['river', 'chasm', 'lava', 'void', 'none']).optional().describe('generate: what separates the halves (default river).'),
      size: schema.number().min(100).max(400).optional().describe('generate: side of the square map in metres.'),
      team_size: schema.number().int().min(1).max(5).optional().describe('generate: heroes per team (default 3 for one lane, 5 otherwise).'),
      camps_per_jungle: schema.number().int().min(0).max(3).optional().describe('generate: small camps in each jungle (default 2).'),
      objectives: schema.number().int().min(0).max(4).optional().describe('generate: epic objectives on the divider.'),
      bushes: schema.boolean().optional().describe('generate: stealth bushes along the lanes (default true).'),
      walls: schema.boolean().optional().describe('generate: rock walls behind the camps (default true).'),
      id: schema.string().max(41).optional().describe('generate: id of the new map (lowercase, digits, _).'),
      name: schema.string().max(80).optional().describe('generate: display name of the map.'),
      apply: schema.boolean().optional().describe('generate / dress: store the result in the project (default: preview only).'),
      map: schema.record(schema.string(), schema.unknown()).optional().describe('validate / set: a full map document.'),
      force: schema.boolean().optional().describe('set: store a map that has errors.'),
    },
    { readOnly: false },
    async (args, extra) => {
      const { project_id, ...body } = args as { project_id: string } & Record<string, unknown>;
      return api(`gamekit-projects/${enc(project_id)}/moba-map`, body, 'POST', extra?.signal);
    },
  );

  tool(
    'gripforge_terrain_map_use',
    'Play a terrain studio map in a game',
    'Make a map of the terrain studio the world of a game that has the world.terrain kit. Pass map (a terrain studio map id, lvl_…) or scene (a scene id, with terrain when the scene has several terrain nodes). The map is baked once into a file (heights, ground roles, lakes and rivers, vegetation, roads, spawn and objective points) stored in the Library and bound to the terrain_map slot; the project data keeps its reference in terrain_maps. The same file is delivered to Godot, Unity and Unreal with the kit. Buildings and other non-vegetation props, and terrain holes, are not carried yet (counted in map.notCarried). Without a bound map world.terrain keeps generating its world from the seed. 0 credits.',
    {
      project_id: projectId,
      map: schema.string().optional().describe('Terrain studio map id (lvl_…).'),
      scene: schema.string().optional().describe('Scene id whose terrain node becomes the world (instead of map).'),
      terrain: schema.string().optional().describe('Terrain node id in the scene (default: its first terrain).'),
    },
    { readOnly: false },
    async (args, extra) => {
      const { project_id, ...body } = args as { project_id: string; map?: string; scene?: string; terrain?: string };
      return api(`gamekit-projects/${enc(project_id)}/terrain-map`, body, 'PUT', extra?.signal);
    },
  );
}
