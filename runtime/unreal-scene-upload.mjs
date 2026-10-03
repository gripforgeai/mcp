import { uploadUnrealExport } from '../dist/map-unreal-export-local.js';
try {
  await uploadUnrealExport(process.argv[2], process.argv[3], process.argv[4], process.env.GRIPFORGE_API_KEY ?? '');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
