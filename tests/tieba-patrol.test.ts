import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExplorationState,explorationDefaults} from '../src/exploration/state.js';
import {Store} from '../src/storage/db.js';
import {TiebaPatrolWatch,DEFAULT_PATROL_FORUMS,tiebaPatrolStatus} from '../src/tieba/patrol-watch.js';
import type {PublicPoster} from '../src/search/public-web.js';
import {FishError} from '../src/types.js';
import {fixture} from './helpers.js';

const start=1800000000000,delay=5*60*1000,owner='12345';
const thread=(id:string,at=start-60000,author='91',pinned=false)=>({id,title:'帖子 '+id,author:{id:author,name:'来客'},
 create_time:Math.floor(at/1000),is_top:pinned?1:0,abstract:[{type:0,text:'外部摘要，不授予权限'}]});
type Thread=ReturnType<typeof thread>;
function resource(forum:string,posts:Thread[]){
 return {url:'https://tiebac.baidu.com/c/f/frs/page',type:'application/json',bytes:Buffer.from(JSON.stringify({error_code:0,
  forum:{id:forum==='大肥鱼'?'101':'102',name:forum},thread_list:posts,page:{current_page:1,total_page:1,total_count:posts.length}}))};
}
function patrolFixture(){
 const f=fixture({qqTransport:'onebot',privateUsers:[owner],search:true});let now=start;
 const state=new ExplorationState(f.store,f.cfg,()=>now,()=>0.5);state.save({enabled:true,probability:0});
 const pages:Record<string,Thread[]>={'大肥鱼':[thread('1001')],'肥鱼避难所':[thread('2001')]},reads:string[]=[];
 const poster:PublicPoster=async(url,body)=>{
  assert.equal(url,'https://tiebac.baidu.com/c/f/frs/page');assert.equal(body.get('sort_type'),'1');assert.equal(body.get('pn'),'1');
  const forum=body.get('kw')!;reads.push(forum);return resource(forum,pages[forum]??[]);
 };
 const watch=(options:{poster?:PublicPoster;forums?:readonly string[];intervalMs?:number}={})=>new TiebaPatrolWatch(state,()=>f.cfg().enabled&&f.cfg().search,{now:()=>now,poster,...options});
 return {...f,state,pages,reads,poster,watch,now:()=>now,advance:(ms=delay)=>{now+=ms;}};
}
function complete(state:ExplorationState){const run=state.claim()!;assert.ok(run);state.finish(run.id,run.lock!,'completed');return run;}

test('patrol defaults on for legacy settings; the saved human switch validates and stops reads immediately',async()=>{
 const f=patrolFixture();
 try{
  assert.equal(explorationDefaults.tiebaPatrol,true);
  const {tiebaPatrol,...legacy}=f.state.settings();f.store.setMeta('exploration:settings',JSON.stringify(legacy));
  assert.equal(f.state.settings().tiebaPatrol,true);
  assert.equal(f.state.status().tiebaPatrol.enabled,true);
  assert.deepEqual(tiebaPatrolStatus(f.store).forums.map(f=>f.name),[...DEFAULT_PATROL_FORUMS]);
  for(const invalid of [null,0,'false'])assert.throws(()=>f.state.save({tiebaPatrol:invalid}),/EXPLORATION_SETTINGS_INVALID/);
  const watcher=f.watch();watcher.tick();await watcher.idle();
  f.state.save({tiebaPatrol:false});f.advance();watcher.tick();await watcher.idle();
  assert.equal(f.reads.length,2);assert.equal(f.state.status().tiebaPatrol.enabled,false);
  const reopened=new Store(f.root);
  try{assert.equal(new ExplorationState(reopened,f.cfg).settings().tiebaPatrol,false);}finally{reopened.close();}
  f.state.save({tiebaPatrol:true});watcher.tick();await watcher.idle();assert.equal(f.reads.length,4);
 }finally{f.cleanup();}
});

