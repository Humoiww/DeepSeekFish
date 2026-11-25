import {qqAccess,type QQAccess} from '../qq/activity-receipt.js';
import {actionState} from '../agent/tool-feedback.js';
import {generatedImage} from '../image/generated.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store,redact } from '../storage/db.js';
import { FishError,type Usage } from '../types.js';
import { inputCache } from '../usage.js';
import { MAX_IMAGE_BYTES } from '../image/limits.js';
import { makeDir,safePath,writePrivateAtomic } from '../paths.js';
import {diagnosticSafe} from '../diagnostics.js';
import {developmentActivityFolder} from '../development/activity.js';
import type {CorpusLike} from '../memory/corpus.js';

export type ActivityKind='qq'|'web'|'news'|'memory'|'diary'|'image'|'audit'|'exploration'|'development'|'chain';
type Step={type:string;name:string;state?:string;at?:number;durationMs?:number;request?:any;diagnostic?:any;args?:unknown;result?:any;qqAccess?:QQAccess;usage?:Usage;callId?:string;round?:number;phases?:unknown[];modelCall?:number;decision?:{call:number;usage?:Usage;actions:string[]}};
type UsageSummary={input:number;output:number;total:number;calls:number;known:boolean;cachedInput:number;uncachedInput:number;cacheKnownCalls:number;cacheUnknownInput:number;unreportedCalls:number;unconfirmedTokens:number};
type RecordItem={id:string;kind:ActivityKind;title:string;conversation:string;speaker:string;at:number;updated:number;durationMs:number|null;state:string;usage:UsageSummary;counts:{tools:number;search:number;fetch:number;browse:number;downloads:number;images:number;sends:number};qqAccess:number;reply:string;errors:number;events:Step[];related:string[];raw:unknown};
type ActivitySummary=Omit<RecordItem,'events'|'raw'>;
type IndexedSummary={stamp:string;summary:ActivitySummary};
type DevelopmentStatus={id:string;updatedAt:number;phase:string;goal:string;reason?:string;report?:string;rounds:number;codexStep?:string;codexUpdatedAt?:number};
const logFolders={qq:'runtime/logs/qq',news:'runtime/logs/daily-news',memory:'runtime/logs/daily-news',
  diary:'runtime/logs/daily-qzone',image:'runtime/logs/codex',exploration:'runtime/logs/exploration',development:developmentActivityFolder} as const;
