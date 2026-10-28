import { z } from 'zod';
export function createPropGripSchema(factory: unknown = z) {
  const Z = factory as typeof z;
  const vector = Z.tuple([Z.number().finite(), Z.number().finite(), Z.number().finite()]);
  return Z.object({
    position: vector.describe('Grip point in the prop scene local coordinates'),
    axis: vector.describe('Handle direction / shield top (+Y of the grip frame)'),
    normal: vector.describe('Blade flat / outward shield face (+Z of the grip frame)'),
    edgeAxis: vector.optional().describe('Signed cutting/striking direction in the blade plane, perpendicular to axis and normal. Forward grip: away from wrist. This is NOT the blade flat normal.'),
    handleSpan: Z.number().finite().positive().optional().describe('Usable handle length centred on position, in prop-local units. Required for independent mesh section checks; curved handles use their local tangent.'),
  }).describe('Exact prop grip frame; overrides geometric guesses. Returns orientation/contact diagnostics; missing or ambiguous geometry stays needs_review. A gf_grip locator can supply the same frame.');
}
export const propGripSchema = createPropGripSchema();
