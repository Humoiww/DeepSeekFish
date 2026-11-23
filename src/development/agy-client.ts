import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {FishError} from '../types.js';
import {hash} from './workspace.js';
import {maxRecordBytes,allowedBridgePath,conversationPattern,maxBridgeResponse,maxChangeBytes,maxChanges,maxFileBytes,taskIdPattern,
 type BridgeRecord,type BridgeRecordKind,type BridgeRecordSummary,type AgyCancelResult,type AgyStatus,type AgySteerRequest,type AgySteerResult,type AgyTurnRequest,type AgyTurnResult} from './agy-bridge-types.js';

export function decodeAgyChanges(result:AgyTurnResult,taskId:string){
 if(result?.ok!==true||result.taskId!==taskId||!['reply_only','need_clarification','approved','escalated'].includes(result.outcome)||
   typeof result.replyToFeiyu!=='string'||result.replyToFeiyu.length>16000||
   !Array.isArray(result.changes)||result.changes.length>maxChanges||
   result.outcome!=='approved'&&result.changes.length||
   !Number.isSafeInteger(result.codexRetries)||result.codexRetries<0||
   result.steered!==undefined&&(!Array.isArray(result.steered)||result.steered.some(receipt=>!receipt||typeof receipt.source!=='string'||!/^[a-f0-9]{64}$/.test(receipt.source)||typeof receipt.turnId!=='string'||!taskIdPattern.test(receipt.turnId)))||
   result.outcome==='approved'&&(result.summary?.verdict!=='approve'||!result.summary.buildPassed||!result.summary.testPassed)||
   result.conversationId!==undefined&&(typeof result.conversationId!=='string'||!conversationPattern.test(result.conversationId))){
  throw new FishError('DEV_AGY_INVALID_RESPONSE');
 }
 const seen=new Set<string>();
 let total=0;
 return result.changes.map(change=>{
  if(!change||!allowedBridgePath(change.name)||seen.has(change.name))throw new FishError('DEV_AGY_INVALID_CHANGE');
  seen.add(change.name);
  if(change.contentBase64===null&&change.sha256===null)return {name:change.name,bytes:null};
  if(typeof change.contentBase64!=='string'||change.contentBase64.length>4*Math.ceil(maxFileBytes/3)||
    typeof change.sha256!=='string'||!/^[a-f0-9]{64}$/.test(change.sha256)){
   throw new FishError('DEV_AGY_INVALID_CHANGE');
  }
  const bytes=Buffer.from(change.contentBase64,'base64');
  total+=bytes.length;
  if(bytes.length>maxFileBytes||total>maxChangeBytes||bytes.toString('base64')!==change.contentBase64||hash(bytes)!==change.sha256){
   throw new FishError('DEV_AGY_INVALID_CHANGE');
  }
  return {name:change.name,bytes};
 });
}

export class AgyClient {
 constructor(private socketPath:string){}

 private request<T>(method:'POST'|'GET',path:string,body?:unknown,signal?:AbortSignal){
  return new Promise<T>((resolve,reject)=>{
   if(signal?.aborted){reject(signal.reason);return;}
   const payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
   const req=request({socketPath:this.socketPath,path,method,signal,
    headers:payload?{'Content-Type':'application/json','Content-Length':payload.length}:undefined},res=>{
    const chunks:Buffer[]=[];
    let size=0;
    res.on('data',(part:Buffer)=>{
     size+=part.length;
     if(size>(path==='/v1/turn'?maxBridgeResponse:path.startsWith('/v1/record?')?maxRecordBytes:64000))res.destroy(new FishError('DEV_AGY_RESPONSE_TOO_LARGE'));
     else chunks.push(part);
    });
    res.on('error',reject);
    res.on('end',()=>{
     try{
      const result=JSON.parse(Buffer.concat(chunks).toString());
      if(res.statusCode!==200||result?.ok!==true){
       throw new FishError(typeof result?.error==='string'&&/^DEV_(?:AGY|CODEX)_[A-Z0-9_]+$/.test(result.error)?
        result.error:'DEV_AGY_BRIDGE_FAILED');
      }
      resolve(result);
     }catch(error){reject(error);}
    });
   });
   if(path==='/v1/turn')req.setTimeout(0);
   req.once('error',error=>reject(signal?.aborted?signal.reason:new FishError('DEV_AGY_BRIDGE_UNAVAILABLE')));
   req.end(payload);
  });
 }

 status(signal=AbortSignal.timeout(3000)){
  return this.request<AgyStatus>('GET','/v1/status',undefined,signal);
 }

 records(signal=AbortSignal.timeout(5000)){
  return this.request<{ok:true;records:BridgeRecordSummary[]}>('GET','/v1/records',undefined,signal);
 }

 record(kind:BridgeRecordKind,id:string,signal=AbortSignal.timeout(5000)){
  return this.request<BridgeRecord>('GET','/v1/record?'+new URLSearchParams({kind,id}),undefined,signal);
 }

 resetConversation(){
  return this.request<{ok:true}>('POST','/v1/reset-conversation',{},AbortSignal.timeout(3000));
 }

 cancel(taskId?:string){
  return this.request<AgyCancelResult>('POST','/v1/cancel',{taskId},AbortSignal.timeout(3000));
 }

 async steer(input:AgySteerRequest,signal:AbortSignal){
  const result=await this.request<AgySteerResult>('POST','/v1/steer',input,AbortSignal.any([signal,AbortSignal.timeout(6500)]));
  if(typeof result.accepted!=='boolean'||result.accepted&&(typeof result.turnId!=='string'||!taskIdPattern.test(result.turnId)))throw new FishError('DEV_AGY_INVALID_RESPONSE');
  return result;
 }

 private async cancelAndWait(taskId:string){
  const deadline=Date.now()+5500;
  try{
   // Keep the worker lease until TERM/KILL and workspace cleanup have finished.
   await this.cancel(taskId);
   while(Date.now()<deadline){
    const status=await this.status(AbortSignal.timeout(Math.min(1000,Math.max(1,deadline-Date.now()))));
    if(status.activeTaskId!==taskId||!status.busy)return;
    await delay(120);
   }
  }catch{/* An unavailable bridge cannot hold the worker indefinitely. */}
 }

 async turn(input:AgyTurnRequest,signal:AbortSignal,progress?:(status:AgyStatus)=>void){
  if(!taskIdPattern.test(input.taskId))throw new FishError('DEV_AGY_INVALID_REQUEST');
  signal.throwIfAborted();
  let polling=false,stopped=false;
  const poll=async()=>{
   if(polling||stopped)return;
   polling=true;
   try{
    const status=await this.status(AbortSignal.any([signal,AbortSignal.timeout(3000)]));
    if(!stopped&&status.activeTaskId===input.taskId)progress?.(status);
   }catch{}finally{polling=false;}
  };
  let cancellation:Promise<void>|undefined;
  const abort=()=>{cancellation=this.cancelAndWait(input.taskId);};
  signal.addEventListener('abort',abort,{once:true});
  const schedule=setInterval(()=>{void poll();},1500);
  schedule.unref();
  try{
   return await this.request<AgyTurnResult>('POST','/v1/turn',input,signal);
  }finally{
   stopped=true;
   clearInterval(schedule);
   signal.removeEventListener('abort',abort);
   await cancellation;
  }
 }
}
