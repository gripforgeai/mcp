import { z } from 'zod';
export function createPropGripSchema(factory: unknown = z) {
  const Z = factory as typeof z;
  const vector = Z.tuple([Z.number().finite(), Z.number().finite(), Z.number().finite()]);
  return Z.object({
    position: vector.describe('Grip point in the prop scene local coordinates'),
    axis: vector.describe('Handle direction / shield top (+Y of the grip frame)'),
    normal: vector.describe('Blade flat / outward shield face (+Z of the grip frame)'),
  }).describe('Exact prop grip frame; overrides geometric guesses. A gf_grip locator can supply the same frame.');
}
export const propGripSchema = createPropGripSchema();
