import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';
import { LOOK_DESCRIPTION, LOOK_VALUES } from './look.js';

export const ARCHITECTURE_TOOL_NAMES = ['gripforge_architecture_schema', 'gripforge_generate_building', 'gripforge_generate_district', 'gripforge_environment_module', 'gripforge_urban_building'] as const;

/** Hosted and local MCP share the same recipe and durable server workflow. */
export function registerArchitectureTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const identifier = schema.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
  const ref = schema.object({ assetId: identifier, revisionId: identifier, fileRole: identifier.optional() }).strict();
  const point = schema.tuple([schema.number().min(-150).max(150), schema.number().min(-150).max(150), schema.number().min(-150).max(150)]);
  const finishMaterial = { id: schema.string().regex(/^[a-zA-Z0-9_-]{1,48}$/), color: schema.string().regex(/^#[0-9a-f]{6}$/i), roughness: schema.number().min(.05).max(1).optional(), metalness: schema.number().min(0).max(1).optional() };
  const finish = schema.object({ version: schema.literal(1),
    remove: schema.array(schema.object({ center: point, size: schema.tuple([schema.number().min(.001).max(100), schema.number().min(.001).max(100), schema.number().min(.001).max(100)]), rotation: schema.tuple([schema.number().min(-Math.PI*2).max(Math.PI*2), schema.number().min(-Math.PI*2).max(Math.PI*2), schema.number().min(-Math.PI*2).max(Math.PI*2)]).optional() }).strict()).max(64),
    parts: schema.array(schema.discriminatedUnion('kind', [
      schema.object({ kind: schema.literal('shutter'), ...finishMaterial, origin: point, yaw: schema.number().min(-Math.PI*2).max(Math.PI*2).optional(), width: schema.number().min(.2).max(15), height: schema.number().min(.1).max(12), slatHeight: schema.number().min(.035).max(.3).optional() }).strict(),
      schema.object({ kind: schema.literal('railing'), ...finishMaterial, points: schema.array(point).min(2).max(16), height: schema.number().min(.1).max(12), postSpacing: schema.number().min(.2).max(3).optional(), barSpacing: schema.number().min(.05).max(.5).optional(), postRadius: schema.number().min(.015).max(.1).optional(), barRadius: schema.number().min(.006).max(.05).optional(), railRadius: schema.number().min(.01).max(.08).optional() }).strict(),
    ])).min(1).max(32),
  }).strict().describe('Free deterministic repair of an owned source + delivery. All coordinates are Y-up metres AFTER the returned importTransform. Explicit oriented removal boxes (rotation XYZ radians), regular shutters (+Z outward, yaw radians) and railing paths (feet, vertical posts, supports slopes). Measure and review regions first. Applied AFTER each LOD simplification to keep thin parts straight. Textures outside cuts stay byte-identical; removed surfaces are not capped. Triangle targets remain soft. No AI auto-segmentation or collision repair.');
  const building = schema.object({
    id: schema.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/).optional(),
    name: schema.string().min(1).max(100).optional(), prompt: schema.string().min(3).max(300),
    style: schema.enum(['realistic', 'stylized', 'lowpoly', 'handpainted']).optional(),
    look: schema.enum(LOOK_VALUES).optional().describe(`${LOOK_DESCRIPTION} Fills style when style is omitted; toon, anime and pixel add their phrase to the prompt.`),
    provider: schema.enum(['meshy', 'tripo']).optional().describe('3D provider pinned to this recipe, Meshy by default. Tripo v3.1 requires one reviewed concept (no multiview yet) and uses v3.5 PBR textures. No automatic paid provider fallback.'),
    tripoQuality: schema.object({ geometry: schema.enum(['standard', 'detailed']).optional(), texture: schema.enum(['standard', 'detailed', 'extreme']).optional() }).strict().optional().describe('Tripo-only quality; default detailed geometry and detailed textures. extreme requests 8K. Read the separate provider quote. Exclusive with Meshy meshQuality and source.'),
    use: schema.enum(['residential', 'retail', 'office', 'industrial', 'mixed']).optional(),
    floors: schema.number().int().min(1).max(30).optional(),
    dimensions: schema.object({ width: schema.number().min(3).max(100).optional(), depth: schema.number().min(3).max(100).optional(), height: schema.number().min(3).max(150).optional() }).strict().optional().describe('Maximum footprint and height in metres. Uniform fit preserves proportions; actual dimensions are returned.'),
    roof: schema.enum(['flat', 'pitched']).optional(), facade: schema.string().max(120).optional(),
    polycount: schema.number().int().min(4000).max(80000).optional(),
    concept: ref.optional().describe('Owned PNG/JPEG/WebP revision for Meshy image-to-3D. At most 12 MiB. Mutually exclusive with source.'),
    concepts: schema.array(ref).min(1).max(4).optional().describe('Coherent views of ONE building, front first, for Meshy multi-image-to-3D. Exclusive with concept/source. Review coherence before building.'),
    meshQuality: schema.object({ geometry: schema.enum(['standard', '2k', '4k']).optional(), texture: schema.enum(['2k', '4k', '8k']).optional() }).strict().optional().describe('Meshy 7.1 quality. Defaults standard geometry and 2K PBR. Multi-image supports standard/2k geometry only. Texture resolution is preserved during optimization. Read the updated quote.'),
    delivery: schema.object({ lods: schema.array(schema.object({ triangles: schema.number().int().min(1000).max(200000), textureSize: schema.union([schema.literal(1024), schema.literal(2048), schema.literal(4096), schema.literal(8192)]), maxError: schema.number().min(0).max(.02).optional(), lockBorder: schema.boolean().optional() }).strict()).min(1).max(3) }).strict().optional().describe('Preserve an immutable full-detail source without provider remeshing, then prepare 1–3 independent LOD GLBs. Highest detail first, decreasing triangles and texture sizes. Default maxError=.001, lockBorder=true prioritizes detail and may exceed targets. For distant levels, explicitly allow e.g. maxError=.005/.01 and lockBorder=false after review. Shared metric fit and preserved PBR. No normal rebake, runtime LOD switching or inferred collision. Also works with source at no provider cost.'),
    source: ref.optional().describe('Reuse an owned static GLB revision instead of paying for this building. The source is never modified.'),
    finish: finish.optional(),
  }).strict();
  const material = schema.record(schema.string(), schema.unknown()).describe('SceneMaterialOverride: color, roughness, metalness, map/normalMap/roughnessMap/metalnessMap as owned immutable SceneAssetRef, repeat:[u,v]. Validated by the shared Scene Engine.');
  const district = schema.object({
    version: schema.literal(1).optional(), name: schema.string().min(1).max(100).optional(),
    buildings: schema.array(building).min(1).max(8).describe('Unique building definitions with distinct ids. Each new model is manufactured once.'),
    repetitions: schema.number().int().min(1).max(4).optional().describe('Instances per definition, without additional model generation cost.'),
    streetWidth: schema.number().min(6).max(30).optional(), sidewalkWidth: schema.number().min(1).max(8).optional(), gap: schema.number().min(1).max(30).optional(),
    materials: schema.object({ road: material.optional(), sidewalk: material.optional() }).strict().optional(),
  }).strict();
  const shared = {
    stage: schema.enum(['plan', 'build']).optional().describe('Default plan is free and does not generate. Read its quote, then explicitly build.'),
    budget: schema.object({ credits: schema.number().nonnegative().optional(), usd: schema.number().nonnegative().optional() }).strict().optional().describe('Required for paid concept/build: maximum GripForge credits OR subscription USD accepted. Use the quote funding currency: insufficient AI allowance falls back to GripForge credits for the whole new job, never both. Use plan.concept_quote for images, plan.quote for Meshy. Provider credits are separate.'),
    workspace_id: schema.string().max(100).optional(),
    idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
  };
  const moduleRecipe = schema.object({
    module: schema.enum(['pillar', 'arch', 'fountain', 'stairs', 'wall', 'pavement', 'rock', 'cliff', 'ruin', 'bridge', 'watchtower', 'shrine', 'guardian']),
    width: schema.number().min(.3).max(40).optional(), depth: schema.number().min(.3).max(40).optional(), height: schema.number().min(.05).max(20).optional(),
    seed: schema.number().int().min(0).max(2147483646).optional(),
    pattern: schema.enum(['radial', 'botanical']).optional().describe('Pavement only: botanical adds a broad leaf rosette inlay, radial keeps the original restrained rings.'),
    palette: schema.object({ stone: schema.string().regex(/^#[0-9a-f]{6}$/i).optional(), recess: schema.string().regex(/^#[0-9a-f]{6}$/i).optional(), trim: schema.string().regex(/^#[0-9a-f]{6}$/i).optional(), water: schema.string().regex(/^#[0-9a-f]{6}$/i).optional() }).strict().optional(),
  }).strict();
  const definitions: Array<{ name: string; kind: string; shape: z.ZodRawShape; title: string; description: string }> = [
    { name: ARCHITECTURE_TOOL_NAMES[4], kind:'urban', title:'Manufacture a reusable urban building', description:'Free, deterministic parametric architecture. plan validates a metric recipe; build queues a durable common-compute job and returns job_id to poll with gripforge_generation_read. Real window reveals, balconies, shopfronts, rooftop HVAC, photographic PBR and optional arid shutters/canopies/water tanks. Private immutable GLB plus recipe/report; reuse via Library bindings or scene instances. Nominal width/depth exclude protrusions: use returned actual bounds and preserve proportions. A solid envelope with storefront depth, not traversable interiors, a complete city or an AI replacement for gripforge_generate_building. Review in the actual game. 0 credits.', shape:{stage:schema.enum(['plan','build']).optional(),workspace_id:schema.string().max(100).optional(),idempotency_key:shared.idempotency_key,recipe:schema.object({name:schema.string().min(1).max(100),style:schema.enum(['brick','balconies','limestone','loft','workshop','office','stucco']),width:schema.number().min(6).max(30).optional(),depth:schema.number().min(6).max(30).optional(),floors:schema.number().int().min(1).max(20).optional(),seed:schema.number().int().min(0).max(2147483646).optional(),shop:schema.number().int().min(0).max(7).optional(),climate:schema.enum(['temperate','arid']).optional(),palette:schema.object({facade:schema.string().regex(/^#[a-fA-F0-9]{6}$/).optional(),stone:schema.string().regex(/^#[a-fA-F0-9]{6}$/).optional(),trim:schema.string().regex(/^#[a-fA-F0-9]{6}$/).optional(),roof:schema.string().regex(/^#[a-fA-F0-9]{6}$/).optional()}).strict().optional()}).strict()} },
    { name: ARCHITECTURE_TOOL_NAMES[0], kind: 'schema', shape: {}, title: 'Architecture · schema', description: 'Read the reusable Meshy/Tripo building and district contract, example, limits and plan → build workflow. Separate immutable Library assets, scene instances and shared SceneDocument. No paid generation.' },
    { name: ARCHITECTURE_TOOL_NAMES[1], kind: 'building', shape: { ...shared, recipe: building,
      stage: schema.enum(['plan', 'concept', 'build']).optional().describe('plan is free: exact prompts and separate image/3D quotes. concept creates reviewable workspace images. First review artistic scene, then isolated views of the SAME building, then build 3D from chosen isolated references.'),
      concept_provider: schema.enum(['openai', 'xai']).optional().describe('Default openai (GPT Image 2.5 Sunburst, high quality). xai explicitly selects Imagine. Provider is pinned in the durable job; never silently falls back. Read the provider-specific concept_quote.'),
      concept_presentation: schema.enum(['scene', 'isolated']).optional().describe('Default scene: artistic concept in its neighbourhood preserving the user atmosphere and lighting. isolated: technical views of the SAME building for 3D reconstruction. Keep rich architectural detail in both.'),
      concept_reference: ref.optional().describe('Owned artistic reference to EDIT into new scene/isolated views. Distinct from recipe.concept, which reuses an existing front view without generation. Exclusive with recipe.concept/concepts/source and stage=build.'),
      concept_views: schema.array(schema.enum(['front_right', 'front_left', 'rear_right', 'rear_left'])).min(1).max(4).optional().describe('Unique views starting with front_right. Default one view for scene or Tripo, three for isolated Meshy. Tripo requires one view. Alternate views edit the SAME master. recipe.concept reuses an existing master; concept_reference guides a NEW master.'),
    }, title: 'Generate a building', description: 'Reusable plan → artistic concept → isolated reference views → review → Meshy or explicitly selected Tripo build workflow. Generate 1–4 images through OpenAI or Imagine; alternate views reference one master but must be checked for actually different viewpoints. If edits repeat the front, use one good concept instead of a false multiview set. Separate explicit budgets for concepts and 3D. Accepts text, owned concept views or a static GLB. Optional delivery preserves the source master and prepares reusable LOD GLBs with PBR and a common metric fit. Durable jobs return workspace links; poll generation_read, cancel/retry preserves finished steps. Review the actual render before publishing. No guaranteed interiors, collisions or runtime LOD switching; no automatic game replacement.' },
    { name: ARCHITECTURE_TOOL_NAMES[2], kind: 'district', shape: { ...shared, recipe: district }, title: 'Generate a district', description: 'Plan then build a straight-street district from 1–8 distinct Meshy/Tripo buildings, each manufactured once and reused as separate editable instances. Includes road, pavements, spawn, daylight and camera in the shared Map SceneDocument. Optional owned PBR road/pavement maps; otherwise simple solid surfaces. Plan returns layout, provider-credit count and account quote without spending. Build requires a budget and returns a persistent job, then Map Studio link. Private work version requiring visual review; no automatic Community publication or game replacement.' },
    { name: ARCHITECTURE_TOOL_NAMES[3], kind: 'module', shape: { stage: schema.enum(['inspect', 'build']).optional(), recipe: moduleRecipe, name: schema.string().min(1).max(100).optional(), workspace_id: schema.string().max(100).optional() }, title: 'Create a reusable environment module', description: 'Free parametric 3D masonry, independent of any game: pillar, arch, fountain, stairs, wall, pavement, rock, cliff, ruin, bridge, watchtower, shrine or a stone guardian. inspect (default) returns real generated bounds, triangle count, metric recipe and assembly sockets. build saves a private textured GLB in the Library, with bevelled geometry, baked vertex shading and named stone/recess/trim/water materials. Dimensions are nominal metres; bounds report actual moulding overhang. Ground origin, stairs ascend toward -Z, <=23 cm risers; top/bottom sockets support assembly. Seed and palette are repeatable. Does not place assets, generate arbitrary AI models, publish, or guarantee navigation/collisions in a target game. 0 credits.' },
  ];
  for (const tool of definitions.sort((a,b)=>(ARCHITECTURE_TOOL_NAMES as readonly string[]).indexOf(a.name)-(ARCHITECTURE_TOOL_NAMES as readonly string[]).indexOf(b.name))) register(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.shape,
    annotations: { readOnlyHint: tool.kind === 'schema', destructiveHint: false, idempotentHint: tool.kind === 'schema', openWorldHint: tool.kind !== 'schema' } }, async (args, extra) => {
    const parsed = schema.object(tool.shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const key = options.getApiKey();
    if (!key && tool.kind !== 'schema') return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    const { workspace_id, ...body } = parsed.data as Record<string, unknown>;
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + (tool.kind === 'module' ? '/api/v1/environment-modules' : tool.kind === 'urban' ? '/api/v1/urban-buildings' : '/api/v1/architecture'), {
        method: tool.kind === 'schema' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', ...(key ? { 'x-api-key': key } : {}), ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}) },
        ...(tool.kind === 'schema' ? {} : { body: JSON.stringify(['module','urban'].includes(tool.kind) ? body : { ...body, kind: tool.kind }) }),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      for (const field of ['studio_url', 'status_url']) if (typeof data[field] === 'string' && data[field].startsWith('/')) data[field] = new URL(data[field], options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Architecture request failed.' }] }; }
  });
}
