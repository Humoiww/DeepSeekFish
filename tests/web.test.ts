import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { fixture,assertPersonaLayout,seedVoiceExamples } from './helpers.js';
import { createWebApp,createTiebaDismissals } from '../src/web/app.js';
import { webServer } from '../src/web/server.js';
import { SessionWorkspace } from '../src/web/workspace.js';
import type { WireMessage } from '../src/web/model.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';
import { Store } from '../src/storage/db.js';
import { MemoryJournal } from '../src/memory/journal.js';
import {createApp} from '../src/app.js';
import {DeepSeekBalance,parseDeepSeekBalance} from '../src/web/deepseek-balance.js';
import {bridgeViewDir,processAgyQuotaRefresh} from '../src/development/bridge-view.js';

const reply=(message:any,usage={prompt_tokens:20,completion_tokens:10})=>new Response(JSON.stringify({choices:[{message}],usage}));
const call=(id:string,name:string,args:unknown)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
function web(mock=true,http?:typeof fetch){const f=fixture();const app=createWebApp(f.root,mock,http);return {f,app,async close(){await app.close();f.cleanup();}};}

test('DeepSeek account balance prefers CNY, coalesces refreshes and keeps the last successful amounts on failure',async()=>{
 const usd={currency:'USD',total_balance:'5.00',granted_balance:'0.20',topped_up_balance:'4.80'};
 const cny={currency:'CNY',total_balance:'12.34',granted_balance:'2.34',topped_up_balance:'10.00'};
 const response={is_available:true,balance_infos:[usd,cny]};
 assert.equal(parseDeepSeekBalance(response).balance?.currency,'CNY');
 assert.equal(parseDeepSeekBalance(response).balances.length,2);
 assert.equal(parseDeepSeekBalance({...response,balance_infos:[usd]}).balance?.currency,'USD');
 assert.equal(parseDeepSeekBalance({is_available:false,balance_infos:[]}).isAvailable,false);
 assert.throws(()=>parseDeepSeekBalance({is_available:true,balance_infos:[{...usd,total_balance:5}]}),/DEEPSEEK_BALANCE_INVALID_RESPONSE/);

 let key='',calls=0,now=10000,failure=false;
 const http=(async(url,options)=>{
  calls++;
  assert.equal(url,'https://api.deepseek.com/user/balance');
  assert.equal(options?.method,'GET');
  assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+key);
  assert.equal(new Headers(options?.headers).get('accept'),'application/json');
  return failure?new Response('{}',{status:401}):Response.json(response);
 }) as typeof fetch;
 const balance=new DeepSeekBalance(()=>key,false,http,()=>now);
 assert.deepEqual(await balance.refresh(true),{configured:false,checkedAt:null});
 assert.equal(calls,0);
 key='fixture-balance-key';
 const [first,also]=await Promise.all([balance.refresh(),balance.refresh(true)]);
 assert.deepEqual(first,also);
 assert.equal(first.balance?.totalBalance,'12.34');
 now+=4999;
 assert.deepEqual(await balance.refresh(true),first);
 assert.equal(calls,1);
 now+=1;
 failure=true;
 assert.deepEqual(await balance.refresh(true),{...first,error:'DEEPSEEK_BALANCE_HTTP_401',stale:true});
 now+=5*60_000-1;
 await balance.refresh();
 assert.equal(calls,2);
 now+=1;
 failure=false;
 assert.equal((await balance.refresh()).error,undefined);
 assert.equal(calls,3);
 key='rotated-key';
 assert.deepEqual(balance.status(),{configured:true,checkedAt:null});
 const mock=new DeepSeekBalance(()=>assert.fail('offline credential access'),true,http,()=>now);
 assert.equal((await mock.refresh()).balance?.totalBalance,'12.34');
 assert.equal(calls,3);
});

