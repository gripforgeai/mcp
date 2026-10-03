import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

/**
 * Les outils MCP des outils chaînés (studios → outils → étapes), enregistrés par le MCP hébergé
 * (`apps/web/src/lib/mcp-server.ts`) et par le client npm (`server.ts`).
 *
 * Même contrat que la library : tout passe par `/api/v1/tools*`, ouvert aux membres du workspace de
 * la clé (lecture pour tous, lancer et corriger pour ceux qui écrivent dans le casier). Quand une
 * chaîne s'arrête, la réponse porte l'étape, la phrase qui dit quoi
 * faire et l'URL où le faire — on ne décrit pas le problème, on donne l'endroit où le régler.
 */
export const STUDIO_TOOLS_TOOL_NAMES = ['gripforge_studios', 'gripforge_tool_run', 'gripforge_tool_runs', 'gripforge_mesh_passport'] as const;

export function registerStudioToolsTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, schema: typeof z = z) {
  const libId = schema.string().regex(/^lib_[A-Za-z0-9_-]{8,64}$/);
  const ws = schema.string().max(100).optional().describe('Workspace id (defaults to the key’s workspace).');
  const shapes = {
    studios: { item_id: libId.optional().describe('A locker item: the answer says which tools are possible on it right now.'), workspace_id: ws },
    run: {
      tool: schema.string().min(1).max(40).describe('Tool id from gripforge_studios (passport, rig, mannequin).'),
      item_id: libId.optional().describe('Locker item the chain works on. mannequin without item = the adult canon.'),
      step: schema.string().max(40).optional().describe('Replay ONE step (the one you just corrected) instead of the whole chain.'),
      force: schema.boolean().optional().describe('Recompute fresh blocks too. Default: fresh blocks are skipped.'),
      workspace_id: ws,
    },
    runs: {
      item_id: libId.optional(),
      tool: schema.string().max(40).optional(),
      limit: schema.number().int().min(1).max(100).optional(),
      workspace_id: ws,
    },
    passport: {
      item_id: libId,
      manual: schema.record(schema.string(), schema.unknown()).optional().describe('Partial PassportManual to MERGE (e.g. {"orientation":{"up":[0,1,0],"front":[0,0,1],"toCanonical":[0,0,0,1],"confidence":1,"source":"manual"}}). Omit to read.'),
      clear: schema.string().max(60).optional().describe('Remove one correction (orientation, joints.elbow.L, fits.helm) or "*" for all.'),
      workspace_id: ws,
    },
  };

  async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, args: Record<string, unknown>, body?: unknown, signal?: AbortSignal) {
    const key = options.getApiKey();
    if (!key) return { isError: true, content: [{ type: 'text' as const, text: 'GripForge API key required.' }] };
    const ws = typeof args.workspace_id === 'string' ? args.workspace_id : null;
    try {
      const response = await fetch(options.apiUrl.replace(/\/$/, '') + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-gripforge-client': 'mcp', 'x-api-key': key, ...(ws ? { 'x-workspace-id': ws } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]),
      });
      const data = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
      return { ...(!response.ok ? { isError: true } : {}), structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'GripForge tools request failed.' }] };
    }
  }

  const q = (o: Record<string, unknown>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  const tools: { name: (typeof STUDIO_TOOLS_TOOL_NAMES)[number]; title: string; description: string; shape: Record<string, z.ZodType>; readOnly: boolean; run: (a: Record<string, unknown>, signal?: AbortSignal) => ReturnType<typeof call> }[] = [
    {
      name: 'gripforge_studios', title: 'Studios · tools map', readOnly: true, shape: shapes.studios,
      description: 'The map of GripForge studios and their chained tools (steps, kind code/ai/tool/analysis, manual equivalent of each step). Call it BEFORE guessing a tool name. With item_id, `available` says what is possible on that item now.',
      run: (a, s) => call('GET', `/api/v1/tools${q({ item: a.item_id })}`, a, undefined, s),
    },
    {
      name: 'gripforge_tool_run', title: 'Studios · run a chained tool', readOnly: false, shape: shapes.run,
      description: 'Run a chained tool server-side (computation happens in the GripForge compute service). Returns the step-by-step run. status "needs-manual" = the chain stopped on purpose: read manual_hint, fix it (gripforge_mesh_passport) or send the user to `url`, then replay with step=<that step>. mannequin with an item = chain passport → rig → mannequin, a new locker item.',
      run: (a, s) => call('POST', '/api/v1/tools/run', a, { tool: a.tool, id: a.item_id ?? null, step: a.step ?? null, force: a.force === true, source: 'mcp' }, s),
    },
    {
      name: 'gripforge_tool_runs', title: 'Studios · run history', readOnly: true, shape: shapes.runs,
      description: 'The shared history of chained-tool runs (web page and agents alike), newest first: which tool, on which item, each step, where it stopped and the URL to resume.',
      run: (a, s) => call('GET', `/api/v1/tools/runs${q({ item: a.item_id, tool: a.tool, limit: a.limit })}`, a, undefined, s),
    },
    {
      name: 'gripforge_mesh_passport', title: 'Studios · mesh passport', readOnly: false, shape: shapes.passport,
      description: 'Read or correct the passport of a locker mesh (size, orientation, reference skeleton, colliders). `manual` merges a human correction (it always wins and survives regeneration); `clear` removes one. Measurements themselves come from gripforge_tool_run tool=passport.',
      run: (a, s) => {
        const path = `/api/v1/tools/passport/${a.item_id}`;
        if (typeof a.clear === 'string') return call('DELETE', `${path}${a.clear === '*' ? '' : q({ field: a.clear })}`, a, undefined, s);
        if (a.manual) return call('PUT', path, a, { manual: a.manual }, s);
        return call('GET', path, a, undefined, s);
      },
    },
  ];

  for (const tool of tools) {
    register(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.shape,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.readOnly, openWorldHint: false },
    }, async (args, extra) => {
      const parsed = schema.object(tool.shape).strict().safeParse(args);
      if (!parsed.success) return { isError: true, content: [{ type: 'text', text: parsed.error.message }] };
      return tool.run(parsed.data as Record<string, unknown>, extra?.signal);
    });
  }
}
