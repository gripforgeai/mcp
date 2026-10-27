/**
 * The core loop rule on a local game or kit folder (docs/game-engine-contract.md §12): the MCP side of
 * `gripforge game-check --loop`. The work is core-loop.generated.ts, the same code as the CLI, the kit build and the
 * hosted audit. Registered by `server.ts` only: the hosted MCP never reaches the caller's disk.
 */
import { isAbsolute } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod/v4';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { VfxProjectRegister } from './vfx-project-tools.js';
import { CORE_LOOP_RULES, CORE_LOOP_TICK_TABLE, checkCoreLoopFiles, collectCoreLoopFiles } from './core-loop.generated.js';

export const CORE_LOOP_TOOL_NAMES = ['gripforge_core_loop_check'] as const;

const ok = (data: object): CallToolResult => ({ structuredContent: data as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (error: unknown): CallToolResult => ({ isError: true, content: [{ type: 'text', text: String(error instanceof Error ? error.message : error).slice(0, 2000) }] });

export function coreLoopCheck(path: string) {
  const files = collectCoreLoopFiles(path, {
    readdir: (p) => readdirSync(p), isDirectory: (p) => statSync(p).isDirectory(), size: (p) => statSync(p).size, read: (p) => readFileSync(p, 'utf8'),
  });
  const issues = checkCoreLoopFiles(files);
  return { ok: issues.length === 0, files: files.length, issues, tick_table: CORE_LOOP_TICK_TABLE };
}

export function registerCoreLoopTools(register: VfxProjectRegister, schema: typeof z = z) {
  const shape = { path: schema.string().min(1).max(4096).describe('Absolute path of the game folder (web export, Godot, Unity or Unreal project) or of a kit folder.') };
  register(CORE_LOOP_TOOL_NAMES[0], {
    title: 'Check the core loop rule of a local game or kit',
    description: `Check a game or kit folder on this machine against the core loop rule every GripForge game follows (docs/game-engine-contract.md §12): game logic only on the game tick (game.engine tick.hz set explicitly), frame/present hooks and physics callbacks read only, the GripForge tick stepped from the frame callback and never from _physics_process / FixedUpdate, the engine physics step not retuned, no tick path waiting on another thread, and the render/physics Workers and shared memory not turned off without a stated reason. Rules: ${Object.values(CORE_LOOP_RULES).map((r) => r.id).join(', ')}. Each problem comes with its file, line and fix. ok=false fails the game or kit; same check as gripforge game-check --loop (CLI), refused by gripforge kit build. Free, local, reads only.`,
    inputSchema: shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    const parsed = schema.object(shape).strict().safeParse(args);
    if (!parsed.success) return fail(parsed.error.message);
    try {
      if (!isAbsolute(parsed.data.path)) throw Error(`path must be an absolute path (got ${parsed.data.path})`);
      if (!statSync(parsed.data.path).isDirectory()) throw Error('path must be a folder');
      return ok(coreLoopCheck(parsed.data.path));
    } catch (e) { return fail(e); }
  });
}
