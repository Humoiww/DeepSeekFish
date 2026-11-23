import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fixture} from './helpers.js';
import {TiebaOperationQueue} from '../src/tieba/queue.js';
import {TiebaAccountClient} from '../src/tieba/client.js';
import {TiebaPosting,publishInput,trackTiebaPublication} from '../src/tieba/posting.js';
import {actionState,UnreadFeedback} from '../src/agent/tool-feedback.js';
import {ProviderError} from '../src/diagnostics.js';
import {webServer} from '../src/web/server.js';
import {createWebApp,type WebApp} from '../src/web/app.js';

test('Tieba reply queue assembles one item per reply and retains selected details across pages',()=>{
 const f=fixture(),dir=path.join(f.root,'runtime','tieba');
 const queue=new TiebaOperationQueue(dir,{describe:()=>({}),async cancel(){},restart(){}});
 const db=new DatabaseSync(path.join(dir,'actions.sqlite'));
 try{
  db.exec('CREATE TABLE tieba_actions(id TEXT PRIMARY KEY,request TEXT,result TEXT,state TEXT,created INTEGER)');
  const persist=db.prepare('INSERT INTO tieba_actions VALUES (?,?,?,?,?)');
  const operation=db.prepare('INSERT INTO tieba_operations(id,action,state,created,finished,metadata,result) VALUES (?,?,?,?,?,?,?)');
  const request={action:'reply',threadId:'18420',forumId:'5',content:'第一句真回帖'};
  persist.run('first',JSON.stringify(request),JSON.stringify({requestId:'first',id:'601020',publicVerified:true,
    visibility:'public',verifiedAt:56,checks:{public:{status:'content'}}}),'confirmed',10);
  operation.run('post-first','publish','done',10,12,JSON.stringify({...request,requestId:'first'}),'{}');
  operation.run('verify-first','verify','done',50,56,'{"requestId":"first"}','{}');
  operation.run('read-thread','read','done',57,58,'{}','{}');
  operation.run('screen-shot','frame','done',58,59,'{"requestId":"first"}','{}');
  operation.run('failed-before-ledger','publish','done',20,30,JSON.stringify({...request,requestId:'failed',content:'没有提交的一条'}),'{"outcome":"failed","error":"TIEBA_LOGIN_REQUIRED"}');
  operation.run('not-a-reply','publish','done',56,60,'{"requestId":"thread","action":"thread"}','{}');
  operation.run('still-running','publish','running',57,null,JSON.stringify({...request,requestId:'running'}),null);
  for(let i=0;i<21;i++)operation.run('later-'+i,'publish','done',60+i,90+i,JSON.stringify({...request,requestId:'later-'+i}),'{}');

  const firstPage=queue.snapshot(0,false,true,'first');
  assert.ok('selected' in firstPage);
  assert.equal(firstPage.counts.completed,23);
  assert.equal(firstPage.completed.length,20);
  assert.equal(firstPage.hasMore,true);
  assert.deepEqual(firstPage.active.map(item=>item.id),['running']);
  assert.equal(firstPage.selected?.id,'first');
  assert.equal(firstPage.selected?.metadata.content,request.content);
  assert.equal(firstPage.selected?.result?.visibility,'public');
  assert.equal(firstPage.selected?.result?.checks.public.status,'content');
  assert.deepEqual(firstPage.selected?.steps.map(step=>step.action),['publish','verify']);

  const secondPage=queue.snapshot(20,false,true,'failed');
  assert.ok('selected' in secondPage);
  assert.equal(secondPage.hasMore,false);
  assert.equal(secondPage.completed.filter(item=>item.id==='first').length,1);
  assert.equal(secondPage.selected?.result?.error,'TIEBA_LOGIN_REQUIRED');
  assert.equal(secondPage.selected?.canVerify,false);
  assert.equal(queue.snapshot().completed[0].action,'publish');
 }finally{db.close();queue.close();f.cleanup();}
});

