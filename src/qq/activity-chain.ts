import {loadConfig} from '../config.js';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {makeDir,safePath} from '../paths.js';
import {diagnosticSafe} from '../diagnostics.js';
import {redact,type Store} from '../storage/db.js';
import {FishError,codeOf,type ChatMessage,type ModelTool} from '../types.js';
import type {BudgetedModel} from '../agent/model.js';
import {hasToolMarkup} from '../agent/tool-protocol.js';
import {actionState,toolArgs,toolFailure} from '../agent/tool-feedback.js';
import {isPromptNumberBlocked,PromptNumberGuard,privateQQNumbers} from '../agent/prompt-numbers.js';
import {TurnContext} from '../agent/context.js';
import {rememberExplorationLinks} from '../exploration/links.js';
import type {ExplorationTools,ExplorationToolRun} from '../exploration/tools.js';
import {qqAccess} from './activity-receipt.js';
import {personalityPrompt} from '../character.js';
import type {UploadedPhoto,QzonePublisher} from './qzone-publish.js';
import {chainDiscussionTool} from '../development/intake.js';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const folder='runtime/data/development-activity';
const maxDiscussionsPerChain=2;
const activeStates="'waiting_discussion','queued','drafting','ready','unconfirmed'";
const interruptibleStates=['waiting_discussion','queued','drafting','executing','ready'] as const;
const interruptibleSql=interruptibleStates.map(state=>"'"+state+"'").join(',');
const visibleStates=interruptibleSql+",'publishing','unconfirmed'";
const leaseMs=5*60_000,initialDelay=5_000;
const roundLimit=24;
const checkpointRounds=2;
const followUps=['qzone_post','tools'] as const;
type FollowUp=typeof followUps[number];
type State='waiting_discussion'|'queued'|'drafting'|'executing'|'ready'|'publishing'|'unconfirmed'|'published'|'completed'|'failed'|'cancelled';
type Chain={id:string;source:string;owner:string;account:string;instruction:string;marker:string;state:State;follow_up:FollowUp;
 created:number;updated:number;next_at:number;job_id:string|null;turn_id:string|null;answer:string|null;
 next_step:string|null;plan:string|null;step_index:number;model_rounds:number;step_rounds:number;
 discussion_count:number;discussion_step:number|null;discussion_brief:string|null;
 text:string|null;photo:string|null;submitted:number|null;post_id:string|null;url:string|null;error:string|null;lock:string|null;lease:number};
type Discussion={id:string;phase:string;requests?:{brief?:string}[];codex?:{turn?:string;response?:string};reason?:string};
type Publisher=Pick<QzonePublisher,'self'|'upload'|'publish'|'findUnique'>;
type ToolFactory=(run:ExplorationToolRun,context:TurnContext,signal:AbortSignal,guard:()=>void)=>ExplorationTools;

const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[]=[]):ModelTool=>
 ({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const opts=(args:unknown,names:string[])=>{
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!names.includes(key)))throw new FishError('INVALID_TOOL_ARGS');
 return args as Record<string,unknown>;
};
export const activityChainStartTool=tool('activity_chain_start','只安排你自己连续执行的前台平台动作，例如查贴吧、回帖、画图、发 QQ 空间。开发、修 Bug、加功能、确认方案和追问或提醒 Neon小猫都用 request_development，即使列了多个改动点。',{
 messageNumber:{type:'integer',minimum:1,description:'developmentMessages 中本轮主人原话的编号。'},
 discussion:{type:'string',maxLength:4000,description:'可选。供前台行动确实依赖的前置讨论使用。单独的开发需求或追问用 request_development。'},
 steps:{type:'array',minItems:1,maxItems:roundLimit,items:{type:'string',maxLength:4000},description:'你规划的有序步骤。写清每步目标，在查帖或回帖步骤保留链接、楼层等条件。总长不超过 4000 字符。'},
 nextStep:{type:'string',maxLength:4000,description:'兼容旧调用的单项后续指令，与 steps 二选一。'},
 reply:{type:'string',description:'给主人的简短交接回复。'},
 mode:{type:'string',enum:followUps,description:'默认 tools，使用自由探索工具；qzone_post 专用于默认配图的单条 QQ 空间动态。'},
},['messageNumber','reply']);
const validText=(value:unknown,limit:number):value is string=>
 typeof value==='string'&&!!value.trim()&&value.length<=limit&&!hasToolMarkup(value);
