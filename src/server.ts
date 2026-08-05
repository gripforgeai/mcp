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

const server = new McpServer({ name: 'gripforge', version: '0.1.0' });

const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

server.tool(
  'gripforge_attach',
  'Attach a prop (sword, shield, gun, staff/scythe…) onto a rigged character. ' +
    'Finds the hand bone across naming schemes, scales to body height, seats the grip, ' +
    'and returns a bind + ready-to-paste Three.js / Unity / Godot snippets.',
  {
    character_path: z.string().describe('Absolute path to the rigged character (.glb .gltf .fbx .obj)'),
    prop_path: z.string().describe('Absolute path to the prop mesh'),
    style: z.enum(['melee', 'gun', 'shield', 'staff']).optional().describe('Grip style (default: guessed from the filename)'),
    hand: z.enum(['right', 'left']).optional().describe('Hand side (default right)'),
    height_ratio: z.number().min(0.05).max(1.5).optional().describe('Prop size as a fraction of body height'),
    fist: z.number().min(0).max(1).optional().describe('Fist closing amount, 0 open → 1 closed (default 1)'),
    out_dir: z.string().optional().describe('Write bind.json + engine snippets into this folder'),
  },
  async ({ character_path, prop_path, style, hand, height_ratio, fist, out_dir }) => {
    if (!API_KEY) {
      return err(
        'GRIPFORGE_API_KEY missing. Create a free account at ' +
          API_URL +
          '/login then set the key in this MCP server env:\n' +
          '"env": { "GRIPFORGE_API_KEY": "gf_..." }',
      );
    }
    const charPath = resolve(character_path);
    const propPath = resolve(prop_path);
    for (const p of [charPath, propPath]) {
      if (!SUPPORTED.includes(extname(p).toLowerCase())) {
        return err(`Unsupported format: ${p} — use ${SUPPORTED.join(' ')}`);
      }
    }

    const form = new FormData();
    form.append('character', new Blob([await readFile(charPath)]), basename(charPath));
    form.append('prop', new Blob([await readFile(propPath)]), basename(propPath));
    if (style) form.append('style', style);
    if (hand) form.append('hand', hand);
    if (height_ratio != null) form.append('ratio', String(height_ratio));
    if (fist != null) form.append('fist', String(fist));
    form.append('fingers', '1');

    let res: Response;
    try {
      res = await fetch(`${API_URL}/api/v1/attach`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: form,
      });
    } catch {
      return err(`GripForge API unreachable at ${API_URL} — check GRIPFORGE_API_URL.`);
    }

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) return err('Invalid GRIPFORGE_API_KEY — check it on ' + API_URL + '/account#api');
    if (res.status === 402) {
      const u = data as { used?: number; limit?: number; plan?: string };
      return err(`Quota exceeded (${u.used}/${u.limit}, plan ${u.plan}) — upgrade at ${API_URL}/#pricing`);
    }
    if (!res.ok) return err(`Attach failed (${res.status}): ${String(data.error ?? 'unknown error')}`);

    const exportsObj = (data.exports ?? {}) as Record<string, string>;
    let wrote: string | null = null;
    if (out_dir) {
      const dir = resolve(out_dir);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'bind.json'), exportsObj.json ?? JSON.stringify(data.bind, null, 2));
      if (exportsObj.three) await writeFile(join(dir, 'three.js.txt'), exportsObj.three);
      if (exportsObj.unity) await writeFile(join(dir, 'unity.cs.txt'), exportsObj.unity);
      if (exportsObj.godot) await writeFile(join(dir, 'godot.gd.txt'), exportsObj.godot);
      wrote = dir;
    }

    const credits = data.credits as { remaining?: number; limit?: number; plan?: string } | null;
    return {
      content: [
        {
          type: 'text' as const,
          text:
            JSON.stringify({ bind: data.bind, confidence: data.confidence, exports: exportsObj, wrote }, null, 2) +
            (credits ? `\ncredits: ${credits.remaining}/${credits.limit} remaining (${credits.plan})` : ''),
        },
      ],
    };
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

const transport = new StdioServerTransport();
await server.connect(transport);
