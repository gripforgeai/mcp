import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { isDeepStrictEqual } from 'node:util';
import type { VfxProjectRegister } from './vfx-project-tools.js';

const absolute = z.string().max(4096).refine(isAbsolute, 'Expected an absolute local path.');
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const assetPath = z.string().regex(/^\/(Game|Engine)(?:\/[a-zA-Z0-9_-]+)+$/);
const outputPath = z.string().regex(/^\/Game\/GripForge\/Maps\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/);
const scalar = z.number().finite();
const vec3 = z.object({ x: scalar, y: scalar, z: scalar });
const transform = z.object({ translation: vec3, rotation: vec3.extend({ w: scalar }), scale: vec3 });
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const triple = z.tuple([scalar, scalar, scalar]);
const spawnReviewDefaults = { enabled: true, duration_seconds: 6, tolerance_cm: 200, require_grounded: true };
// Image files are pinned just like meshes. Native paths remain supported for project-owned materials.
const textureFile = z.object({
  assetId: id, revisionId: id, fileRole: id.optional(),
  file: absolute.refine(s => /\.(png|jpe?g)$/i.test(s), 'Portable textures require PNG or JPEG files.'), sha256: sha,
}).strict();
const texture = z.union([assetPath, textureFile]);
const sourceSchema = z.object({
  assetId: id, revisionId: id, kind: z.enum(['native_mesh', 'native_actor', 'glb']),
  path: assetPath.optional(), file: absolute.optional(), sha256: sha,
  pivot: z.enum(['source', 'bounds_base']).default('source'), origin: triple.optional(), extent: triple.optional(),
}).superRefine((a, ctx) => {
  if (a.kind === 'glb' ? !a.file || !/\.glb$/i.test(a.file) : !a.path?.startsWith('/Game/')) ctx.addIssue({ code: 'custom', message: 'GLB requires file; native sources require a /Game package path.' });
  if (a.pivot === 'bounds_base' && (!a.origin || !a.extent || a.extent.some(n => n <= 0))) ctx.addIssue({ code: 'custom', message: 'bounds_base requires inspected native bounds in centimetres.' });
});
const nodeSchema = z.object({
  id, name: z.string().max(1024), type: z.enum(['asset', 'group', 'terrain', 'primitive', 'region', 'path', 'zone', 'camera', 'environment', 'light']),
  parentId: id.nullable(), transform, visible: z.boolean(), locked: z.boolean(),
}).passthrough();

