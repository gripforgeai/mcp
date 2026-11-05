import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

/** Same release API as the editor and CLI. Packaging, signing keys and Steam login remain on the publisher's machine. */
export function registerGameReleaseTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const shape = {
    project_id: schema.string().regex(/^gkp_[A-Za-z0-9_-]{2,100}$/),
    action: schema.enum(['history', 'snapshot', 'register', 'promote']),
    revision: schema.number().int().min(1).optional(),
    build_id: schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,100}$/).optional(),
    channel: schema.enum(['stable', 'beta']).optional(),
    expected_revision: schema.number().int().min(0).optional(),
    manifest: schema.record(schema.string(), schema.unknown()).optional(),
    public_key: schema.string().max(256).optional(),
    workspace_id: schema.string().max(100).optional(),
  };
  register('gripforge_game_releases', {
    title: 'Game releases · desktop updates and Steam',
    description: 'Read immutable game release history and stable/beta channel revisions; obtain a snapshot fingerprint for an exact saved project revision; register a prepared signed release; or promote its build ID with expected_revision from history. Direct Windows/macOS updates use the signed launcher feed. Steam builds use SteamPipe and are promoted in Steamworks separately. Registering never promotes. Use gripforge game-release prepare/finalize/publish locally for packaging, signatures and binary uploads; game-release steam-upload uses an already authorized local SteamCMD account. Never send a signing private key or Steam password to this tool. A missing artifact returns warnings and preserves the current channel.',
    inputSchema: shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const a = parsed.data, key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    if ((a.action === 'snapshot' && a.revision === undefined) || (a.action === 'promote' && (!a.build_id || !a.channel || a.expected_revision === undefined)) || (a.action === 'register' && !a.manifest)) return { isError: true, content: [{ type: 'text', text: 'Missing action fields: snapshot needs revision; register needs manifest; promote needs build_id, channel and expected_revision.' }] };
    const suffix = a.action === 'history' ? '' : a.action === 'snapshot' ? '/snapshot' : a.action === 'register' ? '/releases' : `/channels/${a.channel}`;
    const body = a.action === 'snapshot' ? { revision: a.revision } : a.action === 'register' ? { manifest: a.manifest, publicKey: a.public_key } : { buildId: a.build_id, expectedRevision: a.expected_revision };
    try {
      const response = await fetch(`${options.apiUrl.replace(/\/$/, '')}/api/v1/game-releases/${a.project_id}${suffix}`, {
        method: a.action === 'history' ? 'GET' : a.action === 'promote' ? 'PUT' : 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(a.workspace_id ? { 'x-workspace-id': a.workspace_id } : {}) },
        ...(a.action === 'history' ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(60000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const result = await response.json();
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (e) { return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : 'Release request failed.' }] }; }
  });
}
