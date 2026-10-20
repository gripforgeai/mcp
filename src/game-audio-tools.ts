import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const GAME_AUDIO_TOOL_NAMES = ['gripforge_game_audio', 'gripforge_audio_generate'] as const;

/** One project API for the hosted MCP and the npm client. No synthesis or purchase is implicit. */
export function registerGameAudioTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const shape = {
    project_id: schema.string().regex(/^gkp_[A-Za-z0-9_-]{1,76}$/),
    action: schema.enum(['get', 'configure']).default('get'),
    roles: schema.record(schema.string(), schema.array(schema.string().max(120)).min(1).max(16).nullable()).optional().describe('Role → variants. get lists the roles. Sources: lib:lib_…, slot:<id>, base:<recipe>. null resets SFX, silences that music state or removes global ambience.'),
    weapons: schema.record(schema.string(), schema.array(schema.string().max(120)).min(1).max(16).nullable()).optional().describe('Gun model ID → shot variants, e.g. {rifle:["lib:lib_…"]}. null restores the generic shot. Web/Rust conditional cues: one shot, no duplicate; other weapons retain their defaults. Legacy engine scripts are unverified.'),
    volumes: schema.record(schema.string(), schema.number().int().min(0).max(100)).optional().describe('Default bus percentages: master, music, sfx, voice, ambience, ui. Player preferences still win.'),
    fade: schema.number().min(0).max(10).optional().describe('Music crossfade in seconds.'),
    expected_revision: schema.number().int().min(1).optional(),
    dry_run: schema.boolean().optional(),
    workspace_id: schema.string().max(100).optional(),
  };
  register(GAME_AUDIO_TOOL_NAMES[0], {
    title: 'Game audio · effects, weapons, music and ambience',
    description: 'Read and configure the existing audio.core of an owned Game Kit project. get returns revision, role catalogue, sources, procedural/silent roles, weapon shot overrides, bus defaults, music states/playlists, event cues and broken references. It is a configuration audit; playback stays unverified until heard in the player. configure merges only supplied roles/weapons/volumes/fade and requires expected_revision from get. dry_run previews the same validated result without saving. Preserves other sounds, custom cues, spatial areas and Rust acoustic geometry. Search Library audio first; never use a sound effect as music. No generation, GPU rental, asset purchase or credit charge. Voice identities use gripforge_voice_profile and dialogue.voice; bake audio.speech through Drama 3, English by default.',
    inputSchema: shape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const { project_id, action, workspace_id, ...body } = parsed.data;
    if (action === 'configure' && body.expected_revision === undefined) return { isError: true, content: [{ type: 'text', text: 'Read project audio first; expected_revision is required for configure.' }] };
    if (action === 'get' && Object.values(body).some(v => v !== undefined)) return { isError: true, content: [{ type: 'text', text: 'Use action=configure to submit an audio patch.' }] };
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    try {
      const response = await fetch(`${options.apiUrl.replace(/\/$/, '')}/api/v1/gamekit-projects/${encodeURIComponent(project_id)}/audio`, {
        method: action === 'configure' ? 'PATCH' : 'GET',
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(workspace_id ? { 'x-workspace-id': workspace_id } : {}) },
        ...(action === 'configure' ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Game audio request failed.' }] }; }
  });

  const generation = {
    action: schema.enum(['quote', 'generate']).default('quote'),
    prompt: schema.string().min(3).max(2000).describe('Describe one isolated sound in English: source, action, material, character and decay.'),
    name: schema.string().min(1).max(160).optional(),
    subtype: schema.enum(['sfx', 'ambience']).default('sfx'),
    duration: schema.number().min(0.5).max(60).default(3),
    variants: schema.number().int().min(1).max(4).default(1),
    seed: schema.number().int().min(0).max(2147483643).default(0),
    loop: schema.boolean().default(false),
    project_id: schema.string().regex(/^gkp_[A-Za-z0-9_-]{1,76}$/).optional(),
    role: schema.string().max(60).optional().describe('Optional project role from gripforge_game_audio get. Requires expected_revision. Music/voice roles are not supported.'),
    weapon: schema.string().regex(/^[a-z0-9][a-z0-9_.-]{0,47}$/).optional().describe('Optional gun model ID, requires role=shot.'),
    expected_revision: schema.number().int().min(1).optional(),
    quote_hash: schema.string().regex(/^[a-f0-9]{64}$/).optional(),
    idempotency_key: schema.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional(),
    workspace_id: schema.string().max(100).optional(),
  };
  register(GAME_AUDIO_TOOL_NAMES[1], {
    title: 'Generate game sounds · Stable Audio 3 Medium',
    description: 'Generate SFX and ambience with self-hosted Stable Audio 3 Medium, the default sound model. No downgrade to Small. Call action=quote first (no generation/charge), then action=generate with the returned quote_hash and identical inputs. Cost is disclosed in the quote; generation may spend the selected AI allowance or GripForge credits. Returns a durable job_id immediately; poll gripforge_generation_read. Successful takes survive retries as Library audio with prompt, seed, revision and WAV measurements. Optional role assignment uses expected_revision; a conflicting edit keeps takes in Library without overwriting the project. Listen to results: quality and seamless loops are unreviewed. Max SFX 30s, ambience 60s, 1–4 variants, seed increments per take. Music uses its own pipeline; voices use Drama 3 via audio.speech.',
    inputSchema: generation,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const parsed = schema.object(generation).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const { action, workspace_id, ...body } = parsed.data;
    if (body.subtype === 'sfx' && body.duration > 30 || body.role && (!body.project_id || !body.expected_revision) || body.weapon && body.role !== 'shot' || action === 'generate' && !body.quote_hash) return { isError: true, content: [{ type: 'text', text: 'SFX max 30s; role requires project_id and expected_revision; weapon requires role=shot; generate requires quote_hash from a matching quote.' }] };
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    try {
      const response = await fetch(`${options.apiUrl.replace(/\/$/, '')}/api/v1/audio-generations${action === 'quote' ? '/quote' : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(workspace_id ? { 'x-workspace-id': workspace_id } : {}) }, body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]),
      });
      const data = await response.json();
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (e) { return { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : 'Audio generation failed.' }] }; }
  });
}
