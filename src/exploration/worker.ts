import fs from 'node:fs';
import {makeDir,safePath,writePrivateAtomic} from '../paths.js';
import {BudgetedModel,inputBound,modelPayload} from '../agent/model.js';
import {traceModel} from '../agent/model-trace.js';
import {diagnosticSafe,errorDiagnostic} from '../diagnostics.js';
import {TurnContext,contextMetrics} from '../agent/context.js';
import {appearancePrompt} from '../character.js';
import {explorationPrompt,explorationContinuation} from './prompt.js';
import {newsMemory} from '../qq/daily-news.js';
import {qqResources} from '../qq/resources.js';
import {FishError,codeOf,type ChatMessage} from '../types.js';
import {hasToolMarkup} from '../agent/tool-protocol.js';
import {ExplorationState,type ExplorationRun} from './state.js';
import {ExplorationTools,type ExplorationServices} from './tools.js';

export function explorationRead(root:string,state:ExplorationState,id:unknown,offset=0,owner?:string,query=''){
 if(id===undefined)return state.history(query,offset,owner);
 if(typeof id!=='string'||!/^[-a-f0-9]{36}$/.test(id)||!Number.isSafeInteger(offset)||offset<0)throw new FishError('INVALID_TOOL_ARGS');
 const row=state.get(id);if(owner&&row.owner!==owner)throw new FishError('CONVERSATION_NOT_ALLOWED');
 const file=safePath(root,'runtime/logs/exploration/'+id+'.json');if(!fs.existsSync(file))return {run:row,trace:[],...state.observations(id,offset),notice:'详细过程已过日志保留期或尚未开始；经历索引、来源和好奇心日志独立保留。'};
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.nlink!==1||stat.size>9*1024*1024)throw new FishError('EXPLORATION_LOG_INVALID');
 const log=JSON.parse(fs.readFileSync(file,'utf8')),page=log.trace.slice(offset,offset+10);
 // The owner UI can inspect diagnostics; model recall only receives experiences.
 const trace=owner?page.map(({request,diagnostic,diagnostics,providerResponse,...entry}:any)=>entry):page;
 return {run:row,trace,offset,nextOffset:offset+trace.length<log.trace.length?offset+trace.length:null};
}
export class ExplorationWorker{
 private timer?:NodeJS.Timeout;private active?:{id:string;lock:string;controller:AbortController;promise:Promise<void>};private stopped=true;private polling=false;
 constructor(readonly state:ExplorationState,private model:Pick<BudgetedModel,'complete'>,private services:Omit<ExplorationServices,'state'|'readRun'>,private now=Date.now){}
 start(){if(!this.stopped)return;this.stopped=false;void this.poll();}
 private async poll(){if(this.stopped)return;try{await this.tick();}catch(e){this.state.store.setMeta('exploration:worker',JSON.stringify({at:this.now(),state:'error',error:codeOf(e),diagnostic:errorDiagnostic(e)}));}finally{if(!this.stopped){this.timer=setTimeout(()=>void this.poll(),1000);this.timer.unref();}}}
 async tick(){
  if(this.polling)return;this.polling=true;
  try{
   this.state.store.setMeta('exploration:worker',JSON.stringify({at:this.now(),state:this.active?'running':'idle'}));
   this.state.check();
   if(this.active){try{this.state.heartbeat(this.active.id,this.active.lock);}catch{this.active.controller.abort();}return;}
   const run=this.state.claim();if(!run)return;
   const controller=new AbortController(),promise=this.execute(run,controller).catch(e=>{this.state.finish(run.id,run.lock!,'failed',codeOf(e));this.state.store.audit('exploration-error','private:'+run.owner,JSON.stringify(errorDiagnostic(e)));});
   this.active={id:run.id,lock:run.lock!,controller,promise};void promise.finally(()=>{if(this.active?.id===run.id)this.active=undefined;}).catch(()=>{});
  }finally{this.polling=false;}
 }
 async idle(){await this.active?.promise;}
 async stop(){this.stopped=true;clearTimeout(this.timer);this.active?.controller.abort();await this.idle();}
 private prune(){
  const dir=makeDir(this.services.root,'runtime/logs/exploration');const files=fs.readdirSync(dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(name=>({name,stat:fs.lstatSync(safePath(dir,name))})).filter(f=>f.stat.isFile()&&f.stat.nlink===1).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
  let kept=0;for(const f of files){kept+=f.stat.size;if(kept>128*1024*1024||f.stat.mtimeMs<this.now()-90*86400000)fs.unlinkSync(safePath(dir,f.name));}
 }
 private async execute(run:ExplorationRun,controller:AbortController){
  const {root,cfg,ledger}=this.services,started=this.now(),trace:any[]=[],context=new TurnContext();let round=0,step=0,tokens=0,textOnly=0,note='',state='completed',error:string|null=null;
  const services={...this.services,state:this.state,readRun:(id:string|undefined,offset:number,query?:string)=>explorationRead(root,this.state,id,offset,run.owner,query)};
  const capabilities=new ExplorationTools(services,run,context,controller.signal),seen=new Set<string>();
  const group='private:'+run.owner;
  const background={kind:'自主探索',now:new Date(started).toISOString(),owner:run.owner,delivery:{recipient:run.owner,transport:this.services.transport.status},character:{appearance:appearancePrompt(root),referenceId:'character'},
   curiosity:this.state.journal().entries?.slice(0,5).map(e=>({id:e.id,title:e.title,preview:e.preview.slice(0,200),version:e.version})),recent:newsMemory(this.state.store,run.owner).recent,
   previous:this.state.status().recent.filter((r:any)=>r.id!==run.id&&r.owner===run.owner).slice(0,3).map((r:any)=>({id:r.id,state:r.state,at:r.created,note:r.note?.slice(0,500)})),...qqResources(cfg(),ledger,group,'exploration')};
  const messages:ChatMessage[]=[{role:'system',content:explorationPrompt(root)},{role:'system',content:JSON.stringify(background)},{role:'user',content:run.trigger==='manual'&&run.instruction?run.instruction:'你醒了一会儿，现在是自己的时间。'}];
  const logPath='runtime/logs/exploration/'+run.id+'.json';makeDir(root,'runtime/logs/exploration');
  const save=()=>{
   const log=JSON.stringify(diagnosticSafe({id:run.id,request:run.trigger==='manual'?(run.instruction??'手动唤醒 · 自主探索'):'随机刻 · 自主探索',conversation:group,startedAt:started,finishedAt:state==='running'?undefined:this.now(),state,note,inputContext:background,trace}));
   if(Buffer.byteLength(log)>8*1024*1024)throw new FishError('EXPLORATION_TRACE_STORAGE_LIMIT');writePrivateAtomic(root,logPath,log);
  };
  const heartbeat=setInterval(()=>{try{this.state.heartbeat(run.id,run.lock!);const settings=this.state.settings();if(this.now()-started>=settings.maxRunMinutes*60000)controller.abort(new FishError('EXPLORATION_TIME_BUDGET'));}catch(e){controller.abort(e);}},1000);heartbeat.unref();
  try{
   this.prune();state='running';save();
   for(;;round++){
    controller.signal.throwIfAborted();this.state.guard(run.id,run.lock!);const settings=this.state.settings();
    if(this.now()-started>=settings.maxRunMinutes*60000)throw new FishError('EXPLORATION_TIME_BUDGET');
    context.compact(round);messages[0]={role:'system',content:explorationPrompt(root)};const offered=capabilities.available();
    if(contextMetrics(messages,offered).totalTextTokens>24000){
      const boundaries=messages.map((m,i)=>m.role==='assistant'?i:-1).filter(i=>i>=3);
      if(boundaries.length>8){const cut=boundaries[boundaries.length-8];messages.splice(3,cut-3);messages[1]={role:'system',content:JSON.stringify({...background,earlierActions:{runId:run.id,readWith:'read_exploration'}})};trace.push({contextCompacted:true,round});}
    }
    const bound=inputBound(messages,offered)+cfg().maxOutputTokens;if(settings.runTokens&&tokens+bound>settings.runTokens)throw new FishError('EXPLORATION_TOKEN_BUDGET');
    trace.push({round,contextInput:contextMetrics(messages,offered)});
    let response;
    try{response=await traceModel(trace,save,modelPayload(cfg(),messages,cfg().maxOutputTokens,{tools:offered}),round,onReservation=>this.model.complete(group,'exploration',messages,{tools:offered,signal:controller.signal,onReservation}));}
    catch(e){
      const record=trace.at(-1),usage=record?.usage,reservation=record?.reservation;
      if(usage)tokens+=usage.input+usage.output;
      if(reservation?.state==='unknown')this.state.store.db.prepare('UPDATE exploration_runs SET unknown_tokens=unknown_tokens+? WHERE id=? AND lock=?').run(reservation.reservedTokens,run.id,run.lock!);
      throw e;
    }
    tokens+=response.usage.input+response.usage.output;this.state.store.db.prepare('UPDATE exploration_runs SET tokens=? WHERE id=? AND lock=?').run(tokens,run.id,run.lock!);
    save();
    controller.signal.throwIfAborted();this.state.guard(run.id,run.lock!);
    if(!response.tool_calls?.length){
      if(hasToolMarkup(response.text))throw new FishError('DEEPSEEK_TOOL_PROTOCOL_INVALID');
      note=response.text.slice(0,4000);
      // A completion's stop is not an agent decision to end its session. Keep
      // the actual assistant turn; the continuation is runtime data, not a user.
      // Two protocol repair opportunities bound empty chatter, not exploration.
      if(++textOnly>2)throw new FishError('EXPLORATION_DECISION_STALLED');
      messages.push({role:'assistant',content:response.text},{role:'system',content:explorationContinuation});
      trace.push({round,continuation:{reason:'text_without_action',attempt:textOnly,content:explorationContinuation}});save();continue;
    }
    textOnly=0;
    messages.push({role:'assistant',content:hasToolMarkup(response.text)?'':response.text,tool_calls:response.tool_calls});
    let finished=false;
    for(const call of response.tool_calls){
      controller.signal.throwIfAborted();this.state.guard(run.id,run.lock!);
      let result:any,args:any,parts:any[]=[];const startedAt=this.now();let diagnostic;
      try{
        if(seen.has(call.id))throw new FishError('DUPLICATE_TOOL_CALL');seen.add(call.id);
        args=JSON.parse(call.function.arguments);const action=await capabilities.execute(call.function.name,args,call.id);result=action.result;parts=action.parts??[];
        if(action.finish){finished=true;note=result.note??'';}
      }catch(e){result={error:e instanceof SyntaxError?'INVALID_TOOL_JSON':codeOf(e)};diagnostic=errorDiagnostic(e);}
      this.state.observation(run.id,step++,call.function.name,args??{},result);
      trace.push({tool:call.function.name,callId:call.id,result,startedAt,finishedAt:this.now(),diagnostic,diagnostics:capabilities.takeDiagnostics()});messages.push(context.result(call.function.name,call.id,result,round,parts));save();
      if(finished)break;
    }
    if(finished)break;
   }
  }catch(e){error=codeOf(e);if(controller.signal.aborted)error=controller.signal.reason instanceof FishError?controller.signal.reason.code:'EXPLORATION_CANCELLED';state=error.includes('BUDGET')||error==='EXPLORATION_DECISION_STALLED'?'paused':error==='EXPLORATION_CANCELLED'?'cancelled':'failed';trace.push({error,phase:'run',diagnostic:errorDiagnostic(e),at:this.now()});}
  finally{
   clearInterval(heartbeat);if(state==='running')state='completed';
   this.state.store.db.prepare('UPDATE exploration_runs SET tokens=? WHERE id=? AND lock=?').run(tokens,run.id,run.lock!);
   this.state.finish(run.id,run.lock!,state,error,note);
   try{save();}catch(e){this.state.store.audit('exploration-log',group,JSON.stringify(errorDiagnostic(e)));}
  }
 }
}
