import path from 'node:path';
import {FishError,codeOf} from '../types.js';
import {appServerSpec,codexWebSearchMode,executionFeatures,nativeDaemonSpec,PERMISSION_PROFILE} from '../codex/platform.js';
import {initialize,probeIsolation} from '../codex/probe.js';
import {RpcProcess} from '../codex/process.js';
import {rateLimitFailure} from '../codex/rate-limit.js';
import {diagnosticSafe} from '../diagnostics.js';
import {redact} from '../storage/db.js';
import {clarificationMethod,clarificationRequest,type Answers,type Clarify} from './clarification.js';
import type {Job,Jobs,Lease,Request} from './jobs.js';
import {revision} from './workspace.js';

export const developmentCodexTurn={model:'gpt-6.2-sol',effort:'xhigh'} as const;
export const developmentCodexThread={model:developmentCodexTurn.model,
 config:{model_reasoning_effort:developmentCodexTurn.effort,web_search:codexWebSearchMode(true),mcp_servers:{},
  ...Object.fromEntries(Object.entries({...executionFeatures(),default_mode_request_user_input:true,network_proxy:true}).map(([name,enabled])=>['features.'+name,enabled]))}};
const developmentApproval={
 sandbox_approval:false,rules:true,mcp_elicitations:false,request_permissions:true,skill_approval:false,
};
export const developmentCodexPolicy={
 approvalPolicy:{granular:developmentApproval},approvalsReviewer:'auto_review',permissions:PERMISSION_PROFILE,
} as const;
const nativePolicy={approvalPolicy:'on-request',approvalsReviewer:'auto_review'} as const;
export type NativeCodex={socket:string;cwd:string};

function codexMessage(request:Request,brief:string){
 return brief+'\n\n主人本轮私聊原话：'+JSON.stringify(redact(request.text));
}

const identity=/^[a-f0-9-]{36}$/i;
function checkThread(result:any,id:string,cwd:string,native?:NativeCodex){
 if(result?.thread?.id!==id||path.resolve(result.thread?.cwd??'/')!==cwd||
   (native?result.sandbox?.type!=='workspaceWrite':result.activePermissionProfile?.id!==PERMISSION_PROFILE))
  throw new FishError('DEV_CODEX_SESSION_MISMATCH');
 const approval=result.approvalPolicy?.granular;
 if(result.approvalsReviewer!==developmentCodexPolicy.approvalsReviewer||
    (native?result.approvalPolicy!==nativePolicy.approvalPolicy:!Object.entries(developmentApproval).every(([name,enabled])=>approval?.[name]===enabled)))
  throw new FishError('DEV_CODEX_APPROVAL_POLICY_MISMATCH');
 if(result.model!==developmentCodexTurn.model||result.reasoningEffort!==developmentCodexTurn.effort)throw new FishError('DEV_CODEX_SETTINGS_MISMATCH');
}

