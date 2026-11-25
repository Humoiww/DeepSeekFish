import {projectTime,clockPrompt,modelTimeJson} from '../time.js';
import {Affect} from '../affect.js';
import {tiebaTextPosts} from '../search/tieba.js';
import {toolFailure,toolArgs,UnreadFeedback,actionState} from '../agent/tool-feedback.js';
import { networkPricing,toCny } from '../budget/pricing.js';
import fs from 'node:fs';
import { configureQQ,qqStatus,readQQSettings } from '../qq/settings.js';
import { ExplorationState } from '../exploration/state.js';
import { randomBytes,randomUUID } from 'node:crypto';
import { deepseekCredential,providerCredential,defaults,prepare,loadSecrets,loadConfig,validateConfig,type Config } from '../config.js';
import { safePath,writePrivate } from '../paths.js';
import { Store,redact } from '../storage/db.js';
import { Ledger,dayKey } from '../budget/ledger.js';
import { Tasks } from '../codex/tasks.js';
import { AppServerRunner,MockTaskRunner } from '../codex/runner.js';
import { knowledgeTools,knowledgeSnapshot,updateKnowledge } from '../memory/knowledge.js';
import {browsePage,readPublic,type PublicReader} from '../search/public-web.js';
import { webTools,browseTools } from '../search/tools.js';
import { SearchService,DeepSeekSearchProvider,MockSearchProvider,searchEvidence } from '../search/provider.js';
import { FishError,codeOf } from '../types.js';
import { SessionWorkspace } from './workspace.js';
import { WebModel,type WireMessage,type WebTool } from './model.js';
import { webPrompt,promptSystems } from '../prompts.js';
import { personalityPrompt,personaSettings,savePersona } from '../character.js';
import { promptSnapshots } from '../prompt-record.js';
import { WebImages,requestsImage } from './images.js';
import type { ImageRunner } from '../image/codex-smoke.js';
import { AppServerQuotaReader,CodexQuotaMonitor,type QuotaReader } from '../codex/quota.js';
import { MemoryJournal,dayStart } from '../memory/journal.js';
import { startQQImageBroker } from '../qq/image-broker.js';
import {Corpus} from '../memory/corpus.js';
import {privateQQNumbers} from '../agent/prompt-numbers.js';
import { ActivityHistory,corpusReplyCandidates,corpusTiebaReply } from './activity.js';
import {activityChainActive,interruptActivityChains} from '../qq/activity-chain.js';
import {developmentDashboard,developmentRecord,readAgyQuota,requestAgyQuotaRefresh,requestDevelopmentInterrupt,requestConversationReset} from '../development/bridge-view.js';
import {DeepSeekBalance} from './deepseek-balance.js';
import {OpenCodeQuota} from './opencode-quota.js';
import {boundDevelopmentOwner} from '../development/intake.js';
import { modelPayload,RoutedChatModel } from '../agent/model.js';
import {ConnectionProfiles,liveModelConfig} from '../provider/connections.js';
import {OpenCodeCatalog,mockProviderMode} from '../provider/opencode.js';
import {traceModel} from '../agent/model-trace.js';
import {diagnosticSafe,errorDiagnostic} from '../diagnostics.js';
import { PROJECT_TIMEZONE } from '../time.js';
import {TiebaAccountClient} from '../tieba/client.js';
import {tiebaTarget} from '../search/tieba.js';
import {tiebaSectionSettings,saveTiebaSectionSettings} from '../tieba/section-settings.js';
import { dailyStatus } from '../qq/daily-qzone.js';
import { newsStatus } from '../qq/daily-news.js';

type Settings={model:string;maxOutputTokens:number;dailyCny:number;groupDailyCny:number;search:boolean;codexQueue:boolean;groupChatSearch:boolean;curiosityPublicSearch:boolean;curiosityAutoSummary:boolean};
type Session={id:string;title:string;created:number;updated:number};
type Turn={id:string;sid:string;user:string;answer:string;trace:string;context:string;state:string;created:number};
export type WebEvent={type:string;[key:string]:unknown};
const tool=(name:string,description:string,properties:Record<string,unknown>={},required:string[]=[]):WebTool=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const tools=[tool('list_files','列出当前会话工作区内的文件'),
  tool('read_file','读取当前会话工作区的 UTF-8 文本文件，最多 64 KiB',{path:{type:'string'}},['path']),
  tool('write_file','在当前会话工作区创建或更新文本文件，最多 64 KiB；无权访问其他目录',{path:{type:'string'},content:{type:'string'}},['path','content']),
  ...webTools,...browseTools.filter(t=>t.function.name==='browse_page'),...knowledgeTools,
  tool('queue_codex','提出独立 Codex 任务，只进入待审队列，不能执行或批准任务',{task:{type:'string'}},['task'])];

