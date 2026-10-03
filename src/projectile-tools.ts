import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';
export const PROJECTILE_TOOL_NAME = 'gripforge_projectile_create';
export function registerProjectileTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, s: typeof z = z) {
  const shape = {
    variants: s.array(s.string().min(1).max(40)).min(1).max(20).optional(),
    workspace_id: s.string().max(100).optional(), name: s.string().trim().min(1).max(80).optional(), save: s.boolean().optional(), idempotency_key: s.string().min(8).max(160).optional(),
    config: s.object({ version: s.literal(1).optional(), style: s.enum(['fire', 'ice', 'arcane', 'poison']).optional(), variant: s.enum(['elemental', 'arcane-dart', 'ember-dart', 'venom-dart', 'crimson-bullet', 'frost-bullet', 'frost-orb', 'arcane-orb', 'solar-wisp', 'frost-wisp', 'carrot-shot', 'arcane-disc', 'ice-spear', 'venom-spear', 'venom-orb', 'void-comet', 'solar-comet', 'flame-coil', 'frost-coil', 'storm-bolt', 'solar-bolt']).optional(), radius: s.number().min(.04).max(1).optional(), trailLifetime: s.number().min(.06).max(1).optional(), impactDuration: s.number().min(.15).max(2).optional(), color: s.string().regex(/^#[a-f\d]{6}$/i).optional(), accent: s.string().regex(/^#[a-f\d]{6}$/i).optional(), seed: s.number().int().min(0).max(65535).optional(), quality: s.enum(['low', 'high']).optional() }).strict().optional(),
  };
  register(PROJECTILE_TOOL_NAME, { title: 'Create projectile VFX', description: 'ADMIN ONLY. Create an editable 3D projectile: ignition, elemental volume, world-space trail, embers, contact flash, oriented ring and soot. 20 named variants: darts, short bolts, orbs, wisps, carrot rocket, spinning disc, spears, comets, coils and lightning. config.variant selects the geometry, trail and impact; style/color optionally override its palette. Omit variant to retain the original elemental recipe. To save several catalogue entries, pass variants=[IDs] without config/name: one persistent job renders/reviews each item sequentially, preserves completed items on retry and returns result.items. Publication remains explicit. Uses the shared trail and Scene Engine modules. save=true (default) queues persistent rendering/review/workspace save; poll gripforge_generation_read for Library ID and Studio link. save=false returns an unsaved recipe. Bind the resulting VFX to combat.projectiles/projectile_vfx using the Game Kit tools; gameplay speed/gravity/damage stay in the module. Web/Three.js only in v1. Does not install a kit or modify a game automatically. Recipe compilation needs no AI; saved previews use the existing review pipeline. No automatic visual validation.', inputSchema: shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, async (args, extra) => {
    const parsed = s.object(shape).strict().safeParse(args);
    if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
    const key = options.getApiKey(); if (!key) return { isError: true, content: [{ type: 'text', text: 'GripForge API key required.' }] };
    const { workspace_id, save, ...body } = parsed.data;
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + '/api/v1/vfx/projectiles', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, ...(workspace_id ? { 'x-workspace-id': workspace_id } : {}) }, body: JSON.stringify({ ...body, action: save === false ? 'preview' : 'create' }), signal: AbortSignal.any([AbortSignal.timeout(90000), ...(extra?.signal ? [extra.signal] : [])]) });
      const data = await response.json();
      if (data.studio_url?.startsWith('/')) data.studio_url = new URL(data.studio_url, options.apiUrl).href;
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (e) { return { isError: true, content: [{ type: 'text', text: (e as Error).message }] }; }
  });
}
