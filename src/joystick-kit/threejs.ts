import type { JoystickConfig, JoystickFile } from './index.js';

export function threeJoystickFiles(c: JoystickConfig): JoystickFile[] {
  return [{path:'gripforge/joystick.mjs',content:`// GripForge input.joystick 1.0.0 — no framework or renderer dependency.
export const defaults = ${JSON.stringify(c)};
export function radialAxis(x,y,deadzone=defaults.deadzone) {
  const m=Math.hypot(x,y);
  if(!Number.isFinite(m)||m<=deadzone) return {x:0,y:0};
  const k=Math.min(1,(m-deadzone)/(1-deadzone))/m;
  return {x:x*k,y:y*k};
}
export function createJoystick({parent=document.body,...options}={}) {
  const cfg={...defaults,...options};
  if(!['move','dual'].includes(cfg.layout)||!Number.isFinite(cfg.deadzone)||cfg.deadzone<0||cfg.deadzone>.5||!Number.isFinite(cfg.radius)||cfg.radius<32||cfg.radius>160||!/^#[a-f0-9]{6}$/i.test(cfg.accent)) throw Error('Invalid joystick options');
  const root=document.createElement('div');
  root.dataset.gripforgeJoystick='';
  Object.assign(root.style,{position:'fixed',inset:'0',pointerEvents:'none',zIndex:'30'});
  const state={move:{x:0,y:0},look:{x:0,y:0}};
  const sticks=[];
  function make(name,right) {
    const base=document.createElement('div'),thumb=document.createElement('div');
    base.dataset.stick=name; base.setAttribute('aria-label',name==='move'?'Movement joystick':'Camera joystick');
    base.setAttribute('role','group');
    Object.assign(base.style,{position:'absolute',bottom:'max(24px, env(safe-area-inset-bottom))',width:'min('+cfg.radius*2+'px, calc((100vw - 72px) / 2))',aspectRatio:'1',borderRadius:'50%',background:'rgba(15,20,28,.72)',boxShadow:'inset 0 0 0 2px rgba(255,255,255,.22)',touchAction:'none',userSelect:'none',pointerEvents:'auto'});
    base.style[right?'right':'left']='max(24px, env(safe-area-inset-'+(right?'right':'left')+'))';
    Object.assign(thumb.style,{position:'absolute',left:'36%',top:'36%',width:'28%',height:'28%',borderRadius:'50%',background:cfg.accent,boxShadow:'0 0 16px '+cfg.accent+'55',pointerEvents:'none'});
    base.append(thumb);root.append(base);
    const stick={base,thumb,pointer:null}; sticks.push(stick);
    function reset(){
      const pointer=stick.pointer;stick.pointer=null;state[name]={x:0,y:0};thumb.style.transform='';
      if(pointer!==null&&base.hasPointerCapture(pointer))base.releasePointerCapture(pointer);
    }
    stick.reset=reset;
    function update(e){
      const r=base.getBoundingClientRect(),travel=Math.min(r.width,r.height)*.325;
      if(travel<=0){reset();return;}
      const x=(e.clientX-r.left-r.width/2)/travel,y=-(e.clientY-r.top-r.height/2)/travel;
      state[name]=radialAxis(x,y,cfg.deadzone);
      const m=Math.max(1,Math.hypot(x,y));
      thumb.style.transform='translate('+(x/m*travel)+'px,'+(-y/m*travel)+'px)';
    }
    base.addEventListener('pointerdown',e=>{
      if(stick.pointer!==null||(e.pointerType==='mouse'&&e.button!==0))return;
      e.preventDefault();e.stopPropagation();stick.pointer=e.pointerId;base.setPointerCapture(e.pointerId);update(e);
    });
    base.addEventListener('pointermove',e=>{if(stick.pointer===e.pointerId){e.preventDefault();e.stopPropagation();update(e);}});
    for(const event of ['pointerup','pointercancel','lostpointercapture'])base.addEventListener(event,e=>{if(stick.pointer===e.pointerId){e.stopPropagation();reset();}});
  }
  make('move',false);if(cfg.layout==='dual')make('look',true);
  parent.append(root);
  const reset=()=>sticks.forEach(s=>s.reset());
  const onVisibility=()=>{if(document.hidden)reset();};
  window.addEventListener('blur',reset);window.addEventListener('resize',reset);document.addEventListener('visibilitychange',onVisibility);
  return {root,read:()=>({move:{...state.move},look:{...state.look}}),reset,
    dispose(){reset();window.removeEventListener('blur',reset);window.removeEventListener('resize',reset);document.removeEventListener('visibilitychange',onVisibility);root.remove();}};
}
// Optional GripForge KitHost bridge. Does not overwrite physical gamepad state.
export function bindGripForgeInput(joystick,input,source='touch-joystick') {
  if(typeof input.setVirtualAxis!=='function')throw Error('Update GripForge input.actions for named virtual axes.');
  return {update(){const s=joystick.read();for(const [name,value] of Object.entries({move_x:s.move.x,move_y:s.move.y,look_x:s.look.x,look_y:s.look.y}))input.setVirtualAxis(name,value,source);},
    dispose(){input.clearVirtualInput(source);joystick.reset();}};
}
`},{path:'gripforge/three-joystick-example.mjs',content:`import * as THREE from 'three';
import { createJoystick } from './joystick.mjs';
export const joystick=createJoystick();
const forward=new THREE.Vector3(),right=new THREE.Vector3();
// Feed this direction to your capsule/character motor's normal physics update.
export function readMovement(camera) {
  const {move,look}=joystick.read();
  camera.getWorldDirection(forward);forward.y=0;
  if(forward.lengthSq()<.00001)forward.set(0,0,-1);else forward.normalize();
  right.crossVectors(forward,THREE.Object3D.DEFAULT_UP).normalize();
  return {direction:new THREE.Vector3().addScaledVector(right,move.x).addScaledVector(forward,move.y),look};
}
// Each physics tick: motor.setDesiredDirection(readMovement(camera).direction).
// Camera: yaw -= look.x * radiansPerSecond * dt; pitch += look.y * radiansPerSecond * dt.
// On unmount: joystick.dispose(). No teleporting or replacement of collision/network code.
`},{path:'README.md',content:`# GripForge joystick · Three.js

Copy gripforge/ into your browser project. Import createJoystick() from joystick.mjs;
call read() every simulation frame. The overlay works with touch and mouse, holds
each finger independently and resets on release, cancellation, blur and disposal.
Outputs are move/look vectors in a unit disc, X right and Y forward/up.

The Three.js example converts movement to camera-relative world space. Pass that
vector to your existing physics motor. Its look vector is an angular velocity;
multiply by dt once. Destroy the overlay when unloading the game.

For a GripForge KitHost use bindGripForgeInput(), call its update() before
host.tick(), and dispose both the binding and joystick. Register look_x/look_y
actions when using a camera kit. Virtual axes bypass the extra hardware noise
threshold because the joystick already applies its radial deadzone. Physical
gamepad state remains independent.
`}];
}
