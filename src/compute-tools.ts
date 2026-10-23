import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

/**
 * GripForge Compute: image or text → textured 3D prop (two GLBs), then colour / material variants of the same shape.
 * Every call goes to GripForge (quote, then confirmed launch, one debit); GripForge talks to the Compute router.
 * Each asset comes back with its direct edit page (`edit_url`) that the client can open.
 */
export const COMPUTE_TOOL_NAMES = ['gripforge_compute_status', 'gripforge_compute_generate', 'gripforge_compute_job', 'gripforge_compute_assets', 'gripforge_compute_variant', 'gripforge_compute_download'] as const;
const BUDGETS = ['petit_objet', 'en_main', 'outil_detaille', 'mobilier_simple', 'gros_mobilier'] as const;
type Options = { apiUrl: string; getApiKey: () => string | null | undefined; local?: boolean; readFile?: (path: string) => Promise<Buffer>; writeFile?: (path: string, bytes: Buffer) => Promise<string> };
type Result = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: 'text'; text: string }[] };

const fail = (text: string): Result => ({ isError: true, content: [{ type: 'text', text }] });
const ok = (data: Record<string, unknown>, isError = false): Result => ({ ...(isError ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });

/** Relative GripForge links (edit pages, files, status) become absolute so the client can open them. */
function absolute(value: unknown, base: string): unknown {
  if (Array.isArray(value)) return value.map(v => absolute(v, base));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('/') && /(_url|^url)$/.test(k) ? new URL(v, base).href : absolute(v, base)]));
}

