import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

/** Shared hosted/npm contract: assets are discovered independently of game modules. */
export function registerAssetProductionTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const origin = options.apiUrl.replace(/\/$/, '');
  const workspace = schema.string().max(100).optional().describe('Authorized workspace; defaults to the connected workspace.');
  const result = (data: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data });
  async function request(path: string, workspaceId: unknown, method = 'GET', body?: unknown) {
    const key = options.getApiKey(); if (!key) throw Error('GripForge API key required.');
    const response = await fetch(origin + '/api/v1/' + path, { method, headers: { 'x-api-key': key, 'x-gripforge-client': 'mcp', ...(body ? { 'content-type': 'application/json' } : {}), ...(typeof workspaceId === 'string' ? { 'x-workspace-id': workspaceId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw Error(String(data.error ?? `HTTP ${response.status}`));
    return data;
  }
  const wrap = (run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>) => async (args: Record<string, unknown>) => {
    try { return result(await run(args)); }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] }; }
  };
  register('gripforge_generate_weapon_catalog', {
    title: 'Generate a weapon catalogue',
    description: 'Plan then manufacture 1–64 original static weapon models using the existing Meshy PBR pipeline. plan is free and returns an exact aggregate quote and plan_hash. build requires that hash, an explicit budget covering the quote and a stable idempotency_key. One durable job, two bounded fabrication lanes, per-weapon checkpoints and billing; cancellation/retry preserves finished work and provider task IDs. Results remain private work assets. Inspect geometry, textures and actual renderer output before publishing. Does not create attack/reload animations, grip bindings, or flexible-chain physics. Poll gripforge_generation_read; result.items contains Library IDs and Studio links.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      stage: schema.enum(['plan','build']), workspace_id: workspace,
      entries: schema.array(schema.object({ key: schema.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/), name: schema.string().min(1).max(160), prompt: schema.string().min(3).max(600), subtype: schema.string().min(1).max(60), style: schema.enum(['gun','melee','shield','staff']).optional(), polycount: schema.number().int().min(500).max(20000).optional(), tags: schema.array(schema.string().min(1).max(60)).max(16).optional() }).strict()).min(1).max(64),
      plan_hash: schema.string().regex(/^[a-f0-9]{64}$/).optional(),
      budget: schema.object({ credits: schema.number().nonnegative().optional(), usd: schema.number().nonnegative().optional() }).strict().optional(),
      idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
    },
  }, wrap(args => request('weapons/catalog', args.workspace_id, 'POST', args)));
  register('gripforge_generation_quote', {
    title: 'Estimate generation usage before spending',
    description: 'Free quote for a model, concept, texture, rig or animation. Reports the account funding mode, available balance and estimated operation cost. A subscription combines AI and paid asset generation in one monthly limit without also charging generation credits. Quote every missing role, propose the plan, and obtain a generation budget before submitting paid jobs. Estimates cover one operation, not the full concept/rig/review pipeline.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { kind: schema.enum(['model','concept','texture','rig','animation']), provider: schema.enum(['meshy','tripo','xai','openai']).optional(), count: schema.number().int().min(1).max(20).optional(), workspace_id: workspace },
  }, wrap(args => {
    const params = new URLSearchParams({ kind: String(args.kind), count: String(args.count ?? 1) });
    if (args.provider) params.set('provider', String(args.provider));
    return request(`generation-quote?${params}`, args.workspace_id);
  }));
  register('gripforge_asset_search', {
    title: 'Search workspace and Community assets',
    description: 'Search actual asset models, materials and animations, independently of Game Kit modules. Returns provenance, import requirements and Library ids. Results are ranked best first by fitness for a GripForge game (score/100, grade A–D, reasons: triangle budget for the target, rigged and clean rig, clips, empty-handed characters, attachable weapons, classified, file size, adoption); `best` is the top pick across sources. Prefer grade A/B; read the reasons before choosing a C/D. Search both sources before manufacturing missing roles. An empty kit search does not mean there are no assets. Search is free; never substitutes proxy geometry for finished models. In a Game Kit project, use it to fill what gripforge_game_audit reports missing (a creature slot gets ranked proposals from gripforge_gamekit_creatures; a character without clips is animated, not left idle).',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      q: schema.string().max(200).describe('Visual role or style, e.g. sci-fi turret, rock, soldier.'),
      kind: schema.enum(['character','fps-arms','enemy','weapon','equipment','prop','texture','skybox','vfx','animation','audio','kit']).optional().describe('Optional asset kind.'),
      source: schema.enum(['workspace','community','both']).optional().describe('Defaults to both.'),
      limit: schema.number().int().min(1).max(48).optional().describe('Results per source; default 12.'),
      offset: schema.number().int().min(0).max(10000).optional().describe('Pagination offset per source; default 0.'),
      target: schema.enum(['mobile','desktop']).optional().describe('Platform the game ships on: sets the triangle and file budgets of the rank. Defaults to mobile.'),
      sort: schema.enum(['rank','newest']).optional().describe('rank (default): best fit first; newest: most recent first.'),
      workspace_id: workspace,
    },
  }, wrap(async args => {
    const limit = Number(args.limit ?? 12), offset = Number(args.offset ?? 0);
    const target = args.target === 'desktop' ? 'desktop' : 'mobile';
    const qs = new URLSearchParams({ q: String(args.q ?? ''), limit: String(limit), offset: String(offset), sort: args.sort === 'newest' ? 'newest' : 'rank', target });
    if (args.kind) qs.set('kind', String(args.kind));
    const sources = args.source === 'workspace' ? ['workspace'] : args.source === 'community' ? ['community'] : ['workspace','community'];
    const data = await Promise.all(sources.map(async source => {
      const response = await request(`${source === 'workspace' ? 'library' : 'community'}?${qs}`, args.workspace_id);
      const items = (Array.isArray(response.items) ? response.items : []).slice(0, limit) as Record<string, unknown>[];
      return { source, total: response.total ?? items.length, items: items.map(item => {
        const meta = (item.meta && typeof item.meta === 'object' ? item.meta : {}) as Record<string, unknown>;
        const rank = (item.rank && typeof item.rank === 'object' ? item.rank : null) as { score?: number; grade?: string; reasons?: Array<{ code: string; points: number; note: string }> } | null;
        return { id: item.id, name: item.name, kind: item.kind, filename: item.filename, source,
          score: rank?.score ?? null, grade: rank?.grade ?? null, reasons: (rank?.reasons ?? []).slice(0, 5).map(r => `${r.points > 0 ? '+' : ''}${r.points} ${r.note}`),
          triangles: meta.triangles, tags: meta.tags, rigged: meta.rigged, placeholder: meta.placeholder === true || /proxy_|volume de travail/i.test(String(item.filename) + ' ' + String(item.name)),
          next: source === 'community' ? 'gripforge_asset_clone, then gripforge_library_pull' : 'gripforge_library_get / gripforge_library_pull',
        };
      }) };
    }));
    // The top pick across sources; a workspace copy wins a tie (no credit to take it).
    const best = data.flatMap(d => d.items).filter(i => typeof i.score === 'number' && !i.placeholder)
      .sort((a, b) => (b.score as number) - (a.score as number) || (a.source === 'workspace' ? -1 : 1))[0] ?? null;
    return { target, best, results: data, note: 'Ranked for a GripForge game (see reasons). Inspect suitability and textures/animations before importing. Downloads alone are not runtime integration.' };
  }));
  register('gripforge_asset_clone', {
    title: 'Copy a Community asset to the workspace',
    description: 'Copy a published Community asset into the connected workspace. Assets and armor sets are free by default. Only an explicit creator price is charged, using paid credits. Repeated takes are not billed again but may create another copy: reuse an existing workspace id when possible. Returns the private Library item and signed file URL. Download it with gripforge_library_pull, then import into the actual game.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { id: schema.string().regex(/^lib_[A-Za-z0-9_-]+$/).describe('Published Community Library id.'), workspace_id: workspace },
  }, wrap(args => request(`community/${encodeURIComponent(String(args.id))}/clone`, args.workspace_id, 'POST')));
}

/** 202 response: do not strip job ids or misrepresent a queued model as a Library item. */
export function assetGenerationOutput(schema: typeof z = z) {
  return schema.object({
    job: schema.string().optional(), job_id: schema.string().optional(), status: schema.string().optional(), stage: schema.string().optional(),
    status_url: schema.string().optional(), studio_url: schema.string().optional(), library_url: schema.string().optional(),
    item: schema.record(schema.string(), schema.unknown()).optional(), provider: schema.string().optional(), notes: schema.array(schema.string()).optional(),
  }).passthrough();
}
