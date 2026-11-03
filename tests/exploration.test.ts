import {test} from 'node:test';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './helpers.js';
import {ExplorationState,explorationDefaults,interval,expectedPerDay} from '../src/exploration/state.js';
import {ExplorationWorker,explorationRead} from '../src/exploration/worker.js';
import {ExplorationTools} from '../src/exploration/tools.js';
import {TurnContext} from '../src/agent/context.js';
import {BudgetedModel} from '../src/agent/model.js';
import {Store} from '../src/storage/db.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {QQMedia} from '../src/qq/media.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import {MemoryJournal} from '../src/memory/journal.js';
import {writePrivate} from '../src/paths.js';
import {createWebApp} from '../src/web/app.js';
import {ActivityHistory} from '../src/web/activity.js';
import {FishError,type Model,type ModelResult,type ChatMessage} from '../src/types.js';

const call=(id:string,name:string,args:any):ModelResult=>({text:'',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}],usage:{input:100,output:20,cachedInput:60,uncachedInput:40}});
const quiet=():ModelResult=>({...call('finish','finish_exploration',{note:'先歇会儿。'}),usage:{input:100,output:5,cachedInput:80,uncachedInput:20}});
function setup(){
 const f=fixture({enabled:true,qqTransport:'onebot',privateUsers:['20002'],admins:['20002'],search:true,dailyTokens:10000000,groupDailyTokens:10000000,userDailyRequests:1000}),state=new ExplorationState(f.store,f.cfg);
 f.store.db.exec('CREATE TABLE IF NOT EXISTS qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT,PRIMARY KEY(conversation,message_id))');
 let sent=0,failure=false;const deliveries:any[]=[],queries:string[]=[],visited:string[]=[];
 const transport={status:'mock',async file(){throw Error('unexpected file');},async stop(){},async send(m:any,text:string){sent++;if(failure)throw new FishError('ONEBOT_ACTION_TIMEOUT');deliveries.push({m,text});},async meme(m:any,image:any){sent++;deliveries.push({m,image});}};
 const services={root:f.root,cfg:f.cfg,ledger:f.ledger,transport,tasks:new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),media:new QQMedia(f.root,f.store),library:new QQImageLibrary(f.root,f.store),
  search:{async search(query:string){queries.push(query);return [{url:'https://example.com/a',title:'unexpected discovery',snippet:'an interesting tangent'}];},async fetch(url:string){visited.push(url);return {url,content:'a source',title:'a source',totalCharacters:8,truncated:false,status:'content',latestVerified:false,fetchedAt:new Date().toISOString(),offset:0,nextOffset:null};}},
  browse:async(url:string)=>{visited.push(url);return {url,text:'a different topic',links:[],images:[],nextOffset:null} as any;}};
 return {...f,state,services,deliveries,queries,visited,sent:()=>sent,fail:()=>{failure=true;},worker:(provider:Model)=>new ExplorationWorker(state,new BudgetedModel(provider,f.ledger,f.cfg),services)};
}
const provider=(complete:Model['complete']):Model=>({kind:'mock',complete});
async function run(f:ReturnType<typeof setup>,p:Model){const id=f.state.manual().run.id,w=f.worker(p);await w.tick();await w.idle();return f.state.get(id);}

