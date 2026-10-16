import { z } from 'zod/v4';
import { creatureGenerationShape, creatureGenerationSchema } from './creature-generation-contract.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const CREATURE_GENERATION_TOOL_NAMES = ['gripforge_generate_creature'] as const;
export function registerCreatureGenerationTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  register(CREATURE_GENERATION_TOOL_NAMES[0], {
    title: 'Creatures · plan, generate and rig',
    description: 'Generic animal/alien creature factory, one to eight original creatures per batch. stage=plan quotes concept + Meshy 3D + anatomy vision without paid calls. stage=build requires explicit budget and stable idempotency_key, then generates private meshes and inspectable skeleton overlays. Poll gripforge_generation_read; inspect each preview/profile before stage=rig with generation_job, creature_id, reviewed_anatomy=true and optional corrected profile. Reuses the anatomy-aware Blender rig, never humanoid autorig. Exports GLB, Blender source and diagnostics. Procedural starting clips are drafts; missing fly/swim/action clips are reported. No automatic game-ready approval. Existing owned immutable source/concept revisions can be reused. Use generation_cancel/retry for durable work.',
    inputSchema: { ...creatureGenerationShape(schema), workspace_id: schema.string().max(100).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const { workspace_id, ...body } = args;
    const parsed = creatureGenerationSchema.safeParse(body);
    if (!parsed.success || (workspace_id !== undefined && (typeof workspace_id !== 'string' || workspace_id.length > 100))) return { isError: true, content: [{ type: 'text', text: parsed.success ? 'Invalid workspace_id.' : parsed.error.message }] };
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + '/api/v1/creatures', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}) },
        body: JSON.stringify(parsed.data), signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      for (const field of ['status_url', 'studio_url']) if (typeof data[field] === 'string' && data[field].startsWith('/')) data[field] = new URL(data[field], options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Creature generation request failed.' }] }; }
  });
}