/** Portable, versioned delivery binding. The SceneDocument remains the source of instance data. */
export const unrealScenePlanSchema = z.object({
  schema: z.literal('gripforge.unreal-scene.v1'), project_file: absolute.refine(s => /\.uproject$/i.test(s)),
  target_level: outputPath, asset_folder: outputPath,
  document: z.object({ schemaVersion: z.literal(1), id, name: z.string(), purpose: z.literal('map'), nodes: z.array(nodeSchema).min(1).max(20000), metadata: z.record(z.string(), z.unknown()).default({}) }).passthrough(),
  assets: z.array(sourceSchema).max(5000),
  terrains: z.array(z.object({ nodeId: id, assetId: id, revisionId: id })).default([]),
  materials: z.array(z.object({
    id, color: hex.default('#ffffff'), roughness: scalar.min(0).max(1).default(.8), metalness: scalar.min(0).max(1).default(0),
    textures: z.object({ color: texture.optional(), normal: texture.optional(), roughness: texture.optional(), metalness: texture.optional(), emissive: texture.optional(), ao: texture.optional() }).default({}),
    repeat: z.tuple([scalar.min(.001).max(10000),scalar.min(.001).max(10000)]).default([1,1]),
    normal_format: z.enum(['opengl','directx']).default('opengl'),
    emissive: hex.optional(), emissive_intensity: scalar.min(0).max(100).default(0), unlit: z.boolean().default(false),
    vertex_colors:z.boolean().default(false),
  })).default([]),
  material_bindings: z.array(z.object({ nodeId: id, slot: z.number().int().min(0).max(63).default(0), materialId: id })).default([]),
  collision: z.record(z.string(), z.enum(['none', 'source', 'complex'])).default({}),
  actor_properties: z.record(id, z.record(z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/), z.union([scalar,z.boolean(),z.string().max(512)]))).default({}),
  niagara_overrides:z.array(z.object({nodeId:id,system:assetPath,colors:z.record(z.string().min(1).max(128).regex(/^User\.[^\x00-\x1f\x7f]+$/),z.object({color:hex,intensity:scalar.min(0).max(100).default(1)}))})).max(32).default([]),
  vfx_previews:z.array(z.object({nodeId:id,warmup_seconds:scalar.min(0).max(5).default(1),hide_static_meshes:z.boolean().default(false)})).max(16).default([]),
  environment: z.object({ sun_lux: scalar.min(0).max(150000).default(8), sky_intensity: scalar.min(0).max(20).default(1), fog_density: scalar.min(0).max(.1).default(.001), exposure_ev100: scalar.min(-10).max(20).default(1), bloom_intensity: scalar.min(0).max(10).default(.25) }).default({ sun_lux: 8, sky_intensity: 1, fog_density: .001, exposure_ev100: 1, bloom_intensity: .25 }),
  gameplay: z.object({
    game_mode: z.string().regex(/^\/(?:Game|Script)\/[a-zA-Z0-9_/.]+$/).optional(),
    player_starts: z.array(z.object({ nodeId: id, offset: vec3.default({x:0,y:1,z:0}) })).default([]),
    spawn_review: z.object({
      enabled: z.boolean().default(true), duration_seconds: scalar.min(2).max(15).default(6),
      tolerance_cm: scalar.min(10).max(500).default(200), require_grounded: z.boolean().default(true),
    }).strict().default(spawnReviewDefaults),
  }).default({player_starts:[],spawn_review:spawnReviewDefaults}),
  capture: z.object({ camera_ids: z.array(id).max(16).default([]), width: z.number().int().min(320).max(3840).default(1600), height: z.number().int().min(240).max(2160).default(900) }).default({camera_ids:[],width:1600,height:900}),
}).strict();
export type UnrealScenePlan = z.infer<typeof unrealScenePlanSchema>;
type UnrealMaterial = UnrealScenePlan['materials'][number];
export type PortableSceneTexture = z.infer<typeof textureFile>;
const textureChannels = {color:'map',normal:'normalMap',roughness:'roughnessMap',metalness:'metalnessMap',emissive:'emissiveMap',ao:'aoMap'} as const;
const textureKey = (t:PortableSceneTexture) => JSON.stringify([t.assetId,t.revisionId,t.fileRole??'main']);

/** Common material values for the Studio, with image files resolved by the normal SceneAssetResolver. */
export function unrealMaterialToScene(m:UnrealMaterial): Record<string,unknown> {
  const result:Record<string,unknown>={color:m.color,roughness:m.roughness,metalness:m.metalness,repeat:m.repeat,vertexColors:m.vertex_colors};
  if(m.emissive)Object.assign(result,{emissive:m.emissive,emissiveIntensity:m.emissive_intensity});
  for(const [channel,key] of Object.entries(textureChannels)){
    const t=m.textures[channel as keyof typeof textureChannels];
    if(t&&typeof t!=='string')result[key]={assetId:t.assetId,revisionId:t.revisionId,...(t.fileRole?{fileRole:t.fileRole}:{})};
  }
  if(result.normalMap)result.normalScale=[1,m.normal_format==='directx'?-1:1];
  return result;
}

export function portableSceneTextures(p:UnrealScenePlan):PortableSceneTexture[] {
  const found=new Map<string,PortableSceneTexture>();
  for(const m of p.materials)for(const t of Object.values(m.textures)){
    if(typeof t==='string')continue;
    const key=textureKey(t),previous=found.get(key);
    if(previous && (previous.sha256!==t.sha256 || previous.file!==t.file))throw Error('Conflicting texture revision binding: '+t.assetId);
    found.set(key,t);
  }
  return [...found.values()];
}

