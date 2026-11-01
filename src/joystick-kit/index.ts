import { THREEJS_REMOVED_MESSAGE, isRemovedThreeTarget } from '../removed-targets.js';
import { godotJoystickFiles } from './godot.js';
import { unityJoystickFiles } from './unity.js';
import { unrealJoystickFiles } from './unreal.js';

export type JoystickTarget = 'godot' | 'unity' | 'unreal';
export interface JoystickConfig { layout: 'move' | 'dual'; deadzone: number; radius: number; accent: string }
export interface JoystickFile { path: string; content: string }
export const joystickDefaults: JoystickConfig = { layout: 'dual', deadzone: .15, radius: 72, accent: '#ff681f' };

/** Radial, continuous, unit-disc axes. Y is up/forward on every target. */
export function joystickAxis(x: number, y: number, deadzone = .15): { x: number; y: number } {
  if (![x,y,deadzone].every(Number.isFinite) || deadzone < 0 || deadzone >= 1) return {x:0,y:0};
  const length=Math.hypot(x,y);
  if(length<=deadzone) return {x:0,y:0};
  const scale=Math.min(1,(length-deadzone)/(1-deadzone))/length;
  return {x:x*scale,y:y*scale};
}

export function createJoystickKit(target: JoystickTarget | 'all' | 'bevy' | 'web', options: Partial<JoystickConfig> = {}) {
  const config={...joystickDefaults,...options};
  if (isRemovedThreeTarget(target)) throw Error(THREEJS_REMOVED_MESSAGE);
  // Bevy (the GripForge player) has its touch sticks in the kit input.virtualpad: nothing to write, never a refusal.
  if (target==='bevy'||target==='web') return {
    schema:'gripforge.joystick-kit.v1', module:'input.joystick', version:'1.0.0', credits:0, config, deliveries:[], status:'not_needed', applied:false,
    warnings:[{code:'joystick_in_virtualpad',message:'Bevy (the GripForge player) needs no joystick source files: its touch sticks are the kit input.virtualpad, a default kit of every game.',skipped:['joystick source files'],howToFix:'Configure input.virtualpad on the Game Kit project (gripforge_gamekit_configure, kit input.virtualpad: layout, dead zone, radius) or choose the control scheme with gripforge_game_project action=controls.'}],
    next:'Configure input.virtualpad instead.',
  };
  if (!['godot','unity','unreal','all'].includes(target)) throw Error('Unknown joystick target.');
  if (!['move','dual'].includes(config.layout) || !Number.isFinite(config.deadzone) || config.deadzone<0 || config.deadzone>.5 ||
      !Number.isFinite(config.radius) || config.radius<32 || config.radius>160 || !/^#[\da-f]{6}$/i.test(config.accent)) throw Error('Invalid joystick configuration.');
  const targets: JoystickTarget[]=target==='all'?['godot','unity','unreal']:[target];
  const factories={godot:godotJoystickFiles,unity:unityJoystickFiles,unreal:unrealJoystickFiles};
  return {
    schema:'gripforge.joystick-kit.v1', module:'input.joystick', version:'1.0.0', credits:0, config,
    conventions:{axes:'x right, y up/forward',range:'unit disc; diagonals never exceed magnitude 1',deadzone:'radial, rescaled continuously outside the dead zone',holding:'value persists every frame until release/cancel/focus loss',ownership:'one pointer per stick; movement and look can be held simultaneously',physics:'Feeds the existing pawn/controller; examples are optional.'},
    deliveries:targets.map(engine=>({engine,files:factories[engine](config)})),
    status:'files_generated',
    next:'Write each delivery file at its relative path, then follow that target README. Install only one movement driver. Generation does not modify your project or claim an in-game verification.',
  };
}
