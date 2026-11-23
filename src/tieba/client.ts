import {ProviderError} from '../diagnostics.js';
import {request} from 'node:http';
import {FishError} from '../types.js';
import {publishInput,publishInputFeedback,type PublishInput} from './posting.js';
import type {SessionStatus,LoginInput} from './session.js';
import {moderatorInput,type ModeratorInput} from './moderator.js';
export type TiebaRpc=(action:string,input?:unknown,binary?:Buffer)=>Promise<any>;
/** Trusted internal capability. The socket returns only normalized reads,
 * status or an ephemeral login screenshot; never cookies or a generic CDP API. */
export function tiebaRpc(socketPath='/run/deepseekfish-capture.sock'):TiebaRpc{
 return (action,input={},binary)=>new Promise((resolve,reject)=>{
  const metadata=JSON.stringify(input),body=binary??metadata;
  const req=request({socketPath,path:'/tieba/'+action,method:'POST',headers:{'content-type':binary?'application/octet-stream':'application/json','content-length':Buffer.byteLength(body),'x-fish-queue-wait':'1',...(binary?{'x-fish-image-metadata':Buffer.from(metadata).toString('base64url')}: {})}},res=>{
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(part:Buffer)=>{size+=part.length;if(size>10000000)res.destroy(new Error('limit'));else chunks.push(part);});
   res.on('error',()=>reject(new ProviderError('TIEBA_WORKER_RESPONSE_FAILED',{stage:'read_worker_response',operation:action})));
   res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(value.rpcVersion===1){if(value.error)throw new ProviderError(/^TIEBA_[A-Z_0-9]+$/.test(value.error)?value.error:'TIEBA_WORKER_FAILED',value.feedback??{stage:'capture_worker'});resolve(value.value);return;}if(res.statusCode!==200)throw new FishError(/^TIEBA_[A-Z_0-9]+$/.test(value.error)?value.error:'TIEBA_WORKER_FAILED');resolve(value);}catch(e){reject(e instanceof FishError?e:new FishError('TIEBA_WORKER_RESPONSE_FAILED'));}});
  });req.setTimeout(action==='status'?2000:90000,()=>req.destroy());req.on('error',(e:NodeJS.ErrnoException)=>{
   const before=['ENOENT','ECONNREFUSED','EACCES'].includes(e.code??'');
   reject(new ProviderError('TIEBA_WORKER_UNAVAILABLE',{stage:before?'connect_capture_worker':'wait_worker_response',operation:action,nativeCode:e.code,
    ...(['publish','moderator'].includes(action)?{submissionStatus:before?'not_submitted':'unknown',deliveryStatus:before?'failed':'unconfirmed',requestSent:before?false:null}:{})},e));
  });req.end(body);
 });
}
const defaultRpc=tiebaRpc();
const moderatorChecks=new WeakMap<TiebaRpc,{until:number;allowed:Promise<boolean>}>();
export class TiebaAccountClient {
 constructor(private rpc:TiebaRpc=defaultRpc){}
 moderatorAuthorized(){
  const now=Date.now(),cached=moderatorChecks.get(this.rpc);
  if(cached&&cached.until>now)return cached.allowed;
  const allowed=new Promise<boolean>(resolve=>{
   const timeout=setTimeout(()=>resolve(false),1000);
   this.status().then(value=>resolve(value?.moderatorAuthorized===true),()=>resolve(false))
    .finally(()=>clearTimeout(timeout));
  });
  moderatorChecks.set(this.rpc,{until:now+45000,allowed});
  return allowed;
 }
 async status():Promise<SessionStatus>{try{return await this.rpc('status');}catch{ return {state:'check_failed',browserRunning:false,profileSaved:false,identity:null,lastIdentity:null,verifiedAt:null,lastError:{code:'TIEBA_WORKER_UNAVAILABLE',stage:'status',at:Date.now()},waitingUntil:null,verificationRequired:true};}}
 start(){return this.rpc('start');}check(){return this.rpc('check');}logout(){return this.rpc('logout');}close(){return this.rpc('close');}
 startPublication(requestId?:string){return this.rpc('publication-start',{requestId});}submitPublication(requestId?:string){return this.rpc('publication-submit',{requestId});}checkPublication(){return this.rpc('publication-check');}
 input(value:LoginInput){return this.rpc('input',value);}
 async frame(){const r=await this.rpc('frame');if(typeof r.png!=='string'||r.png.length>8000000)throw new FishError('TIEBA_FRAME_INVALID');return Buffer.from(r.png,'base64');}
 async publicationFrame(requestId:string){const r=await this.rpc('publication-frame',{requestId});if(r.requestId!==requestId||typeof r.png!=='string'||r.png.length>8000000)throw new FishError('TIEBA_FRAME_INVALID');return {bytes:Buffer.from(r.png,'base64'),requestId:r.requestId,at:r.at,live:true};}
 async publicationEvidence(requestId:string,id:string){const r=await this.rpc('publication-evidence',{requestId,id});if(r.requestId!==requestId||typeof r.png!=='string'||r.png.length>10000000)throw new FishError('TIEBA_FRAME_INVALID');return {bytes:Buffer.from(r.png,'base64'),requestId:r.requestId,at:r.at,live:false};}
 read(url:string){return this.rpc('read',{url});}
 account(){return this.rpc('account');}
 stageImage(requestId:string,imageId:string,bytes:Buffer){return this.rpc('stage-image',{requestId,imageId},bytes);}
 publish(input:PublishInput,requestId:string,authorizedRetryOf?:string){const feedback=publishInputFeedback(input);return feedback?Promise.resolve(feedback):this.rpc('publish',{input:publishInput(input),requestId,...(authorizedRetryOf?{authorizedRetryOf}:{})});}
 history(offset=0){return this.rpc('history',{offset});}
 queue(offset=0,activeOnly=false){return this.rpc('queue',{offset,...(activeOnly?{activeOnly}:{})});}
 publicationQueue(){return this.rpc('queue',{publications:true});}
 async replyQueue(offset=0,activeOnly=false,selectedId?:string){
  try{return await this.rpc('queue',{offset,...(activeOnly?{activeOnly}:{}),replies:true,...(selectedId?{selectedId}:{})});}
  catch(error){if(!(error instanceof FishError)||error.code!=='TIEBA_INPUT_INVALID')throw error;return this.queue(offset,activeOnly);}
 }
 replies(page=1){return this.rpc('replies',{page});}
 mentions(page=1){return this.rpc('mentions',{page});}
 moderator(input:ModeratorInput,requestId:string){return this.rpc('moderator',{input:moderatorInput(input),requestId});}
 verify(requestId:string){return this.rpc('verify',{requestId});}
}
export const tiebaAccountRead=(url:string)=>new TiebaAccountClient().read(url);