export function validateUnrealScenePlan(value: unknown): UnrealScenePlan {
  const p = unrealScenePlanSchema.parse(value), nodes = new Map(p.document.nodes.map(n => [n.id,n]));
  if (nodes.size !== p.document.nodes.length) throw Error('Duplicate scene node IDs.');
  if (p.target_level === p.asset_folder || p.asset_folder.startsWith(p.target_level + '/')) throw Error('Level package and asset folder must be separate.');
  const sources = new Map(p.assets.map(a => [JSON.stringify([a.assetId,a.revisionId]),a]));
  if (sources.size !== p.assets.length) throw Error('Duplicate asset revision binding.');
  const terrains = new Map(p.terrains.map(t => [t.nodeId,t]));
  if (terrains.size !== p.terrains.length) throw Error('Duplicate terrain binding.');
  const materials = new Set(p.materials.map(m => m.id));
  if (materials.size !== p.materials.length) throw Error('Duplicate material ID.');
  for(const t of portableSceneTextures(p))if(sources.has(JSON.stringify([t.assetId,t.revisionId])))throw Error('Texture and mesh revisions must be separate assets.');
  const assetRef = z.object({assetId:id,revisionId:id});
  for (const n of nodes.values()) {
    const q = n.transform.rotation, s = n.transform.scale;
    if (Math.hypot(q.x,q.y,q.z,q.w) < 1e-8 || [s.x,s.y,s.z].some(v => Math.abs(v)<1e-8)) throw Error('Invalid transform: '+n.id);
    const ancestors = new Set([n.id]); let parent = n.parentId;
    while (parent) { if (!nodes.has(parent) || ancestors.has(parent)) throw Error('Invalid scene hierarchy: '+n.id); ancestors.add(parent); parent=nodes.get(parent)!.parentId; }
    if (n.type === 'asset') {
      if (n.instanceBatch) throw Error('Expand compact foliage batches into individual nodes before Unreal delivery: '+n.id);
      const ref = assetRef.parse(n.asset);
      if (!sources.has(JSON.stringify([ref.assetId,ref.revisionId]))) throw Error('Missing asset revision binding: '+n.id);
      if (n.attachment || n.armor || n.performer || (n.animation as {enabled?:boolean}|undefined)?.enabled) throw Error('Animated/attached characters need a skeletal delivery adapter: '+n.id);
    } else if (n.type === 'terrain') {
      z.tuple([scalar.positive(),scalar.positive()]).parse(n.size);
      const b=terrains.get(n.id);
      if (!b || !sources.has(JSON.stringify([b.assetId,b.revisionId]))) throw Error('Terrain requires an exported mesh binding: '+n.id);
      const source=sources.get(JSON.stringify([b.assetId,b.revisionId]))!;
      if (source.kind==='native_actor') throw Error('Terrain requires a static mesh, not a Blueprint: '+n.id);
      if ((p.collision[n.id] ?? 'complex')==='complex' && source.kind!=='glb') throw Error('Complex terrain collision requires a newly imported mesh: '+n.id);
    } else if (n.type === 'path') {
      z.array(vec3).min(2).max(20000).parse(n.points); scalar.positive().parse(n.width);
    } else if (n.type === 'zone' || n.type === 'region') {
      z.array(z.tuple([scalar,scalar])).min(3).max(20000).parse(n.polygon);
      if (n.type==='zone') z.enum(['spawn','objective','gameplay']).parse(n.zoneKind);
    } else if (n.type === 'camera') {
      vec3.parse(n.target); scalar.min(1).max(170).parse(n.fov);
      if (n.projection !== 'perspective' || (n.keys as unknown[])?.length) throw Error('Only static perspective cameras are supported in this delivery version.');
    } else if (n.type === 'primitive') {
      z.enum(['box','plane','sphere','cylinder']).parse(n.shape); z.tuple([scalar.positive(),scalar.positive(),scalar.positive()]).parse(n.size);
    } else if (n.type === 'environment') {
      if (n.hdri || (n.clouds as {enabled?:boolean})?.enabled) throw Error('HDRI/clouds require a native Unreal environment adapter; do not silently drop them.');
    } else if (n.type === 'light') {
      z.enum(['directional','point','ambient','hemisphere']).parse(n.lightKind); hex.parse(n.color); scalar.min(0).parse(n.intensity); scalar.min(0).parse(n.range);
    }
  }
  if (p.document.nodes.filter(n=>n.type==='environment').length>1) throw Error('Only one shared environment is supported.');
  const materialSlots=new Set<string>();
  for (const b of p.material_bindings) {
    const node=nodes.get(b.nodeId), slot=JSON.stringify([b.nodeId,b.slot]);
    if (!node || !materials.has(b.materialId) || !['asset','primitive','terrain'].includes(node.type)) throw Error('Invalid material binding.');
    if (materialSlots.has(slot)) throw Error('Duplicate material slot binding: '+b.nodeId);
    materialSlots.add(slot);
    if (node.type==='asset') {
      const ref=assetRef.parse(node.asset);
      if(sources.get(JSON.stringify([ref.assetId,ref.revisionId]))?.kind==='native_actor') throw Error('Blueprint materials need explicit component bindings; this adapter supports static mesh material slots only: '+b.nodeId);
    }
  }
  for (const b of p.terrains) if (nodes.get(b.nodeId)?.type!=='terrain') throw Error('Invalid terrain binding.');
  // Keep common instance materials in the delivery document. Explicit bindings must agree;
  // silently rendering one material in the Studio and another in UE is forbidden.
  for(const n of nodes.values()){
    const surface=n.material as Record<string,unknown>|undefined;
    const values=n.type==='asset'?Object.entries(n.materials as Record<string,unknown>??{}):['terrain','primitive'].includes(n.type)&&surface&&Object.values(textureChannels).some(k=>surface[k])?[['*',surface]]:[];
    for(const [name,value] of values){
      const bindings=p.material_bindings.filter(b=>b.nodeId===n.id),m=p.materials.find(m=>m.id===bindings[0]?.materialId);
      if(name!=='*'||bindings.length!==1||bindings[0].slot!==0||!m||!isDeepStrictEqual(value,unrealMaterialToScene(m)))throw Error('Resolve material overrides into matching material_bindings for Unreal delivery: '+n.id);
    }
  }
  const starts = new Set<string>();
  for (const s of p.gameplay.player_starts) {
    const node=nodes.get(s.nodeId);
    if (node?.type!=='zone' || node.zoneKind!=='spawn') throw Error('Player start must bind a spawn zone.');
    if (starts.has(s.nodeId)) throw Error('Duplicate player start binding: '+s.nodeId);
    starts.add(s.nodeId);
  }
  for (const c of p.capture.camera_ids) if (nodes.get(c)?.type!=='camera') throw Error('Capture must bind a scene camera.');
  for (const [key, mode] of Object.entries(p.collision)) {
    const node=nodes.get(key); if (!node || !['asset','terrain','primitive'].includes(node.type)) throw Error('Invalid collision binding: '+key);
    if (mode==='complex' && node.type==='primitive') throw Error('Complex collision may not modify a shared engine primitive.');
    if (node.type==='asset') {
      const ref=assetRef.parse(node.asset), kind=sources.get(JSON.stringify([ref.assetId,ref.revisionId]))?.kind;
      if(mode==='complex' && kind!=='glb') throw Error('Complex collision may only modify a newly imported mesh, never a shared native source.');
      if(mode!=='source' && kind==='native_actor') throw Error('Blueprint collision needs explicit component bindings: '+key);
    }
  }
  for (const key of Object.keys(p.actor_properties)) {
    const node=nodes.get(key);
    if (node?.type!=='asset') throw Error('Actor properties require a native Blueprint instance: '+key);
    const ref=assetRef.parse(node.asset);
    if(sources.get(JSON.stringify([ref.assetId,ref.revisionId]))?.kind!=='native_actor') throw Error('Actor properties require a native Blueprint instance: '+key);
  }
  for(const preview of [...p.vfx_previews,...p.niagara_overrides]){
    const node=nodes.get(preview.nodeId);
    if(node?.type!=='asset')throw Error('VFX preview requires a native Blueprint instance.');
    const ref=assetRef.parse(node.asset);
    if(sources.get(JSON.stringify([ref.assetId,ref.revisionId]))?.kind!=='native_actor')throw Error('VFX preview requires a native Blueprint instance.');
  }
  return p;
}

