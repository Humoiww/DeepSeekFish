import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { FishError,codeOf } from '../types.js';
import { rateLimitFailure } from './rate-limit.js';

export interface ProcessSpec { command:string; args:string[]; cwd:string; env:NodeJS.ProcessEnv }
export interface ServerRequest {id:string|number;method:string;params:unknown;signal:AbortSignal}
type ServerRequestHandler=(request:ServerRequest)=>unknown|Promise<unknown>;
const maxRpcLineBytes=32*1024*1024;

export class RpcProcess extends EventEmitter {
  child:ChildProcessWithoutNullStreams;
  private counter=0; private closed=false;
  private lineChunks:Buffer[]=[];
  private lineBytes=0;
  private protocolFailed=false;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(e:Error)=>void}>();
  private serverRequests=new Map<ServerRequest['id'],AbortController>();
  constructor(spec:ProcessSpec,private signal:AbortSignal,private handleServerRequest?:ServerRequestHandler) {
    super();signal.throwIfAborted();
    this.child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true,detached:process.platform!=='win32'});
    this.child.stdout.on('data',(chunk:Buffer)=>this.consume(chunk));
    // Only the diagnostic consumer may persist bounded, redacted error text.
    this.child.stderr.on('data',(chunk:Buffer)=>this.emit('stderr',String(chunk)));
    this.child.stdin.on('error',()=>this.fail(new FishError('CODEX_PIPE_CLOSED')));
    this.child.on('error',()=>this.fail(new FishError('CODEX_SPAWN_FAILED')));
    this.child.on('close',()=>{this.closed=true;this.fail(new FishError('CODEX_PROCESS_EXIT'));});
    signal.addEventListener('abort',this.abort,{once:true});
  }
  private abort=():void=>{this.fail(new FishError('CODEX_ABORTED'));void this.stop().catch(()=>{});};
  private fail(error:Error):void {
    for(const p of this.pending.values())p.reject(error);this.pending.clear();
    for(const request of this.serverRequests.values())request.abort(error);this.serverRequests.clear();
    this.emit('failure',error);
  }
  private failProtocol(code:'CODEX_PROTOCOL_LIMIT'|'CODEX_PROTOCOL_INVALID'):void {
    this.protocolFailed=true;
    this.lineChunks=[];
    this.lineBytes=0;
    this.fail(new FishError(code));
    void this.stop().catch(()=>{});
  }
  private consume(chunk:Buffer):void {
    if(this.protocolFailed)return;
    // Frame raw bytes before decoding so a partial UTF-8 character counts
    // towards the current line and is decoded together with the rest of it.
    for(let offset=0;offset<chunk.length;){
      const newline=chunk.indexOf(0x0a,offset);
      const part=chunk.subarray(offset,newline===-1?chunk.length:newline);
      const size=this.lineBytes+part.length;
      if(size>maxRpcLineBytes){
        this.failProtocol('CODEX_PROTOCOL_LIMIT');
        return;
      }
      if(newline===-1){
        this.lineChunks.push(part);
        this.lineBytes=size;
        return;
      }
      const line=(this.lineChunks.length?Buffer.concat([...this.lineChunks,part],size):part).toString('utf8');
      this.lineChunks=[];
      this.lineBytes=0;
      offset=newline+1;
      if(!line.trim())continue;
      let msg:any;try{msg=JSON.parse(line);}catch{this.failProtocol('CODEX_PROTOCOL_INVALID');return;}
      if(msg.id!==undefined&&typeof msg.method==='string'){
        void this.respond(msg.id,msg.method,msg.params);
      }else if(msg.id!==undefined){
        if(msg.error)this.emit('rpcError',{id:msg.id,error:msg.error});
        const p=this.pending.get(msg.id);if(p){this.pending.delete(msg.id);msg.error?p.reject(rateLimitFailure(msg.error)??new FishError('CODEX_RPC_REJECTED')):p.resolve(msg.result);}
      }else if(msg.method){
        if(msg.method==='serverRequest/resolved')this.serverRequests.get(msg.params?.requestId)?.abort(new FishError('CODEX_REQUEST_RESOLVED'));
        this.emit('notice',msg.method,msg.params);
      }
    }
  }
  private async respond(id:ServerRequest['id'],method:string,params:unknown){
    if(!['number','string'].includes(typeof id)||this.serverRequests.has(id))return;
    const controller=new AbortController(),signal=AbortSignal.any([this.signal,controller.signal]);
    this.serverRequests.set(id,controller);
    try{
      // Approval RPCs may change the sandbox, exec policy, or network scope.
      // Development may answer questions, but no handler can grant privileges.
      const noGrant=method==='item/permissions/requestApproval'?{permissions:{},scope:'turn'}:
        method.endsWith('/requestApproval')?{decision:'decline'}:
        ['applyPatchApproval','execCommandApproval'].includes(method)?{decision:{denied:{rejection:'The task permission profile is already set.'}}}:undefined;
      const result=noGrant??await this.handleServerRequest?.({id,method,params,signal});
      if(signal.aborted)return;
      this.emit('serverRequest',{id,method,decision:noGrant?'decline':result!==undefined?'answered':'unsupported'});
      this.write(result!==undefined?{id,result}:{id,error:{code:-32601,message:'Client capability disabled'}});
    }catch(error){
      if(signal.aborted)return;
      this.emit('serverRequest',{id,method,decision:'failed',error:codeOf(error)});
      this.write({id,error:{code:-32000,message:codeOf(error)}});
    }finally{this.serverRequests.delete(id);}
  }
  private write(value:unknown):void {if(!this.closed)this.child.stdin.write(JSON.stringify(value)+'\n');}
  notify(method:string,params:unknown={}):void {this.write({method,params});}
  call(method:string,params:unknown={}):Promise<any>{
    if(this.closed||this.signal.aborted)return Promise.reject(new FishError('CODEX_PROCESS_CLOSED'));
    const id=++this.counter;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.write({id,method,params});});
  }
  async stop(waitForClose=false):Promise<void>{
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
    if(waitForClose)await ended;
    else await Promise.race([ended,new Promise<void>(resolve=>{const t=setTimeout(resolve,3000);t.unref();})]);
    if(!this.closed)throw new FishError('CODEX_PROCESS_NOT_TERMINATED');
  }
}
