import fs from 'node:fs/promises';
import path from 'node:path';
import { Store,redact } from '../storage/db.js';
import { FishError } from '../types.js';
import { MAX_IMAGE_BYTES } from '../image/limits.js';
import { safePath } from '../paths.js';

export type ActivityKind='qq'|'web'|'news'|'memory'|'diary'|'image'|'audit';
type Step={type:string;name:string;state?:string;at?:number;args?:unknown;result?:any;usage?:any;callId?:string;round?:number;phases?:unknown[]};
type RecordItem={id:string;kind:ActivityKind;title:string;conversation:string;speaker:string;at:number;updated:number;durationMs:number|null;state:string;usage:{input:number;output:number;total:number;calls:number;known:boolean};counts:{tools:number;search:number;fetch:number;browse:number;downloads:number;images:number;sends:number};reply:string;errors:number;events:Step[];related:string[];raw:unknown};
const kinds=new Set(['qq','web','news','memory','diary','image','audit']);
const secret=/^(?:authorization|cookie|set-cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|skey|p_skey|rkey)$/i;
/** Log data is display-only. Never expose credentials, signed media handles or inline binaries. */
export function activitySafe(value:any,root='',depth=0):any{
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
function resultState(value:any){
  const r=obj(value);if(r?.error||r?.ok===false||r?.success===false||r?.state==='failed')return 'failed';
  if(Array.isArray(r?.images)&&r.images.some((i:any)=>i.error))return r.images.every((i:any)=>i.error)?'failed':'partial';
  if(r?.deliveryStatus==='failed')return 'failed';return 'completed';
}
function base(id:string,kind:ActivityKind,d:any,mtime:number):RecordItem{
  const at=time(d.startedAt??d.created??d.inputContext?.context?.currentTurn?.at??d.at??d.updated)||mtime;
  return {id,kind,title:'',conversation:d.conversation??'',speaker:d.inputContext?.context?.qqIdentity?.speaker??'',at,updated:time(d.finishedAt??d.updated??d.at)||mtime,durationMs:d.finishedAt&&d.startedAt?Math.max(0,d.finishedAt-d.startedAt):null,state:'unknown',usage:{input:0,output:0,total:0,calls:0,known:false},counts:{tools:0,search:0,fetch:0,browse:0,downloads:0,images:0,sends:0},reply:'',errors:0,events:[],related:[],raw:d};
}
function addUsage(r:RecordItem,usage:any){
  if(usage&&Number.isSafeInteger(usage.input)&&Number.isSafeInteger(usage.output)){
    r.usage.input+=usage.input;r.usage.output+=usage.output;r.usage.total+=usage.input+usage.output;r.usage.calls++;r.usage.known=true;
  }
}
function count(r:RecordItem,name:string){
  r.counts.tools++;
  const key: keyof RecordItem['counts']|undefined=({search_web:'search',fetch_page:'fetch',browse_page:'browse',download_image:'downloads',generate_image:'images',send_image:'sends',send_meme:'sends'} as Record<string,keyof RecordItem['counts']>)[name];
  if(key)r.counts[key]++;
}
function traceRecord(r:RecordItem,trace:any[]){
  for(const e of trace){
    const calls=e.toolCalls??e.tool_calls;
    if(e.usage&&e.name!=='model_usage'){addUsage(r,e.usage);r.events.push({type:'model',name:'DeepSeek',round:e.round,usage:e.usage,state:e.error?'failed':'completed',result:{text:e.assistant??e.text??'',finishReason:e.finishReason,error:e.error,toolCalls:calls?.map((c:any)=>c.function?.name)}});}
    if(e.contextInput)r.events.push({type:'context',name:'本轮输入规模',round:e.round,result:e.contextInput});
    if(Array.isArray(calls))for(const c of calls){const name=c.function?.name??'unknown';count(r,name);r.events.push({type:'tool',name,callId:c.id,round:e.round,args:obj(c.function?.arguments),state:'pending'});}
    if(e.tool&&Object.hasOwn(e,'result')){
      let step=r.events.find(s=>s.type==='tool'&&s.name===e.tool&&s.state==='pending');
      if(!step){step={type:'tool',name:e.tool};r.events.push(step);count(r,e.tool);}
      step.result=obj(e.result);step.state=resultState(step.result);if(step.state==='failed'||step.state==='partial')r.errors++;
      if(step.name==='reply'&&step.result?.sent===true){r.reply=String((step.args as any)?.text??'');r.state='completed';}
      if(step.result?.imageId)r.related.push('image:'+step.result.imageId);
      if(step.name==='finish_memory'&&step.result?.ok)r.state='completed';
    }else if(e.tool&&e.phase){const step=[...r.events].reverse().find(s=>s.name===e.tool);if(step)(step.phases??=[]).push(e);else r.events.push({type:'phase',name:e.tool,at:e.at,result:e});}
    if(e.draft){r.reply=e.draft.text??'';r.state='completed';const step=r.events.find(s=>s.name==='draft_news'&&s.state==='pending');if(step){step.state='completed';step.result=e.draft;}r.events.push({type:'result',name:'草稿',result:e.draft});}
    if(e.error){r.state='failed';r.errors++;r.events.push({type:'error',name:String(e.error),round:e.round,result:e});}
    if(e.assistant&&!calls?.length&&!e.error)r.reply=e.assistant;
    if(e.name){
      if(e.name==='model_usage'){addUsage(r,e.usage);r.events.push({type:'model',name:'DeepSeek',round:e.round,usage:e.usage,state:e.state??'completed'});}
      else {count(r,e.name);const state=e.state??resultState(e.result);r.events.push({type:'tool',name:e.name,state,args:e.args,result:obj(e.result),round:e.round,callId:e.callId});if(state==='failed')r.errors++;}
    }
  }
  r.related=[...new Set(r.related)];
}
function parseLog(id:string,kind:ActivityKind,d:any,mtime:number):RecordItem{
  const r=base(id,kind,d,mtime);
  if(kind==='image'){
    r.title=d.request?.prompt??'Codex 生图';r.reply=d.finalText??'';
    r.state=d.delivery?.ok===false||d.error?'failed':d.delivery?.ok===true?'completed':d.outcome==='running'?'running':'unknown';
    r.events=[{type:'request',name:'生图请求与参考图',result:d.request},...(d.events??[]).map((e:any)=>({type:'event',name:e.method,at:e.at,result:e.detail})),...(d.messages??[]).map((e:any)=>({type:'message',name:'Codex '+(e.phase??''),result:e.text})),{type:'result',name:'生成产物',result:d.images},{type:'delivery',name:'产物校验',result:d.delivery}];
    r.errors=r.state==='failed'?1:0;return r;
  }
  if(kind==='diary'||kind==='news'&&!d.trace){
    r.title=kind==='diary'?'每日空间动态':'早间新闻发送';r.conversation=d.owner?'private:'+d.owner:d.self?'QQ '+d.self:'';
    r.reply=obj(d.draft)?.text??'';r.state=({sent:'completed',published:'completed',completed:'completed',failed:'failed',sending:'running',running:'running'} as any)[d.state]??'unknown';
    r.events=[{type:'result',name:r.title,result:d}];if(d.image_id)r.related=['image:'+d.image_id];if(d.error)r.errors=1;return r;
  }
  r.title=kind==='qq'?String(d.request??'QQ 对话'):kind==='memory'?'后台记忆回顾':'早间新闻检索';
  traceRecord(r,d.trace??[]);if(['running','completed','failed'].includes(d.state))r.state=d.state;
  return r;
}
function queryDate(raw:string|null,end=false){
  if(!raw)return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))throw new FishError('ACTIVITY_QUERY_INVALID');
  const v=Date.parse(raw+'T00:00:00+08:00');if(!Number.isFinite(v)||new Date(v+28800000).toISOString().slice(0,10)!==raw)throw new FishError('ACTIVITY_QUERY_INVALID');
  return v+(end?86400000:0);
}

