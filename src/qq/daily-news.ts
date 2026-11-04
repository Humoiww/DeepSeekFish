import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath,makeDir,writePrivate,writePrivateAtomic } from '../paths.js';
import { Store,redact } from '../storage/db.js';
import { type Config,conversationAllowed } from '../config.js';
import { type BudgetedModel,modelPayload } from '../agent/model.js';
import {traceModel} from '../agent/model-trace.js';
import {diagnosticSafe,errorDiagnostic} from '../diagnostics.js';
import { TurnContext,contextTools } from '../agent/context.js';
import { FishError,codeOf,type ChatMessage,type ModelTool,type Transport,type Message } from '../types.js';
import { qqChatTools,imageLibraryTools } from './chat-tools.js';
import { forwardTools } from './forward.js';
import { qqPrompt } from '../prompts.js';
import { hasToolMarkup } from '../agent/tool-protocol.js';
import { knowledgeTools,knowledgeSnapshot,knowledgeTokens,knowledgeUpdateParameters,updateKnowledge } from '../memory/knowledge.js';
import { MemoryJournal,recallTools } from '../memory/journal.js';
import { webTools,browseTools } from '../search/tools.js';
import { searchEvidence,type SearchService } from '../search/provider.js';
import { browsePage } from '../search/public-web.js';
import { PROJECT_TIMEZONE,projectDay,projectDayStart,DAY_MS } from '../time.js';

interface NewsSettings {enabled:boolean;owner:string;startsOn:string;timezone:typeof PROJECT_TIMEZONE}
interface NewsRow {day:string;owner:string;state:string;draft:string|null;error:string|null;updated:number;lease:number;lock:string|null;attempts:number}
export function newsSettings(root:string):NewsSettings|undefined{
  const file=safePath(root,'runtime/data/daily-news.json');if(!fs.existsSync(file))return;
  const s=JSON.parse(fs.readFileSync(file,'utf8'));
  if(typeof s.enabled!=='boolean'||!/^[1-9]\d{0,19}$/.test(s.owner)||!/^20\d{2}-\d{2}-\d{2}$/.test(s.startsOn)||s.timezone!==PROJECT_TIMEZONE)throw new FishError('DAILY_NEWS_CONFIG_INVALID');return s;
}
export function newsSlot(at=Date.now()){
  const start=projectDayStart(at)+8*3600000;
  return {day:projectDay(at),inWindow:at>=start&&at<start+4*3600000,nextRunAt:at<start?start:start+DAY_MS};
}
export function newsStatus(root:string,store:Store,now=Date.now()){
  const s=newsSettings(root),exists=store.db.prepare("SELECT name FROM sqlite_master WHERE name='daily_news'").get();
  return {enabled:s?.enabled??false,timezone:PROJECT_TIMEZONE,at:'08:00',startsOn:s?.startsOn??null,nextRunAt:newsSlot(now).nextRunAt,
    last:exists?store.db.prepare('SELECT day,state,error,updated FROM daily_news ORDER BY day DESC LIMIT 1').get()??null:null};
}
/** Only the owner's recent private conversation, bounded independently of the daily archive. */
export function newsMemory(store:Store,owner:string,now=Date.now()){
  const rows=store.db.prepare("SELECT role,text,observed FROM memory_events WHERE conversation=? AND observed>=? AND observed<=? AND source!='daily-news' ORDER BY observed DESC,seq DESC LIMIT 80").all('private:'+owner,projectDayStart(now)-DAY_MS,now) as any[];
  const recent:{role:string;at:string;text:string}[]=[];let tokens=0;
  for(const r of rows){
    if(hasToolMarkup(r.text))continue;
    const text=redact(String(r.text)).slice(0,600),cost=knowledgeTokens(text)+24;
    if(tokens+cost>2000||recent.length>=36)break;
    recent.unshift({role:r.role,at:new Date(r.observed).toISOString(),text});tokens+=cost;
  }
  return {timezone:PROJECT_TIMEZONE,conversation:'private:'+owner,peerQQ:owner,recent,textTokens:tokens,more:'recall_chat'};
}
const memoryDecision:ModelTool={type:'function',function:{name:'finish_memory',description:'结束后台回顾；有值得长期保留的内容时附带memory，没有则省略。',parameters:{type:'object',properties:{memory:knowledgeUpdateParameters},additionalProperties:false}}};
const draftNews:ModelTool={type:'function',function:{name:'draft_news',description:'完成要私聊给主人的新闻分享。sources填写本次实际查到的来源链接，memory可顺便后台记住新知识。',parameters:{type:'object',properties:{text:{type:'string',maxLength:1800},sources:{type:'array',items:{type:'string'},minItems:1,maxItems:4},memory:knowledgeUpdateParameters},required:['text','sources'],additionalProperties:false}}};

