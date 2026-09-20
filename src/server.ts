#!/usr/bin/env node
/**
 * GripForge MCP — thin client.
 *
 * Exposes gripforge_attach to any MCP client (Cursor, Windsurf, Grok…) and
 * delegates the compute to the hosted GripForge API. Requires an API key:
 * create one at https://gripforge.ai/login and set GRIPFORGE_API_KEY in the
 * server env. 1 credit = 1 successful attach.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerVfxProjectTools, type VfxProjectRegister } from './vfx-project-tools.js';
import { registerSceneTools } from './scene-tools.js';
import { registerServerTools } from './server-tools.js';
import { registerGameKitTools } from './gamekit-tools.js';
import { registerGameKitLocalTools } from './gamekit-deliver-local.js';

const API_URL = process.env.GRIPFORGE_API_URL ?? 'https://gripforge.ai';
const API_KEY = process.env.GRIPFORGE_API_KEY;
const MCP_SELF = '0.1.9';

const SUPPORTED = ['.glb', '.gltf', '.fbx', '.obj'];

const server = new McpServer({ name: 'gripforge', version: MCP_SELF });
registerVfxProjectTools((server as unknown as { registerTool: VfxProjectRegister }).registerTool.bind(server), { apiUrl: API_URL, getApiKey: () => API_KEY });
registerSceneTools((server as unknown as { registerTool: VfxProjectRegister }).registerTool.bind(server), { apiUrl: API_URL, getApiKey: () => API_KEY });
registerServerTools((server as unknown as { registerTool: VfxProjectRegister }).registerTool.bind(server), { apiUrl: API_URL, getApiKey: () => API_KEY });
registerGameKitTools((server as unknown as { registerTool: VfxProjectRegister }).registerTool.bind(server), { apiUrl: API_URL, getApiKey: () => API_KEY });
registerGameKitLocalTools((server as unknown as { registerTool: VfxProjectRegister }).registerTool.bind(server), { apiUrl: API_URL, getApiKey: () => API_KEY, userAgent: `gripforge-mcp/${MCP_SELF}` });

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
    attach_id: z.string().optional().describe('Library bind id — use the armed GLB as the character'),
    prop_id: z.string().optional().describe('Library id of a prop (lib_…)'),
    prop_id_2: z.string().optional().describe('Second held item (off-hand), attached after the first'),
    prop_path_2: z.string().optional().describe('Local path of a second held item (off-hand)'),
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
  async ({ character_path, prop_path, character_id, attach_id, prop_id, prop_id_2, prop_path_2, style, hand, height_ratio, fist, grip_offset, ai_refine, export_glb, out_dir }) => {
    if (!API_KEY) {
      return err(
        'GRIPFORGE_API_KEY missing. Create a free account at ' +
          API_URL +
          '/login then set the key in this MCP server env:\n' +
          '"env": { "GRIPFORGE_API_KEY": "gf_..." }',
      );
    }
    if (!character_id && !character_path && !attach_id) return err('Provide character_path, character_id or attach_id.');
    if (!prop_id && !prop_path) return err('Provide prop_path or prop_id.');
    if (export_glb && !out_dir) {
      return err('export_glb needs out_dir — that is where attached.glb will be written.');
    }

    const form = new FormData();
    if (attach_id) {
      form.append('attach_id', attach_id);
    } else if (character_id) {
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
    if (export_glb || prop_id_2 || prop_path_2) form.append('export', 'glb');
    form.append('fingers', '1');

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/attach`, {
        method: 'POST',
        headers: apiHeaders(),
        body: form,
      });
    } catch {
      return err(`GripForge API unreachable at ${API_URL} — check GRIPFORGE_API_URL.`);
    }

    let data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) return err('Invalid GRIPFORGE_API_KEY — check it on ' + API_URL + '/account#api');
    if (res.status === 403) {
      return err(
        `MCP access needs a credit pack after the 3 free API/MCP trial attaches. Buy at ${API_URL}/pricing`,
      );
    }
    if (res.status === 402) {
      const u = data as { used?: number; limit?: number; plan?: string };
      return err(`Quota exceeded (${u.used}/${u.limit}, plan ${u.plan}) — buy credits at ${API_URL}/pricing`);
    }
    if (!res.ok) return err(`Attach failed (${res.status}): ${String(data.error ?? 'unknown error')}`);
    if (prop_id_2 || prop_path_2) {
      const first = data.library as { id?: string } | undefined;
      if (!first?.id) return err('first attach did not save a Library bind — cannot attach second prop');
      const form2 = new FormData();
      form2.append('attach_id', first.id);
      if (prop_id_2) form2.append('prop_id', prop_id_2);
      else {
        const p2 = resolve(prop_path_2!);
        form2.append('prop', new Blob([await readFile(p2)]), basename(p2));
      }
      form2.append('export', 'glb');
      form2.append('fingers', '1');
      form2.append('hand', hand === 'left' ? 'right' : 'left');
      const res2 = await fetch(`${API_URL}/api/v1/attach`, {
        method: 'POST',
        headers: apiHeaders(),
        body: form2,
      });
      const data2 = (await res2.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res2.ok) return err(`second attach failed (${res2.status}): ${String(data2.error ?? 'unknown error')}`);
      data = { ...data2, first_attach: first.id };
    }

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

    const upgrade =
      typeof data.mcp_upgrade === 'string'
        ? data.mcp_upgrade
        : typeof (exportsObj as { mcp_upgrade?: string }).mcp_upgrade === 'string'
          ? (exportsObj as { mcp_upgrade: string }).mcp_upgrade
          : '';

    return {
      content: [
        {
          type: 'text' as const,
          text:
            (upgrade ? upgrade + '\n\n' : '') +
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
  'List supported mesh formats, grip styles and hands. Also reports this MCP client version vs latest.',
  {},
  async () => {
    let latest: string | null = null;
    let hosted: string | null = null;
    let outdated = false;
    let mcp_upgrade: string | null = null;
    try {
      const res = await fetch(`${API_URL}/api/v1/mcp`, { headers: apiHeaders() });
      const cat = (await res.json().catch(() => ({}))) as {
        latest?: string;
        hosted?: string;
        tools?: string[];
      };
      if (res.ok && typeof cat.latest === 'string') {
        latest = cat.latest;
        hosted = typeof cat.hosted === 'string' ? cat.hosted : null;
        const [a, b, c] = MCP_SELF.split('.').map((n) => parseInt(n, 10) || 0);
        const [x, y, z] = latest.split('.').map((n) => parseInt(n, 10) || 0);
        outdated = a < x || (a === x && (b < y || (b === y && c < z)));
        if (outdated) {
          mcp_upgrade =
            `GripForge MCP npm ${MCP_SELF} is outdated (latest ${latest}). ` +
            `Upgrade: npx -y @gripforgeai/mcp@${latest} then restart your MCP client. ` +
            `Or hosted: ${hosted ?? 'https://gripforge.ai/mcp'}`;
        }
      }
    } catch {
      /* offline — still return formats */
    }
    return {
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
              mcp: { client: MCP_SELF, latest: latest ?? MCP_SELF, outdated, npm: '@gripforgeai/mcp' },
              ...(mcp_upgrade ? { mcp_upgrade } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

function apiHeaders(): Record<string, string> {
  return {
    'x-api-key': API_KEY ?? '',
    'x-gripforge-client': 'mcp',
    'user-agent': `gripforge-mcp/${MCP_SELF}`,
  };
}

function safeName(name: string): string {
  const base = basename(name.split('?')[0] ?? name);
  return base.replace(/[^a-zA-Z0-9._-]+/g, '_') || 'file';
}

function absUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

async function downloadTo(url: string, dest: string): Promise<boolean> {
  const res = await fetch(absUrl(url), { headers: apiHeaders(), signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return false;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

const KIND = z.enum(['character', 'fps-arms', 'enemy', 'weapon', 'prop', 'texture', 'skybox', 'loading', 'hud', 'button', 'bind', 'vfx', 'animation', 'audio']);
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
    const qs = new URLSearchParams({ limit: '200' }) // style= does the matching; q= would also require the prompt in the NAME and empty the kit;
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
      textures: of('texture'),
      skyboxes: of('skybox'),
      loading: of('loading'),
      huds: [...of('hud'), ...of('button')],
      buttons: of('button'),
      binds: of('bind'),
      vfx: of('vfx'),
      animations: of('animation'),
      hint:
        items.length > 0
          ? of('weapon').length
            ? 'Reuse these Library ids. Do not regenerate unless the user wants a NEW mesh.'
            : '0 weapons — grip style is melee/gun on meta.style. Tag swords with gripforge_library_tag(id, style) (writes the look into tags, does not overwrite the grip).'
          : 'No locker assets for this look yet.',
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
  },
);

server.tool(
  'gripforge_generate_character',
  'CREATE a Mixamo T-pose auto-rigged character or enemy and save it to Library. ' +
    'To sculpt from a picture (image-to-3D, Meshy): pass concept_item (lib_… from gripforge_concept_correct / character_concepts), or path / file_url of a T-pose or concept PNG. ' +
    'Without an image, this is text-to-3D only. ' +
    'If the look may already be in the locker, call gripforge_style_kit FIRST. ' +
    'For knives/guns use gripforge_generate_weapon. Costs 10 credits. Returns job_id immediately; poll gripforge_generation_read. Closing this call does not cancel it.',
  {
    prompt: z.string().min(3).max(600).describe('Description. "Devil May Cry like enemy" → tagged devil-may-cry, kind=enemy.'),
    provider: z.enum(['tripo', 'meshy']).optional().describe('Default tripo. Forced meshy when concept_item / path / file_url is set.'),
    name: z.string().max(160).optional().describe('Library item name (default: the prompt)'),
    kind: z.enum(['character', 'enemy', 'boss']).optional().describe('character | enemy | boss (boss → enemy + meta.boss)'),
    polycount: z.number().optional().describe('Target triangles. Meshy characters default 8000.'),
    underwear: z.boolean().optional().describe('false = keep the described outfit. Implied false when an image is passed.'),
    concept_item: z.string().optional().describe('Library concept / T-pose sheet id (lib_…). Image-to-3D from that picture — not text-to-3D.'),
    path: z.string().optional().describe('Absolute path to a local concept or T-pose image (PNG/JPG/WebP). Image-to-3D.'),
    file_url: z.string().optional().describe('https URL of a concept or T-pose image. Image-to-3D.'),
    out_dir: z.string().optional().describe('After the job completes, gripforge_library_pull into this folder.'),
  },
  async ({ prompt, provider, name, kind, polycount, underwear, concept_item, path, file_url, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    let image_base64: string | undefined;
    if (path) {
      const abs = resolve(path);
      const buf = await readFile(abs);
      image_base64 = buf.toString('base64');
    } else if (file_url) {
      let parsed: URL;
      try {
        parsed = new URL(file_url);
      } catch {
        return err('file_url: invalid URL');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return err('file_url: http(s) only');
      const got = await fetch(parsed, { signal: AbortSignal.timeout(60_000) });
      if (!got.ok) return err(`file_url: download failed (${got.status})`);
      image_base64 = Buffer.from(await got.arrayBuffer()).toString('base64');
    }
    const res = await fetch(`${API_URL}/api/v1/generate-character`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        provider: image_base64 || concept_item ? 'meshy' : provider,
        name,
        kind,
        polycount,
        underwear: image_base64 || concept_item ? false : underwear,
        concept_item,
        image_base64,
      }),
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
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote, ...(out_dir && !wrote.length ? { next: 'Poll gripforge_generation_read, then gripforge_library_pull with the completed asset id and this out_dir.', requested_out_dir: out_dir } : {}) }, null, 2) }] };
  },
);

