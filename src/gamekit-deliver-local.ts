/**
 * npm-only Game Kit delivery into a local engine project. Registered by `server.ts` only: the hosted MCP never
 * reaches the caller's disk.
 *
 * gripforge_gamekit_deliver_local hashes the files a delivery may touch (gripforge/**, assets/gripforge/** and the
 * lock's owned paths, bytes as-is), reads gripforge/gamekits.lock.json, POSTs /api/v1/gamekits/deliver, validates every
 * action (paths inside the project, text sha256, binaries downloaded and checked) and only then executes plan.actions in
 * order. Every file it overwrites or deletes is first copied to gripforge/.backup/<plan id>/ (an existing backup is never
 * overwritten), the lock is written last, and `verify` runs Godot headless when GODOT_BIN is set.
 * gripforge_gamekit_rollback_local restores gripforge/.backup/<lock id>/, removes the files that delivery added when they
 * are unmodified, and puts gripforge/gamekits.lock.prev.json back as the lock.
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const GAMEKIT_LOCAL_TOOL_NAMES = ['gripforge_gamekit_deliver_local', 'gripforge_gamekit_rollback_local'] as const;

const LOCK_PATH = 'gripforge/gamekits.lock.json';
const PREV_LOCK_PATH = 'gripforge/gamekits.lock.prev.json';
const BACKUP_DIR = 'gripforge/.backup';
const SCAN_ROOTS = ['gripforge', 'assets/gripforge'];
const GODOT_ROOTS = ['gripforge/', 'assets/gripforge/'];
const MAX_FILES = 5000;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const DERIVED = ['.uid', '.import'];
const SHA256_RE = /^[a-f0-9]{64}$/;
const KIT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const BACKUP_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const TARGETS = ['godot', 'unity', 'unreal'] as const;
type Target = (typeof TARGETS)[number];

type Action =
  | { op: 'backup'; path: string; to: string }
  | { op: 'write'; path: string; sha256: string }
  | { op: 'writeBin'; path: string; sha256?: string }
  | { op: 'delete'; path: string; alsoSiblings?: string[] }
  | { op: 'writeLock'; path: string; previous: string | null }
  | { op: 'refresh' };
type BinaryRef = { url: string; sha256?: string; bytes?: number } | { base64: string; sha256: string };
interface LockDoc {
  id: string;
  kits?: Record<string, { files?: Record<string, { sha256?: string }> }>;
  ownedPaths?: string[];
}
interface PlanDoc {
  id: string;
  target: string;
  mode: string;
  kits: Array<{ id: string; version: string }>;
  files?: Array<{ path: string; change: string; reason?: string }>;
  actions: Action[];
  summary?: unknown;
  warnings?: unknown[];
  blockers?: unknown[];
  postInstall?: unknown[];
  dependencies?: unknown[];
}
interface BundleDoc {
  planId: string;
  files: Record<string, string>;
  binaries: Record<string, BinaryRef>;
  lock: LockDoc;
}

type Step =
  | { op: 'backup'; rel: string; from: string; to: string }
  | { op: 'write'; rel: string; path: string; bytes: Uint8Array }
  | { op: 'delete'; rel: string; path: string; siblings: Array<{ rel: string; path: string }> }
  | { op: 'lock'; rel: string; path: string; previous: string | null; prevPath: string; bytes: Uint8Array };

interface ApplyReport {
  backedUp: string[];
  written: string[];
  deleted: string[];
  missing: string[];
  skipped: Array<{ op: string; path: string; reason: string }>;
  lock: string | null;
  warnings: string[];
}

class LocalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LocalError';
  }
}

export interface GameKitLocalOptions {
  apiUrl: string;
  getApiKey: () => string | null | undefined;
  /** Headless Godot 4 binary for `verify` (default `process.env.GODOT_BIN`). */
  godotBin?: () => string | undefined;
  userAgent?: string;
}

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const under = (dir: string, rel: string): string => join(dir, ...rel.split('/'));
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The lock as written into the project: 2-space JSON with a trailing newline (same as the editor bridge). */
export function serializeEngineLock(lock: unknown): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Project-relative path → absolute path inside `dir`; `forbidden_path` for anything else. */
function projectPath(dir: string, rel: unknown, opts: { godot: boolean; what?: string }): string {
  const what = opts.what ?? 'path';
  if (typeof rel !== 'string' || !rel || rel.length > 512 || rel.includes('\0')) throw new LocalError('forbidden_path', `invalid ${what}`, { path: String(rel).slice(0, 120) });
  const norm = rel.replace(/\\/g, '/');
  const segments = norm.split('/');
  if (norm.startsWith('/') || /^[a-z]:/i.test(norm) || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new LocalError('forbidden_path', `${what} ${rel} must be project-relative, without "..", "." or empty segments`, { path: rel });
  }
  if (!norm.startsWith(`${BACKUP_DIR}/`) && segments.some((s) => s.startsWith('.'))) throw new LocalError('forbidden_path', `${what} ${rel} has a hidden segment`, { path: rel });
  if (opts.godot && !GODOT_ROOTS.some((root) => norm.startsWith(root))) throw new LocalError('forbidden_path', `${what} ${rel} is outside gripforge/ and assets/gripforge/`, { path: rel });
  const absolute = resolve(dir, ...segments);
  const back = relative(dir, absolute);
  if (!back || back.startsWith('..') || isAbsolute(back)) throw new LocalError('forbidden_path', `${what} ${rel} escapes the project`, { path: rel });
  return absolute;
}

