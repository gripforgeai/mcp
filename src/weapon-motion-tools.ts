import { z } from 'zod/v4';
import type { VfxProjectRegister } from './vfx-project-tools.js';

export const WEAPON_MOTION_TOOL_NAMES = ['gripforge_weapon_profile','gripforge_weapon_motion','gripforge_weapon_motion_review'] as const;
export function registerWeaponMotionTools(register: VfxProjectRegister, options: { apiUrl: string; getApiKey: () => string | null | undefined }, s: typeof z = z) {
  const v=s.tuple([s.number(),s.number(),s.number()]);
  const common={source_id:s.string().regex(/^lib_[A-Za-z0-9_-]{8,64}$/),workspace_id:s.string().max(100).optional()};
  const profile={...common,family:s.enum(['axe','sword','hammer','staff']).optional().describe('Required on the first call. Never infer axe vs sword from geometry alone.'),hand:s.enum(['left','right']).optional(),hands:s.union([s.literal(1),s.literal(2)]).optional(),weaponNode:s.string().max(150).optional(),primaryAnchor:v.optional(),secondaryAnchor:v.optional().describe('Required for two hands; weapon-node local coordinates.'),handleAxis:v.optional(),edgeAxis:v.optional()};
  const generate={...profile,slots:s.array(s.enum(['idle','walk','run','attack1','attack2','attack3','hit','death','dodge','block','jump_start','jump_loop','jump_land'])).min(1).max(13).optional(),name:s.string().max(150).optional(),idempotency_key:s.string().regex(/^[a-zA-Z0-9_.:-]{8,160}$/).optional()};
  const definitions=[
    {name:WEAPON_MOTION_TOOL_NAMES[0],action:'profile',shape:profile,description:'Measure an owned armed GLB instance and return its editable weapon/motion profile: explicit family, holding hand, dimensions, grip anchors, handle and cutting-edge axes. Use gripforge_attach first. Default axes are +Y handle and +Z edge; inspect/correct them. Does not mutate the Library source or certify the initial seating.'},
    {name:WEAPON_MOTION_TOOL_NAMES[1],action:'generate',shape:generate,description:'Queue a persistent weapon-aware motion draft from an owned armed GLB. Axe/hammer get distinct procedural cleave, backhand and overhead attacks; sword uses the explicit UAL sword pack. Staff attacks fail with compatible_motion_missing; no silent sword fallback. Holds Grip finger poses, supports a second-hand anchor with IK. Poll gripforge_generation_read, cancel/retry with generation tools. Returns a NEW work asset and Character Studio URL; never replaces the game/source or visually validates a result. 0 generation credits.'},
    {name:WEAPON_MOTION_TOOL_NAMES[2],action:'review',shape:common,description:'Independently sample the saved weapon-motion GLB at 60 Hz: grip drift, finger pose, wrist rotation, joint discontinuities, second-hand reach and torso overlaps. Reports technicalPassed separately from visualStatus=not_reviewed. Inspect idle, wind-up, impact, recovery and locomotion in GripForge before using the draft. No promotion or mutation.'},
  ];
  for (const d of definitions) register(d.name,{title:d.name,description:d.description,inputSchema:d.shape,annotations:{readOnlyHint:d.action!=='generate',destructiveHint:false,idempotentHint:d.action!=='generate',openWorldHint:false}},async(args,extra)=>{
    const key=options.getApiKey();if(!key)return{isError:true,content:[{type:'text',text:'GripForge API key required.'}]};
    const parsed=s.object(d.shape).strict().safeParse(args);if(!parsed.success)return{isError:true,content:[{type:'text',text:parsed.error.message}]};
    const{workspace_id,...body}=parsed.data;
    try{const response=await fetch(options.apiUrl.replace(/\/$/,'')+'/api/v1/weapon-motion',{method:'POST',headers:{'content-type':'application/json','x-api-key':key,...(workspace_id?{'x-workspace-id':workspace_id}:{})},body:JSON.stringify({action:d.action,...body}),signal:AbortSignal.any([AbortSignal.timeout(150000),...(extra?.signal?[extra.signal]:[])])});
      const data=await response.json();for(const k of ['studio_url','status_url'])if(typeof data[k]==='string'&&data[k].startsWith('/'))data[k]=new URL(data[k],options.apiUrl).href;
      return{...(!response.ok?{isError:true}:{}),structuredContent:data,content:[{type:'text',text:JSON.stringify(data)}]};
    }catch(error){return{isError:true,content:[{type:'text',text:error instanceof Error?error.message:'Weapon motion request failed.'}]};}
  });
}
