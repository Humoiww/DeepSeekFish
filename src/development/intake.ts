import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {diagnosticSafe,ProviderError} from '../diagnostics.js';
import {writePrivateAtomic} from '../paths.js';
import {FishError,type Message,type ModelTool} from '../types.js';
import type {Config} from '../config.js';
import {groupTrigger} from '../social/group-trigger.js';

const inboxPath='runtime/data/development-inbox';
const taskId=/^[a-f0-9-]{36}$/i;
export type DevelopmentIntent={action:'send';goal:string;criteria:string[];brief:string}
 |{action:'cancel';taskId?:string};

type GroupPolicy=Pick<Config,'groups'|'names'>;

export function developmentSource(message:Message,owner:string,policy?:GroupPolicy){
 const direct=message.oneBotDirect,text=direct?.text.trim();
 if(!direct||!text||message.user!==owner||Math.abs(Date.now()-message.at)>240000)return;
 const isPrivate=message.group==='private:'+owner;
 if(!isPrivate&&(!policy?.groups.includes(message.group)||!groupTrigger({mentioned:message.mentioned,text},policy.names)))return;
 if(text.startsWith('/fish '))return;
 const taskRef=/(?:开发任务|任务)[ \t]*([a-f0-9-]{36})(?![a-f0-9-])/i.exec(text)?.[1]?.toLowerCase();
 const source=createHash('sha256').update(JSON.stringify(isPrivate?[direct.self,message.user,message.id]:[direct.self,message.user,message.group,message.id])).digest('hex');
 return {source,text:direct.text,taskRef};
}

export function developmentMessages(root:string,batch:Message[],policy?:GroupPolicy){
 if(!batch.some(message=>message.oneBotDirect))return [];
 const owner=boundDevelopmentOwner(root);
 if(!owner)return [];
 return batch.flatMap(message=>{
  const value=developmentSource(message,owner,policy);
  return value&&message.oneBotDirect?[{...value,self:message.oneBotDirect.self}]:[];
 });
}

export function boundDevelopmentOwner(root:string){
 try{return fs.readFileSync(path.join(root,'config/development-owner'),'utf8').trim()||undefined;}
 catch{return undefined;}
}

export const developmentTool:ModelTool={type:'function',function:{
 name:'request_development',description:'找 Neon小猫提开发需求、改代码、修 Bug、加功能、查源码、确认方案或追问和提醒，只用此工具。多条改动点也合在同一次调用里，不能建活动任务链。同一主人的后续追问或提醒再次调用，后台会接上 Neon 的主会话。reply 是你本轮给主人的回复。',
 parameters:{type:'object',properties:{
  messageNumber:{type:'integer',minimum:1,description:'developmentMessages 中本轮主人原话的编号。'},
  action:{type:'string',enum:['send','cancel'],description:'默认发消息。主人要停止当前工作时用 cancel。'},
  brief:{type:'string',description:'你想对 Neon小猫说的话，用你平时的语气。'},
  reply:{type:'string',description:'你给主人的简短自然回复。'}
 },required:['messageNumber','reply'],additionalProperties:false}
}};

export const chainDiscussionTool:ModelTool={type:'function',function:{
 name:'ask_development',
 description:'在当前任务步骤向 Neon小猫提问。当前步已有答复时默认返回已有结果。要追问新问题时填 followUpTo。send_message 是给主人的 QQ 私聊。',
 parameters:{type:'object',properties:{brief:{type:'string',maxLength:4000,
  description:'要发给 Neon小猫的问题和回答所需的信息。'},followUpTo:{type:'string',
  description:'确实需要追问新问题时，填当前步骤收到的 discussionForStep.id。'}},required:['brief'],additionalProperties:false},
}};

export const developmentStatusTool:ModelTool={type:'function',function:{
 name:'development_status',description:'查看任务进度和后台实际的上线回执。带 taskId 也能读 Neon小猫给你的使用说明。是否上线以部署回执为准。',
 parameters:{type:'object',properties:{taskId:{type:'string',description:'要查看完整交付说明的开发任务 ID。省略则列出最近任务。'}},additionalProperties:false}
}};

export function developmentIntent(value:unknown):DevelopmentIntent{
 const args=value as Record<string,unknown>|null;
 if(!args||args.action!==undefined&&
  (typeof args.action!=='string'||!['send','cancel','start','ask','continue','follow_up','amend'].includes(args.action))){
  throw new FishError('DEV_ACTION_INVALID');
 }
 const id=typeof args.taskId==='string'&&taskId.test(args.taskId)?args.taskId.toLowerCase():undefined;
 if(args.action==='cancel')return {action:'cancel',taskId:id};
 if(typeof args.brief!=='string'||!args.brief.trim())throw new FishError('DEV_BRIEF_REQUIRED');
 const brief=args.brief.trim(),goal=typeof args.goal==='string'&&args.goal.trim()?args.goal.trim():brief;
 const criteria=Array.isArray(args.criteria)?args.criteria.filter((item):item is string=>typeof item==='string'&&!!item.trim()).map(item=>item.trim()):[];
 return {action:'send',goal,criteria,brief};
}

export function developmentStatus(root:string,owner:string,id?:unknown){
 if(id!==undefined&&(typeof id!=='string'||!taskId.test(id)))throw new FishError('DEV_TASK_REQUIRED');
 const file=path.join(root,inboxPath,'status.json');
 if(!fs.existsSync(file))return {available:false};
 const status=JSON.parse(fs.readFileSync(file,'utf8'));
 if(status.owner!==owner)return {available:false};
 const tasks=status.tasks as {id:string;phase:string;codexHandoff?:string}[];
 const activeTask=tasks.find(task=>['code','candidate','deploy','live'].includes(task.phase))?.id;
 const busy=Boolean(status.busy??activeTask);
 if(typeof id==='string'){
  const task=tasks.find(task=>task.id===id.toLowerCase());
  if(!task)throw new FishError('DEV_TASK_NOT_FOUND');
  return {available:true,busy,activeTask,task:diagnosticSafe(task)};
 }
 return {available:true,busy,activeTask,lastDeployment:status.lastDeployment,tasks:tasks.map(({codexHandoff:_,...task})=>task)};
}

/** Save the plan before replying. Unreleased plans can be recovered after a restart. */
export async function developmentHandoff(root:string,source:string,intent:DevelopmentIntent,reply:()=>Promise<void>,signal:AbortSignal){
 if(!/^[0-9a-f]{64}$/.test(source))throw new FishError('DEV_SOURCE_INVALID');
 const inbox=path.join(root,inboxPath),receipt=path.join(inbox,source);
 for(let attempt=0;!fs.existsSync(receipt)&&attempt<10;attempt++)await delay(100,undefined,{signal});
 signal.throwIfAborted();
 if(!fs.existsSync(receipt))throw new ProviderError('DEV_SOURCE_NOT_RECORDED',{
  stage:'record_development_source',reason:'开发后台还未收到本轮原消息，尚未创建任务。请向主人说明卡在移交回执。',requestSent:false
 });
 const pending=receipt+'.pending',ready=receipt+'.request';
 if(fs.existsSync(pending)||fs.existsSync(ready))return {handedOff:true,reused:true};
 writePrivateAtomic(root,inboxPath+'/'+source+'.pending',JSON.stringify(intent));
 try{await reply();}
 finally{
  try{fs.renameSync(pending,ready);}catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
 }
 return {handedOff:true};
}
