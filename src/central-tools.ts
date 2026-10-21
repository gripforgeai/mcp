/**
 * The app server of a game, for an AI agent: thin tools over the GripForge CLI (the same code as
 * `gripforge create central-server|rooms-server` and `gripforge central add|remove|status`), run with --json.
 * The CLI is `gripforge` on the PATH, or GRIPFORGE_CLI (a path to its bin.js or executable).
 * Errors are the CLI's, named (central_url_missing, central_not_applied…); a missing CLI is gripforge_cli_missing.
 */
import { execFile } from 'node:child_process';
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const CENTRAL_TOOL_NAMES = ['gripforge_central_server_create', 'gripforge_rooms_server_create', 'gripforge_central_apply'] as const;

/** The command line of the CLI: [file, ...args]. */
export function cliCommand(args: string[], cli = process.env.GRIPFORGE_CLI): [string, string[]] {
  if (cli && /\.(m?js)$/.test(cli)) return [process.execPath, [cli, ...args]];
  return [cli || 'gripforge', args];
}

export function runCli(args: string[], signal?: AbortSignal): Promise<CallToolResult> {
  const [file, argv] = cliCommand([...args, '--json']);
  return new Promise((resolve) => {
    execFile(file, argv, { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 300_000, signal, env: { ...process.env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ isError: true, content: [{ type: 'text', text: `gripforge_cli_missing: ${file} not found. Install the GripForge CLI or set GRIPFORGE_CLI to its path.` }] });
        return;
      }
      if (error) {
        resolve({ isError: true, content: [{ type: 'text', text: (stderr || error.message).trim().split('\n').slice(-6).join('\n') }] });
        return;
      }
      try {
        const data = JSON.parse(stdout.trim().split('\n').pop() ?? '') as Record<string, unknown>;
        resolve({ structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });
      } catch {
        resolve({ isError: true, content: [{ type: 'text', text: `cli_output_invalid: ${stdout.slice(-400)}` }] });
      }
    });
  });
}

export function registerCentralTools(register: VfxProjectRegister, schema: typeof z = z) {
  const annotations = (readOnly: boolean, destructive = false) => ({ readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: false });
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const opt = (flag: string, v: unknown) => (str(v) ? [flag, String(v)] : []);

  register(CENTRAL_TOOL_NAMES[0], {
    title: 'Create the central server (app server) starter',
    description: 'Write the studio\'s central server into a new local folder: a NestJS starter the studio runs as is and changes (accounts and sign in, sessions, short signed tickets, directory of rooms servers, launch, match results; later payments or chat as modules). SQLite by default (db=postgres for Postgres), tickets of 60 s. Returns { dir, secret, next }: `secret` is GF_CENTRAL_SECRET, give it to gripforge_rooms_server_create. Run `npm install && npm start` in dir. Same as `gripforge create central-server`.',
    inputSchema: {
      folder: schema.string().min(1).max(400).describe('New (or empty) local folder for the starter.'),
      db: schema.enum(['sqlite', 'postgres']).optional().describe('Database: sqlite (default, a file) or postgres (GF_DB_URL in .env).'),
      central_pkg: schema.string().max(400).optional().describe('Development only: a version or a local path of @gripforgeai/central.'),
    },
    annotations: annotations(false),
  }, (args, extra) => runCli(['create', 'central-server', String(args.folder), ...opt('--db', args.db), ...opt('--central-pkg', args.central_pkg)], extra?.signal));

  register(CENTRAL_TOOL_NAMES[1], {
    title: 'Create a rooms server starter linked to central',
    description: 'Only for an online multiplayer game. Write a rooms server (NestJS starter: rooms, challenges, one match server per match) into a new local folder, linked to the central server: players enter it with central\'s ticket. Declared match servers are the studio\'s only (a studio token is generated with placement declared or both). Returns { dir, studioToken?, next }; run `npm install && npm start` in dir after central. Same as `gripforge create rooms-server --central <url> --central-secret <secret>`.',
    inputSchema: {
      folder: schema.string().min(1).max(400).describe('New (or empty) local folder for the starter.'),
      central_url: schema.string().max(512).describe('Address of the central server (http(s)://host:port).'),
      central_secret: schema.string().min(16).max(200).describe('GF_CENTRAL_SECRET of central (the `secret` gripforge_central_server_create returned).'),
      placement: schema.enum(['hosted', 'declared', 'both']).optional().describe('Where matches run: hosted (default: the rooms server starts one per match), declared (the studio\'s own servers), both.'),
      net: schema.string().max(400).optional().describe('Development only: a version or a local path of @gripforgeai/net.'),
    },
    annotations: annotations(false),
  }, (args, extra) => runCli(['create', 'rooms-server', String(args.folder), '--central', String(args.central_url), '--central-secret', String(args.central_secret), ...opt('--placement', args.placement), ...opt('--net', args.net)], extra?.signal));

  register(CENTRAL_TOOL_NAMES[2], {
    title: 'Plug a game into its app server (central)',
    description: 'Optional for any game (solo too); never apply it unless the game needs accounts or the studio\'s central server, or the user asks. action=add installs central.client with its ready-made account view (ui.webui, menu) and sets central\'s address (url, else GF_CENTRAL_URL); multiplayer=true also installs net.rooms + net.transport with the rooms view (only for an online multiplayer game; app = the GF_APP of the rooms server). action=remove takes the preset\'s kits and views out again (net.transport stays only if another kit needs it). action=status reads { applied, url, multiplayer, app, kits }. Named errors: central_url_missing, central_url_invalid, central_app_invalid, central_not_applied. Same as `gripforge central add|remove|status <gkp_id>`.',
    inputSchema: {
      project_id: schema.string().min(5).max(80).describe('Game Kit project id (gkp_…).'),
      action: schema.enum(['add', 'remove', 'status']).optional().describe('add (default), remove or status.'),
      url: schema.string().max(512).optional().describe('add: address of the central server (http(s)://host:port).'),
      multiplayer: schema.boolean().optional().describe('add: true for an online multiplayer game (net.rooms + rooms view).'),
      app: schema.string().max(64).optional().describe('add with multiplayer: application id the rooms server checks (its GF_APP, e.g. my-game@1).'),
    },
    annotations: annotations(false, true),
  }, (args, extra) => {
    const action = str(args.action) ?? 'add';
    return runCli(['central', action, String(args.project_id), ...(action === 'add' ? [...opt('--url', args.url), ...(args.multiplayer === true ? ['--multiplayer'] : []), ...opt('--app', args.app)] : [])], extra?.signal);
  });
}
