import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod/v4';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { confinedFile, jobDirectory, loadImportJob } from './game-import-agent.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';

type Session = { path: string; sha256: string; program: string; endpoint: string };
/** Detect containers locally before recommending native code investigation. No binaries are executed. */
export function detectFormat(bytes: Buffer) {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))) return { format: 'ELF', native: true };
  if (bytes.toString('ascii', 0, 2) === 'MZ') return { format: 'PE', native: true };
  if (bytes.length >= 4 && [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe].includes(bytes.readUInt32BE())) return { format: 'Mach-O', native: true };
  for (const [magic, format] of [['glTF', 'GLB'], ['UnityFS', 'Unity bundle'], ['DDS ', 'DDS'], ['PK\u0003\u0004', 'ZIP']] as const)
    if (bytes.toString('latin1', 0, magic.length) === magic) return { format, native: false };
  return { format: 'unknown', native: false };
}
function endpoint() {
  const url = new URL(process.env.GRIPFORGE_GHIDRA_MCP_URL ?? '');
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw Error('Configure a dedicated loopback GRIPFORGE_GHIDRA_MCP_URL (for example http://127.0.0.1:8081/mcp)');
  return url;
}
async function bridge<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ name: 'gripforge-game-import', version: '1.0' });
  try { await client.connect(new StreamableHTTPClientTransport(endpoint())); return await run(client); }
  finally { await client.close().catch(() => {}); }
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const tool = (await client.listTools()).tools.find(t => t.name === name);
  if (!tool) throw Error('Compatible Ghidra tool unavailable: ' + name);
  for (const key of tool.inputSchema.required ?? []) if (!(key in args)) throw Error(`Installed Ghidra requires ${key} for ${name}; incompatible adapter contract`);
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  if (response.isError) throw Error(JSON.stringify(response.content).slice(0, 4000));
  return response;
}
export function registerReverseTools(register: VfxProjectRegister) {
  const jobId = z.string().regex(/^gi_[a-f0-9]{24}$/), path = z.string().min(1).max(4096);
  const wrap = (run: (a: any) => Promise<unknown>) => async (a: any) => { try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run(a), null, 2) }] }; } catch (e) { return { isError: true, content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }] }; } };
  const common = { job_id: jobId };
  register('gripforge_reverse_detect_format', { title: 'Inspect file magic before reverse engineering', description: 'Local signatures, source hash and known-format-first recommendation. Unknown remains unknown. Does not execute or alter the source.', inputSchema: { ...common, path }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, wrap(async a => {
    const job = await loadImportJob(a.job_id), bytes = await readFile(await confinedFile(job.root, a.path)), found = detectFormat(bytes);
    return { ...found, sha256: createHash('sha256').update(bytes).digest('hex'), next: found.native ? 'gripforge_reverse_open' : 'Known extractor/converter first; unknown data needs a format-specific investigation, not automatic native decompilation' };
  }));
  register('gripforge_reverse_open', { title: 'Open an authorized native binary in Ghidra', description: 'Imports a copy into a dedicated installed Ghidra analysis project, without running the binary. Requires a finished local import job, native file signature and rights basis. Records hash and explicit program selector, so later reads never depend on the shared current program. No extraction or visual approval is implied.', inputSchema: { ...common, path, rights: z.object({ basis: z.enum(['owned','authorized','compatible-license']), note: z.string().min(3).max(1000) }).strict() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }, wrap(async a => {
    const job = await loadImportJob(a.job_id), file = await confinedFile(job.root, a.path), bytes = await readFile(file);
    if (!detectFormat(bytes).native) throw Error('Use a known extractor or inspect the data format first; this is not a recognized native binary');
    const response = await bridge(c => call(c, 'import_file', { file_path: file, project_folder: '/' + job.id, auto_analyze: true }));
    const content = response.content as Array<{ type: string; text?: string }>;
    let program: string | undefined;
    for (const block of content) if (block.text) { try { const json = JSON.parse(block.text); program = json.data?.name ?? json.name; } catch {} }
    if (!program) throw Error('Ghidra did not report the imported program name; no ambiguous current-program session saved');
    const session: Session = { path: a.path, sha256: createHash('sha256').update(bytes).digest('hex'), program: '/' + job.id + '/' + basename(program), endpoint: endpoint().href };
    await writeFile(join(jobDirectory(job.id), 'reverse-session.json'), JSON.stringify({ ...session, rights: a.rights }), { mode: 0o600 });
    return { program: session.program, sha256: session.sha256, analysis: response, next: 'gripforge_reverse_scan', source_unchanged: true };
  }));
  // A deliberately small allowlist. Upstream rename/patch/execute tools are never passed through.
  for (const [name, tool, description, query, group] of [
    ['gripforge_reverse_scan', 'find_functions', 'List native functions with an explicit program selector', false, 'listing'],
    ['gripforge_reverse_find_asset_system', 'search_strings', 'Search native strings for asset loading/format clues; results are evidence, not inferred assets', true, 'listing'],
    ['gripforge_reverse_trace_function', 'get_functions', 'Read one native function to investigate an asset loader; never changes executable code', true, 'function'],
  ] as const) {
    register(name, { title: description, description: 'Configured local Ghidra MCP bridge only. Verifies source hash and installed tool schema. Bounded output and persisted evidence; no unsupported converter is invented. ' + description, inputSchema: { ...common, ...(query ? { query: z.string().min(1).max(256) } : {}), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, wrap(async a => {
      const job = await loadImportJob(a.job_id), session: Session = JSON.parse(await readFile(join(jobDirectory(job.id), 'reverse-session.json'), 'utf8'));
      if (session.endpoint !== endpoint().href) throw Error('Ghidra endpoint changed; open the binary again');
      const bytes = await readFile(await confinedFile(job.root, session.path));
      if (createHash('sha256').update(bytes).digest('hex') !== session.sha256) throw Error('Binary changed; open it again');
      const response = await bridge(async c => {
        if (!(await c.listTools()).tools.some(t => t.name === tool)) await call(c, 'load_tool_group', { group });
        const schema = (await c.listTools()).tools.find(t => t.name === tool)?.inputSchema;
        if (!schema?.properties?.program) throw Error('Installed Ghidra tool lacks explicit program selection; update the bridge');
        const args: Record<string, unknown> = { program: session.program };
        if (schema.properties.offset) args.offset = a.offset ?? 0;
        if (schema.properties.limit) args.limit = a.limit ?? 40;
        if (tool === 'get_functions' && schema.properties.fields) args.fields = 'decompiled_code,callers,callees,signature';
        if (query) {
          const key = tool === 'get_functions' ? ['function', 'address', 'function_address', 'name', 'function_name'].find(k => schema.properties?.[k]) : ['query', 'search', 'search_term', 'filter'].find(k => schema.properties?.[k]);
          if (!key) throw Error('Installed Ghidra query schema incompatible'); args[key] = a.query;
        }
        return call(c, tool, args);
      });
      const evidence = { source_sha256: session.sha256, program: session.program, operation: tool, query: a.query, observed_at: new Date().toISOString(), result: JSON.stringify(response).slice(0, 64000) };
      await writeFile(join(jobDirectory(job.id), 'reverse-' + tool + '.json'), JSON.stringify(evidence), { mode: 0o600 }); return evidence;
    }));
  }
}