async function projectDir(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) throw new LocalError('bad_request', 'project_dir is required: the absolute path of the engine project.');
  if (!isAbsolute(raw)) throw new LocalError('bad_request', `project_dir must be an absolute path, got ${raw}`);
  const dir = resolve(raw);
  let directory = false;
  try {
    directory = (await stat(dir)).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) throw new LocalError('not_found', `project_dir ${dir} is not a directory`);
  return dir;
}

async function readLock(dir: string, rel: string): Promise<{ lock: LockDoc | null; warning?: string }> {
  let text: string;
  try {
    text = await readFile(under(dir, rel), 'utf8');
  } catch {
    return { lock: null };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.id === 'string' ? { lock: parsed as unknown as LockDoc } : { lock: null, warning: `${rel} is not a GripForge lock: ignored` };
  } catch {
    return { lock: null, warning: `${rel} is not valid JSON: ignored` };
  }
}

/** Files under `root` (project-relative, sorted, hidden entries skipped like the editor bridge). */
async function walkFiles(dir: string, root: string, visit: (rel: string) => Promise<void>): Promise<void> {
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 24) return;
    let entries: Dirent[];
    try {
      entries = await readdir(under(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile()) await visit(child);
    }
  };
  await walk(root, 0);
}

async function hashProject(dir: string, lock: LockDoc | null): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let count = 0;
  const add = async (rel: string) => {
    if (++count > MAX_FILES) throw new LocalError('too_many_files', `more than ${MAX_FILES} files to hash under ${SCAN_ROOTS.join(', ')}`);
    files[rel] = sha256(await readFile(under(dir, rel)));
  };
  for (const root of SCAN_ROOTS) await walkFiles(dir, root, add);
  for (const owned of lock?.ownedPaths ?? []) {
    if (typeof owned !== 'string' || owned in files) continue;
    let path: string;
    try {
      path = projectPath(dir, owned, { godot: false });
    } catch {
      continue;
    }
    if (await isFile(path)) await add(owned);
  }
  return files;
}

/** `config/features=PackedStringArray("4.3", …)` → `4.3`. */
async function godotVersion(dir: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(dir, 'project.godot'), 'utf8');
    const features = /config\/features\s*=\s*PackedStringArray\(([^)]*)\)/.exec(text)?.[1];
    return features?.match(/"(\d+\.\d+(?:\.\d+)?)"/)?.[1];
  } catch {
    return undefined;
  }
}

