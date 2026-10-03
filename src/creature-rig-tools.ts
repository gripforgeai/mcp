import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const CREATURE_RIG_TOOL_NAMES = ['gripforge_creature_rig_schema', 'gripforge_creature_analyze', 'gripforge_creature_rig'] as const;
/** Same contract for hosted MCP and the local client; Blender runs in the durable worker. */
export function registerCreatureRigTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const shared = { workspace_id: schema.string().max(100).optional(), name: schema.string().min(1).max(100).optional(), idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional() };
  const analyze = { ...shared, source_id: schema.string().regex(/^lib_[A-Za-z0-9_-]{8,64}$/), kind: schema.enum(['enemy', 'character']).optional() };
  const rig = { ...shared, analysis_job: schema.string().regex(/^gen_[A-Za-z0-9_-]{8,64}$/), profile: schema.record(schema.string(), schema.unknown()).optional().describe('Optional corrected anatomy in the exact coordinate system returned by analyze. Read the schema and inspect the multiview preview first.'), reviewed_anatomy: schema.boolean().optional().describe('Required: true only after inspecting/correcting the anatomy and its skeleton overlay.'), allow_rerig: schema.boolean().optional().describe('Explicitly create a NEW rigged copy if the source already contains bones. The source is never overwritten.') };
  async function call(action: 'schema' | 'analyze' | 'rig', args: Record<string, unknown>, signal?: AbortSignal) {
    const key = options.getApiKey();
    if (!key && action !== 'schema') return { isError: true, content: [{ type: 'text' as const, text: 'GripForge API key required.' }] };
    const { workspace_id, ...body } = args;
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + '/api/v1/creature-rigs', {
        method: action === 'schema' ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', ...(key ? { 'x-api-key': key } : {}), ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}) },
        ...(action === 'schema' ? {} : { body: JSON.stringify({ action, ...body }) }), signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]),
      });
      const data = await response.json();
      for (const field of ['studio_url', 'status_url']) if (typeof data[field] === 'string' && data[field].startsWith('/')) data[field] = new URL(data[field], options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Creature rig request failed.' }] }; }
  }
  const tools = [
    { name: CREATURE_RIG_TOOL_NAMES[0], action: 'schema' as const, title: 'Creature rig · schema', shape: {}, description: 'Read the reusable creature anatomy/rig workflow, coordinate contract, limits and export formats. Detect anatomy before authoring; source GLB, asset instances and draft rig stay separate. Blender is the worker, GripForge is the review renderer.' },
    { name: CREATURE_RIG_TOOL_NAMES[1], action: 'analyze' as const, title: 'Creature rig · detect anatomy', shape: analyze, description: 'Queue multiview mesh inspection and vision anatomy detection for an OWNED GLB. Detect actual body, legs, arms, claws, wings or tail without imposing a humanoid/eight-leg template. Returns a persistent job_id. Poll gripforge_generation_read with include_preview=true for the annotated views, editable profile and uncertainty flags. No rig mutation. 0 GripForge credits; configured server vision/Blender required.' },
    { name: CREATURE_RIG_TOOL_NAMES[2], action: 'rig' as const, title: 'Creature rig · manufacture', shape: rig, description: 'Create a NEW private draft character/enemy from a completed creature analysis and optional corrected anatomy. Blender builds the skeleton, surface-smoothed skin weights and procedural starting/diagnostic clips. Grounded leg chains get in-place walk/run with IK. Returns job_id; poll gripforge_generation_read for the Character Studio link, skinned GLB, editable .blend, anatomy and deformation report. Never automatically replaces or validates the source. Every anatomy proposal requires explicit review; use generation_cancel/retry to control durable work. Finger/facial authoring and finished combat choreography are outside v1. 0 GripForge credits.' },
  ];
  for (const tool of tools) register(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.shape,
    annotations: { readOnlyHint: tool.action === 'schema', destructiveHint: false, idempotentHint: tool.action === 'schema', openWorldHint: false } }, async (args, extra) => {
    const parsed = schema.object(tool.shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    return call(tool.action, parsed.data, extra?.signal);
  });
}
