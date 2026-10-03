import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const ARCHITECTURE_TOOL_NAMES = ['gripforge_architecture_schema', 'gripforge_generate_building', 'gripforge_generate_district'] as const;

/** Hosted and local MCP share the same recipe and durable server workflow. */
export function registerArchitectureTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const identifier = schema.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/);
  const ref = schema.object({ assetId: identifier, revisionId: identifier, fileRole: identifier.optional() }).strict();
  const building = schema.object({
    id: schema.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/).optional(),
    name: schema.string().min(1).max(100).optional(), prompt: schema.string().min(3).max(300),
    style: schema.enum(['realistic', 'stylized', 'lowpoly', 'handpainted']).optional(),
    use: schema.enum(['residential', 'retail', 'office', 'industrial', 'mixed']).optional(),
    floors: schema.number().int().min(1).max(30).optional(),
    dimensions: schema.object({ width: schema.number().min(3).max(100).optional(), depth: schema.number().min(3).max(100).optional(), height: schema.number().min(3).max(150).optional() }).strict().optional().describe('Maximum footprint and height in metres. Uniform fit preserves proportions; actual dimensions are returned.'),
    roof: schema.enum(['flat', 'pitched']).optional(), facade: schema.string().max(120).optional(),
    polycount: schema.number().int().min(4000).max(80000).optional(),
    concept: ref.optional().describe('Owned PNG/JPEG/WebP revision for Meshy image-to-3D. At most 12 MiB. Mutually exclusive with source.'),
    concepts: schema.array(ref).min(1).max(4).optional().describe('Coherent views of ONE building, front first, for Meshy multi-image-to-3D. Exclusive with concept/source. Review coherence before building.'),
    meshQuality: schema.object({ geometry: schema.enum(['standard', '2k', '4k']).optional(), texture: schema.enum(['2k', '4k', '8k']).optional() }).strict().optional().describe('Meshy 7.1 quality. Defaults standard geometry and 2K PBR. Multi-image supports standard/2k geometry only. Texture resolution is preserved during optimization. Read the updated quote.'),
    source: ref.optional().describe('Reuse an owned static GLB revision instead of paying for this building. The source is never modified.'),
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
  const definitions = [
    { name: ARCHITECTURE_TOOL_NAMES[0], kind: 'schema', shape: {}, title: 'Architecture · schema', description: 'Read the reusable Meshy building and district contract, example, limits and plan → build workflow. Separate immutable Library assets, scene instances and shared SceneDocument. No paid generation.' },
    { name: ARCHITECTURE_TOOL_NAMES[1], kind: 'building', shape: { ...shared, recipe: building,
      stage: schema.enum(['plan', 'concept', 'build']).optional().describe('plan is free: exact prompts and separate image/3D quotes. concept creates reviewable workspace images. First review artistic scene, then isolated views of the SAME building, then build 3D from chosen isolated references.'),
      concept_provider: schema.enum(['openai', 'xai']).optional().describe('Default openai (GPT Image 2.5 Sunburst, high quality). xai explicitly selects Imagine. Provider is pinned in the durable job; never silently falls back. Read the provider-specific concept_quote.'),
      concept_presentation: schema.enum(['scene', 'isolated']).optional().describe('Default scene: artistic concept in its neighbourhood preserving the user atmosphere and lighting. isolated: technical views of the SAME building for Meshy. Keep rich architectural detail in both.'),
      concept_reference: ref.optional().describe('Owned artistic reference to EDIT into new scene/isolated views. Distinct from recipe.concept, which reuses an existing front view without generation. Exclusive with recipe.concept/concepts/source and stage=build.'),
      concept_views: schema.array(schema.enum(['front_right', 'front_left', 'rear_right', 'rear_left'])).min(1).max(4).optional().describe('Unique views starting with front_right. Default one view for scene, three for isolated. Alternate views edit the SAME master. recipe.concept reuses an existing master; concept_reference guides a NEW master.'),
    }, title: 'Generate a building', description: 'Reusable plan → artistic concept → isolated reference views → review → Meshy build workflow. Generate 1–4 coherent images through OpenAI (1536×1024 high quality, default) or Imagine (2K), saved as private Library drafts; alternate views reference one master. Separate explicit budgets for concepts and 3D. Accepts text, owned single/multiple concept views or an owned static GLB. Meshy PBR/geometry quality, bounded geometry and uniform metric fit. Durable jobs return workspace links; poll generation_read, cancel/retry preserves finished steps. Review images before building and the real Studio render before publishing. No guaranteed interiors, collisions or LODs. Never substitutes procedural geometry or automatically replaces a game asset.' },
    { name: ARCHITECTURE_TOOL_NAMES[2], kind: 'district', shape: { ...shared, recipe: district }, title: 'Generate a district', description: 'Plan then build a straight-street district from 1–8 distinct Meshy buildings, each manufactured once and reused as separate editable instances. Includes road, pavements, spawn, daylight and camera in the shared Map SceneDocument. Optional owned PBR road/pavement maps; otherwise simple solid surfaces. Plan returns layout, provider-credit count and account quote without spending. Build requires a budget and returns a persistent job, then Map Studio link. Private work version requiring visual review; no automatic Community publication or game replacement.' },
  ];
  for (const tool of definitions) register(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.shape,
    annotations: { readOnlyHint: tool.kind === 'schema', destructiveHint: false, idempotentHint: tool.kind === 'schema', openWorldHint: tool.kind !== 'schema' } }, async (args, extra) => {
    const parsed = schema.object(tool.shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const key = options.getApiKey();
    if (!key && tool.kind !== 'schema') return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    const { workspace_id, ...body } = parsed.data as Record<string, unknown>;
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + '/api/v1/architecture', {
        method: tool.kind === 'schema' ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', ...(key ? { 'x-api-key': key } : {}), ...(typeof workspace_id === 'string' ? { 'x-workspace-id': workspace_id } : {}) },
        ...(tool.kind === 'schema' ? {} : { body: JSON.stringify({ ...body, kind: tool.kind }) }),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      for (const field of ['studio_url', 'status_url']) if (typeof data[field] === 'string' && data[field].startsWith('/')) data[field] = new URL(data[field], options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Architecture request failed.' }] }; }
  });
}
