import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, stat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';

export const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
export async function atomicJson(file: string, value: unknown) { const tmp = file + '.' + process.pid + '.tmp'; await writeFile(tmp, JSON.stringify(value)); await rename(tmp, file); }
export async function readJson(file: string) { if ((await stat(file)).size > 64 * 1024 * 1024) throw Error('Manifest exceeds 64 MB.'); return JSON.parse(await readFile(file, 'utf8')); }
export async function exportFile(dir: string, file: string) {
  const root = await realpath(dir), path = await realpath(resolve(root, file));
  if (!path.startsWith(root + sep)) throw Error('Export file escapes its job directory.');
  return path;
}
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
function crc32(data: Buffer) { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
/** Native RGBA8 data, without gamma conversion (height is packed in RG). */
export function decodeExportPng(bytes: Buffer) {
  if (!bytes.subarray(0, 8).equals(signature)) throw Error('Invalid PNG signature.');
  let width = 0, height = 0, channels = 0, ended = false; const parts: Buffer[] = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at), end = at + length + 12;
    if (end > bytes.length) throw Error('Truncated PNG.');
    const type = bytes.toString('ascii', at + 4, at + 8), data = bytes.subarray(at + 8, end - 4);
    if (crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw Error('PNG checksum mismatch.');
    if (type === 'IHDR') {
      if (width || length !== 13 || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) throw Error('Expected non-interlaced RGB/RGBA8 PNG.');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3;
      if (!width || !height || width > 8192 || height > 8192) throw Error('PNG dimensions exceed export budget.');
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') { ended = true; break; }
    at = end;
  }
  if (!width || !ended) throw Error('Incomplete PNG.');
  const stride = width * channels, expected = (stride + 1) * height, raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected });
  if (raw.length !== expected) throw Error('Invalid PNG data length.');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; if (filter > 4) throw Error('Invalid PNG filter.');
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? pixels[at - channels] : 0, b = y ? pixels[at - stride] : 0, c = y && x >= channels ? pixels[at - stride - channels] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      pixels[at] = raw[y * (stride + 1) + x + 1] + (filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
    }
  }
  return { width, height, channels, pixels };
}
export function encodeExportPng(width: number, height: number, pixels: Buffer, channels = 4) {
  const chunk = (name: string, data: Buffer) => { const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); out.write(name, 4); data.copy(out, 8); out.writeUInt32BE(crc32(out.subarray(4, out.length - 4)), out.length - 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  const stride = width * channels, scan = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) pixels.copy(scan, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
}

type Vec = { x: number; y: number; z: number };
type Transform = { translation: Vec; rotation: Vec & { w: number }; scale: Vec };
type NativeFile = { file: string; sha256: string; bytes: number };
type NativeTerrain = { id: string; heightmap: NativeFile; albedo: NativeFile; visibility?: NativeFile; width: number; height: number; base: number[]; components: number[][]; component_quads: number; origin: number[]; scale: number[]; albedo_span_cm: number; material: string };
const vec = (x = 0, y = 0, z = 0) => ({ x, y, z });
const identity = (): Transform => ({ translation: vec(), rotation: { ...vec(), w: 1 }, scale: vec(1, 1, 1) });
const base = (id: string, name = id) => ({ id, name, parentId: null as string | null, transform: identity(), visible: true, locked: false });
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const refFor = (file: NativeFile) => ({ assetId: 'ue_' + file.sha256.slice(0, 24), revisionId: 'rev_' + file.sha256.slice(0, 24) });
type PortableAsset = NativeFile & ReturnType<typeof refFor> & { name: string; kind: string; mime: string };

export function decodeUnrealTerrain(t: NativeTerrain, bytes: Buffer, resolution: number, visibility?: Buffer) {
  const png = decodeExportPng(bytes), mask = visibility ? decodeExportPng(visibility) : undefined;
  if (png.width !== t.width || png.height !== t.height || mask && (mask.width !== t.width || mask.height !== t.height)) throw Error('Landscape grid does not match its PNG.');
  const spanX = t.width - 1, spanZ = t.height - 1, longest = Math.max(spanX, spanZ), sx = Math.max(1, Math.round((resolution - 1) * spanX / longest)), sz = Math.max(1, Math.round((resolution - 1) * spanZ / longest));
  const q = t.component_quads, occupied = new Set(t.components.map(([x, y]) => x + ':' + y));
  const present = (x: number, z: number) => occupied.has((Math.floor((t.base[0] + Math.min(spanX - .00001, Math.max(0, x))) / q) * q) + ':' + (Math.floor((t.base[1] + Math.min(spanZ - .00001, Math.max(0, z))) / q) * q));
  const hidden = (x: number, z: number) => mask ? mask.pixels[(Math.round(z) * mask.width + Math.round(x)) * mask.channels] >= 128 : false;
  const sample = (x: number, z: number) => { const at = (Math.min(t.height - 1, Math.max(0, z)) * t.width + Math.min(t.width - 1, Math.max(0, x))) * png.channels; return (png.pixels[at] * 256 + png.pixels[at + 1] - 32768) / 128 * t.scale[2] * .01; };
  const heights: number[] = [], holes: number[] = [];
  for (let z = 0; z <= sz; z++) for (let x = 0; x <= sx; x++) {
    const px = x / sx * spanX, pz = z / sz * spanZ, ix = Math.floor(px), iz = Math.floor(pz), u = px - ix, v = pz - iz;
    const a = sample(ix, iz) * (1 - u) + sample(ix + 1, iz) * u, b = sample(ix, iz + 1) * (1 - u) + sample(ix + 1, iz + 1) * u;
    heights.push(present(px, pz) ? Math.round((a * (1 - v) + b * v) * 1000) / 1000 : 0);
  }
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    let hole = false;
    // Every source sample overlapped by this quad is checked, so small painted holes survive downsampling.
    for (let j = Math.floor(z / sz * spanZ); j <= Math.ceil((z + 1) / sz * spanZ) && !hole; j++) for (let i = Math.floor(x / sx * spanX); i <= Math.ceil((x + 1) / sx * spanX); i++) if (!present(i, j) || hidden(i, j)) { hole = true; break; }
    holes.push(hole ? 1 : 0);
  }
  return { size: [spanX * t.scale[0] * .01, spanZ * t.scale[1] * .01], segments: [sx, sz], heights, holes,
    center: vec((t.origin[0] + (t.base[0] + spanX / 2) * t.scale[0]) * .01, t.origin[2] * .01, (t.origin[1] + (t.base[1] + spanZ / 2) * t.scale[1]) * .01) };
}

