import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';
export const ABILITY_TOOL_NAMES=['gripforge_abilities'] as const;
export function registerAbilityTools(register:VfxProjectRegister,options:{apiUrl:string;getApiKey:()=>string|null|undefined},schema:typeof z=z){
  const shape={action:schema.enum(['schema','example','validate','export']),target:schema.enum(['threejs','godot','unity','unreal','all']).optional(),pack:schema.record(schema.string(),schema.unknown()).optional().describe('Versioned ability pack. Read schema/example first; author a reusable pack then validate it.'),model_asset:schema.string().regex(/^lib_[A-Za-z0-9_-]{8,64}$/).optional().describe('Library model id bound to the example. Does not rig or animate it.')};
  register('gripforge_abilities',{title:'Abilities / skills · four engines',description:'combat.abilities: inspect schema, get an editable Chrono Crab example, validate a pack or export executable Three.js, Godot, Unity and Unreal source adapters. Shared costs, cooldowns, conditions, targeting, windup/active/recovery and presentation cues. Native adapters require the game combat backend and asset bindings. Returns relative path/content files; no rig/animation/VFX generation or automatic installation. Persist through gripforge_gamekit_configure config.pack or project data. 0 credits.',inputSchema:shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async args=>{
    const parsed=schema.object(shape).strict().safeParse(args);
    if(!parsed.success)return{isError:true,content:[{type:'text',text:parsed.error.message}]};
    const key=options.getApiKey();if(!key)return{isError:true,content:[{type:'text',text:'GripForge API key required.'}]};
    try{
      const response=await fetch(options.apiUrl.replace(/\/$/,'')+'/api/v1/abilities',{method:'POST',headers:{'content-type':'application/json','x-api-key':key,'x-gripforge-client':'mcp'},body:JSON.stringify(parsed.data),signal:AbortSignal.timeout(30000)});
      const data=await response.json();return{...(!response.ok?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
    }catch(e){return{isError:true,content:[{type:'text',text:e instanceof Error?e.message:'Ability request failed'}]};}
  });
}
