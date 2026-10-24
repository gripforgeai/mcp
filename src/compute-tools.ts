import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

/**
 * GripForge Compute: image or text → textured 3D prop (two GLBs), then colour / material variants of the same shape.
 * Every call goes to GripForge (quote, then confirmed launch, one debit); GripForge talks to the Compute router.
 * Each asset comes back with its direct edit page (`edit_url`) that the client can open.
 */
export const COMPUTE_TOOL_NAMES = ['gripforge_compute_status', 'gripforge_compute_generate', 'gripforge_compute_job', 'gripforge_compute_assets', 'gripforge_compute_variant', 'gripforge_compute_download', 'gripforge_compute_validate'] as const;
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

  type Item = { name?: unknown; prompt?: unknown; image_base64?: unknown; image_path?: unknown; source?: unknown };
  async function imageOf(item: Item): Promise<string | Result> {
    if (typeof item.image_path === 'string' && options.readFile) {
      const bytes = await options.readFile(item.image_path).catch(() => null);
      if (!bytes) return fail(`Cannot read image_path ${item.image_path}.`);
      const mime = bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : 'image/webp';
      return `data:${mime};base64,${bytes.toString('base64')}`;
    }
    if (typeof item.image_base64 === 'string') return item.image_base64.startsWith('data:') ? item.image_base64 : `data:${item.image_base64.startsWith('/9j/') ? 'image/jpeg' : item.image_base64.startsWith('UklG') ? 'image/webp' : 'image/png'};base64,${item.image_base64}`;
    return fail('An image item needs image_base64' + (options.local ? ' or image_path.' : '.'));
  }
  const studioUrl = (job: string, ws: unknown) => `${base}/generate-3d/studio?job=${encodeURIComponent(job)}${typeof ws === 'string' ? `&workspace=${encodeURIComponent(ws)}` : ''}`;
  const itemShape = schema.object({
    name: schema.string().min(1).max(100), prompt: schema.string().min(3).max(500).optional(), image_base64: schema.string().max(12_000_000).optional(),
    ...(options.local ? { image_path: schema.string().max(1000).optional() } : {}),
  });

  register(COMPUTE_TOOL_NAMES[1], {
    title: 'Compute · generate 3D assets',
    description: 'ON DEMAND ONLY: use when the user asks for GripForge Compute; the default 3D generator stays gripforge_generate_prop without provider. Make textured 3D prop/furniture assets with GripForge Compute from images or text descriptions: one asset (name + prompt or image) or several at once (items, up to 5; each item is one asset, from its prompt or its image). Two steps: stage=quote (free) returns each quote.token and the total price; show it to the user, then stage=generate with the tokens (quote_token, or quote_tokens in item order) and confirm=true launches one durable job per asset, each debited once after success with its own idempotency key. Text assets stop after four reference images (billed on their own): show them to the user, then gripforge_compute_validate with the chosen image (the 3D is quoted then, and billed when finished), or regenerate; auto_pick=true (only if the user asked) takes the first image and bills images + 3D once. Weapons, vehicles and characters are refused before any charge (use the default generator). Returns one job per asset with studio_url; poll gripforge_compute_job (several job_ids at once) for the GLBs and their edit_url.',
    inputSchema: {
      stage: schema.enum(['quote', 'generate']).describe('quote first (free), then generate'),
      source: schema.enum(['image', 'text']).optional().describe('Single asset: default image. Items: inferred from each item (prompt → text, image → image)'),
      name: schema.string().min(1).max(100).optional().describe('Single asset name'),
      prompt: schema.string().min(3).max(500).optional().describe('source=text: one object, e.g. "a studded wooden pirate chest"'),
      image_base64: schema.string().max(12_000_000).optional().describe('source=image: PNG/JPEG/WebP, raw base64 or data URI, up to 8 MB'),
      ...(options.local ? { image_path: schema.string().max(1000).optional().describe('source=image: local PNG/JPEG/WebP file (instead of image_base64)') } : {}),
      items: schema.array(itemShape).min(1).max(5).optional().describe('Several assets at once: [{name, prompt} or {name, image_base64' + (options.local ? '|image_path' : '') + '}]'),
      object_type: schema.enum(BUDGETS).optional().describe('Triangle budget class. Default mobilier_simple'),
      quality: schema.enum(['standard', 'detail']).optional().describe('Texture quality. Default standard'),
      triangles: schema.number().int().min(500).max(200000).optional().describe('Image assets only: exact triangle count of the « near » GLB (the « scene » one gets half). Default: from object_type. For a finished asset (also from text), use gripforge_compute_variant kind=budget'),
      options: schema.array(schema.enum(['photo', 'matieres', 'relief'])).max(3).optional().describe('Image assets: photo (keep visible details), matieres (refine materials), relief (surface detail). Default all three'),
      auto_pick: schema.boolean().optional().describe('Text assets: true = take the first image without asking (only when the user explicitly wants it). Default: stop and wait for gripforge_compute_validate'),
      quote_token: schema.string().length(64).optional().describe('stage=generate, single asset: quote.token from the quote with the SAME inputs'),
      quote_tokens: schema.array(schema.string().length(64)).max(5).optional().describe('stage=generate with items: the quote tokens in item order'),
      confirm: schema.boolean().optional().describe('stage=generate: true once the user accepted the quoted price'),
      idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional().describe('Single asset: stable key for retries of the same launch; generated if absent (items: one per item, derived from it)'),
      workspace_id: workspace,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const list = Array.isArray(args.items) ? args.items as Item[] : [{ name: args.name, prompt: args.prompt, image_base64: args.image_base64, image_path: args.image_path, source: args.source }];
    if (!Array.isArray(args.items) && typeof args.name !== 'string') return fail('Give name (single asset) or items.');
    const tokens = Array.isArray(args.items) ? (Array.isArray(args.quote_tokens) ? args.quote_tokens as string[] : []) : typeof args.quote_token === 'string' ? [args.quote_token] : [];
    if (args.stage === 'generate' && (args.confirm !== true || tokens.length !== list.length)) return fail('stage=generate needs one quote token per asset (quote_token, or quote_tokens in item order) from a quote with the same inputs, and confirm=true after the user accepted the price.');
    const batchKey = typeof args.idempotency_key === 'string' ? args.idempotency_key : `compute:mcp:${randomUUID()}`;
    const out: Record<string, unknown>[] = [];
    for (const [index, item] of list.entries()) {
      const text = item.source === 'text' || (item.source === undefined && typeof item.prompt === 'string' && item.image_base64 === undefined && item.image_path === undefined);
      let image: string | undefined;
      if (!text) { const r = await imageOf(item); if (typeof r !== 'string') return r; image = r; }
      else if (typeof item.prompt !== 'string') return fail(`${String(item.name)}: a text asset needs prompt.`);
      const body = {
        action: args.stage, source: text ? 'text' : 'image', name: item.name, budget: args.object_type ?? 'mobilier_simple', quality: args.quality ?? 'standard',
        options: text ? [] : args.options ?? ['photo', 'matieres', 'relief'], ...(text ? { prompt: item.prompt, ...(args.auto_pick === true ? { auto_pick: true } : {}) } : { image, ...(typeof args.triangles === 'number' ? { triangles: args.triangles } : {}) }),
        ...(args.stage === 'generate' ? { accepted_quote: tokens[index], idempotency_key: list.length > 1 ? `${batchKey.slice(0, 150)}:${index}` : batchKey } : {}),
      };
      const result = await call('/api/v1/compute-assets', { method: 'POST', body, workspace: args.workspace_id, signal: extra?.signal });
      const data = (result.structuredContent ?? {}) as { quote?: { token?: string; estimated_credits?: number; estimated_maximum_usd?: number }; job?: { id?: string; status?: string }; error?: string };
      if (result.isError) out.push({ name: item.name, error: data.error ?? result.content[0]?.text });
      else if (args.stage === 'quote') out.push({ name: item.name, quote: data.quote });
      else out.push({ name: item.name, job_id: data.job?.id, status: data.job?.status, quote: data.quote, status_url: `${base}/api/v1/generation-jobs/${data.job?.id}`, studio_url: data.job?.id ? studioUrl(data.job.id, args.workspace_id) : undefined });
    }
    const failed = out.filter(o => o.error).length;
    const quotes = out.map(o => o.quote as { estimated_credits?: number; estimated_maximum_usd?: number } | undefined).filter(Boolean) as { estimated_credits?: number; estimated_maximum_usd?: number }[];
    const data: Record<string, unknown> = Array.isArray(args.items) ? { items: out } : { ...out[0] };
    if (args.stage === 'quote') {
      data.total = { credits: quotes.reduce((s, q) => s + (q.estimated_credits ?? 0), 0), usd: quotes.reduce((s, q) => s + (q.estimated_maximum_usd ?? 0), 0) };
      data.next = 'Show the prices to the user. If accepted, call again with stage=generate, the same inputs, the tokens (quote_token or quote_tokens in order) and confirm=true.';
    } else data.next = 'Poll gripforge_compute_job with job_ids until each status is succeeded; open studio_url to follow them in the 3D studio.';
    return ok(data, failed === out.length);
  });

  register(COMPUTE_TOOL_NAMES[2], {
    title: 'Compute · follow jobs',
    description: 'Read GripForge Compute jobs (generations or variants): job_id, or job_ids for several at once. Status (queued, running, succeeded, failed), current stage and stage counts. While the router waits, `attente` = {raison: demarrage_machine | aucune_machine | file | machine_occupee, position, depuis, estimation_s} (a machine start takes about 10 min the first time). On success, result.assets lists the GLBs (scene, detail) with asset_id, triangles, edit_url (open it to edit in the studio) and file_url. Free.',
    inputSchema: { job_id: schema.string().min(1).max(200).optional(), job_ids: schema.array(schema.string().min(1).max(200)).min(1).max(20).optional(), workspace_id: workspace },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (args, extra) => {
    const ids = Array.isArray(args.job_ids) ? args.job_ids as string[] : typeof args.job_id === 'string' ? [args.job_id] : [];
    if (!ids.length) return fail('Give job_id or job_ids.');
    const jobs: Record<string, unknown>[] = [];
    for (const id of ids) {
      const result = await call(`/api/v1/generation-jobs/${encodeURIComponent(id)}`, { workspace: args.workspace_id, signal: extra?.signal });
      const data = (result.structuredContent ?? { error: result.content[0]?.text }) as { workspace_id?: string; result?: { assets?: unknown } };
      if (data?.result?.assets) data.result.assets = editLinks(data.result.assets, data.workspace_id ?? args.workspace_id);
      jobs.push(result.isError ? { id, error: (data as { error?: string }).error ?? 'failed' } : { ...data, studio_url: studioUrl(id, data.workspace_id ?? args.workspace_id) });
    }
    return Array.isArray(args.job_ids) ? ok({ jobs }, jobs.every(j => j.error)) : ok(jobs[0], Boolean(jobs[0].error));
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
    title: 'Compute · colour, material or polygon variant',
    description: 'New version of a Compute asset, on demand: kind=couleur (value #RRGGBB, recolours the main material), kind=matiere (value: a few words, e.g. "green velvet"; the texture is redone) kind=retexture (value: a style for the whole asset, same mesh and UVs, e.g. "painted blue wood, worn") or kind=budget (change the polygon count: value bas | moyen | haut relative to the current one, or an exact « near » triangle count 500–200000; the « scene » GLB gets half; refused as coming soon until the router supports it). stage=quote (free) returns quote.token; after the user accepts, stage=generate with quote_token and confirm=true launches one billed job. Poll gripforge_compute_job; new assets come back with edit_url. Painted-area edits need the studio brush: give the user the edit_url.',
    inputSchema: {
      asset_id: schema.string().min(1).max(160).describe('Compute asset (scene or detail) from gripforge_compute_assets or a job result'),
      kind: schema.enum(['couleur', 'matiere', 'budget', 'retexture']),
      value: schema.string().min(1).max(300).describe('couleur: #RRGGBB; matiere: short description; budget: bas | moyen | haut or a triangle count; retexture: style for the whole asset'),
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

  register(COMPUTE_TOOL_NAMES[6], {
    title: 'Compute · validate or regenerate text images',
    description: 'A text generation of GripForge Compute stops after its four reference images (gripforge_compute_job shows validation.etat en_attente and images[{stage, url}]). Show them to the user, then: image=1..4 to turn that image into 3D (stage=quote returns the 3D price; stage=generate with quote_token and confirm=true launches the 3D job, billed when finished), or regenerate=true (optionally with a new prompt) for four new images, billed again on their own, or abandon=true (only the images were billed).',
    inputSchema: {
      job_id: schema.string().min(1).max(200).describe('The text generation job waiting for validation'),
      image: schema.number().int().min(1).max(4).optional(), regenerate: schema.boolean().optional(), prompt: schema.string().min(3).max(500).optional().describe('regenerate: new text (default: the same)'),
      abandon: schema.boolean().optional(),
      stage: schema.enum(['quote', 'generate']).optional().describe('image / regenerate: quote first, then generate'),
      quote_token: schema.string().length(64).optional(), confirm: schema.boolean().optional(),
      idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(), workspace_id: workspace,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const id = encodeURIComponent(String(args.job_id));
    if (args.abandon === true) return call(`/api/v1/compute-assets/jobs/${id}/dismiss`, { method: 'POST', body: {}, workspace: args.workspace_id, signal: extra?.signal });
    const what = typeof args.image === 'number' ? 'validate' : args.regenerate === true ? 'regenerate' : null;
    if (!what) return fail('Give image (1–4), regenerate=true or abandon=true.');
    const stage = args.stage === 'generate' ? 'generate' : 'quote';
    if (stage === 'generate' && (args.confirm !== true || typeof args.quote_token !== 'string')) return fail('stage=generate needs quote_token and confirm=true after the user accepted the price.');
    const body = { action: stage, ...(what === 'validate' ? { stage: `image_${args.image}` } : typeof args.prompt === 'string' ? { prompt: args.prompt } : {}),
      ...(stage === 'generate' ? { accepted_quote: args.quote_token, idempotency_key: typeof args.idempotency_key === 'string' ? args.idempotency_key : `compute:${what}:mcp:${randomUUID()}` } : {}) };
    const result = await call(`/api/v1/compute-assets/jobs/${id}/${what}`, { method: 'POST', body, workspace: args.workspace_id, signal: extra?.signal });
    const data = result.structuredContent as { job?: { id?: string } } | undefined;
    if (data?.job?.id) { (data as Record<string, unknown>).studio_url = studioUrl(data.job.id, args.workspace_id); result.content = [{ type: 'text', text: JSON.stringify(data) }]; }
    return result;
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
