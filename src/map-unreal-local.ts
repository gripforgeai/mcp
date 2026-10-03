import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

const inside = (root: string, path: string) => { const r = relative(root, path); return r === '' || r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };

/** Read a selected content pack, not the whole project, config, credentials or Saved directory. */
export async function inspectUnrealMapReference(projectFile: string, contentPath: string, signal?: AbortSignal) {
  if (!isAbsolute(projectFile) || extname(projectFile).toLowerCase() !== '.uproject') throw Error('project_file must be an absolute .uproject path.');
  if (!/^\/Game(?:\/[\p{L}\p{N}_-]+)+$/u.test(contentPath)) throw Error('content_path must be a pack folder such as /Game/StylizedDesertEnv (no traversal or object suffix).');
  const project = await realpath(projectFile), root = dirname(project);
  if ((await stat(project)).size > 1024 * 1024) throw Error('Unexpectedly large .uproject.');
  const descriptor = JSON.parse(await readFile(project, 'utf8')) as { EngineAssociation?: unknown };
  const content = await realpath(join(root, 'Content'));
  const pack = await realpath(join(content, contentPath.slice('/Game/'.length)));
  if (!inside(content, pack)) throw Error('Content pack resolves outside the project Content directory.');
  const assets: Array<{ package_path: string; object_path: string; relative_file: string; bytes: number; modified_at: string; kind_hint: string }> = [];
  const skipped: string[] = [];
  let visited = 0;
  async function walk(directory: string) {
    signal?.throwIfAborted();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (++visited > 20000) throw Error('Content pack exceeds 20,000 entries. Select a smaller folder.');
      const file = join(directory, entry.name), rel = relative(content, file).split(sep).join('/');
      if (entry.isSymbolicLink()) { skipped.push(rel); continue; }
      if (entry.isDirectory()) { await walk(file); continue; }
      const extension = extname(entry.name).toLowerCase();
      if (!entry.isFile() || !['.uasset', '.umap'].includes(extension)) continue;
      if (assets.length >= 5000) throw Error('Content pack exceeds 5,000 packages. Select a smaller folder.');
      // Do not decode or upload proprietary UE package bytes: the editor will reuse their native paths.
      const info = await stat(file), packagePath = '/Game/' + rel.slice(0, -extension.length);
      const kind = extension === '.umap' ? 'map' : /(?:^|\/)(?:meshes|staticmeshes)(?:\/|$)/i.test(rel) ? 'mesh' : /(?:^|\/)materials(?:\/|$)/i.test(rel) ? 'material' : /(?:^|\/)textures(?:\/|$)/i.test(rel) ? 'texture' : 'unknown';
      assets.push({ package_path: packagePath, object_path: packagePath + '.' + entry.name.slice(0, -extension.length), relative_file: 'Content/' + rel, bytes: info.size, modified_at: info.mtime.toISOString(), kind_hint: kind });
    }
  }
  await walk(pack);
  return {
    schema: 'gripforge.unreal-map-reference.v1', project_file: project, project_name: basename(project, '.uproject'),
    engine_version: typeof descriptor.EngineAssociation === 'string' ? descriptor.EngineAssociation : null,
    content_path: contentPath, assets,
    counts: assets.reduce<Record<string, number>>((counts, asset) => { counts[asset.kind_hint] = (counts[asset.kind_hint] ?? 0) + 1; return counts; }, {}),
    limitations: ['Filesystem inventory only: kind_hint is inferred from directories. Actor transforms, dimensions, collision and material bindings need inspection in the Unreal editor.', 'No package was uploaded, converted, imported, modified or visually validated.'],
    skipped_symlinks: skipped,
    next: 'Use an actual viewport screenshot as the pinned reference for gripforge_map_generate stage=concept. Show that concept before building. Reuse these native object paths as independent instances when delivering the chosen scene to a new Unreal level; preserve original materials. This inventory is not an import manifest or a SceneDocument.',
  };
}

export function registerMapUnrealLocalTools(register: VfxProjectRegister) {
  register('gripforge_map_unreal_reference_local', {
    title: 'Inspect a local Unreal environment pack',
    description: 'Read-only local project inventory for concept-first map creation. Returns reusable /Game asset paths, map files and inferred mesh/material/texture kinds from one selected pack. No Unreal editor or API key required; no upload or conversion. It cannot recover geometry, material bindings or actor transforms from .uasset files. Use an actual viewport image as the map concept reference, then inspect assets in the editor before native scene delivery. Available in the npm MCP client only; the hosted MCP cannot read your local disk.',
    inputSchema: { project_file: z.string().min(1).max(4096).describe('Absolute .uproject path.'), content_path: z.string().min(7).max(512).describe('Selected pack folder, e.g. /Game/StylizedDesertEnv.') },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, extra) => {
    try {
      const data = await inspectUnrealMapReference(String(args.project_file), String(args.content_path), extra?.signal);
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Cannot inspect the Unreal content pack.' }] }; }
  });
}