test('random tick simulation: about four daily on average, variable days, consecutive hits, no quota',()=>{
 let seed=123456;const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 const days=3650,counts=Array(days).fill(0);let at=0,previous=false,consecutive=0,checks=0;
 while((at+=interval(explorationDefaults,rng))<days*86400000){const hit=rng()<explorationDefaults.probability;checks++;if(hit)counts[Math.floor(at/86400000)]++;if(hit&&previous)consecutive++;previous=hit;}
 const mean=counts.reduce((a,b)=>a+b,0)/days;assert.ok(Math.abs(mean-expectedPerDay(explorationDefaults))<0.15);assert.ok(counts.includes(0));assert.ok(Math.max(...counts)>8);assert.ok(consecutive>100);
 console.log('simulation',JSON.stringify({days,checks,mean,min:Math.min(...counts),max:Math.max(...counts),consecutive}));
});
test('schedule survives separate connections, rolls only once after offline gap, live settings reschedule',()=>{
 const f=setup();let now=1000000;const state=new ExplorationState(f.store,f.cfg,()=>now,()=>0.5),other=new Store(f.root);
 try{
  state.save({enabled:true,probability:0});const first=(state.status().schedule as any).next_check;assert.equal(first,now+600000);
  const restarted=new ExplorationState(other,f.cfg,()=>now,()=>0.5);assert.equal((restarted.status().schedule as any).next_check,first);
  now+=30*86400000;assert.equal(restarted.check().hit,false);assert.equal((state.status().schedule as any).checks,1);assert.equal(restarted.check().checked,false);assert.equal(state.status().recent.length,0);
  restarted.save({minMinutes:2,maxMinutes:2,probability:1});assert.equal((state.status().schedule as any).next_check,now+120000);now+=120000;const check=state.check();assert.equal(check.hit,true);assert.equal(state.status().recent.length,1);
  now+=120000;assert.equal(state.check().hit,true);assert.equal(state.status().recent.length,1,'hit while queued reuses single active run');
 }finally{other.close();f.cleanup();}
});
test('missed ticks never invoke the model, and multiple workers share one durable lease',async()=>{
 const f=setup();let calls=0,release!:()=>void;const held=new Promise<void>(r=>release=r),p=provider(async()=>{calls++;await held;return quiet();}),one=f.worker(p),two=f.worker(p);
 try{
  f.state.save({enabled:true,probability:0});f.store.db.prepare('UPDATE exploration_schedule SET next_check=0').run();await one.tick();assert.equal(calls,0);
  const id=f.state.manual().run.id;assert.equal(f.state.manual().run.id,id);await Promise.all([one.tick(),two.tick()]);assert.equal(calls,1);assert.equal(f.state.status().active?.state,'running');
  release();await one.idle();await two.idle();assert.equal(f.state.get(id).state,'completed');assert.equal(f.ledger.value('tokens'),105);assert.equal(f.sent(),0);
 }finally{release();await one.stop();await two.stop();f.cleanup();}
});
test('expired process lease is fenced, old work is interrupted and never replayed; stale offline queue is discarded',()=>{
 const f=setup();let now=1000;const state=new ExplorationState(f.store,f.cfg,()=>now,()=>0.5);
 try{
  state.manual();const old=state.claim()!;assert.ok(old.lock);now+=60001;state.recover();assert.equal(state.get(old.id).state,'interrupted');assert.throws(()=>state.guard(old.id,old.lock!),/CANCELLED/);
  state.finish(old.id,old.lock!,'completed');assert.equal(state.get(old.id).state,'interrupted');assert.equal(state.claim(),undefined);
  state.manual();now+=3600001;state.recover();assert.equal(state.status().active,null);
 }finally{f.cleanup();}
});
test('model chooses tools, changes direction, keeps curiosity with sources and quietly ends without a fixed workflow',async()=>{
 const f=setup();let n=0;const inputs:ChatMessage[][]=[];
 try{
  const row=await run(f,provider(async(messages,_max,options)=>{
   inputs.push(structuredClone(messages));assert.equal(options?.requireTool,undefined);assert.equal(options?.toolChoice,undefined);
   const names=options!.tools!.map(t=>t.function.name);assert.ok(names.includes('download_image')&&names.includes('write_curiosity'));assert.ok(!names.includes('generate_image')&&!names.includes('publish_qzone'));assert.ok(!names.some(n=>/exec|approve|shell/.test(n)));
   const sequence:[string,any][]=[['search_web',{query:'why whales sing'}],['browse_page',{url:'https://example.com/a'}],['search_web',{query:'underwater sound and old synthesizers'}],['write_curiosity',{title:'声音的弯路',content:'本来在看鲸歌，突然想看看声音合成。',sources:['https://example.com/a']}],['finish_exploration',{}]];
   const [name,args]=sequence[n++];return call('choice-'+n,name,args);
  }));
  assert.equal(row.state,'completed');assert.deepEqual(f.queries,['why whales sing','underwater sound and old synthesizers']);assert.equal(f.visited.length,1);assert.equal(f.sent(),0);assert.equal(f.state.journal().entries?.[0].title,'声音的弯路');assert.equal(row.tokens,600);assert.equal(f.ledger.value('tokens'),600);
  assert.equal(inputs[1].at(-1)?.role,'tool');assert.match(JSON.stringify(inputs[2]),/a different topic/);assert.equal(f.store.history('private:20002',6).length,0,'private exploration is not inserted as a human dialogue');
  const detail=explorationRead(f.root,f.state,row.id);assert.ok('trace' in detail);assert.ok(detail.trace.some((x:any)=>x.tool==='search_web'));
  fs.unlinkSync(f.root+'/runtime/logs/exploration/'+row.id+'.json');const indexed=explorationRead(f.root,f.state,row.id);assert.ok('observations' in indexed);assert.equal(indexed.observations.length,5);assert.match(JSON.stringify(indexed.observations),/example.com\/a/);assert.equal(f.state.history('synthesizers').runs[0].id,row.id);
 }finally{f.cleanup();}
});
test('text-only plans continue as assistant thoughts, and the model can actually browse and change direction',async()=>{
 const f=setup();let n=0;const inputs:ChatMessage[][]=[];
 const thought='溜达时间到(´▽`)/ 今天贴吧有没有人在说本鱼亖了呀～';
 try{
  const row=await run(f,provider(async(messages,_max,options)=>{
   inputs.push(structuredClone(messages));assert.equal(options?.requireTool,undefined);assert.equal(options?.toolChoice,undefined);
   assert.ok(options?.tools?.some(t=>t.function.name==='finish_exploration'));
   n++;if(n===7)return quiet();
   if(n%2)return {text:n===1?thought:'改主意了，再去别处看看。',finishReason:'stop',usage:{input:100,output:20}};
   return call('visit-'+n,'browse_page',{url:'https://example.com/model-choice-'+n});
  }));
  assert.equal(row.state,'completed');assert.equal(n,7,'three separated text turns do not impose a round cap');
  assert.deepEqual(f.visited,['https://example.com/model-choice-2','https://example.com/model-choice-4','https://example.com/model-choice-6']);
  assert.equal(inputs[1].at(-2)?.role,'assistant');assert.equal(inputs[1].at(-2)?.content,thought);assert.equal(inputs[1].at(-1)?.role,'system');
  assert.equal(inputs.at(-1)?.filter(m=>m.role==='user').length,1,'no fabricated human follow-up');
  const calls=new Set<string>();for(const message of inputs.at(-1)!){if(message.role==='assistant')for(const c of message.tool_calls??[])calls.add(c.id);if(message.role==='tool')assert.ok(calls.has(message.tool_call_id!));}
  assert.equal(f.sent(),0);assert.equal(f.state.journal().entries?.length,0,'no forced report or memory write');assert.equal(f.store.history('private:20002',6).length,0);
  assert.equal(row.tokens,825);assert.equal(f.ledger.value('tokens'),825);
  const log=JSON.parse(fs.readFileSync(f.root+'/runtime/logs/exploration/'+row.id+'.json','utf8'));
  assert.equal(log.trace.filter((e:any)=>e.continuation).length,3);assert.equal(log.trace.filter((e:any)=>e.tool==='finish_exploration').length,1);
 }finally{f.cleanup();}
});
test('the model can immediately choose to rest without browsing, sharing, or receiving a continuation',async()=>{
 const f=setup();let n=0;
 try{const row=await run(f,provider(async()=>{n++;return quiet();}));assert.equal(n,1);assert.equal(row.state,'completed');assert.equal(row.note,'先歇会儿。');assert.equal(f.visited.length,0);assert.equal(f.queries.length,0);assert.equal(f.sent(),0);assert.equal(row.tokens,105);}
 finally{f.cleanup();}
});
test('repeated text without any action pauses with honest usage instead of claiming success or spinning',async()=>{
 const f=setup();let n=0;
 try{
  const row=await run(f,provider(async()=>{n++;return {text:'先想一想。',finishReason:'stop',usage:{input:100,output:5}};}));
  assert.equal(n,3);assert.equal(row.state,'paused');assert.equal(row.error,'EXPLORATION_DECISION_STALLED');assert.equal(row.tokens,315);assert.equal(f.ledger.value('tokens'),315);assert.equal(f.visited.length,0);assert.equal(f.sent(),0);
  const log=JSON.parse(fs.readFileSync(f.root+'/runtime/logs/exploration/'+row.id+'.json','utf8'));assert.equal(log.trace.filter((e:any)=>e.continuation).length,2);assert.equal(log.trace.filter((e:any)=>e.usage).length,3);
  const activity=await new ActivityHistory(f.root,f.store,f.store).detail('exploration:'+row.id);assert.equal(activity.state,'paused');assert.equal(activity.usage.calls,3);assert.equal(activity.events.filter(e=>e.name==='探索继续提示').length,2);
 }finally{f.cleanup();}
});
test('cancellation after a text-only decision prevents continuation; finish prevents later effects in the batch',async()=>{
 const f=setup();let n=0;
 try{
  const cancelled=await run(f,provider(async()=>{n++;f.state.cancel();return {text:'还想看看。',usage:{input:100,output:5}};}));assert.equal(n,1);assert.equal(cancelled.state,'cancelled');assert.equal(f.sent(),0);
  const done=await run(f,provider(async()=>({...quiet(),tool_calls:[...quiet().tool_calls!,...call('late-send','send_message',{text:'不该发送'}).tool_calls!]})));
  assert.equal(done.state,'completed');assert.equal(f.sent(),0);assert.equal(f.state.observations(done.id).observations.length,1);
 }finally{f.cleanup();}
});
test('real image catalog stores downloaded original, collects it and sends it by model choice',async()=>{
 const f=setup();const sharp=(await import('sharp')).default,bytes=await sharp({create:{width:40,height:40,channels:4,background:'#336699'}}).png().toBuffer();let n=0,id='';
 const worker=new ExplorationWorker(f.state,{async complete(_g,_u,m){n++;if(n===1)return call('d','download_image',{url:'https://example.com/meme.png'});if(n===2){const last=m.at(-1)!;const text=typeof last.content==='string'?last.content:last.content.find(p=>p.type==='text')!.text;id=JSON.parse(text).image.id;return call('c','collect_meme',{imageId:id,description:'一片海蓝色',tags:['蓝色']});}if(n===3)return call('s','send_meme',{id});return quiet();}}, {...f.services,download:async()=>({bytes,type:'image/png',url:'https://example.com/meme.png'})});
 try{const task=f.state.manual().run;await worker.tick();await worker.idle();assert.equal(f.state.get(task.id).state,'completed');assert.equal(f.sent(),1);assert.equal(f.services.media.browse('private:20002','蓝色').memes.length,1);assert.deepEqual(f.services.media.original('private:20002',id),bytes);assert.equal(f.state.get(task.id).shared,1);}
 finally{await worker.stop();f.cleanup();}
});
test('unknown send results are durable and never retried, even by a later run; confirmed sends are archived once',async()=>{
 for(const fail of [false,true]){
  const f=setup();try{
   if(fail)f.fail();const queued=f.state.manual();const active=f.state.claim()!,tools=new ExplorationTools({...f.services,state:f.state,readRun:()=>({})},active,new TurnContext(),new AbortController().signal);
   const first=await tools.execute('send_message',{text:'这个梗有点好笑。'},'a');const second=await tools.execute('send_message',{text:'这个梗有点好笑。'},'b');assert.equal(f.sent(),1);assert.equal(second.result.reused,true);assert.equal(first.result.deliveryStatus,fail?'unconfirmed':'confirmed');
   assert.equal(f.store.history('private:20002',6).length,fail?0:1);assert.equal(f.state.get(queued.run.id).shared,fail?0:1);
   f.state.finish(active.id,active.lock!,'completed');f.state.manual();const later=f.state.claim()!,again=new ExplorationTools({...f.services,state:f.state,readRun:()=>({})},later,new TurnContext(),new AbortController().signal);await again.execute('send_message',{text:'这个梗有点好笑。'},'c');assert.equal(f.sent(),fail?1:2);
  }finally{f.cleanup();}
 }
});
test('journal revision and abandoned interests survive restart, and unauthorized groups or execution are denied',async()=>{
 const f=setup();const other=new Store(f.root);try{
  const created=f.state.writeJournal('test',{title:'想法',content:'第一版',sources:['https://example.com/a']}),changed=f.state.writeJournal('test',{id:created.id,version:1,content:'我改变主意了。'});
  assert.throws(()=>f.state.writeJournal('test',{id:created.id,version:1,content:'stale'}),/VERSION_CHANGED/);f.state.writeJournal('test',{id:created.id,version:changed.version,remove:true});
  const restarted=new ExplorationState(other,f.cfg);assert.equal(restarted.journal().entries?.length,0);assert.equal(restarted.journal({removed:true}).entries?.length,1);assert.equal(restarted.journal({id:created.id}).revisions?.length,3);
  f.state.manual();const active=f.state.claim()!,tools=new ExplorationTools({...f.services,state:f.state,readRun:()=>({})},active,new TurnContext(),new AbortController().signal);
  await assert.rejects(tools.execute('recall_chat',{conversation:'private:30003'},'x'),/NOT_ALLOWED/);await assert.rejects(tools.execute('recall_chat',{conversation:'unapproved-group'},'y'),/NOT_ALLOWED/);
  const memory=new MemoryJournal(f.root,f.store);memory.record({id:'allowed',conversation:'g',actor:'member',role:'user',text:'公开的群消息',at:Date.now()});assert.match(JSON.stringify(await tools.execute('recall_chat',{conversation:'g'},'z')),/公开的群消息/);
  await assert.rejects(tools.execute('generate_image',{},'i'),/NOT_ALLOWED/);await assert.rejects(tools.execute('publish_qzone',{},'q'),/NOT_ALLOWED/);await assert.rejects(tools.execute('approve',{},'a'),/NOT_ALLOWED/);
  const proposal=await tools.execute('propose_project',{idea:'做个小海洋',why:'想把声音画出来',brief:'一个离线可用的声音可视化页面'},'p');assert.equal(proposal.result.state,'waiting');assert.equal(f.state.status().proposals.length,1);assert.equal(f.ledger.value('codex'),0);
 }finally{other.close();f.cleanup();}
});
test('more than twenty decisions can continue; resource budget and explicit stop preserve actual progress',async()=>{
 const f=setup();try{
  let n=0;const row=await run(f,provider(async()=>++n<=22?call('read-'+n,'get_knowledge',{}):quiet()));assert.equal(row.state,'completed');assert.equal(n,23);
  f.state.save({runTokens:1});let called=0;const limited=await run(f,provider(async()=>{called++;return quiet();}));assert.equal(called,0);assert.equal(limited.state,'paused');assert.equal(limited.error,'EXPLORATION_TOKEN_BUDGET');
  f.state.save({runTokens:0});const w=f.worker(provider(async(_m,_max,options)=>new Promise((_resolve,reject)=>{options!.signal!.addEventListener('abort',()=>reject(options!.signal!.reason),{once:true});})));const id=f.state.manual().run.id;await w.tick();await w.stop();assert.equal(f.state.get(id).state,'cancelled');const saved=explorationRead(f.root,f.state,id);assert.ok('trace' in saved&&saved.trace.length>0);
 }finally{f.cleanup();}
});
test('WebUI settings persist in shared database without changing QQ settings; activity shows actual per-action cache split',async()=>{
 const f=setup();writePrivate(f.root,'runtime/data/qq-settings.json',JSON.stringify({enabled:true,qqTransport:'onebot',privateUsers:['20002'],admins:['20002'],groups:['g']}));
 const app=createWebApp(f.root,false);let closed=false;try{
  assert.equal(app.exploration.settings().enabled,false);app.exploration.save({enabled:true,minMinutes:2,maxMinutes:3,probability:0.5});assert.equal(f.state.settings().maxMinutes,3);assert.equal(app.exploration.status().expectedPerDay,288);
  const id=app.exploration.manual().run.id;let n=0;const worker=f.worker(provider(async()=>++n===1?call('s','send_message',{text:'散步回来了。'}):quiet()));await worker.tick();await worker.idle();assert.equal(f.state.get(id).state,'completed');
  const detail=await app.activityDetail('exploration:'+id);assert.equal(detail.kind,'exploration');assert.equal(detail.usage.input,200);assert.equal(detail.usage.cachedInput,140);assert.equal(detail.usage.output,25);assert.equal(detail.events.find(e=>e.name==='send_message')?.decision?.usage?.cachedInput,60);
  await app.close();closed=true;const reopened=createWebApp(f.root,false);try{assert.equal(reopened.exploration.settings().probability,0.5);assert.equal(reopened.exploration.status().last?.id,id);}finally{await reopened.close();}
 }finally{if(!closed)await app.close();f.cleanup();}
});