/** Human WebUI acknowledgments only. Never write to the account worker/journal. */
export function createTiebaDismissals(store:Store){
  store.db.exec('CREATE TABLE IF NOT EXISTS tieba_dismissed_issues(request_id TEXT PRIMARY KEY,dismissed_at INTEGER NOT NULL)');
  const watermark=()=>Number(store.getMeta('tieba:dismissed-all-at')??0);
  const problem=(item:any)=>!['running','queued','cleaning'].includes(item?.state)&&
    !(item?.result?.publicVerified||item?.result?.published||item?.result?.visibility==='public'||item?.result?.outcome==='public')&&
    !!(item?.result?.error||['challenge','failed','unknown','removed','interrupted','timeout'].includes(item?.result?.outcome));
  function annotate(item:any){
    if(!item)return item;
    const requestId=item.metadata?.requestId??item.requestId??item.result?.requestId??item.id;
    const explicit=typeof requestId==='string'?store.db.prepare('SELECT dismissed_at FROM tieba_dismissed_issues WHERE request_id=?').get(requestId) as {dismissed_at:number}|undefined:undefined;
    const at=Math.max(item.createdAt??item.created??item.startedAt??0,item.finishedAt??0,item.updatedAt??0,item.at??0);
    const isProblem=problem(item),dismissed=explicit?explicit.dismissed_at>0:isProblem&&at>0&&at<=watermark();
    return {...item,problem:isProblem,dismissed};
  }
  function queue(data:any){
    const active=(data.active??[]).map(annotate),completed=(data.completed??[]).map(annotate);
    const items=[...active,...completed];
    return {...data,active,completed,...(data.selected?{selected:annotate(data.selected)}:{}),dismissedAllAt:watermark(),
      issueCounts:{attention:items.filter((i:any)=>i.problem&&!i.dismissed).length,dismissed:items.filter((i:any)=>i.dismissed).length}};
  }
  function attempt(value:any){return annotate(value&&{...value,createdAt:value.startedAt,state:value.result?.stage==='running'?'running':'done'});}
  function status(value:any,latestAttempt:any){
    const work=value.publicationWork,application=value.moderatorWork&&value.moderatorWork.created>=(work?.created??0)?value.moderatorWork:null;
    const active=application??work,activeId=active?.requestId;
    const a=latestAttempt&&(latestAttempt.requestId===activeId||latestAttempt.startedAt>=Math.max(work?.created??0,application?.created??0))?latestAttempt:null;
    const matched=a?.requestId===activeId;
    const result=application?.result??(matched&&work?.result?work.result:a?.result??work?.result);
    const needsHuman=!application&&value.publication?.needsHuman;
    const challenge=needsHuman&&(!result||work?.stage==='challenge'&&!result.error&&!result.outcome);
    const attention=annotate({requestId:application?.requestId??a?.requestId??activeId,
      createdAt:application?application.created:a?.startedAt??work?.created,
      finishedAt:application?application.updatedAt:Math.max(a?.at??0,a?.finishedAt??0,work?.updatedAt??0,needsHuman?value.publication.detectedAt??0:0),
      state:result?.stage==='running'||!a&&['preparing','started'].includes(active?.stage)?'running':'done',
      result:result?.error==='TIEBA_PUBLICATION_NEEDS_HUMAN'&&!value.publication?.needsHuman?undefined:
        challenge?{...result,error:'TIEBA_PUBLICATION_CHALLENGE',outcome:'challenge'}:result});
    const annotateWork=(w:any)=>w?annotate({...w,state:['preparing','started'].includes(w.stage)?'running':'done'}):w;
    return {...value,...(work?{publicationWork:annotateWork(work)}:{}),...(value.moderatorWork?{moderatorWork:annotateWork(value.moderatorWork)}:{}),
      latestAttempt:attempt(latestAttempt),attention,attentionDismissed:attention.dismissed,dismissedAllAt:watermark()};
  }
  function dismiss(input:unknown){
    const b=input as Record<string,unknown>,validId=(id:unknown):id is string=>typeof id==='string'&&id.trim().length>0&&id.length<=240&&!/[\u0000-\u001f\u007f]/.test(id);
    if(!b||typeof b!=='object'||Array.isArray(b))throw new FishError('TIEBA_INPUT_INVALID');
    const keys=Object.keys(b),all=b.all===true&&keys.every(k=>['all','requestIds'].includes(k))&&
      (b.requestIds===undefined||Array.isArray(b.requestIds)&&b.requestIds.length<=500&&b.requestIds.every(validId));
    const single=validId(b.requestId)&&(keys.length===1||b.restore===true&&keys.length===2&&keys.includes('restore'));
    if(!all&&!single)throw new FishError('TIEBA_INPUT_INVALID');
    const at=Date.now();
    store.transaction(()=>{
      if(all){
        // A new dismiss-all also acknowledges items previously restored. The
        // watermark covers completed problems on every page, never future work.
        // Optional requestIds are hints, not explicit dismissals of active or
        // successful items: only problems completed by this watermark qualify.
        store.db.exec('DELETE FROM tieba_dismissed_issues WHERE dismissed_at=0');
        store.setMeta('tieba:dismissed-all-at',String(at));
      }else store.db.prepare('INSERT OR REPLACE INTO tieba_dismissed_issues VALUES (?,?)').run(b.requestId as string,b.restore===true?0:at);
    });
    return {ok:true,...(all?{all:true,dismissedAllAt:at}:{requestId:b.requestId,dismissed:b.restore!==true})};
  }
  return {queue,status,attempt,dismiss};
}

