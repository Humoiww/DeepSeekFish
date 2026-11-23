import type {ChildProcess} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';

/** Private pipe only. No listening debugging port, protocol proxy or raw events
 * are exposed to WebUI/model callers. Shared by the two isolated browsers. */
export class Pipe {
 onEvent?:(event:any)=>void;
 private seq=0;private buffer='';private failure?:Error;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout;method:string}>();
 constructor(private child:ChildProcess,private allowed?:(url:string,request?:any)=>boolean){
  const decoder=new StringDecoder('utf8');
  (child.stdio[4] as NodeJS.ReadableStream).on('data',(bytes:Buffer)=>{
   if(this.failure)return;
   this.buffer+=decoder.write(bytes);if(this.buffer.length>24000000){child.kill('SIGKILL');return;}
   for(let i;(i=this.buffer.indexOf('\0'))>=0;){
    const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);let p:any;try{p=JSON.parse(line);}catch{continue;}
    if(p.id){const job=this.pending.get(p.id);if(job){clearTimeout(job.timer);this.pending.delete(p.id);p.error?job.reject(Object.assign(Error('CAPTURE_PROTOCOL_FAILED'),{protocol:{method:job.method,code:p.error.code}})):job.resolve(p.result);}}
    else {this.onEvent?.(p);if(this.allowed&&p.method==='Fetch.requestPaused'){let allow=false;try{allow=this.allowed(p.params.request.url,p.params);}catch{}void this.call(allow?'Fetch.continueRequest':'Fetch.failRequest',allow?{requestId:p.params.requestId}:{requestId:p.params.requestId,errorReason:'BlockedByClient'},p.sessionId).catch(()=>{});}}
   }
  });
  const failed=()=>this.abort(Error('CAPTURE_BROWSER_EXIT'));
  child.on('exit',failed);child.on('error',failed);(child.stdio[3] as NodeJS.WritableStream).on('error',failed);
 }
 abort(error:Error=Error('CAPTURE_BROWSER_EXIT')){this.failure??=error;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(this.failure);}this.pending.clear();}
 call(method:string,params:Record<string,unknown>={},sessionId?:string,timeout=20000):Promise<any>{
  if(this.failure)return Promise.reject(this.failure);
  const id=++this.seq;return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CAPTURE_PROTOCOL_TIMEOUT'));},timeout);timer.unref();
   this.pending.set(id,{resolve,reject,timer,method});
   (this.child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(Error('CAPTURE_PIPE_CLOSED'));}});
  });
 }
}