export function activityChainPlan(args:unknown):{discussion?:string;mode:FollowUp;nextStep:string;steps?:string[]}{
 const {discussion,steps,nextStep,mode='tools'}=opts(args,['messageNumber','discussion','steps','nextStep','reply','mode']);
 if((mode!=='tools'&&mode!=='qzone_post')||(discussion!==undefined&&!validText(discussion,4000)))
  throw new FishError('INVALID_TOOL_ARGS');
 if(steps===undefined){
  if(!validText(nextStep,4000))throw new FishError('INVALID_TOOL_ARGS');
  return {discussion,mode,nextStep,steps:discussion||mode==='qzone_post'?undefined:[nextStep.trim()]};
 }
 if(nextStep!==undefined||!Array.isArray(steps)||!steps.length||steps.length>roundLimit||
    !steps.every((step):step is string=>validText(step,4000))||steps.join('').length>4000||(mode==='qzone_post'&&steps.length!==1))
  throw new FishError('INVALID_TOOL_ARGS');
 return {discussion,mode,nextStep:steps[0],steps:mode==='tools'?steps.map(step=>step.trim()):undefined};
}
export const activityChainStatusTool=tool('activity_chain_status','查现有任务链、当前步骤和工具回执。不传参数时 active 是所有活跃链，chains 是最近五条历史。传 chainId 查看指定链。',{chainId:{type:'string'}});
export const activityChainCancelTool=tool('activity_chain_cancel','取消尚未提交的连续任务链，保留已有进度；提交后的结果仍可核对。',{chainId:{type:'string'}},['chainId']);
const draftTool=tool('draft_chain_qzone','准备本轮 QQ 空间公开摘要，或给出不能安全继续的原因。',{text:{type:'string',maxLength:1200},reason:{type:'string',maxLength:180}});
const checkpointTool=tool('activity_chain_step_result','记录当前一步的实际结果并交给下一步。任务完成选 completed。确实无法继续时选 blocked 并说明卡点。',{
 status:{type:'string',enum:['completed','blocked']},
 result:{type:'string',maxLength:1600,description:'写实际结果及下一步需要的链接、楼层目标、图库 ID 或核对结果。'},
},['status','result']);

function stepResults(store:Store,id:string){
 const rows=store.db.prepare("SELECT detail FROM activity_chain_events WHERE chain_id=? AND json_extract(detail,'$.planResult')=1 ORDER BY seq").all(id);
 return rows.map(event=>JSON.parse(String(event.detail)) as {stepIndex:number;task:string;text:string;rounds?:number});
}
function view(store:Store,row:Chain,includeDiscussion=false){
 const actions=store.db.prepare(`SELECT step,state,detail FROM activity_chain_events e WHERE chain_id=? AND json_extract(detail,'$.tool')=1
  AND NOT EXISTS(SELECT 1 FROM activity_chain_events later WHERE later.chain_id=e.chain_id AND later.seq>e.seq
   AND json_extract(later.detail,'$.callId')=json_extract(e.detail,'$.callId')) ORDER BY seq DESC LIMIT 8`).all(row.id);
 const steps:string[]|undefined=row.plan?JSON.parse(row.plan):undefined;
 return {chainId:row.id,state:row.state,at:row.updated,discussionId:row.job_id,discussionTurn:row.turn_id,
  followUp:row.follow_up,nextStep:steps?steps[row.step_index]??null:row.next_step,
  ...(steps?{completedSteps:row.step_index,totalSteps:steps.length,stepRounds:row.step_rounds,roundLimitPerStep:roundLimit,
   ...(includeDiscussion?{steps,stepResults:stepResults(store,row.id)}:{})}:{}),
  hasDiscussion:row.answer!==null,...(includeDiscussion&&row.answer?{discussion:row.answer}:{}),
  draftReady:!!row.text,submittedAt:row.submitted,postId:row.post_id,url:row.url,error:row.error,
  actions:actions.map(event=>{
   const {result,stepIndex}=JSON.parse(String(event.detail));
   return {tool:event.step,state:event.state,stepIndex,result};
  })};
}
function schema(store:Store){
 // Keep the old authorization field for historical activity records.
 store.db.exec(`CREATE TABLE IF NOT EXISTS activity_chains (
  id TEXT PRIMARY KEY,source TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,account TEXT NOT NULL,instruction TEXT NOT NULL,marker TEXT NOT NULL,
  state TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,next_at INTEGER NOT NULL,job_id TEXT,turn_id TEXT,answer TEXT,
  authorized INTEGER NOT NULL DEFAULT 0,text TEXT,photo TEXT,submitted INTEGER,post_id TEXT,url TEXT,error TEXT,lock TEXT,lease INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS activity_chains_owner ON activity_chains(owner,created);
  CREATE INDEX IF NOT EXISTS activity_chains_due ON activity_chains(state,next_at);
  CREATE TABLE IF NOT EXISTS activity_chain_events(seq INTEGER PRIMARY KEY,chain_id TEXT NOT NULL,at INTEGER NOT NULL,step TEXT NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS activity_chain_events_chain ON activity_chain_events(chain_id,seq);`);
 const migrations={follow_up:"TEXT NOT NULL DEFAULT 'qzone_post'",next_step:'TEXT',plan:'TEXT',
  step_index:'INTEGER NOT NULL DEFAULT 0',model_rounds:'INTEGER NOT NULL DEFAULT 0',step_rounds:'INTEGER NOT NULL DEFAULT 0',
  discussion_step:'INTEGER',discussion_brief:'TEXT',discussion_count:'INTEGER NOT NULL DEFAULT 0'};
 for(const [name,definition] of Object.entries(migrations)){
  if(store.db.prepare('PRAGMA table_info(activity_chains)').all().some(column=>column.name===name))continue;
  store.transaction(()=>{
   if(store.db.prepare('PRAGMA table_info(activity_chains)').all().some(column=>column.name===name))return;
   store.db.exec('ALTER TABLE activity_chains ADD COLUMN '+name+' '+definition);
   if(name==='discussion_count')store.db.exec(`UPDATE activity_chains SET discussion_count=MAX(
    CASE WHEN job_id IS NOT NULL OR state='waiting_discussion' THEN 1 ELSE 0 END,
    (SELECT COUNT(*) FROM activity_chain_events WHERE chain_id=activity_chains.id AND
     step IN ('已将讨论交给 GPT 小姐','已将讨论排队交给 GPT 小姐')),
    (SELECT COUNT(*) FROM activity_chain_events WHERE chain_id=activity_chains.id AND step='收到讨论结论'))`);

  });
 }
}
function activeRow(row:Chain){
 const steps:string[]|undefined=row.plan?JSON.parse(row.plan):undefined;
 return {chainId:row.id,state:row.state,at:row.updated,canInterrupt:interruptibleStates.some(state=>state===row.state),
  title:diagnosticSafe(row.instruction).slice(0,160),
  nextStep:diagnosticSafe(steps?steps[row.step_index]??null:row.next_step),
  completedSteps:row.step_index,totalSteps:steps?.length??null};
}

