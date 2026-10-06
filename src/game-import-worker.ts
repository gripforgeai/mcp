import { GameImportAgent, claimImportJob, loadImportJob, saveImportJob } from './game-import-agent.js';
import { normalizeGame } from './game-import-normalize.js';
import { extractGame } from './game-import-extract.js';

const id = process.argv[2];
const release = await claimImportJob(id);
const job = await loadImportJob(id);
try {
  job.status = 'running'; job.workerPid = process.pid; await saveImportJob(job);
  const agent = new GameImportAgent(job);
  if (job.phase === 'normalize') await normalizeGame(job);
  else if (job.phase === 'extract') await extractGame(job);
  else if (job.phase === 'analyze') await agent.analyze();
  else { const key = process.env.GRIPFORGE_API_KEY; if (!key) throw Error('API key required to resume import'); await agent.import_to_gripforge(key); }
} catch (e) {
  job.status = await new GameImportAgent(job).cancelled() ? 'cancelled' : 'failed';
  job.errors.worker = e instanceof Error ? e.message : String(e); await saveImportJob(job);
} finally { delete job.workerPid; await saveImportJob(job); await release(); }