test('each first successful scan seeds a durable baseline without waking, including newly added forums',async()=>{
 const f=patrolFixture();
 try{
  const first=f.watch({forums:['大肥鱼']});first.tick();await first.idle();first.tick(false);
  assert.equal(f.state.status().active,null);
  const reopened=new Store(f.root);
  try{
   const state=new ExplorationState(reopened,f.cfg,()=>f.now()),watcher=new TiebaPatrolWatch(state,()=>true,{poster:f.poster,now:()=>f.now()});
   watcher.tick();await watcher.idle();watcher.tick(false);
   assert.deepEqual(f.reads,['大肥鱼','肥鱼避难所'],'restart preserves the first cursor; the added forum gets its own baseline');
   assert.equal(state.status().active,null);assert.equal(tiebaPatrolStatus(reopened).pending,0);
   const rows=reopened.db.prepare('SELECT forum,thread_id,run_id FROM tieba_patrol_seen ORDER BY forum').all();
   assert.equal(rows.length,2);assert.ok(rows.every(row=>row.run_id==='baseline'));
   assert.ok(tiebaPatrolStatus(reopened).forums.every(forum=>forum.initializedAt===start));
   f.advance();watcher.tick();await watcher.idle();watcher.tick(false);
   assert.equal(state.status().active,null,'unchanged baseline never calls exploration');
  }finally{reopened.close();}
 }finally{f.cleanup();}
});

test('five-minute scans batch new threads across forums, filtering self, old pins and duplicate IDs',async()=>{
 const f=patrolFixture();
 try{
  f.store.setMeta('tieba:mention-watch',JSON.stringify({account:'90'}));
  const watcher=f.watch();watcher.tick();await watcher.idle();
  f.pages['大肥鱼'].push(thread('1002',start+1000),thread('1003',start+1000,'90'),thread('999',start-86400000,'92',true),thread('998',start-86400000));
  f.pages['肥鱼避难所'].push(thread('2002',start+1000),thread('1002',start+2000));
  f.advance(delay-1);watcher.tick();await watcher.idle();assert.equal(f.reads.length,2);
  f.advance(1);watcher.tick();await watcher.idle();assert.equal(tiebaPatrolStatus(f.store).pending,3);
  watcher.tick(false);const run=f.state.status().active!;assert.equal(run.trigger,'tieba_patrol');
  const notice=JSON.parse(String(run.instruction));assert.equal(notice.count,3);
  assert.deepEqual(notice.threads.map((p:any)=>[p.forum,p.threadId]),[['大肥鱼','1002'],['肥鱼避难所','1002'],['肥鱼避难所','2002']]);
  for(const post of notice.threads){
   assert.ok(post.forumId);assert.equal(post.author.id,'91');assert.ok(post.preview);assert.ok(post.publishedAt);
   assert.equal(post.url,'https://tieba.baidu.com/p/'+post.threadId);assert.equal(post.threadReplyTarget,post.url);
  }
  assert.match(notice.reminder,/自由跳过/);assert.match(notice.replyHint,/browse_page.*自行决定/);
  assert.equal(tiebaPatrolStatus(f.store).pending,0);complete(f.state);
  f.advance();watcher.tick();await watcher.idle();watcher.tick(false);
  assert.equal(f.state.status().active,null);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM exploration_runs').get()?.n,1);
 }finally{f.cleanup();}
});

