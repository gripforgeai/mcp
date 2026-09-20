/** Same authoring tools in the hosted MCP and the npm stdio client. */
// mcp-handler requires v4 field schemas for raw shapes. zod 3.25 ships v4
// alongside v3, so existing stdio tools can retain their current v3 schemas.
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type VfxProjectRegister = (name: string, config: { title: string; description: string; inputSchema: z.ZodRawShape; annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }, callback: (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => Promise<CallToolResult>) => void;

// The hosted SDK uses a newer Zod v4 serializer than the npm SDK. Inject its
// matching factory so schemas remain compatible with each host's serializer.
export function registerVfxProjectTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | undefined | null }, schema: typeof z = z) {
  const workspace = { workspace_id: schema.string().max(100).optional().describe('Explicit workspace id. The key must have access to this workspace; never infer another user’s workspace.') };
  const id = schema.string().regex(/^lib_[A-Za-z0-9_-]+$/);
  const project = schema.record(schema.string(), schema.unknown()).describe('Complete editable project JSON. Read gripforge_vfx_project_schema for the format and a working example.');
  const times = schema.array(schema.number().min(0).max(12)).min(1).max(4).optional().describe('Render timestamps in seconds. Defaults to anticipation, middle and decay samples.');
  async function api(path: string, args: Record<string, unknown>, method: string, signal?: AbortSignal): Promise<CallToolResult> {
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    const { workspace_id, ...body } = args;
    try {
      const res = await fetch(`${options.apiUrl}/api/v1/vfx/projects${path}`, {
        method, headers: { 'x-api-key': key, 'x-gripforge-client': 'mcp', 'content-type': 'application/json', ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(285_000)]),
      });
      const raw = await res.json() as Record<string, unknown>;
      if (!res.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: res.status, ...raw }) }] };
      const { preview_image, ...data } = raw;
      if (typeof data.studio_url === 'string') data.studio_url = new URL(data.studio_url, options.apiUrl).href;
      const content: CallToolResult['content'] = [{ type: 'text', text: JSON.stringify(data) }];
      const image = preview_image as { mimeType?: unknown; data?: unknown } | undefined;
      if (image?.mimeType === 'image/png' && typeof image.data === 'string') content.push({ type: 'image', mimeType: 'image/png', data: image.data });
      return { content, structuredContent: data };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'VFX API failed' }] }; }
  }
  function tool(name: string, title: string, description: string, inputSchema: z.ZodRawShape, readOnly: boolean, callback: Parameters<VfxProjectRegister>[2], external = false) {
    register(name, { title, description: `ADMIN ONLY. ${description}`, inputSchema: { ...inputSchema, ...workspace }, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly && !external, openWorldHint: external } }, callback);
  }
  tool('gripforge_vfx_project_schema', 'VFX authoring language and example',
    'Start here to create original VFX beyond presets. Returns the editable source format, shader helpers, geometry budgets and a working example. Workflow: write custom source -> render -> inspect the returned image -> revise -> save. Blender or another modeling tool may supply custom mesh vertices/UVs/indices; no Blender instance is required for procedural effects.', {}, true,
    (args, extra) => api('', args, 'GET', extra?.signal));
  tool('gripforge_vfx_project_read', 'Read VFX project files and revisions',
    'Read a project in the authenticated workspace. Returns project.json, per-layer .vert/.frag source, current revision, recent revision history and a Studio link. Read an older revision to restore it through write with the CURRENT expected_revision. Does not grant access to the server repository or arbitrary user files.',
    { id, revision: schema.number().int().positive().optional() }, true,
    (args, extra) => api(`/${encodeURIComponent(String(args.id))}${args.revision ? `?revision=${args.revision}` : ''}`, args, 'GET', extra?.signal));
  tool('gripforge_vfx_project_write', 'Create or edit a VFX project',
    'Create with project, or update id with project OR edits:[{path,content}]. Updates require expected_revision. Returns HTTP 202 job_id and studio_url immediately. Poll gripforge_generation_read; the worker compiles, renders and saves a work revision, then reviews it visually. Completed result includes source_url, preview_url and review. Use generation_read with include_preview to see the actual image. A source conflict fails the job and preserves current work; reread before writing. Validated versions remain unchanged. Editable files are project.json and layers/{id}.vert/.frag.',
    { idempotency_key: schema.string().min(8).max(160).optional(), id: id.optional(), expected_revision: schema.number().int().positive().optional(), project: project.optional(), edits: schema.array(schema.object({ path: schema.string().max(100), content: schema.string().max(400_000) })).min(1).max(24).optional(), times, note: schema.string().max(1000).optional() }, false,
    (args, extra) => api(args.id ? `/${encodeURIComponent(String(args.id))}` : '', args, args.id ? 'PATCH' : 'POST', extra?.signal));
  tool('gripforge_vfx_project_render', 'Render actual VFX frames for inspection',
    'Queue a durable render of an owned id OR an unsaved project at 1–4 timestamps. Returns job_id immediately. Poll gripforge_generation_read with include_preview for the actual rendered image, coverage, clipping and shader diagnostics. Uses the shared GripForge SceneViewport. Saves preview evidence only, no project revision. Requires workspace write access because the job and preview consume storage. Render timings are not browser FPS.',
    { idempotency_key: schema.string().min(8).max(160).optional(), id: id.optional(), project: project.optional(), times }, false,
    (args, extra) => api('/render', args, 'POST', extra?.signal));
  tool('gripforge_vfx_project_review', 'Review an existing work revision',
    'Queue a fresh GripForge capture and independent visual review without writing another source revision. Poll gripforge_generation_read; inspect its preview, then explicitly promote if approved.',
    { id, expected_revision: schema.number().int().positive(), idempotency_key: schema.string().min(8).max(160).optional() }, false,
    (args, extra) => api(`/${args.id}/review`, args, 'POST', extra?.signal));
  tool('gripforge_vfx_project_promote', 'Set the visually approved VFX version',
    'Explicitly promote work after a trusted positive review matching this source, dependencies and renderer. expectedCurrent is the existing validated revision, or null.',
    { id, revision: schema.number().int().positive(), expectedCurrent: schema.number().int().positive().nullable() }, false,
    (args, extra) => api(`/${args.id}/promote`, args, 'POST', extra?.signal));
  tool('gripforge_vfx_project_generate', 'Create, render and refine a custom VFX',
    'Text/image -> durable generation job -> original geometry/shaders -> actual GripForge rendering -> visual critique/correction -> workspace work revision. Returns immediately with job_id, status_url and studio_url. Poll gripforge_generation_read, then open its source_url to inspect the saved source and review. Closing the request does not cancel the job. Completed steps survive worker restart. Pass id + expected_revision to refine; image_id must belong to this workspace. A visually rejected candidate never replaces the validated version.',
    { idempotency_key: schema.string().min(8).max(160).optional(), prompt: schema.string().max(2000).optional(), visual_style: schema.enum(['realistic', 'stylized', 'anime', 'lowpoly']).optional(), image_mode: schema.enum(['spatial', 'animated-artwork']).optional().describe('Default spatial: build a 3D effect. animated-artwork explicitly opts into a flat animated illustration.'), image_id: id.optional(), image_data: schema.string().max(12 * 1024 * 1024).optional(), id: id.optional(), expected_revision: schema.number().int().positive().optional() }, false,
    (args, extra) => api('/generate', args, 'POST', extra?.signal), true);
}