test('the existing WebUI route verifies only the selected reply and preserves the account action',async()=>{
 const f=fixture();
 const calls:{action:string;input:unknown}[]=[];
 const tieba=new TiebaAccountClient(async(action,input)=>{
  calls.push({action,input});
  if(action==='verify')return {requestId:(input as {requestId:string}).requestId,publicVerified:true};
  if(action==='queue')return {view:'replies'};
  return {state:'logged_in'};
 });
 const findPort=createServer();
 findPort.listen(0,'127.0.0.1');await once(findPort,'listening');
 const port=(findPort.address() as import('node:net').AddressInfo).port;
 await new Promise<void>(resolve=>findPort.close(()=>resolve()));
 const app={root:f.root,token:'fixture',tieba,tiebaAudit(){}} as unknown as WebApp;
 const {server}=webServer(app,port);
 server.listen(port,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+port;
 const headers={authorization:'Bearer fixture','content-type':'application/json'};
 const post=(value:unknown)=>fetch(base+'/api/tieba/publication-check',{method:'POST',headers,body:JSON.stringify(value)});
 try{
  assert.equal((await fetch(base+'/api/tieba/queue?replies=1&offset=20&selectedId=older',{headers})).status,200);
  assert.equal((await fetch(base+'/api/tieba/queue?replies=1&offset=20&selectedId=older&filter=attention',{headers})).status,200);
  const status=await fetch(base+'/api/tieba',{headers});assert.equal(status.status,200);assert.deepEqual(await status.json(),{state:'logged_in'});
  assert.deepEqual(await (await post({requestId:'selected'})).json(),{requestId:'selected',publicVerified:true});
  assert.equal((await post({requestId:'selected',submit:true})).status,400);
  assert.equal((await post({})).status,200);
  assert.deepEqual(calls,[
   {action:'queue',input:{offset:20,replies:true,selectedId:'older'}},
   {action:'queue',input:{offset:20,replies:true,selectedId:'older'}},
   {action:'status',input:undefined},
   {action:'verify',input:{requestId:'selected'}},
   {action:'publication-check',input:undefined},
  ]);
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.cleanup();
 }
});

test('reply verification requires a matching body and author from the public reader',async()=>{
 const f=fixture(),dir=path.join(f.root,'runtime','tieba');
 const queue=new TiebaOperationQueue(dir,{describe:()=>({}),async cancel(){},restart(){}});
 const posting=new TiebaPosting(dir),db=new DatabaseSync(path.join(dir,'actions.sqlite'));
 const now=Date.now(),who={id:'55',name:'fixture'},request={action:'reply',threadId:'1885',forumId:'5',content:'回帖正文'};
 try{
  db.prepare('INSERT INTO tieba_actions VALUES (?,?,?,?,?,?,?)').run('reply',who.id,'fixture','accepted',JSON.stringify(request),
   JSON.stringify({submitted:true,id:'7614',receipt:{accepted:true}}),now-3000);
  const hits:string[]=[];
  const result=await posting.verify('reply',who,{
   async followed(){return [];},
   async read(){throw new Error('the public match already provides evidence');},
   async publicRead(url){
    hits.push(url);
    return {status:'content',forum:{id:request.forumId},posts:[
     {id:'7614',author:{id:who.id},publishedAt:new Date(now-1000).toISOString(),content:request.content},
    ]};
   },
  });
  assert.deepEqual(hits,['https://tieba.baidu.com/p/1885?pid=7614']);
  assert.equal(result.publicVerified,true);
  assert.equal(result.visibility,'public');
  assert.equal(result.observed.id,'7614');
 }finally{db.close();posting.close();queue.close();f.cleanup();}
});

test('human Tieba dismissal API acknowledges, restores and keeps future failures visible',async()=>{
 const f=fixture(),now=Date.now(),error={error:'TIEBA_WEB_PRE_SUBMIT_FAILED',outcome:'failed',submitted:false,receipt:{httpAttempts:0,notSubmitted:true}};
 const item=(id:string,state='done',result:any=error)=>({id,state,createdAt:now-5000,finishedAt:state==='done'?now-1000:null,metadata:{requestId:id,action:'reply',content:'保留的原回复'},result});
 const rows=[item('first'),item('second'),item('public','done',{outcome:'public',publicVerified:true}),item('running','running'),item('queued','queued'),item('cleaning','cleaning')];
 let work:any={requestId:'first',created:now-5000,updatedAt:now-1000,stage:'rejected',input:{action:'reply',content:'保留的原回复'},result:error};
 const calls:string[]=[],tieba=new TiebaAccountClient(async(action,input:any)=>{
  calls.push(action);
  if(action==='status')return {state:'logged_in',browserRunning:false,profileSaved:true,publicationWork:work};
  if(action==='queue'){
   const completed=rows.filter(r=>r.state==='done'),offset=input?.offset??0,limit=1;
   return {view:'replies',counts:{completed:completed.length,running:2,queued:1},active:rows.filter(r=>r.state!=='done'),
    completed:completed.slice(offset,offset+limit),selected:rows.find(r=>r.id===input?.selectedId),offset,limit,hasMore:offset+limit<completed.length};
  }
  throw Error('unexpected worker mutation: '+action);
 });
 const app=createWebApp(f.root,true,undefined,undefined,undefined,undefined,tieba);
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
 const port=(probe.address() as import('node:net').AddressInfo).port;await new Promise<void>(resolve=>probe.close(()=>resolve()));
 const {server}=webServer(app,port);server.listen(port,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+port,headers={authorization:'Bearer '+app.token,'content-type':'application/json'};
 const post=(value:unknown,extra:Record<string,string>={})=>fetch(base+'/api/tieba/dismiss',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
 const get=async(route:string)=>{const response=await fetch(base+route,{headers});assert.equal(response.status,200);return response.json() as Promise<any>;};
 const original=JSON.stringify(rows);
 try{
  assert.equal((await post({requestId:'first'},{authorization:'Bearer wrong'})).status,401);
  assert.equal((await post({requestId:'first'},{origin:'https://evil.example'})).status,403);
  for(const bad of [{},{requestId:''},{requestId:' '},{requestId:1},{all:false},{restore:true},{requestId:'first',restore:false},{all:true,requestId:'first'},{all:true,restore:true},{all:true,requestIds:['']},{all:true,requestIds:'first'},{requestId:'first',extra:true}])assert.equal((await post(bad)).status,400,JSON.stringify(bad));
  assert.equal((await post({requestId:'first'})).status,200);
  assert.equal((await get('/api/tieba/queue?replies=1')).completed[0].dismissed,true);
  assert.equal((await get('/api/tieba')).attentionDismissed,true);
  assert.equal((await get('/api/status')).tieba.attentionDismissed,true);
  assert.equal((await post({restore:true,requestId:'first'})).status,200);
  assert.equal((await get('/api/tieba')).attentionDismissed,false);
  const dismissed=await (await post({all:true,requestIds:['first','second','running','public']})).json() as any;
  assert.equal(dismissed.ok,true);
  assert.equal((await get('/api/tieba/queue?replies=1')).completed[0].dismissed,true);
  const ignored=await get('/api/tieba/queue?replies=1&filter=dismissed&offset=1&selectedId=first');
  assert.equal(ignored.completed[0].id,'second');assert.equal(ignored.issueCounts.dismissed,2);assert.equal(ignored.selected.dismissed,true);
  const visible=await get('/api/tieba/queue?replies=1&filter=all');
  assert.deepEqual(visible.completed.map((r:any)=>r.id),['public']);assert.ok(visible.active.every((r:any)=>!r.dismissed));
  assert.equal((await post({restore:true,requestId:'second'})).status,200);
  assert.equal((await get('/api/tieba/queue?replies=1&filter=attention')).completed[0].id,'second');
  assert.equal(JSON.stringify(rows),original,'UI dismissal never mutates worker receipts or history');
  const futureAt=dismissed.dismissedAllAt+1;
  rows.unshift({...item('future'),createdAt:futureAt,finishedAt:futureAt});
  rows.push({...item('finished-later'),createdAt:now-5000,finishedAt:futureAt});
  work={...work,requestId:'future',created:futureAt,updatedAt:futureAt};
  const future=await get('/api/tieba/queue?replies=1&filter=attention');
  assert.equal(future.completed[0].id,'future');assert.equal(future.completed[0].dismissed,false);assert.equal(future.issueCounts.attention,3);
  assert.equal((await get('/api/tieba')).attentionDismissed,false);
  assert.equal((await get('/api/status')).tieba.attentionDismissed,false);
  assert.ok(calls.every(action=>['status','queue'].includes(action)),'no publish, retry, history deletion or account mutation');
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();f.cleanup();
 }
});

// Advance the queue's clock and its timers together, with no real cooldown waits.
// Flush work/cleanup/pump microtasks before and after each clock tick so pacing
// timers are scheduled at the current time before the virtual clock advances.
function pacingClock(t:TestContext){
 let at=1_000_000;
 t.mock.timers.enable({apis:['setTimeout']});
 const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
 return {now:()=>at,flush,async advance(ms:number){await flush();at+=ms;t.mock.timers.tick(ms);await flush();}};
}
const queueLifecycle={describe:()=>({}),async cancel(){},restart(){throw Error('unexpected queue restart');}};

test('Tieba pacing defaults to 60–80 seconds and preserves fixed-interval overrides',()=>{
 const f=fixture();
 try{
  const cases=[
   {options:{},min:60_000,max:80_000},
   {options:{publishIntervalMs:25},min:25,max:25},
   {options:{publishIntervalMs:0},min:0,max:0},
   {options:{publishIntervalMs:25,publishMaxIntervalMs:40},min:25,max:40},
   {options:{publishMaxIntervalMs:90_000},min:60_000,max:90_000},
  ];
  for(const [index,{options,min,max}] of cases.entries()){
   const queue=new TiebaOperationQueue(path.join(f.root,'options-'+index),queueLifecycle,Date.now,options);
   try{assert.deepEqual(queue.snapshot().publishPacing,{intervalMs:min,maxIntervalMs:max,nextPublishAt:null});}finally{queue.close();}
  }
  for(const options of [
   {publishIntervalMs:-1},{publishIntervalMs:NaN},{publishIntervalMs:Infinity},
   {publishMaxIntervalMs:59_999},{publishMaxIntervalMs:NaN},{publishMaxIntervalMs:Infinity},
   {publishIntervalMs:25,publishMaxIntervalMs:24},
  ])assert.throws(()=>new TiebaOperationQueue(path.join(f.root,'invalid'),queueLifecycle,Date.now,options),RangeError);
 }finally{f.cleanup();}
});

test('each completed live publish samples a fresh delay within the default randomized window',async t=>{
 const f=fixture(),clock=pacingClock(t),samples=[0,0.25,0.5,0.75,1],delays=[60_000,65_000,70_000,75_000,80_000];
 let draws=0;
 const queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{random:()=>{draws++;return samples.shift()!;}});
 try{
  for(const [index,delay] of delays.entries()){
   const receipt={requestId:'sample-'+index,submitted:true,deliveryStatus:'accepted'};
   assert.equal(await nonBlockingPublish(queue,receipt.requestId,async()=>receipt),receipt,'idle publishes return the live receipt');
   const pacing=queue.snapshot().publishPacing;
   assert.equal(pacing.nextPublishAt,clock.now()+delay);
   assert.ok(delay>=pacing.intervalMs&&delay<=pacing.maxIntervalMs);
   assert.equal(draws,index+1,'status reads do not sample another slot');
   await clock.advance(delay);
  }
  assert.equal(samples.length,0);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('Tieba injected RNG is clamped and publication-submit uses the same randomized pacing',async t=>{
 const f=fixture(),clock=pacingClock(t),samples=[-1,0.25,0.5,1,2,NaN],delays=[10,15,20,30,30,10];
 const queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{publishIntervalMs:10,publishMaxIntervalMs:30,random:()=>samples.shift()!});
 try{
  for(const [index,delay] of delays.entries()){
   const action=index%2?'publication-submit':'publish';
   await queue.enqueue(action,{},async()=>action==='publish'?{submitted:true}:{publicationWork:{result:{submitted:true}}});
   assert.equal(queue.snapshot().publishPacing.nextPublishAt,clock.now()+delay);
   await clock.advance(delay);
  }
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('Tieba publishes keep FIFO spacing while reads pass queued jobs and execution time starts after pacing',async t=>{
 const f=fixture(),clock=pacingClock(t),intervalMs=100;
 const queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{publishIntervalMs:intervalMs});
 const starts:{id:string;at:number}[]=[],reads:string[]=[];
 let release!:()=>void,secondSignal:AbortSignal|undefined;
 const record=(id:string)=>{starts.push({id,at:clock.now()});return {submitted:true,requestId:id};};
 try{
  const first=queue.enqueue('publish',{requestId:'first',action:'reply'},async()=>record('first'));
  const second=queue.enqueue('publish',{requestId:'second',action:'reply'},async signal=>{
   secondSignal=signal;record('second');await new Promise<void>(resolve=>{release=resolve;});return {submitted:true,requestId:'second'};
  });
  const third=queue.enqueue('publish',{requestId:'third',action:'reply'},async()=>record('third'));
  await first;await clock.flush();
  const next=clock.now()+intervalMs,snapshot=queue.snapshot(),waiting=snapshot.active.find(item=>item.metadata.requestId==='second')!;
  assert.deepEqual(snapshot.publishPacing,{intervalMs,maxIntervalMs:intervalMs,nextPublishAt:next});
  assert.equal(waiting.state,'queued');assert.equal(waiting.scheduledAt,next);
  assert.equal(waiting.startedAt,null);assert.equal(waiting.deadlineAt,null);
  const replies=queue.snapshot(0,false,true,'second');
  assert.ok('selected' in replies);assert.equal(replies.selected?.state,'queued');
  assert.equal(replies.selected?.scheduledAt,next);assert.deepEqual(replies.publishPacing,snapshot.publishPacing);
  // All non-publish account actions remain eligible even behind two publishes.
  for(const action of ['read','replies','mentions','verify','publication-check','frame','publication-frame','account','start','check','input','close']){
   await queue.enqueue(action,{},async()=>{reads.push(action);return {};});
  }
  assert.equal(reads.length,12);assert.deepEqual(starts.map(s=>s.id),['first']);
  await clock.advance(intervalMs-1);assert.deepEqual(starts.map(s=>s.id),['first']);
  await clock.advance(1);
  const running=queue.snapshot().active.find(item=>item.metadata.requestId==='second')!;
  assert.equal(running.state,'running');assert.equal(running.startedAt,next);assert.equal(running.scheduledAt,null);
  assert.equal(running.limitMs,240_000);assert.equal(running.deadlineAt,running.startedAt!+240_000);
  await clock.advance(239_999);assert.equal(secondSignal?.aborted,false);
  assert.equal(queue.snapshot().active.find(item=>item.metadata.requestId==='second')?.state,'running');
  release();await second;await clock.flush();
  assert.deepEqual(starts.map(s=>s.id),['first','second']);
  await clock.advance(intervalMs);await third;
  assert.deepEqual(starts.map(s=>s.id),['first','second','third']);
  for(let i=1;i<starts.length;i++)assert.ok(starts[i].at-starts[i-1].at>=intervalMs);
  await clock.advance(intervalMs);assert.equal(queue.snapshot().publishPacing.nextPublishAt,null);
 }finally{release?.();queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('Tieba pacing and pending publish FIFO survive closing and reopening actions.sqlite',async t=>{
 const f=fixture(),clock=pacingClock(t),dir=path.join(f.root,'tieba'),intervalMs=100;
 let queue=new TiebaOperationQueue(dir,queueLifecycle,clock.now,{publishIntervalMs:intervalMs});
 const sent:{id:string;at:number}[]=[];
 try{
  await queue.enqueue('publish',{},async()=>({submitted:true}));
  const next=queue.snapshot().publishPacing.nextPublishAt;
  for(const requestId of ['second','third'])void queue.enqueue('publish',{requestId,action:'reply'},async()=>{throw Error('old connection must never dispatch');},
   {payload:{requestId,input:{action:'reply',forumId:'5',threadId:'123',content:requestId}},key:'publish:'+requestId});
  await clock.flush();queue.close();
  const db=new DatabaseSync(path.join(dir,'actions.sqlite'));
  try{assert.equal((db.prepare("SELECT value FROM tieba_queue_meta WHERE key='next_publish_at'").get() as {value:string}).value,String(next));}finally{db.close();}
  queue=new TiebaOperationQueue(dir,queueLifecycle,clock.now,{publishIntervalMs:intervalMs});
  assert.equal(queue.snapshot().publishPacing.nextPublishAt,next);
  queue.restore(async payload=>{sent.push({id:payload.requestId,at:clock.now()});return {submitted:true,requestId:payload.requestId};});
  await clock.flush();
  assert.equal(queue.snapshot().active.length,2);assert.ok(queue.snapshot().active.every((item,index)=>item.state==='queued'&&item.scheduledAt===Number(next)+index*intervalMs));
  await queue.enqueue('read',{},async()=>({status:'content'}));assert.equal(sent.length,0);
  await clock.advance(intervalMs-1);assert.equal(sent.length,0);
  await clock.advance(1);assert.deepEqual(sent,[{id:'second',at:next}]);
  await clock.advance(intervalMs);assert.deepEqual(sent.map(s=>s.id),['second','third']);
  assert.equal(queue.snapshot().counts.queued,0);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('Tieba preview outcomes and local input validation never add a publish cooldown',async t=>{
 const f=fixture(),clock=pacingClock(t);let draws=0;
 const queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{publishIntervalMs:100,publishMaxIntervalMs:180,random:()=>{draws++;return 0;}});
 const starts:number[]=[];
 try{
  await queue.enqueue('publish',{},async()=>({mode:'preview'}));
  await queue.enqueue('publication-submit',{},async()=>({publicationWork:{result:{mode:'preview'}}}));
  assert.equal(queue.snapshot().publishPacing.nextPublishAt,null);
  await assert.rejects(queue.enqueue('publish',{},async()=>publishInput({action:'reply',content:'missing forum'})));
  await assert.rejects(queue.enqueue('publication-submit',{},async()=>{throw new ProviderError('TIEBA_PUBLICATION_WINDOW_CHANGED',{stage:'input_validation',requestSent:false});}));
  for(const code of ['TIEBA_SECTION_REQUIRED','TIEBA_SECTION_NOT_AVAILABLE']){
   await assert.rejects(queue.enqueue('publish',{},async()=>{throw new ProviderError(code,{field:'sectionId',reason:'invalid section'});}),{code});
   assert.equal(queue.snapshot().publishPacing.nextPublishAt,null);
  }
  await queue.enqueue('publish',{},async()=>({stage:'input_validation',error:'TIEBA_PUBLISH_INPUT_INVALID'}));
  assert.equal(queue.snapshot().publishPacing.nextPublishAt,null);
  assert.equal(draws,0,'preview and validation do not consume a random pacing slot');
  await queue.enqueue('publish',{},async()=>{starts.push(clock.now());return {submitted:true};});
  assert.deepEqual(starts,[1_000_000]);
  assert.equal(queue.snapshot().publishPacing.nextPublishAt,clock.now()+100);
  assert.equal(draws,1);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('Tieba restart after an interrupted publish waits a full interval without replaying the uncertain job',async t=>{
 const f=fixture(),clock=pacingClock(t),dir=path.join(f.root,'tieba');
 const initial=new TiebaOperationQueue(dir,queueLifecycle,clock.now,{publishIntervalMs:100});initial.close();
 const db=new DatabaseSync(path.join(dir,'actions.sqlite'));
 try{
  db.prepare('INSERT INTO tieba_operations(id,action,state,created,started,metadata) VALUES (?,?,?,?,?,?)')
   .run('uncertain','publish','running',clock.now()-50,clock.now()-20,'{"requestId":"uncertain","action":"reply"}');
  db.prepare('INSERT INTO tieba_operations(id,action,state,created,metadata,payload) VALUES (?,?,?,?,?,?)')
   .run('pending','publish','queued',clock.now()-10,'{"requestId":"pending","action":"reply"}',JSON.stringify({requestId:'pending',input:{action:'reply',content:'next'}}));
 }finally{db.close();}
 const queue=new TiebaOperationQueue(dir,queueLifecycle,clock.now,{publishIntervalMs:100}),sent:string[]=[];
 try{
  assert.equal(queue.snapshot().completed[0].state,'interrupted');
  queue.restore(async payload=>{sent.push(payload.requestId);return {submitted:true};});
  await clock.flush();assert.equal(queue.snapshot().active[0].scheduledAt,clock.now()+100);
  await clock.advance(99);assert.equal(sent.length,0);
  await clock.advance(1);assert.deepEqual(sent,['pending']);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('Tieba publication-submit shares the publish pacing slot and advances it for later publishes',async t=>{
 const f=fixture(),clock=pacingClock(t),queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{publishIntervalMs:100});
 const sent:string[]=[];
 try{
  await queue.enqueue('publish',{},async()=>{sent.push('publish');return {submitted:true};});
  const submit=queue.enqueue('publication-submit',{},async()=>{sent.push('submit');return {publicationWork:{result:{submitted:true}}};});
  const publish=queue.enqueue('publish',{},async()=>{sent.push('later');return {submitted:true};});
  await clock.flush();assert.deepEqual(sent,['publish']);
  assert.equal(queue.snapshot().active.find(item=>item.action==='publication-submit')?.scheduledAt,clock.now()+100);
  await clock.advance(100);await submit;assert.deepEqual(sent,['publish','submit']);
  await clock.advance(99);assert.deepEqual(sent,['publish','submit']);
  await clock.advance(1);await publish;assert.deepEqual(sent,['publish','submit','later']);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('Tieba live publish execution timeout preserves the next publish cooldown',async t=>{
 const f=fixture(),clock=pacingClock(t),queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{publishIntervalMs:100});
 let laterStarted=false;
 try{
  const expired=assert.rejects(queue.enqueue('publish',{requestId:'timeout'},signal=>new Promise((_resolve,reject)=>{
   signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })),/TIEBA_QUEUE_EXECUTION_TIMEOUT/);
  const later=queue.enqueue('publish',{requestId:'later'},async()=>{laterStarted=true;return {submitted:true};});
  await clock.flush();await clock.advance(240_000);await expired;
  const result=queue.snapshot().completed[0].result;
  assert.equal(result?.outcome,'timeout');assert.equal(result?.timeout.cleanup.state,'stopped');
  assert.equal(laterStarted,false);assert.equal(queue.snapshot().active[0].state,'queued');
  assert.equal(queue.snapshot().active[0].scheduledAt,clock.now()+100);
  await queue.enqueue('verify',{},async()=>({publicVerified:false}));assert.equal(laterStarted,false);
  await clock.advance(100);await later;assert.equal(laterStarted,true);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('Tieba pacing timers are unreferenced and cleared by both stop and close',async t=>{
 const f=fixture(),clear=t.mock.method(globalThis,'clearTimeout');
 const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
 try{
  for(const end of ['stop','close'] as const){
   const queue=new TiebaOperationQueue(path.join(f.root,end),queueLifecycle);
   let sent=false,closed=false;
   try{
    assert.equal(queue.snapshot().publishPacing.intervalMs,60_000);
    assert.equal(queue.snapshot().publishPacing.maxIntervalMs,80_000);
    await queue.enqueue('publish',{},async()=>({submitted:true}));
    void queue.enqueue('publish',{},async()=>{sent=true;return {submitted:true};});
    await flush();
    const timer=(queue as unknown as {paceTimer?:NodeJS.Timeout}).paceTimer;
    assert.ok(timer);assert.equal(timer.hasRef(),false);
    queue[end]();closed=end==='close';
    assert.equal((queue as unknown as {paceTimer?:NodeJS.Timeout}).paceTimer,undefined);
    assert.ok(clear.mock.calls.some(call=>call.arguments[0]===timer));
    await flush();assert.equal(sent,false);
   }finally{if(!closed)queue.close();}
  }
 }finally{f.cleanup();}
});

function nonBlockingPublish(queue:TiebaOperationQueue,requestId:string,work:(signal:AbortSignal)=>Promise<any>){
 const input={action:'reply',forumId:'5',threadId:'123',content:requestId};
 return queue.enqueue('publish',{...input,requestId},work,{payload:{requestId,input},key:'publish:'+requestId,returnImmediatelyIfQueued:true});
}
async function immediateReceipt(promise:Promise<any>,flush:()=>Promise<void>){
 return Promise.race([promise,flush().then(()=>{throw Error('queued receipt waited for background work');})]);
}

test('non-blocking publish still waits for the real receipt when idle and deduplicates a running request',async t=>{
 const f=fixture(),clock=pacingClock(t),queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{publishIntervalMs:100});
 const real={requestId:'first',submitted:true,published:true,deliveryStatus:'confirmed'};
 let release!:()=>void,started=0,returned=false;
 try{
  const first=nonBlockingPublish(queue,'first',async()=>{started++;await new Promise<void>(resolve=>{release=resolve;});return real;});
  void first.then(()=>{returned=true;});
  assert.equal(queue.pendingPublication('first')?.state,'queued');
  await clock.flush();assert.equal(returned,false);assert.equal(started,1);
  const pending=queue.pendingPublication('first');
  assert.equal(pending?.state,'running');assert.equal(pending?.deliveryStatus,'running');
  assert.equal(pending?.queuePosition,0);assert.equal(pending?.scheduledAt,null);
  const reused=await immediateReceipt(nonBlockingPublish(queue,'first',async()=>{throw Error('duplicate dispatch');}),clock.flush);
  assert.equal(reused.reused,true);assert.equal(reused.deliveryStatus,'running');assert.equal(reused.state,'running');
  assert.equal(queue.snapshot().active.length,1);
  assert.deepEqual(queue.publicationQueue().counts,{queued:0,running:1});
  release();assert.equal(await first,real);assert.equal(returned,true);
  assert.equal(queue.pendingPublication('first'),undefined);
  assert.deepEqual(queue.publicationQueue().active,[]);
  const completed=await nonBlockingPublish(queue,'first',async()=>{throw Error('completed request dispatched again');});
  assert.equal(completed.reused,true);assert.equal(completed.deliveryStatus,'confirmed');
 }finally{release?.();queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('queued publish receipts return immediately, persist payloads and automatically send once in FIFO order',async t=>{
 const f=fixture(),clock=pacingClock(t),dir=path.join(f.root,'tieba'),intervalMs=65_000,nextIntervalMs=75_000,samples=[0.25,0.75,0];
 const queue=new TiebaOperationQueue(dir,queueLifecycle,clock.now,{random:()=>samples.shift()!}),sent:string[]=[];
 const send=async(id:string)=>{sent.push(id);return {requestId:id,submitted:true};};
 try{
  await nonBlockingPublish(queue,'first',()=>send('first'));
  const scheduledAt=clock.now()+intervalMs;
  const second=await immediateReceipt(nonBlockingPublish(queue,'second',()=>send('second')),clock.flush);
  assert.deepEqual(queue.publicationQueue().active.map(item=>[item.queuePosition,item.scheduledAt,item.metadata.content]),[[1,scheduledAt,'second']]);
  for(const [key,value] of Object.entries({queued:true,deliveryStatus:'queued',submissionStatus:'queued',submitted:false,published:false,requestId:'second',action:'publish',queuePosition:1,scheduledAt,retryScheduled:false}))assert.equal(second[key],value,key);
  assert.match(second.notice,/1分钟到1分20秒随机间隔排队/);assert.match(second.notice,/勿重试勿重复发/);assert.equal(second.error,undefined);
  const third=await immediateReceipt(nonBlockingPublish(queue,'third',()=>send('third')),clock.flush);
  assert.equal(third.queuePosition,2);assert.equal(third.scheduledAt,scheduledAt+70_000,'later slots estimate the middle of the random window');
  // A fourth call for the second request is a receipt lookup, not another job.
  const duplicate=await immediateReceipt(nonBlockingPublish(queue,'second',async()=>{throw Error('duplicate dispatch');}),clock.flush);
  assert.equal(duplicate.reused,true);assert.equal(duplicate.queuePosition,1);assert.equal(duplicate.scheduledAt,scheduledAt);
  assert.equal(queue.snapshot().counts.queued,2);
  const db=new DatabaseSync(path.join(dir,'actions.sqlite'));
  try{
   const rows=db.prepare("SELECT state,payload FROM tieba_operations WHERE json_extract(metadata,'$.requestId')='second'").all() as {state:string;payload:string}[];
   assert.equal(rows.length,1);assert.equal(rows[0].state,'queued');
   assert.deepEqual(JSON.parse(rows[0].payload),{requestId:'second',input:{action:'reply',forumId:'5',threadId:'123',content:'second'}});
  }finally{db.close();}
  const pending=queue.pendingPublication('second');
  assert.equal(pending?.state,'queued');assert.equal(pending?.queuePosition,1);assert.equal(pending?.scheduledAt,scheduledAt);
  await queue.enqueue('read',{},async()=>({status:'content'}));
  assert.deepEqual(sent,['first']);
  await clock.advance(intervalMs-1);assert.deepEqual(sent,['first']);
  await clock.advance(1);assert.deepEqual(sent,['first','second']);
  assert.equal(queue.pendingPublication('second'),undefined);
  assert.equal(queue.pendingPublication('third')?.queuePosition,1);
  assert.equal(queue.pendingPublication('third')?.scheduledAt,clock.now()+nextIntervalMs);
  await clock.advance(nextIntervalMs-1);assert.deepEqual(sent,['first','second']);
  await clock.advance(1);assert.deepEqual(sent,['first','second','third']);
  assert.equal(queue.pendingPublication('third'),undefined);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('publish returns a queued receipt while either a read or another publish occupies the worker',async t=>{
 const f=fixture(),clock=pacingClock(t);
 try{
  for(const action of ['read','publish']){
   const queue=new TiebaOperationQueue(path.join(f.root,action),queueLifecycle,clock.now,{publishIntervalMs:100});
   let release!:()=>void,sent=false;
   try{
    const blocker=queue.enqueue(action,{requestId:'blocker'},async()=>{await new Promise<void>(resolve=>{release=resolve;});return action==='publish'?{submitted:true}:{status:'content'};});
    await clock.flush();
    const queued=await immediateReceipt(nonBlockingPublish(queue,'later',async()=>{sent=true;return {submitted:true};}),clock.flush);
    assert.equal(queued.queued,true);assert.equal(queued.deliveryStatus,'queued');assert.equal(queued.queuePosition,1);
    assert.equal(sent,false);assert.equal(queue.pendingPublication('later')?.state,'queued');
    release();await blocker;await clock.flush();
    if(action==='publish'){assert.equal(sent,false);await clock.advance(100);}
    assert.equal(sent,true);assert.equal(queue.pendingPublication('later'),undefined);
   }finally{release?.();queue.stop();await queue.drained();queue.close();}
  }
 }finally{f.cleanup();}
});

test('publish returns immediately when a read is queued before the pump starts',async t=>{
 const f=fixture(),clock=pacingClock(t),queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{publishIntervalMs:100});
 let release!:()=>void,sent=false;
 try{
  const blocker=queue.enqueue('read',{},async()=>{await new Promise<void>(resolve=>{release=resolve;});return {status:'content'};});
  const receipt=await immediateReceipt(nonBlockingPublish(queue,'later',async()=>{sent=true;return {submitted:true};}),clock.flush);
  assert.equal(receipt.deliveryStatus,'queued');assert.equal(receipt.queuePosition,1);assert.equal(sent,false);
  await clock.flush();release();await blocker;await clock.flush();assert.equal(sent,true);
 }finally{release?.();queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('non-blocking queued publication status and deduplication survive restart',async t=>{
 const f=fixture(),clock=pacingClock(t),dir=path.join(f.root,'tieba');
 let queue=new TiebaOperationQueue(dir,queueLifecycle,clock.now,{publishIntervalMs:100,publishMaxIntervalMs:180,random:()=>0.75}),sent=0;
 try{
  await nonBlockingPublish(queue,'first',async()=>({submitted:true}));
  await immediateReceipt(nonBlockingPublish(queue,'saved',async()=>{throw Error('old worker dispatched');}),clock.flush);
  const nextPublishAt=clock.now()+160;
  assert.equal(queue.snapshot().publishPacing.nextPublishAt,nextPublishAt);
  queue.close();queue=new TiebaOperationQueue(dir,queueLifecycle,clock.now,{publishIntervalMs:100,publishMaxIntervalMs:180,random:()=>0});
  assert.equal(queue.snapshot().publishPacing.nextPublishAt,nextPublishAt,'restart preserves the sampled slot without drawing a new delay');
  assert.equal(queue.pendingPublication('saved')?.state,'queued');
  // Deduplicate against the durable row even before restore has scheduled it.
  const duplicate=await immediateReceipt(nonBlockingPublish(queue,'saved',async()=>{throw Error('duplicate dispatch');}),clock.flush);
  assert.equal(duplicate.reused,true);assert.equal(queue.snapshot().counts.queued,1);
  const restore=async()=>{sent++;return {submitted:true};};queue.restore(restore);queue.restore(restore);
  await clock.advance(159);assert.equal(sent,0);
  await clock.advance(1);assert.equal(sent,1);assert.equal(queue.pendingPublication('saved'),undefined);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('queued background failures are journaled and do not interrupt subsequent automatic publishes',async t=>{
 const f=fixture(),clock=pacingClock(t),queue=new TiebaOperationQueue(path.join(f.root,'tieba'),queueLifecycle,clock.now,{publishIntervalMs:100});
 let sent=false;
 try{
  await nonBlockingPublish(queue,'first',async()=>({submitted:true}));
  await immediateReceipt(nonBlockingPublish(queue,'failed',async()=>{throw new ProviderError('TIEBA_LOGIN_REQUIRED',{});}),clock.flush);
  await immediateReceipt(nonBlockingPublish(queue,'later',async()=>{sent=true;return {submitted:true};}),clock.flush);
  await clock.advance(100);
  assert.equal(queue.pendingPublication('failed'),undefined);
  assert.equal(queue.snapshot().completed.find(item=>item.metadata.requestId==='failed')?.result.error,'TIEBA_LOGIN_REQUIRED');
  assert.equal(sent,false);
  await clock.advance(100);assert.equal(sent,true);
 }finally{queue.stop();await queue.drained();queue.close();f.cleanup();}
});

test('queued receipts remain queued in tool feedback and retain queue metadata in last-attempt tracking',async()=>{
 const f=fixture(),feedback=new UnreadFeedback(f.store,'tieba-queue');
 const queued={requestId:'waiting',queued:true,deliveryStatus:'queued',submissionStatus:'queued',submitted:false,published:false,queuePosition:2,scheduledAt:1_060_000,retryScheduled:false};
 try{
  assert.equal(actionState(queued),'queued');
  assert.equal(actionState({deliveryStatus:'queued',error:'stale error'}),'queued');
  assert.equal(actionState({queued:true,deliveryStatus:'unconfirmed'}),'queued');
  feedback.record('publish_tieba',queued);feedback.record('check_tieba_publication',{...queued,queued:undefined});
  assert.deepEqual(feedback.previous(),{});
  const result=await trackTiebaPublication(f.store,{action:'reply',forumId:'5',threadId:'123',content:'waiting'},'waiting',async()=>queued);
  assert.equal(result.deliveryStatus,'queued');assert.equal(result.submissionStatus,'queued');
  const last=JSON.parse(f.store.getMeta('tieba:last-attempt')!);
  assert.equal(last.result.queued,true);assert.equal(last.result.queuePosition,2);assert.equal(last.result.scheduledAt,queued.scheduledAt);
  feedback.record('publish_tieba',{error:'TIEBA_LOGIN_REQUIRED',deliveryStatus:'failed'});
  assert.equal(feedback.previous().previousToolErrors?.length,1,'real failures still reach unread feedback');
 }finally{f.cleanup();}
});
