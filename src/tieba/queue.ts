import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomInt,randomUUID} from 'node:crypto';
import {codeOf,FishError} from '../types.js';
import {errorDiagnostic,ProviderError} from '../diagnostics.js';

type Row={id:string;action:string;state:string;created:number;started:number|null;finished:number|null;metadata:string;payload:string|null;result:string|null};
type QueueItem=ReturnType<typeof operationItem>;
type Job={id:string;action:string;key?:string;work:(signal:AbortSignal)=>Promise<any>;resolve:(value:any)=>void;reject:(error:unknown)=>void};
interface QueueLifecycle {describe():Record<string,unknown>;cancel():Promise<void>;restart():void}
interface QueueOptions {publishIntervalMs?:number;publishMaxIntervalMs?:number;random?:()=>number}
const CLEANUP_LIMIT_MS=30000;
const QUEUED_PUBLICATION_NOTICE='已进入贴吧通用队列，按1分钟到1分20秒随机间隔排队，后台按顺序自动发送；无需等待，勿重试勿重复发。稍后可用 check_tieba_publication({requestId}) 查真实回执。';
export function executionLimit(action:string,publicationInput=false){
 if(action==='input'&&publicationInput)return 240000;
 if(['publish','publication-submit'].includes(action))return 240000;
 if(action==='moderator')return 180000;
 if(['start','publication-start'].includes(action))return 120000;
 if(action==='close')return 15000;
 if(['frame','publication-frame','input','logout'].includes(action))return 30000;
 return 90000;
}
const parse=(v:string|null)=>{try{return JSON.parse(v??'null');}catch{return null;}};
const replyAction=(action:unknown)=>action==='reply'||action==='comment';
const activeState=(state:string)=>state==='queued'||state==='running'||state==='cleaning';
const publishAction=(action:string)=>action==='publish'||action==='publication-submit';
function livePublish(value:any,error?:unknown){
 const result=value?.publicationWork?.result??value,diagnostic=(error as ProviderError|undefined)?.diagnostic;
 if(result?.mode==='preview'||result?.outcome==='preview'||result?.reused===true)return false;
 if(result?.stage==='input_validation'||diagnostic?.stage==='input_validation')return false;
 if(typeof diagnostic?.field==='string'&&typeof diagnostic?.reason==='string'||typeof (error as any)?.field==='string'&&typeof (error as any)?.reason==='string')return false;
 // These failures occur before dispatching a browser publish, including the
 // queued scene check in the capture worker. Browser/platform failures count.
 const code=error?codeOf(error):result?.error;
 return !['TIEBA_INPUT_INVALID','TIEBA_PUBLISH_INPUT_INVALID','TIEBA_PUBLISH_INPUT_TOO_LARGE','TIEBA_REQUEST_ID_INVALID','TIEBA_PUBLICATION_WINDOW_CHANGED',
  'TIEBA_PUBLICATION_NOT_PREPARED','TIEBA_NOT_CONFIGURED','TIEBA_BUSY','TIEBA_PUBLISH_DISABLED','TIEBA_PUBLISH_UNAVAILABLE','TIEBA_ACCOUNT_NOT_AUTHORIZED','TIEBA_REQUEST_ID_REUSED','TIEBA_RECOVERY_SOURCE_CHANGED'].includes(code);
}
// Keep publication operations with the account journal. Polls and frame reads remain bounded.
const publicationStep = "(action IN ('publish','publication-start','publication-submit','publication-check','verify') OR (action='input' AND json_extract(metadata,'$.publicationInput')=1))";
const operationRequest = "COALESCE(json_extract(metadata,'$.requestId'),json_extract(result,'$.requestId'))";
function operationItem(row:Row){
 const metadata=parse(row.metadata),limitMs=metadata?.executionLimitMs??null;
 return {id:row.id,action:row.action,state:row.state,createdAt:row.created,startedAt:row.started,finishedAt:row.finished,limitMs,deadlineAt:row.started&&limitMs?row.started+limitMs:null,metadata,result:parse(row.result)};
}
/** Only normalized public intent/result fields are stored. Login input,
 * screenshots, cookies and raw browser responses never enter this journal. */
