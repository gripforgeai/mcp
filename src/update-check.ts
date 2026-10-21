/**
 * Startup update check of the npm MCP client (@gripforgeai/mcp).
 *
 * The npm registry is the source of truth: it is what `npx -y @gripforgeai/mcp@latest` runs next time.
 * The check never blocks or fails the start: it runs after the server is connected, gives up after a short
 * timeout and keeps its answer in a small state file for a few hours. The state file also remembers the last
 * version that ran (to say "updated from X to Y") and which notices were already shown, so each notice reaches
 * the AI agent once per version, appended to a single tool result.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_PACKAGE = '@gripforgeai/mcp';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CACHE_MS = 6 * 60 * 60 * 1000;

/** The version of this package, read from its own package.json (never a hand-kept constant). */
export function packageVersion(url = new URL('../package.json', import.meta.url)): string {
  try {
    const v = JSON.parse(readFileSync(url, 'utf8')).version;
    if (typeof v === 'string' && VERSION.test(v)) return v;
  } catch { /* fall through */ }
  return '0.0.0';
}

/** Same rule as the CLI (packages/grip-forge/src/update.ts): strict x.y.z, anything else is never newer. */
export function newerVersion(latest: string, current: string) {
  if (!VERSION.test(latest) || !VERSION.test(current)) return false;
  const a = latest.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

/** How this process was launched, which decides what "update" means. */
export type LaunchMode = 'npx' | 'global' | 'local';
export function launchMode(entry = process.argv[1] ?? fileURLToPath(import.meta.url)): LaunchMode {
  const p = entry.split(sep).join('/');
  if (p.includes('/_npx/')) return 'npx';
  if (/\/node_modules\/@gripforgeai\/mcp\//.test(p)) return 'global';
  return 'local';
}

type State = {
  checked_at?: number;
  latest?: string;
  last_version?: string;
  notified_available?: string;
  notified_updated?: string;
};

export type UpdateOptions = {
  current?: string;
  file?: string;
  registry?: string;
  fetcher?: typeof fetch;
  timeout?: number;
  now?: () => number;
  mode?: LaunchMode;
};

export const stateFile = () =>
  process.env.GRIPFORGE_MCP_UPDATE_FILE || join(homedir(), '.gripforge', 'mcp-update.json');

async function readState(file: string): Promise<State> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as State : {};
  } catch { return {}; }
}

async function writeState(file: string, state: State) {
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, file);
  } catch { /* A read-only home must not stop the MCP. */ }
}

/** The latest published version, or undefined when the registry is unreachable, slow or answers garbage. */
export async function fetchLatest(options: UpdateOptions = {}): Promise<string | undefined> {
  const registry = (options.registry ?? process.env.GRIPFORGE_MCP_REGISTRY ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  try {
    // Public metadata only: never send the GripForge API key to the registry.
    const res = await (options.fetcher ?? fetch)(`${registry}/${MCP_PACKAGE.replace('/', '%2f')}/latest`, {
      redirect: 'follow', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeout ?? 2500),
    });
    if (!res.ok) return undefined;
    const text = await res.text();
    if (text.length > 1_000_000) return undefined;
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === 'string' && VERSION.test(version) ? version : undefined;
  } catch { return undefined; }
}

const restartHint = (mode: LaunchMode, latest: string) =>
  mode === 'npx'
    ? `Restart the GripForge MCP (or your AI client) to load it: a launch with \`npx -y ${MCP_PACKAGE}@latest\` takes it on its own. If your MCP config pins a version, replace it with @latest.`
    : mode === 'global'
      ? `Update it with \`npm install -g ${MCP_PACKAGE}@${latest}\`, or register the MCP as \`npx -y ${MCP_PACKAGE}@latest\` to always run the latest, then restart the MCP.`
      : `Rebuild this checkout or register the MCP as \`npx -y ${MCP_PACKAGE}@latest\`, then restart the MCP.`;

/**
 * The once-per-version notices for this start. `updated` is known at once from the state file; `available`
 * needs the registry (cached CACHE_MS). Each returned notice is marked as shown in the state file.
 */
export async function startupNotices(options: UpdateOptions = {}): Promise<string[]> {
  const file = options.file ?? stateFile();
  const current = options.current ?? packageVersion();
  const now = (options.now ?? Date.now)();
  const mode = options.mode ?? launchMode();
  const state = await readState(file);
  const notices: string[] = [];

  if (state.last_version && newerVersion(current, state.last_version) && state.notified_updated !== current) {
    notices.push(`GripForge MCP updated from ${state.last_version} to ${current}. Tell the user once.`);
    state.notified_updated = current;
  }
  state.last_version = current;

  let latest = typeof state.latest === 'string' ? state.latest : undefined;
  const fresh = typeof state.checked_at === 'number' && now - state.checked_at >= 0 && now - state.checked_at < CACHE_MS;
  if (!fresh) {
    const fetched = await fetchLatest(options);
    // A failed check is not recorded: the next start tries again, the old answer stays a fallback.
    if (fetched) { latest = fetched; state.latest = fetched; state.checked_at = now; }
  }
  if (latest && newerVersion(latest, current) && state.notified_available !== latest) {
    notices.push(`GripForge MCP ${latest} is available (running ${current}). ${restartHint(mode, latest)} Tell the user once.`);
    state.notified_available = latest;
  }
  await writeState(file, state);
  return notices;
}

type Message = { result?: { content?: unknown } };

/**
 * Appends pending notices to the next tool result going out through `transport`, then stops. Only tool
 * results carry a `content` array (prompts use `messages`, resources `contents`), so nothing else is touched.
 */
export function attachNotices<T extends { send: (message: never, ...rest: never[]) => Promise<void> }>(transport: T, pending: Promise<string[]>) {
  let queue: string[] = [];
  void pending.then((n) => { queue = queue.concat(n); }, () => {});
  const send = transport.send.bind(transport) as (message: Message, ...rest: unknown[]) => Promise<void>;
  (transport as unknown as { send: typeof send }).send = (message: Message, ...rest: unknown[]) => {
    const content = message?.result?.content;
    if (queue.length && Array.isArray(content)) {
      const text = queue.join('\n');
      queue = [];
      message = { ...message, result: { ...message.result, content: [...content, { type: 'text', text }] } };
    }
    return send(message, ...rest);
  };
  return transport;
}

/** Wire the startup check into the server. Disabled with GRIPFORGE_MCP_NO_UPDATE_CHECK=1. */
export function startUpdateCheck<T extends { send: (message: never, ...rest: never[]) => Promise<void> }>(transport: T, options: UpdateOptions = {}) {
  if (process.env.GRIPFORGE_MCP_NO_UPDATE_CHECK === '1') return transport;
  const pending = startupNotices(options).then((notices) => {
    for (const n of notices) process.stderr.write(`${n}\n`);
    return notices;
  }, () => [] as string[]);
  return attachNotices(transport, pending);
}