/** Read the existing private logs lazily; cache parsed files by size/mtime. No model calls. */
export class ActivityHistory {
  private cache=new Map<string,{stamp:string;record:RecordItem}>();
  private lastScan=0;private scanning?:Promise<void>;
  constructor(private root:string,private web:Store,private shared:Store){}
  private async scan(){
    if(this.scanning)return this.scanning;if(Date.now()-this.lastScan<1500)return;
    this.scanning=(async()=>{
      const found=new Set<string>();
      for(const [folder,defaultKind] of [['qq','qq'],['daily-news','news'],['daily-qzone','diary'],['codex','image']] as const){
        const dir=path.join(this.root,'runtime/logs',folder);let entries:string[];
        try{const s=await fs.lstat(dir);if(!s.isDirectory()||s.isSymbolicLink())continue;entries=await fs.readdir(dir);}catch{continue;}
        for(const name of entries){
          if(!/^[a-zA-Z0-9-]+\.json$/.test(name))continue;
          const kind=folder==='daily-news'&&name.startsWith('memory-')?'memory':defaultKind,id=kind+':'+name.slice(0,-5),file=path.join(dir,name);found.add(id);
          try{
            const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16*1024*1024){found.delete(id);continue;}
            const stamp=stat.mtimeMs+':'+stat.size;if(this.cache.get(id)?.stamp===stamp)continue;
            const raw=JSON.parse(await fs.readFile(file,'utf8'));this.cache.set(id,{stamp,record:parseLog(id,kind,activitySafe(raw,this.root),stat.mtimeMs)});
          }catch{/* An active write can be partial; keep the last readable snapshot and retry. */}
        }
      }
      for(const id of this.cache.keys())if(!found.has(id))this.cache.delete(id);
      this.lastScan=Date.now();
    })();try{await this.scanning;}finally{this.scanning=undefined;}
  }
  private webRecords(){
    const rows=this.web.db.prepare('SELECT * FROM web_turns ORDER BY created DESC').all() as any[];
    return rows.map(t=>{const d=activitySafe({...t,trace:obj(t.trace),context:obj(t.context)},this.root),r=base('web:'+t.id,'web',d,t.created);r.title=d.user;r.conversation='web:'+t.sid;r.speaker='webui-local';r.reply=d.answer;r.state=d.state;traceRecord(r,Array.isArray(d.trace)?d.trace:[]);return r;});
  }
  private auditRecords(){
    return [this.shared,...(this.web===this.shared?[]:[this.web])].flatMap((store,i)=>(store.db.prepare('SELECT * FROM audit ORDER BY at DESC').all() as any[]).map(d=>{
      d=activitySafe({...d,detail:obj(d.detail)},this.root);const r=base('audit:'+i+'-'+d.id,'audit',d,d.at);r.title=d.kind;r.conversation=d.grp;r.state=/error|denied|fault|limit/.test(d.kind)?'failed':'completed';r.events=[{type:'event',name:d.kind,result:d.detail}];r.errors=r.state==='failed'?1:0;return r;
    }));
  }
  async list(params:URLSearchParams){
    const kind=params.get('kind')||'',state=params.get('state')||'',q=(params.get('q')??'').trim().toLowerCase(),conversation=params.get('conversation')||'';
    const from=queryDate(params.get('from')),to=queryDate(params.get('to'),true),offset=Number(params.get('offset')??0),limit=20;
    if(kind&&!kinds.has(kind)||state&&!['completed','failed','running','unknown'].includes(state)||q.length>200||conversation.length>120||!Number.isSafeInteger(offset)||offset<0||from!==null&&to!==null&&from>=to)throw new FishError('ACTIVITY_QUERY_INVALID');
    await this.scan();let records=kind==='audit'?this.auditRecords():[...this.cache.values()].map(v=>v.record).concat(this.webRecords());
    const conversations=[...new Set(records.map(r=>r.conversation).filter(Boolean))].sort();
    records=records.filter(r=>(!kind||r.kind===kind)&&(!state||(state==='failed'?r.state==='failed'||r.errors>0:r.state===state))&&(!conversation||r.conversation===conversation)&&(from===null||r.at>=from)&&(to===null||r.at<to)&&(!q||JSON.stringify([r.title,r.reply,r.conversation,r.speaker,r.events]).toLowerCase().includes(q))).sort((a,b)=>b.at-a.at||b.id.localeCompare(a.id));
    const totals={records:records.length,input:0,output:0,tokens:0,modelCalls:0,unknownUsage:0,tools:0,search:0,fetch:0,browse:0,downloads:0,images:0,sends:0,errors:0};
    for(const r of records){totals.input+=r.usage.input;totals.output+=r.usage.output;totals.tokens+=r.usage.total;totals.modelCalls+=r.usage.calls;if(!r.usage.known)totals.unknownUsage++;totals.errors+=r.errors;for(const k of Object.keys(r.counts) as (keyof RecordItem['counts'])[])totals[k]+=r.counts[k];}
    return {items:records.slice(offset,offset+limit).map(({events,raw,...item})=>({...item,title:item.title.slice(0,180),reply:item.reply.slice(0,240)})),totals,conversations,offset,limit,nextOffset:offset+limit<records.length?offset+limit:null,timezone:'Asia/Hong_Kong',updatedAt:Date.now()};
  }
  async detail(id:unknown){
    if(typeof id!=='string'||id.length>180||!/^\w+:[a-zA-Z0-9-]+$/.test(id))throw new FishError('ACTIVITY_NOT_FOUND');
    await this.scan();const r=id.startsWith('web:')?this.webRecords().find(r=>r.id===id):id.startsWith('audit:')?this.auditRecords().find(r=>r.id===id):this.cache.get(id)?.record;
    if(!r)throw new FishError('ACTIVITY_NOT_FOUND');return r;
  }
  async image(id:unknown){
    const record=await this.detail(id);
    if(record.kind!=='image'||!/^image:[a-f0-9-]{36}$/.test(record.id))throw new FishError('ACTIVITY_NOT_FOUND');
    const file=safePath(this.root,'runtime/outputs/'+record.id.slice(6)+'/image.png');
    try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_IMAGE_BYTES)throw Error('invalid');return await fs.readFile(file);}catch{throw new FishError('ACTIVITY_IMAGE_UNAVAILABLE');}
  }
}