const hash = (b: string|Buffer) => createHash('sha256').update(b).digest('hex');
export function unrealLaunchCommand(executable:string,args:string[],nativeAppleSilicon:boolean) {
  // A Rosetta Node process otherwise selects UE's Intel slice and cannot load arm64 project modules.
  return nativeAppleSilicon ? {command:'/usr/bin/arch',args:['-arm64',executable,...args]} : {command:executable,args};
}
async function readJson(file:string) { if((await stat(file)).size>64*1024*1024) throw Error('Manifest exceeds 64 MB.'); return JSON.parse(await readFile(file,'utf8')); }
async function atomicJson(file:string, value:unknown) { const temp=file+'.'+process.pid+'.tmp'; await writeFile(temp,JSON.stringify(value,null,2)); await rename(temp,file); }

export async function prepareUnrealSceneImport(planFile:string, jobDirectory:string) {
  absolute.parse(planFile); absolute.parse(jobDirectory);
  const plan=validateUnrealScenePlan(await readJson(planFile));
  await realpath(plan.project_file);
  for (const source of plan.assets) {
    const file=source.kind==='glb' ? source.file! : join(dirname(plan.project_file),'Content',source.path!.slice(6)+'.uasset');
    if (hash(await readFile(file))!==source.sha256) throw Error('Source revision changed: '+source.assetId);
  }
  for(const texture of portableSceneTextures(plan)){
    if((await stat(texture.file)).size>64*1024*1024)throw Error('Texture exceeds 64 MB: '+texture.assetId);
    const bytes=await readFile(texture.file);
    if(hash(bytes)!==texture.sha256)throw Error('Texture revision changed: '+texture.assetId);
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if(!png&&!jpeg)throw Error('Invalid texture image: '+texture.assetId);
  }
  const snapshot=JSON.stringify(plan), fingerprint=hash(snapshot);
  await mkdir(jobDirectory,{recursive:true}); const dir=await realpath(jobDirectory), manifest=join(dir,'plan.json');
  try { await writeFile(manifest,snapshot,{flag:'wx'}); }
  catch(error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; if(hash(await readFile(manifest))!==fingerprint) throw Error('Job already contains a different scene revision. Choose a new job directory and target level.'); }
  for (const name of ['unreal-scene-import.py','unreal_scene_math.py','unreal_spawn_review.py']) {
    const source=fileURLToPath(new URL('../runtime/'+name,import.meta.url)), dest=join(dir,name);
    try { await copyFile(source,dest,1); } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; if(hash(await readFile(source))!==hash(await readFile(dest))) throw Error('Worker version changed. Prepare a new job to retain reproducible imports.'); }
  }
  return {schema:'gripforge.unreal-import-job.v1',job_directory:dir,plan_hash:fingerprint,target_level:plan.target_level,lifecycle:'work',node_count:plan.document.nodes.length,
    next:'Call gripforge_map_unreal_import_local with this job_directory and your UnrealEditor executable. Import creates a separate work level; visual acceptance is a separate step.'};
}

