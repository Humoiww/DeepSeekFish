import {setTimeout as delay} from 'node:timers/promises';
import {RpcProcess} from '../codex/process.js';
import {nativeDaemonSpec} from '../codex/platform.js';
import {initialize} from '../codex/probe.js';
import {FishError,codeOf} from '../types.js';
import {bridgeText,liveCodexEvents} from './bridge-records.js';
import {taskIdPattern,type BridgeEvent} from './agy-bridge-types.js';

type NativeOptions={
 appRoot:string;socket:string;cwd:string;timeout:number;model?:string;effort?:string;
};
type CodexTurn={id:string;status:string;items?:unknown[];error?:{message?:string}};
const policy={approvalPolicy:'on-request',approvalsReviewer:'auto_review'};

async function untilAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 let rejectAbort:()=>void=()=>{};
 const abort=new Promise<never>((_,reject)=>{
  rejectAbort=()=>reject(signal.reason);
  signal.addEventListener('abort',rejectAbort,{once:true});
  if(signal.aborted)rejectAbort();
 });
 try{return await Promise.race([promise,abort]);}
 finally{signal.removeEventListener('abort',rejectAbort);}
}

export class NativeBridgeCodex{
 private readonly rpc:RpcProcess;
 private thread?:string;
 private running?:{id:string;signal:AbortSignal};
 private diagnostic='';
 private rpcError='';

 constructor(private options:NativeOptions,private event:(event:BridgeEvent)=>void){
  // Keep the transport alive until an interrupt has been attempted.
  this.rpc=new RpcProcess(nativeDaemonSpec(options.appRoot,options.socket),new AbortController().signal);
  this.rpc.on('stderr',text=>this.note(text));
  this.rpc.on('rpcError',({error})=>{
   this.rpcError=typeof error?.message==='string'?error.message:'';
   this.note(error?.message);
  });
 }

 private note(value:unknown){
  const text=bridgeText(value,800)?.trim();
  if(!text)return;
  this.diagnostic=text;
  this.event({role:'bridge',title:'Codex RPC 诊断',text});
 }

 async open(signal:AbortSignal,existing?:string){
  const {cwd,model,effort}=this.options;
  const setup=AbortSignal.any([signal,AbortSignal.timeout(15_000)]);
  await untilAbort(initialize(this.rpc,cwd,false),setup);
  const account=await untilAbort(this.rpc.call('account/read',{refreshToken:false}),setup);
  if(account?.account?.type!=='chatgpt')throw new FishError('CODEX_CHATGPT_PROJECT_LOGIN_REQUIRED');
  const opts={
   cwd,sandbox:'workspace-write',...policy,
   ...(model?{model}:{}),...(effort?{config:{model_reasoning_effort:effort}}:{}),
   developerInstructions:'按本轮授权规格在主仓库工作。保留已有未提交改动，只修改发布白名单内的文件。不要部署、提交 Git、修改开发后台或重复执行整套构建测试。主人可以在原生 Codex 界面补充要求或打断本轮。',
  };
  let reply:any;
  if(existing){
   try{reply=await untilAbort(this.rpc.call('thread/resume',{...opts,threadId:existing,excludeTurns:true}),setup);}
   catch(error){
    if(codeOf(error)!=='CODEX_RPC_REJECTED'||![`no rollout found for thread id ${existing}`,`thread not found: ${existing}`].includes(this.rpcError))throw error;
    this.event({role:'bridge',title:'Codex 主线程已失效，重新建立'});
   }
  }
  const resumed=!!reply;
  if(!resumed)reply=await untilAbort(this.rpc.call('thread/start',{...opts,ephemeral:false}),setup);
  if(!taskIdPattern.test(reply?.thread?.id??'')||resumed&&reply.thread.id!==existing||reply.thread.cwd!==cwd||
    reply.sandbox?.type!=='workspaceWrite'||reply.approvalPolicy!==policy.approvalPolicy||
    reply.approvalsReviewer!==policy.approvalsReviewer)throw new FishError('DEV_CODEX_SESSION_MISMATCH');
  this.thread=reply.thread.id;
  this.event({role:'bridge',title:resumed?'Codex 主线程已续接':'Codex 原生会话已打开',text:this.thread});
  return this.thread!;
 }