test('workspace sidebar contains the three account cards, files and no obsolete DOM bindings',()=>{
 const html=fs.readFileSync(new URL('../../src/web/public/index.html',import.meta.url),'utf8');
 const js=fs.readFileSync(new URL('../../src/web/public/web.js',import.meta.url),'utf8');
 const panel=html.slice(html.indexOf('id="workspace-panel"'),html.indexOf('</aside>',html.indexOf('id="workspace-panel"')));
 assert.match(panel,/额度与工作区/);
 const ids=['close-panel','deepseek-balance-content','agy-quota-content','codex-quota-content','files'];
 const positions=ids.map(id=>panel.indexOf('id="'+id+'"'));
 assert.ok(positions.every((position,i)=>position>=0&&(i===0||position>positions[i-1])));
 for(const id of ['mode-label','search-dot','search-state','codex-dot','codex-state','tasks','task-count']){
  assert.doesNotMatch(panel,new RegExp('id="'+id+'"'));
  assert.ok(!js.includes("$('"+id+"')"));
 }
 assert.doesNotMatch(panel,/boundary-card|可用操作|task-section|panel-footer/);
 assert.match(js,/renderDeepSeekBalance\(s\.deepseekBalance\);renderAgyQuota\(s\.agyQuota\)/);
 assert.match(js,/\['refresh-deepseek-balance','deepseek-balance\/refresh',renderDeepSeekBalance\]/);
 assert.match(js,/\['refresh-agy-quota','agy-quota\/refresh',renderAgyQuota\]/);
});

test('Tieba UI acknowledgments persist in the WebUI store with restore overrides',()=>{
 const f=fixture();let store=new Store(f.root,'webui.sqlite');
 const failed={id:'old',state:'done',createdAt:1,finishedAt:2,result:{outcome:'failed',error:'TIEBA_LOGIN_REQUIRED'}},snapshot={active:[],completed:[failed]};
 try{
  createTiebaDismissals(store).dismiss({requestId:'old'});store.close();store=new Store(f.root,'webui.sqlite');
  let dismissal=createTiebaDismissals(store);
  assert.equal(dismissal.queue(snapshot).completed[0].dismissed,true);
  dismissal.dismiss({all:true});dismissal.dismiss({restore:true,requestId:'old'});
  store.close();store=new Store(f.root,'webui.sqlite');dismissal=createTiebaDismissals(store);
  assert.equal(dismissal.queue(snapshot).completed[0].dismissed,false);
  assert.equal(dismissal.queue({active:[],completed:[{...failed,id:'other'}]}).completed[0].dismissed,true);
  const at=Number(store.getMeta('tieba:dismissed-all-at'))+1;
  assert.equal(dismissal.queue({active:[],completed:[{...failed,id:'later',finishedAt:at}]}).completed[0].dismissed,false);
  const attempt={requestId:'later',startedAt:1,at,result:failed.result};
  assert.equal(dismissal.status({},attempt).attentionDismissed,false);
  assert.equal(dismissal.attempt(attempt).dismissed,false);
  dismissal.dismiss({all:true});assert.equal(dismissal.queue(snapshot).completed[0].dismissed,true);
  assert.deepEqual(failed.result,{outcome:'failed',error:'TIEBA_LOGIN_REQUIRED'});
 }finally{store.close();f.cleanup();}
});

test('Tieba dismiss-all uses legacy verification timestamps and recognizes incomplete challenge results',()=>{
 const f=fixture(),store=new Store(f.root,'webui.sqlite'),dismissal=createTiebaDismissals(store);
 const detectedAt=Date.now()-1000,legacy={publication:{needsHuman:true,detectedAt}};
 try{
  assert.equal(dismissal.status(legacy,null).attention.problem,true);
  assert.equal(dismissal.status(legacy,null).attentionDismissed,false);
  dismissal.dismiss({all:true});const futureAt=Number(store.getMeta('tieba:dismissed-all-at'))+1;
  assert.equal(dismissal.status(legacy,null).attentionDismissed,true);
  assert.equal(dismissal.status({publication:{needsHuman:true,detectedAt:futureAt}},null).attentionDismissed,false);
  const work={requestId:'legacy-challenge',created:detectedAt-1000,stage:'challenge',result:{receipt:{httpAttempts:0}}};
  const original=JSON.stringify(work);
  const before=dismissal.status({...legacy,publicationWork:work},null);
  assert.equal(before.attention.problem,true);assert.equal(before.attentionDismissed,true);
  assert.equal(before.attention.result.error,'TIEBA_PUBLICATION_CHALLENGE');
  const after=dismissal.status({publication:{needsHuman:true,detectedAt:futureAt},publicationWork:work},null);
  assert.equal(after.attention.problem,true);assert.equal(after.attentionDismissed,false);
  assert.deepEqual(after.publicationWork.result,work.result);
  assert.equal(JSON.stringify(work),original,'classification leaves the stored platform receipt intact');
 }finally{store.close();f.cleanup();}
});

