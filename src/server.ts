#!/usr/bin/env node
/**
 * GripForge MCP — thin client.
 *
 * Exposes gripforge_attach to any MCP client (Claude Code, Cursor, Grok…) and
 * delegates the compute to the hosted GripForge API. Requires an API key:
 * create one at https://gripforge.ai/login and set GRIPFORGE_API_KEY in the
 * server env. 1 credit = 1 successful attach.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = process.env.GRIPFORGE_API_URL ?? 'https://gripforge.ai';
const API_KEY = process.env.GRIPFORGE_API_KEY;

const SUPPORTED = ['.glb', '.gltf', '.fbx', '.obj'];

const server = new McpServer({ name: 'gripforge', version: '0.1.5' });

const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

server.tool(
  'gripforge_attach',
  'Attach a prop (sword, shield, gun, staff/scythe…) onto a rigged character. ' +
    'Finds the hand bone across naming schemes, scales to body height, seats the grip, ' +
    'and returns a bind + ready-to-paste Three.js / Unity / Godot snippets. ' +
    'Pass local paths or Library ids (character_id / prop_id). After attach the bind ' +
    '(+ armed GLB when export_glb) is saved in Library — not a second credit. ' +
    'Exact placement: add an Empty/locator named "grip" on the handle inside the weapon file — ' +
    'GripForge puts that point in the palm and skips all grip heuristics. ' +
    'Hand closing: rigs WITH finger bones get bind.gripPose rotations (applied by the snippets); ' +
    'rigs WITHOUT finger bones (mitten hands) need export_glb: true + out_dir to receive ' +
    'attached.glb with the fist baked in — the JSON bind alone cannot close a mitten hand.',
  {
    character_path: z.string().optional().describe('Absolute path to the rigged character (.glb .gltf .fbx .obj)'),
    prop_path: z.string().optional().describe('Absolute path to the prop mesh'),
    character_id: z.string().optional().describe('Library id of a character (lib_…)'),
    prop_id: z.string().optional().describe('Library id of a prop (lib_…)'),
    style: z.enum(['melee', 'gun', 'shield', 'staff']).optional().describe('Grip style (default: guessed from the filename)'),
    hand: z.enum(['right', 'left']).optional().describe('Hand side (default right)'),
    height_ratio: z.number().min(0.05).max(1.5).optional().describe('Prop size as a fraction of body height'),
    fist: z.number().min(0).max(1).optional().describe('Fist closing amount, 0 open → 1 closed (default 1)'),
    grip_offset: z
      .array(z.number())
      .length(3)
      .optional()
      .describe('Grip fine-tune [palm, lateral, along-handle] in palm units — overrides the weapon-class defaults'),
    ai_refine: z
      .boolean()
      .optional()
      .describe('Vision-model verification of the grip: renders the fist+weapon, checks the hold, auto-corrects (adds ~10-30s)'),
    export_glb: z
      .boolean()
      .optional()
      .describe(
        'Bake character + closed fist + prop into one attached.glb (requires out_dir; .glb/.gltf inputs only). ' +
          'Use this for mitten-hand rigs: the closed fist cannot travel in the bind JSON.',
      ),
    out_dir: z.string().optional().describe('Write bind.json + engine snippets into this folder'),
  },
  async ({ character_path, prop_path, character_id, prop_id, style, hand, height_ratio, fist, grip_offset, ai_refine, export_glb, out_dir }) => {
    if (!API_KEY) {
      return err(
        'GRIPFORGE_API_KEY missing. Create a free account at ' +
          API_URL +
          '/login then set the key in this MCP server env:\n' +
          '"env": { "GRIPFORGE_API_KEY": "gf_..." }',
      );
    }
    if (!character_id && !character_path) return err('Provide character_path or character_id.');
    if (!prop_id && !prop_path) return err('Provide prop_path or prop_id.');
    if (export_glb && !out_dir) {
      return err('export_glb needs out_dir — that is where attached.glb will be written.');
    }

    const form = new FormData();
    if (character_id) {
      form.append('character_id', character_id);
    } else {
      const charPath = resolve(character_path!);
      if (!SUPPORTED.includes(extname(charPath).toLowerCase())) {
        return err(`Unsupported format: ${charPath} — use ${SUPPORTED.join(' ')}`);
      }
      form.append('character', new Blob([await readFile(charPath)]), basename(charPath));
    }
    if (prop_id) {
      form.append('prop_id', prop_id);
    } else {
      const propPath = resolve(prop_path!);
      if (!SUPPORTED.includes(extname(propPath).toLowerCase())) {
        return err(`Unsupported format: ${propPath} — use ${SUPPORTED.join(' ')}`);
      }
      form.append('prop', new Blob([await readFile(propPath)]), basename(propPath));
    }
    if (character_path && prop_path && resolve(character_path) === resolve(prop_path)) {
      return err(
        'character_path and prop_path point to the same file. Export the weapon as its own GLB ' +
          '(Blender: select the weapon only, File > Export > glTF, check "Selected Objects") and pass that as prop_path.',
      );
    }
    if (style) form.append('style', style);
    if (hand) form.append('hand', hand);
    if (height_ratio != null) form.append('ratio', String(height_ratio));
    if (fist != null) form.append('fist', String(fist));
    if (grip_offset) form.append('grip_offset', grip_offset.join(','));
    if (ai_refine) form.append('refine', 'ai');
    if (export_glb) form.append('export', 'glb');
    form.append('fingers', '1');

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/attach`, {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'x-gripforge-client': 'mcp',
          'user-agent': 'gripforge-mcp/0.1.5',
        },
        body: form,
      });
    } catch {
      return err(`GripForge API unreachable at ${API_URL} — check GRIPFORGE_API_URL.`);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) return err('Invalid GRIPFORGE_API_KEY — check it on ' + API_URL + '/account#api');
    if (res.status === 403) {
      return err(
        `MCP access requires a paid plan (indie or studio); the free plan covers the Studio only. Upgrade at ${API_URL}/#pricing`,
      );
    }
    if (res.status === 402) {
      const u = data as { used?: number; limit?: number; plan?: string };
      return err(`Quota exceeded (${u.used}/${u.limit}, plan ${u.plan}) — upgrade at ${API_URL}/#pricing`);
    }
    if (!res.ok) return err(`Attach failed (${res.status}): ${String(data.error ?? 'unknown error')}`);

    const exportsObj = (data.exports ?? {}) as Record<string, string>;
    let wrote: string | null = null;
    let glbFile: string | null = null;
    let glbNotes: string[] = [];
    if (out_dir) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'bind.json'), exportsObj.json ?? JSON.stringify(data.bind, null, 2));
      if (exportsObj.three) await writeFile(join(dir, 'three.js.txt'), exportsObj.three);
      if (exportsObj.unity) await writeFile(join(dir, 'unity.cs.txt'), exportsObj.unity);
      if (exportsObj.godot) await writeFile(join(dir, 'godot.gd.txt'), exportsObj.godot);
      const glb = data.glb as { filename?: string; base64?: string; notes?: string[] } | undefined;
      if (glb?.base64) {
        glbFile = join(dir, glb.filename ?? 'attached.glb');
        await writeFile(glbFile, Buffer.from(glb.base64, 'base64'));
      }
      if (glb?.notes?.length) glbNotes = glb.notes;
      wrote = dir;
    }

    const credits = data.credits as { remaining?: number; limit?: number; plan?: string } | null;
    const library = data.library as { id?: string; file_url?: string } | undefined;

    // Mitten rigs (no real finger bones): the fist is a mesh swap that cannot
    // travel in the bind JSON — steer the caller toward export_glb.
    const bind = data.bind as
      | { gripPose?: unknown[]; fingerRig?: { generated?: boolean; bones?: number } }
      | undefined;
    const isMitten =
      bind?.fingerRig?.generated === true || (bind?.fingerRig && (bind.fingerRig.bones ?? 0) === 0);
    const noPose = !bind?.gripPose || bind.gripPose.length === 0;
    const mittenHint =
      !glbFile && isMitten && noPose
        ? '\nNOTE: this rig has no real finger bones, so the closed fist exists only as a mesh swap ' +
          'and is NOT in the bind JSON — the hand will stay open in your engine. ' +
          'Re-run gripforge_attach with export_glb: true and an out_dir to get attached.glb ' +
          '(character with the fist closed + prop attached, textures preserved).'
        : '';

    return {
      content: [
        {
          type: 'text' as const,
          text:
            JSON.stringify(
              { bind: data.bind, confidence: data.confidence, exports: exportsObj, wrote, glbFile, library },
              null,
              2,
            ) +
            (credits ? `\ncredits: ${credits.remaining}/${credits.limit} remaining (${credits.plan})` : '') +
            (glbNotes.length ? `\nglb notes:\n- ${glbNotes.join('\n- ')}` : '') +
            mittenHint,
        },
      ],
    };
  },
);

server.tool(
  'getAttachmentFrame',
  'Skeleton attachment frame. Outward = R_Thigh−L_Thigh (right) or opposite (left). Up = Knee→Hip / Ankle→Knee. No Euler.',
  {
    character_path: z.string().describe('Absolute path to the rigged character'),
    bodyPart: z.enum(['right_thigh', 'left_thigh', 'right_shin', 'left_shin']),
  },
  async ({ character_path, bodyPart }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const form = new FormData();
    form.append('character', new Blob([await readFile(resolve(character_path))]), basename(character_path));
    form.append('bodyPart', bodyPart);
    const res = await fetch(`${API_URL}/api/v1/attachment-frame`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'x-gripforge-client': 'mcp' },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'getWearableFrame',
  'Analyze a wearable once: up, bodyFacing, outward, anchor. Never rotate X = 180°.',
  {
    asset_path: z.string().describe('Absolute path to the armor piece'),
    type: z.enum(['thigh', 'greave']).optional(),
    side: z.enum(['left', 'right']).optional(),
  },
  async ({ asset_path, type, side }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const form = new FormData();
    form.append('asset', new Blob([await readFile(resolve(asset_path))]), basename(asset_path));
    if (type) form.append('type', type);
    if (side) form.append('side', side);
    const res = await fetch(`${API_URL}/api/v1/wearable-frame`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'x-gripforge-client': 'mcp' },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_formats',
  'List supported mesh formats, grip styles and hands.',
  {},
  async () => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            formats: SUPPORTED,
            styles: ['melee', 'gun', 'shield', 'staff'],
            hands: ['right', 'left'],
            api: API_URL,
            docs: API_URL + '/docs',
          },
          null,
          2,
        ),
      },
    ],
  }),
);

function apiHeaders(): Record<string, string> {
  return {
    'x-api-key': API_KEY ?? '',
    'x-gripforge-client': 'mcp',
    'user-agent': 'gripforge-mcp/0.1.5',
  };
}

const KIND = z.enum(['character', 'enemy', 'weapon', 'prop', 'texture', 'bind', 'vfx']);
const TEX_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

server.tool(
  'gripforge_texture_prep',
  'Prep a game texture (terrain / props): optional 50% wrap + seam blend, then a faithful ' +
    'lanczos upscale (1× / 2× / 4×, capped at 1024 or 2048). The pattern is PRESERVED — ' +
    'nothing is generated. Pass a local path or a Library texture_id. Writes the PNG into ' +
    'out_dir and returns the Library albedo URL. No credit consumed.',
  {
    path: z.string().optional().describe('Absolute path to a PNG/JPG/WebP'),
    texture_id: z.string().optional().describe('Library id of a texture (lib_…)'),
    seamless: z.boolean().optional().describe('50% offset + seam blend (default true)'),
    scale: z.union([z.literal(1), z.literal(2), z.literal(4)]).optional().describe('Upscale factor (default 1)'),
    size: z.union([z.literal(1024), z.literal(2048)]).optional().describe('Max output side (default 1024)'),
    name: z.string().optional().describe('Library / file name stem'),
    out_dir: z.string().optional().describe('Write the prepped PNG here (default: ./gripforge-library)'),
    save: z.boolean().optional().describe('Save to Library (default true)'),
  },
  async ({ path, texture_id, seamless, scale, size, name, out_dir, save }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    if (!path && !texture_id) return err('Provide path or texture_id.');
    const form = new FormData();
    if (path) {
      const abs = resolve(path);
      const ext = extname(abs).toLowerCase();
      if (!TEX_EXTS.includes(ext)) return err(`Unsupported image: ${abs} — use ${TEX_EXTS.join(' ')}`);
      form.append('file', new Blob([await readFile(abs)]), basename(abs));
    }
    if (texture_id) form.append('texture_id', texture_id);
    form.append('seamless', seamless === false ? '0' : '1');
    form.append('scale', String(scale ?? 1));
    form.append('size', String(size ?? 1024));
    form.append('save', save === false ? '0' : '1');
    if (name) form.append('name', name);

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/textures/prep`, {
        method: 'POST',
        headers: { ...apiHeaders() },
        body: form,
      });
    } catch {
      return err(`GripForge API unreachable at ${API_URL}`);
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      id?: string;
      library_id?: string | null;
      width?: number;
      height?: number;
      urls?: { albedo?: string };
    };
    if (!res.ok) return err(String(data.error ?? `texture_prep failed (${res.status})`));

    const dir = resolve(out_dir || join(process.cwd(), 'gripforge-library'));
    await mkdir(dir, { recursive: true });
    const wrote: string[] = [];
    if (data.urls?.albedo) {
      const fileRes = await fetch(data.urls.albedo);
      if (fileRes.ok) {
        const buf = Buffer.from(await fileRes.arrayBuffer());
        const stem = (name || (path ? basename(path).replace(/\.[^.]+$/, '') : data.id) || 'texture').replace(
          /[/\\]/g,
          '',
        );
        const dest = join(dir, `${stem}_prep.png`);
        await writeFile(dest, buf);
        wrote.push(dest);
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              id: data.id,
              library_id: data.library_id ?? null,
              file_url: data.urls?.albedo ?? null,
              width: data.width,
              height: data.height,
              wrote,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);


server.tool(
  'gripforge_style_kit',
  'Resolve "Devil May Cry like" / "genshin" to the locker kit already tagged with that game look (characters, enemies, weapons, props). Call this BEFORE generating. Reuse the returned ids.',
  { prompt: z.string().min(2).max(240).describe('e.g. "devil may cry like", "un ennemi genshin"') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams({ q: prompt, limit: '200' });
    // Hosted matcher lives on the API: pass style= the prompt; the server canonicalizes aliases.
    qs.set('style', prompt);
    const res = await fetch(`${API_URL}/api/v1/library?${qs}`, { headers: apiHeaders() });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      items?: Array<Record<string, unknown>>;
    };
    if (!res.ok) return err(String(data.error ?? res.status));
    const items = Array.isArray(data.items) ? data.items : [];
    const of = (k: string) =>
      items
        .filter((it) => it.kind === k)
        .map((it) => ({ id: it.id, kind: it.kind, name: it.name, file_url: it.file_url }));
    const out = {
      prompt,
      characters: of('character'),
      enemies: of('enemy'),
      weapons: of('weapon'),
      props: of('prop'),
      hint:
        items.length > 0
          ? 'Reuse these Library ids. Do not regenerate unless the user wants a NEW mesh.'
          : 'No locker assets for this look yet.',
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
  },
);

server.tool(
  'gripforge_generate_character',
  'CREATE a new game-ready mesh (T-pose, auto-rigged) and save it to Library. ' +
    'If the user wants an existing game look ("Devil May Cry like", "genshin"), call gripforge_style_kit FIRST and reuse those ids — do not regenerate. ' +
    'Put "enemy" / "ennemi" in the prompt (or kind=enemy) to save as kind=enemy, not character. Costs 10 credits; 2–8 minutes.',
  {
    prompt: z.string().min(3).max(600).describe('Description. "Devil May Cry like enemy" → tagged devil-may-cry, kind=enemy.'),
    provider: z.enum(['tripo', 'meshy']).optional().describe('Generation provider (default tripo)'),
    name: z.string().max(160).optional().describe('Library item name (default: the prompt)'),
    kind: z.enum(['character', 'enemy']).optional().describe('character (playable) or enemy (foe). Inferred from the prompt if omitted.'),
    out_dir: z.string().optional().describe('Write the generated GLB here (default: skip, Library URL only)'),
  },
  async ({ prompt, provider, name, kind, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/generate-character`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, provider, name, kind }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      item?: { id?: string; name?: string; kind?: string; file_url?: string | null; filename?: string | null };
      provider?: string;
      notes?: string[];
    };
    if (!res.ok) return err(String(data.error ?? `generate failed (${res.status})`));
    const wrote: string[] = [];
    if (out_dir && data.item?.file_url) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      const fileRes = await fetch(data.item.file_url);
      if (fileRes.ok) {
        const dest = join(dir, data.item.filename || `${data.item.id}.glb`);
        await writeFile(dest, Buffer.from(await fileRes.arrayBuffer()));
        wrote.push(dest);
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_concept_correct',
  'Turn a character concept image into a strict T-pose sheet (optional: remove flowing cape/train only — sleeved jacket stays; outfit or sport base). Saves PNG to Library. 1 credit.',
  {
    path: z.string().optional().describe('Absolute path to a local concept image'),
    file_url: z.string().optional().describe('https URL of the concept image'),
    clothes: z.enum(['outfit', 'base']).optional().describe('outfit = keep clothes; base = grey athletic sportswear'),
    cape: z.boolean().optional().describe('Remove flowing cape/train only; keep sleeved jacket (outfit only, default true)'),
    notes: z.string().optional().describe('Extra direction'),
    name: z.string().optional().describe('Library name'),
  },
  async ({ path, file_url, clothes, cape, notes, name }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    if (!path && !file_url) return err('Provide path or file_url.');
    const fd = new FormData();
    if (path) {
      const abs = resolve(path);
      fd.append('file', new Blob([await readFile(abs)]), basename(abs));
    } else if (file_url) {
      let parsed: URL;
      try {
        parsed = new URL(file_url);
      } catch {
        return err('file_url: invalid URL');
      }
      const got = await fetch(parsed, { signal: AbortSignal.timeout(60_000) });
      if (!got.ok) return err(`file_url: download failed (${got.status})`);
      fd.append('file', new Blob([await got.arrayBuffer()]), parsed.pathname.split('/').pop() || 'concept.jpg');
    }
    fd.append('clothes', clothes === 'base' ? 'base' : 'outfit');
    fd.append('cape', cape === false ? '0' : '1');
    if (notes) fd.append('notes', notes);
    if (name) fd.append('name', name);
    const res = await fetch(`${API_URL}/api/v1/concept-correct`, {
      method: 'POST',
      headers: apiHeaders(),
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_library_list',
  'List the GripForge Library locker (characters, enemies, weapons, props, textures, binds). Filter by kind and/or game style.',
  {
    kind: KIND.optional().describe('Filter by kind'),
    q: z.string().optional().describe('Search name/filename'),
    style: z.string().optional().describe('Game look (devil-may-cry, dmc, genshin)'),
  },
  async ({ kind, q, style }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams();
    if (kind) qs.set('kind', kind);
    if (q) qs.set('q', q);
    if (style) qs.set('style', style);
    const res = await fetch(`${API_URL}/api/v1/library?${qs}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_library_get',
  'Get one Library item (metadata + signed file URL).',
  { id: z.string().describe('Library id (lib_…)') },
  async ({ id }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/library/${encodeURIComponent(id)}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_library_push',
  'Upload a local file into the GripForge Library locker (character, weapon, prop, texture, or bind).',
  {
    path: z.string().describe('Absolute path of the file to upload'),
    kind: KIND.describe('Locker kind'),
    name: z.string().optional().describe('Display name (defaults to the filename stem)'),
  },
  async ({ path, kind, name }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const abs = resolve(path);
    const form = new FormData();
    form.append('file', new Blob([await readFile(abs)]), basename(abs));
    form.append('kind', kind);
    form.append('name', name || basename(abs).replace(/\.[^.]+$/, ''));
    const res = await fetch(`${API_URL}/api/v1/library`, {
      method: 'POST',
      headers: apiHeaders(),
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_library_pull',
  'Download a Library item into the open repo. This is the sync: writes bind.json and/or the mesh next to the working tree.',
  {
    id: z.string().describe('Library id (lib_…)'),
    out_dir: z
      .string()
      .optional()
      .describe('Folder to write into (default: ./gripforge-library in the current working directory)'),
  },
  async ({ id, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/library/${encodeURIComponent(id)}`, { headers: apiHeaders() });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      item?: {
        id: string;
        kind: string;
        name: string;
        filename: string | null;
        file_url: string | null;
        thumb_url?: string | null;
        json_url?: string | null;
        meta?: { bind?: unknown; has_glb?: boolean };
      };
    };
    if (!res.ok || !data.item) return err(String(data.error ?? res.status));
    const dir = resolve(out_dir || join(process.cwd(), 'gripforge-library'));
    await mkdir(dir, { recursive: true });
    const wrote: string[] = [];
    const item = data.item;
    if (item.kind === 'bind' && item.meta?.bind) {
      const bindPath = join(dir, `${item.id}-bind.json`);
      await writeFile(bindPath, JSON.stringify(item.meta.bind, null, 2));
      wrote.push(bindPath);
    }
    if (item.file_url) {
      const fileRes = await fetch(item.file_url);
      if (!fileRes.ok) return err(`file download failed (${fileRes.status})`);
      const buf = Buffer.from(await fileRes.arrayBuffer());
      const isJsonBind = item.kind === 'bind' && (item.filename ?? '').endsWith('.json');
      if (!isJsonBind || !item.meta?.bind) {
        const fname = item.filename || `${item.id}.bin`;
        const dest = join(dir, `${item.id}-${fname}`);
        await writeFile(dest, buf);
        wrote.push(dest);
      }
    }
    if (item.kind === 'vfx') {
      for (const [url, fname] of [
        [item.json_url, `${item.id}.json`],
        [item.thumb_url, `${item.id}.png`],
      ] as const) {
        if (!url) continue;
        const extra = await fetch(url);
        if (!extra.ok) continue;
        const dest = join(dir, fname);
        await writeFile(dest, Buffer.from(await extra.arrayBuffer()));
        wrote.push(dest);
      }
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ id: item.id, kind: item.kind, name: item.name, wrote }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'gripforge_vfx',
  'ADMIN ONLY. Generate + export 3D slash/thrust/spin VFX on an existing Library bind, or a world-space fire meteor (head + trail + impact). Pass prompt to fill type/style/color/emitters. Additive PNG, vfx.json + snippets. Refused for non-admin keys.',
  {
    attach_id: z.string().optional().describe('Library bind id (lib_…). Not required for meteor.'),
    prompt: z.string().optional().describe('Natural-language VFX prompt. Fills type/style/color/emitters when omitted.'),
    type: z.enum(['slash', 'thrust', 'spin', 'meteor', 'beam', 'swing', 'claw', 'charge', 'shield']).optional().describe('Strike type (default slash)'),
    style: z.enum(['energy', 'metal', 'magic']).optional().describe('Look (default energy)'),
    look: z.enum(['toon', 'solid']).optional().describe('Beam look: toon lightning or solid filled kamehameha'),
    color: z.string().optional().describe('Hex color'),
    duration: z.number().optional().describe('Seconds (default 0.25)'),
    width: z.number().optional().describe('Ribbon width in metres'),
    out_dir: z.string().optional().describe('Write vfx.glb, additive.png, vfx.json here'),
  },
  async ({ attach_id, prompt, type, style, look, color, duration, width, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/vfx`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'x-gripforge-client': 'mcp', 'content-type': 'application/json' },
      body: JSON.stringify({
        attach_id,
        prompt,
        type,
        style,
        look,
        color,
        duration,
        width,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      id?: string;
      urls?: { glb?: string; textures?: { additive?: string }; json?: string };
      snippets?: { json?: string };
    };
    if (res.status === 403) return err('admin only — gripforge_vfx is not available on this key.');
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    if (out_dir) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      if (data.urls?.glb) {
        const bin = Buffer.from(await (await fetch(data.urls.glb)).arrayBuffer());
        await writeFile(join(dir, 'vfx.glb'), bin);
        wrote.push(join(dir, 'vfx.glb'));
      }
      if (data.urls?.textures?.additive) {
        const bin = Buffer.from(await (await fetch(data.urls.textures.additive)).arrayBuffer());
        await writeFile(join(dir, 'additive.png'), bin);
        wrote.push(join(dir, 'additive.png'));
      }
      if (data.snippets?.json) {
        await writeFile(join(dir, 'vfx.json'), data.snippets.json);
        wrote.push(join(dir, 'vfx.json'));
      }
      const snip = data.snippets as { three?: string; unity?: string; godot?: string } | undefined;
      if (snip?.three) {
        await writeFile(join(dir, 'three.js.txt'), snip.three);
        wrote.push(join(dir, 'three.js.txt'));
      }
      if (snip?.unity) {
        await writeFile(join(dir, 'unity.cs.txt'), snip.unity);
        wrote.push(join(dir, 'unity.cs.txt'));
      }
      if (snip?.godot) {
        await writeFile(join(dir, 'godot.gd.txt'), snip.godot);
        wrote.push(join(dir, 'godot.gd.txt'));
      }
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }],
    };
  },
);

server.tool(
  'gripforge_vfx_preview',
  'ADMIN ONLY. Evaluate the VFX timeline at time t (t=0 empty). No credits. Play/scrub pose.',
  {
    bind: z.record(z.string(), z.unknown()).describe('Attach bind.json object'),
    t: z.number().optional().describe('Seconds (default 0)'),
    type: z.enum(['slash', 'thrust', 'spin', 'meteor', 'beam', 'swing', 'claw', 'charge', 'shield']).optional(),
    duration: z.number().optional(),
  },
  async ({ bind, t, type, duration }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/vfx/preview`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'x-gripforge-client': 'mcp', 'content-type': 'application/json' },
      body: JSON.stringify({ bind, t: t ?? 0, type, duration }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (res.status === 403) return err('admin only — gripforge_vfx_preview is not available on this key.');
    if (!res.ok) return err(String(data.error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_shaders',
  'List shaders from the GripForge catalog (authorized GodotShaders.com mirror). ' +
    'Returns { id, name, engines }. Search q=slash_reveal (alias) or a name. ' +
    'Then pull with gripforge_shader_pull. Listing is free.',
  {
    q: z.string().optional().describe('Search id/name/alias (e.g. slash_reveal)'),
    type: z
      .enum(['canvas_item', 'spatial', 'sky', 'particles', 'fog'])
      .optional()
      .describe('Godot shader_type filter'),
    limit: z.number().optional().describe('Page size (default 50, max 200)'),
    offset: z.number().optional().describe('Offset (default 0)'),
  },
  async ({ q, type, limit, offset }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (type) qs.set('type', type);
    if (limit != null) qs.set('limit', String(limit));
    if (offset != null) qs.set('offset', String(offset));
    const res = await fetch(`${API_URL}/api/v1/shaders?${qs}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_shader_pull',
  'Pull a catalog shader into the open repo and return an assignment snippet. ' +
    'id = slug or alias (slash_reveal). engine = godot | unity | three. ' +
    'Writes sources into out_dir. Godot → ShaderMaterial (SpatialMaterial/StandardMaterial3D cannot run custom code). ' +
    'Unity → ShaderLab Material. Three → ShaderMaterial. Example: "put slash_reveal Godot on my arc". ' +
    'v1 pull is free (no credit).',
  {
    id: z.string().describe('Shader id or alias (slash_reveal, circular_cresent_slash_2d_mask, …)'),
    engine: z.enum(['godot', 'unity', 'three']).describe('Target engine'),
    out_dir: z.string().describe('Folder to write shader files into (repo path)'),
  },
  async ({ id, engine, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/shaders/pull`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ id, engine, out_dir }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      id?: string;
      name?: string;
      engine?: string;
      files?: Array<{ path?: string; relative?: string; content?: string }>;
      snippet?: string;
      snippets?: Record<string, string>;
      credit?: number;
      note?: string;
      warnings?: string[];
    };
    if (!res.ok) return err(String(data.error ?? res.status));
    const dir = resolve(out_dir);
    await mkdir(dir, { recursive: true });
    const wrote: string[] = [];
    for (const f of data.files ?? []) {
      const rel = (f.relative || f.path || '').replace(/^.*[/\\]/, '');
      if (!rel || typeof f.content !== 'string') continue;
      const dest = join(dir, rel);
      await writeFile(dest, f.content);
      wrote.push(dest);
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              id: data.id,
              name: data.name,
              engine: data.engine,
              credit: 0,
              note: data.note,
              wrote,
              snippet: data.snippet,
              warnings: data.warnings ?? [],
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