const summaryFile='runtime/cache/activity-summaries-v1.json';
const maxLogBytes=16*1024*1024;
const kinds=new Set(['qq','web','news','memory','diary','image','audit','exploration','development','chain','qq_access']);
const isMemoryLog=(name:string)=>name.startsWith('memory-')||name.startsWith('curiosity-')||name.startsWith('corpus-');
const secret=/^(?:authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|skey|p_skey|rkey)$/i;
/** Log data is display-only. Never expose credentials, signed media handles or inline binaries. */
export function activitySafe(value:any,root='',depth=0):any{
  if(depth===0)value=diagnosticSafe(value);
  if(depth>24)return '[层级过深，已省略]';
  if(typeof value==='string'){
    let text=redact(value).replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g,'[图片数据省略]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[凭据省略]')
      .replace(/((?:cookie|set-cookie|refresh_token|id_token|skey|p_skey|rkey)\s*[=:]\s*)[^\s"'<>]+/gi,'$1[凭据省略]')
      .replace(/([?&](?:rkey|skey|p_skey|access_token|token|signature|sig)=)[^&\s"<>]+/gi,'$1[凭据省略]')
      .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|authorization|cookie)"\s*:\s*")[^"]*/gi,'$1[凭据省略]');
    if(root)text=text.split(root+'/').join('');return text;
  }
  if(Array.isArray(value))return value.map(v=>activitySafe(v,root,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,secret.test(k)?'[凭据省略]':k==='data'&&typeof v==='string'&&v.length>1024?'[二进制数据省略]':activitySafe(v,root,depth+1)]));
  return value;
}
const obj=(v:any)=>{if(typeof v==='string'){try{return JSON.parse(v);}catch{}}return v;};
const finite=(v:any)=>Number.isFinite(Number(v))?Number(v):0;
const time=(v:any)=>typeof v==='string'?Date.parse(v)||0:finite(v);
const resultState=(v:any)=>actionState(obj(v));
function base(id:string,kind:ActivityKind,d:any,mtime:number):RecordItem{
  const at=time(d.startedAt??d.created??d.inputContext?.context?.currentTurn?.at??d.at??d.updated)||mtime;
  return {id,kind,title:'',conversation:d.conversation??'',speaker:d.inputContext?.context?.qqIdentity?.speaker??'',at,updated:time(d.finishedAt??d.updated??d.at)||mtime,durationMs:d.finishedAt&&d.startedAt?Math.max(0,d.finishedAt-d.startedAt):null,state:'unknown',usage:{input:0,output:0,total:0,calls:0,known:false,cachedInput:0,uncachedInput:0,cacheKnownCalls:0,cacheUnknownInput:0,unreportedCalls:0,unconfirmedTokens:0},counts:{tools:0,search:0,fetch:0,browse:0,downloads:0,images:0,sends:0},qqAccess:0,reply:'',errors:0,events:[],related:[],raw:d};
}
function addUsage(r:RecordItem,usage:any):Usage|undefined{
  r.usage.calls++;
  if(!usage||!Number.isSafeInteger(usage.input)||usage.input<0||!Number.isSafeInteger(usage.output)||usage.output<0){r.usage.unreportedCalls++;return;}
  const cache=inputCache(usage.input,usage.cachedInput,usage.uncachedInput);
  r.usage.input+=usage.input;r.usage.output+=usage.output;r.usage.total+=usage.input+usage.output;r.usage.known=true;
  if(cache.cachedInput!==undefined&&cache.uncachedInput!==undefined){r.usage.cachedInput+=cache.cachedInput;r.usage.uncachedInput+=cache.uncachedInput;r.usage.cacheKnownCalls++;}else r.usage.cacheUnknownInput+=usage.input;
  return {input:usage.input,output:usage.output,...cache};
}
function count(r:RecordItem,name:string){
  r.counts.tools++;
  const key: keyof RecordItem['counts']|undefined=({search_web:'search',fetch_page:'fetch',browse_page:'browse',download_image:'downloads',generate_image:'images',send_image:'sends',send_file:'sends',send_meme:'sends',send_message:'sends',publish_qzone:'sends'} as Record<string,keyof RecordItem['counts']>)[name];
  if(key)r.counts[key]++;
}
function traceRecord(r:RecordItem,trace:any[]){
  let currentModel:Step|undefined;
  const diagnostic=(e:any)=>e.diagnostic??(e.diagnostics?.length?e.diagnostics:undefined)??(e.error==='INTERNAL_ERROR'?{missing:true,message:'旧版本只保存了 INTERNAL_ERROR，没有保留原始异常，无法从该记录恢复具体原因。'}:undefined);
  const recordModel=(e:any,calls:any[])=>{
    currentModel={type:'model',name:e.provider==='opencode_go'?'OpenCode Go':'DeepSeek',modelCall:e.notRequested?undefined:r.usage.calls+1,round:e.round,at:e.startedAt,durationMs:e.durationMs,request:e.request,diagnostic:diagnostic(e),usage:e.notRequested?undefined:addUsage(r,e.usage),state:e.error?'failed':e.state??'completed',result:{text:e.assistant??e.text??'',finishReason:e.finishReason,error:e.error,responseId:e.responseId,billing:e.billing,reservation:e.reservation,notRequested:e.notRequested,provider:e.provider,model:e.model,fallbackFrom:e.fallbackFrom,toolCalls:calls?.map((c:any)=>c.function?.name??c.name)}};
    if(e.reservation?.state==='unknown')r.usage.unconfirmedTokens+=finite(e.reservation.reservedTokens??e.reservation.retainedTokens);
    r.events.push(currentModel);
  };
  for(const e of trace){
    const calls=e.toolCalls??e.tool_calls;
    const isModel=e.kind==='model'||e.name==='model_usage'||e.usage||Array.isArray(calls);
    if(isModel)recordModel(e,calls);
    if(e.contextInput)r.events.push({type:'context',name:'本轮输入规模',round:e.round,result:e.contextInput});
    if(e.continuation)r.events.push({type:'context',name:'探索继续提示',round:e.round,result:e.continuation});
    if(e.name!=='model_usage'&&Array.isArray(calls))for(const c of calls){const name=c.function?.name??'unknown';count(r,name);r.events.push({type:'tool',name,callId:c.id,round:e.round,args:obj(c.function?.arguments),state:'pending',modelCall:currentModel?.modelCall});}
    if(e.tool&&Object.hasOwn(e,'result')){
      let step=r.events.find(s=>s.type==='tool'&&(e.callId?s.callId===e.callId:s.name===e.tool&&s.state==='pending'));
      if(!step){step={type:'tool',name:e.tool};r.events.push(step);count(r,e.tool);}
      step.result=obj(e.result);step.state=resultState(step.result);step.diagnostic=diagnostic(e);step.at=e.startedAt;step.durationMs=e.finishedAt&&e.startedAt?e.finishedAt-e.startedAt:undefined;if(step.state==='failed'||step.state==='partial')r.errors++;
      if(step.name==='reply'&&step.result?.sent===true){r.reply=String((step.args as any)?.text??'');r.state='completed';}
      if(step.result?.imageId)r.related.push('image:'+step.result.imageId);
      if(step.name==='finish_memory'&&step.result?.ok)r.state='completed';
    }else if(e.tool&&e.phase){const step=[...r.events].reverse().find(s=>s.name===e.tool);if(step)(step.phases??=[]).push(e);else r.events.push({type:'phase',name:e.tool,at:e.at,result:e});}
    if(e.draft){r.reply=e.draft.text??'';r.state='completed';const step=r.events.find(s=>s.name==='draft_news'&&s.state==='pending');if(step){step.state='completed';step.result=e.draft;}r.events.push({type:'result',name:'草稿',result:e.draft});}
    if(e.error){
      r.state='failed';
      // A final catch may repeat the model failure; retain raw evidence without
      // presenting the same exception as a second failed action.
      const duplicate=(e.phase==='run'||e.phase==='turn')&&r.events.some(s=>s.result?.error===e.error&&s.state==='failed');
      if(!duplicate){r.errors++;if(!isModel)r.events.push({type:'error',name:String(e.error),state:'failed',round:e.round,diagnostic:diagnostic(e),result:e});}
    }
    if(e.assistant&&!calls?.length&&!e.error)r.reply=e.assistant;
    if(e.name&&e.name!=='model_usage'){
      let step=e.callId?r.events.find(s=>s.type==='tool'&&s.callId===e.callId):undefined;
      if(!step){step={type:'tool',name:e.name};count(r,e.name);r.events.push(step);}
      const state=e.state??resultState(e.result);Object.assign(step,{state,args:e.args,result:obj(e.result),diagnostic:diagnostic(e),round:e.round,callId:e.callId,modelCall:step.modelCall??(e.round===currentModel?.round?currentModel?.modelCall:undefined)});if(state==='failed')r.errors++;
    }
  }
  for(const model of r.events.filter(e=>e.type==='model')){
    const actions=r.events.filter(e=>e.type==='tool'&&e.modelCall===model.modelCall);
    const decision={call:model.modelCall!,usage:model.usage,actions:actions.map(e=>e.name)};
    for(const action of actions)action.decision=decision;
  }
  for(const step of r.events){
    const evidence=qqAccess(step);
    if(evidence){step.qqAccess=evidence;r.qqAccess++;}
  }
  r.related=[...new Set(r.related)];
}
const developmentPhases={code:'开发',candidate:'候选构建',deploy:'部署',live:'上线核对',done:'已完成',blocked:'失败',cancelled:'已停止'} as const;
function developmentRecord(r:RecordItem,d:any){
  const phase=Object.hasOwn(developmentPhases,d.phase)?developmentPhases[d.phase as keyof typeof developmentPhases]:'状态未记录';
  const codex=d.codex??{};
  r.title=d.goal??'开发任务';r.conversation='development';
  r.state=d.phase==='done'?'completed':d.phase==='blocked'?'failed':d.phase==='cancelled'?'cancelled':phase==='状态未记录'?'unknown':'running';
  r.errors=r.state==='failed'?1:0;
  r.reply=d.phase==='code'?(codex.activity?.step??(codex.thread?'已创建 Codex 会话':'等待 Codex 会话')):d.report??d.reason??phase;
  if(d.requests?.length)r.events.push({type:'request',name:'主人原话与肥鱼提交的需求',at:r.at,result:{messages:d.requests,criteria:d.criteria}});
  r.events.push({type:'event',name:'任务阶段 · '+phase,state:r.state,at:r.updated,result:d.reason?{error:d.reason}:undefined});
  const codexState=codex.activity?.step??(codex.turn?'回合状态未记录':codex.thread?'已创建会话，未开始回合':d.requests?'未创建 Codex 会话':'会话明细未记录');
  r.events.push({type:'event',name:'Codex · '+codexState,at:codex.activity?.at,
    result:{model:codex.selection?.model,effort:codex.selection?.effort,threadId:codex.thread,turnId:codex.turn,
      completedRounds:codex.rounds,response:codex.response}});
  if(codex.approvals?.length)r.events.push({type:'event',name:'Codex 自动审批',result:codex.approvals});
  for(const trial of d.trials??[])r.events.push({type:'event',name:trial.kind==='live'?'上线复验':'候选验收',
    state:trial.passed===undefined?'running':trial.passed?'completed':'failed',result:trial});
  if(d.deployment||d.candidate)r.events.push({type:'event',name:'候选与部署版本',result:{candidate:d.candidate,deployment:d.deployment}});
  return r;
}
function parseLog(id:string,kind:ActivityKind,d:any,mtime:number):RecordItem{
  const r=base(id,kind,d,mtime);
  if(kind==='development')return developmentRecord(r,d);
  if(kind==='image'){
    r.title=d.request?.prompt??'Codex 生图';r.reply=d.finalText??'';
    r.state=d.delivery?.ok===false||d.error?'failed':d.delivery?.ok===true?'completed':d.outcome==='running'?'running':'unknown';
    r.events=[{type:'request',name:'生图请求与参考图',result:d.request},...(d.events??[]).map((e:any)=>({type:'event',name:e.method,at:e.at,result:e.detail})),...(d.messages??[]).map((e:any)=>({type:'message',name:'Codex '+(e.phase??''),result:e.text})),{type:'result',name:'生成产物',result:d.images},{type:'delivery',name:'产物校验',result:d.delivery}];
    r.errors=r.state==='failed'?1:0;return r;
  }
  if(kind==='diary'||kind==='news'&&!d.trace){
    r.title=kind==='diary'?'每日空间动态':'早间新闻发送';r.conversation=d.owner?'private:'+d.owner:d.self?'QQ '+d.self:'';
    r.reply=obj(d.draft)?.text??'';r.state=({sent:'completed',published:'completed',completed:'completed',failed:'failed',unknown:'unconfirmed',publishing:'running',sending:'running',running:'running'} as any)[d.state]??'unknown';
    r.events=[{type:'result',name:r.title,result:d}];if(d.image_id)r.related=['image:'+d.image_id];if(d.error)r.errors=1;return r;
  }
  r.title=d.kind==='corpus-extract'?(d.manual?'手动提取语料':d.source==='public'?'公域观察提梗':'QQ 会话提梗'):d.kind==='curiosity-summary'?'会话结束后的好奇心整理'+(d.groupName?' · '+d.groupName:''):kind==='exploration'?String(d.request??'自主探索'):kind==='qq'?String(d.request??'QQ 对话'):kind==='memory'?'后台记忆回顾':'早间新闻检索';
  traceRecord(r,d.trace??[]);if(['running','completed','failed','unconfirmed','paused','cancelled','interrupted'].includes(d.state))
    r.state=kind==='exploration'&&d.state==='paused'?'failed':d.state;
  return r;
}
/** Only receipts for actual replies are eligible; exploratory thoughts, drafts,
 * accepted submissions and uncertain deliveries cannot become liked replies. */
export function corpusTiebaReply(item:any):CorpusLike|undefined{
 const m=item?.metadata??{},r=item?.result??{};
 if(['queued','running','cleaning'].includes(item?.state)||!(r.publicVerified===true||r.visibility==='public'||r.outcome==='public')||m.action==='thread')return;
 const reply=m.content??m.text;if(typeof reply!=='string'||!reply.trim())return;
 return {source_key:'tieba:'+(m.requestId??r.requestId??item.id),platform:'tieba',conversation:'tieba',topic:String(m.title??'贴吧回复').slice(0,300),reply_text:reply};
}
export function corpusReplyCandidates(record:any):CorpusLike[]{
 const found:CorpusLike[]=[];
 if(record.kind==='web'&&record.state==='completed'&&record.reply?.trim())found.push({source_key:record.id,platform:'web',conversation:record.conversation,topic:record.title.slice(0,300),reply_text:record.reply});
 for(const event of record.events??[]){
  const a=event.args??{},r=event.result??{};
  if(event.name==='publish_tieba'&&a.action==='reply'&&(r.publicVerified===true||r.visibility==='public'||r.outcome==='public')){
   const reply=r.content??a.content??a.text;if(typeof reply==='string'&&reply.trim())found.push({source_key:'tieba:'+(r.requestId??a.requestId??record.id+':'+event.callId),platform:'tieba',conversation:'tieba',topic:String(a.title??record.title).slice(0,300),reply_text:reply});
  }else if(['reply','send_message','send_qq_message'].includes(event.name)&&(r.deliveryStatus==='confirmed'||r.sent===true&&r.deliveryStatus===undefined)){
   const reply=r.text??a.text,conversation=r.conversation??record.conversation;
   if(typeof reply==='string'&&reply.trim()&&typeof conversation==='string'&&!conversation.startsWith('web:'))found.push({source_key:record.id+':'+(event.callId??found.length),platform:'qq',conversation,topic:record.title.slice(0,300),reply_text:reply});
  }
 }
 if(record.kind==='qq'&&record.state==='completed'&&record.reply?.trim()&&!found.length&&!(record.events??[]).some((e:any)=>['send_meme','send_file','send_image'].includes(e.name)))
  found.push({source_key:record.id+':reply',platform:'qq',conversation:record.conversation,topic:record.title.slice(0,300),reply_text:record.reply});
 return found;
}
function queryDate(raw:string|null,end=false){
  if(!raw)return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))throw new FishError('ACTIVITY_QUERY_INVALID');
  const v=Date.parse(raw+'T00:00:00+08:00');if(!Number.isFinite(v)||new Date(v+28800000).toISOString().slice(0,10)!==raw)throw new FishError('ACTIVITY_QUERY_INVALID');
  return v+(end?86400000:0);
}

