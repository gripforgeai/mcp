import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { GameImportAgent, confinedFile, saveImportJob } from './game-import-agent.js';
import type { ImportJob } from './game-import-types.js';
const exec = promisify(execFile);
/** Explicit adapters; never execute a binary discovered inside the source game. */
export async function extractGame(job: ImportJob) {
  const e = job.extraction; if (!e || !job.rights || !job.report) throw Error('Extraction plan and authorized rights basis required');
  if (job.report.engine.name !== 'unity') throw Error('This adapter only handles Unity. Use the existing Unreal source-project exporter for Unreal.');
  await mkdir(e.output,{recursive:true,mode:0o700});
  const agent=new GameImportAgent(job); await agent.checkpoint();
  if(!e.completed){
    if(e.tool==='assetripper'){
      const url=new URL(e.endpoint??'');if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/')throw Error('AssetRipper requires a dedicated local loopback HTTP instance');
      // Version-compatible route discovery prevents invoking imaginary CLI options or a different local service.
      const spec=await fetch(new URL('/openapi/v1.json',url),{signal:AbortSignal.timeout(10000)});
      if(!spec.ok)throw Error('AssetRipper OpenAPI unavailable; use a compatible web build or manual export');
      const api=await spec.json() as any;
      if(!api.paths?.['/LoadFolder']?.post||!api.paths?.['/Export/PrimaryContent']?.post)throw Error('AssetRipper API lacks required export routes');
      e.version=String(api.info?.version??'unreported');await saveImportJob(job);
      const post=async(route:string,path:string)=>{await agent.checkpoint();const res=await fetch(new URL(route,url),{method:'POST',body:new URLSearchParams({Path:path,CreateSubfolder:'false'}),redirect:'manual',signal:AbortSignal.timeout(20*60*1000)});if(![200,302,303].includes(res.status))throw Error(`AssetRipper ${route}: HTTP ${res.status}`);};
      await post('/LoadFolder',e.sourceRoot);await post('/Export/PrimaryContent',e.output);
      if(!(await readdir(e.output)).length)throw Error('Extractor returned no files; inspect AssetRipper failed-file log');
    }else{
      const bin=process.env[e.tool==='cpp2il'?'GRIPFORGE_CPP2IL_BIN':'GRIPFORGE_ILSPY_BIN'];if(!bin)throw Error(`Configure the installed ${e.tool} executable; no automatic installation`);
      const version=await exec(bin,['--version'],{cwd:e.output,timeout:10000,maxBuffer:1024*1024}).catch(()=>({stdout:'version not reported'}));e.version=version.stdout.trim().slice(0,200);await saveImportJob(job);
      const args=e.tool==='cpp2il'?['--game-path',e.sourceRoot,'--output-to',e.output]:['--disable-updatecheck','-p','-o',e.output,await confinedFile(e.sourceRoot,job.report.assets.find(a=>/(?:^|\/)Managed\/Assembly-CSharp\.dll$/i.test(a.path))?.path??'')];
      await exec(bin,args,{cwd:e.output,timeout:20*60*1000,maxBuffer:4*1024*1024});
      job.report.warnings.push(`${e.tool} metadata/code exported locally to ${e.tool}-output. It is not a mesh extraction and is never uploaded to the Library.`);
    }
    e.completed=true;await agent.checkpoint();
  }
  if(e.tool==='assetripper'){
    const engine=job.report.engine,source=job.report.source;job.root=await realpath(e.output);job.phase='analyze';
    const report=await new GameImportAgent(job).analyze();report.source=source;report.engine=engine;report.toolchain=agent.select_toolchain(engine);report.warnings.push('Inventory is from AssetRipper export; native Unity formats still require their own converter.');await saveImportJob(job);
  }else{job.phase='analyze';job.status='awaiting_selection';await saveImportJob(job);}
}