export async function unrealImportStatus(jobDirectory:string): Promise<Record<string, unknown>> {
  absolute.parse(jobDirectory); const plan=validateUnrealScenePlan(await readJson(join(jobDirectory,'plan.json')));
  let state:Record<string,unknown>={stage:'prepared',lifecycle:'work',target_level:plan.target_level};
  try {state=await readJson(join(jobDirectory,'status.json'));} catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  try {
    const launch=await readJson(join(jobDirectory,'launch.json')) as {pid:number;started_at:string};
    if (Date.parse(launch.started_at) > Number(state.updated_at ?? 0)*1000) state={...state,...launch,stage:'launching'};
  } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if (typeof state.pid==='number') {
    try {process.kill(state.pid,0);state.editor_running=true;}
    catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='EPERM')state.editor_running=null;else {if(code!=='ESRCH')throw error;state.editor_running=false;if(!['failed','cancelled','awaiting_visual_review'].includes(String(state.stage)))state={...state,interrupted_stage:state.stage,stage:'failed',error:'Unreal exited before finishing. Inspect editor-launch.log / editor.log, then resume this saved job.'};}}
  }
  return {job_directory:jobDirectory,...state};
}

export async function startUnrealSceneImport(jobDirectory:string, editorExecutable:string) {
  absolute.parse(jobDirectory); absolute.parse(editorExecutable);
  const dir=await realpath(jobDirectory), executable=await realpath(editorExecutable);
  if (!/^UnrealEditor(?:-Cmd)?(?:\.exe)?$/.test(basename(executable))) throw Error('editor_executable must be UnrealEditor or UnrealEditor-Cmd.');
  const lock=join(dir,'launch.lock');
  try {await writeFile(lock,JSON.stringify({pid:process.pid}),{flag:'wx'});} catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const owner=await readJson(lock);
    try {process.kill(owner.pid,0);throw Error('A launch request is already in progress for this job.');} catch(check){if((check as NodeJS.ErrnoException).code!=='ESRCH')throw check;}
    await unlink(lock);return startUnrealSceneImport(dir,executable);
  }
  try {
  const plan=validateUnrealScenePlan(await readJson(join(dir,'plan.json'))), state=await unrealImportStatus(dir);
  if(typeof state.pid==='number') {
    try {process.kill(state.pid,0); return {...state,next:'This job is already open in Unreal. Inspect the level there; close that editor before relaunching the saved job.'};} catch(error){if((error as NodeJS.ErrnoException).code==='EPERM')return {...state,next:'Editor process exists but cannot be inspected from this sandbox. Do not launch a duplicate editor.'};if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  }
  await atomicJson(join(dir,'control.json'),{cancel:false});
  const log=await open(join(dir,'editor-launch.log'),'a');
  try {
    const nativeAppleSilicon=process.platform==='darwin' && (await promisify(execFile)('/usr/sbin/sysctl',['-n','hw.optional.arm64'])).stdout.trim()==='1';
    const launch=unrealLaunchCommand(executable,[plan.project_file,'/Engine/Maps/Entry','-ExecutePythonScript='+join(dir,'unreal-scene-import.py'),'-GFMapPlan='+join(dir,'plan.json'),'-EnablePlugins=PythonScriptPlugin,EditorScriptingUtilities','-nosplash','-NoSound','-unattended','-NoLoadStartupPackages','-abslog='+join(dir,'editor.log')],nativeAppleSilicon);
    const child=spawn(launch.command,launch.args,{cwd:dirname(executable),detached:true,stdio:['ignore',log.fd,log.fd],shell:false});
    await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();
    await atomicJson(join(dir,'launch.json'),{pid:child.pid,started_at:new Date().toISOString()});
    return {job_directory:dir,pid:child.pid,stage:'launching',target_level:plan.target_level,lifecycle:'work',next:'Poll gripforge_map_unreal_import_status_local. The editor performs the work independently of this MCP call.'};
  } finally {await log.close();}
  } finally {await unlink(lock);}
}