export class DailyNews {
  private memory:MemoryJournal;
  constructor(private root:string,private store:Store,private cfg:()=>Config,private model:Pick<BudgetedModel,'complete'>,private search:Pick<SearchService,'search'|'fetch'>,private transport:Pick<Transport,'send'>,private now=Date.now){
    this.memory=new MemoryJournal(root,store);
    store.db.exec('CREATE TABLE IF NOT EXISTS daily_news(day TEXT PRIMARY KEY,owner TEXT NOT NULL,state TEXT NOT NULL,draft TEXT,error TEXT,updated INTEGER NOT NULL,lease INTEGER NOT NULL DEFAULT 0,lock TEXT,attempts INTEGER NOT NULL DEFAULT 0)');
  }
  private config(){const s=newsSettings(this.root),c=this.cfg();if(!s?.enabled||!c.enabled||!conversationAllowed(c,'private:'+s.owner))throw new FishError('DAILY_NEWS_DISABLED');return s;}
  private log(name:string,data:unknown){makeDir(this.root,'runtime/logs/daily-news');writePrivateAtomic(this.root,'runtime/logs/daily-news/'+name+'.json',JSON.stringify(diagnosticSafe(data),null,2));}
  private row(day:string){return this.store.db.prepare('SELECT * FROM daily_news WHERE day=?').get(day) as NewsRow|undefined;}
  private save(day:string,values:Record<string,unknown>){const fields=Object.entries({...values,updated:this.now()});this.store.db.prepare('UPDATE daily_news SET '+fields.map(([k])=>k+'=?').join(',')+' WHERE day=?').run(...fields.map(([,v])=>v) as any[],day);const {lock:_lock,...row}=this.row(day)!;this.log(day,row);}

  /** One small review per scheduled morning, also callable once to initialize existing memories. */
  async remember(){
    const s=this.config(),trace:any[]=[],file='memory-'+randomUUID(),context=new TurnContext(),used=new Set<string>();
    const tools=[...recallTools,...contextTools,...knowledgeTools,memoryDecision];
    const startedAt=this.now(),saveTrace=()=>this.log(file,{startedAt,at:this.now(),conversation:'private:'+s.owner,trace});
    const messages:ChatMessage[]=[{role:'system',content:qqPrompt(this.root)},{role:'user',content:JSON.stringify({task:'这是后台记忆回顾，不发QQ消息。近期私聊在recent；自己判断哪些知识、偏好、约定或经验值得长期记住，也可以不更新。当前QQ工具在qqTools，联网方法在qqWebTools；历史失败是当时的情况，不代表现在不能做。',qqTools:this.cfg().qqTransport==='onebot'?[...qqChatTools(true,this.cfg().images,true),...imageLibraryTools(),...forwardTools].map(t=>t.function.name):[],qqWebTools:this.cfg().search?[...webTools,...browseTools].map(t=>({name:t.function.name,description:t.function.description})):[],...newsMemory(this.store,s.owner,this.now())})}];
    try{
      for(let round=0;round<4;round++){
        context.compact(round);
        const r=await traceModel(trace,saveTrace,modelPayload(this.cfg(),messages,this.cfg().maxOutputTokens,{tools,requireTool:true}),round,onReservation=>this.model.complete('private:'+s.owner,'memory-review',messages,{tools,requireTool:true,onReservation}));
        if(!r.tool_calls?.length||r.finishReason==='length')throw new FishError('MEMORY_REVIEW_INVALID');
        messages.push({role:'assistant',content:r.text,tool_calls:r.tool_calls});
        for(const call of r.tool_calls){
          if(used.has(call.id)||used.size>=16)throw new FishError('MEMORY_REVIEW_TOOL_LIMIT');used.add(call.id);
          let result:any;
          try{
            const args=JSON.parse(call.function.arguments);
            if(!args||Array.isArray(args)||typeof args!=='object')throw new FishError('INVALID_TOOL_ARGS');
            if(call.function.name==='recall_chat')result=this.memory.read('private:'+s.owner,args,this.now());
            else if(call.function.name==='read_tool_result')result=context.read(args);
            else if(call.function.name==='get_knowledge'){if(Object.keys(args).length)throw new FishError('INVALID_TOOL_ARGS');result=knowledgeSnapshot(this.root);}
            else if(call.function.name==='update_knowledge')result=updateKnowledge(this.root,args);
            else if(call.function.name==='finish_memory'){
              if(r.tool_calls.length!==1||Object.keys(args).some(k=>k!=='memory'))throw new FishError('MEMORY_REVIEW_INVALID');
              result=args.memory===undefined?{ok:true,...knowledgeSnapshot(this.root)}:updateKnowledge(this.root,args.memory);
              trace.push({tool:call.function.name,result});if(result.ok)return result;
            }else throw new FishError('TOOL_NOT_ALLOWED');
          }catch(e){result={error:codeOf(e)};trace.push({tool:call.function.name,callId:call.id,phase:'error',diagnostic:errorDiagnostic(e)});}
          messages[0]={role:'system',content:qqPrompt(this.root)};
          trace.push({tool:call.function.name,result});messages.push(context.result(call.function.name,call.id,result,round));
        }
      }
      throw new FishError('MEMORY_REVIEW_INCOMPLETE');
    }catch(e){trace.push({error:codeOf(e),diagnostic:errorDiagnostic(e),phase:'run'});throw e;}finally{saveTrace();}
  }

