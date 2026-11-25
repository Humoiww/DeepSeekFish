import { networkPricing } from './budget/pricing.js';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { prepare, loadConfig, loadSecrets, validateConfig, deepseekCredential, providerCredential, conversationAllowed, type Config } from './config.js';
import { safePath, writePrivate } from './paths.js';
import { Store } from './storage/db.js';
import { Ledger } from './budget/ledger.js';
import { BudgetedModel, RoutedChatModel, MockModel } from './agent/model.js';
import { Tasks } from './codex/tasks.js';
import { AppServerRunner, MockTaskRunner } from './codex/runner.js';
import { DeepSeekSearchProvider, MockSearchProvider, SearchService } from './search/provider.js';
import { MockImageProvider, CodexImageProvider } from './image/provider.js';
import { Bot } from './agent/bot.js';
import { credentials, MockTransport, QQTransport } from './qq/adapter.js';
import { OneBotTransport,onebotCredential } from './qq/onebot.js';
import { readQQSettings } from './qq/settings.js';
import { PersonMemory } from './memory/people.js';
import { FishError } from './types.js';
import { boundaryStatus } from './codex/platform.js';
import { QQImageClient } from './qq/image-client.js';
import { QzoneMemory } from './memory/qzone.js';
import { QQMedia } from './qq/media.js';
import { PROJECT_TIMEZONE } from './time.js';
import { dailyStatus } from './qq/daily-qzone.js';
import { ActivityChains } from './qq/activity-chain.js';
import { newsStatus } from './qq/daily-news.js';
import { ForwardRecords } from './qq/forward.js';
import { QQAttachments } from './qq/received-attachments.js';
import { ExplorationState } from './exploration/state.js';
import { ExplorationWorker } from './exploration/worker.js';
import { QQImageLibrary } from './qq/image-library.js';
import { QzonePublisher } from './qq/qzone-publish.js';
import { Affect } from './affect.js';
import { ExternalPeople } from './memory/external-people.js';
import {CorpusExtractWorker} from './memory/corpus-extract.js';
import {CuriositySummaryWorker} from './memory/curiosity-summary.js';

import {liveModelConfig} from './provider/connections.js';
import {OpenCodeCatalog} from './provider/opencode.js';