test('one actual OS process claims the run, a restarted process observes durable fencing and settings',async()=>{
 const f=setup();const {spawn}=await import('node:child_process');
 const child=(action:string)=>new Promise<any>((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',`import {Store} from './dist/src/storage/db.js';import {ExplorationState} from './dist/src/exploration/state.js';import {defaults} from './dist/src/config.js';const store=new Store(process.argv[1]),state=new ExplorationState(store,()=>({...defaults,qqTransport:'onebot',privateUsers:['20002']}));const run=${action==='claim'?'state.claim()':'(state.recover(),state.status().last)'};console.log(JSON.stringify(run??null));store.close();`,f.root],{stdio:['ignore','pipe','pipe']});let text='',error='';p.stdout.on('data',b=>text+=b);p.stderr.on('data',b=>error+=b);p.on('error',reject);p.on('exit',code=>code?reject(Error(error)):resolve(JSON.parse(text)));});
 try{const id=f.state.manual().run.id,claims=await Promise.all([child('claim'),child('claim')]);assert.equal(claims.filter(Boolean).length,1);assert.equal(claims.find(Boolean).id,id);f.store.db.prepare('UPDATE exploration_runs SET lease=0 WHERE id=?').run(id);const recovered=await child('recover');assert.equal(recovered.state,'interrupted');assert.equal(await child('claim'),null);}
 finally{f.cleanup();}
});

test('per-action network charges reuse the ledger; cached calls cost zero, failures preserve unknown charges',async()=>{
 const f=setup();const {SearchService}=await import('../src/search/provider.js');let requests=0;const search=new SearchService({async search(){requests++;if(requests===2)throw new FishError('NETWORK_TIMEOUT');return [{title:'one',url:'https://example.com/one',snippet:'one'}];}},f.ledger,f.cfg);
 try{f.state.manual();const active=f.state.claim()!,tools=new ExplorationTools({...f.services,search,state:f.state,readRun:()=>({})},active,new TurnContext(),new AbortController().signal);
 const a=await tools.execute('search_web',{query:'a'},'a'),cached=await tools.execute('search_web',{query:'a'},'b'),failed=await tools.execute('search_web',{query:'b'},'c');assert.equal(a.result.billing.chargedTokens,2500);assert.equal(cached.result.billing.chargedTokens,0);assert.equal(failed.result.billing.uncertain,true);assert.equal(failed.result.error,'NETWORK_TIMEOUT');assert.equal(f.state.get(active.id).web_tokens,5000);assert.equal(f.ledger.value('tokens'),5000);assert.equal(requests,2);
 }finally{f.cleanup();}
});

test('WebUI HTTP authentication, owner gateway routes, validation and journal pagination are functional',async()=>{
 const f=setup();const {webServer}=await import('../src/web/server.js'),{tailnetGateway}=await import('../src/web/tailnet.js'),{request}=await import('node:http');
 writePrivate(f.root,'runtime/data/qq-settings.json',JSON.stringify({qqTransport:'onebot',enabled:true,privateUsers:['20002']}));const app=createWebApp(f.root,false),port=45000+Math.floor(Math.random()*9000),{server}=webServer(app,port);server.listen(port,'127.0.0.1');await once(server,'listening');
 let owner=true;const gateway=tailnetGateway('100.123.219.112:17863',port,{token:app.token,owner:async()=>owner});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');const gp=(gateway.address() as any).port;
 const phone=(route:string,value?:any)=>new Promise<any>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:gp,path:'/api/'+route,method:value?'POST':'GET',headers:{host:'100.123.219.112:17863','content-type':'application/json'}},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(value?JSON.stringify(value):undefined);});
 try{
  assert.equal((await fetch('http://127.0.0.1:'+port+'/api/exploration')).status,401);
  assert.equal((await phone('exploration/settings',{owner:'99999',enabled:true})).status,400);assert.equal((await phone('exploration/settings',{minMinutes:12,maxMinutes:9})).status,400);
  const saved=await phone('exploration/settings',{enabled:true,probability:0.01});assert.equal(saved.status,200);assert.equal(f.state.settings().probability,0.01);assert.ok((await phone('exploration')).body.schedule.next_check>Date.now());
  const queued=await phone('exploration/run',{});assert.equal(queued.status,200);assert.equal(queued.body.run.state,'queued');assert.equal((await phone('exploration/run',{})).body.run.id,queued.body.run.id);
  assert.equal((await phone('exploration/cancel',{})).status,200);f.state.recover();assert.equal(f.state.get(queued.body.run.id).state,'cancelled');
  f.state.writeJournal('test',{title:'测试日志',content:'能从手机查看',sources:[]});assert.equal((await phone('exploration/journal?offset=0')).body.entries.length,1);
  owner=false;assert.equal((await phone('exploration')).status,403);assert.equal((await phone('exploration/run',{})).status,403);assert.equal((await phone('exploration/settings',{enabled:false})).status,403);
 }finally{gateway.closeAllConnections();server.closeAllConnections();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>server.close(()=>r()))]);await app.close();f.cleanup();}
});

