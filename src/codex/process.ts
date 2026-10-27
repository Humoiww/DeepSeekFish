import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { FishError } from '../types.js';

export interface ProcessSpec { command:string; args:string[]; cwd:string; env:NodeJS.ProcessEnv }
export class RpcProcess extends EventEmitter {
  child:ChildProcessWithoutNullStreams;
  private counter=0; private buffer=''; private bytes=0; private closed=false;
  private decoder=new StringDecoder('utf8');
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void}>();
  constructor(spec:ProcessSpec,private signal:AbortSignal) {
    super();signal.throwIfAborted();
    this.child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32'});
    this.child.stdout.on('data',(chunk:Buffer)=>this.consume(chunk));
    this.child.stderr.on('data',()=>{}); // Never persist raw stderr/protocol/credentials.
    this.child.stdin.on('error',()=>this.fail(new FishError('CODEX_PIPE_CLOSED')));
    this.child.on('error',()=>this.fail(new FishError('CODEX_SPAWN_FAILED')));
    this.child.on('close',()=>{this.closed=true;this.fail(new FishError('CODEX_PROCESS_EXIT'));});
    signal.addEventListener('abort',this.abort,{once:true});
  }
  private abort=():void=>{this.fail(new FishError('CODEX_ABORTED'));void this.stop();};
  private fail(error:Error):void {
    for(const p of this.pending.values())p.reject(error);this.pending.clear();this.emit('failure',error);
  }
  private consume(chunk:Buffer):void {
    this.bytes+=chunk.length;
    if(this.bytes>16777216){this.fail(new FishError('CODEX_PROTOCOL_LIMIT'));void this.stop();return;}
    this.buffer+=this.decoder.write(chunk);
    while(this.buffer.includes('\n')){
      const end=this.buffer.indexOf('\n'),line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
      if(!line.trim())continue;
      let msg:any;try{msg=JSON.parse(line);}catch{this.fail(new FishError('CODEX_PROTOCOL_INVALID'));void this.stop();return;}
      if(msg.id!==undefined&&msg.method){
        // No server request can acquire more authority. Known approvals are
        // denied; all other interactive/tool requests are explicitly unsupported.
        const result=/requestApproval$/.test(msg.method)?{decision:'decline'}:undefined;
        this.write(result?{id:msg.id,result}:{id:msg.id,error:{code:-32601,message:'Client capability disabled'}});
      }else if(msg.id!==undefined){
        const p=this.pending.get(msg.id);if(p){this.pending.delete(msg.id);msg.error?p.reject(new FishError('CODEX_RPC_REJECTED')):p.resolve(msg.result);}
      }else if(msg.method)this.emit('notice',msg.method,msg.params);
    }
  }
  private write(value:unknown):void {if(!this.closed)this.child.stdin.write(JSON.stringify(value)+'\n');}
  notify(method:string,params:unknown={}):void {this.write({method,params});}
  call(method:string,params:unknown={}):Promise<any>{
    if(this.closed||this.signal.aborted)return Promise.reject(new FishError('CODEX_PROCESS_CLOSED'));
    const id=++this.counter;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.write({id,method,params});});
  }
  async stop():Promise<void>{
    this.signal.removeEventListener('abort',this.abort);
    if(this.closed)return;
    const ended=once(this.child,'close').catch(()=>{});
    if(this.child.pid){
      if(process.platform==='win32'){
        // The PowerShell launcher holds a kill-on-close Job Object. Killing
        // that owner closes the job and terminates every descendant.
        this.child.kill();
      }else{try{process.kill(-this.child.pid,'SIGKILL');}catch{this.child.kill('SIGKILL');}}
    }
    await Promise.race([ended,new Promise<void>(resolve=>{const t=setTimeout(resolve,3000);t.unref();})]);
    if(!this.closed)throw new FishError('CODEX_PROCESS_NOT_TERMINATED');
  }
}