export function createApp(root:string,mock:boolean,override:Partial<Config>={},demo=false){
  prepare(root);loadSecrets(root);
  const store=new Store(root,demo?'demo.sqlite':mock?'mock.sqlite':'fish.sqlite');const base=loadConfig(root);
  const {enabled:qqEnabled,...qqBase}=readQQSettings(root);
  let config=validateConfig({...base,...qqBase,...JSON.parse(store.getMeta('settings')??'{}'),...override});
  if(process.env.FISH_CODEX_IMAGE_ONLY==='1')config.codex=false;
  if(mock)config={...config,groups:config.groups.length?config.groups:['demo-group'],admins:config.admins.length?config.admins:['demo-admin']};
  const cfg=()=>{const saved=readQQSettings(root),{enabled,...options}=saved,shared=JSON.parse(store.getMeta('settings')??'{}');return liveModelConfig(validateConfig({...config,...options,...Object.fromEntries(['search','dailyCny','groupDailyCny','groupChatSearch','curiosityPublicSearch','curiosityAutoSummary'].filter(k=>shared[k]!==undefined).map(k=>[k,shared[k]])),enabled:config.enabled&&enabled!==false,codex:process.env.FISH_CODEX_IMAGE_ONLY==='1'?false:config.codex}),store);};
  const ledger=new Ledger(store,cfg);
  const provider=mock?new MockModel():new RoutedChatModel(root,cfg,ledger,new OpenCodeCatalog(root,mock));
  const credential=()=>{const config=cfg();return providerCredential(root,config.provider,config.keySlot);};
  const model=new BudgetedModel(provider,ledger,cfg);
  const tasks=new Tasks(root,store,ledger,cfg,mock?new MockTaskRunner():new AppServerRunner(root));
  const search=new SearchService(mock?new MockSearchProvider():new DeepSeekSearchProvider(()=>deepseekCredential(root),cfg),ledger,cfg);
  let bot:Bot;
  const creds=mock||config.qqTransport==='onebot'?undefined:credentials(root);
  if(!mock&&config.qqTransport==='official'&&!creds){store.close();throw new FishError('QQ_CREDENTIALS_MISSING_RUN_BIND');}
  let transport:MockTransport|QQTransport|OneBotTransport;
  try{transport=mock?new MockTransport():config.qqTransport==='onebot'?
    new OneBotTransport(root,config.onebotUrl,onebotCredential(root),store,m=>bot.receive(m),group=>conversationAllowed(cfg(),group)):
    new QQTransport(creds!.appId,creds!.appSecret,store,m=>bot.receive(m),group=>cfg().groups.includes(group));
  }catch(e){store.close();throw e;}
  const media=transport instanceof OneBotTransport?new QQMedia(root,store,file=>(transport as OneBotTransport).imageUrl(file)):undefined;
  const forwards=transport instanceof OneBotTransport?new ForwardRecords(store,transport,group=>conversationAllowed(cfg(),group),media):undefined;
  const receivedAttachments=transport instanceof OneBotTransport?new QQAttachments(root,store,transport,group=>cfg().enabled&&conversationAllowed(cfg(),group)):undefined;
  const people=transport instanceof OneBotTransport?new PersonMemory(root,store,transport,cfg):undefined;
  const imageClient=transport instanceof OneBotTransport?new QQImageClient(root):undefined;
  const qzone=transport instanceof OneBotTransport?new QzoneMemory(root,store,transport,cfg):undefined;
  const affect=new Affect(store);
  const externalPeople=new ExternalPeople(root,mock||demo);
  const explorationState=new ExplorationState(store,()=>({...cfg(),enabled:cfg().enabled&&readQQSettings(root).enabled!==false}));
  bot=new Bot(root,cfg,store,ledger,model,tasks,search,mock?new MockImageProvider():new CodexImageProvider(),transport,
    people,imageClient,qzone,
    media,forwards,receivedAttachments,affect,{memory:externalPeople,owner:()=>explorationState.settings().owner});
  store.db.exec('CREATE TABLE IF NOT EXISTS qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT,PRIMARY KEY(conversation,message_id))');
  const exploration=new ExplorationWorker(explorationState,model,{root,cfg,ledger,search,transport,tasks,media:media??new QQMedia(root,store),library:new QQImageLibrary(root,store),images:imageClient,people,qzone,forwards,externalPeople,
    ...(transport instanceof OneBotTransport?{publisher:async()=>new QzonePublisher(transport as OneBotTransport,(await transport.identity()).userId)}:{})},Date.now,affect);
  const activityChains=transport instanceof OneBotTransport?new ActivityChains(root,store,model,(owner,followUp)=>{
    try{return fs.readFileSync(safePath(root,'config/development-owner'),'utf8').trim()===owner&&
      conversationAllowed(cfg(),'private:'+owner)&&cfg().enabled&&readQQSettings(root).enabled!==false&&
      (followUp==='tools'||explorationState.settings().allowPublicPosts);}
    catch{return false;}
  },async()=>{
    if(transport.status!=='connected')throw new FishError('ACTIVITY_CHAIN_TRANSPORT_WAITING');
    return new QzonePublisher(transport,(await transport.identity()).userId);
  },Date.now,(run,context,signal,guard)=>exploration.toolsFor(run,context,signal,guard)):undefined;
  bot.activityChains=activityChains;
  const curiositySummary=new CuriositySummaryWorker(root,store,cfg,model);
  const corpusExtract=new CorpusExtractWorker(root,store,cfg,model);
  const tokenPath=safePath(root,'runtime/data/admin-token');
  if(!fs.existsSync(tokenPath))writePrivate(root,'runtime/data/admin-token',randomBytes(32).toString('hex'));
  const token=fs.readFileSync(tokenPath,'utf8').trim();
  function set(key:string,value:unknown):void{
    if(key==='codex'&&value===true&&process.env.FISH_CODEX_IMAGE_ONLY==='1')throw new FishError('CODEX_IMAGE_ONLY');
    // Permission lists and resource boundaries are deployment config only.
    if(!['enabled','autonomous','autoReply','search','codex','images','dailyCny','groupDailyCny','maxOutputTokens','probability','activity','cooldownMs','dailyInterjections','maxChars','quietHours'].includes(key))throw new FishError('SETTING_NOT_MUTABLE');
    config=validateConfig({...config,[key]:value});
    const saved=JSON.parse(store.getMeta('settings')??'{}');saved[key]=value;store.setMeta('settings',JSON.stringify(saved));
    if((key==='enabled'||key==='codex')&&value===false)void tasks.stop();
    store.audit('setting','',key+'='+String(value));
  }
  function projectLoginPresent(){
    try{return fs.existsSync(safePath(root,'runtime/codex-home/auth.json'));}catch{return false;}
  }
  const status=()=>({mode:mock?'mock':'live',enabled:cfg().enabled,qq:transport.status,privateUsers:cfg().privateUsers,
    exploration:explorationState.status(),corpus:corpusExtract.status(),
    dailyQzone:dailyStatus(root,store),
    dailyNews:newsStatus(root,store),
    memory:{archive:'runtime/memory/days',automaticDays:2,timezone:PROJECT_TIMEZONE,events:(store.db.prepare('SELECT count(*) AS n FROM memory_events').get() as any).n,persona:'personas/active.json'},
    qqTransport:config.qqTransport,
    groupTrigger:{mode:'mention-or-keyword',keywords:cfg().names},
    deepseek:{provider:mock?'mock':cfg().provider,model:cfg().model,credentialPresent:!mock&&!!credential(),status:store.getMeta('modelStatus')??'not probed'},
    codex:{enabled:config.codex,provider:mock?'mock':'official-app-server',unattended:false,localApprovalRequired:true,
      projectLoginPresent:projectLoginPresent(),isolation:mock?'mock only':boundaryStatus(root)},
    features:{autonomous:config.autonomous,search:cfg().search,images:config.images,groupChatSearch:cfg().groupChatSearch,curiosityPublicSearch:cfg().curiosityPublicSearch,curiosityAutoSummary:cfg().curiosityAutoSummary},web:{enabled:cfg().search,requests:ledger.value('search'),budget:'CNY',...networkPricing(cfg().model)},
    budgets:{cost:ledger.costSummary(),dailyCny:cfg().dailyCny,groupDailyCny:cfg().groupDailyCny,maxOutputTokens:cfg().maxOutputTokens,usage:ledger.snapshot(),fault:store.getMeta('budgetFault')??null},
    groups:cfg().groups.map(group=>({group,ordinaryMessages:store.getMeta('qqOrdinary:'+group)?'observed':'unverified; mention-only capability assumed'})),
    groupCount:cfg().groups.length,tasks:tasks.list().map(t=>({id:t.id,group:t.grp,state:t.state,created:t.created,result:t.result})),
    recent:store.db.prepare('SELECT at,kind,grp,detail FROM audit ORDER BY id DESC LIMIT 30').all()});
  return {root,store,ledger,model,tasks,bot,transport,token,cfg,set,status,mock,exploration,explorationState,activityChains,curiositySummary,corpusExtract,search};
}
export type App=ReturnType<typeof createApp>;
