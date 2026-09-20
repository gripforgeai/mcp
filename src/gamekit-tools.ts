/** Modular Game Kits tools. Studio and MCP call the same Core HTTP API. */
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const GAMEKIT_TOOL_NAMES = [
  'gripforge_gamekit_search',
  'gripforge_gamekit_get',
  'gripforge_gamekit_install',
  'gripforge_gamekit_remove',
  'gripforge_gamekit_configure',
  'gripforge_gamekit_dependencies',
  'gripforge_gamekit_update',
  'gripforge_gamekit_deliver',
  'gripforge_game_capabilities',
  'gripforge_game_project',
  'gripforge_game_play_url',
] as const;

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
  const range = schema.string().max(80).optional().describe('Semver range to satisfy (e.g. ^1.2.0, 1.x). Default: latest compatible version.');
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
        signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
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
        description,
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
    'gripforge_gamekit_search',
    'Search the Game Kit catalogue',
    'Start here. Search the modular Game Kit catalogue (vehicle.driveable, mission.objectives, npc.wanted, …) by free text, capability, tag or engine target. Pass project_id to score kits against that project: each hit then carries state { installed, updateAvailable, compatible, conflicts, reason } and kits that fill one of its missing capabilities rank first. Returns { kits, presets }; legacy genre kits appear as legacy.* and are installed with gripforge_kit, not here. Kart Racing is native: compose world.racetrack + vehicle.driveable + race.kart; edit race_tracks through project data. world.lighting adds shared sun/fill, point lights and spots, presets, bounded light budgets and bloom; edit world_lights through project data. Call this BEFORE gripforge_gamekit_install. 0 credits.',
    {
      q: schema.string().max(200).optional().describe('Free text matched on id, name, description and tags (e.g. "drive a car", "wanted level").'),
      capability: schema.string().max(120).optional().describe('Capability the kit must provide (exact id or prefix, e.g. vehicle.drive).'),
      tag: schema.string().max(60).optional().describe('Tag filter (e.g. vehicle, mission, npc, legacy).'),
      target: schema.enum(['web', 'godot', 'unity', 'unreal']).optional().describe('Engine target the kit must support. Default web.'),
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
    'Read one Game Kit: its manifest (provides / requires capabilities, asset slots, data collections, events), README docs, config JSON schema with defaults, and published versions. Pass with_usage=true to also list the workspace projects that have it installed. Call this BEFORE gripforge_gamekit_configure to know which config keys exist. 0 credits.',
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
    'gripforge_gamekit_install',
    'Install a Game Kit into a project',
    'Add a modular gameplay kit to a Game Kit project (gkp_…). Dependencies declared in the kit manifest are resolved and added automatically; the response returns the plan (add / upgrade / keep) and the updated capabilities. Pass dry_run=true to preview without writing. Call gripforge_game_capabilities first to see what the project is missing, gripforge_gamekit_search to find the kit, then gripforge_gamekit_configure to tune it. Legacy genre kits (legacy.*) are not installable here — use gripforge_kit. 0 credits.',
    {
      project_id: projectId,
      id: kitId,
      range,
      config,
      dry_run: schema.boolean().optional().describe('true to return the install plan without writing the project.'),
      allow_planned: schema.boolean().optional().describe('true to accept kits still marked planned (0.x, no runtime yet). Default false.'),
    },
    { readOnly: false },
    (args, extra) => api(`gamekit-projects/${enc(args.project_id)}/kits`, { ...body(args), id: args.id }, 'POST', extra?.signal),
  );

  tool(
    'gripforge_gamekit_remove',
    'Uninstall a Game Kit from a project',
    'Uninstall a kit from a Game Kit project (gkp_…). Refused with 409 kit_in_use while other installed kits still require one of its capabilities; pass force=true to remove it anyway and prune=true to also drop the dependencies nothing else needs. Returns { removed[], project }. Call gripforge_gamekit_dependencies BEFORE forcing to see who depends on it. 0 credits.',
    {
      project_id: projectId,
      id: kitId,
      force: schema.boolean().optional().describe('true to remove even when other kits depend on it (their requirements become unresolved).'),
      prune: schema.boolean().optional().describe('true to also remove dependencies that no remaining kit requires.'),
    },
    { readOnly: false, destructive: true },
    (args, extra) =>
      api(`gamekit-projects/${enc(args.project_id)}/kits/${enc(args.id)}`, args, 'DELETE', extra?.signal, {
        force: args.force === true ? 1 : undefined,
        prune: args.prune === true ? 1 : undefined,
      }),
  );

  tool(
    'gripforge_gamekit_configure',
    'Configure an installed Game Kit',
    'Tune an installed kit: merge config values validated against the kit configSchema (read it with gripforge_gamekit_get), or toggle enabled to switch the kit off without uninstalling it. Returns { kit, project } with the new project revision. Call this AFTER gripforge_gamekit_install. 0 credits.',
    {
      project_id: projectId,
      id: kitId,
      config,
      enabled: schema.boolean().optional().describe('false to disable the kit at runtime while keeping it installed; true to re-enable.'),
    },
    { readOnly: false },
    (args, extra) => api(`gamekit-projects/${enc(args.project_id)}/kits/${enc(args.id)}`, body(args), 'PATCH', extra?.signal),
  );

  tool(
    'gripforge_gamekit_dependencies',
    'Dependency graph of a project or kit',
    'Dependency graph of a Game Kit project: nodes (installed kits with version, provides, requires), edges labelled by capability, conflicts and unresolved requirements. Pass project_id for the installed graph; pass a kit id instead to read the declared requires / provides tree of a catalogue kit before installing it. Call this BEFORE gripforge_gamekit_remove with force. 0 credits.',
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
    'Check or apply Game Kit updates',
    'Check or apply kit updates in a Game Kit project. Dry-run by default: returns the plan (from / to version, breaking changes, migrations to run) without writing. Pass apply=true to write the new lockfile and run the migrations; range narrows the target version (e.g. ^1.2.0). Omit id to check every installed kit in one call. Call gripforge_gamekit_get on the target version to read its manifest first. 0 credits.',
    {
      project_id: projectId,
      id: kitId.optional().describe('Installed kit to update. Omit to check every installed kit.'),
      range,
      apply: schema.boolean().optional().describe('true to apply the update (new lockfile + migrations). Default false = plan only.'),
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
    'Turn catalogue kits, or the enabled kits of a Game Kit project, into engine files: Godot gets GDScript, scenes and config under gripforge/kits/<kit>/, Unity and Unreal get recipes, web needs nothing. Call with dry_run=true FIRST: it returns the plan (files to add / keep / modify / delete, conflicts, dependencies, post-install steps) and never charges. Pass project_state (the current gripforge/gamekits.lock.json, path → sha256 of the files under gripforge/, engineVersion) so updates keep your edits and detect conflicts. Then call without dry_run to get the bundle. The hosted endpoint cannot write into your project: write bundle.files following plan.actions in order (backup, write, writeBin from bundle.binaries, delete with .uid / .import siblings, writeLock with bundle.lock), or use the npm client with project_dir (gripforge_gamekit_deliver_local), or the editor bridge. A blocked plan answers 409 with the plan: force backs up then overwrites edited files, accept_breaking allows a major update. Credits: the first delivery of a kit major version to an engine costs 1 credit per workspace; re-deliveries, updates within a major, dry runs and the web target are free.',
    {
      target: schema.enum(['godot', 'unity', 'unreal', 'web']).describe('Engine to deliver to: godot (files), unity / unreal (recipes), web (native, nothing to write).'),
      kits: schema
        .array(
          schema.object({
            id: kitId,
            version: schema.string().max(40).optional().describe('Exact version; only the latest is deliverable. Default latest.'),
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
      accept_breaking: schema.boolean().optional().describe('true → allow a breaking (major) update.'),
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
          acceptBreaking: args.accept_breaking === true,
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
    'Start here for an existing project. Report the capabilities a Game Kit project provides, what is still missing for a goal (a preset id from gripforge_gamekit_search or a comma-separated list of capabilities) and which catalogue kits would fill each gap. Call this BEFORE gripforge_gamekit_install to pick the next kit. 0 credits.',
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
    'gripforge_game_project',
    'List, create, read, bind, feed or delete Game Kit projects',
    'Manage Game Kit projects (gkp_…): the container holding installed kits, their lockfile, asset bindings and data collections. action=list lists the workspace projects; create needs name and takes a preset (see gripforge_gamekit_search) or an explicit kits map; get returns the full ProjectDetail (installed kits, bindings, capabilities, missing, playUrl); bind maps asset slots to Library items (lib_…, null to clear); data reads a collection or upserts / removes documents validated against the kits’ schemas (replace=true swaps the whole collection); delete needs confirm=true. Call this first to create or pick the project, then gripforge_gamekit_install. 0 credits.',
    {
      action: schema.enum(['list', 'create', 'get', 'bind', 'data', 'delete']).describe('list | create | get | bind | data | delete.'),
      project_id: projectId.optional().describe('Game Kit project id (gkp_…). Required for get, bind, data and delete.'),
      name: schema.string().min(1).max(120).optional().describe('create: project name.'),
      preset: schema.string().max(80).optional().describe('create: preset id whose default kits are installed (gripforge_gamekit_search returns presets).'),
      kits: schema.record(schema.string(), schema.boolean()).optional().describe('create: explicit kit toggles { "vehicle.driveable": true, … } on top of the preset. Unchecking a required kit fails with toggle_requires.'),
      target: schema.enum(['web', 'godot', 'unity', 'unreal']).optional().describe('create: engine target. Default web.'),
      bindings: schema.record(schema.string(), schema.string().nullable()).optional().describe('bind: { slot: lib_… | null } — Library item per asset slot declared by the installed kits, null clears.'),
      collection: schema.string().max(80).optional().describe('data: collection name declared by an installed kit (e.g. missions, npcs, zones).'),
      documents: schema.array(schema.record(schema.string(), schema.unknown())).max(500).optional().describe('data: documents to upsert (each with its id), validated against the kit schema.'),
      remove: schema.array(schema.string().max(120)).max(500).optional().describe('data: document ids to remove.'),
      replace: schema.boolean().optional().describe('data: true to replace the whole collection with documents.'),
      confirm: schema.boolean().optional().describe('delete: must be true. The project, its revisions and data are removed.'),
    },
    { readOnly: false },
    (args, extra) => {
      const action = String(args.action);
      if (action === 'list') return api('gamekit-projects', args, 'GET', extra?.signal);
      if (action === 'create') {
        if (typeof args.name !== 'string' || !args.name.trim()) return Promise.resolve(fail('create needs name.'));
        return api('gamekit-projects', body(args, 'bindings', 'collection', 'documents', 'remove', 'replace'), 'POST', extra?.signal);
      }
      if (typeof args.project_id !== 'string') return Promise.resolve(fail(`${action} needs project_id (gkp_…).`));
      const project = enc(args.project_id);
      if (action === 'get') return api(`gamekit-projects/${project}`, args, 'GET', extra?.signal);
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
      if (action === 'delete') {
        if (args.confirm !== true) return Promise.resolve(fail('delete needs confirm=true.'));
        return api(`gamekit-projects/${project}`, args, 'DELETE', extra?.signal, { confirm: 1 });
      }
      return Promise.resolve(fail(`Unknown action ${action}.`));
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
}
