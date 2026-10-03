import { z } from 'zod/v4';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir, copyFile, realpath, open, unlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unrealLaunchCommand } from './map-unreal-import-local.js';
import { atomicJson, readJson, sha256, buildUnrealStudioPackage, exportFile } from './unreal-export-package.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';

const absolute = z.string().min(1).max(4096).refine(isAbsolute, 'Absolute local path required.').refine(s => !/[\r\n\0"]/.test(s), 'Invalid path.');
const level = z.string().regex(/^\/Game(?:\/[\w-]+)+$/);
const qualities = { texture_size: z.union([z.literal(512), z.literal(1024), z.literal(2048)]).default(1024), terrain_texture_size: z.union([z.literal(1024), z.literal(2048), z.literal(4096)]).default(4096), terrain_resolution: z.union([z.literal(129), z.literal(257), z.literal(513), z.literal(1025)]).default(513) };
const requestSchema = z.object({ schema: z.literal('gripforge.unreal-export-request.v1'), project_file: absolute, source_level: level, source_sha256: z.string().regex(/^[a-f0-9]{64}$/), ...qualities }).strict();
function alive(pid: unknown) { if (typeof pid !== 'number' || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EPERM') return true; if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; return false; } }
async function optionalJson(file: string) { try { return await readJson(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return null; } }
async function withLaunchLock<T>(dir: string, stage: string, task: () => Promise<T>): Promise<T> {
  const file = join(dir, stage + '-launch.lock');
  try { await writeFile(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (alive((await readJson(file)).pid)) throw Error('Another launch request is in progress.');
    await unlink(file); return withLaunchLock(dir, stage, task);
  }
  try { return await task(); } finally { await unlink(file); }
}
export async function prepareUnrealExport(input: { project_file: string; source_level: string; job_directory: string; texture_size?: number; terrain_texture_size?: number; terrain_resolution?: number }) {
  absolute.parse(input.job_directory); absolute.parse(input.project_file); level.parse(input.source_level);
  const project = await realpath(input.project_file); if (!project.endsWith('.uproject')) throw Error('Expected an installed .uproject.');
  const source = join(dirname(project), 'Content', input.source_level.slice(6) + '.umap');
  const request = requestSchema.parse({ schema: 'gripforge.unreal-export-request.v1', project_file: project, source_level: input.source_level, source_sha256: sha256(await readFile(source)), texture_size: input.texture_size, terrain_texture_size: input.terrain_texture_size, terrain_resolution: input.terrain_resolution });
  await mkdir(input.job_directory, { recursive: true }); const dir = await realpath(input.job_directory);
  const previous = await optionalJson(join(dir, 'request.json'));
  if (previous && JSON.stringify(requestSchema.parse(previous)) !== JSON.stringify(request)) throw Error('Job inputs changed. Use a new job directory.');
  if (!previous) await writeFile(join(dir, 'request.json'), JSON.stringify(request), { flag: 'wx' });
  const worker = fileURLToPath(new URL('../runtime/unreal-scene-export.py', import.meta.url)), target = join(dir, 'unreal-scene-export.py');
  try { await copyFile(worker, target, 1); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; if (sha256(await readFile(worker)) !== sha256(await readFile(target))) throw Error('Worker version changed. Prepare a new job directory.'); }
  return { job_directory: dir, request, lifecycle: 'work' };
}
export async function unrealExportStatus(directory: string) {
  absolute.parse(directory); const dir = await realpath(directory); requestSchema.parse(await readJson(join(dir, 'request.json')));
  const result: Record<string, any> = { job_directory: dir, lifecycle: 'work' };
  for (const stage of ['export', 'upload']) {
    const file = stage === 'export' ? 'status.json' : 'upload-status.json', launch = await optionalJson(join(dir, stage + '-launch.json'));
    let state = await optionalJson(join(dir, file));
    if (launch && (!state || launch.started_at > (state.updated_at ?? 0))) state = { ...launch, status: 'running', stage: 'launching' };
    if (!state) { result[stage] = { status: 'pending' }; continue; }
    const running = alive(launch?.pid ?? state.pid);
    if (state.status === 'running' && !running) state = { ...state, status: 'interrupted', error: 'Worker exited. Read its log and resume the saved job; completed steps remain available.' };
    result[stage] = { ...state, worker_running: running };
  }
  if (result.upload.studio_url) result.studio_url = result.upload.studio_url;
  return result;
}
export async function startUnrealExport(directory: string, editor: string) {
  absolute.parse(directory); absolute.parse(editor); const dir = await realpath(directory), executable = await realpath(editor);
  if (!/^UnrealEditor(?:-Cmd)?(?:\.exe)?$/.test(basename(executable))) throw Error('Expected UnrealEditor or UnrealEditor-Cmd executable.');
  return withLaunchLock(dir, 'export', async () => {
    const state = await unrealExportStatus(dir); if (state.export.worker_running || state.export.status === 'succeeded') return state;
    const request = requestSchema.parse(await readJson(join(dir, 'request.json')));
    const source = join(dirname(request.project_file), 'Content', request.source_level.slice(6) + '.umap');
    if (sha256(await readFile(source)) !== request.source_sha256) throw Error('Source level changed. Prepare a new export.');
    const worker = await exportFile(dir, 'unreal-scene-export.py');
    const current = fileURLToPath(new URL('../runtime/unreal-scene-export.py', import.meta.url));
    if (sha256(await readFile(worker)) !== sha256(await readFile(current))) throw Error('Worker changed. Prepare a new job.');
    await atomicJson(join(dir, 'control.json'), { cancel: false });
    const arm = process.platform === 'darwin' && (await promisify(execFile)('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])).stdout.trim() === '1';
    const launch = unrealLaunchCommand(executable, [request.project_file, '-run=pythonscript', '-script=' + worker, '-GFExportJob=' + dir, '-AllowCommandletRendering', '-EnablePlugins=PythonScriptPlugin,EditorScriptingUtilities,GLTFExporter', '-unattended', '-nosplash', '-nosound', '-abslog=' + join(dir, 'export.log')], arm);
    const log = await open(join(dir, 'export-launch.log'), 'a');
    try {
      const child = spawn(launch.command, launch.args, { cwd: dirname(executable), detached: true, shell: false, stdio: ['ignore', log.fd, log.fd] });
      await new Promise<void>((ok, bad) => { child.once('spawn', ok); child.once('error', bad); }); child.unref();
      await atomicJson(join(dir, 'export-launch.json'), { pid: child.pid, started_at: Date.now() / 1000 });
      return { job_directory: dir, status: 'running', stage: 'launching', pid: child.pid, next: 'Poll gripforge_map_unreal_export_status_local. No source level/assets will be saved.' };
    } finally { await log.close(); }
  });
}
function apiOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw Error('Use an HTTPS API origin, or HTTP loopback for local development.');
  return url.origin;
}
async function api(url: string, key: string, workspace: string, path: string, method = 'GET', body?: string | Buffer, headers: Record<string, string> = {}) {
  const response = await fetch(url + path, { method, redirect: 'error', headers: { 'x-api-key': key, 'x-workspace-id': workspace, 'x-gripforge-client': 'mcp', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : new Uint8Array(body) }), signal: AbortSignal.timeout(120000) });
  const data = await response.json() as Record<string, any>;
  if (!response.ok) throw Error('GripForge API ' + response.status + ': ' + JSON.stringify(data).slice(0, 1500));
  return data;
}
/** Runs in a detached Node worker. The credential is inherited in memory, never persisted in its checkpoints. */
export async function uploadUnrealExport(directory: string, origin: string, workspace: string, key: string) {
  const dir = await realpath(directory), url = apiOrigin(origin), scope = sha256(url + ':' + workspace), stateFile = join(dir, 'upload-status.json');
  let state: Record<string, any> = await optionalJson(stateFile) ?? {};
  if (state.scope && state.scope !== scope) throw Error('Upload job belongs to another workspace or API origin. Use a separate copy of the export.');
  state = { ...state, scope, workspace_id: workspace, api_origin: url, status: 'running', pid: process.pid, lifecycle: 'work', updated_at: Date.now() / 1000, uploaded: state.uploaded ?? {} };
  const progress = async (stage: string) => { state.stage = stage; state.updated_at = Date.now() / 1000; await atomicJson(stateFile, state); };
  const checkCancel = async () => {
    if ((await optionalJson(join(dir, 'upload-control.json')))?.cancel) {
      if (state.job_id) await api(url, key, workspace, '/api/v1/generation-jobs/' + encodeURIComponent(state.job_id), 'POST', JSON.stringify({ action: 'cancel' }), { 'content-type': 'application/json' });
      throw Error('Upload cancelled; completed assets retained.');
    }
  };
  try {
    await progress('assembling'); await checkCancel();
    const portable = await buildUnrealStudioPackage(dir), hash = portable.manifest.sceneHash;
    if (state.scene_hash && state.scene_hash !== hash) throw Error('Portable scene changed during upload. Use a new job.');
    state.scene_hash = hash; state.total = portable.manifest.assets.length;
    for (const file of portable.manifest.assets) {
      await checkCancel(); if (state.uploaded[file.sha256]) continue;
      state.file = file.name; state.completed = Object.keys(state.uploaded).length; await progress('uploading_assets');
      const bytes = await readFile(await exportFile(dir, file.file)); if (sha256(bytes) !== file.sha256) throw Error('Export changed: ' + file.file);
      const response = await api(url, key, workspace, '/api/v1/maps/import/unreal/assets', 'POST', bytes, { 'content-type': file.mime, 'x-asset-filename': basename(file.file), 'x-content-sha256': file.sha256 });
      if (response.sha256 !== file.sha256 || !response.asset?.assetId || !response.asset?.revisionId) throw Error('Unexpected asset upload response.');
      state.uploaded[file.sha256] = response.asset; await progress('uploading_assets');
    }
    await checkCancel();
    const refs = new Map(portable.manifest.assets.map(a => [a.assetId + ':' + a.revisionId, state.uploaded[a.sha256]]));
    const replaceRefs = (v: any): any => {
      if (!v || typeof v !== 'object') return v;
      if (typeof v.assetId === 'string' && typeof v.revisionId === 'string') { const ref = refs.get(v.assetId + ':' + v.revisionId); if (!ref) throw Error('Unresolved asset reference.'); return { ...ref, ...(v.fileRole ? { fileRole: v.fileRole } : {}) }; }
      return Array.isArray(v) ? v.map(replaceRefs) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceRefs(x)]));
    };
    const input = replaceRefs(portable.input); input.document.workspaceId = workspace; input.idempotency_key = 'ue-import-' + hash;
    await progress('queueing_import');
    if (!state.job_id) {
      const response = await api(url, key, workspace, '/api/v1/maps/import/unreal', 'POST', JSON.stringify(input), { 'content-type': 'application/json' });
      if (typeof response.job_id !== 'string') throw Error('Missing persistent import job.'); state.job_id = response.job_id; await progress('saving_scene');
    }
    let first = true;
    for (;;) {
      await checkCancel();
      const response = await api(url, key, workspace, '/api/v1/generation-jobs/' + encodeURIComponent(state.job_id)), job = response.job ?? response;
      if (job.status === 'failed' || job.status === 'cancelled') {
        if (!first) throw Error('Import job ' + job.status + ': ' + String(job.error ?? 'Read generation_read for details.'));
        await api(url, key, workspace, '/api/v1/generation-jobs/' + encodeURIComponent(state.job_id), 'POST', JSON.stringify({ action: 'retry' }), { 'content-type': 'application/json' });
      } else if (job.status === 'succeeded') {
        if (!job.result?.studio_url) throw Error('Import completed without a Studio link.');
        Object.assign(state, { status: 'succeeded', result: job.result, studio_url: new URL(job.result.studio_url, url).href, completed: state.total });
        await progress('awaiting_visual_review'); return state;
      }
      first = false; state.remote_status = job.status; await progress('saving_scene'); await new Promise(ok => setTimeout(ok, 3000));
    }
  } catch (e) {
    state.status = (await optionalJson(join(dir, 'upload-control.json')))?.cancel ? 'cancelled' : 'failed'; state.error = e instanceof Error ? e.message : String(e); await progress(state.stage); throw e;
  }
}
export async function startUnrealUpload(directory: string, origin: string, workspace: string, key: string) {
  if (!key) throw Error('Connect a GripForge API key before uploading.');
  absolute.parse(directory); z.string().regex(/^[\w-]{1,100}$/).parse(workspace); const url = apiOrigin(origin), dir = await realpath(directory);
  return withLaunchLock(dir, 'upload', async () => {
    const status = await unrealExportStatus(dir); if (status.export.status !== 'succeeded') throw Error('Wait for a successful native export.');
    if (status.upload.scope && status.upload.scope !== sha256(url + ':' + workspace)) throw Error('Job already belongs to another workspace/API.');
    if (status.upload.worker_running || status.upload.status === 'succeeded') return status;
    await atomicJson(join(dir, 'upload-control.json'), { cancel: false });
    const log = await open(join(dir, 'upload.log'), 'a');
    try {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/unreal-scene-upload.mjs', import.meta.url)), dir, url, workspace], { detached: true, shell: false, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, GRIPFORGE_API_KEY: key } });
      await new Promise<void>((ok, bad) => { child.once('spawn', ok); child.once('error', bad); }); child.unref();
      await atomicJson(join(dir, 'upload-launch.json'), { pid: child.pid, started_at: Date.now() / 1000 });
      return { job_directory: dir, status: 'running', stage: 'uploading', next: 'Poll gripforge_map_unreal_export_status_local for progress and studio_url.' };
    } finally { await log.close(); }
  });
}
export function registerMapUnrealExportLocalTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }) {
  const job = { job_directory: absolute.describe('Persistent local export directory; retain it to resume completed stages.') };
  const wrap = (f: (a: Record<string, any>) => Promise<Record<string, unknown>>) => async (a: Record<string, any>) => { try { const data = await f(a); return { structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] }; } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] }; } };
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  register('gripforge_map_unreal_export_local', { title: 'Export an Unreal map to GripForge', description: 'Generic local UE 5.7 exporter. Pins the selected saved map and runs a separate Unreal Python commandlet without saving source assets. Exports PBR GLBs, all supported static placements, compact foliage patches, Landscape height/holes and baked albedo. Durable per-file checkpoints survive closed MCP calls. Native shader graphs, animated water/sky, Niagara and gameplay Blueprints are reported, not silently recreated. Work version requires visual review in GripForge. Local MCP only; Unreal/Python/GLTFExporter must be installed.', inputSchema: { project_file: absolute, source_level: level, editor_executable: absolute, ...job, ...qualities }, annotations }, wrap(async a => { const prepared = await prepareUnrealExport(a as Parameters<typeof prepareUnrealExport>[0]); return startUnrealExport(prepared.job_directory, String(a.editor_executable)); }));
  register('gripforge_map_unreal_export_status_local', { title: 'Read Unreal export/upload progress', description: 'Read durable stages, failures, completed assets and final GripForge Studio link. Does not equate technical export success with visual validation.', inputSchema: job, annotations: { ...annotations, readOnlyHint: true } }, wrap(a => unrealExportStatus(String(a.job_directory))));
  register('gripforge_map_unreal_export_cancel_local', { title: 'Cancel an Unreal export or upload', description: 'Request cancellation at the next safe asset checkpoint. Keeps completed files and uploaded private assets; resume with export_local or upload_local using the same directory. Never kills an unrelated Unreal editor.', inputSchema: { ...job, stage: z.enum(['export', 'upload']) }, annotations }, wrap(async a => { const state = await unrealExportStatus(String(a.job_directory)); await atomicJson(join(state.job_directory, a.stage === 'export' ? 'control.json' : 'upload-control.json'), { cancel: true }); return { cancel_requested: true, stage: a.stage, job_directory: state.job_directory }; }));
  register('gripforge_map_unreal_upload_local', { title: 'Import exported Unreal map into your workspace', description: 'Assemble a completed native export as a common SceneDocument, upload immutable assets to the authenticated workspace and queue a persistent API import. Detached upload resumes per-file checkpoints. Poll export_status_local for studio_url. Private work only, never auto-promotes or publishes. 0 generation credits; workspace storage quota applies.', inputSchema: { ...job, workspace_id: z.string().regex(/^[\w-]{1,100}$/) }, annotations }, wrap(a => startUnrealUpload(String(a.job_directory), options.apiUrl, String(a.workspace_id), options.getApiKey() ?? '')));
}
