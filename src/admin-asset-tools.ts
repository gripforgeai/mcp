import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const ADMIN_ASSET_TOOL_NAMES = ['gripforge_admin_assets', 'gripforge_admin_assets_update'] as const;

const ID = /^lib_[A-Za-z0-9_-]{8,64}$/;

/**
 * ADMIN ONLY. The platform's assets, every workspace (`/api/v1/admin/assets`): list and filter them,
 * then rate, tag, feature, hide, publish or pack them. A non-admin key gets 403.
 * Hosted and local MCP share this module.
 */
export function registerAdminAssetTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const call = async (method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown, signal?: AbortSignal) => {
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text' as const, text: 'GripForge API key required.' }] };
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + path, {
        method,
        headers: { 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
      });
      const data = await response.json().catch(() => ({ error: response.statusText }));
      if (response.status === 403) return { isError: true, content: [{ type: 'text' as const, text: 'admin only — the GripForge admin asset tools are not available on this key.' }] };
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Admin asset request failed.' }] };
    }
  };

  const listShape = {
    id: schema.string().regex(ID).optional().describe('One asset: its full detail (meta, usage, dependents) instead of a list.'),
    q: schema.string().max(120).optional().describe('Name, id, file name, owner or description.'),
    kind: schema.string().max(40).optional(),
    workspace: schema.string().max(80).optional(),
    owner: schema.string().max(254).optional(),
    published: schema.enum(['yes', 'no']).optional(),
    pack: schema.string().max(160).optional(),
    tag: schema.string().max(80).optional(),
    style: schema.string().max(80).optional(),
    rating: schema.enum(['none', '1', '2', '3', '4', '5']).optional().describe('none = not rated yet (the review queue).'),
    curation: schema.enum(['featured', 'hidden']).optional(),
    sort: schema.enum(['created_at', 'updated_at', 'bytes', 'name', 'triangles', 'kind', 'rating']).optional(),
    dir: schema.enum(['asc', 'desc']).optional(),
    page: schema.number().int().min(1).optional(),
    size: schema.number().int().min(1).max(100).optional(),
  };
  register(ADMIN_ASSET_TOOL_NAMES[0], {
    title: 'Platform assets (admin)',
    description: 'ADMIN ONLY. Every asset of the platform, all workspaces: filter by kind, owner, tag, pack, style, team rating (rating=none is the review queue) or curation (featured, hidden), sort by rating or size. Each row has its team rating (1–5), featured / hidden flags and its mobile rank (0–100). Pass id for one asset in full. Refused for non-admin keys. Change them with gripforge_admin_assets_update.',
    inputSchema: listShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    const parsed = schema.object(listShape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const { id, ...filters } = parsed.data;
    if (id) return call('GET', `/api/v1/admin/assets/${id}`, undefined, extra?.signal);
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return call('GET', `/api/v1/admin/assets${qs.size ? `?${qs}` : ''}`, undefined, extra?.signal);
  });

  const updateShape = {
    action: schema.enum(['rate', 'tag', 'untag', 'set_tags', 'feature', 'unfeature', 'hide', 'unhide', 'publish', 'unpublish', 'pack']).describe(
      'rate: team rating 1–5 (rating null removes it), weighs on the rank (1★ −16 … 5★ +16). tag / untag: add or remove one tag. set_tags: replace the tags of ONE asset. feature: first in the community rank sort. hide: out of the community listings, search and sitemap, still served by its id (games keep it). publish / unpublish: community visibility. pack: file into a collection (pack null removes it).',
    ),
    ids: schema.array(schema.string().regex(ID)).min(1).max(200),
    rating: schema.number().int().min(1).max(5).nullable().optional(),
    tag: schema.string().trim().min(1).max(40).optional(),
    tags: schema.array(schema.string().trim().min(1).max(40)).max(40).optional().describe('set_tags only.'),
    pack: schema.string().trim().min(1).max(160).nullable().optional(),
  };
  register(ADMIN_ASSET_TOOL_NAMES[1], {
    title: 'Rate, tag and curate assets (admin)',
    description: 'ADMIN ONLY. Curate platform assets in bulk (up to 200 ids): rate 1–5 (moves the community rank), add or remove a tag, replace the tags of one asset, feature (first in the rank sort), hide (out of listings and search, still served by id), publish / unpublish, file into a pack. Every change is audited with the admin who made it. Find ids with gripforge_admin_assets. Deleting stays in the /admin/assets screen. Refused for non-admin keys.',
    inputSchema: updateShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    const parsed = schema.object(updateShape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const { action, ids, rating, tag, tags, pack } = parsed.data;
    const need = (ok: boolean, text: string) => (ok ? null : { isError: true, content: [{ type: 'text' as const, text }] });
    if (action === 'set_tags') {
      return need(ids.length === 1 && tags !== undefined, 'set_tags takes one id and tags.') ?? call('PATCH', `/api/v1/admin/assets/${ids[0]}`, { tags }, extra?.signal);
    }
    if (action === 'rate') return need(rating !== undefined, 'rate needs rating (1–5, or null to remove it).') ?? call('POST', '/api/v1/admin/assets', { action, ids, rating }, extra?.signal);
    if (action === 'tag' || action === 'untag') return need(Boolean(tag), `${action} needs tag.`) ?? call('POST', '/api/v1/admin/assets', { action, ids, tag }, extra?.signal);
    if (action === 'pack') return need(pack !== undefined, 'pack needs pack (a name, or null to remove it).') ?? call('POST', '/api/v1/admin/assets', { action, ids, pack }, extra?.signal);
    return call('POST', '/api/v1/admin/assets', { action, ids }, extra?.signal);
  });
}