function summarize({events:_events,raw:_raw,...record}:RecordItem,root:string):ActivitySummary{
  const summary=activitySafe(record,root) as ActivitySummary;
  summary.title=String(summary.title??'').slice(0,180);
  summary.reply=String(summary.reply??'').slice(0,240);
  summary.speaker=String(summary.speaker??'');
  summary.conversation=String(summary.conversation??'');
  return summary;
}

async function logStat(file:string){
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.nlink!==1||stat.size>maxLogBytes)throw new FishError('ACTIVITY_NOT_FOUND');
  return stat;
}

/** The index stores previews and counters. Full traces are only kept while reading one record. */
export class ActivityHistory {
  private logs=new Map<string,IndexedSummary>();
  private webIndex=new Map<string,IndexedSummary>();
  private indexLoaded=false;
  private lastScan=0;private lastDevelopmentScan=0;private scanning?:Promise<void>;
  constructor(private root:string,private web:Store,private shared:Store){}

  private async loadIndex(){
    if(this.indexLoaded)return;
    this.indexLoaded=true;
    try{
      const file=safePath(this.root,summaryFile);
      await logStat(file);
      const rows=JSON.parse(await fs.readFile(file,'utf8')) as IndexedSummary[];
      this.logs=new Map(rows.filter(row=>Number.isSafeInteger(row.summary.qqAccess)).map(({stamp,summary})=>[summary.id,{stamp,summary}]));
    }catch{/* A missing or damaged index can be rebuilt from the original logs. */}
  }

