import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {safePath,writePrivateAtomic} from '../paths.js';
import {FishError,codeOf} from '../types.js';
import {agyQuotaTtlMs,isBridgeRecordKind,maxRecordBytes,taskIdPattern,type AgyQuota,type AgyStatus,type BridgeRecord,type BridgeRecordSummary} from './agy-bridge-types.js';
import type {Jobs} from './jobs.js';

export const bridgeViewDir='runtime/data/development-activity/bridge-records';
export const developmentInbox='runtime/data/development-inbox';
const cancelFile=developmentInbox+'/web-cancel.json';
const processingFile=developmentInbox+'/web-cancel.processing.json';
const resetFile=developmentInbox+'/web-reset-conversation.json';
const resetResultFile=developmentInbox+'/web-reset-conversation-result.json';
type ConversationReset={id:string;at:number;error?:string};
const quotaFile=bridgeViewDir+'/agy-quota.json';
const quotaRefreshFile=developmentInbox+'/web-refresh-agy-quota.json';
type SavedQuota=AgyQuota&{refreshId?:string};

export const webCancelReason='主人在 WebUI 手动打断';

type DevelopmentTask={
 id:string;phase:string;goal:string;createdAt?:number;updatedAt?:number;backend?:string;
 agyStage?:string;codexStep?:string;deployedRevision?:string;deployedAt?:number;
 reason?:string;report?:string;codexHandoff?:string;
};
type WorkerView={owner:string;runningTaskId?:string;tasks:DevelopmentTask[];lastDeployment?:unknown};
export type BridgeView=Omit<AgyStatus,'agyBin'|'codexSocket'> & {updatedAt:number};

