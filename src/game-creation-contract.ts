import { z } from 'zod/v4';

/** One command contract for the hosted orchestrator and both MCP transports. */
export function creationWriteShape(schema: typeof z = z) {
  return {
    action: schema.enum(['create', 'select', 'use_reference', 'approve_concept', 'approve_asset', 'quote', 'accept', 'cancel', 'retry', 'dismiss', 'quote_continuation', 'accept_continuation']),
    id: schema.string().max(100).optional(), expected_revision: schema.number().int().positive().optional(),
    prompt: schema.string().max(2000).optional(), engine: schema.enum(['web', 'unity', 'godot', 'unreal']).optional(),
    platforms: schema.array(schema.enum(['web', 'mobile', 'windows', 'mac'])).min(1).max(4).optional(),
    slot_id: schema.string().max(100).optional(), mode: schema.enum(['select', 'generate', 'default']).optional(), asset_id: schema.string().max(100).optional(),
    operation: schema.enum(['plan', 'refine', 'concept', 'generate', 'build', 'develop', 'produce']).optional(), quote_token: schema.string().max(100).optional(),
    geometry_mode: schema.literal('designed').optional(),
    production_source: schema.string().max(100).optional(), resume_token: schema.string().max(200).optional(),
    message: schema.string().trim().min(3).max(1500).optional(), allow_incomplete: schema.boolean().optional(), player_accounts: schema.boolean().optional(),
  };
}

export function creationToolShape(schema: typeof z = z) {
  const shape = creationWriteShape(schema);
  return {
    ...shape,
    action: schema.enum(['list', 'get', 'assets', ...shape.action.options]),
    workspace_id: schema.string().max(100).optional(),
    other_styles: schema.boolean().optional(), source: schema.enum(['all', 'workspace', 'community']).optional(), q: schema.string().max(100).optional(),
  };
}

export const creationWriteRequest = z.object(creationWriteShape()).strict();
export type CreationCommand = z.infer<typeof creationWriteRequest>;
