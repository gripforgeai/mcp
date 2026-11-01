/**
 * « On ne refuse jamais » (docs/refus-metier.md): every tool answer whose JSON carries `warnings`
 * [{ code, message, skipped, howToFix }] gets one more text block that states them to the user's AI, so that what
 * GripForge skipped to go on is never lost in a large JSON. Used by the npm server and the hosted MCP.
 */
import { formatWarnings, warningsOf } from './warnings.generated.js';

type Content = { type: string; text?: string };
type ToolResult = { content?: Content[]; structuredContent?: unknown; isError?: boolean };

export function surfaceToolWarnings<T>(result: T): T {
  if (!result || typeof result !== 'object') return result;
  const r = result as ToolResult;
  let data: unknown = r.structuredContent;
  if (!data && Array.isArray(r.content)) {
    const text = r.content.find(c => c.type === 'text' && typeof c.text === 'string' && c.text.trimStart().startsWith('{'))?.text;
    if (text) try { data = JSON.parse(text); } catch { /* not JSON */ }
  }
  const warnings = warningsOf(data);
  if (!warnings.length) return result;
  const block = formatWarnings(warnings, (data as { applied?: unknown }).applied !== false);
  if (r.content?.some(c => c.text === block)) return result;
  return { ...r, content: [...(r.content ?? []), { type: 'text', text: block }] } as T;
}

/** Wraps a tool callback so that its answer surfaces its warnings. */
export function withSurfacedWarnings<A extends unknown[], R>(cb: (...args: A) => R | Promise<R>) {
  return async (...args: A): Promise<R> => surfaceToolWarnings(await cb(...args));
}

/** Patches `registerTool` (and the older `tool`) of an MCP server so that every tool surfaces its warnings. */
export function surfaceWarningsOnServer(server: object) {
  const s = server as Record<string, unknown>;
  for (const method of ['registerTool', 'tool']) {
    const original = s[method];
    if (typeof original !== 'function') continue;
    s[method] = function (this: unknown, ...args: unknown[]) {
      const last = args.length - 1;
      if (typeof args[last] === 'function') args[last] = withSurfacedWarnings(args[last] as (...a: unknown[]) => unknown);
      return (original as (...a: unknown[]) => unknown).apply(server, args);
    };
  }
}