function outcome(action:string,value:any,error?:unknown){
 if(error)return {outcome:'failed',error:codeOf(error),diagnostic:errorDiagnostic(error)};
 const publication=['publish','publication-start','publication-submit','publication-check','verify'].includes(action);
 const r=publication?(value?.publicationWork?.result??value):action==='moderator'?value:undefined;
 if(r){
  const receipt=r.receipt??{},state=r.mode==='preview'?'preview':r.publicVerified?'public':r.visibility==='removed_by_system'?'removed':r.error==='TIEBA_PUBLICATION_CHALLENGE'?'challenge':r.submitted===true||r.deliveryStatus==='accepted'?'accepted':r.submitted===null||r.deliveryStatus==='unconfirmed'?'unknown':r.error||r.deliveryStatus==='failed'?'failed':'done';
  return {outcome:state,requestId:r.requestId??value?.publicationWork?.requestId,id:r.id,url:r.url,submitted:r.submitted,published:r.published,publicVerified:r.publicVerified,visibility:r.visibility,error:r.error,
   receipt:{transport:receipt.transport,httpStatus:receipt.httpStatus,errorCode:receipt.errorCode,errorMessage:receipt.errorMessage,accepted:receipt.accepted,httpAttempts:receipt.httpAttempts,requestCounterSource:receipt.requestCounterSource,notSubmitted:receipt.notSubmitted,guardReason:receipt.guardReason,step:receipt.step,pageNotice:receipt.pageNotice,submission:receipt.submission},
   ...(action==='moderator'?{applicationStatus:r.applicationStatus}:{}),...(r.resolvedTarget?{resolvedTarget:r.resolvedTarget}:{}),...(r.mode==='preview'?{notice:'预演记录，没有真实发布。'}:{}),evidence:receipt.evidence,
   verifiedAt:r.verifiedAt,checks:r.checks};
 }
 const unavailable=['unavailable','login_required','blocked','error'].includes(value?.status),errorCode=value?.error??(unavailable?value?.unavailable?.[0]?.error??(value?.status==='login_required'?'TIEBA_LOGIN_REQUIRED':undefined):undefined);
 return {outcome:errorCode||unavailable?'failed':'done',...(errorCode?{error:errorCode}:{}),...(value?.status?{readStatus:value.status}:{}),...(typeof value?.returned==='number'?{returned:value.returned}:{}),...(value?.account?{account:value.account}:{}),...(typeof value?.prepared==='boolean'?{prepared:value.prepared}:{}),...(action==='close'?{closed:value?.closed,closeReason:value?.closeReason,notice:value?.notice}:{})};
}

/** One account browser queue, with durable spacing between publish attempts.
 * Reads and page controls may pass publishes waiting for their pacing slot.
 * Pending publish intents survive restart; an interrupted running operation
 * is reported locally and is never mistaken for a platform rejection. */
