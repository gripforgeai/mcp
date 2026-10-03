/** Identical deterministic delivery in the hosted MCP and npm client. */
import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';
import { createJoystickKit } from './joystick-kit/index.js';

export const JOYSTICK_TOOL_NAMES = ['gripforge_joystick_kit'] as const;

export function registerJoystickTools(register: VfxProjectRegister, schema: typeof z = z) {
  const shape = {
    target: schema.enum(['threejs','godot','unity','unreal','all']).describe('Engine delivery. all returns each of the four source kits.'),
    layout: schema.enum(['move','dual']).default('dual').describe('One movement stick, or independent movement + camera sticks.'),
    deadzone: schema.number().min(0).max(.5).default(.15).describe('Radial deadzone, continuously rescaled to a unit disc.'),
    radius: schema.number().min(32).max(160).default(72).describe('Stick radius in CSS/UI logical pixels, before engine DPI scaling.'),
    accent: schema.string().regex(/^#[\da-f]{6}$/i).default('#ff681f').describe('Thumb color, six-digit hexadecimal RGB.'),
  };
  register('gripforge_joystick_kit', {
    title:'Ready-to-use joystick · Unreal / Godot / Unity / Three.js',
    description:'Generate input.joystick source files and installation instructions: touch + mouse, independent dual sticks, radial deadzone, continuous holding and release/focus reset. Unreal runtime Pawn component, Godot CanvasLayer scene, Unity UI component, Three.js DOM controls + GripForge input.actions bridge. Feeds the existing movement controller rather than replacing physics, collision or networking. Returns files with relative path/content; the agent writes them into the target project and compiles/tests there. Does not install automatically, modify project settings or claim runtime validation. 0 credits.',
    inputSchema:shape,
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async args=>{
    const parsed=schema.object(shape).safeParse(args);
    if(!parsed.success)return {isError:true,content:[{type:'text',text:parsed.error.message}]};
    const {target,...config}=parsed.data;
    const result=createJoystickKit(target,config);
    return {content:[{type:'text',text:JSON.stringify(result)}],structuredContent:result};
  });
}
