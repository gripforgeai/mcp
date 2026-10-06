import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { GameImportAgent, confinedFile, inspectAsset, jobDirectory, saveImportJob } from './game-import-agent.js';
import type { ImportJob } from './game-import-types.js';
const exec = promisify(execFile), hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function normalizedPath(job: ImportJob, id: string, format: string) { return join(jobDirectory(job.id), 'normalized', id, 'output.' + format); }
/** Local durable conversions. Completed files survive cancellation/crashes; original sources are never modified. */
export async function normalizeGame(job: ImportJob) {
  if (!job.report || !job.selected?.length || !job.rights) throw Error('Select sources and provide a rights basis');
  const bin = process.env.GRIPFORGE_BLENDER_BIN;
  if (!bin || !isAbsolute(bin)) throw Error('Configure GRIPFORGE_BLENDER_BIN with an installed Blender executable');
  const agent = new GameImportAgent(job); job.total = job.selected.length; job.completed = 0;
  for (const id of job.selected) {
    await agent.checkpoint(); const asset = job.report.assets.find(a => a.id === id);
    if (!asset || !['fbx', 'obj', 'dds', 'tga'].includes(asset.format)) throw Error('Blender normalization supports FBX/OBJ/DDS/TGA only');
    const source = await readFile(await confinedFile(job.root, asset.path));
    if (hash(source) !== asset.sha256) throw Error('Source changed after analysis; analyze again');
    const format = ['dds', 'tga'].includes(asset.format) ? 'png' : 'glb', output = normalizedPath(job, id, format), dir = dirname(output);
    await mkdir(join(dir, 'source'), { recursive: true, mode: 0o700 });
    try {
      let bytes: Buffer | undefined;
      if (asset.details.normalization) {
        const cached = await readFile(output).catch(() => undefined);
        if (cached && hash(cached) === asset.details.normalization.sha256) bytes = cached;
      }
      if (!bytes) {
        const input = join(dir, 'source', basename(asset.path));
        await writeFile(input, source, { mode: 0o600 });
        // Staging excludes source scripts and arbitrary external references. Embedded FBX materials are retained.
        // OBJ material sidecars need explicit portable export: never follow unvalidated MTL references in Blender.
        if (asset.format === 'obj' && /^\s*mtllib\s/m.test(source.toString())) throw Error('OBJ references an MTL sidecar; export a self-contained GLB or embedded FBX to preserve PBR');
        const plan = join(dir, 'plan.json'), receipt = join(dir, 'receipt.json');
        await writeFile(plan, JSON.stringify({ input, output, receipt }), { mode: 0o600 });
        await exec(bin, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', fileURLToPath(new URL('../runtime/game-import-normalize.py', import.meta.url)), '--', plan], { cwd: dir, timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
        await agent.checkpoint(); if ((await stat(output)).size > 256 * 1024 * 1024) throw Error('Normalized output exceeds 256 MiB'); bytes = await readFile(output);
        const inspected = inspectAsset('output.' + format, bytes);
        if (inspected.status !== 'ready') throw Error('Converter output is not a portable asset: ' + inspected.reason);
        const version = String(JSON.parse(await readFile(receipt, 'utf8')).version).slice(0, 100);
        asset.details = { ...asset.details, ...inspected.details, normalization: { format, sha256: hash(bytes), sourceSha256: asset.sha256, tool: 'blender', version } };
        asset.evidence.push({ source: asset.path, reason: 'Blender conversion preserving available materials/rig/clips; visual and anatomy review required', confidence: 1 });
      }
      if (format === 'png') asset.kind = 'texture';
      asset.status = 'ready'; delete asset.reason; delete job.errors[id]; job.completed++;
    } catch (e) { job.errors[id] = e instanceof Error ? e.message : String(e); }
    await saveImportJob(job);
  }
  job.status = job.selected.some(id => job.errors[id]) ? 'failed' : 'awaiting_selection'; await saveImportJob(job);
}