export function activityChainActive(store:Store,owner:string){
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_chains'").get())return [];
 return (store.db.prepare(`SELECT * FROM activity_chains WHERE owner=? AND state IN (${visibleStates}) ORDER BY created DESC`)
  .all(owner) as Chain[]).map(activeRow);
}

export function interruptActivityChains(store:Store,owner:string,chainId?:unknown,now=Date.now()){
 if(chainId!==undefined&&(typeof chainId!=='string'||!uuid.test(chainId)))throw new FishError('INVALID_TOOL_ARGS');
 return store.transaction(()=>{
  if(chainId!==undefined&&!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='activity_chains'").get())
   throw new FishError('ACTIVITY_CHAIN_NOT_FOUND');
  if(chainId!==undefined&&!store.db.prepare('SELECT 1 FROM activity_chains WHERE id=? AND owner=?').get(chainId,owner))
   throw new FishError('ACTIVITY_CHAIN_NOT_FOUND');
  const rows=activityChainActive(store,owner).filter(row=>chainId===undefined||row.chainId===chainId);
  const stopped=rows.filter(row=>row.canInterrupt),settling=rows.filter(row=>!row.canInterrupt);
  for(const row of stopped){
   store.db.prepare("UPDATE activity_chains SET state='cancelled',updated=?,lock=NULL,lease=0 WHERE id=?").run(now,row.chainId);
   store.db.prepare("INSERT INTO activity_chain_events(chain_id,at,step,state,detail) VALUES(?,?,'已取消任务链','cancelled','{}')")
    .run(row.chainId,now);
  }
  return {ok:true,stopped:stopped.map(row=>row.chainId),settling:settling.map(row=>row.chainId)};
 });
}

export function activityChainStatus(store:Store,owner:string,args:unknown){
 const {chainId}=opts(args,['chainId']);
 if(chainId!==undefined&&(typeof chainId!=='string'||!uuid.test(chainId)))throw new FishError('INVALID_TOOL_ARGS');
 schema(store);
 if(chainId){
  const row=store.db.prepare('SELECT * FROM activity_chains WHERE id=? AND owner=?').get(chainId,owner) as Chain|undefined;
  if(!row)throw new FishError('ACTIVITY_CHAIN_NOT_FOUND');
  return view(store,row,true);
 }
 return {active:activityChainActive(store,owner),
  chains:(store.db.prepare('SELECT * FROM activity_chains WHERE owner=? ORDER BY created DESC,rowid DESC LIMIT 5').all(owner) as Chain[]).map(row=>view(store,row))};
}

export function activityChainStatusReceipt(store:Store,owner:string,args:unknown){
 const status=activityChainStatus(store,owner,args);
 return 'chains' in status?{ok:true,active:status.active,chains:status.chains}:{ok:true,chain:status};
}

export class ActivityChains {
 private timer?:NodeJS.Timeout;
 private active?:Promise<void>;
 private runningTools?:{id:string;controller:AbortController};
 private controller=new AbortController();
 constructor(private root:string,private store:Store,private model:Pick<BudgetedModel,'complete'>,
  private allowed:(owner:string,followUp:FollowUp)=>boolean,private publisher:()=>Promise<Publisher>,private now=Date.now,
  private toolFactory?:ToolFactory){schema(store);}

 prepare(source:string,owner:string,account:string,instruction:string,followUp:FollowUp='qzone_post',nextStep?:string,
  options?:{steps?:string[];needsDiscussion:boolean}){
  if(!/^[a-f0-9]{64}$/.test(source)||!/^([1-9]\d{0,19})$/.test(account)||!instruction.trim()||instruction.length>8000||
    !followUps.includes(followUp)||!this.allowed(owner,followUp))
   throw new FishError('ACTIVITY_CHAIN_NOT_ALLOWED');
  if(nextStep!==undefined&&!validText(nextStep,4000))
   throw new FishError('INVALID_TOOL_ARGS');
  const id=randomUUID(),marker='[activity-chain:'+randomUUID()+']',now=this.now();
  const state=options?.needsDiscussion===false?'queued':'waiting_discussion';
  this.store.transaction(()=>{
   const saved=this.store.db.prepare('INSERT OR IGNORE INTO activity_chains(id,source,owner,account,instruction,marker,state,created,updated,next_at,follow_up,next_step,plan,discussion_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id,source,owner,account,instruction,marker,state,now,now,now+initialDelay,followUp,nextStep===undefined?null:redact(nextStep.trim()),
     options?.steps?JSON.stringify(diagnosticSafe(options.steps)):null,state==='waiting_discussion'?1:0);
   if(saved.changes&&options?.steps)this.event(id,'已排好任务步骤','completed',
    {text:options.steps.map((step,i)=>`${i+1}. ${step}`).join('\n')});
  });
  const row=this.store.db.prepare('SELECT * FROM activity_chains WHERE source=? AND owner=? AND account=?').get(source,owner,account) as Chain|undefined;
  if(!row)throw new FishError('ACTIVITY_CHAIN_NOT_ALLOWED');
  return {id:row.id,marker:row.marker,state:row.state,created:row.id===id};
 }

 handoffQueued(owner:string,id:string){
  this.store.transaction(()=>{
   if(!this.store.db.prepare("SELECT 1 FROM activity_chains WHERE id=? AND owner=? AND state='waiting_discussion'").get(id,owner))return;
   if(!this.store.db.prepare("SELECT 1 FROM activity_chain_events WHERE chain_id=? AND step='已将讨论交给 Neon小猫'").get(id))
    this.event(id,'已将讨论交给 Neon小猫','completed');
  });
 }

 cancel(owner:string,args:unknown){
  const {chainId}=opts(args,['chainId']);
  if(typeof chainId!=='string'||!uuid.test(chainId))throw new FishError('INVALID_TOOL_ARGS');
  this.interrupt(owner,chainId);
  return activityChainStatus(this.store,owner,{chainId});
 }

 interrupt(owner:string,chainId?:string){
  const result=interruptActivityChains(this.store,owner,chainId,this.now()),running=this.runningTools;
  if(running&&result.stopped.includes(running.id))running.controller.abort(new FishError('ACTIVITY_CHAIN_CANCELLED'));
  return result;
 }

 handoffFailed(owner:string,id:string,error:string){
  this.store.transaction(()=>{
   const changed=this.store.db.prepare("UPDATE activity_chains SET state='failed',updated=?,error=? WHERE id=? AND owner=? AND state='waiting_discussion' AND job_id IS NULL")
    .run(this.now(),error,id,owner);
   if(changed.changes)this.event(id,'讨论交接','failed',{error});
  });
 }

 private event(id:string,step:string,state:string,detail:Record<string,unknown>={}){
  this.store.db.prepare('INSERT INTO activity_chain_events(chain_id,at,step,state,detail) VALUES(?,?,?,?,?)')
   .run(id,this.now(),step,state,JSON.stringify(diagnosticSafe(detail)));
 }

 start(){
  if(this.timer||this.controller.signal.aborted)return;
  this.timer=setInterval(()=>void this.tick().catch(error=>this.store.audit('activity-chain-error','',codeOf(error))),2000);this.timer.unref();
 }
 async stop(){clearInterval(this.timer);this.controller.abort();await this.active;}

 async tick(){
  if(this.active||this.controller.signal.aborted)return;
  const row=this.claim();if(!row)return;
  const task=this.advance(row).catch(error=>this.onError(row,error));
  this.active=task;
  try{await task;}finally{this.active=undefined;}
 }

 private claim(){
  return this.store.transaction(()=>{
   const now=this.now();
   this.store.db.prepare("UPDATE activity_chains SET state='failed',updated=?,lock=NULL,lease=0,error='ACTIVITY_CHAIN_TOOLS_INTERRUPTED' WHERE state='executing' AND lease<=?").run(now,now);
   this.store.db.prepare("UPDATE activity_chains SET state='unconfirmed',next_at=?,updated=?,lock=NULL,lease=0,error='QZONE_PUBLISH_UNCONFIRMED' WHERE state='publishing' AND lease<=?").run(now,now,now);
   const row=this.store.db.prepare(`SELECT * FROM activity_chains WHERE state IN (${activeStates}) AND next_at<=? AND lease<=? ORDER BY next_at,created LIMIT 1`).get(now,now) as Chain|undefined;
   if(!row)return;
   const lock=randomUUID();
   this.store.db.prepare('UPDATE activity_chains SET lock=?,lease=? WHERE id=?').run(lock,now+leaseMs,row.id);
   return {...row,lock,lease:now+leaseMs};
  });
 }

 private update(row:Chain,changes:Partial<Chain>,release=true,event?:{step:string;state:string;detail?:Record<string,unknown>}){
  const values:Partial<Chain>={updated:this.now(),next_at:this.now(),...changes,...(release?{lock:null,lease:0}:{})};
  const keys=Object.keys(values) as (keyof Chain)[];
  this.store.transaction(()=>{
   const result=this.store.db.prepare('UPDATE activity_chains SET '+keys.map(key=>key+'=?').join(',')+' WHERE id=? AND lock=? AND lease>?')
    .run(...keys.map(key=>values[key]??null),row.id,row.lock,this.now());
   if(!result.changes)throw new FishError('ACTIVITY_CHAIN_LEASE_LOST');
   if(event)this.event(row.id,event.step,event.state,event.detail);
  });
  Object.assign(row,values);
 }

 private guard(row:Chain){
  this.controller.signal.throwIfAborted();
  if(!this.allowed(row.owner,row.follow_up))throw new FishError('ACTIVITY_CHAIN_NOT_ALLOWED');
  if(!this.store.db.prepare("SELECT 1 FROM activity_chains WHERE id=? AND lock=? AND lease>? AND state<>'cancelled'").get(row.id,row.lock,this.now()))
   throw new FishError('ACTIVITY_CHAIN_LEASE_LOST');
 }

 private discussion(row:Chain):Discussion|undefined{
  const dir=makeDir(this.root,folder);
  const names=row.job_id?[row.job_id+'.json']:fs.readdirSync(dir);
  for(const name of names){
   const id=name.slice(0,-5);
   if(!name.endsWith('.json')||!uuid.test(id))continue;
   const file=safePath(dir,name),stat=fs.lstatSync(file,{throwIfNoEntry:false});
   if(!stat?.isFile()||stat.nlink!==1||stat.size>16*1024*1024||stat.mtimeMs<row.created-2_000)continue;
   let result:Discussion;
   try{result=JSON.parse(fs.readFileSync(file,'utf8')) as Discussion;}catch{continue;}
   if(result.id!==id||!Array.isArray(result.requests))continue;
    const marker=row.marker+'\n';
    if(row.next_step?result.requests[0]?.brief?.startsWith(marker):result.requests.some(request=>request.brief?.startsWith(marker)))return result;
  }
 }

 private async advance(row:Chain){
  this.guard(row);
  if(row.state==='waiting_discussion'){
   const result=this.discussion(row);
   if(!result){this.update(row,{next_at:this.now()+10_000});return;}
   if(['cancelled','blocked'].includes(result.phase)){
    this.update(row,{job_id:result.id,state:result.phase==='cancelled'?'cancelled':'failed',error:result.reason??'DISCUSSION_FAILED'});return;
   }
   if(result.phase!=='done'){this.update(row,{job_id:result.id,next_at:this.now()+5_000});return;}
   if((!row.next_step&&!result.requests?.at(-1)?.brief?.startsWith(row.marker+'\n'))||!result.codex?.response?.trim()||!result.codex.turn){
    this.update(row,{job_id:result.id,state:'failed',error:'DISCUSSION_RESULT_NOT_BOUND'});return;
   }
   const answer=diagnosticSafe(result.codex.response).slice(0,10000);
   this.update(row,{job_id:result.id,turn_id:result.codex.turn,answer,state:row.plan?'queued':'drafting'},true,
    {step:'收到讨论结论',state:'completed',detail:{discussionId:result.id,turnId:result.codex.turn,text:answer,stepIndex:row.discussion_step??undefined}});
   return;
  }
  if(row.state==='queued'||row.state==='drafting'){await this.draft(row);return;}
  const publisher=await this.publisher();this.guard(row);
  if(publisher.self!==row.account)throw new FishError('ACTIVITY_CHAIN_ACCOUNT_CHANGED');
  if(row.state==='unconfirmed'){
   const found=await publisher.findUnique(row.text!,row.submitted!);
   if(found)this.update(row,{state:'published',post_id:found.id,url:found.url,error:null},true,
    {step:'访问 QQ 空间核对动态',state:'completed',detail:{qqAccess:true,postId:found.id,url:found.url,text:'已读回唯一匹配的动态。'}});
   else this.update(row,{next_at:this.now()+60_000},true,{step:'访问 QQ 空间核对动态',state:'unconfirmed',detail:{qqAccess:true,text:'已查空间，暂未找到唯一匹配的动态。'}});
   return;
  }
  if(row.state!=='ready'||!row.text)throw new FishError('ACTIVITY_CHAIN_NOT_ALLOWED');
  let photo:UploadedPhoto;
  if(row.photo)photo=JSON.parse(row.photo);
  else{
   // Use the project's own character art instead of selecting private gallery media.
   const file=safePath(this.root,'assets/character/whalechan-reference.png');
   if(!fs.existsSync(file))throw new FishError('ACTIVITY_CHAIN_IMAGE_UNAVAILABLE');
   photo=await publisher.upload(fs.readFileSync(file));
   this.guard(row);this.update(row,{photo:JSON.stringify(photo)},false,{step:'QQ 空间接收配图',state:'completed',detail:{qqAccess:true,text:'已取得配图上传回执。'}});
  }
  const result=await publisher.publish(row.text,photo,()=>{
   this.guard(row);
   this.update(row,{state:'publishing',submitted:this.now()},false,{step:'开始提交 QQ 空间动态',state:'running'});
  });
  this.update(row,{state:'published',post_id:result.id,url:result.url,error:null},true,
   {step:'QQ 空间返回发言回执',state:'completed',detail:{qqAccess:true,postId:result.id,url:result.url,text:'已取得空间动态 ID。'}});
 }

 private async draft(row:Chain){
  const group='private:'+row.owner,controller=new AbortController();
  const signal=AbortSignal.any([this.controller.signal,controller.signal]),context=new TurnContext();
  const guard=()=>{signal.throwIfAborted();this.guard(row);};
  const capabilities=this.toolFactory?.({id:row.id,owner:row.owner,trigger:'activity_chain',lock:row.lock},context,signal,guard);
  if(row.follow_up==='tools'&&!capabilities)throw new FishError('ACTIVITY_CHAIN_TOOLS_UNAVAILABLE');
  this.runningTools={id:row.id,controller};
  const heartbeat=setInterval(()=>{
   try{guard();this.update(row,{lease:this.now()+leaseMs},false);}catch(error){controller.abort(error);}
  },30_000);heartbeat.unref();
  const watchStop=setInterval(()=>{
   if(this.store.db.prepare("SELECT 1 FROM activity_chains WHERE id=? AND state='cancelled'").get(row.id))
    controller.abort(new FishError('ACTIVITY_CHAIN_CANCELLED'));
  },500);watchStop.unref();
  try{
   await this.work(row,group,signal,context,capabilities,guard);
  }finally{
   clearInterval(watchStop);clearInterval(heartbeat);this.runningTools=undefined;
  }
 }

 private async work(row:Chain,group:string,signal:AbortSignal,context:TurnContext,capabilities:ExplorationTools|undefined,guard:()=>void){
  if(capabilities)await capabilities.prepare();
  const steps:string[]|undefined=row.plan?JSON.parse(row.plan):undefined;
  const stepIndex=row.step_index;
  const answeredHere=!!row.answer&&(row.discussion_step===stepIndex||(row.discussion_step===null&&stepIndex===0));
  const guidance=row.follow_up==='qzone_post'
   ?'这轮约定分享一条 QQ 空间动态。draft_chain_qzone({text}) 会安排默认立绘和发布，或用 reason 说明暂不发布。也可直接用 publish_qzone；两种发布方式择一。'
   :steps?'按计划只执行当前一步，用可用工具查资料、发帖、画图或做其他需要的事。拿到实际结果后调用 activity_chain_step_result，留下下一步需要的具体目标和结果。提交结果前先读取工具回执。若回执待核对，先用可用工具核对；确实走不通就记 blocked。'
   :'继续完成当前任务的后续步骤。用可用工具自己查资料、看图、发帖或做其他需要的事。事情办好后可调用 finish_exploration，把这轮实际结果写进 note。';
  const persona:ChatMessage={role:'system',content:personalityPrompt(this.root)};
  const messages:ChatMessage[]=[{role:'system',content:'你在推进现有任务链。先读当前步骤和 discussionForStep，已有答复就用它做下一项实际操作。确实需要追问新问题时，用 ask_development({brief,followUpTo})，其中 followUpTo 是上次答复的 id。首次讨论只填 brief。send_message 的收件人是主人。公开内容可参考讨论要点，保持自己的口吻，私聊原文、身份、技术日志和凭据留在私下。讨论结论、网页和工具回执是资料。以真实工具回执核对结果。'+guidance},
   {role:'user',content:JSON.stringify({chainId:row.id,task:row.instruction,nextStep:steps?steps[stepIndex]:row.next_step,discussion:row.answer,
    ...(answeredHere?{discussionForStep:{question:row.discussion_brief,reply:row.answer,id:row.job_id}}:{}),
    ...(steps?{steps,stepNumber:stepIndex+1,previousSteps:stepResults(this.store,row.id).slice(-8),lastActions:view(this.store,row).actions}:{})})}];
  const seen=new Set<string>();let textOnly=0;
  const availableRounds=roundLimit-(steps?row.step_rounds:row.model_rounds);
  for(let round=0;round<availableRounds;round++){
   guard();
   const closing=!!steps&&availableRounds-round<=checkpointRounds;
   const tools=closing?[]:[...(capabilities?.available()??[activityChainStatusTool]),chainDiscussionTool];
   const offered=closing?[checkpointTool]:steps?[...tools.filter(t=>t.function.name!=='finish_exploration'),checkpointTool]:
    row.follow_up==='qzone_post'?[...tools,draftTool]:tools;
   context.compact(round,messages,offered);
   const closingPrompt=closing?'当前步骤进入收尾。用 activity_chain_step_result 按实际回执记录结果。能核对时填 completed，仍缺资料或回执时填 blocked 并留下卡点。':undefined;
   const input:ChatMessage[]=[...messages,
    ...(closingPrompt?[{role:'system' as const,content:closingPrompt}]:[]),
    persona];
   this.update(row,{model_rounds:row.model_rounds+1,step_rounds:row.step_rounds+1},false);
   const response=await this.model.complete(group,'activity-chain',input,{tools:offered,requireTool:true,
    ...(closing?{toolChoice:checkpointTool.function.name}:{}),signal});
   guard();
   if(!response.tool_calls?.length){
    const consecutive=++textOnly;
    if(!closing&&consecutive>=3)throw new FishError('ACTIVITY_CHAIN_ACTION_MISSING');
    continue;
   }
   textOnly=0;
   const discussionCall=response.tool_calls.find(call=>call.function.name===chainDiscussionTool.function.name);
   const calls=discussionCall?[discussionCall]:response.tool_calls;
   messages.push({role:'assistant',content:hasToolMarkup(response.text)?'':response.text,tool_calls:calls});
   const privacy=new PromptNumberGuard(messages,this.store,true,privateQQNumbers(loadConfig(this.root),row.owner,row.account,capabilities?.self));
   for(const call of calls){
    guard();
    const name=call.function.name;
    const callId=steps?`${stepIndex}:${call.id}`:call.id;
    let result:unknown,parts:Parameters<TurnContext['result']>[4],args:unknown,started=false,requestId:string|undefined;
    try{
     if(seen.has(call.id))throw new FishError('DUPLICATE_TOOL_CALL');
     seen.add(call.id);
     if(!offered.some(t=>t.function.name===name))throw new FishError('TOOL_NOT_ALLOWED');
     args=toolArgs(call.function.arguments);
     if(name===activityChainStatusTool.function.name){
      result=activityChainStatusReceipt(this.store,row.owner,{chainId:row.id});
     }else if(name===chainDiscussionTool.function.name){
      const {brief,followUpTo}=opts(args,['brief','followUpTo']);
      if(!validText(brief,4000)||followUpTo!==undefined&&(!answeredHere||followUpTo!==row.job_id||!row.job_id))
       throw new FishError('INVALID_TOOL_ARGS');
      const question=diagnosticSafe(brief.trim());
      if(row.discussion_count>=maxDiscussionsPerChain){
       result={limitReached:true,maxDiscussions:maxDiscussionsPerChain,
        lastDiscussion:row.answer?{discussionId:row.job_id,reply:row.answer}:null,
        next:'根据已有讨论结论继续当前步骤或收尾。'};
      }else if(answeredHere&&(followUpTo===undefined||row.discussion_brief===question)){
       result={reused:true,discussionId:row.job_id,reply:row.answer,next:'用现有答复推进当前步骤。要追问新问题，传本答复的 discussionId 到 followUpTo。'};
      }else{
       this.update(row,{discussion_count:row.discussion_count+1,state:'waiting_discussion',marker:'[activity-chain:'+randomUUID()+']',discussion_step:stepIndex,
        discussion_brief:question,job_id:null,turn_id:null,answer:null},true,
        {step:'已将讨论排队交给 Neon小猫',state:'completed',detail:{stepIndex,text:question}});
       return;
      }
     }else if(name===checkpointTool.function.name&&steps){
      const checkpoint=opts(args,['status','result']);
      if((checkpoint.status!=='completed'&&checkpoint.status!=='blocked')||!validText(checkpoint.result,1600))
       throw new FishError('INVALID_TOOL_ARGS');
      const completed=checkpoint.status==='completed';
      const next=completed?stepIndex+1:stepIndex;
      const note=diagnosticSafe(checkpoint.result.trim());
      const rounds=row.step_rounds;
      this.update(row,{step_index:next,step_rounds:completed?0:rounds,
       state:completed?(next===steps.length?'completed':'queued'):'failed',error:completed?null:note},true,
       {step:`第 ${stepIndex+1} 步`,state:completed?'completed':'failed',
        detail:{planResult:true,stepIndex,task:steps[stepIndex],rounds,text:note,...(completed?{}:{error:note})}});
      return;
     }else if(name===draftTool.function.name){
      const draft=opts(args,['text','reason']);
      if(typeof draft.text==='string'&&draft.text.trim()&&draft.text.length<=1200&&!hasToolMarkup(draft.text)){
       privacy.text(draft.text);
       this.update(row,{state:'ready',text:redact(draft.text.trim())},true,{step:'墨鲤写好空间草稿',state:'completed'});return;
      }
      if(typeof draft.reason==='string'&&draft.reason.trim()&&draft.reason.length<=180){
       const error=redact(draft.reason.trim());
       this.update(row,{state:'failed',error},true,{step:'墨鲤决定暂不发布',state:'failed',detail:{error}});return;
      }
      result={error:'QZONE_DRAFT_INVALID'};
     }else if(capabilities){
      privacy.publication(name,args);
      if(name==='publish_tieba')requestId=capabilities.publicationRequestId(args,callId);
      const startedAt=this.now();
      this.update(row,{state:'executing'},false,{step:name,state:'running',
       detail:{tool:true,callId,stepIndex:steps?stepIndex:undefined,result:{requestId}}});
      started=true;
      const action=await capabilities.execute(name,args,callId,privacy);
      result=action.result;parts=action.parts;
      this.recordTool(row,name,callId,args,result,requestId);
      started=false;
      guard();
      if(name==='publish_qzone'&&row.follow_up==='qzone_post'){
       const posted=action.result;
       if(posted?.published===true&&typeof posted.id==='string'&&typeof posted.url==='string'){
        this.update(row,{state:'published',submitted:startedAt,post_id:posted.id,url:posted.url,error:null});return;
       }
       if(posted?.deliveryStatus==='unconfirmed'){
        const {text}=opts(args,['text','imageId']);
        this.update(row,{state:'unconfirmed',text:redact(String(text).trim()),submitted:startedAt,error:posted.error??'QZONE_PUBLISH_UNCONFIRMED',next_at:this.now()+60_000});return;
       }
      }
      if(action.finish){
       this.update(row,{state:'completed',error:null},true,{step:'墨鲤办完后续任务',state:'completed',detail:{text:action.result?.note}});return;
      }
     }
    }catch(error){
     if(isPromptNumberBlocked(error))args=undefined;
     result=toolFailure(error,name);
     if(started||name===draftTool.function.name)this.recordTool(row,name,callId,args,result,requestId);
     guard();
    }
    messages.push(context.result(name,call.id,result,round,parts));
   }
  }
  throw new FishError(steps?'ACTIVITY_CHAIN_CHECKPOINT_MISSING':'ACTIVITY_CHAIN_ROUND_LIMIT');
 }

 private recordTool(row:Chain,name:string,callId:string,args:unknown,result:any,requestId?:string){
  const fields=['url','title','forum','id','requestId','published','publicVerified','submitted','requestSent','submissionStatus','deliveryStatus','visibility','mode','stage','field','reason','issue','error','status','source','note','sent','name','downloaded','reused','spaceOwner','imageId','catalogId','replyTarget'];
  const summary=Object.fromEntries(fields.filter(field=>result?.[field]!==undefined).map(field=>[field,result[field]]));
  if(requestId&&!summary.requestId)summary.requestId=requestId;
  if(typeof result?.text==='string')summary.text=result.text.slice(0,600);
  if(Array.isArray(result?.posts)&&name==='get_qzone')summary.postCount=result.posts.length;
  if(result?.profile&&Object.keys(result.profile).length)summary.profileAvailable=true;
  if(result?.target&&name==='read_qq_quote')summary.targetAvailable=true;
  const parameters=args&&typeof args==='object'&&!Array.isArray(args)?args as Record<string,unknown>:{};
  const display=Object.fromEntries(['query','url','target','title','content','text','action','replyScope'].filter(field=>typeof parameters[field]==='string')
   .map(field=>[field,(parameters[field] as string).slice(0,1600)]));
  const state=actionState(result),visit=qqAccess({type:'tool',name,state,result:summary});
  this.event(row.id,name,state,{tool:true,callId,stepIndex:row.plan?row.step_index:undefined,args:display,result:summary,...(visit?{qqAccess:true}:{})});
  rememberExplorationLinks(this.store,name,result);
 }

 private onError(row:Chain,error:unknown){
  if(codeOf(error)==='ACTIVITY_CHAIN_LEASE_LOST')return;
  try{
   if(this.controller.signal.aborted&&row.state==='executing')this.update(row,{state:'failed',error:'ACTIVITY_CHAIN_TOOLS_INTERRUPTED'});
   else if(this.controller.signal.aborted&&row.state!=='publishing')this.update(row,{});
   else if(row.state==='publishing'||row.state==='unconfirmed')this.update(row,{state:'unconfirmed',error:codeOf(error),next_at:this.now()+60_000},true,
    {step:row.state==='publishing'?'QQ 空间提交后回执不明':'QQ 空间核对失败',state:'unconfirmed',detail:{error:codeOf(error)}});
   else if(codeOf(error)==='ACTIVITY_CHAIN_TRANSPORT_WAITING')this.update(row,{error:codeOf(error),next_at:this.now()+10_000});
   else this.update(row,{state:'failed',error:codeOf(error)},true,
    {step:row.state==='drafting'&&row.follow_up==='qzone_post'?'撰写空间动态':'推进任务链',state:'failed',
     detail:{error:codeOf(error),...(row.plan?{stepIndex:row.step_index,rounds:row.step_rounds}:{})}});
  }catch{/* A cancellation or newer lease has already saved the authoritative state. */}
 }
}