test('background image broker requires the separate human toggle and a live matching owner lease',async()=>{
 const f=setup();f.set({images:true});fs.mkdirSync(f.root+'/config');fs.writeFileSync(f.root+'/config/local.json',JSON.stringify(f.cfg()));
 const {CodexQuotaMonitor}=await import('../src/codex/quota.js'),{startQQImageBroker}=await import('../src/qq/image-broker.js'),{QQImageClient}=await import('../src/qq/image-client.js');
 const quota=new CodexQuotaMonitor(f.store,true,{read:async()=>{},close:async()=>{}}),broker=await startQQImageBroker(f.root,f.store,quota,true),client=new QQImageClient(f.root),controller=new AbortController();
 const plan={subject:'海浪',scene:'海面',style:'水彩',composition:'远景',lighting:'清晨',palette:'蓝色',details:'小小的浪花'};
 try{
  f.state.manual();const active=f.state.claim()!,tools=new ExplorationTools({...f.services,images:client,state:f.state,readRun:()=>({})},active,new TurnContext(),controller.signal);
  assert.ok(!tools.available().some(t=>t.function.name==='generate_image'));
  const m={id:'explore:'+active.id+':'+('a'.repeat(20)),group:'private:20002',user:'20002',text:'海浪',at:Date.now(),mentioned:false,event:'ordinary' as const};
  await assert.rejects(client.generate(m,plan,1000),/EXPLORATION_IMAGE_DISABLED/);assert.equal(f.ledger.value('image'),0);
  f.state.save({allowImages:true});assert.ok(tools.available().some(t=>t.function.name==='generate_image'));const generated=await client.generate(m,plan,2000);assert.ok(generated.imageId);assert.equal(f.ledger.value('image'),1);assert.equal(f.sent(),0);
  f.state.save({allowImages:false});await assert.rejects(client.generate({...m,id:m.id.slice(0,-1)+'b'},plan,1000),/EXPLORATION_IMAGE_DISABLED/);
  f.state.save({allowImages:true});f.state.cancel();await assert.rejects(client.generate({...m,id:m.id.slice(0,-1)+'c'},plan,1000),/EXPLORATION_CANCELLED/);assert.equal(f.ledger.value('image'),1);
 }finally{await broker.close();await quota.close();f.cleanup();}
});