test('retrieval and summary settings default on and change live through shared WebUI metadata',async()=>{
 const w=web(false),other=createWebApp(w.f.root,false),qq=createApp(w.f.root,true);
 try{
  for(const key of ['groupChatSearch','curiosityPublicSearch','curiosityAutoSummary'] as const){assert.equal(w.app.status().settings[key],true);assert.equal(qq.cfg()[key],true);}
  w.app.configure({groupChatSearch:false,curiosityPublicSearch:false,curiosityAutoSummary:false});
  for(const key of ['groupChatSearch','curiosityPublicSearch','curiosityAutoSummary'] as const){assert.equal(w.app.status().settings[key],false);assert.equal(other.status().settings[key],false);assert.throws(()=>qq.set(key,true),/SETTING_NOT_MUTABLE/);}
  assert.throws(()=>w.app.configure({curiosityAutoSummary:'false'}),/INVALID_WEB_SETTINGS/);
  w.app.configure({groupChatSearch:true,curiosityPublicSearch:true,curiosityAutoSummary:true});
  assert.equal(other.status().settings.curiosityAutoSummary,true);
  assert.equal(qq.ledger.value('tokens'),0,'createApp never starts a background model worker');
  const html=fs.readFileSync(new URL('../../src/web/public/index.html',import.meta.url),'utf8');
  for(const id of ['group-chat-search','curiosity-public-search','curiosity-auto-summary'])assert.ok(html.includes('id="'+id+'"'));
 }finally{await qq.curiositySummary.stop();await qq.bot.stop();qq.store.close();await other.close();await w.close();}
});

test('WebUI archives both sides and recalls older records only when explicitly requested in that session',async()=>{
  let payload:any;const w=web(false,(async(_url:any,opts:any)=>{payload=JSON.parse(opts.body);return reply({content:'收到。'});}) as typeof fetch);
  const db=new Store(w.f.root,'webui.sqlite'),memory=new MemoryJournal(w.f.root,db);
  try{
    w.app.configure({apiKey:'fixture-key'});const a=w.app.createSession(),b=w.app.createSession(),at=Date.now()-3*86400000;
    for(const [id,sid,text] of [['old-a',a.id,'旧日海边露营'],['old-b',b.id,'其他会话的海边露营秘密']]){
      db.db.prepare('INSERT INTO web_turns VALUES (?,?,?,?,?,?,?,?)').run(id,sid,text,'旧回复','[]',JSON.stringify([{role:'user',content:text},{role:'assistant',content:'旧回复'}]),'completed',at);
      memory.record({id:id+':user',conversation:'web:'+sid,actor:'webui-local',role:'user',text,at});
    }
    await w.app.chat(a.id,'你好','chat',new AbortController().signal,()=>{});
    assert.ok(!JSON.stringify(payload.messages).includes('海边露营'));
    const n=db.db.prepare('SELECT count(*) AS n FROM memory_events WHERE conversation=?').get('web:'+a.id) as any;assert.equal(n.n,3);
    await w.app.chat(a.id,'还记得“海边露营”吗','chat',new AbortController().signal,()=>{});
    assert.ok(JSON.stringify(payload.messages).includes('旧日海边露营'));
    assert.ok(!JSON.stringify(payload.messages).includes('其他会话'));
  }finally{db.close();await w.close();}
});

