import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { prepare, loadConfig, loadSecrets, validateConfig, type Config } from './config.js';
import { safePath, writePrivate } from './paths.js';
import { Store } from './storage/db.js';
import { Ledger } from './budget/ledger.js';
import { BudgetedModel, DeepSeekModel, MockModel } from './agent/model.js';
import { Tasks } from './codex/tasks.js';
import { AppServerRunner, MockTaskRunner } from './codex/runner.js';
import { DeepSeekSearchProvider, MockSearchProvider, SearchService } from './search/provider.js';
import { MockImageProvider, CodexImageProvider } from './image/provider.js';
import { Bot } from './agent/bot.js';
import { credentials, MockTransport, QQTransport } from './qq/adapter.js';
import { FishError } from './types.js';

export function createApp(root:string,mock:boolean,override:Partial<Config>={},demo=false){
  prepare(root);loadSecrets(root);
  const store=new Store(root,demo?'demo.sqlite':mock?'mock.sqlite':'fish.sqlite');const base=loadConfig(root);
  let config=validateConfig({...base,...JSON.parse(store.getMeta('settings')??'{}'),...override});
  if(mock)config={...config,groups:config.groups.length?config.groups:['demo-group'],admins:config.admins.length?config.admins:['demo-admin']};
  const cfg=()=>config;
  const ledger=new Ledger(store,cfg),provider=mock?new MockModel():new DeepSeekModel(process.env.DEEPSEEK_API_KEY??'',cfg);
  const model=new BudgetedModel(provider,ledger,cfg);
  const tasks=new Tasks(root,store,ledger,cfg,mock?new MockTaskRunner():new AppServerRunner(root));
  const search=new SearchService(mock?new MockSearchProvider():new DeepSeekSearchProvider(process.env.DEEPSEEK_API_KEY??'',cfg),ledger,cfg);
  let bot:Bot;
  const creds=mock?undefined:credentials(root);
  if(!mock&&!creds){store.close();throw new FishError('QQ_CREDENTIALS_MISSING_RUN_BIND');}
  if(!mock&&!process.env.DEEPSEEK_API_KEY){store.close();throw new FishError('DEEPSEEK_KEY_MISSING');}
  const transport=mock?new MockTransport():new QQTransport(creds!.appId,creds!.appSecret,store,m=>bot.receive(m),group=>cfg().groups.includes(group));
  bot=new Bot(root,cfg,store,ledger,model,tasks,search,mock?new MockImageProvider():new CodexImageProvider(),transport);
  const tokenPath=safePath(root,'runtime/data/admin-token');
  if(!fs.existsSync(tokenPath))writePrivate(root,'runtime/data/admin-token',randomBytes(32).toString('hex'));
  const token=fs.readFileSync(tokenPath,'utf8').trim();
  function set(key:string,value:unknown):void{
    // Permission lists and resource boundaries are deployment config only.
    if(!['enabled','autonomous','autoReply','search','codex','images','dailyTokens','groupDailyTokens','userDailyRequests','maxOutputTokens','searchDaily','codexDaily','codexDailyMs','probability','activity','cooldownMs','dailyInterjections','maxChars','quietHours'].includes(key))throw new FishError('SETTING_NOT_MUTABLE');
    config=validateConfig({...config,[key]:value});
    const saved=JSON.parse(store.getMeta('settings')??'{}');saved[key]=value;store.setMeta('settings',JSON.stringify(saved));
    if((key==='enabled'||key==='codex')&&value===false)void tasks.stop();
    store.audit('setting','',key+'='+String(value));
  }
  const status=()=>({mode:mock?'mock':'live',enabled:config.enabled,qq:transport.status,
    deepseek:{provider:provider.kind,model:config.model,credentialPresent:!!process.env.DEEPSEEK_API_KEY,status:store.getMeta('modelStatus')??'not probed'},
    codex:{enabled:config.codex,provider:mock?'mock':'official-app-server',unattended:false,localApprovalRequired:true,
      projectLoginPresent:fs.existsSync(safePath(root,'runtime/codex-home/auth.json')),isolation:mock?'mock only':'Windows MXC + per-run canary required; not certified on this host'},
    features:{autonomous:config.autonomous,search:config.search,images:config.images},
    budgets:{dailyTokens:config.dailyTokens,maxOutputTokens:config.maxOutputTokens,usage:ledger.snapshot(),fault:store.getMeta('budgetFault')??null},
    groups:config.groups.map(group=>({group,ordinaryMessages:store.getMeta('qqOrdinary:'+group)?'observed':'unverified; mention-only capability assumed'})),
    groupCount:config.groups.length,tasks:tasks.list().map(t=>({id:t.id,group:t.grp,state:t.state,created:t.created,result:t.result})),
    recent:store.db.prepare('SELECT at,kind,grp,detail FROM audit ORDER BY id DESC LIMIT 30').all()});
  return {root,store,ledger,model,tasks,bot,transport,token,cfg,set,status,mock};
}
export type App=ReturnType<typeof createApp>;