export function registerMapUnrealImportLocalTools(register:VfxProjectRegister) {
  const job={job_directory:absolute.describe('Persistent local directory returned by prepare_local.')};
  const wrap=(f:(a:Record<string,unknown>)=>Promise<Record<string,unknown>>)=>async(a:Record<string,unknown>)=>{try{const data=await f(a);return{structuredContent:data,content:[{type:'text' as const,text:JSON.stringify(data)}]};}catch(e){return{isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:String(e)}]};}};
  register('gripforge_map_unreal_prepare_local',{title:'Prepare a reusable Unreal scene import',description:'Validate a common GripForge map SceneDocument and native/GLB asset bindings, pin source revisions and package the bounded UE Python worker into a persistent local job. Preserves PBR and separate instances. No source package changes. A new target under /Game/GripForge/Maps is required; work versions are never automatically visually validated. Local npm MCP only.',inputSchema:{plan_file:absolute,...job},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},wrap(a=>prepareUnrealSceneImport(String(a.plan_file),String(a.job_directory))));
  register('gripforge_map_unreal_import_local',{title:'Import/resume a map in Unreal',description:'Launch the installed Unreal editor to materialize a prepared job as a separate native work level. Writes generated assets and that level only; original native meshes/materials remain shared. Continues after the MCP call ends. Closing and relaunching the same job resumes saved checkpoints without duplicate actors. Returns status location, never claims visual acceptance.',inputSchema:{...job,editor_executable:absolute},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},wrap(a=>startUnrealSceneImport(String(a.job_directory),String(a.editor_executable))));
  register('gripforge_map_unreal_import_status_local',{title:'Read persistent Unreal import progress',description:'Read stages, saved progress, failures, collision/scale checks and actual viewport captures for a prepared native map import.',inputSchema:job,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},wrap(a=>unrealImportStatus(String(a.job_directory))));
  register('gripforge_map_unreal_import_cancel_local',{title:'Cancel a native map import',description:'Request cancellation at the next safe checkpoint. Completed generated assets and saved actors remain available for a later resume; the current validated map is not replaced.',inputSchema:job,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},wrap(async a=>{await unrealImportStatus(String(a.job_directory));await atomicJson(join(String(a.job_directory),'control.json'),{cancel:true});return{cancel_requested:true,job_directory:a.job_directory};}));
}