export async function buildUnrealStudioPackage(directory: string) {
  const dir = await realpath(directory), manifest = await readJson(resolve(dir, 'native.json')), request = await readJson(resolve(dir, 'request.json'));
  if (manifest.schema !== 'gripforge.unreal-export.v1' || manifest.status !== 'exported-awaiting-gripforge-review' || sha256(await readFile(resolve(dir, 'request.json'))) !== manifest.request_hash) throw Error('Native export must finish successfully before assembly.');
  const assets: PortableAsset[] = [], nodes: Record<string, any>[] = [], assetRefs = new Map<string, ReturnType<typeof refFor>>();
  async function addFile(file: NativeFile, name: string, kind: string, mime: string) {
    const path = await exportFile(dir, file.file), bytes = await readFile(path);
    if (bytes.length > 128 * 1024 * 1024 || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw Error('Changed or oversized export: ' + file.file);
    const ref = refFor(file);
    if (!assets.some(a => a.sha256 === file.sha256)) assets.push({ ...file, ...ref, name, kind, mime });
    return ref;
  }
  for (const [key, file] of Object.entries(manifest.assets) as [string, NativeFile & { name: string }][]) assetRefs.set(key, await addFile(file, file.name, 'prop', 'model/gltf-binary'));
  nodes.push({ ...base('props', 'Props & buildings'), type: 'group' }, { ...base('vegetation', 'Vegetation'), type: 'group' }, { ...base('terrain', 'Terrain'), type: 'group' });
  const batches = new Map<string, Record<string, any>>();
  let zeroScaleInstances = 0;
  for (const instance of manifest.instances as { id: string; name: string; source: string; asset: string; batch: boolean; transform: Transform }[]) {
    const asset = assetRefs.get(instance.asset); if (!asset) throw Error('Missing exported mesh: ' + instance.asset);
    const t = instance.transform, p = t.translation, q = t.rotation, s = t.scale;
    // Unreal foliage retains removed placements as zero-scale tombstones. They have no visible geometry.
    if ([s.x, s.y, s.z].every(n => n === 0)) { zeroScaleInstances++; continue; }
    const row = [p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z].map(round);
    if (!row.every(Number.isFinite) || Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) > .001 || [s.x, s.y, s.z].some(n => Math.abs(n) < .00001)) throw Error('Invalid native transform: ' + instance.id);
    if (instance.batch && [s.x, s.y, s.z].every(n => n > 0)) {
      const cx = Math.floor(p.x / 64), cz = Math.floor(p.z / 64), prefix = instance.asset + ':' + cx + ':' + cz;
      let part = 0, key = prefix;
      while ((batches.get(key)?.instanceBatch.ids.length ?? 0) >= 4096) key = prefix + ':' + (++part);
      if (!batches.has(key)) {
        const b = { ...base('batch_' + sha256(key).slice(0, 24), instance.name.slice(0, 110) + ` [${cx},${cz}]`), type: 'asset', parentId: 'vegetation', asset, role: 'vegetation', materials: {}, parameters: { source: 'unreal-instancing' }, instanceBatch: { ids: [] as string[], transforms: [] as number[][] } };
        batches.set(key, b); nodes.push(b);
      }
      const b = batches.get(key)!; b.instanceBatch.ids.push(instance.id); b.instanceBatch.transforms.push(row);
    } else nodes.push({ ...base(instance.id, instance.name), type: 'asset', parentId: instance.batch ? 'vegetation' : 'props', asset, role: 'prop', transform: t, materials: {}, parameters: { unrealSource: instance.source } });
  }
  let overview: { center: Vec; size: number[] } | undefined;
  for (const t of manifest.terrains as NativeTerrain[]) {
    await addFile(t.heightmap, t.id + ' source height', 'texture', 'image/png');
    if (t.visibility) await addFile(t.visibility, t.id + ' source holes', 'texture', 'image/png');
    const terrain = decodeUnrealTerrain(t, await readFile(await exportFile(dir, t.heightmap.file)), request.terrain_resolution ?? 513, t.visibility ? await readFile(await exportFile(dir, t.visibility.file)) : undefined);
    let albedo = t.albedo;
    if (Math.abs(terrain.size[0] - terrain.size[1]) > .001) {
      const source = decodeExportPng(await readFile(await exportFile(dir, albedo.file)));
      const w = Math.max(1, Math.round(source.width * terrain.size[0] / (t.albedo_span_cm * .01))), h = Math.max(1, Math.round(source.height * terrain.size[1] / (t.albedo_span_cm * .01))), data = Buffer.alloc(w * h * source.channels);
      if (w > source.width || h > source.height) throw Error('Invalid Landscape albedo extent.');
      const ox = Math.floor((source.width - w) / 2), oy = Math.floor((source.height - h) / 2);
      for (let y = 0; y < h; y++) source.pixels.copy(data, y * w * source.channels, ((y + oy) * source.width + ox) * source.channels, ((y + oy) * source.width + ox + w) * source.channels);
      const bytes = encodeExportPng(w, h, data, source.channels), file = t.id + '-albedo-cropped.png'; await writeFile(resolve(dir, file), bytes); albedo = { file, bytes: bytes.length, sha256: sha256(bytes) };
    }
    const map = await addFile(albedo, t.id + ' albedo', 'texture', 'image/png');
    nodes.push({ ...base('terrain_' + sha256(t.id).slice(0, 24), t.id), type: 'terrain', parentId: 'terrain', transform: { ...identity(), translation: terrain.center }, size: terrain.size, segments: terrain.segments, heights: terrain.heights, holes: terrain.holes, layers: [], material: { color: '#ffffff', roughness: 1, metalness: 0, map } });
    overview ??= terrain;
  }
  const placements = manifest.instances as { transform: Transform }[];
  if (!overview && placements.length) {
    const axes = ['x', 'y', 'z'] as const, min = axes.map(k => Math.min(...placements.map(p => p.transform.translation[k]))), max = axes.map(k => Math.max(...placements.map(p => p.transform.translation[k])));
    overview = { center: vec(...min.map((v, i) => (v + max[i]) / 2) as [number, number, number]), size: [Math.max(10, max[0] - min[0]), Math.max(10, max[2] - min[2])] };
  }
  if (!overview) throw Error('Nothing portable was found in the selected map.');
  const center = overview.center, span = Math.max(...overview.size), sun = manifest.environment.sun ?? [1, 2, 1];
  nodes.push({ ...base('environment', 'Environment (portable approximation)'), type: 'environment', preset: 'outdoor', background: '#9dc4e1', intensity: .8, exposure: 1, rotation: 0, fog: null, sky: { mode: 'physical', sun: vec(...sun as [number, number, number]), turbidity: 3, rayleigh: 1.5, intensity: .8 } });
  nodes.push({ ...base('camera_overview', 'Overview'), type: 'camera', projection: 'perspective', transform: { ...identity(), translation: vec(center.x + span * .55, center.y + span * .7, center.z + span * .65) }, target: center, fov: 55, near: .1, far: Math.max(3000, span * 6), zoom: 1 });
  for (const [i, c] of (manifest.cameras as { name: string; position: number[]; target: number[]; fov: number }[]).entries()) nodes.push({ ...base('camera_native_' + i, c.name.slice(0, 160)), type: 'camera', projection: 'perspective', transform: { ...identity(), translation: vec(...c.position as [number, number, number]) }, target: vec(...c.target as [number, number, number]), fov: Math.min(175, Math.max(1, c.fov)), near: .1, far: Math.max(3000, span * 6), zoom: 1 });
  const warnings = [...manifest.warnings, 'Repeated foliage is editable by spatial patch. Member IDs and transforms are retained; per-blade gizmos are not implemented.', 'Portable environment lighting is an approximation; compare against Unreal before validation.'];
  if (zeroScaleInstances) warnings.push(`${zeroScaleInstances} zero-scale native placements have no visible geometry and were omitted; their original transforms remain in native.json.`);
  const document = { schemaVersion: 1, id: 'unreal_' + manifest.request_hash.slice(0, 24), workspaceId: 'local-preview', name: manifest.project + ' — ' + manifest.source_level.split('/').pop(), purpose: 'map', revision: 0, nodes, activeCameraId: 'camera_overview', metadata: { unrealSource: { level: manifest.source_level, sha256: manifest.source_sha256, omitted: manifest.omitted }, lifecycle: 'work', warnings } };
  const input = { schema: 'gripforge.unreal-studio-import.v1', source: { engine: 'unreal', level: manifest.source_level, sha256: manifest.source_sha256, warnings }, document };
  if (nodes.length > 20000 || Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024) throw Error('Portable scene exceeds the Studio budget; export smaller regions.');
  await atomicJson(resolve(dir, 'scene.json'), document);
  const portable = { schema: 'gripforge.scene-package.v1', scene: 'scene.json', sceneHash: sha256(JSON.stringify(document)), assets, cameras: ['camera_overview', ...nodes.filter(n => n.id.startsWith('camera_native_')).map(n => n.id)], source: input.source, instanceCount: manifest.instances.length - zeroScaleInstances, zeroScaleInstances, nodeCount: nodes.length, lifecycle: 'work' };
  await atomicJson(resolve(dir, 'manifest.json'), portable);
  return { directory: dir, input, manifest: portable };
}
