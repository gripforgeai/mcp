import { constants } from 'node:fs';
import { readdir, mkdir, readFile, writeFile, rename, realpath, stat, open, access, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { normalizedPath } from './game-import-normalize.js';
import type { ImportAsset, ImportJob, ImportKind, ImportReport } from './game-import-types.js';

const MAX_FILES = 20000, MAX_BYTES = 256 * 1024 * 1024, MAX_JSON = 8 * 1024 * 1024;
const OMIT = new Set(['.git', '.svn', 'node_modules', '.env', '.aws', '.ssh', 'Library', 'Temp', 'Logs', 'obj', '.DS_Store']);
export const importHome = () => process.env.GRIPFORGE_GAME_IMPORT_HOME || join(homedir(), '.gripforge', 'game-imports');
export function jobDirectory(id: string) {
  if (!/^gi_[a-f0-9]{24}$/.test(id)) throw Error('Invalid import id');
  return join(importHome(), id);
}
export async function loadImportJob(id: string): Promise<ImportJob> { return JSON.parse(await readFile(join(jobDirectory(id), 'job.json'), 'utf8')); }
export async function saveImportJob(job: ImportJob) {
  const dir = jobDirectory(job.id); await mkdir(dir, { recursive: true, mode: 0o700 });
  job.updatedAt = new Date().toISOString();
  const tmp = join(dir, `job.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o600 }); await rename(tmp, join(dir, 'job.json'));
  if (job.report) { const report = join(dir, `report.${process.pid}.tmp`); await writeFile(report, JSON.stringify(job.report, null, 2), { mode: 0o600 }); await rename(report, join(dir, 'report.json')); }
}
export async function newImportJob(path: string): Promise<ImportJob> {
  if (!isAbsolute(path)) throw Error('Use an absolute local directory path');
  const root = await realpath(path); if (!(await stat(root)).isDirectory()) throw Error('Source must be a directory');
  if (root === sep || root === homedir()) throw Error('Select the game/project directory, not the whole computer');
  const job: ImportJob = { schema: 'gripforge.game-import-job.v1', id: `gi_${randomBytes(12).toString('hex')}`, root, phase: 'analyze', status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completed: 0, total: 0, receipts: {}, errors: {} };
  await saveImportJob(job); return job;
}
export async function confinedFile(root: string, path: string) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw Error('Unsafe source reference');
  const requested = resolve(root, path), actual = await realpath(requested);
  if (actual !== requested || !actual.startsWith(root + sep)) throw Error('Symlink or external source reference rejected');
  const info = await stat(actual); if (!info.isFile() || info.size > MAX_BYTES) throw Error('File unavailable or exceeds 256 MiB');
  return actual;
}
async function readSource(root: string, path: string) {
  const file = await confinedFile(root, path), handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { const s = await handle.stat(); if (s.size > MAX_BYTES) throw Error('File exceeds 256 MiB'); return await handle.readFile(); } finally { await handle.close(); }
}
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const media = new Set(['.png', '.jpg', '.jpeg', '.webp', '.wav', '.ogg', '.mp3']);
const structured = new Set(['.prefab', '.unity', '.mat', '.asset', '.anim', '.meta', '.cs', '.tscn', '.tres', '.uproject', '.uasset', '.umap', '.pak', '.utoc', '.ucas', '.dll', '.bundle', '.assets', '.fbx', '.obj', '.glb', '.gltf', '.dds', '.tga', '.shader', '.vfx']);
const nameRules: Array<[RegExp, ImportKind, string?]> = [
  [/(^|[\W_])(sword|longsword|katana|axe|rifle|ak47|pistol|shotgun|weapon)([\W_]|$)/i, 'weapon'],
  [/(^|[\W_])(building|house|warehouse|tower)([\W_]|$)/i, 'building'],
  [/(^|[\W_])(vehicle|car|truck|kart)([\W_]|$)/i, 'vehicle'],
  [/(^|[\W_])(character|soldier|hero|npc|enemy)([\W_]|$)/i, 'character'],
  [/(^|[\W_])(terrain|landscape|environment)([\W_]|$)/i, 'environment'],
];
function gltfJSON(bytes: Buffer, ext: string): Record<string, any> {
  if (ext === '.gltf') { if (bytes.length > MAX_JSON) throw Error('glTF JSON exceeds limit'); return JSON.parse(bytes.toString()); }
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length || bytes.readUInt32LE(16) !== 0x4e4f534a) throw Error('Invalid GLB header');
  const len = bytes.readUInt32LE(12); if (len > MAX_JSON || 20 + len > bytes.length) throw Error('Invalid GLB JSON length');
  return JSON.parse(bytes.subarray(20, 20 + len).toString());
}
export function inspectAsset(path: string, bytes: Buffer): ImportAsset {
  const ext = extname(path).toLowerCase(), sha256 = digest(bytes), evidence: ImportAsset['evidence'] = [];
  const a: ImportAsset = { id: `src_${digest(path).slice(0, 24)}`, path, name: basename(path, ext), format: ext.slice(1), bytes: bytes.length, sha256, kind: 'unknown', evidence, status: 'blocked', details: {}, suggestedKits: [] };
  if (['.glb', '.gltf', '.fbx', '.obj'].includes(ext)) {
    a.kind = 'prop'; const rule = nameRules.find(([r]) => r.test(path));
    evidence.push({ source: path, reason: 'Mesh file format; role needs review', confidence: .4 });
    if (rule) { a.kind = rule[1]; evidence.push({ source: path, reason: 'Role suggested by filename, not verified visually', confidence: .55 }); }
    if (ext === '.glb' || ext === '.gltf') {
      try {
        const doc = gltfJSON(bytes, ext); if (doc.asset?.version !== '2.0') throw Error('Requires glTF 2');
        a.details.meshes = doc.meshes?.length ?? 0;
        a.details.materials = (doc.materials ?? []).map((m: any, i: number) => String(m.name ?? `material_${i}`));
        a.details.clips = (doc.animations ?? []).map((m: any, i: number) => String(m.name ?? `clip_${i}`));
        a.details.joints = [...new Set<string>((doc.skins ?? []).flatMap((s: any) => (s.joints ?? []).map((i: number) => String(doc.nodes?.[i]?.name ?? `joint_${i}`))))];
        if (a.details.joints.length) { a.details.rig = 'unclassified'; evidence.push({ source: path, reason: 'glTF skin joints found; anatomy/retargeting not validated', confidence: 1 }); }
        if (!a.details.meshes && a.details.clips?.length) a.kind = 'animation';
        a.details.dependencies = [...(doc.buffers ?? []), ...(doc.images ?? [])].map((b: any) => b.uri).filter((s: unknown): s is string => typeof s === 'string' && !s.startsWith('data:'));
        a.status = ext === '.glb' && !a.details.dependencies.length ? 'ready' : 'convertible';
        if (ext === '.glb' && a.details.dependencies.length) { a.status = 'blocked'; a.reason = 'GLB references external resources; export a self-contained GLB'; }
      } catch (e) { a.reason = String(e); }
    } else a.reason = 'Export to GLB with Blender or the source editor before import';
  } else if (media.has(ext)) {
    const valid = ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ['.jpg','.jpeg'].includes(ext) ? bytes[0] === 255 && bytes[1] === 216 : ext === '.webp' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' : ext === '.wav' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WAVE' : ext === '.ogg' ? bytes.toString('ascii',0,4) === 'OggS' : bytes.toString('ascii',0,3) === 'ID3' || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0;
    a.kind = ['.wav', '.ogg', '.mp3'].includes(ext) ? 'audio' : 'texture';
    a.status = valid ? 'ready' : 'blocked'; if (!valid) a.reason = 'File signature does not match extension';
    evidence.push({ source: path, reason: valid ? 'Media signature verified' : 'Invalid media signature', confidence: 1 });
  } else {
    const kind: Record<string, ImportKind> = { '.prefab': 'scene', '.unity': 'scene', '.umap': 'scene', '.tscn': 'scene', '.mat': 'material', '.anim': 'animation', '.cs': 'script', '.dll': 'script', '.shader': 'script', '.vfx': 'vfx', '.pak': 'container', '.utoc': 'container', '.ucas': 'container', '.assets': 'container', '.bundle': 'container' };
    a.kind = kind[ext] ?? 'unknown'; a.reason = 'Requires an engine exporter or format-specific converter';
  }
  if (a.kind === 'weapon') a.suggestedKits = ['weapons.loadout', 'combat.melee', 'combat.projectiles'];
  if (a.kind === 'vehicle') a.suggestedKits = ['vehicle.driveable', 'vehicle.enter_exit'];
  return a;
}

/** Local orchestration, not a renderer. Source files are never executed or modified. */
export class GameImportAgent {
  constructor(public job: ImportJob) {}
  async cancelled() { try { await access(join(jobDirectory(this.job.id), 'cancel')); return true; } catch { return false; } }
  async checkpoint() { if (await this.cancelled()) { this.job.status = 'cancelled'; await saveImportJob(this.job); throw Error('Import cancelled'); } await saveImportJob(this.job); }
  async discover_assets() {
    const files: string[] = [], warnings: string[] = [], home = await realpath(importHome()), skipHome = !this.job.root.startsWith(home + sep);
    const walk = async (dir: string, depth: number) => {
      if (depth > 32) { warnings.push(`Depth limit: ${relative(this.job.root, dir)}`); return; }
      if (await this.cancelled()) throw Error('Import cancelled');
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (OMIT.has(e.name) || e.name.startsWith('.env') || e.name.startsWith('.')) continue;
        const p = join(dir, e.name); if (skipHome && (p === home || p.startsWith(home + sep))) continue;
        if (e.isSymbolicLink()) { warnings.push(`Skipped symlink: ${relative(this.job.root, p)}`); continue; }
        if (e.isDirectory()) await walk(p, depth + 1);
        else if (e.isFile()) { if (files.length >= MAX_FILES) throw Error('Scan exceeds 20,000 files; select a smaller source directory'); files.push(relative(this.job.root, p).split(sep).join('/')); }
      }
    };
    await walk(this.job.root, 0); return { files: files.sort(), warnings };
  }
  async detect_engine(files: string[]): Promise<ImportReport['engine']> {
    const has = (r: RegExp) => files.find(p => r.test(p));
    const unity = has(/(?:UnityPlayer\.(?:dll|so|dylib)|global-metadata\.dat|ProjectSettings\/ProjectVersion\.txt|(?:^|\/)[^/]+_Data\/)/i);
    const unreal = has(/\.uproject$|\.utoc$|(?:^|\/)Content\/Paks\//i);
    const godot = has(/(?:^|\/)project\.godot$|\.pck$/i);
    const web = has(/(?:^|\/)package\.json$/i);
    const name = unity ? 'unity' : unreal ? 'unreal' : godot ? 'godot' : web ? 'web' : 'unknown';
    const evidence = [{ source: unity ?? unreal ?? godot ?? web ?? '.', reason: name === 'unknown' ? 'No recognized engine marker; do not infer native engine from absence' : 'Engine filesystem marker', confidence: name === 'unknown' ? 0 : web ? .4 : .95 }];
    let version: string | undefined;
    const vf = has(/ProjectSettings\/ProjectVersion\.txt$/i);
    if (vf) version = (await readSource(this.job.root, vf)).toString().match(/m_EditorVersion:\s*(\S+)/)?.[1];
    const uf = has(/\.uproject$/i);
    if (uf) { try { version = JSON.parse((await readSource(this.job.root, uf)).toString()).EngineAssociation; } catch {} }
    return { name, version, runtime: name === 'unity' ? has(/global-metadata\.dat$|GameAssembly\.dll$/i) ? 'IL2CPP' : has(/Managed\/Assembly-CSharp\.dll$/i) ? 'Mono' : 'unknown' : name === 'unreal' ? 'native' : name === 'godot' ? 'GDScript / native (unverified)' : 'unknown', evidence };
  }
  select_toolchain(engine: ImportReport['engine']): ImportReport['toolchain'] {
    const steps: ImportReport['toolchain'] = [{ tool: 'GripForge file importer', purpose: 'Inspect GLB, pack glTF, index images/audio and Unity GUID references', status: 'builtin', reason: 'Known portable formats first' }];
    if (engine.name === 'unity') {
      steps.push({ tool: 'AssetRipper', purpose: 'Export Unity assets through an installed local AssetRipper HTTP instance, then rescan', status: 'external', reason: 'Set GRIPFORGE_ASSETRIPPER_URL to a dedicated loopback instance; external GPL tool, not bundled' });
      steps.push({ tool: 'AssetStudio', purpose: 'Alternative asset exploration/export', status: 'manual', reason: 'Archived original repository; use only for compatible builds' });
      if (engine.runtime === 'IL2CPP') steps.push({ tool: 'Cpp2IL', purpose: 'Recover classes and metadata, not meshes', status: 'external', reason: 'Run an installed version with its documented options in an isolated output directory' });
      else if (engine.runtime === 'Mono') steps.push({ tool: 'ILSpy', purpose: 'Inspect managed controllers; code stays local', status: 'external', reason: 'Optional installed ilspycmd; does not export meshes' });
    } else if (engine.name === 'unreal') steps.push({ tool: 'Unreal editor / GripForge Unreal export', purpose: 'Export an owned project through the existing Unreal scene pipeline', status: 'external', reason: 'Native project path supported; cooked packages require compatible extractor, not direct GLB import' });
    else if (engine.name === 'godot') steps.push({ tool: 'Godot editor', purpose: 'Export source scenes/meshes and inspect resources', status: 'manual', reason: 'PCK archives are indexed, not unpacked by this version' });
    steps.push({ tool: 'Blender', purpose: 'Normalize extracted FBX/OBJ/DDS/TGA through a durable local manufacture worker', status: 'external', reason: 'Configure GRIPFORGE_BLENDER_BIN; preserves available embedded materials/rig/clips, missing resources require a self-contained source export' });
    if (engine.name === 'unknown') steps.push({ tool: 'Ghidra MCP / REA', purpose: 'Investigate unknown formats and document a converter', status: 'external', reason: 'Configure GRIPFORGE_GHIDRA_MCP_URL; use the bounded gripforge_reverse_* abstraction. Fallback only. Analysis is not an asset conversion; no untrusted game code is launched' });
    return steps;
  }
  async analyze_asset_relationships(report: ImportReport) {
    const guids = new Map<string, string>();
    for (const a of report.assets) {
      try { const meta = (await readSource(this.job.root, a.path + '.meta')).toString(); const guid = meta.match(/^guid:\s*([a-f0-9]{32})/m)?.[1]; if (guid) { a.details.guid = guid; if (guids.has(guid)) report.warnings.push(`Duplicate Unity GUID: ${guid}`); else guids.set(guid, a.id); } } catch {}
    }
    for (const a of report.assets) {
      if (!['prefab','unity','mat','asset','anim'].includes(a.format) || a.bytes > MAX_JSON) continue;
      const text = (await readSource(this.job.root, a.path)).toString();
      for (const guid of new Set([...text.matchAll(/guid:\s*([a-f0-9]{32})/g)].map(m => m[1]))) {
        const to = guids.get(guid); if (to && to !== a.id) report.relationships.push({ from: a.id, to, type: 'references', evidence: { source: a.path, reason: `Serialized Unity GUID reference ${guid}`, confidence: 1 } });
      }
    }
  }
  async analyze() {
    const { files, warnings } = await this.discover_assets(), engine = await this.detect_engine(files);
    const candidates = files.filter(p => media.has(extname(p).toLowerCase()) || structured.has(extname(p).toLowerCase())).filter(p => !p.endsWith('.meta'));
    const report: ImportReport = { schema: 'gripforge.game-import.v1', id: this.job.id, source: basename(this.job.root), createdAt: this.job.createdAt, engine, assets: [], relationships: [], counts: {}, warnings, toolchain: this.select_toolchain(engine), normalization: { supported: ['Self-contained GLB preserving PBR/skins/clips', 'glTF 2 with embedded local buffers/images → GLB', 'PNG/JPEG/WebP and WAV/OGG/MP3', 'Installed Blender FBX/OBJ → GLB and DDS/TGA → PNG with persistent provenance'], requiresReview: ['Semantic kind/subtype', 'Skeleton anatomy and retargeting', 'PBR reconstruction for legacy formats', 'LOD and colliders', 'Sockets and Game Kit behavior mapping', 'GripForge renderer visual review before promotion'] } };
    const previous = new Map(this.job.report?.assets.map(a => [a.path, a]) ?? []);
    this.job.report = report; this.job.total = candidates.length; this.job.completed = 0;
    for (const p of candidates) {
      try {
        const bytes = await readSource(this.job.root, p); const old = previous.get(p); const a = old?.sha256 === digest(bytes) ? old : inspectAsset(p, bytes);
        if(a.format==='gltf'&&a.status==='convertible') {
          a.details.resources={};
          try{for(const uri of a.details.dependencies??[]){if(/^[a-z]+:/i.test(uri)||uri.startsWith('/')||uri.includes('\\'))throw Error('External resource URI rejected');const ref=relative(this.job.root,resolve(this.job.root,dirname(p),decodeURIComponent(uri)));a.details.resources[ref]=digest(await readSource(this.job.root,ref));}}
          catch(e){a.status='blocked';a.reason=String(e);}
        }
        report.assets.push(a);
      }
      catch (e) { report.warnings.push(`${p}: ${String(e)}`); }
      this.job.completed++; if (this.job.completed % 10 === 0) await this.checkpoint();
    }
    await this.analyze_asset_relationships(report);
    for (const a of report.assets) report.counts[a.kind] = (report.counts[a.kind] ?? 0) + 1;
    this.job.status = 'awaiting_selection'; await this.checkpoint(); return report;
  }
  async normalize_assets(a: ImportAsset): Promise<{ bytes: Buffer; filename: string }> {
    const bytes = await readSource(this.job.root, a.path); if (digest(bytes) !== a.sha256) throw Error('Source changed after analysis; analyze again');
    if (a.details.normalization) { const n = a.details.normalization; const output = await readFile(normalizedPath(this.job, a.id, n.format)); if (n.sourceSha256 !== a.sha256 || digest(output) !== n.sha256) throw Error('Normalized checkpoint changed; normalize again'); return { bytes: output, filename: basename(a.path, extname(a.path)) + '.' + n.format }; }
    if (a.status === 'blocked') throw Error(a.reason ?? 'Extraction/conversion required');
    if (a.format !== 'gltf') return { bytes, filename: basename(a.path) };
    const doc = gltfJSON(bytes, '.gltf'), chunks: Buffer[] = [], offsets: number[] = []; let total = 0;
    if(doc.extensionsUsed?.includes('EXT_meshopt_compression'))throw Error('meshopt-compressed glTF requires decompression before packing');
    const append = (b: Buffer) => { const offset = total; chunks.push(b); total += b.length; const pad = (4 - total % 4) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); total += pad; } if (total > MAX_BYTES) throw Error('Packed glTF exceeds 256 MiB'); return offset; };
    const resource = async (uri: unknown) => {
      if (typeof uri !== 'string') throw Error('Missing glTF resource URI');
      if (uri.startsWith('data:')) { const m = uri.match(/^data:[^;,]+;base64,([a-zA-Z0-9+/=\s]+)$/); if (!m) throw Error('Unsupported data URI'); return Buffer.from(m[1], 'base64'); }
      if (/^[a-z]+:/i.test(uri) || uri.startsWith('/') || uri.includes('\\')) throw Error('Remote/absolute glTF resources are forbidden');
      // ../ within the selected root is allowed for ordinary exporter layouts; never outside it.
      const p = relative(this.job.root, resolve(this.job.root, dirname(a.path), decodeURIComponent(uri)));
      const data=await readSource(this.job.root,p);if(a.details.resources?.[p]!==digest(data))throw Error('glTF dependency changed after analysis; analyze again');return data;
    };
    for (const b of doc.buffers ?? []) { const content = await resource(b.uri); if (content.length < b.byteLength) throw Error('Truncated glTF buffer'); offsets.push(append(content)); }
    for (const v of doc.bufferViews ?? []) { if (offsets[v.buffer] === undefined) throw Error('Invalid glTF buffer binding'); v.byteOffset = (v.byteOffset ?? 0) + offsets[v.buffer]; v.buffer = 0; }
    for (const image of doc.images ?? []) if (image.uri) {
      const uri = image.uri, content = await resource(uri), mime = uri.startsWith('data:') ? uri.slice(5, uri.indexOf(';')) : /\.png$/i.test(uri) ? 'image/png' : /\.webp$/i.test(uri) ? 'image/webp' : /\.jpe?g$/i.test(uri) ? 'image/jpeg' : null;
      if (!mime) throw Error('Image requires PNG/JPEG/WebP conversion');
      doc.bufferViews ??= []; image.bufferView = doc.bufferViews.length; image.mimeType = mime; doc.bufferViews.push({ buffer: 0, byteOffset: append(content), byteLength: content.length }); delete image.uri;
    }
    doc.buffers = [{ byteLength: total }];
    const json = Buffer.from(JSON.stringify(doc)), padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]), binary = Buffer.concat(chunks);
    const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2,4); header.writeUInt32LE(28 + padded.length + binary.length,8); header.writeUInt32LE(padded.length,12); header.writeUInt32LE(0x4e4f534a,16);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(binary.length); bh.writeUInt32LE(0x004e4942,4);
    return { bytes: Buffer.concat([header,padded,bh,binary]), filename: basename(a.path, '.gltf') + '.glb' };
  }
  async import_to_gripforge(key: string) {
    const job = this.job; if (!job.report || !job.rights || !job.origin || !job.workspace || !job.selected?.length) throw Error('Analysis, selection, workspace and rights basis required');
    const headers = { 'x-api-key': key, 'x-workspace-id': job.workspace, 'x-gripforge-client': 'mcp' };
    const request = async (body: BodyInit, json = false) => {
      for(let attempt=0;attempt<6;attempt++){
        if(await this.cancelled())throw Error('Import cancelled');
        const res = await fetch(job.origin + '/api/v1/game-imports', { method: 'POST', headers: { ...headers, ...(json ? { 'content-type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(120000) });
        const result = await res.json() as any;
        if(res.status===503&&result.code==='import_busy'&&attempt<5){await new Promise(r=>setTimeout(r,Math.min(5000,1000*(attempt+1))));continue;}
        if (!res.ok) throw Error(String(result.error ?? `HTTP ${res.status}`)); return result;
      }
      throw Error('Import persistence lane unavailable; resume later');
    };
    await request(JSON.stringify({ report: job.report, rights: job.rights }), true);
    job.total = job.selected.length; job.completed = job.selected.filter(id => job.receipts[id]).length; await this.checkpoint();
    for (const id of job.selected) {
      if (job.receipts[id]) continue; await this.checkpoint();
      const a = job.report.assets.find(a => a.id === id); if (!a) throw Error('Selected asset not in inventory');
      try {
        const output = await this.normalize_assets(a), form = new FormData();
        form.set('job_id', job.id); form.set('asset_id', a.id); form.set('file', new Blob([new Uint8Array(output.bytes)]), output.filename);
        const result = await request(form); job.receipts[id] = { itemId: result.item.id, revision: result.revision?.revisionId, studioUrl: result.studio_url }; delete job.errors[id]; job.completed++;
      } catch (e) { job.errors[id] = e instanceof Error ? e.message : String(e); }
      await this.checkpoint();
    }
    job.status = job.selected.some(id => !job.receipts[id]) ? 'failed' : 'completed'; await this.checkpoint();
  }
}

/** Exclusive per-job worker lease. Dead workers can be resumed without discarding receipts. */
export async function claimImportJob(id: string) {
  const lock = join(jobDirectory(id), 'worker.lock');
  try { const old = Number(await readFile(lock, 'utf8')); try { process.kill(old, 0); throw Error('A worker is already running for this import'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; } await unlink(lock); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  await writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); return async () => { await unlink(lock).catch(() => {}); };
}
