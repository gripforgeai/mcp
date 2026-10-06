import { spawn } from 'node:child_process';
import { open, writeFile, unlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod/v4';
import { jobDirectory, loadImportJob, newImportJob, saveImportJob } from './game-import-agent.js';
import type { ImportJob } from './game-import-types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';

async function launch(job: ImportJob, key?: string) {
  const log = await open(join(jobDirectory(job.id), 'worker.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./game-import-worker.js', import.meta.url)), job.id], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ...(key ? { GRIPFORGE_API_KEY: key } : {}) } });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
  } finally { await log.close(); }
}
async function assertIdle(id: string) {
  try { const pid = Number(await readFile(join(jobDirectory(id), 'worker.lock'), 'utf8')); try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return; throw e; } throw Error('Worker still running; cancel and wait for it to finish'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
export function registerGameImportTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }) {
  const result = (data: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], structuredContent: data });
  const wrap = (run: (a: Record<string, any>) => Promise<Record<string, unknown>>) => async (a: Record<string, any>) => { try { return result(await run(a)); } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] }; } };
  const id = z.string().regex(/^gi_[a-f0-9]{24}$/);
  const summary = (job: ImportJob) => ({ job_id: job.id, status: job.status, phase: job.phase, progress: { completed: job.completed, total: job.total }, engine: job.report?.engine, counts: job.report?.counts, errors: job.errors, imported: job.receipts, report_path: join(jobDirectory(job.id), 'report.json'), library_url: `${options.apiUrl}/library`, next: job.status === 'awaiting_selection' ? 'Read inventory, select asset ids, then gripforge_game_import_select' : 'gripforge_game_import_read' });
  register('gripforge_game_import', {
    title: 'Analyze an authorized local game or project',
    description: 'LOCAL MCP ONLY. Analyze → discover → classify → normalize → private Library import. Starts a detached durable local job; returns immediately. Known portable formats first, Unity GUID relations carry evidence, unsupported formats stay blocked with an explicit toolchain. Does not launch the game, bypass encryption, guess sockets or claim behavior/visual validation. Read the inventory and select before uploading. Closing the MCP or Studio does not delete progress; read/resume by job_id. Analysis is free and local. Source files remain unchanged.',
    inputSchema: { path: z.string().min(1).max(4096) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, wrap(async a => { const job = await newImportJob(a.path); await launch(job); return summary(job); }));
  register('gripforge_game_import_read', {
    title: 'Read game import progress and inventory', description: 'Read persistent local state with paginated assets, role confidence, extraction blockers and verified relationship edges. The report_path can be opened in Library → Add asset → From Game. Unknown/bundled files are not counted as successfully imported assets.',
    inputSchema: { job_id: id, kind: z.string().max(40).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(async a => { const job = await loadImportJob(a.job_id), all = (job.report?.assets ?? []).filter(x => !a.kind || x.kind === a.kind); return { ...summary(job), total: all.length, assets: all.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 40)), toolchain: job.report?.toolchain, normalization: job.report?.normalization, warnings: job.report?.warnings, relationships: job.report?.relationships }; }));
  register('gripforge_game_import_extract', {
    title:'Run the selected known Unity extractor', description:'LOCAL ONLY. Dedicated AssetRipper loopback HTTP adapter for assets; installed Cpp2IL/ILSpy adapters for local code/metadata only. The agent chooses AssetRipper first unless tool is explicit. Uses durable output/checkpoints and rescans exported assets; never executes game code. Requires installed tools configured in the MCP environment, compatible OpenAPI routes and an authorization basis. No Ghidra fallback is silently invoked. Tools/version and errors remain visible. Cancellation is checked between external operations, each bounded to 20 minutes.',
    inputSchema:{job_id:id,tool:z.enum(['assetripper','cpp2il','ilspy']).optional(),rights:z.object({basis:z.enum(['owned','authorized','compatible-license']),note:z.string().min(3).max(1000)}).strict()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },wrap(async a=>{await assertIdle(a.job_id);const job=await loadImportJob(a.job_id);if(!job.report||job.report.engine.name!=='unity')throw Error('Finish Unity analysis first');if(Object.keys(job.receipts).length)throw Error('Start a new import before extracting a different inventory');const tool=a.tool??'assetripper';if(tool==='cpp2il'&&job.report.engine.runtime!=='IL2CPP')throw Error('Cpp2IL requires IL2CPP evidence');if(tool==='ilspy'&&job.report.engine.runtime!=='Mono')throw Error('ILSpy requires Mono evidence');if(job.extraction&&job.extraction.tool!==tool)throw Error('Start a separate analysis job for another extractor');job.extraction??={tool,sourceRoot:job.root,output:join(jobDirectory(job.id),tool+'-output'),...(tool==='assetripper'?{endpoint:process.env.GRIPFORGE_ASSETRIPPER_URL}:{})};job.rights=a.rights;job.phase='extract';job.status='queued';await unlink(join(jobDirectory(job.id),'cancel')).catch(()=>{});await saveImportJob(job);await launch(job);return summary(job);}));
  register('gripforge_game_import_select', {
    title: 'Import selected game assets into a private workspace', description: 'Requires an analyzed local job, explicit source ids, workspace id and rights basis. Self-contained GLB and standard images/audio import directly; glTF packs its local resources into GLB. Engine-native formats require extraction first. Durable per-file checkpoints and server idempotency preserve completed imports across retries. Saved as work revisions, never published/promoted. Storage quotas apply; no paid AI call. Relations remain a knowledge graph and Game Kit suggestions require actual gameplay integration.',
    inputSchema: { job_id: id, asset_ids: z.array(z.string().regex(/^src_[a-f0-9]{24}$/)).min(1).max(500), workspace_id: z.string().regex(/^ws_[A-Za-z0-9_-]+$/), rights: z.object({ basis: z.enum(['owned','authorized','compatible-license']), note: z.string().min(3).max(1000) }).strict() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, wrap(async a => {
    const key = options.getApiKey(); if (!key) throw Error('GripForge API key required'); await assertIdle(a.job_id);
    const job = await loadImportJob(a.job_id); if (!job.report || job.completed < job.total && job.phase === 'analyze') throw Error('Finish analysis before selecting assets');
    if (job.workspace && job.workspace !== a.workspace_id) throw Error('Start a new import to target another workspace');
    const selected = [...new Set<string>(a.asset_ids)];
    for (const id of selected) { const asset = job.report.assets.find(x => x.id === id); if (!asset || asset.status === 'blocked') throw Error(`Asset unavailable for import: ${id}`); }
    job.phase = 'import'; job.selected = selected; job.rights = a.rights; job.workspace = a.workspace_id; job.origin = options.apiUrl.replace(/\/$/,''); job.status = 'queued'; delete job.errors.worker;
    await unlink(join(jobDirectory(job.id), 'cancel')).catch(() => {}); await saveImportJob(job); await launch(job, key); return summary(job);
  }));
  register('gripforge_game_import_normalize', {
    title: 'Convert selected extracted assets with Blender',
    description: 'LOCAL durable worker. Installed GRIPFORGE_BLENDER_BIN converts FBX/OBJ to GLB and DDS/TGA to PNG. Keeps available PBR, rig and animations; does not fabricate missing materials or validate appearance. Sources remain unchanged; checksummed outputs persist for resume. OBJ with external MTL and missing FBX textures fail explicitly; export embedded materials first. Run before registration/import. Source engine scenes still require their known exporter.',
    inputSchema: { job_id: id, asset_ids: z.array(z.string().regex(/^src_[a-f0-9]{24}$/)).min(1).max(500), rights: z.object({ basis: z.enum(['owned','authorized','compatible-license']), note: z.string().min(3).max(1000) }).strict() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(async a => {
    await assertIdle(a.job_id); const job = await loadImportJob(a.job_id);
    if (!job.report || Object.keys(job.receipts).length || job.workspace) throw Error('Normalize an analyzed inventory before registering/importing it');
    for (const assetId of a.asset_ids) if (!job.report.assets.some(x => x.id === assetId && ['fbx','obj','dds','tga'].includes(x.format))) throw Error('Select FBX/OBJ/DDS/TGA inventory sources');
    job.phase = 'normalize'; job.selected = [...new Set<string>(a.asset_ids)]; job.rights = a.rights; job.status = 'queued';
    await unlink(join(jobDirectory(job.id), 'cancel')).catch(() => {}); await saveImportJob(job); await launch(job); return summary(job);
  }));
  register('gripforge_game_import_control', {
    title: 'Cancel or resume a local game import', description: 'Cancel between files; an already committed upload remains imported. Resume preserves successful receipts and checkpoints. After a worker crash, resume with the same job_id. Credentials are supplied by the current MCP session, never saved in the job report.',
    inputSchema: { job_id: id, action: z.enum(['cancel','resume']) }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, wrap(async a => { const job = await loadImportJob(a.job_id); if (a.action === 'cancel') { await writeFile(join(jobDirectory(job.id), 'cancel'), 'cancel', { mode: 0o600 }); await assertIdle(job.id).then(async () => { job.status = 'cancelled'; await saveImportJob(job); }).catch(() => {}); }
    else { await assertIdle(job.id); if (job.phase === 'import' && !options.getApiKey()) throw Error('API key required to resume import'); await unlink(join(jobDirectory(job.id), 'cancel')).catch(() => {}); job.status = 'queued'; delete job.errors.worker; await saveImportJob(job); await launch(job, options.getApiKey() ?? undefined); }
    return summary(job);
  }));
}