server.tool(
  'gripforge_generate_weapon',
  'CREATE a game-ready weapon GLB (knife, gun, sword) and save it to Library as kind=weapon. ' +
    'Default Meshy, no T-pose, no rig. polycount default 4000. style=melee|gun for attach. 10 credits. ' +
    'Do NOT write one-off Meshy scripts.',
  {
    prompt: z.string().min(3).max(600).describe('e.g. CS2 default CT combat knife, silver blade, black grip'),
    name: z.string().max(160).optional(),
    polycount: z.number().optional().describe('Target triangles (default 4000)'),
    style: z.enum(['melee', 'gun', 'shield', 'staff']).optional().describe('Grip style for attach (inferred if omitted)'),
    provider: z.enum(['meshy', 'tripo']).optional().describe('Default meshy'),
    out_dir: z.string().optional().describe('After the durable job completes, use gripforge_library_pull with this out_dir.'),
  },
  async ({ prompt, name, polycount, style, provider, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/generate-character`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        name,
        kind: 'weapon',
        polycount: polycount ?? 4000,
        style,
        provider: provider ?? 'meshy',
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      item?: { id?: string; name?: string; kind?: string; file_url?: string | null; filename?: string | null };
      provider?: string;
      notes?: string[];
    };
    if (!res.ok) return err(String(data.error ?? `generate weapon failed (${res.status})`));
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
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote, ...(out_dir && !wrote.length ? { next: 'Poll gripforge_generation_read, then gripforge_library_pull with the completed asset id and this out_dir.', requested_out_dir: out_dir } : {}) }, null, 2) }] };
  },
);

server.tool(
  'gripforge_generate_prop',
  'CREATE a game-ready prop GLB (kart, crate, banana, barrier…) and save it to Library as kind=prop. Default Meshy, no T-pose, no rig. polycount default 4000. 10 credits. Returns a durable job_id; poll gripforge_generation_read.',
  {
    prompt: z.string().min(3).max(600).describe('e.g. compact orange open-cockpit racing kart, isolated'),
    name: z.string().max(160).optional(),
    polycount: z.number().optional().describe('Target triangles (default 4000)'),
    provider: z.enum(['meshy', 'tripo']).optional().describe('Default meshy'),
    out_dir: z.string().optional().describe('After the durable job completes, use gripforge_library_pull with this out_dir.'),
  },
  async ({ prompt, name, polycount, provider, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/generate-character`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        name,
        kind: 'prop',
        polycount: polycount ?? 4000,
        provider: provider ?? 'meshy',
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      item?: { id?: string; name?: string; kind?: string; file_url?: string | null; filename?: string | null };
      provider?: string;
      notes?: string[];
    };
    if (!res.ok) return err(String(data.error ?? `generate prop failed (${res.status})`));
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
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote, ...(out_dir && !wrote.length ? { next: 'Poll gripforge_generation_read, then gripforge_library_pull with the completed asset id and this out_dir.', requested_out_dir: out_dir } : {}) }, null, 2) }] };
  },
);