function lockedHashes(lock: LockDoc | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kit of Object.values(lock?.kits ?? {})) {
    for (const [path, file] of Object.entries(kit?.files ?? {})) if (typeof file?.sha256 === 'string') out[path] = file.sha256.toLowerCase();
  }
  return out;
}

function planView(raw: unknown) {
  if (!isRecord(raw)) return null;
  const plan = raw as unknown as PlanDoc;
  return {
    id: plan.id,
    target: plan.target,
    mode: plan.mode,
    kits: plan.kits,
    summary: plan.summary,
    actions: Array.isArray(plan.actions) ? plan.actions.length : 0,
    conflicts: (Array.isArray(plan.files) ? plan.files : []).filter((f) => f.change === 'conflict').map((f) => ({ path: f.path, reason: f.reason ?? null })),
    warnings: plan.warnings ?? [],
    blockers: plan.blockers ?? [],
    postInstall: plan.postInstall ?? [],
    dependencies: plan.dependencies ?? [],
  };
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.gf-tmp-${process.pid}`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((done) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const take = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-65_536);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: null, output: `${output}\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, output, timedOut });
    });
  });
}

const tail = (text: string) => text.split('\n').filter((l) => l.trim()).slice(-12).join('\n');

async function verifyGodot(dir: string, kits: Array<{ id: string }>, bin: string) {
  const steps: Array<{ step: string; ok: boolean | null; code?: number | null; timedOut?: boolean; skipped?: string; tail?: string }> = [];
  const imported = await run(bin, ['--headless', '--path', dir, '--import'], 300_000);
  steps.push({ step: 'import', ok: imported.code === 0 && !imported.timedOut, code: imported.code, timedOut: imported.timedOut, tail: tail(imported.output) });
  for (const kit of kits) {
    if (!KIT_RE.test(kit.id)) continue;
    const smoke = `gripforge/kits/${kit.id}/smoke.gd`;
    if (!(await isFile(under(dir, smoke)))) {
      steps.push({ step: `smoke ${kit.id}`, ok: null, skipped: 'no smoke.gd' });
      continue;
    }
    const r = await run(bin, ['--headless', '--path', dir, '--script', `res://${smoke}`], 180_000);
    steps.push({ step: `smoke ${kit.id}`, ok: r.output.includes('GF_SMOKE_OK') && !r.timedOut, code: r.code, timedOut: r.timedOut, tail: tail(r.output) });
  }
  return { ok: steps.every((s) => s.ok !== false), steps };
}

