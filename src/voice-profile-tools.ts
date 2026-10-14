import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';
export const VOICE_PROFILE_TOOL_NAMES = ['gripforge_voice_profile'] as const;
export function registerVoiceProfileTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const shape = {
    action: schema.enum(['schema', 'list', 'get', 'characters', 'assign']).default('list'),
    q: schema.string().max(100).optional(), language: schema.string().max(20).optional(), scope: schema.enum(['all', 'mine', 'community']).optional(),
    voice_id: schema.string().regex(/^lib_[A-Za-z0-9_-]{8,64}$/).optional(),
    project_id: schema.string().regex(/^gkp_[A-Za-z0-9_-]+$/).optional(),
    speaker: schema.string().trim().min(1).max(100).optional(), instructions: schema.string().max(500).optional(),
    expected_revision: schema.number().int().min(1).optional(), workspace_id: schema.string().max(100).optional(),
  };
  register(VOICE_PROFILE_TOOL_NAMES[0], {
    title: 'Voice profiles · listen and cast characters',
    description: 'Reusable voice identities in Community > Audio > Voices and the workspace. list/get return provider, model, voice, tested languages, acting instructions and timed sample ranges in file_url. schema describes the contract. characters reads speakers and revision from an OWNED Game Kit project. To assign, first clone a community voice into the workspace, then supply voice_id, project_id, speaker, language and expected_revision from characters. Optional instructions describe the character acting style. Saves a per-speaker/language snapshot in dialogue.voice voice_cast, preserving other voices and dialogue content. Assignment performs no TTS: bake recordings with tools/dialogue-voice/build.mjs and a matching worker. Per-line emotions use dialogue_voice_directions. Free reads; no GPU rental or automatic generation.',
    inputSchema: shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const { workspace_id, action, ...body } = parsed.data;
    if (['get', 'assign'].includes(action) && !body.voice_id) return { isError: true, content: [{ type: 'text', text: 'voice_id is required.' }] };
    if (['characters', 'assign'].includes(action) && !body.project_id) return { isError: true, content: [{ type: 'text', text: 'project_id is required.' }] };
    if (action === 'assign' && (!body.speaker || !body.language || body.expected_revision === undefined)) return { isError: true, content: [{ type: 'text', text: 'speaker, language and expected_revision are required for assign.' }] };
    const key = options.getApiKey();
    if (['characters', 'assign'].includes(action) && !key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    const url = new URL(options.apiUrl.replace(/\/$/, '') + '/api/v1/voice-profiles');
    if (action !== 'assign') { url.searchParams.set('action', action); for (const [name, value] of Object.entries(body)) if (value !== undefined) url.searchParams.set(name, String(value)); }
    try {
      const response = await fetch(url, { method: action === 'assign' ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', ...(key ? { 'x-api-key': key } : {}), ...(workspace_id ? { 'x-workspace-id': workspace_id } : {}) }, ...(action === 'assign' ? { body: JSON.stringify({ action, ...body }) } : {}), signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]) });
      const data = await response.json();
      for (const item of [data, ...(Array.isArray(data.items) ? data.items : [])]) if (typeof item.file_url === 'string' && item.file_url.startsWith('/')) item.file_url = new URL(item.file_url, options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Voice profile request failed.' }] }; }
  });
}