export function createWebApp(root:string,mock=false,http:typeof fetch=fetch,imageRunner?:ImageRunner,quotaReader?:QuotaReader,publicReader:PublicReader=readPublic,tieba=new TiebaAccountClient()){
  prepare(root);loadSecrets(root);
  const store=new Store(root,mock?'webui-mock.sqlite':'webui.sqlite');
  const budgetStore=new Store(root,mock?'webui-mock-budget.sqlite':'fish.sqlite');
  const tiebaDismissals=createTiebaDismissals(store);
  const tiebaAttempt=()=>JSON.parse(budgetStore.getMeta('tieba:last-attempt')??'null');
  let replyHistory:{key:string;until:number;completed:any[]}|undefined;
  async function tiebaReplyQueue(offset:number,activeOnly:boolean,selectedId:string|undefined,filter:string){
    const first=await tieba.replyQueue(0,activeOnly,selectedId);
    if(first.view!=='replies')return tiebaDismissals.queue(first);
    const key=JSON.stringify([first.counts.completed,first.completed]);
    let completed=[...first.completed],page=first;
    // Filter before paginating, so ignored records on older pages remain
    // reachable and the filter counts describe the entire reply queue.
    if(!activeOnly){
      if(replyHistory?.key===key&&replyHistory.until>Date.now())completed=[...replyHistory.completed];
      else{
        while(page.hasMore&&page.limit>0&&page.offset+page.limit<=100000){
          const next=await tieba.replyQueue(page.offset+page.limit);
          if(next.offset<=page.offset)break;
          completed.push(...next.completed);page=next;
        }
        // Refresh the head each poll; avoid rereading every historical page
        // on each 2.5-second UI refresh. Old-page edits refresh within 10s.
        replyHistory={key,until:Date.now()+10000,completed};
      }
      if(first.selected)completed=completed.map(i=>i.id===first.selected.id?first.selected:i);
    }
    const annotated=tiebaDismissals.queue({...first,completed});
    const matches=(i:any)=>filter==='dismissed'?i.dismissed:!i.dismissed&&(filter!=='attention'||i.problem);
    const finished=annotated.completed.filter(matches),limit=first.limit;
    return {...annotated,active:annotated.active.filter(matches),completed:finished.slice(offset,offset+limit),
      counts:{...first.counts,totalCompleted:first.counts.completed,completed:finished.length},offset,limit,hasMore:offset+limit<finished.length};
  }
  const affect=new Affect(budgetStore);
  const activity=new ActivityHistory(root,store,budgetStore);
  const corpus=new Corpus(budgetStore,()=>privateQQNumbers({...loadConfig(root),...readQQSettings(root)}));
  const corpusQueue=(data:any)=>{
    const annotate=(item:any)=>{const reply=corpusTiebaReply(item);return {...item,...(reply?{corpusLike:{sourceKey:reply.source_key,liked:corpus.liked(reply.source_key)}}:{})};};
    return {...data,active:data.active?.map(annotate),completed:data.completed?.map(annotate),...(data.selected?{selected:annotate(data.selected)}:{})};
  };
  const corpusCandidates=async(record:Awaited<ReturnType<ActivityHistory['detail']>>)=>{
    const found=corpusReplyCandidates(record);
    // Publication tools may originally have returned only a queued receipt.
    // Resolve the current read-only queue record before offering a like.
    const ids=[...new Set(record.events.filter(event=>event.name==='publish_tieba'&&(event.args as any)?.action==='reply')
      .map(event=>event.result?.requestId).filter((id):id is string=>typeof id==='string'&&id.length<=240))];
    for(const id of ids){
      if(found.some(reply=>reply.source_key==='tieba:'+id))continue;
      try{const queue=await tieba.replyQueue(0,false,id),item=queue.selected??[...queue.active,...queue.completed].find(row=>row.id===id);
        const reply=item&&corpusTiebaReply(item);if(reply&&reply.source_key==='tieba:'+id)found.push(reply);
      }catch{/* Missing historical queue data does not establish delivery. */}
    }
    return found;
  };
  const corpusActivity=async(id:unknown)=>{const record=await activity.detail(id);return {...record,corpusLikes:(await corpusCandidates(record)).map(reply=>({sourceKey:reply.source_key,liked:corpus.liked(reply.source_key),preview:reply.reply_text.slice(0,120)}))};};
  const corpusToggleLike=async(input:Record<string,unknown>)=>{
    if(Object.keys(input).some(k=>!['activityId','sourceKey','queueId'].includes(k))||Boolean(input.activityId)===Boolean(input.queueId))throw new FishError('CORPUS_INPUT_INVALID');
    let reply;
    if(input.activityId){
      const candidates=await corpusCandidates(await activity.detail(input.activityId));
      reply=candidates.find(item=>item.source_key===input.sourceKey);
    }else{
      if(typeof input.queueId!=='string'||!input.queueId||input.queueId.length>240)throw new FishError('CORPUS_INPUT_INVALID');
      const queue=await tieba.replyQueue(0,false,input.queueId);
      const item=queue.selected??[...queue.active,...queue.completed].find(row=>row.id===input.queueId);
      if(item?.id===input.queueId)reply=corpusTiebaReply(item);
    }
    if(!reply)throw new FishError('CORPUS_REPLY_NOT_CONFIRMED');return corpus.toggleLike(reply);
  };
  const exploration=new ExplorationState(budgetStore,()=>liveModelConfig(validateConfig({...loadConfig(root),...JSON.parse(budgetStore.getMeta('settings')??'{}'),...readQQSettings(root)}),budgetStore));
  const activeExploration=()=>budgetStore.db.prepare("SELECT id,state,cancel FROM exploration_runs WHERE state IN ('queued','running') ORDER BY created DESC LIMIT 1").get()??null;
  store.db.exec(`CREATE TABLE IF NOT EXISTS web_sessions(id TEXT PRIMARY KEY,title TEXT,created INTEGER,updated INTEGER);
    CREATE TABLE IF NOT EXISTS web_turns(id TEXT PRIMARY KEY,sid TEXT,user TEXT,answer TEXT,trace TEXT,context TEXT,state TEXT,created INTEGER);`);
  const memory=new MemoryJournal(root,store);
  for(const t of store.db.prepare('SELECT id,sid,user,answer,state,created FROM web_turns ORDER BY created,rowid').all() as unknown as Turn[]){
    memory.record({id:t.id+':user',conversation:'web:'+t.sid,actor:'webui-local',role:'user',text:t.user,at:t.created,source:'existing-web-chat'});
    if(t.state==='completed')memory.record({id:t.id+':assistant',conversation:'web:'+t.sid,actor:'DeepSeekFish',role:'assistant',text:t.answer,at:t.created,source:'existing-web-chat'});
  }
  let settings:Settings={model:'deepseek-flash',maxOutputTokens:1024,dailyCny:loadConfig(root).dailyCny,groupDailyCny:loadConfig(root).groupDailyCny,search:false,codexQueue:false,groupChatSearch:loadConfig(root).groupChatSearch,curiosityPublicSearch:loadConfig(root).curiosityPublicSearch,curiosityAutoSummary:loadConfig(root).curiosityAutoSummary,...JSON.parse(store.getMeta('web-settings')??'{}')};
  const codexImageOnly=process.env.FISH_CODEX_IMAGE_ONLY==='1';
  if(codexImageOnly)settings.codexQueue=false;
  const balance=new DeepSeekBalance(()=>deepseekCredential(root),mock||/^(1|true)$/i.test(process.env.DEEPSEEK_MOCK??''),http);
  const openCodeQuota=new OpenCodeQuota(mock||mockProviderMode(),http);
  const sessions=():Session[]=>store.db.prepare('SELECT * FROM web_sessions ORDER BY updated DESC LIMIT 50').all() as unknown as Session[];
  const cfg=():Config=>{
    const {codexQueue,...common}=settings;
    const base=loadConfig(root);
    const inherited=base.provider==='deepseek'?common:{...common,model:base.model,maxOutputTokens:base.maxOutputTokens};
    return liveModelConfig(validateConfig({...defaults,...base,...inherited,...Object.fromEntries(Object.entries(JSON.parse(budgetStore.getMeta('settings')??'{}')).filter(([k])=>['search','dailyCny','groupDailyCny','groupChatSearch','curiosityPublicSearch','curiosityAutoSummary'].includes(k))),codex:codexQueue,
      groups:sessions().map(s=>'web:'+s.id),admins:['webui-local']}),budgetStore);
  };
  const credential=()=>{const config=cfg();return providerCredential(root,config.provider,config.keySlot);};
  const missingKey=()=>new FishError(cfg().provider==='opencode_go'?'OPENCODE_KEY_MISSING':'DEEPSEEK_KEY_MISSING');
  const ledger=new Ledger(budgetStore,cfg);
  const catalog=new OpenCodeCatalog(root,mock,http),provider=new RoutedChatModel(root,cfg,ledger,catalog,http);
  const connection=new ConnectionProfiles(root,budgetStore,cfg);
  const model=new WebModel(credential,cfg,ledger,mock,http,provider);
  const search=new SearchService(mock?new MockSearchProvider():new DeepSeekSearchProvider(()=>deepseekCredential(root),cfg,http),ledger,cfg);
  const tasks=new Tasks(root,store,ledger,cfg,mock?new MockTaskRunner():new AppServerRunner(root));
  const quota=new CodexQuotaMonitor(store,mock,quotaReader??new AppServerQuotaReader(root));
  const images=new WebImages(root,store,ledger,cfg,mock,quota,imageRunner);
  let qqBroker:Awaited<ReturnType<typeof startQQImageBroker>>|undefined;
  const tokenFile=safePath(root,'runtime/data/webui-admin-token');
  if(!fs.existsSync(tokenFile))writePrivate(root,'runtime/data/webui-admin-token',randomBytes(32).toString('hex'));
  const token=fs.readFileSync(tokenFile,'utf8').trim();
  const active=new Map<string,AbortController>();let accepting=true;
  function session(id:unknown):Session{
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw new FishError('INVALID_SESSION');
    const row=store.db.prepare('SELECT * FROM web_sessions WHERE id=?').get(id) as unknown as Session;
    if(!row)throw new FishError('SESSION_NOT_FOUND');return row;
  }
  function createSession():Session{
    if(sessions().length>=50)throw new FishError('SESSION_LIMIT');
    const id=randomUUID(),at=Date.now();new SessionWorkspace(root,id);
    store.db.prepare('INSERT INTO web_sessions VALUES (?,?,?,?)').run(id,'新的对话',at,at);return session(id);
  }
  function detail(id:unknown){
    const s=session(id);
    const turns=store.db.prepare('SELECT * FROM web_turns WHERE sid=? ORDER BY created,rowid').all(s.id) as unknown as Turn[];
    return {...s,busy:active.has(s.id),turns:turns.map(t=>({id:t.id,user:t.user,answer:t.answer,trace:JSON.parse(t.trace),images:images.list(s.id,t.id),state:t.state,created:t.created})),files:new SessionWorkspace(root,s.id).list()};
  }
  function configure(input:Record<string,unknown>){
    if(codexImageOnly&&input?.codexQueue===true)throw new FishError('CODEX_IMAGE_ONLY');
    const connectionFields=['apiKey','apiKeyProvider','apiKeySlot','provider','model','maxOutputTokens','keySlot','disableThinking','usdToCny','activePresetId'];
    const commonFields=['dailyCny','groupDailyCny','search','codexQueue','groupChatSearch','curiosityPublicSearch','curiosityAutoSummary'] as const;
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!connectionFields.includes(k)&&!commonFields.some(field=>field===k)))throw new FishError('INVALID_WEB_SETTINGS');
    const current=cfg(),next={...settings,dailyCny:current.dailyCny,groupDailyCny:current.groupDailyCny,
      groupChatSearch:current.groupChatSearch,curiosityPublicSearch:current.curiosityPublicSearch,curiosityAutoSummary:current.curiosityAutoSummary};
    for(const field of commonFields)if(field in input)(next as any)[field]=input[field];
    if(![next.dailyCny,next.groupDailyCny].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&Number.isSafeInteger(Math.round(n*1e9)))||
      typeof next.search!=='boolean'||typeof next.codexQueue!=='boolean'||
      ['groupChatSearch','curiosityPublicSearch','curiosityAutoSummary'].some(field=>typeof next[field as keyof Settings]!=='boolean'))throw new FishError('INVALID_WEB_SETTINGS');
    budgetStore.transaction(()=>{
      if(connectionFields.some(field=>field in input))connection.configure(input);
      const shared=JSON.parse(budgetStore.getMeta('settings')??'{}');
      for(const field of commonFields)if(field!=='codexQueue'&&input[field]!==undefined)shared[field]=next[field];
      budgetStore.setMeta('settings',JSON.stringify(shared));
    });
    settings=next;store.setMeta('web-settings',JSON.stringify(settings));return status();
  }
  function status({refreshOpenCodeQuota=false}={}){
    const config=cfg(),providers=connection.status(),go=providers.opencode_go;
    const goKey=go.configured?providerCredential(root,'opencode_go',go.keySlot):'';
    if(refreshOpenCodeQuota)void openCodeQuota.refresh(goKey);
    const opencodeQuota={configured:Object.values(go.keys).some(key=>key.configured),keyConfigured:go.configured,active:config.provider==='opencode_go',
      ...openCodeQuota.status(goKey)};
    return {app:'DeepSeekFish',mock,credentialPresent:!!credential(),providers,opencodeQuota,codexImageOnly,
    settings:{...settings,provider:config.provider,model:config.model,maxOutputTokens:config.maxOutputTokens,keySlot:config.keySlot??config.provider,
      disableThinking:config.disableThinking,
      usdToCny:config.usdToCny,connectionPresets:config.connectionPresets,activePresetId:config.activePresetId,search:config.search,
      dailyCny:config.dailyCny,groupDailyCny:config.groupDailyCny,groupChatSearch:config.groupChatSearch,curiosityPublicSearch:config.curiosityPublicSearch,
      curiosityAutoSummary:config.curiosityAutoSummary},
    web:{enabled:config.search,requests:ledger.value('search'),spentCny:toCny(Number((budgetStore.db.prepare("SELECT coalesce(sum(cost_nano),0) AS n FROM reservations WHERE day=? AND kind='search' AND allowance_reset=0").get(dayKey()) as any).n)),budget:'CNY',...networkPricing(config.model)},workspace:'每个会话独立；20个文本文件 / 合计1 MiB',
    corpus:corpus.status(),
    neonBusy:developmentDashboard(root,boundDevelopmentOwner(root),false).busy,
    companion:affect.status(),dailyQzone:dailyStatus(root,budgetStore),
    dailyNews:newsStatus(root,budgetStore),
    memory:{automaticDays:2,timezone:PROJECT_TIMEZONE,archive:'runtime/memory/days',persona:'personas/active.json'},
    imageLimits:{daily:config.imageDaily},codexQuota:quota.status(),agyQuota:readAgyQuota(root),deepseekBalance:balance.status(),
    capabilities:['会话文件列表','会话文本读写','明确请求后设计并生成单张图片',...(config.search?['公开搜索与网页读取']:[]),...(settings.codexQueue?['提交 Codex 待审任务']:[])],
    budgets:{cost:ledger.costSummary(),dailyCny:cfg().dailyCny,groupDailyCny:cfg().groupDailyCny,usage:ledger.snapshot(),fault:budgetStore.getMeta('budgetFault')??null},
    tasks:tasks.list().map(t=>({id:t.id,sessionId:t.grp.slice(4),request:t.request,brief:t.brief,state:t.state,result:t.result})),active:active.size};}
  async function execute(s:Session,name:string,args:any,signal?:AbortSignal){
    if(!args||typeof args!=='object'||Array.isArray(args))throw new FishError('INVALID_TOOL_ARGS');
    const schema=tools.find(t=>t.function.name===name)?.function.parameters;
    if(!schema)throw new FishError('TOOL_NOT_ALLOWED');
    const fields=Object.keys(schema.properties as object),required=(schema.required??[]) as string[];
    if(Object.keys(args).some(k=>!fields.includes(k))||required.some(k=>!(k in args)||typeof args[k]!==(({integer:'number',array:'object'} as Record<string,string>)[(schema.properties as any)[k].type as string]??(schema.properties as any)[k].type)))throw new FishError('INVALID_TOOL_ARGS');
    const workspace=new SessionWorkspace(root,s.id);
    switch(name){
      case 'get_knowledge':return knowledgeSnapshot(root);
      case 'update_knowledge':return updateKnowledge(root,args);
      case 'list_files':return workspace.list();
      case 'read_file':return {path:args.path,content:workspace.read(args.path)};
      case 'write_file':return workspace.write(args.path,args.content);
      case 'search_web':return searchEvidence(await search.search(args.query,'web:'+s.id,'webui-local',args.fresh));
      case 'browse_page':{
        const page=await browsePage(args.url,args.offset,signal,publicReader,args.query,args.textOffset);
        const posts=tiebaTextPosts(page,page.text);
        return posts?{...page,text:undefined,posts}:page;
      }
      case 'fetch_page':return search.fetch(args.url,'web:'+s.id,'webui-local',args.offset,args.fresh);
      case 'queue_codex':{
        if(typeof args.task!=='string'||args.task.length>1500)throw new FishError('INVALID_TASK_BRIEF');
        const t=tasks.enqueue({id:randomUUID(),group:'web:'+s.id,user:'webui-local',text:'',mentioned:true,at:Date.now(),event:'mention'},args.task,args.task);
        return {id:t.id,state:'waiting',approvalRequired:true,command:'npm run cli -- web-approve '+t.id+' --reviewed'};
      }
      default:throw new FishError('TOOL_NOT_ALLOWED');
    }
  }
  async function chat(id:unknown,text:unknown,mode:unknown,signal:AbortSignal,emit:(e:WebEvent)=>void,imageConfirmed=false){
    const s=session(id);
    if(!accepting)throw new FishError('SERVER_STOPPING');
    if(typeof text!=='string'||!text.trim()||text.length>4000||!['chat','agent','image'].includes(String(mode)))throw new FishError('INVALID_MESSAGE');
    if(!mock&&!credential())throw missingKey();
    if(active.has(s.id)||active.size>=2)throw new FishError('CHAT_BUSY');
    const count=Number((store.db.prepare('SELECT count(*) AS n FROM web_turns WHERE sid=?').get(s.id) as any).n);
    if(count>=100)throw new FishError('CONVERSATION_LIMIT_CREATE_NEW');
    const controller=new AbortController();active.set(s.id,controller);
    const imageRequest=mode==='image'||requestsImage(text);
    const joined=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(imageRequest?cfg().codexTimeoutMs+90000:120000)]),turnId=randomUUID(),trace:any[]=[];
    const prior=store.db.prepare("SELECT id,context,created FROM web_turns WHERE sid=? AND state='completed' AND created>=? ORDER BY created DESC,rowid DESC LIMIT 3").all(s.id,dayStart()-86400000) as {id:string;context:string;created:number}[];
    const history=prior.reverse().flatMap(t=>(JSON.parse(t.context) as WireMessage[]).map(m=>{
      if(m.role==='user')return {...m,content:'[此轮开始于香港时间 '+projectTime(t.created)+'] '+m.content};
      if(m.role==='tool'){
        // Older saved tool receipts can contain raw epochs or UTC metadata.
        try{return {...m,content:modelTimeJson(JSON.parse(m.content))};}catch{ /* May be a retained excerpt. */ }
      }
      return m;
    }));
    // Whole completed turns only: never orphan tool results when trimming context.
    while(Buffer.byteLength(JSON.stringify(history))>24000&&history.length){history.splice(0,history.findIndex((m,i)=>i>0&&m.role==='user')>0?history.findIndex((m,i)=>i>0&&m.role==='user'):history.length);}
    const feedback=new UnreadFeedback(store,'web:'+s.id),pending=feedback.previous();
    const receipts:WireMessage[]=pending.previousToolErrors?[{role:'system',content:modelTimeJson(pending)}]:[];
    const recalled=memory.recall('web:'+s.id,text,prior.flatMap(t=>[{id:t.id+':user'},{id:t.id+':assistant'}]));
    const memoryContext:WireMessage[]=recalled.events.length||recalled.needsReference?[{role:'user',content:modelTimeJson({memory:recalled})}]:[];
    const personaMessage:WireMessage={role:'system',content:personalityPrompt(root)};
    const current:WireMessage[]=[{role:'user',content:redact(text.trim())}],sent:WireMessage[]=[{role:'system',content:webPrompt(root)},...receipts,...memoryContext,...history];
    const offered=mode==='agent'?tools.filter(t=>!['search_web','fetch_page','browse_page'].includes(t.function.name)||cfg().search).filter(t=>t.function.name!=='queue_codex'||settings.codexQueue):[];
    store.db.prepare('INSERT INTO web_turns VALUES (?,?,?,?,?,?,?,?)').run(turnId,s.id,current[0].content,'','[]','[]','running',Date.now());
    store.db.prepare('UPDATE web_sessions SET title=?,updated=? WHERE id=?').run(s.title==='新的对话'?redact(text.trim()).slice(0,26):s.title,Date.now(),s.id);
    let answer='',calls=0,mood:string|undefined;
    const saveTrace=()=>store.db.prepare('UPDATE web_turns SET trace=?,context=? WHERE id=?').run(JSON.stringify(diagnosticSafe(trace)),JSON.stringify(diagnosticSafe(current)),turnId);
    const record=(event:any,publish=true)=>{trace.push(event);saveTrace();if(publish)emit({type:'tool',event});};
    try{
      memory.record({id:turnId+':user',conversation:'web:'+s.id,actor:'webui-local',role:'user',text:current[0].content,at:Date.now(),source:'web'});
      if(!imageRequest){
        try{
          affect.feedback('web:'+turnId,text,true);
          mood=affect.expression();
        }catch{/* Chat remains available if state recording fails. */}
      }
      emit({type:'start',turnId});
      if(imageRequest){
        const image=await images.generate(s.id,turnId,current[0].content,[...receipts,...memoryContext,...history],model,joined,e=>{
          if(e.type==='image_plan')feedback.acknowledged();
          if(e.type==='model_usage')record({name:'model_usage',state:'completed',usage:e.usage},false);
          else if(e.type==='image_plan')record({name:'image_plan',state:'completed',plan:e.plan,character:e.character,mock:e.mock,result:JSON.stringify(e.plan)});
          else if(e.type==='codex_record')record({name:'codex_record',state:e.error?'failed':'completed',result:JSON.stringify(e.record,null,2)});
          else emit(e);
        },imageConfirmed===true,{trace,save:saveTrace});
        answer=image.mock?'【离线演示】画面方案和出图流程已走通。下方是固定的 1×1 PNG 测试占位，不是 AI 作品；未调用 DeepSeek 或 Codex。':'画好啦，图片已通过校验，可以预览或下载。';
        current.push({role:'assistant',content:answer});
        store.db.prepare("UPDATE web_turns SET answer=?,context=?,state='completed' WHERE id=?").run(answer,JSON.stringify(current),turnId);
        memory.record({id:turnId+':assistant',conversation:'web:'+s.id,actor:'DeepSeekFish',role:'assistant',text:answer,at:Date.now(),source:'web'});
        emit({type:'answer',text:answer});emit({type:'done',turnId});return;
      }
      const used=new Set<string>(),corpusContext={platform:'web' as const,conversation:'web:'+s.id,contextId:turnId};
      const corpusReference=corpus.reference(corpusContext,text.slice(0,8000));
      for(let round=0;round<5;round++){
        joined.throwIfAborted();emit({type:'thinking',round:round+1});
        const guidance=[clockPrompt(),mood,corpus.enabled(corpusContext)?corpusReference:''].filter(Boolean).join('\n');
        const messages:WireMessage[]=[...sent,...current,{role:'system',content:guidance},personaMessage],final=round>=3||calls>=6;
        const m=await traceModel(trace,saveTrace,modelPayload(cfg(),messages,cfg().maxOutputTokens,{tools:offered,final}),round,onReservation=>model.complete('web:'+s.id,messages,offered,joined,final,onReservation));
        joined.throwIfAborted();
        feedback.acknowledged();
        if(!m.tool_calls?.length){
          answer=redact(m.content).slice(0,16000);current.push({role:'assistant',content:answer});break;
        }
        if(!offered.length||round>=3||calls+m.tool_calls.length>6)throw new FishError('TOOL_LIMIT_OR_DISABLED');
        current.push({role:'assistant',content:m.content,tool_calls:m.tool_calls});
        for(const c of m.tool_calls){
          joined.throwIfAborted();
          if(used.has(c.id))throw new FishError('DUPLICATE_TOOL_CALL');used.add(c.id);calls++;
          let result:unknown;
          try{
            if(!offered.some(t=>t.function.name===c.function.name))throw new FishError('TOOL_NOT_ALLOWED');
            const args=toolArgs(c.function.arguments);
            result=await execute(s,c.function.name,args,joined);
            record({name:c.function.name,state:actionState(result),round,callId:c.id,args:toolArgs(c.function.arguments),result:redact(JSON.stringify(result))});
          }catch(e){result=toolFailure(e,c.function.name);record({name:c.function.name,state:'failed',round,callId:c.id,args:c.function.arguments,result:JSON.stringify(result),diagnostic:errorDiagnostic(e)});}
          feedback.record(c.function.name,result);current.push({role:'tool',tool_call_id:c.id,content:['get_knowledge','update_knowledge'].includes(c.function.name)?modelTimeJson(result):redact(modelTimeJson(result)).slice(0,18000)});
        }
      }
      joined.throwIfAborted();if(!answer)throw new FishError('DEEPSEEK_EMPTY_RESPONSE');
      store.db.prepare("UPDATE web_turns SET answer=?,context=?,state='completed' WHERE id=?").run(answer,JSON.stringify(current),turnId);
      memory.record({id:turnId+':assistant',conversation:'web:'+s.id,actor:'DeepSeekFish',role:'assistant',text:answer,at:Date.now(),source:'web'});
      emit({type:'answer',text:answer});emit({type:'done',turnId});
    }catch(e){
      const error=joined.aborted?'CHAT_CANCELLED':codeOf(e);if(imageRequest)feedback.record('generate_image',toolFailure(e,'generate_image'));
      record({error,phase:'turn',diagnostic:errorDiagnostic(e),at:Date.now()},false);
      store.db.prepare("UPDATE web_turns SET answer=?,state='failed' WHERE id=?").run(error,turnId);emit({type:'error',error});
    }finally{active.delete(s.id);}
  }
  function recover(){
    store.db.exec("UPDATE web_turns SET state='failed',answer='PROCESS_RESTART' WHERE state='running'; UPDATE tasks SET state='failed',result='PROCESS_RESTART_REQUIRES_REVIEW' WHERE state='running'");
    // Only this UI's reservations; never clear a QQ or standalone Codex lease.
    budgetStore.db.exec("UPDATE reservations SET state='unknown',cost_status=CASE WHEN cost_status='held' THEN 'unknown' ELSE cost_status END WHERE state='held' AND grp LIKE 'web:%'");
  }
  async function close(){accepting=false;openCodeQuota.close();await qqBroker?.close();for(const c of active.values())c.abort();await tasks.stop();
    while(active.size)await new Promise(resolve=>setTimeout(resolve,10));await quota.close();store.close();budgetStore.close();}
  return {root,mock,token,
    corpus: (params:Record<string,unknown>)=>corpus.list(params),corpusSettings:(input:unknown)=>corpus.configure(input),corpusExtract:(input:unknown)=>corpus.requestExtraction(input),
    corpusCreate:(input:unknown)=>corpus.save(input,{human:true,origin:'webui'}),corpusUpdate:(input:unknown)=>corpus.update(input),
    corpusStatus:(input:unknown)=>corpus.setStatus(input),corpusDelete:(input:unknown)=>corpus.delete(input),
    corpusLikes:(params:Record<string,unknown>)=>corpus.likes(params),corpusToggleLike,corpusDeleteLikes:(input:unknown)=>corpus.deleteLikes(input),corpusQueue,
    exploration,tieba,tiebaAttempt:()=>tiebaDismissals.attempt(tiebaAttempt()),
    tiebaStatus:async()=>tiebaDismissals.status(await tieba.status(),tiebaAttempt()),
    tiebaStatusView:(value:any)=>tiebaDismissals.status(value,tiebaAttempt()),
    tiebaQueue:(data:any)=>tiebaDismissals.queue(data),tiebaReplyQueue,tiebaDismiss:(input:unknown)=>tiebaDismissals.dismiss(input),
    companion:()=>affect.status(),configureCompanion:(input:Record<string,unknown>)=>affect.configure(input),
    tiebaSections:()=>tiebaSectionSettings(root),saveTiebaSections:(input:unknown)=>saveTiebaSectionSettings(root,input),
    tiebaRead:async(input:any)=>{if(!input||Object.keys(input).some(k=>!['url','mode'].includes(k))||typeof input.url!=='string'||input.url.length>4096||!['public','account'].includes(input.mode)||!tiebaTarget(new URL(input.url)))throw new FishError('TIEBA_READ_TARGET_DENIED');return input.mode==='account'?tieba.read(input.url):browsePage(input.url,0,undefined,publicReader);},
    tiebaAudit:(action:string,result:any)=>budgetStore.audit('tieba-account','web',JSON.stringify({action,state:result?.state,error:result?.error??result?.lastError?.code,at:Date.now()})),
    activity:(params:URLSearchParams,signal?:AbortSignal)=>activity.list(params,signal),activityDetail:(id:unknown)=>corpusActivity(id),activityImage:(id:unknown)=>activity.image(id),
    neon:()=>developmentDashboard(root,boundDevelopmentOwner(root)),
    neonRecord:(kind:unknown,id:unknown)=>developmentRecord(root,kind,id),
    neonResetConversation:(input:Record<string,unknown>)=>{
      if(Object.keys(input).length)throw new FishError('INVALID_TOOL_ARGS');
      if(!developmentDashboard(root,boundDevelopmentOwner(root),false).bridge)throw new FishError('DEV_AGY_BRIDGE_UNAVAILABLE');
      return requestConversationReset(root);
    },
    neonInterrupt:(input:Record<string,unknown>)=>{
      if(Object.keys(input).some(key=>key!=='taskId'))throw new FishError('INVALID_TOOL_ARGS');
      return {ok:true,developmentRequested:requestDevelopmentInterrupt(root,boundDevelopmentOwner(root),input.taskId)};
    },
    activityActive:()=>{
      const owner=boundDevelopmentOwner(root);
      return {chains:owner?activityChainActive(budgetStore,owner):[],exploration:activeExploration(),
        development:developmentDashboard(root,owner,false).active};
    },
    activityInterrupt:(input:Record<string,unknown>)=>{
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['chainId','runId','taskId'].includes(key))||
        [input.chainId,input.runId,input.taskId].filter(id=>id!==undefined).length>1)throw new FishError('INVALID_TOOL_ARGS');
      const owner=boundDevelopmentOwner(root);
      const empty={ok:true,stopped:[],settling:[],explorationRequested:false,developmentRequested:[]};
      if(input.taskId!==undefined)return {...empty,developmentRequested:requestDevelopmentInterrupt(root,owner,input.taskId)};
      if(input.chainId!==undefined&&!owner)throw new FishError('ACTIVITY_CHAIN_NOT_FOUND');
      const result=input.runId===undefined&&owner?interruptActivityChains(budgetStore,owner,input.chainId):empty;
      if(input.chainId!==undefined)return {...empty,...result};
      const runId=input.runId??activeExploration()?.id;
      return {...result,explorationRequested:runId!==undefined&&exploration.cancel(runId).requested===true,
        developmentRequested:input.runId===undefined?requestDevelopmentInterrupt(root,owner):[]};
    },
    persona:()=>personaSettings(root),savePersona:(input:unknown)=>savePersona(root,input),
    prompts:()=>({systems:promptSystems(root),knowledge:knowledgeSnapshot(root),latest:promptSnapshots(budgetStore)}),
    sessions,session,createSession,detail,configure,status,chat,tasks,recover,close,
    saveConnectionPreset:(input:Record<string,unknown>)=>{budgetStore.transaction(()=>connection.save(input));return status();},
    deleteConnectionPreset:(input:Record<string,unknown>)=>{budgetStore.transaction(()=>connection.delete(input));return status();},
    opencodeModels:(slot?:string)=>catalog.get(slot??connection.status().opencode_go.keySlot),
    refreshOpencodeModels:(input:Record<string,unknown>)=>{
      if(Object.keys(input).some(k=>k!=='keySlot')||input.keySlot!==undefined&&typeof input.keySlot!=='string')throw new FishError('INVALID_KEY_SLOT');
      return catalog.get((input.keySlot as string|undefined)??connection.status().opencode_go.keySlot,true);
    },
    startQQBroker:async()=>{if(!qqBroker)qqBroker=await startQQImageBroker(root,budgetStore,quota,mock,imageRunner);},
    configureQQ:(input:Record<string,unknown>)=>{if(input.enabled&&!credential())throw missingKey();return configureQQ(root,input,connection.status().deepseek.model);},qqStatus:()=>qqStatus(root,budgetStore),
    startQuota:()=>quota.start(),refreshQuota:async()=>{await quota.refresh(true);return status();},
    pollBalance:()=>balance.refresh(),
    refreshDeepSeekBalance:(input:Record<string,unknown>)=>{
      if(Object.keys(input).length)throw new FishError('INVALID_TOOL_ARGS');
      return balance.refresh(true);
    },
    refreshAgyQuota:(input:Record<string,unknown>)=>{
      if(Object.keys(input).length)throw new FishError('INVALID_TOOL_ARGS');
      requestAgyQuotaRefresh(root);
      return readAgyQuota(root);
    },
    resetImages:()=>{if(active.size)throw new FishError('IMAGE_RESET_BUSY_OR_UNCERTAIN');ledger.resetImages();return status();},
    resetCosts:()=>{const costReset=ledger.resetCosts();return {...status(),costReset};},
    image:(sid:unknown,id:unknown)=>images.read(session(sid).id,id),workspace:(id:unknown)=>new SessionWorkspace(root,session(id).id)};
}
export type WebApp=ReturnType<typeof createWebApp>;