  private async compose(owner:string,day:string){
    if(!this.cfg().search)throw new FishError('SEARCH_DISABLED');
    const tools=[...webTools,...browseTools.filter(t=>t.function.name==='browse_page'),...recallTools,...contextTools,...knowledgeTools,draftNews];
    const messages:ChatMessage[]=[{role:'system',content:qqPrompt(this.root)},{role:'user',content:JSON.stringify({task:'每天早上的新闻私聊。自由挑你感兴趣、或与我们聊过的话题相关的新消息，查过来源和发布时间后，按你自己的性格分享给我，附来源链接。近期私聊在recent。',now:new Date(this.now()).toISOString(),...newsMemory(this.store,owner,this.now())})}];
    const trace:any[]=[],sources=new Set<string>(),used=new Set<string>(),context=new TurnContext();
    const file='research-'+day+'-'+randomUUID(),startedAt=this.now(),saveTrace=()=>this.log(file,{startedAt,at:this.now(),conversation:'private:'+owner,trace});
    try{
      for(let round=0;round<8;round++){
        context.compact(round);
        const r=await traceModel(trace,saveTrace,modelPayload(this.cfg(),messages,this.cfg().maxOutputTokens,{tools,requireTool:true}),round,onReservation=>this.model.complete('private:'+owner,'daily-news',messages,{tools,requireTool:true,onReservation}));
        if(!r.tool_calls?.length||r.finishReason==='length')throw new FishError('DAILY_NEWS_DRAFT_INVALID');
        messages.push({role:'assistant',content:r.text,tool_calls:r.tool_calls});
        for(const call of r.tool_calls){
          if(used.has(call.id)||used.size>=24)throw new FishError('DAILY_NEWS_TOOL_LIMIT');used.add(call.id);
          let result:any;
          try{
            const args=JSON.parse(call.function.arguments);
            if(!args||Array.isArray(args)||typeof args!=='object')throw new FishError('INVALID_TOOL_ARGS');
            const keys=(allowed:string[])=>{if(Object.keys(args).some(k=>!allowed.includes(k)))throw new FishError('INVALID_TOOL_ARGS');};
            if(call.function.name==='search_web'){
              keys(['query','fresh']);result=searchEvidence(await this.search.search(args.query,'private:'+owner,'daily-news',args.fresh??true));for(const item of result.results)sources.add(item.url);
            }else if(call.function.name==='fetch_page'){
              keys(['url','offset','fresh']);result=await this.search.fetch(args.url,'private:'+owner,'daily-news',args.offset,args.fresh??true);if(result.status==='content')sources.add(result.url);
            }else if(call.function.name==='browse_page'){
              keys(['url','offset','query','textOffset']);result=await browsePage(args.url,args.offset,undefined,undefined,args.query,args.textOffset);if(result.status==='content')sources.add(result.url);
            }else if(call.function.name==='recall_chat')result=this.memory.read('private:'+owner,args);
            else if(call.function.name==='read_tool_result')result=context.read(args);
            else if(call.function.name==='get_knowledge'){keys([]);result=knowledgeSnapshot(this.root);}
            else if(call.function.name==='update_knowledge'){result=updateKnowledge(this.root,args);messages[0]={role:'system',content:qqPrompt(this.root)};}
            else if(call.function.name==='draft_news'){
              keys(['text','sources','memory']);
              if(r.tool_calls.length!==1||typeof args.text!=='string'||!args.text.trim()||args.text.length>1800||hasToolMarkup(args.text)||redact(args.text)!==args.text)throw new FishError('DAILY_NEWS_DRAFT_INVALID');
              if(!Array.isArray(args.sources)||args.sources.length<1||args.sources.length>4||args.sources.some((u:any)=>typeof u!=='string'||!sources.has(u)))throw new FishError('DAILY_NEWS_SOURCES_REQUIRED');
              const memory=args.memory===undefined?undefined:updateKnowledge(this.root,args.memory);
              if(memory&&!memory.ok){result={ready:false,memory};messages[0]={role:'system',content:qqPrompt(this.root)};}
              else{
                const urls=[...new Set<string>(args.sources)],text=args.text.trim(),full=[text,...urls.filter(url=>!text.includes(url))].join('\n');
                if(full.length>4000)throw new FishError('DAILY_NEWS_TOO_LONG');
                trace.push({draft:{text:full,sources:urls},memory});return {text:full,sources:urls};
              }
            }else throw new FishError('TOOL_NOT_ALLOWED');
          }catch(e){result={error:codeOf(e)};trace.push({tool:call.function.name,callId:call.id,phase:'error',diagnostic:errorDiagnostic(e)});}
          trace.push({tool:call.function.name,result});messages.push(context.result(call.function.name,call.id,result,round));
        }
      }
      throw new FishError('DAILY_NEWS_TOOL_LIMIT');
    }catch(e){trace.push({error:codeOf(e),diagnostic:errorDiagnostic(e),phase:'run'});throw e;}finally{saveTrace();}
  }

