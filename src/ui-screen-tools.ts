import {z} from 'zod/v4';
import type {VfxProjectRegister} from './vfx-project-tools.js';
export const UI_SCREEN_TOOL_NAMES=['gripforge_ui_screen'] as const;
export function registerUiScreenTools(register:VfxProjectRegister,options:{apiUrl:string;getApiKey:()=>string|undefined|null},schema:typeof z=z){
 const shape={action:schema.enum(['templates','export','validate']),template:schema.enum(['gothic','cinematic','tactical','arcade']).optional(),language:schema.enum(['fr','en']).optional(),screen:schema.object({schema:schema.literal('gripforge.ui-screen/1'),kit:schema.literal('ui.endscreen'),template:schema.enum(['gothic','cinematic','tactical','arcade']),language:schema.enum(['fr','en']),title:schema.string().max(120),message:schema.string().max(400)}).strict().optional()};
 register('gripforge_ui_screen',{title:'Game screen templates',description:'Reusable death/victory screen concepts backed by the existing ui.endscreen Game Kit. List four visual templates, validate or export screen.json + a standalone web/Bevy presenter + runnable preview. No credits, no AI image generation. Connect authoritative game events and acknowledge multiplayer retries; a downed player is not a party defeat. Get health PNGs from gripforge_hud.',inputSchema:shape,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async(args)=>{
  const p=schema.object(shape).strict().safeParse(args);if(!p.success)return{isError:true,content:[{type:'text',text:p.error.message}]};
  const key=options.getApiKey();if(!key)return{isError:true,content:[{type:'text',text:'GripForge API key required'}]};
  try{const r=await fetch(options.apiUrl.replace(/\/$/,'')+'/api/v1/ui-screens',{method:'POST',headers:{'content-type':'application/json','x-api-key':key,'x-gripforge-client':'mcp'},body:JSON.stringify(p.data),signal:AbortSignal.timeout(30000)});const data=await r.json();return{...(!r.ok?{isError:true}:{}),content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}catch(e){return{isError:true,content:[{type:'text',text:e instanceof Error?e.message:'Screen request failed'}]};}
 });
}
