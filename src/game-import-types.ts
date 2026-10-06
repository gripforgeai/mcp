/** Portable report: no absolute paths, credentials, extracted code or claimed visual approval. */
export type ImportKind = 'character' | 'weapon' | 'building' | 'vehicle' | 'prop' | 'environment' | 'animation' | 'texture' | 'material' | 'audio' | 'vfx' | 'ui' | 'scene' | 'script' | 'container' | 'unknown';
export type Evidence = { source: string; reason: string; confidence: number };
export type ImportAsset = {
  id: string; path: string; name: string; format: string; bytes: number; sha256: string;
  kind: ImportKind; subtype?: string; evidence: Evidence[];
  status: 'ready' | 'convertible' | 'blocked'; reason?: string;
  details: { meshes?: number; materials?: string[]; clips?: string[]; joints?: string[]; rig?: string; guid?: string; dependencies?: string[]; resources?: Record<string,string>; normalization?: { format: 'glb' | 'png'; sha256: string; sourceSha256: string; tool: 'blender'; version: string } };
  suggestedKits: string[];
};
export type ImportEdge = { from: string; to: string; type: 'references' | 'uses-texture' | 'contains-animation'; evidence: Evidence };
export type ImportReport = {
  schema: 'gripforge.game-import.v1'; id: string; source: string; createdAt: string;
  engine: { name: 'unity' | 'unreal' | 'godot' | 'web' | 'unknown'; version?: string; runtime: string; evidence: Evidence[] };
  assets: ImportAsset[]; relationships: ImportEdge[];
  toolchain: { tool: string; purpose: string; status: 'builtin' | 'external' | 'manual'; reason: string }[];
  counts: Partial<Record<ImportKind, number>>; warnings: string[];
  normalization: { supported: string[]; requiresReview: string[] };
};
export type ImportJob = {
  schema: 'gripforge.game-import-job.v1'; id: string; root: string; phase: 'analyze' | 'extract' | 'normalize' | 'import';
  status: 'queued' | 'running' | 'awaiting_selection' | 'completed' | 'cancelled' | 'failed';
  createdAt: string; updatedAt: string; completed: number; total: number; report?: ImportReport;
  selected?: string[]; workspace?: string; origin?: string; rights?: { basis: 'owned' | 'authorized' | 'compatible-license'; note: string };
  receipts: Record<string, { itemId: string; studioUrl?: string; revision?: string }>;
  errors: Record<string, string>; workerPid?: number;
  extraction?: { tool: 'assetripper' | 'cpp2il' | 'ilspy'; sourceRoot: string; output: string; completed?: boolean; endpoint?: string; version?: string };
};