test('unreported model usage is shown as an uncertain reservation, not zero-cost success',async()=>{
 const f=setup();try{const row=await run(f,provider(async()=>{throw new FishError('DEEPSEEK_HTTP_503');}));assert.equal(row.state,'failed');assert.equal(row.tokens,0);assert.ok(row.unknown_tokens>0);assert.equal(f.ledger.value('tokens'),row.unknown_tokens);const read=explorationRead(f.root,f.state,row.id);assert.ok('trace' in read&&read.trace.some((e:any)=>e.usageUnreported&&e.reservation.state==='unknown'));assert.equal(f.sent(),0);}finally{f.cleanup();}
});

test('long exploration compacts whole native tool groups while full earlier actions remain readable',async()=>{
 const f=setup();f.set({maxOutputTokens:4096});let n=0,maximum=0;
 try{const row=await run(f,provider(async messages=>{
  maximum=Math.max(maximum,messages.length);const ids=new Set<string>();for(const m of messages){if(m.role==='assistant')for(const c of m.tool_calls??[])ids.add(c.id);if(m.role==='tool')assert.ok(ids.has(m.tool_call_id!),'no orphan tool results after compaction');}
  if(++n>24)return quiet();return {...call('long-'+n,'get_knowledge',{}),text:'想法还可以顺着另一条路继续看。'.repeat(250),usage:{input:100,output:3000}};
 }));assert.equal(row.state,'completed');const log=JSON.parse(fs.readFileSync(f.root+'/runtime/logs/exploration/'+row.id+'.json','utf8'));assert.ok(log.trace.some((e:any)=>e.contextCompacted));assert.equal(log.trace.filter((e:any)=>e.tool).length,25);assert.ok(maximum<3+2*24);assert.ok(f.state.observations(row.id).nextOffset);}
 finally{f.cleanup();}
});