export function readDevelopmentJson<T>(root:string,name:string):T|undefined{
 let fd:number|undefined;
 try{
  fd=fs.openSync(safePath(root,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  const stat=fs.fstatSync(fd);
  if(!stat.isFile()||stat.nlink!==1||stat.size>maxRecordBytes)return;
  const buffer=Buffer.alloc(stat.size);
  if(fs.readSync(fd,buffer,0,buffer.length,0)!==buffer.length)return;
  return JSON.parse(buffer.toString('utf8')) as T;
 }catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;
 }finally{if(fd!==undefined)fs.closeSync(fd);}
}

function agyQuotaFiles(root:string){
 const saved=readDevelopmentJson<SavedQuota>(root,quotaFile);
 const request=readDevelopmentJson<{id:string;at:number}>(root,quotaRefreshFile);
 return {saved,pending:request&&taskIdPattern.test(request.id)&&request.id!==saved?.refreshId?request:undefined};
}

export function readAgyQuota(root:string){
 const {saved,pending}=agyQuotaFiles(root);
 const quota=saved??{source:'agy' as const,checkedAt:0};
 const {refreshId:_,...data}=quota as SavedQuota;
 return {...data,pending:!!pending,stale:!!data.stale||(data.checkedAt>0&&Date.now()-data.checkedAt>=agyQuotaTtlMs)};
}

export function requestAgyQuotaRefresh(root:string){
 const {pending}=agyQuotaFiles(root);
 if(pending)return {ok:true,requestId:pending.id};
 const id=randomUUID();
 fs.mkdirSync(safePath(root,developmentInbox),{recursive:true,mode:0o700});
 writePrivateAtomic(root,quotaRefreshFile,JSON.stringify({id,at:Date.now()}));
 return {ok:true,requestId:id};
}

export async function syncAgyQuota(root:string,refresh:()=>Promise<AgyQuota>,refreshId?:string){
 const previous=readDevelopmentJson<SavedQuota>(root,quotaFile);
 let quota:AgyQuota;
 try{quota=await refresh();}
 catch(error){
  const code=codeOf(error);
  quota={source:'agy',checkedAt:0,error:code.startsWith('DEV_AGY_')?code:'DEV_AGY_BRIDGE_UNAVAILABLE',stale:true};
 }
 // A restarted or temporarily unavailable bridge may have no in-memory values.
 if(!quota.checkedAt&&previous?.checkedAt){
  quota={...quota,checkedAt:previous.checkedAt,weekly:previous.weekly,fiveHour:previous.fiveHour,stale:true};
 }
 const json=JSON.stringify({...quota,refreshId:refreshId??previous?.refreshId});
 if(json!==JSON.stringify(previous))writePrivateAtomic(root,quotaFile,json);
}

export async function processAgyQuotaRefresh(root:string,refresh:()=>Promise<AgyQuota>){
 const {pending}=agyQuotaFiles(root);
 if(!pending)return false;
 await syncAgyQuota(root,refresh,pending.id);
 return true;
}

export function developmentDashboard(root:string,owner:string|undefined,includeRecords=true){
 const snapshot=readDevelopmentJson<WorkerView>(root,developmentInbox+'/status.json');
 const records=includeRecords?readDevelopmentJson<BridgeRecordSummary[]>(root,bridgeViewDir+'/index.json')??[]:[];
 const rawBridge=readDevelopmentJson<BridgeView>(root,bridgeViewDir+'/status.json');
 const bridge=rawBridge&&Date.now()-rawBridge.updatedAt<10_000?rawBridge:null;
 const tasks=snapshot&&snapshot.owner===owner?snapshot.tasks:[];
 const running=tasks.find(task=>task.id===snapshot?.runningTaskId);
 const active=tasks.filter(task=>task.id===running?.id||['deploy','live'].includes(task.phase))
  .filter(task=>['code','candidate','deploy','live'].includes(task.phase))
  .map(task=>({...task,interruptible:task.phase==='code'||task.phase==='candidate'}));
 if(bridge?.busy&&bridge.activeTaskId&&!active.some(task=>task.id===bridge.activeTaskId)){
  const known=tasks.find(task=>task.id===bridge.activeTaskId);
  if(!known)active.push({id:bridge.activeTaskId,phase:'code',goal:'Neon / Codex',backend:'agy',
   createdAt:bridge.startedAt,agyStage:bridge.stage,interruptible:true});
 }
 return {busy:!!active.length||!!bridge?.busy,bridge,active,tasks,records,
  conversationReset:includeRecords?readDevelopmentJson<ConversationReset>(root,resetResultFile):undefined,
  lastDeployment:snapshot?.owner===owner?snapshot?.lastDeployment:undefined};
}

export function requestConversationReset(root:string){
 const previous=readDevelopmentJson<ConversationReset>(root,resetFile);
 const receipt=readDevelopmentJson<ConversationReset>(root,resetResultFile);
 if(previous&&previous.id!==receipt?.id)return {ok:true,requestId:previous.id};
 const id=randomUUID();
 fs.mkdirSync(safePath(root,developmentInbox),{recursive:true,mode:0o700});
 writePrivateAtomic(root,resetFile,JSON.stringify({id,at:Date.now()}));
 return {ok:true,requestId:id};
}

export async function processConversationReset(root:string,reset:()=>Promise<void>){
 const requested=readDevelopmentJson<ConversationReset>(root,resetFile);
 if(!requested||!taskIdPattern.test(requested.id)||
   readDevelopmentJson<ConversationReset>(root,resetResultFile)?.id===requested.id)return;
 let error:string|undefined;
 try{await reset();}catch(cause){error=codeOf(cause);}
 writePrivateAtomic(root,resetResultFile,JSON.stringify({id:requested.id,at:Date.now(),error}));
}

export function developmentRecord(root:string,kind:unknown,id:unknown){
 if(!isBridgeRecordKind(kind)||typeof id!=='string'||!taskIdPattern.test(id))throw new FishError('INVALID_DEVELOPMENT_RECORD');
 const record=readDevelopmentJson<BridgeRecord>(root,bridgeViewDir+'/'+kind+'-'+id+'.json');
 if(!record||record.record.kind!==kind||record.record.id!==id)throw new FishError('DEVELOPMENT_RECORD_NOT_FOUND');
 return record;
}

function requestedIds(root:string,file:string){
 const body=readDevelopmentJson<{taskIds?:unknown}>(root,file);
 return Array.isArray(body?.taskIds)?body.taskIds.filter((id):id is string=>typeof id==='string'&&taskIdPattern.test(id)).slice(0,20):[];
}

export function requestDevelopmentInterrupt(root:string,owner:string|undefined,taskId?:unknown){
 if(taskId!==undefined&&(typeof taskId!=='string'||!taskIdPattern.test(taskId)))throw new FishError('INVALID_TOOL_ARGS');
 const ids=developmentDashboard(root,owner,false).active.filter(task=>task.interruptible&&(taskId===undefined||task.id===taskId)).map(task=>task.id);
 if(taskId!==undefined&&!ids.length)throw new FishError('DEVELOPMENT_TASK_NOT_INTERRUPTIBLE');
 if(!ids.length)return ids;
 fs.mkdirSync(safePath(root,developmentInbox),{recursive:true,mode:0o700});
 const taskIds=[...new Set([...ids,...requestedIds(root,cancelFile)])].slice(0,20);
 writePrivateAtomic(root,cancelFile,JSON.stringify({taskIds,requestedAt:Date.now()}));
 return ids;
}

export function consumeDevelopmentInterrupt(root:string,handle:(ids:string[])=>void){
 const pending=safePath(root,cancelFile),processing=safePath(root,processingFile);
 if(!fs.existsSync(processing)){
  try{fs.renameSync(pending,processing);}catch(error){
   if((error as NodeJS.ErrnoException).code==='ENOENT')return;
   throw error;
  }
 }
 handle(requestedIds(root,processingFile));
 fs.rmSync(processing,{force:true});
}

export function cancelWebDevelopment(jobs:Jobs,owner:string,id:string,controllers:ReadonlyMap<string,AbortController>){
 const cancelled=jobs.tx(()=>{
  const job=jobs.get(id);
  if(!job||job.owner!==owner||job.phase!=='code'&&job.phase!=='candidate')return false;
  jobs.save({...job,phase:'cancelled',grant:'',reason:webCancelReason});
  jobs.cancelMessages(Date.now());
  return true;
 });
 if(cancelled)controllers.get(id)?.abort(new FishError('DEV_GRANT_REVOKED'));
 return cancelled;
}