  async run(){
    const s=this.config(),{day,inWindow}=newsSlot(this.now());if(!inWindow||day<s.startsOn)return {state:'not_due',day};
    const lock=randomUUID(),claimed=this.store.transaction(()=>{
      this.store.db.prepare("INSERT OR IGNORE INTO daily_news(day,owner,state,updated) VALUES (?,?,'new',?)").run(day,s.owner,this.now());
      const r=this.row(day)!;if(r.owner!==s.owner)throw new FishError('DAILY_NEWS_OWNER_CHANGED');
      if(r.state==='sending'&&r.lease<=this.now())this.store.db.prepare("UPDATE daily_news SET state='unknown',error='SEND_OUTCOME_UNKNOWN' WHERE day=?").run(day);
      if(['sent','sending','unknown'].includes(r.state)||r.lease>this.now()||r.attempts>=3)return false;
      this.store.db.prepare('UPDATE daily_news SET lock=?,lease=?,attempts=attempts+1 WHERE day=?').run(lock,this.now()+15*60000,day);return true;
    });
    if(!claimed)return {state:this.row(day)!.state,day};
    try{
      let row=this.row(day)!;
      if(!row.draft){
        this.save(day,{state:'preparing',error:null});
        // Failure to learn must not silence the scheduled news. All outcomes
        // remain private; a no-change decision is a valid memory review.
        try{await this.remember();}catch(e){this.store.audit('memory-review-error','',codeOf(e));}
        const draft=await this.compose(s.owner,day);this.save(day,{state:'ready',draft:JSON.stringify(draft)});row=this.row(day)!;
      }
      this.config();
      const draft=JSON.parse(row.draft!),m:Message={id:'daily-news:'+day,group:'private:'+s.owner,user:s.owner,text:'每日新闻',at:this.now(),mentioned:false,event:'ordinary'};
      this.save(day,{state:'sending',error:null});await this.transport.send(m,draft.text);
      this.save(day,{state:'sent',error:null});
      this.memory.record({id:m.id,conversation:m.group,actor:'DeepSeekFish',replyTo:s.owner,role:'assistant',text:draft.text,at:this.now(),source:'daily-news'});
      this.store.db.prepare('INSERT OR IGNORE INTO messages(id,grp,usr,text,at,mentioned,event,reply_to) VALUES (?,?,?,?,?,?,?,?)').run(m.id,m.group,'DeepSeekFish',draft.text,this.now(),0,'ordinary',s.owner);
      this.store.prune(this.cfg().historyHours,this.cfg().windowSize);return {state:'sent',day};
    }catch(e){
      const row=this.row(day)!,safe=['DAILY_NEWS_CONNECT_FAILED','ONEBOT_NOT_CONNECTED','ONEBOT_GROUP_NOT_ALLOWED','ONEBOT_INVALID_TARGET','ONEBOT_ACTION_FAILED'].includes(codeOf(e));
      // Unknown send outcomes (including a process crash in `sending`) are
      // never resent automatically. Known failures may retry the saved draft.
      this.save(day,{state:row.state==='sent'?'sent':row.state==='sending'&&!safe?'unknown':'failed',error:codeOf(e)});throw e;
    }finally{this.store.db.prepare('UPDATE daily_news SET lock=NULL,lease=0 WHERE day=? AND lock=?').run(day,lock);}
  }
}