server.tool(
  'gripforge_boss',
  'Create a playable boss: stats, phases, attacks bound to anim-pack slots, arena, engine snippets. ' +
    'Kit is 0 credits. Reuses a locker enemy when one exists. Pass character_id to bind a Library mesh. ' +
    'Pass generate=true to forge a NEW kind=enemy mesh (10 credits, 2–8 min) — only if the locker is empty. ' +
    'Then gripforge_animate(archetype) + gripforge_hitbox. Name stays text.',
  {
    prompt: z.string().min(2).max(240).describe('e.g. "devil may cry like phantom boss"'),
    role: z.enum(['mini', 'mid', 'final']).optional().describe('mini | mid | final (inferred from the prompt)'),
    character_id: z.string().optional().describe('lib_… character/enemy/bind to bind — 0 credits'),
    generate: z.boolean().optional().describe('Forge a new enemy mesh (10 credits)'),
    name: z.string().max(80).optional().describe('Boss display name'),
    provider: z.enum(['tripo', 'meshy']).optional().describe('Only used when generate=true (default tripo)'),
    out_dir: z.string().optional().describe('Write boss.json + engine snippets (+ GLB if generated) here'),
  },
  async ({ prompt, role, character_id, generate, name, provider, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    let data: Record<string, unknown>;
    if (generate || character_id) {
      const res = await fetch(`${API_URL}/api/v1/boss`, {
        method: 'POST',
        headers: { ...apiHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, role, character_id, generate, name, provider }),
      });
      data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    } else {
      const qs = new URLSearchParams({ prompt });
      if (role) qs.set('role', role);
      if (name) qs.set('name', name);
      const res = await fetch(`${API_URL}/api/v1/boss?${qs}`, { headers: apiHeaders() });
      data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    }
    const wrote: string[] = [];
    if (out_dir) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      const json = typeof data.json === 'string' ? data.json : JSON.stringify(data, null, 2);
      await writeFile(join(dir, 'boss.json'), json);
      wrote.push(join(dir, 'boss.json'));
      const engines = data.engines as { three?: string; godot?: string; unity?: string; unreal?: string } | undefined;
      if (engines?.three) {
        await writeFile(join(dir, 'three.js.txt'), engines.three);
        wrote.push(join(dir, 'three.js.txt'));
      }
      if (engines?.godot) {
        await writeFile(join(dir, 'godot.gd.txt'), engines.godot);
        wrote.push(join(dir, 'godot.gd.txt'));
      }
      if (engines?.unity) {
        await writeFile(join(dir, 'unity.cs.txt'), engines.unity);
        wrote.push(join(dir, 'unity.cs.txt'));
      }
      if (engines?.unreal) {
        await writeFile(join(dir, 'unreal.cpp.txt'), engines.unreal);
        wrote.push(join(dir, 'unreal.cpp.txt'));
      }
      const fileUrl = typeof data.file_url === 'string' ? data.file_url : null;
      if (fileUrl) {
        const bin = Buffer.from(await (await fetch(fileUrl)).arrayBuffer());
        await writeFile(join(dir, 'boss.glb'), bin);
        wrote.push(join(dir, 'boss.glb'));
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_hud',
  'Survivor HUD kit: hud.json + cartoon PNGs + Godot .tscn + Three / Unity / Unreal snippets. ' +
    'Writes the folder (npm). 1 credit. Do not redraw the hearts.',
  {
    preset: z.literal('survivor').optional().describe('v1: survivor only (default)'),
    health_type: z.enum(['hearts', 'bar']).optional().describe('default hearts'),
    health_max: z.number().int().min(1).max(20).optional().describe('default 5'),
    health_style: z.string().optional().describe('hearts skin or bar skin, or custom:<slug> from gripforge_hud_bar'),
    currencies: z.array(z.string()).max(6).optional().describe('default ["gem","mushroom","drop"]'),
    minimap: z.boolean().optional().describe('default false'),
    portrait: z.boolean().optional().describe('default true'),
    out_dir: z.string().optional().describe('Write hud.json, PNGs, tscn, snippets (default ./gripforge-hud)'),
  },
  async ({ preset, health_type, health_max, health_style, currencies, minimap, portrait, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/hud`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({
        preset,
        health: { type: health_type, max: health_max, style: health_style },
        currencies,
        minimap,
        portrait,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      files?: Record<string, string>;
      assets?: Record<string, string>;
      unreal_plugin_url?: string;
    };
    if (!res.ok) return err(String(data.error ?? `hud failed (${res.status})`));
    const dir = resolve(out_dir || join(process.cwd(), 'gripforge-hud'));
    await mkdir(dir, { recursive: true });
    const wrote: string[] = [];
    for (const [name, body] of Object.entries(data.files ?? {})) {
      const dest = join(dir, safeName(name));
      await writeFile(dest, body);
      wrote.push(dest);
    }
    for (const url of Object.values(data.assets ?? {})) {
      const dest = join(dir, safeName(url));
      if (await downloadTo(url, dest)) wrote.push(dest);
    }
    if (data.unreal_plugin_url) {
      const dest = join(dir, 'GripForgeHUD-plugin.zip');
      if (await downloadTo(data.unreal_plugin_url, dest)) wrote.push(dest);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_hud_bar',
  'Forge an original themed health-bar frame+fill PNG pair (genre/materials, not a specific game). ' +
    'Writes the PNGs (npm). 2 credits.',
  {
    theme: z.string().min(3).max(300).describe('e.g. gothic demon-hunter, baroque metal'),
    colors: z
      .array(z.string().regex(/^#[0-9a-fA-F]{6}$/))
      .length(3)
      .optional()
      .describe('Fill gradient [light, mid, dark] hex'),
    name: z.string().max(60).optional().describe('Slug for Library items'),
    out_dir: z.string().optional().describe('Write frame + fill PNGs (default ./gripforge-hud)'),
  },
  async ({ theme, colors, name, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/hud/forge-bar`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ theme, colors, name }),
      signal: AbortSignal.timeout(280_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      frame_url?: string;
      fill_url?: string;
      hud_snippet?: Record<string, unknown>;
    };
    if (!res.ok) return err(String(data.error ?? `hud_bar failed (${res.status})`));
    const dir = resolve(out_dir || join(process.cwd(), 'gripforge-hud'));
    await mkdir(dir, { recursive: true });
    const wrote: string[] = [];
    const snippet = data.hud_snippet as { health?: { textures?: { frame?: string; fill?: string } } } | undefined;
    const frameName = safeName(snippet?.health?.textures?.frame || 'bar_frame.png');
    const fillName = safeName(snippet?.health?.textures?.fill || 'bar_fill.png');
    if (data.frame_url && (await downloadTo(data.frame_url, join(dir, frameName)))) wrote.push(join(dir, frameName));
    if (data.fill_url && (await downloadTo(data.fill_url, join(dir, fillName)))) wrote.push(join(dir, fillName));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_cape',
  'Cape rig: 3-column bone grid on neck/spine, skins the cape, bakes attached_cape.glb + Godot spring / Three verlet snippets. ' +
    'Writes the folder (npm). 1 credit. Inputs: Library ids or https URLs.',
  {
    character_id: z.string().optional().describe('Library id of a rigged character (lib_…)'),
    character_url: z.string().optional().describe('https URL of a rigged character GLB'),
    cape_id: z.string().optional().describe('Library id of the cape mesh (lib_…)'),
    cape_url: z.string().optional().describe('https URL of the cape GLB'),
    columns: z.number().int().min(2).max(5).optional().describe('Bone columns (default 3)'),
    rows: z.number().int().min(2).max(8).optional().describe('Rows below anchor (default 5)'),
    save: z.boolean().optional().describe('Save attached_cape.glb to Library (default true)'),
    out_dir: z.string().optional().describe('Write bind + scripts + GLB (default ./gripforge-cape)'),
  },
  async ({ character_id, character_url, cape_id, cape_url, columns, rows, save, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    if (!character_id && !character_url) return err('Provide character_id or character_url.');
    if (!cape_id && !cape_url) return err('Provide cape_id or cape_url.');
    const res = await fetch(`${API_URL}/api/v1/cape`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ character_id, character_url, cape_id, cape_url, columns, rows, save }),
      signal: AbortSignal.timeout(110_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      files?: Record<string, string>;
      library?: { file_url?: string } | null;
    };
    if (!res.ok) return err(String(data.error ?? `cape failed (${res.status})`));
    const dir = resolve(out_dir || join(process.cwd(), 'gripforge-cape'));
    await mkdir(dir, { recursive: true });
    const wrote: string[] = [];
    for (const [name, body] of Object.entries(data.files ?? {})) {
      const dest = join(dir, safeName(name));
      await writeFile(dest, body);
      wrote.push(dest);
    }
    const glbUrl = data.library?.file_url;
    if (glbUrl) {
      const dest = join(dir, 'attached_cape.glb');
      if (await downloadTo(glbUrl, dest)) wrote.push(dest);
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
  'List the GripForge Library locker (characters, enemies, weapons, props, textures, HUD, buttons, binds). Filter by kind and/or game style.',
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
  'Upload a local file into the GripForge Library locker (character, weapon, prop, texture, HUD, or bind).',
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
    const sidecars = (item as { sidecars?: { file: string; url: string }[] }).sidecars;
    if (Array.isArray(sidecars) && sidecars.length) {
      for (const sc of sidecars) {
        if (!sc?.url || !sc.file) continue;
        const extra = await fetch(sc.url);
        if (!extra.ok) continue;
        const dest = join(dir, sc.file === 'json' ? `${item.id}.json` : sc.file === 'png' ? `${item.id}.png` : `${item.id}.${sc.file}`);
        let bytes = Buffer.from(await extra.arrayBuffer());
        if (sc.file === 'json') {
          try {
            const text = bytes.toString('utf8').replace(/sidecar:(tex\d+|png|json)/g, `${item.id}.$1`);
            bytes = Buffer.from(text, 'utf8');
          } catch {
            /* keep original */
          }
        }
        await writeFile(dest, bytes);
        wrote.push(dest);
      }
    } else if (item.kind === 'vfx') {
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
  'gripforge_library_tag',
  'Add a game look to tags so style_kit can find the item. Does not overwrite grip style melee/gun.',
  {
    id: z.string().describe('Library id (lib_…)'),
    style: z.string().optional().describe('Game look id or alias (devil-may-cry, dmc)'),
    tags: z.array(z.string()).optional().describe('Replace tags. Omit to keep existing and just add style.'),
  },
  async ({ id, style, tags }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/library/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ style, tags }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_hand_rig',
  'Complete a rigged Library character with finger bones (3 phalanges × 5 fingers per hand, Mixamo names) built from its hand mesh — no provider rigs fingers, so without this a hand cannot close on a weapon and pistol/knife clips have nothing to drive. New characters get it automatically in gripforge_generate_character; use this on characters generated before. Updates the item in place. 0 credits. Then re-run gripforge_animate.',
  { character_id: z.string().describe('Library character / enemy / bind (lib_…)') },
  async ({ character_id }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/hand-rig`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ item: character_id }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return err(String(data.error ?? res.statusText));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_viewmodel_arms',
  'First-person arms cut out of a rigged + animated Library character (animation kit preferred): keeps the skeleton, the 23 clips and the materials, drops every triangle that is not skinned to the arm chains. The player then sees the same gloves/sleeves the others see on the body, and weapons attach on RightHand with the gripforge_attach binds. New Library item. 0 credits.',
  { item: z.string().describe('Library character or animation kit (lib_…)'), out_dir: z.string().optional().describe('write the GLB there (e.g. <godot>/assets/characters), named <team>_arms.glb when team is given'), team: z.string().optional().describe('file prefix, e.g. T or CT') },
  async ({ item, out_dir, team }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/viewmodel-arms`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify({ item }) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; item?: { file_url?: string; filename?: string } };
    if (!res.ok) return err(String(data.error ?? res.statusText));
    const wrote: string[] = [];
    if (out_dir && data.item?.file_url) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(out_dir, { recursive: true });
      const r = await fetch(data.item.file_url);
      if (r.ok) { const f = path.join(out_dir, team ? `${team}_arms.glb` : (data.item.filename ?? 'arms.glb')); await fs.writeFile(f, Buffer.from(await r.arrayBuffer())); wrote.push(f); }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_hand_check',
  'Verify that a rigged character\'s fingers fold cleanly — per hand and per clip: skin-weight sanity, fingertip ownership, skin coherence (animated reach vs rest), bend angles, spike vertices. Run it after gripforge_hand_rig or gripforge_animate; ok=false comes with a problems list and what to re-run. The Character Studio shows the same clips visually (hand check panel). 0 credits.',
  { item: z.string().describe('Library character / enemy / bind / animation kit (lib_…)') },
  async ({ item }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/hand-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ item }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return err(String(data.error ?? res.statusText));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_animate',
  'Retarget the standard clip pack onto a Mixamo-named Library character/enemy/armed bind. Base slots (idle, walk, run, attack1-3, hit, death, dodge) + extras (taunt, stinger, knockback, block, jump_start/loop/land, idle_guns, shoot, reload, aim, crouch_idle, crouch_walk, knife). archetype remaps the base slots: sword (default), claws (zombie scratch), heavy (slow + heavy combo), brawler (punches), puppet (stiff walk + throws), operator (CS-style: knife/punch strikes). Opt-in slots fire_breath (mouth exhalation) and energy_cast (two-hand azure wave) use the Studio VFX character motions. Saves kind=animation. 0 credits.',
  {
    character_id: z.string().describe('Library character, enemy, or armed bind'),
    archetype: z.enum(['sword', 'claws', 'heavy', 'brawler', 'puppet', 'operator']).optional().describe('Movement/strike archetype — remaps the base slots (default sword); operator = CS-style (knife/punch strikes, guns via idle_guns/shoot/reload/aim, crouch_idle/crouch_walk)'),
    slots: z
      .array(z.enum(['idle', 'walk', 'run', 'attack1', 'attack2', 'attack3', 'hit', 'death', 'dodge', 'taunt', 'stinger', 'knockback', 'block', 'jump_start', 'jump_loop', 'jump_land', 'idle_guns', 'shoot', 'fire_breath', 'energy_cast', 'reload', 'aim', 'crouch_idle', 'crouch_walk', 'knife']))
      .optional(),
    name: z.string().optional(),
    out_dir: z.string().optional().describe('Also write the animated GLB here'),
  },
  async ({ character_id, archetype, slots, name, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/animate-pack`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ character_id, archetype, slots, name }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      item?: { id?: string; file_url?: string; filename?: string | null };
      clips?: unknown;
    };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    if (out_dir && data.item?.file_url) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      const bin = Buffer.from(await (await fetch(data.item.file_url)).arrayBuffer());
      const dest = join(dir, data.item.filename || `${data.item.id}.glb`);
      await writeFile(dest, bin);
      wrote.push(dest);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_audio_kit',
  'Search locker + Community SFX by description/tags (gunshot, ui, magie, pas, dinosaure…). Hits include description + use[]. Community: clone then pull. out_dir downloads matched files. Free to search.',
  {
    prompt: z.string().optional().describe('What you need, e.g. "gunshot", "ui click", "dinosaur roar" (omit for a short catalog)'),
    out_dir: z.string().optional().describe('Download matched audio files here'),
  },
  async ({ prompt, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const wanted = (prompt ?? '').toLowerCase().trim();
    const qTokens = wanted.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
    type AudioHit = {
      id: string;
      name: string;
      kind?: string;
      filename?: string | null;
      file_url?: string | null;
      fileUrl?: string | null;
      meta?: Record<string, unknown>;
    };
    const blobOf = (it: AudioHit) => {
      const m = it.meta ?? {};
      const tags = Array.isArray(m.tags) ? (m.tags as unknown[]).join(' ') : '';
      const use = Array.isArray(m.use) ? (m.use as unknown[]).join(' ') : '';
      return `${it.name} ${it.filename ?? ''} ${m.description ?? ''} ${m.search ?? ''} ${m.pack ?? ''} ${tags} ${use}`.toLowerCase();
    };
    const match = (it: AudioHit) => {
      if (!qTokens.length) return true;
      const hay = blobOf(it).split(/[^a-z0-9]+/).filter(Boolean);
      return qTokens.every((w) => hay.some((h) => h === w || (w.length >= 4 && h.startsWith(w))));
    };
    const lite = (it: AudioHit, source: 'locker' | 'community') => {
      const m = it.meta ?? {};
      return {
        id: it.id,
        name: it.name,
        filename: it.filename ?? null,
        description: typeof m.description === 'string' ? m.description : null,
        use: Array.isArray(m.use) ? m.use : [],
        pack: typeof m.pack === 'string' ? m.pack : null,
        file_url: it.file_url ?? it.fileUrl ?? null,
        source,
      };
    };
    const [lockRes, commRes] = await Promise.all([
      fetch(`${API_URL}/api/v1/library?kind=audio&limit=500`, { headers: apiHeaders() }),
      fetch(`${API_URL}/api/v1/community`),
    ]);
    const lockData = (await lockRes.json().catch(() => ({}))) as { items?: AudioHit[] };
    const commData = (await commRes.json().catch(() => ({}))) as { items?: AudioHit[] };
    if (!lockRes.ok) return err('library list failed');
    const locker = (lockData.items ?? []).filter(match);
    const have = new Set(locker.map((it) => it.id));
    const community = (commData.items ?? []).filter((it) => it.kind === 'audio' && !have.has(it.id) && match(it));
    const all = [...locker.map((it) => lite(it, 'locker')), ...community.map((it) => lite(it, 'community'))];
    const hits = all.filter((i) => !/^(sfx|music)[_-]/i.test(i.name)).slice(0, wanted ? 40 : 24);
    const out = {
      query: wanted || null,
      total: all.length,
      sfx: all.filter((i) => /^sfx[_-]/i.test(i.name)),
      music: all.filter((i) => /^music[_-]/i.test(i.name)),
      hits,
      wrote: [] as string[],
      hint: wanted
        ? 'Pick by description/use. Locker ids: gripforge_library_pull. Community ids: clone first (1 credit), then pull.'
        : 'Pass prompt to filter. Descriptions are on each hit.',
    };
    if (out_dir) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      const download = [...out.sfx, ...out.music, ...out.hits];
      for (const it of download) {
        if (!it.file_url) continue;
        const bin = Buffer.from(await (await fetch(it.file_url)).arrayBuffer());
        const dest = join(dir, it.filename || `${it.name.replace(/[^\w.-]+/g, '_')}.wav`);
        await writeFile(dest, bin);
        out.wrote.push(dest);
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] };
  },
);

server.tool(
  'gripforge_aim',
  'Aim-offset poses for a Library character/armed bind (0 credits): for each hand, two-bone IK + wrist alignment so the WEAPON AXIS (gf_muzzle locator from gripforge_loadout, else the seat forward) points at every direction of a yaw×pitch grid. Returns bone-local quaternions per pose + rest, and a Three.js/Godot blend snippet. Works for dual wield (independent hands) and any Mixamo/UAL/Tripo rig. out_dir writes aim.json.',
  {
    attach_id: z.string().optional().describe('Armed bind / loadout id (lib_…) — preferred'),
    character_id: z.string().optional().describe('Character id if no bind'),
    hands: z.array(z.enum(['left', 'right'])).optional().describe('Default both'),
    yaws: z.array(z.number()).optional().describe('Default [-60,-30,0,30,60] (left positive)'),
    pitches: z.array(z.number()).optional().describe('Default [-40,-20,0,20,40] (up positive)'),
    extension: z.number().optional().describe('Arm extension 0.5–0.98 (default 0.9)'),
    out_dir: z.string().optional().describe('Write aim.json here'),
  },
  async ({ attach_id, character_id, hands, yaws, pitches, extension, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    if (!attach_id && !character_id) return err('attach_id or character_id required');
    const res = await fetch(`${API_URL}/api/v1/aim`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ attach_id, character_id, hands, yaws, pitches, extension }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    if (out_dir) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      const dest = join(dir, 'aim.json');
      await writeFile(dest, JSON.stringify(data, null, 2));
      wrote.push(dest);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_terrain_concepts',
  'Three concept pictures of a level (aerial three-quarter view, readable layout) BEFORE any 3D: pick one, then build the terrain from it in the Terrain Studio (the picture is read into a LevelIntent) or pass its id as concept_item. Each image is a Library concept item. 1 credit per image (default 3).',
  { prompt: z.string().min(3).max(600).describe('the level, e.g. "snowy ARPG zone, castle north, dense forests, frozen lake"'), n: z.number().min(1).max(4).optional().describe('default 3') },
  async ({ prompt, n }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/terrain-concepts`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify({ prompt, n: n ?? 3 }) });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return err(String(data.error ?? res.statusText));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_character_concepts',
  'Three LOOK pictures (3/4, Imagine low 1K) of a named character, enemy or boss BEFORE any 3D. Pass weapon to show it on the looks; 3D later is T-pose empty hands. Pick one, then gripforge_generate_character with concept_item. 1 credit per image (default 3).',
  {
    name: z.string().min(2).max(80).describe('Creation name, stored on each concept'),
    prompt: z.string().min(3).max(600).describe('Look, outfit, silhouette'),
    kind: z.enum(['character', 'enemy', 'boss']).optional().describe('Default character'),
    weapon: z.string().max(160).optional().describe('Shown on the looks only; empty hands if omitted'),
    n: z.number().min(1).max(4).optional().describe('Default 3'),
  },
  async ({ name, prompt, kind, weapon, n }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/character-concepts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: JSON.stringify({ name, prompt, kind, weapon, n: n ?? 3 }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return err(String(data.error ?? res.statusText));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_level',
  'Plan a playable level from a prompt (0 credits): rooms placed in metres (entrance, combat rooms, junctions, key/lock, boss antechamber + boss room, treasure, secret room), connections, critical path, shortcuts, and gameplay spawns (player/packs/boss/rewards). Same seed → same level. Pair with gripforge_scene_kit for dressing props and gripforge_style_kit for enemies.',
  {
    prompt: z.string().describe('e.g. "gothic castle dungeon, 3 combat rooms, one boss, exploration pacing"'),
    seed: z.number().optional(),
    combat_rooms: z.number().optional(),
    floors: z.number().optional(),
    optional_branches: z.number().optional(),
    out_dir: z.string().optional().describe('Write level.json here'),
  },
  async ({ prompt, seed, combat_rooms, floors, optional_branches, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/level`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, seed, combat_rooms, floors, optional_branches }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    if (out_dir) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      const dest = join(dir, 'level.json');
      await writeFile(dest, JSON.stringify(data, null, 2));
      wrote.push(dest);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_loadout',
  'Build a multi-weapon character in ONE call: attaches every prop of every set onto the same rig, ' +
    'names each prop node gf_prop_<slug>_<l|r>, stamps glTF extras { gripforge: { prop, set, hand } } and a ' +
    'scene manifest { default, sets }, then (by default) retargets the standard clip pack. ' +
    'The engine switches weapons by toggling node visibility — the returned Three.js snippet does it. ' +
    'Example sets: { "sword": [{"prop_id":"lib_sword"}], "guns": [{"prop_id":"lib_gun","hand":"left","style":"gun"}, {"prop_id":"lib_gun","hand":"right","style":"gun"}] }. ' +
    'Credits: one attach per prop.',
  {
    character_id: z.string().describe('Library character id (lib_…)'),
    sets: z
      .record(
        z.string(),
        z.array(
          z.object({
            prop_id: z.string(),
            hand: z.enum(['left', 'right']).optional(),
            style: z.enum(['melee', 'gun', 'shield', 'staff']).optional(),
          }),
        ),
      )
      .describe('set name → props to hold in that set'),
    default_set: z.string().optional().describe('Set visible by default (first set otherwise)'),
    archetype: z.enum(['sword', 'claws', 'heavy', 'brawler', 'puppet', 'operator']).optional().describe('Movement/strike archetype — remaps the base slots (default sword); operator = CS-style (knife/punch strikes, guns via idle_guns/shoot/reload/aim, crouch_idle/crouch_walk)'),
    name: z.string().optional(),
    animate: z.boolean().optional().describe('Also retarget the standard clip pack (default true)'),
    out_dir: z.string().optional().describe('Write the animated loadout GLB (or the bind GLB) + manifest.json here'),
  },
  async ({ character_id, sets, default_set, archetype, name, animate, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/loadout`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ character_id, sets, default: default_set, archetype, name, animate }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      item?: { id?: string; file_url?: string | null };
      animation?: { id?: string; file_url?: string | null; filename?: string | null } | null;
      manifest?: unknown;
    };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    if (out_dir) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      const best = data.animation?.file_url ? data.animation : data.item;
      if (best?.file_url) {
        const bin = Buffer.from(await (await fetch(best.file_url)).arrayBuffer());
        const dest = join(dir, 'loadout.glb');
        await writeFile(dest, bin);
        wrote.push(dest);
      }
      if (data.manifest) {
        const mf = join(dir, 'manifest.json');
        await writeFile(mf, JSON.stringify(data.manifest, null, 2));
        wrote.push(mf);
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_retarget',
  'Convert clips from skeleton A (source_id) onto skeleton B (target_id). Saves kind=animation.',
  {
    source_id: z.string(),
    target_id: z.string(),
    clip: z.string().optional(),
    name: z.string().optional(),
  },
  async ({ source_id, target_id, clip, name }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/retarget`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ source_id, target_id, clip, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_rest_pose',
  'Lower arms from T-pose until they would clip this mesh. Saves arms-down rest (clip idle). Armed binds keep weapons in the hands. 0 credits.',
  { character_id: z.string(), name: z.string().optional() },
  async ({ character_id, name }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/rest-pose`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ character_id, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_render',
  'Server PNG preview of a Library GLB so the agent can see pose/attach without a browser.',
  { id: z.string(), width: z.number().optional(), height: z.number().optional() },
  async ({ id, width, height }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/render`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ id, width, height }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return err(String((data as { error?: string }).error ?? res.status));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify({ id, bytes: buf.length, mime: 'image/png' }) },
        { type: 'image' as const, data: buf.toString('base64'), mimeType: 'image/png' },
      ],
    };
  },
);

server.tool(
  'gripforge_scene_kit',
  'Locker props for a game look plus a suggested layout (metres, Y-up). Call after style_kit. Empty slots → generate that dressing prop, tag it, retry.',
  { prompt: z.string().min(2).max(240).describe('e.g. devil may cry like') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/scene-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_hitbox',
  'Body capsules + weapons[] (one per gf_prop_ wrapper) from a Library character, armed bind or loadout. 0 credits.',
  {
    character_id: z.string().optional().describe('Library character/enemy id'),
    attach_id: z.string().optional().describe('Library armed bind id'),
    id: z.string().optional().describe('Library id of a loadout / bind / character'),
  },
  async ({ character_id, attach_id, id }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    if (!character_id && !attach_id && !id) return err('Provide character_id, attach_id or id.');
    const res = await fetch(`${API_URL}/api/v1/hitbox`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ character_id, attach_id, id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_vehicle_wheels',
  'Split the 4 wheels out of a fused kart/car GLB so they can spin: Wheel_FL/FR/RL/RR nodes, hub pivots, extras gf_wheel {radius, axle, spin}. Geometric cut (cylinder + plane, seam invariant under rotation, capped). Run gripforge_vehicle_orient first. 0 credits. apply=false → analysis only.',
  {
    id: z.string().describe('Library id of the vehicle GLB (lib_…)'),
    apply: z.boolean().optional().describe('default true — rewrite the Library file with the split wheels'),
  },
  async ({ id, apply }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/vehicle-wheels`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ id, apply }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);
server.tool(
  'gripforge_vehicle_orient',
  'Yaw so a kart/vehicle GLB nose is local +Z (Meshy often faces +X). Then heading = yawToward(tangent) = atan2(fx, fz). Pass Library id. 0 credits.',
  {
    id: z.string().optional().describe('Library id of the vehicle/kart GLB (lib_…)'),
    prop_id: z.string().optional().describe('Same as id'),
  },
  async ({ id, prop_id }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    if (!id && !prop_id) return err('Provide id or prop_id.');
    const res = await fetch(`${API_URL}/api/v1/vehicle-orient`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ id, prop_id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_plan',
  'FPS/bomb map. Interprets overhead as 3D compound (hollow rooms, corniche, A plat+pit, arches, vaulted tunnels, sidewalks). Preview https://gripforge.ai/map-plan?prompt=dust2. Pair gripforge_map_props + gripforge_map_wires. 0 credits. Dungeons: gripforge_level.',
  { prompt: z.string().min(2).max(240).describe('e.g. counter-strike dust2 bomb defusal'),
    item: z.string().optional().describe('lib_… traced plan from gripforge_map_concept (overrides the preset)'),
    windows: z.enum(['shuttered', 'barred', 'none']).optional().describe('Boundary windows: volets (default), grilles, ou aucune'),
    window_density: z.number().min(0).max(1).optional().describe('Share of boundary segments that get a window (default 0.25)'),
  },
  async ({ prompt, item, windows, window_density }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams({ prompt });
    if (item) qs.set('item', item);
    if (windows) qs.set('windows', windows);
    if (window_density != null) qs.set('window_density', String(window_density));
    const res = await fetch(`${API_URL}/api/v1/map-plan?${qs}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    const rec = data as { preview_url?: string };
    const preview = typeof rec.preview_url === 'string' ? `Preview: ${rec.preview_url}\n\n` : '';
    return { content: [{ type: 'text' as const, text: `${preview}${JSON.stringify(data, null, 2)}` }] };
  },
);

server.tool(
  'gripforge_map_concept',
  'AI-DRAW a map layout: gpt-image-2 generates a top-down plan schematic (white walls on black) + a 3/4 greybox concept render, auto-traces the plan into MapPlan wall boxes, saves both to the Library. Reuse via gripforge_map_plan { item } or https://gripforge.ai/map-plan?item=lib_…&greybox=1. Alternative to the code presets when the layout should come from an image.',
  {
    prompt: z.string().min(3).max(400).describe('e.g. "moroccan desert village bomb map, tight alleys, two plazas"'),
    extent_m: z.number().min(40).max(300).optional().describe('Playfield size in metres the image maps onto (default 110)'),
    threshold: z.number().min(30).max(240).optional().describe('Luminance above which a pixel is wall (default 145 — higher = thinner walls, wider streets)'),
    plan_item: z.string().optional().describe('Existing traced plan: re-render its concept image, or with retrace=true re-trace it'),
    retrace: z.boolean().optional().describe('With plan_item: re-trace the stored plan image with the new threshold/extent (no image regen)'),
    min_street_m: z.number().min(1.5).max(6).optional().describe('Guaranteed minimum street width in metres — narrower passages are carved wider (default 2.6)'),
    image_path: z.string().optional().describe('Trace THIS local image instead of generating one (hand-drawn plan, radar crop). White walls on black — or set invert for radar-style (bright walkable on dark)'),
    concept_path: z.string().optional().describe('With image_path: local concept/reference image stored alongside'),
    invert: z.boolean().optional().describe('image_path is radar-style: walkable is bright, everything dark becomes wall'),
    convert: z.boolean().optional().describe('image_path is an ILLUSTRATED/textured top view: gpt-image-2 converts it into the binary wall diagram first (the original becomes the concept image)'),
    views: z.number().min(0).max(4).optional().describe('Also generate N street-level KEY-ANGLE views (main lane, plaza, chokepoint, site doors) conditioned on the aerial concept — linked to the plan, shown in the studio CONCEPT tab'),
    out_dir: z.string().optional().describe('Also write plan.png + greybox.png here'),
  },
  async ({ prompt, extent_m, threshold, plan_item, retrace, min_street_m, image_path, concept_path, invert, convert, views, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    let image_b64: string | undefined;
    let concept_b64: string | undefined;
    if (image_path) {
      const { readFileSync } = await import('node:fs');
      image_b64 = readFileSync(image_path).toString('base64');
      if (concept_path) concept_b64 = readFileSync(concept_path).toString('base64');
    }
    const res = await fetch(`${API_URL}/api/v1/map-concept`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, extent_m, threshold, plan_item, retrace, min_street_m, image_b64, concept_b64, invert, convert, views }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      preview_url?: string;
      plan_item?: { file_url?: string };
      concept_item?: { file_url?: string };
    };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    if (out_dir) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      mkdirSync(out_dir, { recursive: true });
      for (const [name, url] of [['map-concept-plan.png', data.plan_item?.file_url], ['map-concept-greybox.png', data.concept_item?.file_url]] as const) {
        if (!url) continue;
        const bin = await fetch(url, { headers: apiHeaders() });
        if (bin.ok) { const fp = join(out_dir, name); writeFileSync(fp, Buffer.from(await bin.arrayBuffer())); wrote.push(fp); }
      }
    }
    const preview = typeof data.preview_url === 'string' ? `Preview: ${data.preview_url}\n\n` : '';
    return { content: [{ type: 'text' as const, text: `${preview}${JSON.stringify({ ...data, wrote }, null, 2)}` }] };
  },
);

server.tool(
  'gripforge_map_match',
  'stage=match — the reference-constrained loop: renders the greybox top-down orthographic (the concept camera), compares it to the stored reference diagram (IoU, missing/extra %, per-quadrant errors), and with iterate=true grid-searches the tracer parameters and PERSISTS the best-scoring plan (manual spawns kept). Chain: map_concept -> map_analyze -> map_match -> map_paths -> map_export.',
  {
    item: z.string().describe('lib_… traced plan item'),
    iterate: z.boolean().optional().describe('run the correction loop (12 tracer-parameter candidates) and persist the best plan'),
  },
  async ({ item, iterate }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/map-match`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ item, iterate }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_paths',
  'WALKABILITY report of a traced greybox: free-space grid, connected regions (sealed pockets), spawns validated/snapped onto the main region, T-to-CT path length + tightest corridor width + waypoints. Read it before shipping a map — spawns-in-walls and unreachable areas show up here.',
  { item: z.string().describe('lib_… traced plan item') },
  async ({ item }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/map-paths?${new URLSearchParams({ item })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_textures',
  'OUR texture pipeline (not a black-box retexture): generates 5 seamless tileable surfaces FROM the concept (4 wall variants + ground stone), conditioned on a street-level view and the analysis palette. Linked to the plan (meta.texture_items) — map-export embeds them with computed normal maps instead of the stock stucco files. The tiling-killer step after map_analyze.',
  {
    plan_item: z.string().describe('lib_… traced plan item'),
    prompt: z.string().max(200).optional().describe('Extra flavor, e.g. "more cracked, war-torn"'),
  },
  async ({ plan_item, prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/map-textures`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ plan_item, prompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_analyze',
  'READ a map concept image like a level designer (GPT-5 vision): counts doors, windows, stairs, domes, awnings, crates, vehicles, palms + wall height, elevation levels, palette. Stored on the plan item (meta.analysis) — the traced dressing then uses the counts as QUOTAS so the greybox carries exactly what the concept drew. Run after gripforge_map_concept.',
  {
    item: z.string().describe('lib_… traced plan item'),
    image: z.string().optional().describe('lib_… concept image to read (default: the linked concept_item)'),
  },
  async ({ item, image }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/map-analyze`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ item, image }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_decor',
  'AI street-dressing sheet for AI-traced maps: gpt-image-2 draws a 3x2 TRANSPARENT sheet of weathered street posters, saved to the Library. Pass plan_item to link it — the traced dressing already pastes poster quads at eye height on facades, and map-plan/map-export embed the linked sheet automatically. Realism layer over gripforge_map_concept.',
  {
    prompt: z.string().max(300).optional().describe('Flavor for the 6 items'),
    sheet: z.enum(['posters', 'doors', 'debris', 'windows']).optional().describe('posters (default) = street posters at eye height; doors = photoreal weathered double doors, one per house facade'),
    plan_item: z.string().optional().describe('lib_… traced plan to link (meta.decor_item)'),
  },
  async ({ prompt, plan_item, sheet }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/map-decor`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, plan_item, sheet }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_refs',
  'Official in-game stills for a map (Dust II A/B/mid/cat/tunnels). HTTPS links, Valve copyright — reference only, never Meshy image-to-3d. live=true HEAD-checks. 0 credits.',
  {
    prompt: z.string().min(2).max(240).describe('e.g. dust2'),
    live: z.boolean().optional().describe('HEAD-check URLs'),
  },
  async ({ prompt, live }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams({ prompt });
    if (live) qs.set('live', '1');
    const res = await fetch(`${API_URL}/api/v1/map-refs?${qs}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_props',
  'FPS map callout props (xbox, goose, A/B crates, mid/long doors, T palms). Matches locker. Pair with gripforge_map_plan. Preview https://gripforge.ai/map-plan?prompt=dust2. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('e.g. counter-strike dust2') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/map-props?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_wires',
  'Sagging electrical cables for an FPS map: two anchors + sag + strands. Not a generated mesh. Pair with gripforge_map_plan. Dust2: T yard, cat (shot5a), mid, A. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('e.g. counter-strike dust2') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/map-wires?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_reconstruct',
  'Hierarchical FPS reconstruction: classified official stills (LINK) → MapGraph → greybox (no props) → zone parts → camera match → dress (original textures + map_props + map_wires). prompt e.g. Reconstruct map: Counter-Strike 2 Dust II. stage=collect|graph|greybox|zone|dress|all. Dust II is Valve IP — benchmark only, no BSP/VPK, never Meshy a screenshot. Greybox preview https://gripforge.ai/map-plan?prompt=dust2&greybox=1 — dressed /map-plan?prompt=dust2. 0 credits.',
  {
    prompt: z.string().min(2).max(240).describe('e.g. Reconstruct map: Counter-Strike 2 Dust II'),
    stage: z
      .enum(['collect', 'graph', 'greybox', 'zone', 'validate', 'capture', 'dress', 'all'])
      .optional()
      .describe('collect | graph | greybox | zone | validate | capture | dress | all'),
    zone: z.string().min(2).max(40).optional().describe('LONG_A | A_SITE | CATWALK | …'),
  },
  async ({ prompt, stage, zone }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams({ prompt });
    if (stage) qs.set('stage', stage);
    if (zone) qs.set('zone', zone);
    const res = await fetch(`${API_URL}/api/v1/map-reconstruct?${qs}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    const rec = data as { preview_url?: string };
    const preview = typeof rec.preview_url === 'string' ? `Preview: ${rec.preview_url}\n\n` : '';
    return { content: [{ type: 'text' as const, text: `${preview}${JSON.stringify(data, null, 2)}` }] };
  },
);


server.tool(
  'gripforge_map_export',
  'Export the dressed FPS map as ONE engine-ready GLB: merged textured meshes named <family>-col (Godot builds trimesh colliders on import), metric UVs, ground slab. Pair with a NavigationRegion3D bake. 0 credits.',
  {
    prompt: z.string().min(2).max(240).describe('e.g. "dust2"'),
    item: z.string().optional().describe('lib_… traced plan from gripforge_map_concept — exports the AI-drawn layout instead of dust2'),
    extent_m: z.number().min(30).max(300).optional().describe('Rescale the traced plan to this playfield size in metres'),
    out_dir: z.string().optional().describe('Write dust2-map.glb here'),
    save: z.boolean().optional().describe('Also store the GLB in the Library (kind prop)'),
    godot_project: z.boolean().optional().describe('Write a ready-to-run Godot 4 project around the GLB into out_dir (scenes, FPS player, navmesh bake) — then: godot --path <out_dir>'),
    lighting: z.enum(['noon', 'golden', 'dusk', 'night', 'overcast']).optional().describe('Godot mood preset (SDFGI real-time GI, no bake): noon = desert midday (default), golden = warm low sun, dusk = orange sunset, night = cool moonlight, overcast = soft grey. Tunable afterwards in scenes/main.tscn (Sun.light_energy, ambient_light_energy, sdfgi_energy — see the kit README)'),
  },
  async ({ prompt, item, extent_m, out_dir, save, godot_project, lighting }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams({ prompt });
    if (item) qs.set('item', item);
    if (extent_m != null) qs.set('extent_m', String(extent_m));
    if (save) qs.set('save', '1');
    const res = await fetch(`${API_URL}/api/v1/map-export?${qs}`, { headers: apiHeaders() });
    if (!res.ok) { const data = await res.json().catch(() => ({})); return err(String((data as { error?: string }).error ?? res.status)); }
    if (save) { const data = await res.json(); return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }; }
    const buf = Buffer.from(await res.arrayBuffer());
    const wrote: string[] = [];
    if (out_dir) {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      mkdirSync(out_dir, { recursive: true });
      if (godot_project) {
        const kitQs = new URLSearchParams({ prompt, godot: '1' });
        if (item) kitQs.set('item', item);
        if (extent_m != null) kitQs.set('extent_m', String(extent_m));
        if (lighting) kitQs.set('lighting', lighting);
        const kitRes = await fetch(`${API_URL}/api/v1/map-export?${kitQs}`, { headers: apiHeaders() });
        const kit = (await kitRes.json()) as { files?: Record<string, string>; binaries?: Record<string, string> };
        for (const [rel, content] of Object.entries(kit.files ?? {})) {
          const fp = join(out_dir, rel);
          mkdirSync(dirname(fp), { recursive: true });
          writeFileSync(fp, content);
          wrote.push(fp);
        }
        for (const [rel, b64] of Object.entries(kit.binaries ?? {})) {
          const fp = join(out_dir, rel);
          mkdirSync(dirname(fp), { recursive: true });
          writeFileSync(fp, Buffer.from(b64, 'base64'));
          wrote.push(fp);
        }
        mkdirSync(join(out_dir, 'assets'), { recursive: true });
        const gp = join(out_dir, 'assets', 'dust2.glb');
        writeFileSync(gp, buf);
        wrote.push(gp);
      } else {
        const gp = join(out_dir, 'dust2-map.glb');
        writeFileSync(gp, buf);
        wrote.push(gp);
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ bytes: buf.length, wrote, run: godot_project && out_dir ? `godot --path ${out_dir} --import --headless && godot --path ${out_dir}` : undefined, meshes: res.headers.get('x-gripforge-meshes') }, null, 2) }] };
  },
);

server.tool(
  'gripforge_map_look',
  'Reproduce a Dust II still without copying pixels: camera + volume/prop/wire ids. shot=shot21a (A), shot1a (T), shot5a (cat). LINK only, never Meshy image-to-3d. Pair map_plan. 0 credits.',
  {
    prompt: z.string().min(2).max(240).describe('e.g. dust2'),
    shot: z.string().min(2).max(80).optional().describe('shot21a | a-site | shot1a | catwalk'),
  },
  async ({ prompt, shot }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams({ prompt });
    if (shot) qs.set('shot', shot);
    const res = await fetch(`${API_URL}/api/v1/map-look?${qs}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_kit',
  'Read and compose reusable game engines. list/get return manifests and GameRules; create/patch persist rules and asset slots in the authenticated workspace. FPS rules are shared by Godot and web. Existing vehicle kits remain supported.',
  {action:z.enum(['list','get','create','patch']),id:z.string().max(80).optional(),style:z.string().max(64).optional(),name:z.string().max(160).optional(),rules:z.record(z.string(),z.unknown()).nullable().optional(),slots:z.array(z.object({id:z.string().max(40),itemId:z.string().max(64).nullable()})).optional(),prompts:z.record(z.string(),z.string().max(4000)).optional()},
  async args=>{
    if(!API_KEY)return err('GRIPFORGE_API_KEY missing.');
    if((args.action==='get'||args.action==='patch')&&!args.id)return err('id required');
    const endpoint=args.action==='list'?'/api/v1/library?kind=kit&limit=100':args.action==='create'?'/api/v1/library/kit':`/api/v1/library/${encodeURIComponent(args.id!)}/kit`;
    const method=args.action==='create'?'POST':args.action==='patch'?'PATCH':'GET';
    const body=args.action==='create'?{style:args.style??'custom',name:args.name,rules:args.rules,slots:args.slots,prompts:args.prompts}:args;
    const response=await fetch(API_URL+endpoint,{method,headers:{...apiHeaders(),'content-type':'application/json'},...(method!=='GET'?{body:JSON.stringify(body)}:{})});
    const data=await response.json();if(!response.ok)return err(String(data.error??response.status));
    const result=args.action==='list'?{kits:(data.items??[]).map((o:any)=>({id:o.id,name:o.name,style:o.meta?.style,engine:o.meta?.engine??null,rules:o.meta?.rulesSummary??null,slotsFilled:o.meta?.slotsFilled,slotsTotal:o.meta?.slotsTotal}))}:data;
    return {content:[{type:'text' as const,text:JSON.stringify(result,null,2)}],structuredContent:result};
  },
);

server.tool(
  'gripforge_fps_kit',
  'Reusable tactical FPS engine for web and Godot. Get resolved rules/map, validate asset dependencies or export runtime files. Same weapon, animation, grenade, bot and bomb rules in both targets. Offline bots; no network claim. Persist edits with gripforge_kit. 0 credits.',
  { action:z.enum(['get','validate','export']).default('get'), target:z.enum(['web','godot','both']).default('both'), kit_id:z.string().optional(), rules:z.record(z.string(),z.unknown()).optional(), map:z.record(z.string(),z.unknown()).optional(), asset_slots:z.array(z.string()).optional() },
  async (args) => {
    if(!API_KEY)return err('GRIPFORGE_API_KEY missing.');
    const res=await fetch(`${API_URL}/api/v1/fps-kit`,{method:'POST',headers:{...apiHeaders(),'content-type':'application/json'},body:JSON.stringify(args)});
    const data=await res.json();if(!res.ok)return err(String(data.error??res.status));
    return {content:[{type:'text' as const,text:JSON.stringify(data,null,2)}]};
  },
);

server.tool(
  'gripforge_viewmodel_kit',
  'CS-style FPS viewmodel: arms + gun under Camera3D/Hold. Write viewmodel.json + gf_viewmodel.gd. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('e.g. fps or counter-strike dust2') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/viewmodel-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_screen_concept',
  'Rebuild a UI screen from a concept image: vision pass returns every button/panel/label with a normalised rect, colours and action; gf_screen.gd renders it as real Godot controls at any resolution. Saved in the Library (kind concept, category ui). 1 credit.',
  {
    image_path: z.string().optional().describe('local PNG/JPG of the mockup'),
    image_id: z.string().optional().describe('or a Library id (lib_...)'),
    name: z.string().optional().describe('slug for the screen (main_menu, lobby, hud)'),
    out_dir: z.string().optional().describe('write screen json + gf_screen.gd here'),
  },
  async ({ image_path, image_id, name, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const payload: Record<string, unknown> = {};
    if (image_path) payload.image_base64 = (await readFile(image_path)).toString('base64');
    else if (image_id) payload.image = image_id;
    else return err('image_path or image_id required');
    if (name) payload.name = name;
    const res = await fetch(`${API_URL}/api/v1/screen-concept`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; files?: Record<string, string> };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    if (out_dir) {
      for (const [rel, content] of Object.entries(data.files ?? {})) {
        const fp = join(out_dir, rel);
        await mkdir(dirname(fp), { recursive: true });
        await writeFile(fp, content);
        wrote.push(fp);
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, files: undefined, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_screen_assets',
  'Cut the sprites of an analysed screen out of its own concept image (buttons, panels, icons, background) with 9-slice margins, and write them next to the layout. Pixel-identical to the concept, 0 credits.',
  {
    item: z.string().describe('Library id of a screen analysed by gripforge_screen_concept'),
    out_dir: z.string().describe('project root: files land under gripforge/screens/<id>/'),
  },
  async ({ item, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/screen-assets`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ item }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; files?: Record<string, string>; layout?: { id?: string } };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    for (const [rel, b64] of Object.entries(data.files ?? {})) {
      const fp = join(out_dir, rel);
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, Buffer.from(b64, 'base64'));
      wrote.push(fp);
    }
    if (data.layout?.id) {
      const lp = join(out_dir, `gripforge/screens/${data.layout.id}.json`);
      await mkdir(dirname(lp), { recursive: true });
      await writeFile(lp, JSON.stringify(data.layout, null, 2));
      wrote.push(lp);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, files: undefined, layout: undefined, wrote: wrote.length, dir: wrote[0] }, null, 2) }] };
  },
);

server.tool(
  'gripforge_screen_icons',
  'Redraw the icons of an analysed screen as clean TRANSPARENT PNGs (crops carry the panel behind them and cannot be reused). Uses each crop as the reference so the symbol stays the same. 1 credit per 4 icons.',
  {
    item: z.string().describe('Library id of an analysed screen'),
    ids: z.array(z.string()).optional().describe('specific element ids, default every icon'),
    style: z.string().optional().describe('art direction, e.g. "crisp flat white symbol"'),
    out_dir: z.string().describe('project root: icons land under gripforge/screens/<id>/icons/'),
  },
  async ({ item, ids, style, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/screen-icons`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ item, ids, style }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; files?: Record<string, string>; layout?: { id?: string }; icons?: string[] };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    for (const [rel, b64] of Object.entries(data.files ?? {})) {
      const fp = join(out_dir, rel);
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, Buffer.from(b64, 'base64'));
      wrote.push(fp);
    }
    if (data.layout?.id) {
      const lp = join(out_dir, `gripforge/screens/${data.layout.id}.json`);
      await writeFile(lp, JSON.stringify(data.layout, null, 2));
      wrote.push(lp);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ icons: data.icons, wrote: wrote.length }, null, 2) }] };
  },
);

server.tool(
  'gripforge_screen_background',
  'Clean backdrop for an analysed screen: inpaints the interface away (mask built from the layout rects) so the art no longer carries buttons and text baked in. 1 credit.',
  {
    item: z.string().describe('Library id of an analysed screen'),
    keep: z.array(z.string()).optional().describe('element ids to leave in the art'),
    prompt: z.string().optional().describe('extra art direction'),
    out_dir: z.string().describe('project root'),
  },
  async ({ item, keep, prompt, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/screen-background`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ item, keep, prompt }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; files?: Record<string, string>; layout?: { id?: string }; erased?: number };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    for (const [rel, b64] of Object.entries(data.files ?? {})) {
      const fp = join(out_dir, rel);
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, Buffer.from(b64, 'base64'));
      wrote.push(fp);
    }
    if (data.layout?.id) {
      const lp = join(out_dir, `gripforge/screens/${data.layout.id}.json`);
      await writeFile(lp, JSON.stringify(data.layout, null, 2));
      wrote.push(lp);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ erased: data.erased, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_menu_kit',
  'Front-end for a multiplayer FPS: main menu (host/join/quit), lobby listing connected peers where only the host starts, and an in-game HUD (health, round timer, score, weapon, kill feed) fed by replicated state. Pairs with gripforge_net_kit. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('e.g. counter-strike, minimal') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/menu-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_bot_kit',
  'AI opponents for the Godot FPS: navmesh bots (patrol/hunt/shoot, reaction time + aim error, respawn) driven by one autoload; they reuse the player scene under server authority so spawner/synchronizer/net-kit damage apply unchanged. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('difficulty: easy, normal, hard') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/bot-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_build',
  'Build the Godot game and register the version in the workspace: smoke test (GF_SMOKE=1, script errors fail the build), headless export for the preset (macos | windows | linux | web; presets written into export_presets.cfg when missing), zip, upload as a Library "build" (kind kit, meta.tool=build: game, version, preset, commit, engine, size, smoke) and return the download URL. Needs Godot installed locally (GODOT_BIN or /Applications/Godot.app) and the export templates for the platform. 0 credits.',
  {
    project: z.string().describe('Godot project directory (contains project.godot)'),
    preset: z.enum(['macos', 'windows', 'linux', 'web']).default('macos'),
    version: z.string().optional().describe('e.g. 0.3.0 — default: project.godot config/version, else git describe, else date'),
    changelog: z.string().optional(),
    smoke: z.boolean().default(true).describe('run the GF_SMOKE=1 launch before exporting'),
    upload: z.boolean().default(true).describe('push the zip to the workspace'),
  },
  async ({ project, preset, version, changelog, smoke, upload }) => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');
    const { execFile } = await import('node:child_process');
    const run = (cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const child = execFile(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 600000 }, (err, stdout, stderr) => {
          resolve({ code: err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code?: number }).code) : err ? 1 : 0, out: `${stdout}\n${stderr}` });
        });
        void child;
      });
    const notes: string[] = [];
    const proj = path.resolve(project);
    const pg = path.join(proj, 'project.godot');
    let pgText = '';
    try { pgText = await fs.readFile(pg, 'utf8'); } catch { return err(`no project.godot in ${proj}`); }
    const game = (pgText.match(/config\/name="([^"]+)"/)?.[1] ?? path.basename(proj)).trim();
    // godot binary
    let godot = process.env.GODOT_BIN ?? '';
    if (!godot) {
      for (const c of ['/Applications/Godot.app/Contents/MacOS/Godot', '/Applications/Godot_mono.app/Contents/MacOS/Godot', '/usr/local/bin/godot', '/usr/bin/godot']) {
        try { await fs.access(c); godot = c; break; } catch { /* next */ }
      }
    }
    if (!godot) return err('Godot not found: set GODOT_BIN');
    const ver = (await run(godot, ['--version'])).out.trim().split('\n').pop() ?? '';
    const verKey = ver.match(/^(\d+\.\d+(?:\.\d+)?)\.(\w+)/) ? `${ver.match(/^(\d+\.\d+(?:\.\d+)?)\.(\w+)/)![1]}.${ver.match(/^(\d+\.\d+(?:\.\d+)?)\.(\w+)/)![2]}` : ver;
    notes.push(`godot ${ver} (${godot})`);
    // export templates
    const tplDir = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library/Application Support/Godot/export_templates', verKey)
      : path.join(os.homedir(), '.local/share/godot/export_templates', verKey);
    const need: Record<string, string[]> = { macos: ['macos.zip'], windows: ['windows_release_x86_64.exe'], linux: ['linux_release.x86_64'], web: ['web_release.zip', 'web_nothreads_release.zip'] };
    let have: string[] = [];
    try { have = await fs.readdir(tplDir); } catch { /* none */ }
    const ok = need[preset]!.some((f) => have.includes(f));
    if (!ok) {
      return err(`export templates for ${preset} missing in ${tplDir} (have: ${have.join(', ') || 'none'}). Install: Godot → Editor → Manage Export Templates → Download, or unzip Godot_v${verKey.replace('.stable', '-stable')}_export_templates.tpz (templates/*) into that folder.`);
    }
    // version
    let v = version ?? (pgText.match(/config\/version="([^"]+)"/)?.[1] ?? '');
    if (!v) { const g = await run('git', ['describe', '--tags', '--always'], { cwd: proj }); v = g.code === 0 ? g.out.trim() : ''; }
    if (!v) v = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    const commit = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: proj })).out.trim() || null;
    // presets
    const presetName = `gf-${preset}`;
    const presetsPath = path.join(proj, 'export_presets.cfg');
    let presets = '';
    try { presets = await fs.readFile(presetsPath, 'utf8'); } catch { /* new */ }
    const outDir = path.join(proj, 'builds', v, preset);
    await fs.mkdir(outDir, { recursive: true });
    const outFile = { macos: `${game.replace(/[^\w.-]+/g, '_')}.zip`, windows: `${game.replace(/[^\w.-]+/g, '_')}.exe`, linux: `${game.replace(/[^\w.-]+/g, '_')}.x86_64`, web: 'index.html' }[preset]!;
    if (!presets.includes(`name="${presetName}"`)) {
      const idx = (presets.match(/\[preset\.\d+\]/g) ?? []).length;
      const platform = { macos: 'macOS', windows: 'Windows Desktop', linux: 'Linux', web: 'Web' }[preset]!;
      const useNoThreads = preset === 'web' && !have.includes('web_release.zip');
      const opts = preset === 'web'
        ? `variant/thread_support=${useNoThreads ? 'false' : 'true'}\nhtml/export_icon=true\nprogressive_web_app/enabled=false\n`
        : preset === 'macos'
          ? `application/bundle_identifier="ai.gripforge.${game.replace(/[^a-z0-9]+/gi, '').toLowerCase()}"\ncodesign/codesign=0\nnotarization/notarization=0\napplication/export_format=0\n`
          : preset === 'windows'
            ? `binary_format/embed_pck=true\napplication/modify_resources=false\n`
            : `binary_format/embed_pck=true\n`;
      presets += `${presets.trim() ? '\n' : ''}[preset.${idx}]\n\nname="${presetName}"\nplatform="${platform}"\nruntime/platform="${platform}"\ncustom_features=""\nexport_filter="all_resources"\ninclude_filter=""\nexclude_filter="builds/*"\nexport_path="builds/${v}/${preset}/${outFile}"\npatches=PackedStringArray()\nencryption_include_filters=""\nencryption_exclude_filters=""\nseed=0\nencrypt_pck=false\nencrypt_directory=false\nscript_export_mode=2\n\n[preset.${idx}.options]\n\n${opts}`;
      await fs.writeFile(presetsPath, presets);
      notes.push(`export preset "${presetName}" written to export_presets.cfg`);
    }
    // smoke
    let smokeVerdict = 'skipped';
    if (smoke) {
      const s = await run(godot, ['--path', proj, '--resolution', '960x600', '--position', '40,40', '--always-on-top'], { env: { GF_SMOKE: '1' }, timeoutMs: 120000 });
      const errors = (s.out.match(/SCRIPT ERROR:[^\n]*/g) ?? []).slice(0, 5);
      const saved = /SMOKE saved/.test(s.out);
      smokeVerdict = errors.length ? `failed: ${errors.join(' | ')}` : saved ? 'ok' : `no screenshot (exit ${s.code})`;
      notes.push(`smoke: ${smokeVerdict}`);
      if (errors.length) return err(`smoke test failed, build refused — ${errors.join(' | ')}`);
    }
    // export
    const target = path.join(outDir, outFile);
    const ex = await run(godot, ['--headless', '--path', proj, '--export-release', presetName, target], { timeoutMs: 900000 });
    const exErrors = (ex.out.match(/ERROR:[^\n]*/g) ?? []).filter((l) => !/nav_mesh|navigation|Image format/i.test(l)).slice(0, 5);
    let exists = false;
    try { await fs.access(target); exists = true; } catch { /* missing */ }
    if (!exists) return err(`export failed (exit ${ex.code}): ${exErrors.join(' | ') || ex.out.slice(-600)}`);
    notes.push(`exported ${presetName} → ${target}${exErrors.length ? ` (warnings: ${exErrors.length})` : ''}`);
    // zip
    const zipName = `${game.replace(/[^\w.-]+/g, '_')}-${v}-${preset}.zip`;
    const zipPath = path.join(proj, 'builds', zipName);
    try { await fs.unlink(zipPath); } catch { /* fresh */ }
    const z = await run('zip', ['-qr', zipPath, '.'], { cwd: outDir, timeoutMs: 600000 });
    if (z.code !== 0) return err(`zip failed: ${z.out.slice(-300)}`);
    const bytes = (await fs.stat(zipPath)).size;
    notes.push(`zip ${zipName} (${(bytes / 1048576).toFixed(1)} MB)`);
    // upload
    let item: unknown = null;
    if (upload) {
      if (!API_KEY) return err('GRIPFORGE_API_KEY missing (build kept locally at ' + zipPath + ')');
      const form = new FormData();
      form.append('file', new Blob([await fs.readFile(zipPath)]), zipName);
      form.append('kind', 'kit');
      form.append('name', `${game} v${v} · ${preset}`);
      form.append('meta', JSON.stringify({ tool: 'build', game, version: v, preset, platform: preset, commit, engine: ver, bytes, smoke: smokeVerdict, changelog: changelog ?? null, built_at: new Date().toISOString(), tags: ['build', preset] }));
      const res = await fetch(`${API_URL}/api/v1/library`, { method: 'POST', headers: apiHeaders(), body: form });
      const data = (await res.json().catch(() => ({}))) as { error?: string; item?: unknown };
      if (!res.ok) return err(`upload failed: ${String(data.error ?? res.status)} (build kept locally at ${zipPath})`);
      item = data.item ?? data;
      notes.push('registered in the workspace');
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ game, version: v, preset, commit, engine: ver, smoke: smokeVerdict, zip: zipPath, bytes, item, notes }, null, 2) }] };
  },
);

server.tool(
  'gripforge_gunfx_kit',
  'Gun feedback for the Godot FPS: muzzle flash, tracer, impact sparks + bullet-hole decal, blood spray (+ wall splat). One procedural autoload GfGunfx (no textures) fired by the net kit through a shot_fx RPC after the server raycast, misses included. Presets counter-strike / arcade / subtle. 0 credits.',
  {
    prompt: z.string().min(2).max(240).describe('e.g. counter-strike, arcade, subtle tactical'),
    out_dir: z.string().optional().describe('Godot project root: writes scripts/gf_gunfx.gd, gripforge/gunfx.json and the CC0 sprites into gripforge/gunfx/ (+ LICENSES.txt)'),
  },
  async ({ prompt, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/gunfx-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = (await res.json().catch(() => ({}))) as { error?: string; json?: string; snippet_godot?: string; sprites?: Array<{ name: string; url: string }>; licenses_url?: string };
    if (!res.ok) return err(String(data.error ?? res.status));
    const wrote: string[] = [];
    if (out_dir) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(path.join(out_dir, 'scripts'), { recursive: true });
      await fs.mkdir(path.join(out_dir, 'gripforge', 'gunfx'), { recursive: true });
      await fs.writeFile(path.join(out_dir, 'scripts', 'gf_gunfx.gd'), data.snippet_godot ?? '');
      await fs.writeFile(path.join(out_dir, 'gripforge', 'gunfx.json'), data.json ?? '{}');
      wrote.push('scripts/gf_gunfx.gd', 'gripforge/gunfx.json');
      for (const sp of data.sprites ?? []) {
        const r = await fetch(sp.url);
        if (!r.ok) continue;
        await fs.writeFile(path.join(out_dir, 'gripforge', 'gunfx', `${sp.name}.png`), Buffer.from(await r.arrayBuffer()));
        wrote.push(`gripforge/gunfx/${sp.name}.png`);
      }
      if (data.licenses_url) {
        const r = await fetch(data.licenses_url);
        if (r.ok) { await fs.writeFile(path.join(out_dir, 'gripforge', 'gunfx', 'LICENSES.txt'), await r.text()); wrote.push('gripforge/gunfx/LICENSES.txt'); }
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...data, snippet_godot: out_dir ? '(written)' : data.snippet_godot, wrote }, null, 2) }] };
  },
);

server.tool(
  'gripforge_match_kit',
  'Listen-server match contract: party size, teams, maps, ranked flag, join-by-IP. Write match.json + autoload GfMatch on top of GfNet. GripForge does not host a queue. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('e.g. counter-strike, deathmatch, ranked 5v5') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/match-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_net_kit',
  'Godot 4 multiplayer (ENet): GfNet autoload host/join/spawn with server-side hit validation, gf_round.gd for the round + bomb, MultiplayerSpawner/Synchronizer wiring. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('e.g. counter-strike, deathmatch, fps') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/net-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_input_kit',
  'InputMap presets: fps (WASD + arrows on move_*) or kart (accelerate/brake/steer + standard gamepad RT/LT/stick, same indices as the web Gamepad API). Write gripforge/input.json, autoload GfInput. Optional third_person=true adds portable character-facing JavaScript and a Three.js adapter; orientation only, not a physics controller. 0 credits.',
  {
    prompt: z.string().min(2).max(240).describe('e.g. fps or counter-strike dust2'),
    third_person: z.boolean().optional().describe('Include character-facing JavaScript and Three.js usage (default false; existing input map unchanged).'),
  },
  async ({ prompt, third_person }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const qs = new URLSearchParams({ prompt });
    if (third_person) qs.set('third_person', '1');
    const res = await fetch(`${API_URL}/api/v1/input-kit?${qs}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_light_kit',
  'Moon / sun / candle lights + fog + Three.js snippet for a game look. 0 credits. Pair with scene_kit.',
  { prompt: z.string().min(2).max(240).describe('e.g. devil may cry like') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/light-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_font',
  'Google-font CSS + exact HUD copy (DMC: Cinzel D–SSS, kart: Teko, CS: Barlow Condensed). Put letters in HTML — do not rasterize. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('e.g. devil may cry like') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/font-kit?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_loading_page',
  'Loading overlay for Three/Godot/Unity/Unreal. Title is text. Overlay 0 credits. Pass character_id to generate a 16:9 cinematic still of that Library character (1 credit, no letters in the image).',
  {
    prompt: z.string().min(2).max(240).describe('e.g. devil may cry like'),
    character_id: z.string().optional().describe('lib_… character/enemy/bind — generate background still'),
  },
  async ({ prompt, character_id }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    if (character_id) {
      const res = await fetch(`${API_URL}/api/v1/loading-page`, {
        method: 'POST',
        headers: { ...apiHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, character_id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    }
    const res = await fetch(`${API_URL}/api/v1/loading-page?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_navmesh',
  'Walkable XZ AABB + pillar holes for a scene_kit room. JSON clamp, not a baked navmesh. 0 credits.',
  { prompt: z.string().min(2).max(240).describe('e.g. devil may cry like') },
  async ({ prompt }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/navmesh?${new URLSearchParams({ prompt })}`, { headers: apiHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String((data as { error?: string }).error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_vfx_generate',
  'ADMIN ONLY. Text-to-VFX or image-to-VFX: interpret a prompt or reference into an editable animated effect specification. No Library save or credit charge. Pass the resulting type, style, look, color, duration, width, name, emitters and generation to gripforge_vfx to save/export (1 credit). Image mode requires a configured vision provider.',
  { preset: z.enum(['slash-trail', 'slash-emerald', 'slash-steel', 'slash-fire', 'slash-ice', 'slash-nature', 'arc-pulse', 'fire-breath', 'neon-impact']).optional().describe('Load a ready-to-play preset instantly, without AI. Supply this field alone.'),
          prompt: z.string().max(500).optional().describe('Effect description; optional with an image.'),
          visual_style: z.enum(['realistic', 'stylized', 'anime', 'lowpoly']).optional(),
          image_data: z.string().max(12 * 1024 * 1024).optional().describe('PNG/JPEG/WebP base64 data URI, up to 8 MB decoded.'),
          image_id: z.string().optional().describe('Owned Library image id; use instead of image_data.'), },
  async (args) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/vfx/prompt`, {
      method: 'POST', headers: { ...apiHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(55_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return err(String(data.error ?? res.status));
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'gripforge_vfx',
  'ADMIN ONLY. Generate + export 3D slash/thrust/spin VFX on an existing Library bind, or a world-space fire meteor (head + trail + impact). Pass prompt to fill type/style/color/emitters. Returns studio_url to edit the saved effect in GripForge, workspace_id, GLB, PNG, vfx.json + snippets. Refused for non-admin keys.',
  {
    name: z.string().max(80).optional(),
          emitters: z.array(z.record(z.string(), z.unknown())).max(6).optional().describe('Emitters returned by gripforge_vfx_generate.'),
          generation: z.record(z.string(), z.unknown()).optional().describe('Generation provenance returned by gripforge_vfx_generate.'),
          attach_id: z.string().optional().describe('Library bind id (lib_…). Not required for meteor.'),
    prompt: z.string().optional().describe('Natural-language VFX prompt. Fills type/style/color/emitters when omitted.'),
    type: z.enum(['slash', 'thrust', 'spin', 'meteor', 'beam', 'swing', 'claw', 'charge', 'shield', 'portal', 'slam']).optional().describe('Strike type (default slash). portal = standing blood rift / demonic seal (world-space, loops); slam = ground-impact eruption: light pillar + fireball + sparks/debris (world-space, one-shot)'),
    style: z.enum(['energy', 'metal', 'magic']).optional().describe('Look (default energy)'),
    look: z.enum(['toon', 'solid', 'crystal', 'flame', 'pulse', 'firejet', 'impact']).optional().describe('toon: stylized ribbon/lightning; solid: filled beam; crystal: faceted weapon trail; flame: burning crescent; pulse: released electric orb; firejet: flared fire stream with torn tongues and pressure rings; impact: slam-family comic explosion with red telegraph, violet core, ink debris and optional impact frames'),
    color: z.string().optional().describe('Hex color'),
    duration: z.number().optional().describe('Seconds (default 0.25)'),
    width: z.number().optional().describe('Ribbon width in metres'),
    core: z.number().min(0.02).max(0.4).optional().describe('portal only: shadow-core radius as a fraction of the portal (default 0.09)'),
    out_dir: z.string().optional().describe('Write vfx.glb, additive.png, vfx.json here'),
  },
  async ({ name, emitters, generation, attach_id, prompt, type, style, look, color, duration, width, core, out_dir }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing.');
    const res = await fetch(`${API_URL}/api/v1/vfx`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'x-gripforge-client': 'mcp', 'content-type': 'application/json' },
      body: JSON.stringify({
        name, emitters, generation,
        attach_id,
        prompt,
        type,
        style,
        look,
        color,
        duration,
        width,
        core,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      id?: string;
      studio_url?: string;
      workspace_id?: string;
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

// Kept in sync with apps/web/src/lib/performance.ts; this package ships alone.
const performanceMs = z.number().finite().min(0).max(60_000);
const performanceSampleSchema = z.object({
  fps: z.number().finite().min(0).max(1000).optional(),
  frameMs: performanceMs.optional(),
  p95Ms: performanceMs.optional(),
  pixelRatio: z.number().finite().min(.01).max(8).optional(),
  quality: z.enum(['auto', 'high', 'performance']).optional(),
  level: z.number().int().min(0).max(10).optional(),
  cpuMs: performanceMs.optional(),
  submitMs: performanceMs.optional(),
  gpuMs: performanceMs.nullable().optional(),
  drawCalls: z.number().int().min(0).max(1_000_000).optional(),
  triangles: z.number().int().min(0).max(1_000_000_000).optional(),
  networkMs: performanceMs.nullable().optional(),
  snapshotAgeMs: performanceMs.optional(),
}).refine(sample => sample.fps !== undefined || sample.frameMs !== undefined, 'Each sample needs fps or frameMs.');

server.tool(
  'gripforge_performance',
  'Analyze measured game performance: FPS, frame times, CPU/submission work, draw calls and network latency. ' +
    'Pass a numeric report to analyze it without saving, or omit report to retrieve the latest explicitly shared capture in your workspace. ' +
    'Optional kit_id filters the capture. Returns measured findings and limitations, not a claimed optimization or GPU benchmark. 0 credits.',
  {
    kit_id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional().describe('Kit id for the latest workspace capture (optional).'),
    report: z.object({
      game: z.string().trim().max(80).optional(),
      version: z.string().trim().max(80).optional(),
      viewport: z.object({ width: z.number().int().min(1).max(32_768), height: z.number().int().min(1).max(32_768) }).optional(),
      samples: z.array(performanceSampleSchema).min(1).max(120),
    }).optional().describe('Measured diagnostic JSON, including 1–120 numeric samples. Only documented performance fields are sent.'),
  },
  async ({ kit_id, report }) => {
    if (!API_KEY) return err('GRIPFORGE_API_KEY missing. Set a workspace API key to access performance diagnostics.');
    const query = kit_id ? `?${new URLSearchParams({ kit_id })}` : '';
    const body = report ? JSON.stringify({ mode: 'analyze', kitId: kit_id, report }) : undefined;
    if (body && Buffer.byteLength(body, 'utf8') > 65_536) return err('Performance report exceeds the 64 KiB request limit. Reduce the number of samples.');
    try {
      const response = await fetch(`${API_URL}/api/v1/performance${report ? '' : query}`, {
        method: report ? 'POST' : 'GET',
        headers: { ...apiHeaders(), ...(report ? { 'content-type': 'application/json' } : {}) },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => ({})) as { schema?: string; error?: string };
      if (response.status === 401) return err('Invalid GRIPFORGE_API_KEY. Check your workspace API key.');
      if (response.status === 404 && !report) return err('No performance capture is available for this workspace or kit. Share a capture from the game, or provide a measured report.');
      if (!response.ok) return err(String(data.error ?? `Performance diagnostics failed (${response.status}).`));
      if (data.schema !== 'gripforge.performance.v1') return err('The API returned an unsupported performance report. Check that the GripForge server is up to date.');
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch {
      return err('Performance diagnostics could not be retrieved within 15 seconds. Check the GripForge API connection and try again.');
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
