import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const GAME_CONCEPT_TOOL_NAMES = ['gripforge_game_concepts'] as const;

const SLOTS = ['heroes', 'bosses', 'enemies', 'npcs', 'weapons', 'vehicles', 'buildings', 'props', 'textures', 'vfx', 'maps'] as const;

/**
 * Concepts of a whole game, reused before generated. Hosted and local MCP share the same REST
 * workflow: GET the catalog, POST stage=plan (free), then stage=build with an explicit budget.
 */
export function registerGameConceptTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const counts = schema.object(Object.fromEntries(SLOTS.map((s) => [s, schema.number().int().min(0).max(96).optional()]))).strict();
  const wishes = schema.object(Object.fromEntries(SLOTS.map((s) => [s, schema.array(schema.string().trim().min(1).max(200)).max(24).optional()]))).strict();
  const shape = {
    stage: schema.enum(['catalog', 'plan', 'build']).optional().describe('catalog: known games, blueprints (slot counts) and theme packs. plan (default, free): what already exists and is reused, what would be generated, and the price. build: generate the missing concepts, requires budget.'),
    game: schema.string().min(2).max(120).optional().describe('The game the user named, as written ("God of War", "like Dark Souls", "a GTA"). Matched against titles and aliases of the catalog.'),
    custom: schema.object({
      title: schema.string().min(2).max(80),
      blueprint: schema.string().max(60).describe('Closest blueprint from stage=catalog, e.g. third-person-action, open-world-rpg.'),
      pack: schema.string().max(60).describe('Closest theme pack from stage=catalog, e.g. nordic-mythology, cyberpunk.'),
      build: schema.string().min(10).max(300).describe('One sentence describing the original game to make.'),
    }).strict().optional().describe('Only when `game` is not in the catalog: describe the game with the closest blueprint and pack.'),
    counts: counts.optional().describe('Concepts to generate per slot (heroes up to 24, maps up to 6: the first is the whole playfield from above, the others are zones seen through the game camera). Default: what the blueprint needs minus what is already reusable.'),
    wishes: wishes.optional().describe('What the user asked for, per slot, one short description per item (max 24 per slot, 200 chars each), e.g. {"heroes": ["old bald karate master in a worn gi", "masked luchador"], "weapons": ["pump shotgun", "hunting rifle"]}. Binding: the pack produces exactly these items, in this order (named and detailed, never replaced). The slot count defaults to the number of wishes; a larger count adds freely invented items. Always pass the characters, weapons or objects the user described here, not only in custom.build.'),
    hero_kits: schema.boolean().optional().describe('Each hero comes with its ability kit — role, lane, basic attack, passive + Q/W/E/R (type, range, cooldown, cost, effect, VFX, cast animation) — and a sheet of 5 ability icons in its colours (1 more image per hero). Default from the blueprint: on for lane-arena (MOBA). Turn it on for any game whose heroes have abilities (hero shooter, ARPG).'),
    provider: schema.enum(['openai', 'xai']).optional().describe('Default openai (GPT Image 2.5 sunburst: final quality for style bible, heroes and bosses, medium-quality sheets of 6 for the rest).'),
    budget: schema.object({ credits: schema.number().nonnegative().optional(), usd: schema.number().nonnegative().optional() }).strict().optional().describe('Required for build: maximum credits OR USD, at least the plan price.'),
    workspace_id: schema.string().max(100).optional(),
    idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
  };
  register(GAME_CONCEPT_TOOL_NAMES[0], {
    title: 'Game concepts',
    description: 'Concept art for a whole game, reused before generated. Use it when a user asks for a game "like God of War", "a GTA", "a Zelda": call stage=plan with the game they named. When the user describes specific items (heroes, weapons, props…), pass them in wishes: they are drawn exactly as asked. The plan lists concepts that already exist for that game (GripForge community catalog or the workspace) and theme assets already in the library: reuse them first. It then prices the missing concepts: one style bible, heroes and bosses one image each (MOBA and hero games: each hero with its ability kit and ability icons, see hero_kits), enemies, NPCs, weapons, vehicles, buildings, props and VFX in sheets of 6 cut automatically, textures in sheets of 2 turned into seamless 1024 px textures. Maps (counts.maps) are environment paintings, one image each: the level is then built and dressed to match them. Show the plan and price to the user; only call stage=build with a budget after they agree. Concepts are private review images; nothing is sent to 3D. The plan also returns ambient_kits: the kits of the theme\'s atmosphere (weather, lighting, snow tracks) with their config; install them in the game project next to the blueprint\'s gameplay kits.',
    inputSchema: shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const key = options.getApiKey();
    const { workspace_id, stage = 'plan', ...body } = parsed.data as Record<string, unknown> & { stage?: string };
    if (!key && stage !== 'catalog') return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + '/api/v1/game-concepts', {
        method: stage === 'catalog' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', ...(key ? { 'x-api-key': key } : {}), ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}) },
        ...(stage === 'catalog' ? {} : { body: JSON.stringify({ ...body, stage }) }),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      for (const field of ['studio_url', 'status_url']) if (typeof data[field] === 'string' && data[field].startsWith('/')) data[field] = new URL(data[field], options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Game concepts request failed.' }] };
    }
  });
}
