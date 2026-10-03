import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const HERO_ABILITY_TOOL_NAMES = ['gripforge_abilities_generate'] as const;

/**
 * A hero's abilities ready in Character Studio: kit (role, basic attack, passive, Q/W/E/R), the
 * Kimodo clip of each cast on the character, and the gripforge.abilities/1 pack bound to them.
 * Hosted and local MCP share the same REST workflow: stage=plan (free), then stage=build.
 */
export function registerHeroAbilityTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const shape = {
    stage: schema.enum(['plan', 'build']).optional().describe('plan (default, free): the kit, its abilities and clips, and the price. build: queue the GPU job.'),
    prompt: schema.string().min(8).max(600).optional().describe('The hero in one sentence when there is no concept, e.g. "a frost archer who slows enemies, ultimate freezes an area". Its kit is written at plan.'),
    hero_concept_id: schema.string().optional().describe('A hero concept with an ability kit (gripforge_game_concepts with hero_kits).'),
    kit: schema.record(schema.string(), schema.unknown()).optional().describe('The kit returned by plan: pass it to build to keep exactly what was shown.'),
    name: schema.string().min(2).max(80).optional(),
    character_id: schema.string().optional().describe('Rigged Library character or enemy the clips and abilities go on. Default: the UAL mannequin.'),
    workspace_id: schema.string().max(100).optional(),
    idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
  };
  register(HERO_ABILITY_TOOL_NAMES[0], {
    title: 'Generate hero abilities',
    description: 'A hero\'s abilities ready to play in Character Studio: the kit (role, lane, basic attack, passive + Q/W/E/R with type, range, cooldown, cost, effect, VFX brief, cast animation) from a hero concept or written from one sentence; the basic attack and Q/W/E/R casts animated with NVIDIA Kimodo on the rigged character; and the gripforge.abilities/1 pack (targeting, damage/heal, timings) bound to those clips and stored on the result. Call stage=plan first (free) and show the abilities and price (1 credit per clip, 5 for a kit); then stage=build with the returned kit. Poll gripforge_generation_read with job_id; result.studio_url opens the Abilities tab. Numbers are starting values, not a balance pass; VFX lines are briefs for gripforge_vfx_generate.',
    inputSchema: shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    const { workspace_id, ...body } = parsed.data as Record<string, unknown>;
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + '/api/v1/abilities/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      if (typeof data.status_url === 'string' && data.status_url.startsWith('/')) data.status_url = new URL(data.status_url, options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Ability request failed.' }] };
    }
  });
}