 async steer(source:string,text:string){
  const active=this.running,threadId=this.thread;
  if(!active||!threadId||active.signal.aborted)return;
  try{
   const limit=AbortSignal.any([active.signal,AbortSignal.timeout(5000)]);
   const reply=await untilAbort(this.rpc.call('turn/steer',{threadId,expectedTurnId:active.id,clientUserMessageId:source,input:[{type:'text',text}]}),limit);
   return reply?.turnId===active.id?active.id:undefined;
  }catch{return undefined;}
 }

 async turn(text:string,signal:AbortSignal){
  signal.throwIfAborted();
  const threadId=this.thread;
  if(!threadId)throw new FishError('DEV_CODEX_SESSION_MISMATCH');
  const deadline=this.options.timeout>0
   ? AbortSignal.any([signal,AbortSignal.timeout(this.options.timeout)])
   : signal;
  let turnId:string|undefined;
  let lastAnswer='';
  const early:{method:string;params:any}[]=[];
  let finish!:(turn:CodexTurn)=>void;
  let fail!:(error:Error)=>void;
  const done=new Promise<CodexTurn>((resolve,reject)=>{finish=resolve;fail=reject;});
  void done.catch(()=>{});
  const consume=(method:string,params:any)=>{
   if(method==='turn/completed'){
    const turn=params.turn as CodexTurn;
    this.running=undefined;
    this.event({role:'bridge',title:'Codex 轮次结束',text:bridgeText(turn.status,100)});
    finish(turn);
   }else if(method==='item/started'||method==='item/completed'){
    if(method==='item/completed'&&params.item?.type==='agentMessage'&&typeof params.item.text==='string'){
     lastAnswer=bridgeText(params.item.text,4000)??'';
    }
    for(const item of liveCodexEvents({type:method.replace('/','.'),item:params.item}))this.event(item);
   }else if(method.startsWith('item/autoApprovalReview/')){
    const status=bridgeText(params.review?.status??params.status??params.action?.type,100);
    this.event({role:'bridge',title:method.endsWith('/started')?'Codex 自动审批开始':'Codex 自动审批结果',text:status});
   }
  };
  const notice=(method:string,params:any)=>{
   if(params?.threadId!==threadId)return;
   const id=method==='turn/completed'?params.turn?.id:params.turnId;
   if(!taskIdPattern.test(id??''))return;
   if(!turnId){
    if(early.length===64)early.shift();
    early.push({method,params});
   }else if(id===turnId)consume(method,params);
  };
  this.diagnostic='';
  this.rpc.on('notice',notice);
  this.rpc.on('failure',fail);
  const started=this.rpc.call('turn/start',{threadId,cwd:this.options.cwd,...policy,
   ...(this.options.effort?{effort:this.options.effort}:{}),input:[{type:'text',text}]});
  try{
   const reply=await untilAbort(started,deadline);
   if(!taskIdPattern.test(reply?.turn?.id??''))throw new FishError('DEV_CODEX_TURN_ID_INVALID');
   turnId=reply.turn.id;
   this.running={id:turnId!,signal:deadline};
   for(const entry of early)notice(entry.method,entry.params);
   const result=await untilAbort(done,deadline);
   if(result.status==='interrupted')throw new FishError('DEV_AGY_CANCELLED');
   const output=result.items?.findLast((item:any)=>item?.type==='agentMessage'&&item.phase==='final_answer') as {text?:string}|undefined;
   return {code:result.status==='completed'?0:1,timedOut:false,
    output:bridgeText(output?.text,4000)??lastAnswer,error:bridgeText(result.error?.message,800)??this.diagnostic};
  }catch(error){
   if(!deadline.aborted)throw error;
   // A late turn/start receipt may arrive while the owner is cancelling.
   await Promise.race([delay(3000,undefined,{ref:false}), (async()=>{
    const id=turnId??(await started).turn?.id;
    if(!taskIdPattern.test(id??''))return;
    turnId=id;
    await this.rpc.call('turn/interrupt',{threadId,turnId});
    await done.catch(()=>{});
   })().catch(()=>{})]);
   if(signal.aborted)throw signal.reason;
   throw new FishError('DEV_CODEX_TURN_TIMEOUT');
  }finally{
   this.running=undefined;
   this.rpc.off('notice',notice);
   this.rpc.off('failure',fail);
  }
 }

 close(){
  // RpcProcess owns only the WebSocket-to-stdio adapter in this mode.
  return this.rpc.stop();
 }
}
