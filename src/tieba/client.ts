import {request} from 'node:http';
import {FishError} from '../types.js';
import type {PublishInput} from './posting.js';
import type {SessionStatus,LoginInput} from './session.js';
export type TiebaRpc=(action:string,input?:unknown)=>Promise<any>;
/** Trusted internal capability. The socket returns only normalized reads,
 * status or an ephemeral login screenshot; never cookies or a generic CDP API. */
export function tiebaRpc(socketPath='/run/deepseekfish-capture.sock'):TiebaRpc{
 return (action,input={})=>new Promise((resolve,reject)=>{
  const body=JSON.stringify(input),req=request({socketPath,path:'/tieba/'+action,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
   const chunks:Buffer[]=[];let size=0;
   res.on('data',(part:Buffer)=>{size+=part.length;if(size>10000000)res.destroy(new Error('limit'));else chunks.push(part);});
   res.on('error',()=>reject(new FishError('TIEBA_WORKER_RESPONSE_FAILED')));
   res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)throw new FishError(/^TIEBA_[A-Z_0-9]+$/.test(value.error)?value.error:'TIEBA_WORKER_FAILED');resolve(value);}catch(e){reject(e instanceof FishError?e:new FishError('TIEBA_WORKER_RESPONSE_FAILED'));}});
  });req.setTimeout(90000,()=>req.destroy());req.on('error',()=>reject(new FishError('TIEBA_WORKER_UNAVAILABLE')));req.end(body);
 });
}
export class TiebaAccountClient {
 constructor(private rpc:TiebaRpc=tiebaRpc()){}
 async status():Promise<SessionStatus>{try{return await this.rpc('status');}catch{ return {state:'check_failed',browserRunning:false,profileSaved:false,identity:null,lastIdentity:null,verifiedAt:null,lastError:{code:'TIEBA_WORKER_UNAVAILABLE',stage:'status',at:Date.now()},waitingUntil:null,verificationRequired:true};}}
 start(){return this.rpc('start');}check(){return this.rpc('check');}logout(){return this.rpc('logout');}close(){return this.rpc('close');}
 input(value:LoginInput){return this.rpc('input',value);}
 async frame(){const r=await this.rpc('frame');if(typeof r.png!=='string'||r.png.length>8000000)throw new FishError('TIEBA_FRAME_INVALID');return Buffer.from(r.png,'base64');}
 read(url:string){return this.rpc('read',{url});}
 account(){return this.rpc('account');}publish(input:PublishInput,requestId:string){return this.rpc('publish',{input,requestId});}history(){return this.rpc('history');}
 replies(page=1){return this.rpc('replies',{page});}
 verify(requestId:string){return this.rpc('verify',{requestId});}
}
export const tiebaAccountRead=(url:string)=>new TiebaAccountClient().read(url);