export function registerGameKitLocalTools(register: VfxProjectRegister, options: GameKitLocalOptions, schema: typeof z = z) {
  const workspace = {
    workspace_id: schema.string().max(100).optional().describe('Workspace authorized by the current key. Never infer another user’s workspace.'),
  };
  const projectDirField = schema.string().min(1).max(1024).describe('Absolute path of the engine project (for Godot: the folder holding project.godot).');
  const kitId = schema.string().min(2).max(120).regex(/^[a-z0-9][a-z0-9._-]*$/i).describe('Kit id from the catalogue, dotted (e.g. vehicle.driveable).');

  const toolResult = (data: Record<string, unknown>, isError = false): CallToolResult => ({
    ...(isError ? { isError: true } : {}),
    structuredContent: data,
    content: [{ type: 'text', text: JSON.stringify(data) }],
  });
  const failure = (e: unknown, partial: Record<string, unknown> = {}): CallToolResult =>
    e instanceof LocalError
      ? toolResult({ ...partial, error: e.message, code: e.code, details: e.details }, true)
      : toolResult({ ...partial, error: message(e), code: 'internal' }, true);

  async function callDeliver(body: Record<string, unknown>, workspaceId: string | undefined, signal?: AbortSignal) {
    const key = options.getApiKey() ?? '';
    const res = await fetch(`${options.apiUrl.replace(/\/$/, '')}/api/v1/gamekits/deliver`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'x-gripforge-client': 'mcp',
        ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
        ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, data: isRecord(data) ? data : { error: `HTTP ${res.status}`, code: 'bad_response' } };
  }

  async function download(url: string, signal?: AbortSignal): Promise<Buffer> {
    const base = new URL(options.apiUrl);
    const target = new URL(url, base);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new LocalError('download_failed', `unsupported URL scheme ${target.protocol}`);
    const key = options.getApiKey();
    const res = await fetch(target, {
      headers: target.origin === base.origin && key ? { 'x-api-key': key, 'x-gripforge-client': 'mcp' } : {},
      signal: AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) throw new LocalError('download_failed', `HTTP ${res.status} for ${target.pathname}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BINARY_BYTES) throw new LocalError('download_failed', `${target.pathname} is larger than ${MAX_BINARY_BYTES} bytes`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BINARY_BYTES) throw new LocalError('download_failed', `${target.pathname} is larger than ${MAX_BINARY_BYTES} bytes`);
    return bytes;
  }

  /** Validate every action and gather contents; nothing touches the project yet. */
  async function prepare(dir: string, target: Target, plan: PlanDoc, bundle: BundleDoc, report: ApplyReport, signal?: AbortSignal): Promise<Step[]> {
    const godot = target === 'godot';
    const steps: Step[] = [];
    for (const [index, action] of plan.actions.entries()) {
      switch (action.op) {
        case 'backup':
          steps.push({ op: 'backup', rel: action.path, from: projectPath(dir, action.path, { godot }), to: projectPath(dir, action.to, { godot, what: 'backup target' }) });
          break;
        case 'write': {
          const text = bundle.files?.[action.path];
          if (typeof text !== 'string') throw new LocalError('bundle_incomplete', `bundle.files has no content for ${action.path}`, { index });
          const bytes = Buffer.from(text, 'utf8');
          if (sha256(bytes) !== String(action.sha256).toLowerCase()) throw new LocalError('hash_mismatch', `${action.path} does not match sha256 ${action.sha256}`, { index });
          steps.push({ op: 'write', rel: action.path, path: projectPath(dir, action.path, { godot }), bytes });
          break;
        }
        case 'writeBin': {
          const path = projectPath(dir, action.path, { godot });
          const ref = bundle.binaries?.[action.path];
          if (!ref) {
            report.skipped.push({ op: action.op, path: action.path, reason: 'binary not resolved: its Library item is neither in the workspace nor published' });
            break;
          }
          const bytes = 'base64' in ref ? Buffer.from(ref.base64, 'base64') : await download(ref.url, signal);
          const expected = (action.sha256 ?? ref.sha256)?.toLowerCase();
          if (expected && SHA256_RE.test(expected) && sha256(bytes) !== expected) throw new LocalError('hash_mismatch', `${action.path} does not match sha256 ${expected}`, { index });
          steps.push({ op: 'write', rel: action.path, path, bytes });
          break;
        }
        case 'delete': {
          const siblings = (action.alsoSiblings ?? []).map((s) => (s.startsWith('.') ? `${action.path}${s}` : s));
          steps.push({
            op: 'delete',
            rel: action.path,
            path: projectPath(dir, action.path, { godot }),
            siblings: siblings.map((rel) => ({ rel, path: projectPath(dir, rel, { godot, what: 'sibling' }) })),
          });
          break;
        }
        case 'writeLock': {
          const prev = action.previous && action.previous.endsWith('.json') ? action.previous : PREV_LOCK_PATH;
          steps.push({
            op: 'lock',
            rel: action.path,
            path: projectPath(dir, action.path, { godot, what: 'lock path' }),
            previous: action.previous,
            prevPath: projectPath(dir, prev, { godot, what: 'previous lock path' }),
            bytes: Buffer.from(serializeEngineLock(bundle.lock), 'utf8'),
          });
          break;
        }
        case 'refresh':
          break;
        default:
          throw new LocalError('unknown_action', `unknown action ${String((action as { op?: unknown }).op)}`, { index });
      }
    }
    return steps;
  }

  async function execute(dir: string, planId: string, steps: Step[], report: ApplyReport): Promise<void> {
    const saved = new Set<string>();
    const keep = async (rel: string, from: string, to: string) => {
      if (saved.has(rel) || !(await isFile(from))) return;
      saved.add(rel);
      if (await isFile(to)) return; // a retried delivery keeps the original backup
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      report.backedUp.push(rel);
    };
    const safety = (rel: string, path: string) => keep(rel, path, under(dir, `${BACKUP_DIR}/${planId}/${rel}`));

    for (const [index, step] of steps.entries()) {
      try {
        switch (step.op) {
          case 'backup':
            if (await isFile(step.from)) await keep(step.rel, step.from, step.to);
            else report.warnings.push(`backup: ${step.rel} is not in the project, nothing to save`);
            break;
          case 'write':
            await safety(step.rel, step.path);
            await atomicWrite(step.path, step.bytes);
            report.written.push(step.rel);
            break;
          case 'delete':
            if (await isFile(step.path)) {
              await safety(step.rel, step.path);
              await rm(step.path, { force: true });
              report.deleted.push(step.rel);
            } else {
              report.missing.push(step.rel);
            }
            for (const sibling of step.siblings) {
              if (!(await isFile(sibling.path))) continue;
              await safety(sibling.rel, sibling.path);
              await rm(sibling.path, { force: true });
              report.deleted.push(sibling.rel);
            }
            break;
          case 'lock':
            if (step.previous !== null && (await isFile(step.path))) {
              await mkdir(dirname(step.prevPath), { recursive: true });
              await copyFile(step.path, step.prevPath);
            }
            await atomicWrite(step.path, step.bytes);
            report.lock = step.rel;
            break;
        }
      } catch (e) {
        throw new LocalError('io', `${step.op} ${step.rel} failed: ${message(e)}`, { index, hint: `gripforge_gamekit_rollback_local { project_dir, backup_id: "${planId}" } restores the backups taken so far` });
      }
    }
  }

  register(
    'gripforge_gamekit_deliver_local',
    {
      title: 'Deliver Game Kits into a local engine project',
      description:
        'npm client only. Deliver Game Kits straight into an engine project folder on this machine: hashes project_dir/gripforge/**, reads gripforge/gamekits.lock.json, asks the GripForge API for the plan, then executes plan.actions with fs — every overwritten or deleted file is copied to gripforge/.backup/<plan id>/ first and the lock is written last. Paths are checked inside project_dir (Godot: gripforge/ and assets/gripforge/ only) and every hash is verified before anything is written. Run dry_run=true first. A blocked plan (conflicts, breaking update) returns the conflicts without touching files: re-run with force or accept_breaking. verify=true runs Godot headless (import, then each kit smoke.gd) when GODOT_BIN is set. Undo with gripforge_gamekit_rollback_local. Credits: the first delivery of a kit major version to an engine costs 1 credit per workspace; re-deliveries, updates within a major and dry runs are free.',
      inputSchema: {
        project_dir: projectDirField,
        target: schema.enum(TARGETS).optional().describe('Engine of the project: godot (default), unity or unreal.'),
        kits: schema
          .array(
            schema.object({
              id: kitId,
              version: schema.string().max(40).optional().describe('Exact version; only the latest is deliverable.'),
              config: schema.record(schema.string(), schema.unknown()).optional().describe('Kit config, validated against its configSchema.'),
              bindings: schema.record(schema.string(), schema.string()).optional().describe('Asset slot → Library item id (lib_…).'),
            }),
          )
          .max(16)
          .optional()
          .describe('Kits to deliver (at most 16). Omit to deliver the enabled kits of project_id.'),
        project_id: schema.string().min(4).max(80).optional().describe('Game Kit project (gkp_…) whose enabled kits, config and bindings are delivered when kits is omitted.'),
        mode: schema.enum(['install', 'update', 'uninstall']).optional().describe('install (default), update to the latest catalogue version, or uninstall (uses the lock).'),
        dry_run: schema.boolean().optional().describe('true → plan only; nothing is written or charged.'),
        force: schema.boolean().optional().describe('true → back up then overwrite edited managed files and existing seed files.'),
        accept_breaking: schema.boolean().optional().describe('true → allow a breaking (major) update.'),
        verify: schema.boolean().optional().describe('true → after writing, run Godot headless (import + smoke.gd per kit) when GODOT_BIN is set.'),
        ...workspace,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args, extra) => {
      if (!options.getApiKey()) return toolResult({ error: 'GripForge API key required.', code: 'unauthorized' }, true);
      const report: ApplyReport = { backedUp: [], written: [], deleted: [], missing: [], skipped: [], lock: null, warnings: [] };
      let context: Record<string, unknown> = {};
      try {
        const dir = await projectDir(args.project_dir);
        const target = (typeof args.target === 'string' ? args.target : 'godot') as Target;
        if (!TARGETS.includes(target)) throw new LocalError('bad_request', 'target must be godot, unity or unreal');
        if (target === 'godot' && !(await isFile(join(dir, 'project.godot')))) throw new LocalError('not_a_project', `${dir} has no project.godot: pass the Godot project folder`);
        const kits = Array.isArray(args.kits) ? args.kits : [];
        const mode = typeof args.mode === 'string' ? args.mode : 'install';
        const { lock, warning } = await readLock(dir, LOCK_PATH);
        if (warning) report.warnings.push(warning);
        if (!kits.length && typeof args.project_id !== 'string' && !(mode === 'uninstall' && lock)) throw new LocalError('bad_request', 'Pass kits [{ id }] or project_id (gkp_…).');
        const files = await hashProject(dir, lock);
        const engineVersion = target === 'godot' ? await godotVersion(dir) : undefined;
        const dryRun = args.dry_run === true;
        context = { project_dir: dir, target, dry_run: dryRun, hashed: Object.keys(files).length };

        const { status, data } = await callDeliver(
          {
            target,
            ...(kits.length ? { kits } : {}),
            ...(typeof args.project_id === 'string' ? { projectId: args.project_id } : {}),
            mode,
            project: { target, ...(engineVersion ? { engineVersion } : {}), lock, files },
            dryRun,
            force: args.force === true,
            acceptBreaking: args.accept_breaking === true,
          },
          typeof args.workspace_id === 'string' ? args.workspace_id : undefined,
          extra?.signal,
        );
        if (status >= 400) return toolResult({ ...context, applied: false, error: data.error ?? `HTTP ${status}`, code: data.code ?? 'http_error', details: data.details ?? {}, plan: planView(data.plan) }, true);

        const plan = data.plan as PlanDoc | undefined;
        const bundle = data.bundle as BundleDoc | undefined;
        if (!plan || !Array.isArray(plan.actions)) throw new LocalError('bad_response', 'the API answered without a plan');
        context = { ...context, plan: planView(plan), entitlement: data.entitlement, next: data.next };
        if (dryRun || !bundle) return toolResult({ ...context, applied: false, ...report });
        if (bundle.planId !== plan.id) throw new LocalError('bundle_mismatch', `bundle ${bundle.planId} was not emitted for plan ${plan.id}`);
        if (!BACKUP_ID_RE.test(plan.id)) throw new LocalError('bad_response', `plan id ${plan.id} cannot name a backup folder`);

        const steps = await prepare(dir, target, plan, bundle, report, extra?.signal);
        await execute(dir, plan.id, steps, report);

        let verify: unknown;
        if (args.verify === true) {
          const bin = options.godotBin?.() ?? process.env.GODOT_BIN;
          verify = target !== 'godot' ? { skipped: 'verify runs for Godot projects only' } : !bin ? { skipped: 'set GODOT_BIN to a Godot 4 binary to verify' } : await verifyGodot(dir, plan.kits ?? [], bin);
        }
        const failed = isRecord(verify) && verify.ok === false;
        return toolResult({ ...context, applied: true, ...report, ...(verify ? { verify } : {}) }, failed);
      } catch (e) {
        return failure(e, { ...context, applied: false, ...report });
      }
    },
  );

  register(
    'gripforge_gamekit_rollback_local',
    {
      title: 'Roll back the last local Game Kit delivery',
      description:
        'npm client only. Undo the last gripforge_gamekit_deliver_local in project_dir: restores every file saved in gripforge/.backup/<lock id>/, removes the files that delivery added when you did not edit them (edited ones are kept and listed), and puts gripforge/gamekits.lock.prev.json back as gripforge/gamekits.lock.json (or removes the lock after a first install). Pass backup_id (a plan id) to restore the backups of a delivery that failed before writing its lock. Backups are never deleted. 0 credits.',
      inputSchema: {
        project_dir: projectDirField,
        backup_id: schema.string().max(128).optional().describe('Backup folder (plan id) to restore instead of the current lock id; only restores files, the lock is left as is.'),
        ...workspace,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const report = { restored: [] as string[], removed: [] as string[], keptModified: [] as string[], unrestorable: [] as string[], lock: 'unchanged' };
      let context: Record<string, unknown> = {};
      try {
        const dir = await projectDir(args.project_dir);
        const { lock } = await readLock(dir, LOCK_PATH);
        const { lock: prev } = await readLock(dir, PREV_LOCK_PATH);
        const explicit = typeof args.backup_id === 'string' && args.backup_id.trim() ? args.backup_id.trim() : null;
        const backupId = explicit ?? lock?.id ?? null;
        if (!backupId) throw new LocalError('lock_required', `no ${LOCK_PATH} in ${dir}: nothing to roll back (pass backup_id to restore a backup folder)`);
        if (!BACKUP_ID_RE.test(backupId)) throw new LocalError('bad_request', `invalid backup id ${backupId}`);
        context = { project_dir: dir, backup_id: backupId };

        const root = `${BACKUP_DIR}/${backupId}`;
        const restored = new Set<string>();
        await walkFiles(dir, root, async (rel) => {
          const original = rel.slice(root.length + 1);
          const dest = projectPath(dir, original, { godot: false, what: 'restore target' });
          await mkdir(dirname(dest), { recursive: true });
          await copyFile(under(dir, rel), dest);
          restored.add(original);
          report.restored.push(original);
        });

        if (!explicit && lock) {
          const prevOwned = new Set(prev?.ownedPaths ?? []);
          const locked = lockedHashes(lock);
          for (const owned of lock.ownedPaths ?? []) {
            if (prevOwned.has(owned) || restored.has(owned)) continue;
            const path = projectPath(dir, owned, { godot: false });
            if (!(await isFile(path))) continue;
            if (locked[owned] && sha256(await readFile(path)) !== locked[owned]) {
              report.keptModified.push(owned);
              continue;
            }
            await rm(path, { force: true });
            for (const suffix of DERIVED) await rm(`${path}${suffix}`, { force: true });
            report.removed.push(owned);
          }
          for (const [owned, sha] of Object.entries(lockedHashes(prev))) {
            if (restored.has(owned)) continue;
            const path = projectPath(dir, owned, { godot: false });
            const current = (await isFile(path)) ? sha256(await readFile(path)) : null;
            if (current !== sha) report.unrestorable.push(owned);
          }
          const lockPath = under(dir, LOCK_PATH);
          const prevPath = under(dir, PREV_LOCK_PATH);
          if (prev) {
            await atomicWrite(lockPath, await readFile(prevPath));
            await rm(prevPath, { force: true });
            report.lock = `restored ${prev.id}`;
          } else {
            await rm(lockPath, { force: true });
            report.lock = 'removed (the rolled back delivery was the first install)';
          }
        }
        return toolResult({ ...context, ...report }, false);
      } catch (e) {
        return failure(e, { ...context, ...report });
      }
    },
  );
}