  private async scan(developmentOnly:boolean){
    while(this.scanning)await this.scanning;
    if(Date.now()-(developmentOnly?this.lastDevelopmentScan:this.lastScan)<1500)return;
    this.scanning=(async()=>{
      await this.loadIndex();
      const found=new Set<string>();
      let changed=false;
      for(const defaultKind of ['qq','news','diary','image','exploration','development'] as const){
        if(developmentOnly&&defaultKind!=='development')continue;
        let dir:string,entries:string[];
        try{dir=safePath(this.root,logFolders[defaultKind]);entries=await fs.readdir(dir);}catch{continue;}
        for(const name of entries){
          if(!/^[a-zA-Z0-9-]+\.json$/.test(name))continue;
          const kind=defaultKind==='news'&&isMemoryLog(name)?'memory':defaultKind,id=kind+':'+name.slice(0,-5),file=path.join(dir,name);
          try{
            const stat=await logStat(file);found.add(id);
            const stamp=`${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
            if(this.logs.get(id)?.stamp===stamp)continue;
            const raw=JSON.parse(await fs.readFile(file,'utf8'));
            const summary=summarize(parseLog(id,kind,raw,stat.mtimeMs),this.root);
            this.logs.set(id,{stamp,summary});changed=true;
          }catch{/* An active write can be partial; keep the last readable snapshot and retry. */}
        }
      }
      for(const id of this.logs.keys())if((!developmentOnly||id.startsWith('development:'))&&!found.has(id)){this.logs.delete(id);changed=true;}
      if(changed){
        try{
          makeDir(this.root,'runtime/cache');
          writePrivateAtomic(this.root,summaryFile,JSON.stringify([...this.logs.values()]));
        }catch{/* The in-memory summaries still serve the current process. */}
      }
      this.lastDevelopmentScan=Date.now();
      if(!developmentOnly)this.lastScan=this.lastDevelopmentScan;
    })();try{await this.scanning;}finally{this.scanning=undefined;}
  }

  private explorationNotes(){
    if(!this.shared.db.prepare("SELECT name FROM sqlite_master WHERE name='exploration_runs'").get())return;
    return this.shared.db.prepare('SELECT state,note FROM exploration_runs WHERE id=?');
  }

  private webRecord(t:any,full:boolean){
    const d=full?activitySafe({...t,trace:obj(t.trace),context:obj(t.context)},this.root):{...t,trace:obj(t.trace)};
    const r=base('web:'+t.id,'web',d,t.created);
    r.title=d.user;r.conversation='web:'+t.sid;r.speaker='webui-local';r.reply=d.answer;
    traceRecord(r,Array.isArray(d.trace)?d.trace:[]);r.state=d.state;
    return r;
  }

  private webSummaries(){
    const summaries:ActivitySummary[]=[];
    const previous=this.webIndex;
    this.webIndex=new Map();
    const readTrace=this.web.db.prepare('SELECT id,sid,user,answer,trace,state,created FROM web_turns WHERE id=?');
    for(const t of this.web.db.prepare('SELECT id,state,created FROM web_turns').iterate() as Iterable<{id:string;state:string;created:number}>){
      // Only running turns can have updates without a state transition.
      const stamp=`${t.created}:${t.state}`,cached=previous.get(t.id);
      let summary=t.state!=='running'&&cached?.stamp===stamp?cached.summary:undefined;
      if(!summary){
        const row=readTrace.get(t.id);
        if(!row)continue;
        summary=summarize(this.webRecord(row,false),this.root);
      }
      this.webIndex.set(t.id,{stamp,summary});summaries.push(summary);
    }
    return summaries;
  }

  private auditRecord(row:any,index:number){
    const d=activitySafe({...row,detail:obj(row.detail)},this.root);
    const r=base('audit:'+index+'-'+d.id,'audit',d,d.at);
    r.title=d.kind;r.conversation=d.grp;r.state=/error|denied|fault|limit/.test(d.kind)?'failed':'completed';
    r.events=[{type:'event',name:d.kind,result:d.detail}];r.errors=r.state==='failed'?1:0;
    return r;
  }

  private auditStores(){return this.shared===this.web?[this.shared]:[this.shared,this.web];}

  private chainRows(id?:string){
    const db=this.shared.db,exists=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(name);
    if(!exists('activity_chains'))return [];
    const count=exists('activity_chain_events')?"(SELECT count(*) FROM activity_chain_events e WHERE e.chain_id=c.id AND json_extract(e.detail,'$.qqAccess')=1)":'0';
    return db.prepare(`SELECT id,owner,instruction,created,updated,state,job_id,turn_id,answer IS NOT NULL AS answered${id?',answer AS discussion':''},
      authorized,text AS draft,submitted,post_id,url,error,${count} AS qqVisits FROM activity_chains c${id?' WHERE id=?':''}`).all(...(id?[id]:[]));
  }

  private chainRecord(row:any,full=false){
    const d=activitySafe(row,this.root),r=base('chain:'+row.id,'chain',{...d,conversation:'private:'+row.owner},row.created);
    r.title=d.instruction;
    r.state=({published:'completed',completed:'completed',failed:'failed',cancelled:'cancelled',unconfirmed:'unconfirmed'} as Record<string,string>)[row.state]??'running';
    r.errors=r.state==='failed'?1:0;r.qqAccess=row.qqVisits||(row.post_id?1:0);
    r.reply=({waiting_discussion:'等待 GPT 小姐的讨论结果',queued:'等待执行下一步',drafting:'正在准备后续操作',executing:'正在使用工具办事',completed:'后续步骤已完成',ready:'草稿已保存，等待提交',publishing:'正在向 QQ 空间提交',published:'QQ 空间已确认发布',unconfirmed:'空间回执待核对',failed:'任务链失败',cancelled:'任务链已取消'} as Record<string,string>)[row.state]??row.state;
    if(!full)return r;
    r.events.push({type:'event',name:'任务链已建立',at:row.created,state:'completed'});
    const hasEvents=this.shared.db.prepare("SELECT 1 FROM sqlite_master WHERE name='activity_chain_events' AND type='table'").get();
    const events=hasEvents?this.shared.db.prepare('SELECT at,step,state,detail FROM activity_chain_events WHERE chain_id=? ORDER BY seq').all(row.id):[];
    if(row.answered&&!events.some(event=>event.step==='收到讨论结论'))
      r.events.push({type:'event',name:'收到讨论结论',state:'completed',result:{discussionId:row.job_id,turnId:row.turn_id,text:d.discussion}});
    const calls=new Map<string,number>();
    for(const event of events){
      const result=activitySafe(obj(event.detail),this.root);
      const step={type:'event',name:String(event.step),state:String(event.state),at:Number(event.at),result};
      if(step.name==='收到讨论结论'&&result.text===undefined)result.text=d.discussion;
      if(result.tool===true&&typeof result.callId==='string'){
        const action:Step={...step,type:'tool',callId:result.callId,args:result.args,result:result.result};
        action.qqAccess=qqAccess(action);
        const index=calls.get(result.callId);
        if(index===undefined){calls.set(result.callId,r.events.length);r.events.push(action);count(r,action.name);}
        else r.events[index]=action;
      }else r.events.push(step);
    }
    if(row.post_id&&!r.events.some(event=>event.result?.postId===row.post_id))
      r.events.push({type:'event',name:'QQ 空间返回发言回执',at:row.updated,state:'completed',result:{postId:d.post_id,url:d.url}});
    if(row.error&&!r.events.some(event=>event.result?.error===d.error)){
      const old=!events.length&&row.error==='ACTIVITY_CHAIN_PUBLICATION_NOT_AUTHORIZED'&&!row.submitted&&!row.authorized;
      r.events.push({type:'event',name:old?'检查主人发布授权':'任务链状态',at:row.updated,state:r.state,
        result:{error:d.error,text:old?'在写稿和提交前停止。旧版未保存授权工具的原始返回。':undefined}});
    }
    return r;
  }

  private async developmentStatus():Promise<DevelopmentStatus[]>{
    try{
      const file=safePath(this.root,'runtime/data/development-inbox/status.json');
      await logStat(file);
      const {tasks}=JSON.parse(await fs.readFile(file,'utf8'));
      return Array.isArray(tasks)?tasks.filter(row=>typeof row?.id==='string'&&/^[a-f0-9-]{36}$/.test(row.id)):[];
    }catch{return [];}
  }

  private developmentWithStatus(record:any,status:DevelopmentStatus|undefined){
    if(!status||record.updated>=status.updatedAt)return record;
    const current=activitySafe(status,this.root);
    return {...record,updated:current.updatedAt,phase:current.phase,goal:current.goal,reason:current.reason,report:current.report,
      codex:{...record.codex,rounds:current.rounds,activity:current.codexStep?{step:current.codexStep,at:current.codexUpdatedAt}:undefined}};
  }

  private async summaries(kind:string){
    if(kind==='audit')return this.auditStores().flatMap((store,index)=>(store.db.prepare('SELECT * FROM audit').all()).map(row=>summarize(this.auditRecord(row,index),this.root)));
    if(kind==='chain')return this.chainRows().map(row=>summarize(this.chainRecord(row),this.root));
    const developmentOnly=kind==='development';
    await this.scan(developmentOnly);
    const exploration=developmentOnly?undefined:this.explorationNotes();
    const records=[...this.logs.values()].filter(({summary})=>!developmentOnly||summary.kind==='development').map(({summary})=>{
      if(summary.kind!=='exploration')return summary;
      const row=exploration?.get(summary.id.slice(12)) as {state:string;note:string|null}|undefined;
      return row?{...summary,state:row.state==='paused'?'failed':row.state,reply:row.note===null?summary.reply:activitySafe(row.note,this.root).slice(0,240)}:summary;
    });
    const activeDevelopment=new Map((await this.developmentStatus()).map(row=>['development:'+row.id,row]));
    for(let i=0;i<records.length;i++){
      const entry=records[i],status=activeDevelopment.get(entry.id);
      if(!status)continue;
      activeDevelopment.delete(entry.id);
      if(status.updatedAt>entry.updated)records[i]=summarize(parseLog(entry.id,'development',this.developmentWithStatus({
        created:entry.at,updated:entry.updated,goal:entry.title,
      },status),entry.at),this.root);
    }
    for(const [id,status] of activeDevelopment)records.push(summarize(parseLog(id,'development',
      this.developmentWithStatus({created:status.updatedAt},status),status.updatedAt),this.root));
    return developmentOnly?records:records.concat(this.webSummaries(),this.chainRows().map(row=>summarize(this.chainRecord(row),this.root)));
  }

  async list(params:URLSearchParams,signal?:AbortSignal){
    const kind=params.get('kind')||'',state=params.get('state')||'',q=(params.get('q')??'').trim().toLowerCase(),conversation=params.get('conversation')||'';
    const from=queryDate(params.get('from')),to=queryDate(params.get('to'),true),offset=Number(params.get('offset')??0),limit=20;
    if(kind&&!kinds.has(kind)||state&&!['completed','failed','running','unknown','cancelled','interrupted','unconfirmed'].includes(state)||q.length>200||conversation.length>120||!Number.isSafeInteger(offset)||offset<0||from!==null&&to!==null&&from>=to)throw new FishError('ACTIVITY_QUERY_INVALID');
    let records=await this.summaries(kind);
    signal?.throwIfAborted();
    const conversations=[...new Set(records.map(r=>r.conversation).filter(Boolean))].sort();
    records=records.filter(r=>(!kind||(kind==='qq_access'?r.qqAccess>0:r.kind===kind))&&(!state||r.state===state)&&(!conversation||r.conversation===conversation)&&(from===null||r.at>=from)&&(to===null||r.at<to));
    if(q){
      const matches:ActivitySummary[]=[];
      for(const summary of records){
        signal?.throwIfAborted();
        try{
          const r=await this.detail(summary.id);
          if(JSON.stringify([r.title,r.reply,r.conversation,r.speaker,r.events]).toLowerCase().includes(q))matches.push(summary);
        }catch(e){if(!(e instanceof FishError)||e.message!=='ACTIVITY_NOT_FOUND')throw e;}
      }
      records=matches;
    }
    records.sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
    const totals={records:records.length,input:0,output:0,tokens:0,modelCalls:0,unknownUsage:0,cachedInput:0,uncachedInput:0,cacheKnownCalls:0,cacheUnknownInput:0,unreportedCalls:0,tools:0,search:0,fetch:0,browse:0,downloads:0,images:0,sends:0,errors:0};
    for(const r of records){totals.input+=r.usage.input;totals.output+=r.usage.output;totals.tokens+=r.usage.total;totals.modelCalls+=r.usage.calls;for(const k of ['cachedInput','uncachedInput','cacheKnownCalls','cacheUnknownInput','unreportedCalls'] as const)totals[k]+=r.usage[k];if(!r.usage.known)totals.unknownUsage++;totals.errors+=r.errors;for(const k of Object.keys(r.counts) as (keyof RecordItem['counts'])[])totals[k]+=r.counts[k];}
    return {items:records.slice(offset,offset+limit),totals,conversations,offset,limit,nextOffset:offset+limit<records.length?offset+limit:null,timezone:'Asia/Hong_Kong',updatedAt:Date.now()};
  }
  async detail(id:unknown){
    if(typeof id!=='string'||id.length>180||!/^\w+:[a-zA-Z0-9-]+$/.test(id))throw new FishError('ACTIVITY_NOT_FOUND');
    const [kind,key]=id.split(':');
    if(kind==='chain'){
      const [row]=this.chainRows(key);
      if(row)return this.chainRecord(row,true);
    }else if(kind==='web'){
      const row=this.web.db.prepare('SELECT * FROM web_turns WHERE id=?').get(key);
      if(row)return this.webRecord(row,true);
    }else if(kind==='audit'){
      const match=/^([01])-([1-9]\d*)$/.exec(key);
      if(match){
        const index=Number(match[1]);
        const row=this.auditStores()[index]?.db.prepare('SELECT * FROM audit WHERE id=?').get(match[2]);
        if(row)return this.auditRecord(row,index);
      }
    }else if(Object.hasOwn(logFolders,kind)){
      const fileKind=kind as keyof typeof logFolders;
      const status=fileKind==='development'?(await this.developmentStatus()).find(row=>row.id===key):undefined;
      try{
        if((fileKind==='news'||fileKind==='memory')&&(fileKind==='memory')!==isMemoryLog(key))throw new FishError('ACTIVITY_NOT_FOUND');
        const file=safePath(this.root,`${logFolders[fileKind]}/${key}.json`),stat=await logStat(file);
        const raw=JSON.parse(await fs.readFile(file,'utf8'));
        const r=parseLog(id,fileKind,this.developmentWithStatus(activitySafe(raw,this.root),status),stat.mtimeMs);
        if(fileKind==='exploration'){
          const row=this.explorationNotes()?.get(key) as {state:string;note:string|null}|undefined;
          if(row){r.state=row.state==='paused'?'failed':row.state;r.reply=activitySafe(row.note??r.reply,this.root);}
        }
        return r;
      }catch{
        if(status)return parseLog(id,'development',this.developmentWithStatus({created:status.updatedAt},status),status.updatedAt);
      }
    }
    throw new FishError('ACTIVITY_NOT_FOUND');
  }
  async image(id:unknown){
    const record=await this.detail(id);
    if(record.kind!=='image'||!/^image:[a-f0-9-]{36}$/.test(record.id))throw new FishError('ACTIVITY_NOT_FOUND');
    const file=generatedImage(this.root,record.id.slice(6),MAX_IMAGE_BYTES);
    try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_IMAGE_BYTES)throw Error('invalid');return await fs.readFile(file);}catch{throw new FishError('ACTIVITY_IMAGE_UNAVAILABLE');}
  }
}