export class TiebaOperationQueue {
 private db:DatabaseSync;private jobs:Job[]=[];private running?:Job;private shared=new Map<string,Promise<any>>();private stopping=false;private drainWaiters:(()=>void)[]=[];
 private nextPublishAt=0;private publishIntervalMs:number;private publishMaxIntervalMs:number;private random:()=>number;private paceTimer?:NodeJS.Timeout;
 constructor(dir:string,private lifecycle:QueueLifecycle,private now=Date.now,options:QueueOptions={}){
  this.publishIntervalMs=options.publishIntervalMs??60_000;
  this.publishMaxIntervalMs=options.publishMaxIntervalMs??(options.publishIntervalMs===undefined?80_000:this.publishIntervalMs);
  this.random=options.random??(()=>randomInt(0x1_0000_0000)/0x1_0000_0000);
  if(!Number.isFinite(this.publishIntervalMs)||this.publishIntervalMs<0)throw new RangeError('Invalid publishIntervalMs');
  if(!Number.isFinite(this.publishMaxIntervalMs)||this.publishMaxIntervalMs<this.publishIntervalMs)throw new RangeError('Invalid publishMaxIntervalMs');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});const file=path.join(dir,'actions.sqlite');this.db=new DatabaseSync(file);fs.chmodSync(file,0o600);
  this.db.exec("PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS tieba_operations(id TEXT PRIMARY KEY,action TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,started INTEGER,finished INTEGER,metadata TEXT NOT NULL,payload TEXT,result TEXT);CREATE INDEX IF NOT EXISTS tieba_operations_state ON tieba_operations(state,created)");
  this.db.exec('CREATE TABLE IF NOT EXISTS tieba_queue_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const savedNext=Number((this.db.prepare("SELECT value FROM tieba_queue_meta WHERE key='next_publish_at'").get() as {value:string}|undefined)?.value);
  if(Number.isFinite(savedNext)&&savedNext>0)this.nextPublishAt=savedNext;
  for(const old of this.db.prepare("SELECT id,action,result FROM tieba_operations WHERE state IN ('running','cleaning')").all() as {id:string;action:string;result:string|null}[]){
   const saved=parse(old.result),timedOut=!!saved?.timeout;
   // An interrupted live attempt may have sent just before the crash. Keep a
   // full window on recovery without replaying that uncertain operation.
   if(publishAction(old.action)&&livePublish(saved?.lastResult??saved))this.advancePublishPacing();
   const result=timedOut?{...saved,timeout:{...saved.timeout,cleanup:{...saved.timeout.cleanup,state:'restart_required',recoveredAt:this.now()}},notice:'超时清理期间工作进程重启，未开始的发言恢复排队；原请求没有自动重发。'}:{outcome:'interrupted',error:'TIEBA_QUEUE_INTERRUPTED',notice:'服务在处理过程中重启；此为本地中断记录，请以原发布回执核对，未自动重发。'};
   this.db.prepare('UPDATE tieba_operations SET state=?,finished=?,result=? WHERE id=?').run(timedOut?'done':'interrupted',this.now(),JSON.stringify(result),old.id);
  }
  this.db.prepare("UPDATE tieba_operations SET state='interrupted',finished=?,result=? WHERE state='queued' AND (action!='publish' OR payload IS NULL)").run(this.now(),JSON.stringify({outcome:'interrupted',error:'TIEBA_QUEUE_INTERRUPTED',notice:'尚未执行的页面或读取操作随旧连接结束，未发布。'}));
  this.db.exec(`CREATE INDEX IF NOT EXISTS tieba_operation_request ON tieba_operations(${operationRequest},created) WHERE ${publicationStep}`);
  this.prune();
 }
 private prune(){this.db.exec(`DELETE FROM tieba_operations WHERE state NOT IN ('queued','running','cleaning') AND action IN ('frame','publication-frame') AND id NOT IN (SELECT id FROM tieba_operations WHERE action IN ('frame','publication-frame') ORDER BY finished DESC LIMIT 20);DELETE FROM tieba_operations WHERE state NOT IN ('queued','running','cleaning') AND action NOT IN ('frame','publication-frame') AND NOT ${publicationStep} AND id NOT IN (SELECT id FROM tieba_operations WHERE state NOT IN ('queued','running','cleaning') AND action NOT IN ('frame','publication-frame') AND NOT ${publicationStep} ORDER BY finished DESC LIMIT 500)`);}
 restore(publish:(payload:any,signal:AbortSignal)=>Promise<any>){
  for(const row of this.db.prepare("SELECT * FROM tieba_operations WHERE state='queued' AND action='publish' AND payload IS NOT NULL ORDER BY created,rowid").all() as Row[]){
   const payload=parse(row.payload);if(!payload?.requestId||!payload.input)continue;
   if(this.running?.id===row.id||this.jobs.some(job=>job.id===row.id))continue;
   const promise=this.schedule(row.id,'publish',signal=>publish(payload,signal),'publish:'+payload.requestId);void promise.catch(()=>{});
  }
 }
 enqueue(action:string,metadata:Record<string,unknown>,work:(signal:AbortSignal)=>Promise<any>,options:{key?:string;payload?:unknown;returnImmediatelyIfQueued?:boolean}={}){
  const nonBlocking=action==='publish'&&options.returnImmediatelyIfQueued===true,requestId=metadata.requestId;
  if(action==='publish'&&typeof requestId==='string'&&requestId){
   const pending=this.pendingPublication(requestId);
   if(pending){
    const saved=this.db.prepare("SELECT payload FROM tieba_operations WHERE action='publish' AND state IN ('queued','running','cleaning') AND json_extract(metadata,'$.requestId')=? ORDER BY created,rowid LIMIT 1").get(requestId);
    if(options.payload&&saved?.payload&&saved.payload!==JSON.stringify(options.payload))throw new FishError('TIEBA_REQUEST_ID_REUSED');
    return Promise.resolve({...pending,reused:true});
   }
  }
  if(nonBlocking){
   if(typeof requestId!=='string'||!requestId)throw new FishError('TIEBA_REQUEST_ID_INVALID');
   // A detached caller cannot supply the intent again after a worker restart.
   if(!options.payload)throw new FishError('TIEBA_INPUT_INVALID');
   const finished=this.db.prepare(`SELECT metadata,result,state FROM tieba_operations WHERE ${publicationStep} AND action='publish' AND ${operationRequest}=? AND state IN ('done','interrupted') ORDER BY created DESC,rowid DESC LIMIT 1`).get(requestId) as Pick<Row,'metadata'|'result'|'state'>|undefined;
   if(finished){
    const prior=parse(finished.metadata)??{};
    delete prior.executionLimitMs;
    if(JSON.stringify(prior)!==JSON.stringify(metadata))throw new FishError('TIEBA_REQUEST_ID_REUSED');
    const hasJournal=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tieba_actions'").get();
    const report=(hasJournal?parse((this.db.prepare('SELECT result FROM tieba_actions WHERE id=?').get(requestId) as {result:string}|undefined)?.result??null):undefined)
     ??this.publicationFallback(requestId)??parse(finished.result);
    const status=report?.deliveryStatus??(report?.publicVerified||report?.published?'confirmed':report?.submitted?'accepted':'unconfirmed');
    return Promise.resolve({...report,requestId,deliveryStatus:status,reused:true,retryScheduled:false});
   }
  }
  if(options.key&&this.shared.has(options.key))return this.shared.get(options.key)!;
  const queued=nonBlocking&&(!!this.running||this.jobs.length>0||this.now()<this.nextPublishAt);
  const id=randomUUID();this.db.prepare("INSERT INTO tieba_operations(id,action,state,created,metadata,payload) VALUES (?,?,'queued',?,?,?)").run(id,action,this.now(),JSON.stringify(metadata),options.payload?JSON.stringify(options.payload):null);
  const promise=this.schedule(id,action,work,options.key);
  if(queued){void promise.catch(()=>{});return Promise.resolve(this.pendingPublication(requestId as string));}
  return promise;
 }
 /** Read active intent directly from the journal, without waiting for a browser
  * slot or requiring a tieba_actions receipt that does not exist yet. */
 pendingPublication(requestId:string){
  const row=this.db.prepare(`SELECT * FROM tieba_operations WHERE action IN ('publish','publication-submit') AND state IN ('queued','running','cleaning') AND ${operationRequest}=? ORDER BY created,rowid LIMIT 1`).get(requestId) as Row|undefined;
  if(!row)return undefined;
  const state=row.state==='queued'?'queued':'running',position=state==='queued'?this.publishPosition(row):{queuePosition:0,scheduledAt:null};
  return {requestId,action:row.action,state,queued:state==='queued',deliveryStatus:state,submissionStatus:state,...position,retryScheduled:false,
   ...(state==='queued'?{submitted:false,published:false,notice:QUEUED_PUBLICATION_NOTICE}:{notice:'这次贴吧发言正在后台处理，无需重复提交；稍后可用 check_tieba_publication({requestId}) 查真实回执。'})};
 }
 publicationQueue(){
  const rows=this.db.prepare("SELECT * FROM tieba_operations WHERE action IN ('publish','publication-submit') AND state IN ('queued','running','cleaning') ORDER BY created,rowid").all() as Row[];
  let position=0;
  const active=rows.map(row=>{
   const meta=parse(row.metadata),queued=row.state==='queued';
   return {id:row.id,action:row.action,state:row.state,createdAt:row.created,startedAt:row.started,
    ...(queued?{queuePosition:++position,scheduledAt:this.estimatedSlot(position)}:{}),
    metadata:{action:meta?.action,replyScope:meta?.replyScope,title:meta?.title,threadId:meta?.threadId,content:typeof meta?.content==='string'?meta.content.slice(0,240):undefined}};
  });
  return {at:this.now(),publishPacing:this.publishPacing(),workerBusy:!!this.running,
   counts:{queued:position,running:active.length-position},active};
 }
 publicationFallback(requestId:string){
  const hasJournal=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tieba_actions'").get();
  if(hasJournal&&this.db.prepare('SELECT 1 FROM tieba_actions WHERE id=?').get(requestId))return;
  const row=this.db.prepare(`SELECT state,result FROM tieba_operations WHERE ${publicationStep} AND action='publish' AND ${operationRequest}=? AND state IN ('done','interrupted') ORDER BY created DESC,rowid DESC LIMIT 1`).get(requestId);
  const result=parse(typeof row?.result==='string'?row.result:null);
  if(!result?.error)return;
  const detail=result.feedback??result.diagnostic?.provider;
  const uncertain=row?.state==='interrupted'||result.outcome==='timeout'&&detail?.requestSent!==false;
  return {...result,...detail,requestId,queued:false,state:row?.state,deliveryStatus:detail?.deliveryStatus??(uncertain?'unconfirmed':'failed'),
   submitted:result.submitted??(uncertain?null:false),published:result.published??false,retryScheduled:false};
 }
 private estimatedSlot(position:number){
  const estimate=Math.round(this.publishIntervalMs+(this.publishMaxIntervalMs-this.publishIntervalMs)/2);
  const earliest=this.now()+(this.running&&publishAction(this.running.action)?estimate:0);
  return Math.max(earliest,this.nextPublishAt)+(position-1)*estimate;
 }
 private publishPosition(row:Row){
  const {position}=this.db.prepare("SELECT count(*) AS position FROM tieba_operations WHERE state='queued' AND action IN ('publish','publication-submit') AND (created<? OR (created=? AND rowid<=(SELECT rowid FROM tieba_operations WHERE id=?)))").get(row.created,row.created,row.id) as {position:number};
  // Only the next slot has been sampled. Later slots estimate the midpoint
  // of the window; running work may push these estimates back further.
  return {queuePosition:position,scheduledAt:this.estimatedSlot(position)};
 }
 private schedule(id:string,action:string,work:(signal:AbortSignal)=>Promise<any>,key?:string){
  const promise=new Promise<any>((resolve,reject)=>this.jobs.push({id,action,key,work,resolve,reject}));
  if(key){this.shared.set(key,promise);void promise.finally(()=>this.shared.delete(key)).catch(()=>{});}
  queueMicrotask(()=>void this.pump().catch(()=>{}));return promise;
 }
 private async pump(){
  if(this.running||this.stopping)return;
  this.clearPaceTimer();
  const at=this.now(),index=this.jobs.findIndex(job=>!publishAction(job.action)||at>=this.nextPublishAt);
  if(index<0){
   if(this.jobs.length){this.paceTimer=setTimeout(()=>{this.paceTimer=undefined;void this.pump().catch(()=>{});},Math.max(10,this.nextPublishAt-at));this.paceTimer.unref();}
   return;
  }
  const [job]=this.jobs.splice(index,1);this.running=job;
  const row=this.db.prepare('SELECT action,metadata FROM tieba_operations WHERE id=?').get(job.id) as {action:string;metadata:string};
  const startedAt=this.now(),limitMs=executionLimit(row.action,parse(row.metadata)?.publicationInput===true),controller=new AbortController();let timer:NodeJS.Timeout|undefined;
  this.db.prepare("UPDATE tieba_operations SET state='running',started=?,metadata=? WHERE id=?").run(startedAt,JSON.stringify({...parse(row.metadata),executionLimitMs:limitMs}),job.id);
  // Capture late resolution/rejection, but never let it advance the queue.
  const settled=Promise.resolve().then(()=>job.work(controller.signal)).then(value=>({kind:'value' as const,value}),error=>({kind:'error' as const,error}));
  try{
   const completed=await Promise.race([settled,new Promise<{kind:'timeout'}>(resolve=>{timer=setTimeout(()=>resolve({kind:'timeout'}),limitMs);timer.unref();})]);clearTimeout(timer);
   const underlying=completed.kind==='error'?codeOf(completed.error):completed.kind==='value'?outcome(row.action,completed.value).error:undefined;
   if(completed.kind==='timeout'||['TIEBA_BROWSER_COMMAND_TIMEOUT','TIEBA_READ_TIMEOUT'].includes(underlying??'')){
    const reason=completed.kind==='timeout'?'TIEBA_QUEUE_EXECUTION_TIMEOUT':underlying!,error=new FishError(reason),phase=completed.kind==='error'?(completed.error as any)?.timeoutPhase??this.lifecycle.describe():this.lifecycle.describe();
    const timeout:any={limitMs,startedAt,deadlineAt:startedAt+limitMs,timedOutAt:this.now(),reason,...(completed.kind!=='timeout'?{subLimitMs:20000}:{}),phase:{...phase,operation:phase.operation||row.action},cleanup:{state:'cleaning',limitMs:CLEANUP_LIMIT_MS}};
    const metadata=parse(row.metadata),result:any={outcome:'timeout',error:error.code,requestId:metadata?.requestId,timeout,notice:'本地任务执行超时，正在中止操作；不代表贴吧拒绝，未自动重发。'};
    this.db.prepare("UPDATE tieba_operations SET state='cleaning',result=? WHERE id=?").run(JSON.stringify(result),job.id);
    controller.abort(error);
    const cleanup=Promise.resolve().then(()=>this.lifecycle.cancel()).then(()=>({ok:true as const}),e=>({ok:false as const,error:codeOf(e)}));
    let cleanupTimer:NodeJS.Timeout|undefined;
    const stopped=await Promise.race([Promise.all([settled,cleanup]).then(([operation,cleaned])=>({operation,cleaned})),new Promise<null>(resolve=>{cleanupTimer=setTimeout(()=>resolve(null),CLEANUP_LIMIT_MS);cleanupTimer.unref();})]);clearTimeout(cleanupTimer);
    timeout.cleanup={state:stopped?.cleaned.ok?'stopped':'restart_required',finishedAt:this.now(),limitMs:CLEANUP_LIMIT_MS,...(stopped&&!stopped.cleaned.ok?{error:stopped.cleaned.error}:{}),operationSettled:!!stopped};
    result.notice=stopped?.cleaned.ok?'执行超时，当前操作和浏览器已停止，后续队列继续；发言以原回执为准，未自动重发。':'执行超时且未能在30秒内确认清理完成，工作进程将自动重启；未开始的发言保留，结果不明的请求不自动重发。';
    if(stopped?.operation.kind==='value')result.lastResult=outcome(row.action,stopped.operation.value);
    const last=result.lastResult,receipt=last?.receipt;
    const details:Record<string,unknown>={stage:phase.stage??row.action,operation:row.action,requestId:metadata?.requestId,limitMs,elapsedMs:timeout.timedOutAt-startedAt,cleanupState:timeout.cleanup.state};
    if(['publish','publication-submit','moderator'].includes(row.action)){
     const attempts=receipt?.httpAttempts??phase.httpAttempts,accepted=last?.submitted===true||receipt?.accepted===true;
     const counter=receipt?.requestCounterSource==='native_publish_interception'||phase.monitored===true&&metadata?.requestId&&phase.monitoredRequestId===metadata.requestId;
     const before=!accepted&&(receipt?.notSubmitted===true||counter&&attempts===0&&!!stopped?.cleaned.ok);
     const refused=!before&&!accepted&&receipt?.accepted===false&&attempts>0&&['failed','challenge'].includes(last?.outcome);
     Object.assign(details,{submissionStatus:accepted?'accepted':before?'not_submitted':refused?'rejected':counter&&attempts>0?'submitted_unconfirmed':'unknown',
      deliveryStatus:last?.publicVerified?'confirmed':accepted?'accepted':before||refused?'failed':'unconfirmed',requestSent:before?false:accepted||refused||counter&&attempts>0?true:null,postId:last?.id,
      ...(counter?{httpAttempts:attempts,responseReceived:phase.responseReceived}:{}),providerCode:receipt?.errorCode});
    }
    const finalOperation=stopped?.operation??completed;
    if(publishAction(row.action)&&livePublish(finalOperation.kind==='value'?finalOperation.value:undefined,finalOperation.kind==='error'?finalOperation.error:undefined))this.advancePublishPacing();
    result.feedback=details;this.finish(job.id,result);job.reject(new ProviderError(reason,details));
    if(!stopped?.cleaned.ok){this.stopping=true;this.lifecycle.restart();}
   }else if(completed.kind==='error'){if(publishAction(row.action)&&livePublish(undefined,completed.error))this.advancePublishPacing();this.finish(job.id,outcome(row.action,null,completed.error));job.reject(completed.error);}
   else{if(publishAction(row.action)&&livePublish(completed.value))this.advancePublishPacing();this.finish(job.id,outcome(row.action,completed.value));job.resolve(completed.value);}
  }catch(e){this.finish(job.id,outcome(row.action,null,e));job.reject(e);}
  finally{clearTimeout(timer);this.running=undefined;for(const done of this.drainWaiters.splice(0))done();queueMicrotask(()=>void this.pump().catch(()=>{}));}
 }
 private advancePublishPacing(){
  const sample=this.random(),fraction=Number.isNaN(sample)?0:Math.max(0,Math.min(1,sample));
  const delay=Math.round(this.publishIntervalMs+(this.publishMaxIntervalMs-this.publishIntervalMs)*fraction);
  this.nextPublishAt=Math.max(this.nextPublishAt,this.now()+delay);
  this.db.prepare("INSERT INTO tieba_queue_meta(key,value) VALUES ('next_publish_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(this.nextPublishAt));
 }
 private clearPaceTimer(){clearTimeout(this.paceTimer);this.paceTimer=undefined;}
 private publishPacing(){return {intervalMs:this.publishIntervalMs,maxIntervalMs:this.publishMaxIntervalMs,nextPublishAt:this.nextPublishAt>this.now()?this.nextPublishAt:null};}
 private item(row:Row){
  const position=row.state==='queued'&&publishAction(row.action)?this.publishPosition(row):null;
  return {...operationItem(row),queuePosition:position?.queuePosition??null,scheduledAt:position?.scheduledAt??null};
 }
 private finish(id:string,result:unknown){this.db.prepare("UPDATE tieba_operations SET state='done',finished=?,payload=NULL,result=? WHERE id=?").run(this.now(),JSON.stringify(result),id);this.prune();}
 snapshot(offset=0,activeOnly=false,replies=false,selectedId?:string){
  if(replies)return this.replySnapshot(offset,activeOnly,selectedId);
  const limit=20;
  const active=(this.db.prepare("SELECT * FROM tieba_operations WHERE state IN ('queued','running','cleaning') ORDER BY created,rowid LIMIT 100").all() as Row[]).map(row=>this.item(row));
  const counts=Object.fromEntries((this.db.prepare('SELECT state,count(*) AS count FROM tieba_operations GROUP BY state').all() as {state:string;count:number}[]).map(r=>[r.state,r.count]));
  const completed=activeOnly?[]:(this.db.prepare("SELECT * FROM tieba_operations WHERE state NOT IN ('queued','running','cleaning') ORDER BY finished DESC,rowid DESC LIMIT ? OFFSET ?").all(limit,offset) as Row[]).map(row=>this.item(row));
  // Resolve only already-saved delivery evidence, without opening a browser.
  const hasActions=this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tieba_actions'").get();
  if(hasActions)for(const item of [...active,...completed]){if(!['publish','publication-submit','publication-check','verify'].includes(item.action))continue;const id=item.result?.requestId??item.metadata?.requestId;if(!id)continue;const saved=this.db.prepare('SELECT result FROM tieba_actions WHERE id=?').get(id) as {result:string}|undefined;if(saved){const delivery=outcome('publish',parse(saved.result));item.result=item.result?.timeout?{...delivery,...item.result,delivery}:{...item.result,...delivery};}}
  const total=(counts.done??0)+(counts.interrupted??0);
  return {at:this.now(),publishPacing:this.publishPacing(),counts:{queued:counts.queued??0,running:(counts.running??0)+(counts.cleaning??0),completed:total},active,completed,offset,limit,hasMore:!activeOnly&&offset+completed.length<total};
 }
 private replySnapshot(offset:number,activeOnly:boolean,selectedId?:string){
  const hasJournal=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='tieba_actions'").get();
  // Page the lightweight IDs first. Read receipts and full bodies only for rows actually shown.
  const rows=new Map<string,{id:string;created:number;active:boolean;running:boolean;reply:boolean}>();
  if(hasJournal){
   for(const row of this.db.prepare("SELECT id,created FROM tieba_actions WHERE json_extract(request,'$.action') IN ('comment','reply')").all() as {id:string;created:number}[])
    rows.set(row.id,{...row,reply:true,active:false,running:false});
  }
  for(const op of this.db.prepare(`SELECT ${operationRequest} AS id,created,state,json_extract(metadata,'$.action') AS kind FROM tieba_operations WHERE ${publicationStep} ORDER BY created`).all() as {id:string;created:number;state:string;kind:string}[]){
   if(!op.id)continue;
   const row=rows.get(op.id)??{id:op.id,created:op.created,reply:false,active:false,running:false};
   row.reply ||= replyAction(op.kind);
   row.active ||= activeState(op.state);
   row.running ||= op.state==='running'||op.state==='cleaning';
   rows.set(op.id,row);
  }
  const ordered=[...rows.values()].filter(row=>row.reply).sort((a,b)=>b.created-a.created||a.id.localeCompare(b.id));
  const pending=ordered.filter(row=>row.active),finished=ordered.filter(row=>!row.active);
  const steps=this.db.prepare(`SELECT * FROM tieba_operations WHERE ${publicationStep} AND ${operationRequest}=? ORDER BY created,rowid`);
  const journal=hasJournal?this.db.prepare('SELECT request,result,state FROM tieba_actions WHERE id=?'):undefined;
  const describe=(row:typeof ordered[number])=>{
   const items=(steps.all(row.id) as Row[]).map(row=>this.item(row));
   const saved=journal?.get(row.id) as {request:string;result:string|null;state:string}|undefined;
   const original=items.find(i=>i.action==='publish');
   const item=items.findLast(i=>i.state==='running'||i.state==='cleaning')??items.find(i=>i.state==='queued')??items.at(-1);
   const delivery=saved?outcome('publish',parse(saved.result)):undefined;
   const result=item?.result?.timeout?{...delivery,...item.result,delivery}:{...item?.result,...delivery};
   if(saved?.state==='held'&&!row.active&&result.outcome==='done')result.outcome='unknown';
   return {...item,id:row.id,action:'publish',state:item?.state??'done',createdAt:original?.createdAt??row.created,
    metadata:{...(original?original.metadata:{source:'publication_history'}),...parse(saved?.request??null),requestId:row.id},
    result,canVerify:!!saved&&!['preview','held','rejected'].includes(saved.state),
    steps:items.map(({action,state,createdAt,finishedAt,result})=>({action,state,createdAt,finishedAt,outcome:result?.outcome,error:result?.error}))};
  };
  const limit=20,active=pending.map(describe),completed=activeOnly?[]:finished.slice(offset,offset+limit).map(describe);
  const selected=selectedId?rows.get(selectedId):undefined;
  const workerBusy=!!this.db.prepare("SELECT 1 FROM tieba_operations WHERE state='queued' OR state IN ('running','cleaning') AND action NOT IN ('frame','publication-frame') LIMIT 1").get();
  return {view:'replies',at:this.now(),publishPacing:this.publishPacing(),workerBusy,counts:{queued:active.filter(item=>item.state==='queued').length,
   running:active.filter(item=>item.state!=='queued').length,completed:finished.length},
   active,completed,selected:selected?.reply?active.find(i=>i.id===selectedId)??completed.find(i=>i.id===selectedId)??describe(selected):undefined,offset,limit,hasMore:!activeOnly&&offset+completed.length<finished.length};
 }
 stop(){this.stopping=true;this.clearPaceTimer();}
 async drained(){if(this.running)await new Promise<void>(resolve=>this.drainWaiters.push(resolve));}
 close(){this.stop();this.db.close();}
}
