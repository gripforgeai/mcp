/** Local publisher: credentials stay in the process environment, never tool arguments. */
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';
export function registerGamePublicationTools(register: VfxProjectRegister, options: { apiUrl: string; getToken: () => string | undefined }) {
  register('gripforge_game_listing_update', {
    title: 'Update a published game page',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description: 'Replace a registered game’s marketplace description and photo gallery without uploading its executables again. First image is the cover. Requires the game-specific GRIPFORGE_PUBLICATION_TOKEN environment variable. Send all desired images; an empty array removes the gallery. Images must be local PNG/JPEG/WebP files, at most 5 MiB each. Returns the public page URL.',
    inputSchema: { game_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), description: z.string().min(1).max(12000), images: z.array(z.object({ path: z.string().min(1), caption: z.string().max(300) })).max(8) },
  }, async (input) => {
    const args = input as { game_id: string; description: string; images: Array<{ path: string; caption: string }> };
    try {
      const token = options.getToken();
      if (!token) throw new Error('Set GRIPFORGE_PUBLICATION_TOKEN for this game in the MCP environment.');
      const base = new URL(options.apiUrl);
      if (base.protocol !== 'https:') throw new Error('Publication requires HTTPS');
      const images = [];
      for (const item of args.images) {
        if ((await stat(item.path)).size > 5 * 1024 * 1024) throw new Error('Each image must be at most 5 MiB');
        images.push({ caption: item.caption, base64: (await readFile(item.path)).toString('base64') });
      }
      const response = await fetch(new URL(`/api/v1/published-games/${args.game_id}/listing`, base), { method: 'PUT', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ description: args.description, images }), signal: AbortSignal.timeout(120000) });
      const result = await response.json() as { error?: string; url?: string };
      if (!response.ok) throw new Error(result.error || `Publication failed (${response.status})`);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...result, url: new URL(result.url!, base).href }) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Publication failed' }] }; }
  });
}
