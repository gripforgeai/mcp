import type { z } from 'zod/v4';
/** Three.js n'est plus une cible de build : toute demande l'indiquant est refusée explicitement (jamais remappée). */
export const THREEJS_REMOVED_MESSAGE = "Three.js n'est plus une cible supportée ; utilisez web (lecteur GripForge), godot, unity ou unreal";
export function isRemovedThreeTarget(v: unknown): boolean {
  return typeof v === 'string' && ['threejs', 'three', 'three.js', 'r3f'].includes(v.toLowerCase());
}
/** z.enum dont l'erreur est le message Three.js retiré quand la valeur envoyée est threejs/three. */
export function targetEnum<const T extends readonly [string, ...string[]]>(schema: typeof z, values: T) {
  // `error` : zod 4 ; `errorMap` : zod 3 (le client npm peut recevoir l'un ou l'autre).
  const opts = {
    error: (issue: { input?: unknown }) => (isRemovedThreeTarget(issue.input) ? THREEJS_REMOVED_MESSAGE : undefined),
    errorMap: (issue: { message?: string }, ctx: { data?: unknown; defaultError: string }) => ({ message: isRemovedThreeTarget(ctx.data) ? THREEJS_REMOVED_MESSAGE : (ctx.defaultError ?? issue.message ?? '') }),
  };
  return schema.enum(values, opts as never);
}