export function registerComputeTools(register: VfxProjectRegister, options: Options, schema: typeof z = z) {
  const base = options.apiUrl.replace(/\/$/, '');
  const workspace = schema.string().max(100).optional().describe('Explicit workspace id. The key must have access to it.');
  async function call(path: string, init: { method?: string; body?: unknown; workspace?: unknown; signal?: AbortSignal } = {}) {
    const key = options.getApiKey();
    if (!key) return fail('GripForge API key required.');
    try {
      const response = await fetch(base + path, {
        method: init.method ?? 'GET', signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(init.signal ? [init.signal] : [])]),
        headers: { 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(typeof init.workspace === 'string' ? { 'x-workspace-id': init.workspace } : {}) },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
      const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as Record<string, unknown>;
      return ok(absolute(data, base) as Record<string, unknown>, !response.ok);
    } catch (error) { return fail(error instanceof Error ? error.message : 'GripForge Compute request failed.'); }
  }
  const editLinks = (assets: unknown, ws: unknown) => Array.isArray(assets) ? assets.map(a => {
    const id = (a as { assetId?: string }).assetId;
    return id ? { ...(a as object), edit_url: `${base}/generate-3d/studio?asset=${encodeURIComponent(id)}${typeof ws === 'string' ? `&workspace=${encodeURIComponent(ws)}` : ''}`, file_url: `${base}/api/v1/library/${encodeURIComponent(id)}/file?download=1` } : a;
  }) : assets;

  register(COMPUTE_TOOL_NAMES[0], {
    title: 'Compute · router status',
    description: 'GripForge Compute readiness (free, read-only): whether generation is open, which actions the router can run now (image, text, couleur, matiere) and a machine summary (ready / busy / starting). The router rents and stops its own machines; nothing is started by this call.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (_args, extra) => call('/api/v1/compute-assets', { signal: extra?.signal }));

  register(COMPUTE_TOOL_NAMES[1], {
    title: 'Compute · generate a 3D asset',
    description: 'ON DEMAND ONLY: use when the user asks for GripForge Compute; the default 3D generator stays gripforge_generate_prop without provider. Make a textured 3D prop/furniture asset with GripForge Compute from ONE image (image_base64 or a local image_path) or a text description (source=text). Two steps: stage=quote (free) returns quote.token and the price (credits or subscription); show it to the user, then stage=generate with that quote_token and confirm=true launches one durable job (debited once, after success). Poll gripforge_compute_job. Result: two GLBs (scene, detail) in the private library, each with edit_url (studio edit page) and file_url. Characters and vehicles are not supported yet.',
    inputSchema: {
      stage: schema.enum(['quote', 'generate']).describe('quote first (free), then generate'),
      source: schema.enum(['image', 'text']).optional().describe('Default image'),
      name: schema.string().min(1).max(100).describe('Asset name'),
      prompt: schema.string().min(3).max(500).optional().describe('source=text: one object, e.g. "a studded wooden pirate chest"'),
      image_base64: schema.string().max(12_000_000).optional().describe('source=image: PNG/JPEG/WebP, raw base64 or data URI, up to 8 MB'),
      ...(options.local ? { image_path: schema.string().max(1000).optional().describe('source=image: local PNG/JPEG/WebP file (instead of image_base64)') } : {}),
      object_type: schema.enum(BUDGETS).optional().describe('Triangle budget class. Default mobilier_simple'),
      quality: schema.enum(['standard', 'detail']).optional().describe('Texture quality. Default standard'),
      options: schema.array(schema.enum(['photo', 'matieres', 'relief'])).max(3).optional().describe('source=image: photo (keep visible details), matieres (refine materials), relief (surface detail). Default all three'),
      quote_token: schema.string().length(64).optional().describe('stage=generate: quote.token from the quote with the SAME inputs'),
      confirm: schema.boolean().optional().describe('stage=generate: true once the user accepted the quoted price'),
      idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional().describe('Stable key for retries of the same launch; generated if absent'),
      workspace_id: workspace,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const source = args.source === 'text' ? 'text' : 'image';
    let image: string | undefined;
    if (source === 'image') {
      if (typeof args.image_path === 'string' && options.readFile) {
        const bytes = await options.readFile(args.image_path).catch(() => null);
        if (!bytes) return fail('Cannot read image_path.');
        const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
        image = `data:${mime};base64,${bytes.toString('base64')}`;
      } else if (typeof args.image_base64 === 'string') {
        image = args.image_base64.startsWith('data:') ? args.image_base64 : `data:${args.image_base64.startsWith('/9j/') ? 'image/jpeg' : args.image_base64.startsWith('UklG') ? 'image/webp' : 'image/png'};base64,${args.image_base64}`;
      } else return fail('source=image needs image_base64' + (options.local ? ' or image_path.' : '.'));
    } else if (typeof args.prompt !== 'string') return fail('source=text needs prompt.');
    if (args.stage === 'generate' && (args.confirm !== true || typeof args.quote_token !== 'string')) return fail('stage=generate needs the quote_token of a quote with the same inputs and confirm=true after the user accepted the price.');
    const body = {
      action: args.stage, source, name: args.name, budget: args.object_type ?? 'mobilier_simple', quality: args.quality ?? 'standard',
      options: source === 'image' ? args.options ?? ['photo', 'matieres', 'relief'] : [], ...(source === 'image' ? { image } : { prompt: args.prompt }),
      ...(args.stage === 'generate' ? { accepted_quote: args.quote_token, idempotency_key: typeof args.idempotency_key === 'string' ? args.idempotency_key : `compute:mcp:${randomUUID()}` } : {}),
    };
    const result = await call('/api/v1/compute-assets', { method: 'POST', body, workspace: args.workspace_id, signal: extra?.signal });
    if (!result.isError && args.stage === 'quote' && result.structuredContent) result.structuredContent.next = 'Show the price to the user. If accepted, call again with stage=generate, the same inputs, quote_token=quote.token and confirm=true.';
    if (!result.isError && args.stage === 'generate' && result.structuredContent) result.structuredContent.next = 'Poll gripforge_compute_job with job.id until status is succeeded.';
    if (result.structuredContent) result.content = [{ type: 'text', text: JSON.stringify(result.structuredContent) }];
    return result;
  });

  register(COMPUTE_TOOL_NAMES[2], {
    title: 'Compute · follow a job',
    description: 'Read a GripForge Compute job (generation or variant): status (queued, running, succeeded, failed), current stage and stage counts. On success, result.assets lists the GLBs (scene, detail) with asset_id, edit_url (open it to edit in the studio) and file_url. Free.',
    inputSchema: { job_id: schema.string().min(1).max(200), workspace_id: workspace },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    const result = await call(`/api/v1/generation-jobs/${encodeURIComponent(String(args.job_id))}`, { workspace: args.workspace_id, signal: extra?.signal });
    const data = result.structuredContent as { workspace_id?: string; result?: { assets?: unknown } } | undefined;
    if (data?.result?.assets) data.result.assets = editLinks(data.result.assets, data.workspace_id ?? args.workspace_id);
    if (data) result.content = [{ type: 'text', text: JSON.stringify(data) }];
    return result;
  });

  register(COMPUTE_TOOL_NAMES[3], {
    title: 'Compute · list assets',
    description: 'List recent GripForge Compute assets of the workspace (manufactures and variants), newest first, each with asset_id, level (scene/detail), edit_url and file_url. With asset_id: that asset\'s family (original + colour/material versions) and its edit link. Free.',
    inputSchema: { asset_id: schema.string().max(160).optional(), limit: schema.number().int().min(1).max(100).optional(), workspace_id: workspace },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => typeof args.asset_id === 'string'
    ? call(`/api/v1/compute-assets/${encodeURIComponent(args.asset_id)}`, { workspace: args.workspace_id, signal: extra?.signal })
    : call(`/api/v1/compute-assets/mine?limit=${Number(args.limit ?? 20)}`, { workspace: args.workspace_id, signal: extra?.signal }));

  register(COMPUTE_TOOL_NAMES[4], {
    title: 'Compute · colour or material variant',
    description: 'New version of a Compute asset with the same shape: kind=couleur (value #RRGGBB, recolours the main material) or kind=matiere (value: a few words, e.g. "green velvet"; the texture is redone). stage=quote (free) returns quote.token; after the user accepts, stage=generate with quote_token and confirm=true launches one billed job. Poll gripforge_compute_job; new assets come back with edit_url. Painted-area edits and full retexture are not available yet.',
    inputSchema: {
      asset_id: schema.string().min(1).max(160).describe('Compute asset (scene or detail) from gripforge_compute_assets or a job result'),
      kind: schema.enum(['couleur', 'matiere']),
      value: schema.string().min(1).max(80).describe('couleur: #RRGGBB; matiere: short description'),
      stage: schema.enum(['quote', 'generate']),
      quote_token: schema.string().length(64).optional(),
      confirm: schema.boolean().optional(),
      idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
      workspace_id: workspace,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    if (args.stage === 'generate' && (args.confirm !== true || typeof args.quote_token !== 'string')) return fail('stage=generate needs quote_token and confirm=true after the user accepted the price.');
    const body = { action: args.stage, kind: args.kind, value: args.value, ...(args.stage === 'generate' ? { accepted_quote: args.quote_token, idempotency_key: typeof args.idempotency_key === 'string' ? args.idempotency_key : `compute-variant:mcp:${randomUUID()}` } : {}) };
    return call(`/api/v1/compute-assets/${encodeURIComponent(String(args.asset_id))}`, { method: 'POST', body, workspace: args.workspace_id, signal: extra?.signal });
  });

  register(COMPUTE_TOOL_NAMES[5], {
    title: 'Compute · download a GLB',
    description: options.local ? 'Download one Compute GLB from the private library to a local path (out_path, default ./<asset_id>.glb). Free.' : 'Signed-in download link of one Compute GLB (file_url, needs the API key header) and its edit page. Free.',
    inputSchema: { asset_id: schema.string().min(1).max(160), ...(options.local ? { out_path: schema.string().max(1000).optional() } : {}), workspace_id: workspace },
    annotations: { readOnlyHint: !options.local, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    const id = String(args.asset_id), ws = typeof args.workspace_id === 'string' ? `&workspace=${encodeURIComponent(args.workspace_id)}` : '';
    const links = { asset_id: id, file_url: `${base}/api/v1/library/${encodeURIComponent(id)}/file?download=1${ws}`, edit_url: `${base}/generate-3d/studio?asset=${encodeURIComponent(id)}${ws}` };
    if (!options.local || !options.writeFile) return ok(links);
    const key = options.getApiKey(); if (!key) return fail('GripForge API key required.');
    try {
      const response = await fetch(links.file_url, { headers: { 'x-api-key': key, 'x-gripforge-client': 'mcp', ...(typeof args.workspace_id === 'string' ? { 'x-workspace-id': args.workspace_id } : {}) }, signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(extra?.signal ? [extra.signal] : [])]) });
      if (!response.ok) return fail(`Download failed (HTTP ${response.status}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.toString('ascii', 0, 4) !== 'glTF') return fail('The library did not return a GLB.');
      const wrote = await options.writeFile(typeof args.out_path === 'string' ? args.out_path : `${id}.glb`, bytes);
      return ok({ ...links, wrote, bytes: bytes.length });
    } catch (error) { return fail(error instanceof Error ? error.message : 'Download failed.'); }
  });
}
