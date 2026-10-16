import { z } from 'zod/v4';

/** Shared local/hosted MCP and REST contract. Only data, never executable Blender scripts. */
export function creatureGenerationShape(s: typeof z = z) {
  const ref = s.object({ assetId: s.string().regex(/^lib_[A-Za-z0-9_-]{8,64}$/), revisionId: s.string().min(1).max(100), fileRole: s.string().max(100).optional() }).strict();
  const recipe = s.object({
    id: s.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), name: s.string().trim().min(1).max(100),
    prompt: s.string().trim().min(10).max(4000),
    family: s.enum(['arthropod', 'quadruped', 'biped', 'winged', 'serpentine', 'other']),
    role: s.enum(['fauna', 'enemy', 'companion', 'mount', 'boss']).default('fauna'),
    style: s.string().trim().min(1).max(300).default('stylized science-fiction adventure'),
    locomotion: s.enum(['ground', 'air', 'water']).default('ground'),
    size_m: s.number().min(0.05).max(100).default(1),
    polycount: s.number().int().min(500).max(20000).default(8000),
    required_clips: s.array(s.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).min(1).max(24).default(['idle', 'walk', 'run']),
    source: ref.optional(), concept: ref.optional(),
  }).strict().refine(r => !(r.source && r.concept), 'Choose source OR concept.');
  return {
    stage: s.enum(['plan', 'build', 'rig']).default('plan'),
    recipes: s.array(recipe).min(1).max(8).optional().describe('One to eight distinct creatures; each variant needs its own id and prompt. Required for plan/build.'),
    concept_provider: s.enum(['openai', 'xai']).default('openai'),
    budget: s.object({ usd: s.number().min(0).max(10000).optional(), credits: s.number().int().min(0).max(100000).optional() }).strict().optional(),
    idempotency_key: s.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
    generation_job: s.string().regex(/^gen_[A-Za-z0-9_-]{8,64}$/).optional(),
    creature_id: s.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).optional(),
    profile: s.record(s.string(), s.unknown()).optional(),
    reviewed_anatomy: s.boolean().optional(), allow_rerig: s.boolean().optional(),
  };
}
export const creatureGenerationSchema = z.object(creatureGenerationShape()).strict().superRefine((r, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (r.stage === 'rig') {
    if (!r.generation_job || !r.creature_id || r.reviewed_anatomy !== true) issue('rig requires generation_job, creature_id and reviewed_anatomy=true after inspecting the skeleton overlay.');
    if (r.recipes || r.budget) issue('rig uses the pinned creature from the completed generation job, without recipes or a paid budget.');
  } else {
    if (!r.recipes) issue('plan/build requires recipes.');
    if (r.generation_job || r.creature_id || r.profile || r.reviewed_anatomy !== undefined || r.allow_rerig !== undefined) issue('Rig fields are only valid for stage=rig.');
    if (r.recipes && new Set(r.recipes.map(c => c.id)).size !== r.recipes.length) issue('Creature ids must be unique within a batch.');
  }
  if (r.stage !== 'plan' && !r.idempotency_key) issue('A stable idempotency_key is required for build/rig.');
});
export type CreatureGenerationRequest = z.infer<typeof creatureGenerationSchema>;
export type CreatureRecipe = NonNullable<CreatureGenerationRequest['recipes']>[number];
