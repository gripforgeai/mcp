/** Dedicated game-server tools. Dashboard and MCP call the same Core HTTP API. */
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const SERVER_TOOL_NAMES = [
  'gripforge_project_get',
  'gripforge_server_list',
  'gripforge_server_get',
  'gripforge_server_create',
  'gripforge_server_deploy',
  'gripforge_server_start',
  'gripforge_server_stop',
  'gripforge_server_restart',
  'gripforge_server_scale',
  'gripforge_server_delete',
  'gripforge_server_logs',
  'gripforge_server_metrics',
  'gripforge_server_events',
  'gripforge_build_list',
  'gripforge_build_get',
  'gripforge_build_deploy',
  'gripforge_build_rollback',
  'gripforge_players_list',
  'gripforge_player_get',
  'gripforge_player_kick',
  'gripforge_player_ban',
  'gripforge_game_broadcast',
  'gripforge_world_list',
  'gripforge_world_deploy',
  'gripforge_world_backup',
  'gripforge_world_restore',
  'gripforge_match_list',
  'gripforge_match_get',
  'gripforge_match_create',
  'gripforge_match_stop',
] as const;

export function registerServerTools(
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
  const serverId = schema.string().min(4).max(80).describe('Game server id (srv_…)');
  const playerId = schema.string().min(4).max(80).describe('Player session id (ses_…)');
  const buildId = schema.string().min(4).max(80).describe('Game build id (bld_…)');
  const projectId = schema.string().min(4).max(80).describe('Game project id (gpj_…)');
  const matchId = schema.string().min(4).max(80).describe('Match id (mtc_…)');

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
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Server API failed.' }] };
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

  tool(
    'gripforge_project_get',
    'Get a game project',
    'Read a dedicated-server project (gpj_…) in the authenticated workspace. Not a Library asset.',
    { id: projectId },
    { readOnly: true },
    (args, extra) => api(`game-projects/${encodeURIComponent(String(args.id))}`, args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_server_list',
    'List game servers',
    'List dedicated game servers in the workspace with current status and latest instance.',
    {},
    { readOnly: true },
    (args, extra) => api('servers', args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_server_get',
    'Get a game server',
    'Read one dedicated server, its instance, engine/networking detection and integration status.',
    { id: serverId },
    { readOnly: true },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}`, args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_server_create',
    'Create a game server',
    'Create a dedicated server record. Implemented: Unity+FishNet (Docker demo) and Godot+ENet (real Godot Linux headless in Docker). Unreal returns unsupported. Does not start the process until deploy.',
    {
      name: schema.string().min(1).max(80),
      engine: schema.enum(['unity', 'unreal', 'godot', 'custom']).optional(),
      networking: schema.enum(['fishnet', 'ngo', 'mirror', 'photon', 'enet', 'custom', 'unknown']).optional(),
      environment: schema.enum(['production', 'staging', 'development']).optional(),
      region: schema.string().max(40).optional(),
      maxPlayers: schema.number().int().min(1).max(200).optional(),
      gamePort: schema.number().int().min(1).max(65535).optional(),
      sourceKind: schema.enum(['project', 'git', 'upload', 'docker']).optional(),
      image: schema.string().max(200).optional(),
      hints: schema.string().max(2000).optional(),
      demo: schema.boolean().optional(),
    },
    { readOnly: false },
    (args, extra) => api('servers', args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_server_deploy',
    'Deploy a game server',
    'Create a Docker instance for this server and start it. Local demo uses a real container (python heartbeat unless a custom image is set). Mutating.',
    { id: serverId },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/deploy`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_server_start',
    'Start a game server',
    'Start the existing instance. Mutating.',
    { id: serverId },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/start`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_server_stop',
    'Stop a game server',
    'Stop the running instance. Mutating.',
    { id: serverId },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/stop`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_server_restart',
    'Restart a game server',
    'Restart the running instance. Mutating.',
    { id: serverId },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/restart`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_server_scale',
    'Scale max players',
    'Update desired max players. Does not resize cloud hardware (Docker provider has no node pool). Mutating.',
    { id: serverId, maxPlayers: schema.number().int().min(1).max(200) },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/scale`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_server_delete',
    'Delete a game server',
    'HIGH IMPACT. Stops the instance and deletes the server. Requires confirm=true. Owner only.',
    { id: serverId, confirm: schema.literal(true).describe('Must be true. Production-destructive.') },
    { readOnly: false, destructive: true },
    (args, extra) =>
      api(`servers/${encodeURIComponent(String(args.id))}`, args, 'DELETE', extra?.signal, { confirm: true }),
  );
  tool(
    'gripforge_server_logs',
    'Read server logs',
    'Stdout/stderr from the runtime provider (Docker logs). Not stored in SQL.',
    { id: serverId, tail: schema.number().int().min(20).max(2000).optional() },
    { readOnly: true },
    (args, extra) =>
      api(`servers/${encodeURIComponent(String(args.id))}/logs`, args, 'GET', extra?.signal, {
        tail: typeof args.tail === 'number' ? args.tail : 200,
      }),
  );
  tool(
    'gripforge_server_metrics',
    'Read server metrics',
    'CPU, memory, network counters and player count from the metrics provider.',
    { id: serverId },
    { readOnly: true },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/metrics`, args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_server_events',
    'Read server events',
    'Activity feed: server.created, server.ready, player.joined, match.started, …',
    { id: serverId },
    { readOnly: true },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/events`, args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_build_list',
    'List dedicated builds',
    'List game_builds (not Godot kit zips at /api/v1/builds).',
    {},
    { readOnly: true },
    (args, extra) => api('game-builds', args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_build_get',
    'Get a dedicated build',
    'Read one game build. Upload/deploy of Linux dedicated artifacts is not implemented yet.',
    { id: buildId },
    { readOnly: true },
    (args, extra) => api(`game-builds/${encodeURIComponent(String(args.id))}`, args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_build_deploy',
    'Deploy a build',
    'Not implemented. Returns 501 until artifact upload exists.',
    { id: buildId },
    { readOnly: false },
    (args, extra) => api(`game-builds/${encodeURIComponent(String(args.id))}/deploy`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_build_rollback',
    'Rollback a build',
    'Not implemented. Returns 501. Mutating / production-sensitive.',
    { id: buildId },
    { readOnly: false, destructive: true },
    (args, extra) => api(`game-builds/${encodeURIComponent(String(args.id))}/rollback`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_players_list',
    'List connected players',
    'Sessions reported by the Unity SDK. Empty until the SDK calls player.joined.',
    { id: serverId },
    { readOnly: true },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/players`, args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_player_get',
    'Get a player session',
    'Read one player session on a server.',
    { id: serverId, player_id: playerId },
    { readOnly: true },
    (args, extra) =>
      api(
        `servers/${encodeURIComponent(String(args.id))}/players/${encodeURIComponent(String(args.player_id))}`,
        args,
        'GET',
        extra?.signal,
      ),
  );
  tool(
    'gripforge_player_kick',
    'Kick a player',
    'Requires the Unity SDK. Currently returns 501. Mutating.',
    { id: serverId, player_id: playerId },
    { readOnly: false },
    (args, extra) =>
      api(
        `servers/${encodeURIComponent(String(args.id))}/players/${encodeURIComponent(String(args.player_id))}/kick`,
        args,
        'POST',
        extra?.signal,
      ),
  );
  tool(
    'gripforge_player_ban',
    'Ban a player',
    'HIGH IMPACT. Requires the Unity SDK. Currently returns 501. Owner only.',
    { id: serverId, player_id: playerId },
    { readOnly: false, destructive: true },
    (args, extra) =>
      api(
        `servers/${encodeURIComponent(String(args.id))}/players/${encodeURIComponent(String(args.player_id))}/ban`,
        args,
        'POST',
        extra?.signal,
      ),
  );
  tool(
    'gripforge_game_broadcast',
    'Broadcast to a match',
    'Requires the Unity SDK. Currently returns 501. Never runs a shell on the host.',
    { id: serverId, message: schema.string().max(500).optional() },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/broadcast`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_world_list',
    'List worlds',
    'Worlds stored for the workspace or a server’s project. Empty until worlds are implemented.',
    { id: serverId.optional() },
    { readOnly: true },
    (args, extra) =>
      args.id
        ? api(`servers/${encodeURIComponent(String(args.id))}/worlds`, args, 'GET', extra?.signal)
        : api('game-worlds', args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_world_deploy',
    'Deploy a world',
    'Not implemented. Returns 501.',
    { id: serverId },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/worlds`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_world_backup',
    'Backup a world',
    'Not implemented. Returns 501. Mutating.',
    { id: serverId },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/backups`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_world_restore',
    'Restore a backup',
    'HIGH IMPACT. Not implemented. Returns 501.',
    { id: serverId },
    { readOnly: false, destructive: true },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/restore`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_match_list',
    'List matches',
    'Matches recorded for a server (SDK or API).',
    { id: serverId },
    { readOnly: true },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/matches`, args, 'GET', extra?.signal),
  );
  tool(
    'gripforge_match_get',
    'Get a match',
    'Read one match record.',
    { id: serverId, match_id: matchId },
    { readOnly: true },
    (args, extra) =>
      api(
        `servers/${encodeURIComponent(String(args.id))}/matches/${encodeURIComponent(String(args.match_id))}`,
        args,
        'GET',
        extra?.signal,
      ),
  );
  tool(
    'gripforge_match_create',
    'Create a match record',
    'Records match.started. Does not spawn a new process. Mutating.',
    { id: serverId, map: schema.string().max(120).optional() },
    { readOnly: false },
    (args, extra) => api(`servers/${encodeURIComponent(String(args.id))}/matches`, args, 'POST', extra?.signal),
  );
  tool(
    'gripforge_match_stop',
    'Stop a match',
    'Marks the match ended. Mutating.',
    { id: serverId, match_id: matchId },
    { readOnly: false },
    (args, extra) =>
      api(
        `servers/${encodeURIComponent(String(args.id))}/matches/${encodeURIComponent(String(args.match_id))}`,
        args,
        'POST',
        extra?.signal,
      ),
  );
}