test('WebUI mock is independent from QQ; sessions and generated files remain isolated',async()=>{
  const w=web();try{
    const a=w.app.createSession(),b=w.app.createSession(),events:any[]=[];
    await w.app.chat(a.id,'创建 hello.md','agent',new AbortController().signal,e=>events.push(e));
    assert.equal(w.app.detail(a.id).turns[0].state,'completed');assert.equal(w.app.detail(a.id).files[0].name,'hello.md');
    assert.deepEqual(w.app.detail(b.id).files,[]);assert.deepEqual(w.app.detail(b.id).turns,[]);
    assert.ok(events.some(e=>e.type==='tool'&&e.event.name==='write_file'));
    assert.ok(events.some(e=>e.type==='answer'&&e.text.includes('离线演示')));
  }finally{await w.close();}
});
test('workspace rejects cross-session paths, hidden files, executable tricks, links and size/quantity overflow',async()=>{
  const w=web();try{
    const a=w.app.createSession(),workspace=w.app.workspace(a.id);
    for(const p of ['../secret.txt','/etc/passwd','C:/private.txt','.env','dir/.codex/auth.json','auth.json','file.exe','NUL.txt','a\\b.txt'])assert.throws(()=>workspace.write(p,'bad'));
    workspace.write('hello.md','hello');assert.equal(workspace.read('hello.md'),'hello');
    const linked=path.join(workspace.cwd,'link.txt');fs.symlinkSync(path.join(workspace.cwd,'hello.md'),linked);
    assert.throws(()=>workspace.read('link.txt'),/PATH_LINK/);fs.rmSync(linked);
    fs.linkSync(path.join(workspace.cwd,'hello.md'),linked);assert.throws(()=>workspace.write('link.txt','bad'),/FILE_REJECTED/);fs.rmSync(linked);
    assert.throws(()=>workspace.write('big.txt','x'.repeat(65537)),/TOO_LARGE/);
    for(let i=0;i<19;i++)workspace.write(i+'.txt','x');assert.throws(()=>workspace.write('21.txt','x'),/QUOTA/);
  }finally{await w.close();}
});
test('DeepSeek sends real tool wire format, settles each request, and never exposes credentials',async()=>{
  let calls=0;const payloads:any[]=[];
  const http=(async(url:any,opts:any)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(opts.redirect,'error');assert.equal(opts.headers.authorization,'Bearer fixture-key');
    const p=JSON.parse(opts.body);payloads.push(p);assert.equal(p.thinking.type,'disabled');
    assert.match(p.messages[0].content,/鲸酱/);assert.match(p.messages[0].content,/可爱大肥鱼/);assert.match(p.messages[0].content,/鲸鳍耳/);
    return calls===1?reply({content:'',tool_calls:[call('c1','write_file',{path:'plan.md',content:'a useful plan'}),
      call('c2','update_knowledge',{version:0,changes:[{action:'add',text:'鲸鱼会换气。'}]})]}):reply({content:'文件已保存。'});
  }) as typeof fetch;
  const w=web(false,http);try{
    seedVoiceExamples(w.f.root);
    w.app.configure({apiKey:'fixture-key'});const s=w.app.createSession();await w.app.chat(s.id,'create plan','agent',new AbortController().signal,()=>{});
    assert.equal(calls,2);assert.equal(w.app.workspace(s.id).read('plan.md'),'a useful plan');
    assert.deepEqual(payloads[0].messages[0],payloads[1].messages[0]);
    for(const payload of payloads)assertPersonaLayout(w.f.root,payload.messages);
    assert.equal(payloads[1].messages.at(-4).tool_call_id,'c1');
    const knowledgeReceipt=payloads[1].messages.at(-3);
    assert.equal(knowledgeReceipt.role,'tool');assert.equal(knowledgeReceipt.tool_call_id,'c2');
    assert.match(knowledgeReceipt.content,/鲸鱼会换气/);
    assert.equal((w.app.status().budgets.usage as any[]).find(x=>x.metric==='tokens'&&x.scope==='*')?.value,60);
    assert.ok(!JSON.stringify(w.app.status()).includes('fixture-key'));
    assert.ok(fs.statSync(path.join(w.f.root,'runtime/data/webui-secrets.json')).mode&0o600);
  }finally{await w.close();}
});
test('plain chat never executes tool calls; agent tool allowlist denies shell, private paths and disabled search',async()=>{
  const requests:any[]=[];let count=0;
  const http=(async(_u:any,opts:any)=>{const p=JSON.parse(opts.body);requests.push(p);count++;
    if(p.messages.at(-3).role==='tool')return reply({content:'操作被限制。'});
    return reply({content:'',tool_calls:[call('a'+count,'write_file',{path:'../secret.txt',content:'bad'}),call('b'+count,'shell',{command:'whoami'}),call('c'+count,'search_web',{query:'test'})]});
  }) as typeof fetch;
  const w=web(false,http);try{
    w.app.configure({apiKey:'fixture-key'});const a=w.app.createSession();
    await w.app.chat(a.id,'try tools','chat',new AbortController().signal,()=>{});
    assert.equal(requests[0].tools,undefined);assert.equal(w.app.detail(a.id).turns[0].answer,'TOOL_LIMIT_OR_DISABLED');
    const b=w.app.createSession();await w.app.chat(b.id,'try tools','agent',new AbortController().signal,()=>{});
    const t=w.app.detail(b.id).turns[0],actions=t.trace.filter((e:any)=>e.name&&e.name!=='model_usage');assert.equal(t.state,'completed');assert.equal(actions.length,3);assert.ok(actions.every((e:any)=>e.state==='failed'));assert.equal(t.trace.filter((e:any)=>e.kind==='model').length,2);
    assert.deepEqual(w.app.workspace(b.id).list(),[]);assert.ok(!fs.existsSync(path.join(w.f.root,'runtime/workspace/secret.txt')));
  }finally{await w.close();}
});
test('tool loops and concurrency are bounded; cancellation stops upstream and releases session lock',async()=>{
  let calls=0;const http=(async(_u:any,opts:any)=>{calls++;return reply({content:'',tool_calls:[call('c'+calls,'list_files',{})]});}) as typeof fetch;
  const w=web(false,http);try{
    w.app.configure({apiKey:'fixture-key'});const a=w.app.createSession();await w.app.chat(a.id,'loop','agent',new AbortController().signal,()=>{});
    assert.equal(calls,4);assert.equal(w.app.detail(a.id).turns[0].answer,'TOOL_LIMIT_OR_DISABLED');
  }finally{await w.close();}
  const hanging=(async(_u:any,opts:any)=>new Promise((_resolve,reject)=>{opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})) as typeof fetch;
  const h=web(false,hanging);try{
    h.app.configure({apiKey:'fixture-key'});const a=h.app.createSession(),abort=new AbortController();
    const pending=h.app.chat(a.id,'wait','chat',abort.signal,()=>{});
    await assert.rejects(h.app.chat(a.id,'concurrent','chat',abort.signal,()=>{}),/CHAT_BUSY/);
    abort.abort();await pending;assert.equal(h.app.detail(a.id).busy,false);assert.equal(h.app.detail(a.id).turns[0].answer,'CHAT_CANCELLED');
  }finally{await h.close();}
});
test('failed web turns retain actual native dialogue, provider exception and incomplete usage',async()=>{
 let calls=0;const w=web(false,(async()=>{
  if(++calls===1)return reply({content:'看看文件',tool_calls:[call('read-files','list_files',{})]});
  throw new DOMException('upstream timed out','TimeoutError');
 }) as typeof fetch);
 try{
  w.app.configure({apiKey:'fixture-key'});const s=w.app.createSession();await w.app.chat(s.id,'看看文件','agent',new AbortController().signal,()=>{});
  const turn=w.app.detail(s.id).turns[0];assert.equal(turn.state,'failed');assert.equal(turn.answer,'DEEPSEEK_TIMEOUT');
  const db=new Store(w.f.root,'webui.sqlite');try{
   const row=db.db.prepare('SELECT context FROM web_turns WHERE id=?').get(turn.id) as any,dialogue=JSON.parse(row.context);
   assert.deepEqual(dialogue.map((m:any)=>m.role),['user','assistant','tool']);assert.equal(dialogue[1].tool_calls[0].id,dialogue[2].tool_call_id);
  }finally{db.close();}
  const detail=await w.app.activityDetail('web:'+turn.id),models=detail.events.filter(e=>e.type==='model');
  assert.equal(detail.usage.calls,2);assert.equal(detail.usage.total,30);assert.equal(detail.usage.unreportedCalls,1);assert.ok(detail.usage.unconfirmedTokens>0);
  assert.equal(models[1].state,'failed');assert.equal(models[1].diagnostic.cause.name,'TimeoutError');assert.equal(models[1].request.messages.at(-3).role,'tool');assert.equal(detail.counts.tools,1);
 }finally{await w.close();}
});
test('WebUI budget is checked before HTTP, no-key requests cost nothing, and QQ recovery preserves active web leases',async()=>{
  let calls=0;const http=(async()=>{calls++;return reply({content:'hello'});}) as typeof fetch;
  const w=web(false,http);try{
    const s=w.app.createSession();await assert.rejects(w.app.chat(s.id,'hello','chat',new AbortController().signal,()=>{}),/KEY_MISSING/);assert.equal(calls,0);
    w.app.configure({apiKey:'fixture-key',dailyCny:0});await w.app.chat(s.id,'hello','chat',new AbortController().signal,()=>{});assert.equal(calls,0);assert.equal(w.app.detail(s.id).turns[0].answer,'CNY_BUDGET_EXHAUSTED');
    const lease=w.f.ledger.reserve('codex','web:'+s.id,'webui-local');
    new Tasks(w.f.root,w.f.store,w.f.ledger,w.f.cfg,new MockTaskRunner()).recover();
    const row:any=w.f.store.db.prepare('SELECT state FROM reservations WHERE id=?').get(lease);assert.equal(row.state,'held');
  }finally{await w.close();}
});
test('Codex delegation only queues; mock execution still requires a separate local approval',async()=>{
  const w=web();try{
    w.app.configure({codexQueue:true});const s=w.app.createSession();await w.app.chat(s.id,'请交给 Codex 创建文件','agent',new AbortController().signal,()=>{});
    const t=w.app.tasks.list()[0];assert.equal(t.state,'waiting');assert.equal(w.app.detail(s.id).files.length,0);
    w.app.tasks.approve(t.id);await w.app.tasks.idle();assert.equal(w.app.tasks.get(t.id).state,'succeeded');
  }finally{await w.close();}
});
test('HTTP WebUI guards bootstrap replay, token, Origin/Host, downloads and local approval headers',async()=>{
  const w=web();
  // Static assets are shipped in the real checkout; fixtures only exercise API paths.
  let stopped=false;
  const port=22000+Math.floor(Math.random()*20000),{server,launchUrl}=webServer(w.app,port,()=>{stopped=true;});
  try{
    server.listen(port,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+port;
    const headers={authorization:'Bearer '+w.app.token,'content-type':'application/json'};
    const post=(route:string,value:unknown,extra={})=>fetch(base+'/api/'+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
    const code=new URLSearchParams(new URL(launchUrl).hash.slice(1)).get('bootstrap');
    assert.equal((await post('bootstrap',{code},{origin:'https://evil.example'})).status,403);
    assert.equal((await post('bootstrap',{code})).status,200);assert.equal((await post('bootstrap',{code})).status,401);
    assert.equal((await fetch(base+'/api/open',{method:'POST'})).status,401);
    const fresh:any=await (await post('open',{})).json();
    const newCode=new URLSearchParams(new URL(fresh.launchUrl).hash.slice(1)).get('bootstrap');
    assert.notEqual(newCode,code);assert.equal((await post('bootstrap',{code:newCode})).status,200);
    assert.equal((await fetch(base+'/api/status')).status,401);
    const quotaDir=path.join(w.f.root,bridgeViewDir);
    fs.mkdirSync(quotaDir,{recursive:true});
    const quota={source:'agy' as const,checkedAt:Date.now(),weekly:{remainingPercent:68},fiveHour:{remainingPercent:66}};
    const queued:any=await (await post('agy-quota/refresh',{})).json();
    assert.equal(queued.pending,true);
    assert.equal(await processAgyQuotaRefresh(w.f.root,async()=>quota),true);
    assert.equal(await processAgyQuotaRefresh(w.f.root,async()=>assert.fail('refresh replayed')),false);
    const stats:any=await (await fetch(base+'/api/status',{headers})).json();
    assert.equal(stats.settings.provider,'deepseek');
    assert.deepEqual(stats.agyQuota,{...quota,pending:false,stale:false});
    assert.equal(stats.deepseekBalance.balance.totalBalance,'12.34');
    assert.equal((await (await post('deepseek-balance/refresh',{})).json()).mock,true);
    for(const route of ['agy-quota/refresh','deepseek-balance/refresh']){
      assert.equal((await post(route,{unexpected:true})).status,400);
      assert.equal((await fetch(base+'/api/'+route,{method:'POST'})).status,401);
    }
    assert.equal((await fetch(base+'/api/opencode/models')).status,401);
    const models=await (await fetch(base+'/api/opencode/models',{headers})).json();
    assert.equal(models.source,'mock');
    assert.ok(models.models.some((model:any)=>model.supportsTools));
    assert.equal(models.models.find((model:any)=>model.id==='glm-5.3-flash').disableThinkingSupport,'supported');
    const unverified=models.models.find((model:any)=>model.id==='kimi-k2.6');
    assert.equal(unverified.disableThinkingSupport,'unknown');
    assert.match(unverified.disableThinkingReason,/未实测关闭思考/);
    assert.equal((await post('opencode/models/refresh',{keySlot:'work'})).status,200);
    const legacyKey='web-deepseek-fixture-secret',goKey='web-opencode-fixture-secret';
    assert.equal((await post('settings',{apiKey:legacyKey})).status,200);
    const added=await (await post('connection-presets',{name:'Go 工作',provider:'opencode_go',
      model:models.models[0].id,maxOutputTokens:512,keySlot:'work',apiKey:goKey,disableThinking:false})).json();
    assert.equal(added.settings.provider,'opencode_go');
    assert.equal(added.settings.connectionPresets.length,1);
    assert.equal(added.providers.deepseek.keys.deepseek.configured,true);
    assert.equal(added.providers.opencode_go.keys.work.configured,true);
    assert.equal(added.opencodeQuota.active,true);
    assert.equal(added.settings.disableThinking,false);
    const id=added.settings.activePresetId;
    const switched=await (await post('settings',{provider:'deepseek'})).json();
    assert.equal(switched.settings.provider,'deepseek');
    assert.equal(switched.opencodeQuota.configured,true);
    const restored=await (await post('settings',{activePresetId:id,apiKey:''})).json();
    assert.equal(restored.settings.model,models.models[0].id);
    assert.equal(restored.settings.disableThinking,false);
    assert.equal((await (await post('settings',{disableThinking:true})).json()).settings.disableThinking,true);
    assert.equal((await (await post('connection-presets/delete',{id})).json()).settings.connectionPresets.length,0);
    const statusText=await (await fetch(base+'/api/status',{headers})).text();
    assert.ok(!statusText.includes(legacyKey)&&!statusText.includes(goKey));
    assert.equal((await post('settings',{provider:'deepseek'})).status,200);
    const spoofed=await new Promise<number>((resolve,reject)=>{const req=request(base+'/api/status',{headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();});assert.equal(spoofed,403);
    const s:any=await (await post('sessions',{})).json();w.app.workspace(s.id).write('note.html','<script>alert(1)</script>');
    const file=await fetch(base+'/api/file?id='+s.id+'&path=note.html',{headers});assert.equal(file.status,200);assert.match(file.headers.get('content-disposition')??'',/attachment/);assert.match(file.headers.get('content-security-policy')??'',/sandbox/);
    assert.equal((await fetch(base+'/api/file?id='+s.id+'&path=..%2Fsecret.txt',{headers})).status,400);
    assert.equal((await post('approve',{id:'unknown',reviewed:true})).status,400);
    const r=await post('chat',{sessionId:s.id,text:'hello',mode:'chat'});const lines=(await r.text()).trim().split('\n').map(l=>JSON.parse(l));assert.ok(lines.some(e=>e.type==='done'));
    assert.equal((await post('settings',{endpoint:'http://localhost'})).status,400);
    assert.deepEqual(await (await post('stop',{})).json(),{ok:true});
    await new Promise(resolve=>setTimeout(resolve,150));assert.equal(stopped,true);
  }finally{await w.app.close();server.close();await once(server,'close');w.f.cleanup();}
});

test('WebUI retains cache breakdown on successful and rejected responses without duplicate settlement',async()=>{
  let calls=0;
  const http=(async()=>new Response(JSON.stringify({choices:[{message:++calls===1?{content:'',tool_calls:[call('file','list_files',{})]}:{content:'',tool_calls:[{id:'bad',type:'invalid'}]}}],usage:{prompt_tokens:20,completion_tokens:10,prompt_cache_hit_tokens:calls===1?12:0,prompt_cache_miss_tokens:calls===1?8:20}}))) as typeof fetch;
  const w=web(false,http);try{
    w.app.configure({apiKey:'fixture-key'});const session=w.app.createSession();await w.app.chat(session.id,'查看工作区','agent',new AbortController().signal,()=>{});
    const turn=w.app.detail(session.id).turns[0];assert.equal(turn.state,'failed');assert.equal(turn.answer,'INVALID_TOOL_CALL');
    const detail=await w.app.activityDetail('web:'+turn.id);assert.equal(detail.usage.total,60);assert.equal(detail.usage.cachedInput,12);assert.equal(detail.usage.uncachedInput,28);assert.equal(detail.usage.calls,2);assert.equal(detail.usage.cacheKnownCalls,2);
    assert.equal(detail.events.find(e=>e.name==='list_files')?.decision?.usage?.cachedInput,12);assert.equal(detail.events.filter(e=>e.type==='model').at(-1)?.state,'failed');
    assert.equal((w.app.status().budgets.usage as any[]).find(x=>x.metric==='tokens'&&x.scope==='*')?.value,60);
  }finally{await w.close();}
});