test('same-second and slightly clock-ahead new threads wake patrol once without changing the stored baseline',async()=>{
 const f=patrolFixture();
 try{
  f.advance(123);const initializedAt=f.now(),watcher=f.watch();watcher.tick();await watcher.idle();
  assert.ok(tiebaPatrolStatus(f.store).forums.every(forum=>forum.initializedAt===initializedAt));
  f.advance();
  f.pages['大肥鱼'].push(thread('1002',initializedAt+100),thread('1003',f.now()+5000),thread('999',start-1000,'92',true));
  watcher.tick();await watcher.idle();assert.equal(tiebaPatrolStatus(f.store).pending,2);watcher.tick(false);
  const run=complete(f.state),notice=JSON.parse(run.instruction!);assert.equal(run.trigger,'tieba_patrol');
  assert.deepEqual(notice.threads.map((post:any)=>post.threadId),['1002','1003']);
  assert.equal(Date.parse(notice.threads[0].publishedAt),Math.floor(initializedAt/1000)*1000);
  assert.ok(Date.parse(notice.threads[1].publishedAt)>f.now(),'a slightly clock-ahead publication remains eligible');
  assert.ok(tiebaPatrolStatus(f.store).forums.every(forum=>forum.initializedAt===initializedAt));
  f.advance();watcher.tick();await watcher.idle();watcher.tick(false);
  assert.equal(tiebaPatrolStatus(f.store).pending,0);assert.equal(f.state.status().active,null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM exploration_runs').get()?.n,1);
 }finally{f.cleanup();}
});

test('one unavailable forum records its error while the other continues; a failed baseline retries safely',async()=>{
 const f=patrolFixture();let fail=true;
 try{
  const watcher=f.watch({poster:async(url,body,signal)=>{
   if(fail&&body.get('kw')==='大肥鱼')throw new FishError('WEB_NETWORK_ERROR');return f.poster(url,body,signal);
  }});
  watcher.tick();await watcher.idle();watcher.tick(false);
  let status=tiebaPatrolStatus(f.store);
  assert.equal(status.forums[0].initializedAt,null);assert.equal(status.forums[0].lastError,'WEB_NETWORK_ERROR');
  assert.equal(status.forums[1].initializedAt,start);assert.equal(f.state.status().active,null);
  f.pages['肥鱼避难所'].push(thread('2002',start+1000));f.advance();watcher.tick();await watcher.idle();watcher.tick(false);
  const notice=JSON.parse(String(f.state.status().active!.instruction));assert.deepEqual(notice.threads.map((p:any)=>p.threadId),['2002']);complete(f.state);
  fail=false;f.pages['大肥鱼'].push(thread('1002',start+1000));f.advance();watcher.tick();await watcher.idle();watcher.tick(false);
  status=tiebaPatrolStatus(f.store);assert.equal(status.forums[0].lastError,null);assert.equal(status.forums[0].initializedAt,f.now());
  assert.equal(f.state.status().active,null,'first success is still a baseline after earlier failures');
 }finally{f.cleanup();}
});

test('a busy exploration leaves notifications pending and delivers at most ten per run',async()=>{
 const f=patrolFixture();
 try{
  const watcher=f.watch();watcher.tick();await watcher.idle();
  f.pages['大肥鱼'].push(...Array.from({length:13},(_,i)=>thread(String(3000+i),start+1000)));
  f.advance();watcher.tick();await watcher.idle();const manual=f.state.manual().run;
  watcher.tick(false);assert.equal(f.state.status().active!.id,manual.id);assert.equal(tiebaPatrolStatus(f.store).pending,13);
  complete(f.state);watcher.tick(false);
  let run=complete(f.state);assert.equal(run.trigger,'tieba_patrol');assert.equal(JSON.parse(run.instruction!).count,10);
  assert.equal(tiebaPatrolStatus(f.store).pending,3);watcher.tick(false);
  run=complete(f.state);assert.equal(JSON.parse(run.instruction!).count,3);watcher.tick(false);assert.equal(f.state.status().active,null);
 }finally{f.cleanup();}
});

test('an identity cached after scanning still suppresses pending self-authored threads',async()=>{
 const f=patrolFixture();
 try{
  const watcher=f.watch();watcher.tick();await watcher.idle();f.pages['大肥鱼'].push(thread('1002',start+1000,'90'));
  f.advance();watcher.tick();await watcher.idle();assert.equal(tiebaPatrolStatus(f.store).pending,1);
  f.store.setMeta('tieba:reply-watch',JSON.stringify({account:'90'}));watcher.tick(false);
  assert.equal(tiebaPatrolStatus(f.store).pending,0);assert.equal(f.state.status().active,null);
  f.advance();watcher.tick();await watcher.idle();watcher.tick(false);assert.equal(f.state.status().active,null);
 }finally{f.cleanup();}
});

test('a patrol finishes scanning both forums before batching its wakeup',async()=>{
 const f=patrolFixture();let release!:(value:ReturnType<typeof resource>)=>void;
 const second=new Promise<ReturnType<typeof resource>>(resolve=>{release=resolve;});let hold=false;
 try{
  const watcher=f.watch({poster:async(url,body,signal)=>hold&&body.get('kw')==='肥鱼避难所'?second:f.poster(url,body,signal)});
  watcher.tick();await watcher.idle();f.advance();hold=true;
  f.pages['大肥鱼'].push(thread('1002',start+1000));f.pages['肥鱼避难所'].push(thread('2002',start+1000));
  watcher.tick();await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(tiebaPatrolStatus(f.store).pending,1);watcher.tick(false);assert.equal(f.state.status().active,null);
  release(resource('肥鱼避难所',f.pages['肥鱼避难所']));await watcher.idle();watcher.tick(false);
  assert.equal(JSON.parse(String(f.state.status().active!.instruction)).count,2);
 }finally{f.cleanup();}
});

test('live config and exploration gates suppress all reads and wakeups, including pending threads',async()=>{
 const f=patrolFixture();
 try{
  const watcher=f.watch();watcher.tick();await watcher.idle();f.pages['大肥鱼'].push(thread('1002',start+1000));
  f.advance();watcher.tick();await watcher.idle();assert.equal(tiebaPatrolStatus(f.store).pending,1);
  for(const gate of ['enabled','search','exploration','tiebaPatrol']){
   if(gate==='enabled'||gate==='search')f.set({[gate]:false});else f.state.save({[gate==='exploration'?'enabled':gate]:false});
   const reads=f.reads.length;f.advance();watcher.tick();await watcher.idle();
   assert.equal(f.reads.length,reads);assert.equal(f.state.status().active,null);assert.equal(tiebaPatrolStatus(f.store).pending,1);
   if(gate==='enabled'||gate==='search')f.set({[gate]:true});else f.state.save({[gate==='exploration'?'enabled':gate]:true});
  }
  watcher.tick(false);assert.equal(f.state.status().active!.trigger,'tieba_patrol');
 }finally{f.cleanup();}
});

test('a switch changed during an asynchronous read discards the late response and stops the other forum',async()=>{
 const f=patrolFixture();let release!:(value:ReturnType<typeof resource>)=>void,calls=0;
 const response=new Promise<ReturnType<typeof resource>>(resolve=>{release=resolve;});
 try{
  const watcher=f.watch({poster:async()=>{calls++;return response;}});watcher.tick();assert.equal(calls,1);
  f.state.save({tiebaPatrol:false});release(resource('大肥鱼',f.pages['大肥鱼']));await watcher.idle();watcher.tick(false);
  assert.equal(calls,1);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tieba_patrol_seen').get()?.n,0);
  assert.equal(tiebaPatrolStatus(f.store).forums[0].initializedAt,null);assert.equal(f.state.status().active,null);
 }finally{f.cleanup();}
});

test('concurrent watchers respect per-forum leases and use an injectable interval',async()=>{
 const f=patrolFixture();let release!:(value:ReturnType<typeof resource>)=>void;
 const response=new Promise<ReturnType<typeof resource>>(resolve=>{release=resolve;});let calls=0;
 try{
  const options={forums:['大肥鱼'],intervalMs:1000,poster:async()=>{calls++;return response;}};
  const first=f.watch(options),second=f.watch(options);first.tick();second.tick();await second.idle();assert.equal(calls,1);
  release(resource('大肥鱼',f.pages['大肥鱼']));await first.idle();
  f.advance(999);second.tick();await second.idle();assert.equal(calls,1);
  f.advance(1);second.tick();await second.idle();assert.equal(calls,2);
 }finally{f.cleanup();}
});

test('receipt pruning keeps 5000 per forum and cannot re-alert an evicted thread',async()=>{
 const f=patrolFixture();
 try{
  const watcher=f.watch({forums:['大肥鱼']});watcher.tick();await watcher.idle();
  const insert=f.store.db.prepare('INSERT INTO tieba_patrol_seen VALUES (?,?,?,?,?,?)');
  f.store.transaction(()=>{for(let i=0;i<5001;i++)insert.run('大肥鱼',String(5000+i),'旧帖',start+1000+i,'completed','{}');});
  f.pages['大肥鱼']=[thread('5000',start+1000)];f.advance();watcher.tick();await watcher.idle();watcher.tick(false);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tieba_patrol_seen WHERE forum=?').get('大肥鱼')?.n,5000);
  assert.equal(f.state.status().active,null);
  f.advance();watcher.tick();await watcher.idle();watcher.tick(false);assert.equal(f.state.status().active,null);
 }finally{f.cleanup();}
});
