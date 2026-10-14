import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const FACIAL_RIG_TOOL_NAMES = ['gripforge_facial_rig'] as const;
/** Shared by the hosted API and both MCP transports. Landmarks never contain code or file paths. */
export function facialRigShape(schema: typeof z = z) {
  const point = schema.tuple([schema.number().finite().min(-100000).max(100000), schema.number().finite().min(-100000).max(100000), schema.number().finite().min(-100000).max(100000)]);
  return {
    action: schema.enum(['schema', 'inspect', 'build']).default('inspect'),
    source_id: schema.string().regex(/^lib_[A-Za-z0-9_-]{8,64}$/).optional(),
    node: schema.number().int().min(0).max(4095).optional().describe('Mesh node index from inspect. Selects one existing rig when independent faces use different conventions.'),
    prepare_mouth: schema.boolean().optional().describe('Opt in to cutting a guided opening and adding an inner mouth on the output copy when the mouth is sealed. Requires profile and one primitive without existing morphs. Changes facial topology and needs close visual review.'),
    profile: schema.object({ node: schema.number().int().min(0).max(4095), left: point, right: point, upper: point, lower: point, chin: point, depth: schema.number().positive().max(10000).optional() }).strict().optional().describe('For a model without mouth controls: front-view left/right mouth corners, distinct upper/lower INNER lip points and chin, all in the selected node LOCAL rest space before skinning/transforms. A sealed surface also requires prepare_mouth. Inspect first; do not guess from whole-body bounds. depth optionally limits the region behind the lips.'),
    name: schema.string().trim().min(1).max(100).optional(),
    idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
  };
}
export function registerFacialRigTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const shape = { ...facialRigShape(schema), workspace_id: schema.string().max(100).optional() };
  register(FACIAL_RIG_TOOL_NAMES[0], {
    title: 'Facial rig · inspect and prepare dialogue',
    description: 'Inspect or create mouth controls on an OWNED GLB while preserving its body skeleton and animations. action=schema returns the contract. inspect returns a persistent job with mesh node indices, local bounds, existing facial controls and compatible dialogue.voice mappings. build automatically reuses recognized Oculus/ARKit/Rhubarb controls, or creates eight draft mouth morphs from explicit mouth landmarks (profile). A sealed mouth requires explicit prepare_mouth=true to cut a guided opening on the output copy and add an interior; it interpolates UVs and skin weights, changes face topology and requires visual review. It never guesses landmarks from the body bounds. Poll gripforge_generation_read for the new private GLB, report, voice_rig JSON and Character Studio link. No automatic source replacement or project binding. No TTS/GPU rental; CPU geometry processing, not full facial expression authoring.',
    inputSchema: shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const { workspace_id, action, ...body } = parsed.data;
    if (action !== 'schema' && !body.source_id) return { isError: true, content: [{ type: 'text', text: 'source_id is required for inspect/build.' }] };
    const key = options.getApiKey();
    if (action !== 'schema' && !key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + '/api/v1/facial-rigs', {
        method: action === 'schema' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', ...(key ? { 'x-api-key': key } : {}), ...(workspace_id ? { 'x-workspace-id': workspace_id } : {}) },
        ...(action === 'schema' ? {} : { body: JSON.stringify({ action, ...body }) }),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      for (const field of ['status_url', 'studio_url']) if (typeof data[field] === 'string' && data[field].startsWith('/')) data[field] = new URL(data[field], options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Facial rig request failed.' }] }; }
  });
}