test('public publishing remains opt-in, uses one durable receipt and does not leak to QQ by itself',async()=>{
 const f=setup();let published=0;const sharp=(await import('sharp')).default,bytes=await sharp({create:{width:20,height:20,channels:4,background:'blue'}}).png().toBuffer();
 const publisher={async upload(){return {richval:'fixture',picBo:'fixture'};},async publish(_text:any,_photo:any,onSubmit:()=>void){onSubmit();published++;return {id:'post-one',url:'https://user.qzone.qq.com/100/mood/post-one'};}};
 try{const media=await f.services.media.fromWeb('private:20002',bytes,'https://example.com/one.png');f.state.manual();const active=f.state.claim()!,tools=new ExplorationTools({...f.services,state:f.state,readRun:()=>({}),publisher:async()=>publisher as any},active,new TurnContext(),new AbortController().signal);
 await assert.rejects(tools.execute('publish_qzone',{text:'今天发现一点海蓝。',imageId:media.id},'a'),/TOOL_NOT_ALLOWED/);assert.equal(published,0);f.state.save({allowPublicPosts:true});await tools.execute('publish_qzone',{text:'今天发现一点海蓝。',imageId:media.id},'b');await tools.execute('publish_qzone',{text:'今天发现一点海蓝。',imageId:media.id},'c');assert.equal(published,1);assert.equal(f.sent(),0);f.state.save({allowPublicPosts:false});await assert.rejects(tools.execute('publish_qzone',{text:'再发',imageId:media.id},'d'),/TOOL_NOT_ALLOWED/);}
 finally{f.cleanup();}
});
