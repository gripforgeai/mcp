import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const MOTION_TOOL_NAMES = ['gripforge_motion_generate'] as const;

/**
 * Text-to-motion (NVIDIA Kimodo on GripForge's GPU), retargeted onto a Library character.
 * Hosted and local MCP share the same REST workflow: stage=plan (free), then stage=build.
 */
export function registerMotionTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const shape = {
    stage: schema.enum(['plan', 'build']).optional().describe('plan (default, free): the clips that would be made and their price. build: queue the GPU job.'),
    prompts: schema.array(schema.object({
      id: schema.string().regex(/^[a-z0-9_]{1,40}$/).describe('Clip name, snake_case (e.g. "slash_combo")'),
      text: schema.string().min(8).max(400).describe('The body movement in one or two sentences, e.g. "A warrior swings a heavy sword overhead, then spins and slashes horizontally."'),
      duration: schema.number().min(1).max(10).optional().describe('Seconds, default 3'),
    }).strict()).min(1).max(12).optional().describe('Free clips, 1 to 12. Give either prompts or hero_concept_id.'),
    hero_concept_id: schema.string().optional().describe('Kit mode: a hero concept with an ability kit (gripforge_game_concepts with hero_kits). Its basic attack and Q/W/E/R casts become one clip each, from the kit\'s "animation" lines.'),
    character_id: schema.string().optional().describe('Rigged Library character or enemy to retarget onto. Default: the UAL mannequin (any humanoid can reuse the clips later).'),
    name: schema.string().min(2).max(120).optional(),
    workspace_id: schema.string().max(100).optional(),
    idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
  };
  register(MOTION_TOOL_NAMES[0], {
    title: 'Generate motions from text',
    description: 'Custom animations generated from text with NVIDIA Kimodo on GripForge\'s GPU, retargeted onto a rigged Library character (or the UAL mannequin): spell casts, signature attacks, emotes, anything the standard clip pack (gripforge_animate) lacks. Kit mode turns a MOBA hero concept\'s basic attack and Q/W/E/R into clips in one call. Call stage=plan first (free) and show the prompts and price (1 credit per clip); stage=build queues a durable job — poll gripforge_generation_read with job_id (a cold GPU takes a few minutes). The result is a kind=animation Library item, one clip per prompt.',
    inputSchema: shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    const { workspace_id, ...body } = parsed.data as Record<string, unknown>;
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + '/api/v1/motions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      if (typeof data.status_url === 'string' && data.status_url.startsWith('/')) data.status_url = new URL(data.status_url, options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Motion request failed.' }] };
    }
  });
}
