import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const GAME_CREATION_TOOL_NAMES = ['gripforge_game_creation'] as const;
export function registerGameCreationTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const shape = {
    action: schema.enum(['list', 'get', 'assets', 'create', 'select', 'use_reference', 'approve_concept', 'approve_asset', 'quote', 'accept', 'cancel', 'retry', 'dismiss']),
    id: schema.string().max(100).optional(), workspace_id: schema.string().max(100).optional(),
    expected_revision: schema.number().int().positive().optional(), prompt: schema.string().max(2000).optional(),
    engine: schema.enum(['web', 'unity', 'godot', 'unreal']).optional(), slot_id: schema.string().max(100).optional(),
    mode: schema.enum(['select', 'generate', 'default']).optional(), asset_id: schema.string().max(100).optional(),
    operation: schema.enum(['plan', 'refine', 'concept', 'generate', 'build', 'develop']).optional(), quote_token: schema.string().max(100).optional(),
    message: schema.string().trim().min(3).max(1500).optional(), allow_incomplete: schema.boolean().optional(),
    other_styles: schema.boolean().optional(), source: schema.enum(['all', 'workspace', 'community']).optional(), q: schema.string().max(100).optional(),
  };
  register(GAME_CREATION_TOOL_NAMES[0], {
    title: 'Prepare and resume a game',
    description: 'The website and CLI share this saved 3D game creation workflow. Ask which engine (Unity, Godot, Unreal, Three.js) if unspecified; do not choose silently. create saves a brief without spending. quote(operation=plan) estimates AI preparation, accept(quote_token) starts its durable job ONLY after user approval of the shown price. get returns a persistent operation log, slots, studio_url and the same project to resume. Planning can select an appropriate preset OR compose real engine-compatible modules. A missing preset never means the genre needs a native engine. composition.modules pins all module versions; composition.tasks lists the custom logic still to implement. Assembly is a foundation, not a completed custom game: For an assembled web project, quote operation=develop with an optional message, review its bounded price and accept to implement content/configuration using shared MCP kits, playtest and repair in a durable worker. Continue the same conversation and project. The development result distinguishes agent-declared changes, actual checks, remaining work and unsupported runtime capabilities. Each additional pass needs its own estimate; no paid asset generation is included. Native/custom-code development still uses the CLI. After a build, get also returns creatures (the models bound so that no unit is a capsule) and audit { verdict: complete | playable_with_defects | incomplete, headline, fixed (the free fixes applied: models, standard clips, control scheme), defects [{ severity, message, fix { tool, args, credits? } }], next }: show the user the verdict and what is left, work through next (gripforge_game_audit reads it again), and never present a verdict other than complete as a finished game. quote refine with message updates the same plan after approval, preserves selected assets and reviewed work, and persists the conversation. use_reference with slot_id and an owned image asset_id supplies an uploaded concept for visual review. assets searches workspace/community items by actual role before invented generation details. Generic nature packs may cross world themes while keeping the rendering look. New plans consider available styles before inventing one; selection_reason explains planner choices. other_styles=true reveals alternatives with explicit mismatch/unknown compatibility for manual review; never bind a known look mismatch automatically. Prefer reuse before generation; select chooses one or sets mode=generate with a prompt. For generation: quote concept, obtain approval, accept, poll get, show the concept, approve_concept only after visual user review; quote generate, obtain approval, accept, poll and show the model in its studio. A quote with auto_select_character=true selects the missing main character by default when ready; it remains inspectable and replaceable. Other models, replacement generations and older approved jobs remain drafts: approve_asset only after visual review. Never infer visual approval from technical success. quote build then accept acquires the selected community assets and binds them to a Game Kit prototype, without generating extra assets. The main playable character is presented first. If no usable matching rigged/animated model is found, prepare its generation. A missing main character blocks assembly until an existing or generated model is selected. With explicit allow_incomplete=true on the build quote, missing secondary slots may use module defaults where available or remain empty, but a generated model awaiting review blocks assembly until explicitly approved or another asset is selected. Show missing_assets before approval; never imply that an incomplete prototype is finished. Native engine projects still need CLI delivery/import; a web project has a play_url. Revision required for edits. Cancel/retry preserve completed steps. 2D unsupported. No automatic spending, invented asset IDs, or unrelated template substitutions.',
    inputSchema: shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge login required.' }] };
    const { workspace_id, ...body } = parsed.data;
    const read = ['list', 'get', 'assets'].includes(body.action);
    const url = new URL('/api/v1/game-creations', options.apiUrl);
    if (read) for (const [k, v] of Object.entries(body)) if (v !== undefined) url.searchParams.set(k, String(v));
    try {
      const response = await fetch(url, { method: read ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-gripforge-client': 'mcp', ...(workspace_id ? { 'x-workspace-id': workspace_id } : {}) },
        ...(read ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(extra?.signal ? [extra.signal] : [])]) });
      const data = await response.json();
      if (typeof data.studio_url === 'string') data.studio_url = new URL(data.studio_url, options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Creation request failed.' }] }; }
  });
}