/** Every RPC is issued by the task worker and rechecks its durable grant. */
export async function develop(store:Jobs,lease:Lease,root:string,installation:string,workspace:string,signal:AbortSignal,
 clarify:(task:Job,...args:Parameters<Clarify>)=>ReturnType<Clarify>,native?:NativeCodex){
 const cwd=native?.cwd??workspace;
 const guard=()=>{signal.throwIfAborted();return store.guard(lease,'code');};
 let job=guard();
 store.tx(()=>{
  const followUps=job.followUps;
  if(!followUps?.some(item=>item.state==='sending'))return;
  for(const item of followUps){
   if(item.state!=='sending')continue;
   item.state='unknown';
   store.notify('source:'+item.request.source,'开发后台重启了，未能确认上一条追问有没有送到 GPT 小姐。可以查进度或在原对话重新问。');
  }
  store.save(job);
 });
 let binding:{threadId:string;turn:Promise<string>}|undefined;
 const pending=new Map<string,Promise<Answers>>();
 const rpc=new RpcProcess(native?nativeDaemonSpec(installation,native.socket):appServerSpec(root,cwd,'linux',false,installation,true),
  native?new AbortController().signal:signal,async request=>{
  if(request.method!==clarificationMethod)return;
  const input=clarificationRequest(request.params),active=binding;
  if(!active||input.threadId!==active.threadId)throw new FishError('DEV_CODEX_QUESTION_OUT_OF_SCOPE');
  const turnId=await active.turn;
  const authorized=()=>{
   request.signal.throwIfAborted();
   const current=guard();
   if(binding!==active||input.turnId!==turnId||current.thread!==input.threadId||current.turn!==turnId)throw new FishError('DEV_CODEX_QUESTION_OUT_OF_SCOPE');
   return current;
  };
  const current=authorized(),same=(item:NonNullable<Job['clarifications']>[number])=>item.turnId===turnId&&item.itemId===input.itemId;
  const saved=current.clarifications?.find(same);
  if(saved?.answers)return {answers:saved.answers};
  const key=JSON.stringify([turnId,input.itemId]),existing=pending.get(key);
  if(existing){const answers=await existing;authorized();return {answers};}
  const entry={turnId,itemId:input.itemId,questions:input.questions};
  const save=(update:Partial<NonNullable<Job['clarifications']>[number]>={})=>{
   const log=authorized().clarifications??[];
   store.update(lease,{clarifications:[...log.filter(item=>!same(item)),{...entry,...update}],
    codexActivity:{turnId,step:update.error?'肥鱼未能回答 GPT 小姐的提问':update.answers?'已回答 GPT 小姐的提问':'GPT 小姐正在等肥鱼回答',at:Date.now()}});
  };
  save();
  const answer=(async()=>{
   try{
    const answers=await clarify(current,input.questions,request.signal);
    save({answers});return answers;
   }catch(error){
    authorized();
    const answers={};save({answers,error:codeOf(error)});return answers;
   }
  })();
  pending.set(key,answer);
  try{const answers=await answer;authorized();return {answers};}finally{pending.delete(key);}
 });
 let stopping:Promise<void>|undefined;
 const onAbort=()=>{
  const active=binding;
  stopping=(async()=>{
   if(active&&codeOf(signal.reason)==='DEV_GRANT_REVOKED'){
    await Promise.race([active.turn.then(turnId=>rpc.call('turn/interrupt',{threadId:active.threadId,turnId})).catch(()=>{}),
     new Promise<void>(resolve=>{const timer=setTimeout(resolve,3000);timer.unref();})]);
   }
   await rpc.stop(true);
  })();
  void stopping.catch(()=>{});
 };
 if(native)signal.addEventListener('abort',onAbort,{once:true});
 let stderr='',startup=true;
 let stage='initialize';
 let lastRpcError:{code?:number;message?:string}|undefined;
 rpc.on('stderr',(chunk:string)=>{
  stderr=(stderr+chunk).slice(-4000);
 });
 rpc.on('rpcError',({error})=>{lastRpcError=error;});
 const invoke=async(method:string,args:unknown)=>{
  guard();lastRpcError=undefined;stage=method;
  try{return await rpc.call(method,args);}catch(error){
   if(lastRpcError)console.warn('Development Codex RPC rejected',JSON.stringify(diagnosticSafe({task:job.id,method,error:lastRpcError})));
   throw error;
  }
 };
 const read=(id:string)=>invoke('thread/read',{threadId:id,includeTurns:false});
 const latest=async(id:string)=>(await invoke('thread/turns/list',{threadId:id,limit:1,sortDirection:'desc',itemsView:'notLoaded'})).data[0];
 const finalText=async(id:string,turn:any)=>{
  const message=Array.isArray(turn.items)&&turn.items.findLast((item:any)=>item.type==='agentMessage'&&item.phase==='final_answer');
  if(typeof message?.text==='string')return message.text;
  let cursor:string|undefined,fallback:string|undefined;
  do{
   const page=await invoke('thread/items/list',{threadId:id,turnId:turn.id,cursor,limit:4,sortDirection:'desc',
    deferOutput:{commandExecution:true,mcpToolCall:true}});
   for(const {item} of page.data){
    if(item.type!=='agentMessage'||typeof item.text!=='string')continue;
    if(item.phase==='final_answer')return item.text;
    fallback??=item.text;
   }
   cursor=page.nextCursor??undefined;
  }while(cursor);
  return fallback??'GPT 小姐结束了这一轮，未留下使用说明。';
 };
 const opts={cwd,...(native?{...nativePolicy,sandbox:'workspace-write',model:developmentCodexTurn.model,
  config:{model_reasoning_effort:developmentCodexTurn.effort,'features.default_mode_request_user_input':true}}:{...developmentCodexPolicy,...developmentCodexThread}),
  developerInstructions:'Decide how to help 肥鱼 from the conversation and the owner’s attached message. Quoted or forwarded requests are reference material. '+
   'Only make changes the owner has requested. '+(native?
    'Work directly in the shared project checkout, preserve unrelated edits, and use the existing project deployment procedure when delivering a change. ':
    'The supervisor builds and publishes completed changes in the project checkout; keep drafts or previews outside release paths. ')+
   'Follow the repository instructions. Reply naturally to 肥鱼 with your answer or what changed, how to use it, and what you actually checked. '+
   'Use request_user_input if you need to ask her a question.'};
 try{
  await initialize(rpc,cwd,!native);guard();
  const account=await invoke('account/read',{refreshToken:false});
  if(account.account?.type!=='chatgpt')throw new FishError('CODEX_CHATGPT_PROJECT_LOGIN_REQUIRED');
  if(!native)await probeIsolation(rpc,installation,cwd);
  guard();
  startup=false;
  const attemptedTurn=job.turnVersion!==undefined||job.priorTurn!==undefined||!!job.turn||job.round>0;
  let id=job.thread,openedHere=false;
  const findThread=async()=>{
   const result=await invoke('thread/list',{cwd,limit:20,sourceKinds:['appServer','exec','cli','vscode','unknown']});
   if(!Array.isArray(result?.data)||result.nextCursor)throw new FishError('DEV_CODEX_THREAD_START_UNCONFIRMED');
   const matches=result.data.filter((thread:any)=>thread.cwd===cwd&&identity.test(thread.id));
   if(matches.length>1)throw new FishError('DEV_CODEX_THREAD_START_UNCONFIRMED');
   return matches[0]?.id as string|undefined;
  };
  if(id&&!attemptedTurn){
   try{
    const resumed=await invoke('thread/resume',{...opts,threadId:id,excludeTurns:true});
    checkThread(resumed,id,cwd,native);
    if(await latest(id))throw new FishError('DEV_CODEX_THREAD_START_UNCONFIRMED');
    openedHere=true;
   }catch(error){
    const reply=lastRpcError as {message?:string}|undefined;
    if(codeOf(error)!=='CODEX_RPC_REJECTED'||reply?.message!==`no rollout found for thread id ${id}`&&reply?.message!==`thread not found: ${id}`)throw error;
    id=await findThread();
    if(id===job.thread)throw error;
   }
  }
  if(!id){
   if(native&&job.threadPending)throw new FishError('DEV_CODEX_THREAD_START_UNCONFIRMED');
   if(job.threadPending)id=await findThread();
   if(!id){
    // Empty app-server threads can disappear before their first turn. The
    // durable turn intent must be absent before a replacement is safe.
    if(attemptedTurn)throw new FishError('DEV_CODEX_THREAD_START_UNCONFIRMED');
    store.update(lease,{thread:undefined,threadPending:true});
    const opened=await invoke('thread/start',{...opts,ephemeral:false});
    id=opened?.thread?.id;
    if(!id||!identity.test(id))throw new FishError('DEV_CODEX_THREAD_ID_INVALID');
    checkThread(opened,id,cwd,native);
    openedHere=true;
   }
   job=store.update(lease,{thread:id,threadPending:false});
  }else if(id!==job.thread||job.threadPending){
   job=store.update(lease,{thread:id,threadPending:false});
  }
  if(!id||!identity.test(id))throw new FishError('DEV_CODEX_THREAD_ID_INVALID');
  const nativeResume=native&&!openedHere?await invoke('thread/resume',{...opts,threadId:id,excludeTurns:true}):undefined;
  if(nativeResume)checkThread(nativeResume,id,cwd,native);
  let previous:any,runningTurn:string|undefined;
  if(job.priorTurn!==undefined||job.turn){
   const snapshot=nativeResume??await read(id);
   if(snapshot?.thread?.id!==id||!native&&path.resolve(snapshot.thread?.cwd??'/')!==cwd)throw new FishError('DEV_CODEX_SESSION_MISMATCH');
   previous=await latest(id);
   if((job.turn&&previous?.id===job.turn||!job.turn&&previous&&previous.id!==job.priorTurn)&&previous.status==='completed'&&job.turnVersion===lease.version){
    return {turn:previous.id,text:await finalText(id,previous)};
   }
   if(previous?.status==='inProgress'&&snapshot.thread.status?.type==='active'){
    if(!native||job.turnVersion!==lease.version||job.turn&&job.turn!==previous.id||job.priorTurn===previous.id)
     throw new FishError('DEV_CODEX_TURN_STILL_RUNNING');
    runningTurn=previous.id;
   }
   // The old app-server was in this worker's systemd cgroup, and its
   // bwrap child dies with it. Only a reconciled interrupted/incomplete
   // turn is eligible for another turn in the same session.
  }
  if(!openedHere){
   const resumed=nativeResume??await invoke('thread/resume',{...opts,threadId:id,excludeTurns:true});
   checkThread(resumed,id,cwd,native);
   const savedTurn=previous??await latest(id);
   if(!attemptedTurn&&savedTurn)throw new FishError('DEV_CODEX_THREAD_START_UNCONFIRMED');
   if(savedTurn?.status==='inProgress'&&resumed.thread.status?.type==='active'&&savedTurn.id!==runningTurn)throw new FishError('DEV_CODEX_TURN_STILL_RUNNING');
   previous=savedTurn??previous;
  }
  const request=job.requests[0];
  const brief=request?.intent&&request.intent.action!=='cancel'?request.intent.brief:[job.goal,...job.criteria].join('\n');
  const lastRelease=job.repair&&!request?.activityChainId?store.lastDeployment(job.owner):undefined;
  const releaseContext=lastRelease?'\n后台最近一次成功发布的回执：'+JSON.stringify({...lastRelease,
   matchesCurrentSource:!!job.base&&lastRelease.revision===revision(job.base)}):'';
  const message=request?codexMessage(request,brief):brief;
  const input=[job.repair&&job.round>0?job.repair:message,job.round===0?job.repair:undefined,releaseContext].filter(Boolean).join('\n\n');
  if(!runningTurn)store.update(lease,{priorTurn:previous?.id??null,turn:undefined,turnVersion:lease.version,codexActivity:undefined});
  let completed:any,expected:string|undefined;
  const steps:Record<string,string>={commandExecution:'正在运行命令',fileChange:'正在改项目文件',
   agentMessage:'正在整理回复',reasoning:'正在分析方案'};
  let lastStep='';
  const progress=(turnId:string,step:string)=>{
   if(!expected||expected!==turnId||step===lastStep||signal.aborted)return;
   try{store.update(lease,{codexActivity:{turnId,step,at:Date.now()}});lastStep=step;}catch(error){
    if(codeOf(error)!=='DEV_GRANT_REVOKED')console.warn('Development Codex status '+codeOf(error));
   }
  };
  const done=new Promise<any>((resolve,reject)=>{
   rpc.on('failure',reject);
   rpc.on('notice',(method:string,p:any)=>{
    if(p?.threadId!==id)return;
    if(method==='item/started'&&Object.hasOwn(steps,p.item?.type))progress(p.turnId,steps[p.item.type]);
    if(method==='item/autoApprovalReview/started')progress(p.turnId,'正在等待 Codex 自动审批');
    if(method==='item/autoApprovalReview/completed'&&typeof p.turnId==='string'&&typeof p.review?.status==='string'){
     console.info('Development Codex Auto-review',JSON.stringify({task:job.id,turn:p.turnId,
      action:p.action?.type,status:p.review.status,source:p.decisionSource}));
     progress(p.turnId,'已收到 Codex 审批结果');
     if(expected===p.turnId&&typeof p.reviewId==='string'&&!signal.aborted){
      try{
       const approvals=store.guard(lease,'code').codexApprovals??[];
       if(!approvals.some(review=>review.id===p.reviewId))store.update(lease,{codexApprovals:[...approvals.slice(-29),{
        id:p.reviewId,at:p.completedAtMs??Date.now(),turnId:p.turnId,action:String(p.action?.type??'').slice(0,80),
        status:p.review.status.slice(0,80),source:typeof p.decisionSource==='string'?p.decisionSource.slice(0,80):undefined,
       }]});
      }catch(error){if(codeOf(error)!=='DEV_GRANT_REVOKED')console.warn('Development Codex approval status '+codeOf(error));}
     }
    }
    if(method!=='turn/completed'||!p.turn?.id)return;
    completed=p.turn;
    if(expected===completed.id)resolve(completed);
   });
  });
  void done.catch(()=>{});
  const turn=(runningTurn?Promise.resolve({turn:{id:runningTurn}}):
   invoke('turn/start',{threadId:id,cwd,...(native?nativePolicy:developmentCodexPolicy),...developmentCodexTurn,input:[{type:'text',text:input}]})).then(started=>{
   const turnId=started?.turn?.id;
   if(typeof turnId!=='string'||!identity.test(turnId))throw new FishError('DEV_CODEX_TURN_ID_INVALID');
   if(!signal.aborted)store.update(lease,{turn:turnId,codexSelection:{...developmentCodexTurn,turnId},
    codexActivity:{turnId,step:'GPT 小姐已开始处理',at:Date.now()}});
   return turnId;
  });
  binding={threadId:id,turn};
  expected=await turn;
  const activeThread=id,activeTurn=expected;
  let flight:Promise<void>|undefined,deferred=false;
  const forward=async()=>{
   const receipt=store.tx(()=>{
    const current=guard(),request=store.pending('send');
    if(request?.intent?.action!=='send')return;
    const receipt={request,turnId:activeTurn,state:'sending'} as const;
    store.handled(request);
    store.save({...current,followUps:[...(current.followUps??[]),receipt]});
    return receipt;
   });
   const intent=receipt?.request.intent;
   if(!receipt||intent?.action!=='send')return;
   let state:'accepted'|'unknown'|'deferred'='accepted';
   try{
    const result=await rpc.call('turn/steer',{threadId:activeThread,expectedTurnId:activeTurn,clientUserMessageId:receipt.request.source,
     input:[{type:'text',text:codexMessage(receipt.request,intent.brief)}]});
    if(result?.turnId!==activeTurn)state='unknown';
   }catch(error){
    state=codeOf(error)==='CODEX_RPC_REJECTED'?'deferred':'unknown';
   }
   store.tx(()=>{
    const current=store.get(lease.id);
    if(!current||current.grant!==lease.grant||current.version!==lease.version)return;
    const followUps=(current.followUps??[]).filter(item=>item.request.source!==receipt.request.source);
    if(state==='deferred'){
     deferred=true;
     store.defer(receipt.request);
    }else{
     followUps.push({...receipt,state});
     if(state==='accepted')current.requests.push(receipt.request);
     else store.notify('source:'+receipt.request.source,'未能确认这条追问有没有送到 GPT 小姐，可以在原对话重新问。');
    }
    store.save({...current,followUps});
   });
  };
  const timer=setInterval(()=>{
   if(signal.aborted||completed?.id===activeTurn||pending.size||flight||deferred)return;
   flight=forward().catch(error=>{
    if(!signal.aborted)console.warn('Development Codex follow-up '+codeOf(error));
   }).finally(()=>{flight=undefined;});
  },400);
  let finished:any;
  try{
   if(runningTurn){
    const current=await latest(activeThread);
    if(current?.id===runningTurn&&current.status!=='inProgress')completed=current;
   }
   finished=completed?.id===expected?completed:await done;
   await flight;
  }finally{clearInterval(timer);}
  binding=undefined;
  guard();
  progress(expected,finished.status==='completed'?'GPT 小姐已交回本轮结果':'GPT 小姐这轮中断');
  if(finished.status!=='completed')throw rateLimitFailure(finished.error)??new FishError('DEV_CODEX_TURN_FAILED');
  return {turn:expected,text:await finalText(id,finished)};
 }catch(error){
  if(!signal.aborted){
   const detail=stderr.trim();
   console.warn('Development Codex failed',JSON.stringify(diagnosticSafe({task:job.id,stage,code:codeOf(error),
    error:error instanceof Error?error.message:undefined,stderr:startup?detail:undefined})));
   if(startup&&/mount proc on [^\r\n]*\/proc\s*:\s*Operation not permitted/.test(detail))
    throw new FishError('DEV_CODEX_PROC_MOUNT_DENIED');
  }
  throw error;
 }finally{
  signal.removeEventListener('abort',onAbort);
  try{await stopping;}finally{await rpc.stop(true);}
 }
}
