import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {SharedTools} from '../src/agent/shared-tools.js';
import {TurnContext} from '../src/agent/context.js';
import {ExplorationState} from '../src/exploration/state.js';
import {MemoryJournal} from '../src/memory/journal.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import {Store} from '../src/storage/db.js';
import {TiebaAccountClient} from '../src/tieba/client.js';
import {tiebaTools} from '../src/tieba/posting.js';
import {annotateTiebaReplies,isTiebaReplySeen,markTiebaRepliesSeen,tiebaReplyBadge} from '../src/tieba/reply-badge.js';
import {TiebaReplyWatch} from '../src/tieba/reply-watch.js';
import {TiebaSessionManager} from '../src/tieba/session.js';
import type {TiebaReply} from '../src/tieba/replies.js';
import {fixture,message} from './helpers.js';

const account={id:'90',name:'测试账号'},owner='12345',start=1800000000000;
const reply=(id:string,time=start,author='91'):TiebaReply=>({id,time,author:{id:author,name:'来客'},threadId:'200',parentPostId:null,isFloor:false,forum:'大肥鱼',text:'外部回复资料',url:'https://tieba.baidu.com/p/200?pid='+id,replyTarget:'https://tieba.baidu.com/p/200?pid='+id});
function cursors(store:Store,at=start){
 for(const kind of ['reply','mention'])store.setMeta('tieba:'+kind+'-watch',JSON.stringify({account:account.id,since:at-60000,page:1,scanStarted:null,nextCheck:0,lastCheck:null,lastError:null}));
}
function event(store:Store,item:TiebaReply,kind='reply',run:string|null=null){
 store.db.prepare('INSERT INTO tieba_reply_events(account,id,owner,created,detected,due,run_id,payload,kind) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(account.id,item.id,owner,item.time,start,start+300000,run,JSON.stringify(item),kind);
}
function shared(f:ReturnType<typeof fixture>,client:TiebaAccountClient){
 const library=new QQImageLibrary(f.root,f.store);
 return new SharedTools({root:f.root,store:f.store,account:client,memory:new MemoryJournal(f.root,f.store),context:new TurnContext(),signal:new AbortController().signal,
  search:{async search(){throw Error('offline');},async fetch(){throw Error('offline');}},searchEnabled:()=>true,library,identity:{speaker:owner},memoryOrigin:'badge-test',searchActor:'badge-test',guard(){},
  view:(m,ids)=>library.view(m.group,m.user,ids),listImages:(m,source,offset)=>library.list(m.group,m.user,source,offset),listFiles:()=>({files:[]})});
}

test('historical deliveries, watermark history and self replies never become new on deployment',()=>{
 const f=fixture({privateUsers:[owner]});
 try{
  const state=new ExplorationState(f.store,f.cfg);new TiebaReplyWatch(state,()=>false);cursors(f.store);
  const delivered=reply('101'),old=reply('102',start-60001),self=reply('103',start,account.id);
  event(f.store,delivered,'reply','historical-run');
  assert.equal(tiebaReplyBadge(f.store).redDot,false);
  const page=annotateTiebaReplies(f.store,{account,replies:[delivered,old,self]},start);
  assert.equal(page.newCount,0);assert.ok(page.replies.every(r=>r.isNew===false));assert.equal(page.redDotCleared,true);
  assert.equal(tiebaReplyBadge(f.store).redDot,false);
  const reopened=new Store(f.root);
  try{assert.ok(isTiebaReplySeen(reopened,account.id,old));assert.equal(annotateTiebaReplies(reopened,{account,replies:[old]},start+1).newCount,0);}
  finally{reopened.close();}
 }finally{f.cleanup();}
});

test('pending items survive watermark advancement; viewing clears only the returned IDs across feeds',()=>{
 const f=fixture({privateUsers:[owner]});
 try{
  const state=new ExplorationState(f.store,f.cfg);new TiebaReplyWatch(state,()=>false);cursors(f.store);
  const pending=reply('201',start-120000),mention=reply('202');
  event(f.store,pending);event(f.store,mention,'mention');
  assert.equal(tiebaReplyBadge(f.store).unreadCount,2);
  const page=annotateTiebaReplies(f.store,{account,replies:[pending]},start+10);
  assert.equal(page.replies[0].isNew,true);assert.equal(page.newCount,1);assert.equal(page.redDotCleared,true);
  assert.equal(tiebaReplyBadge(f.store).unreadReplies,0);assert.equal(tiebaReplyBadge(f.store).unreadMentions,1);
  markTiebaRepliesSeen(f.store,account.id,[mention.id],'mention',start+20);
  assert.equal(tiebaReplyBadge(f.store).redDot,false);assert.equal(tiebaReplyBadge(f.store).clearedAt,start+20);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tieba_reply_events WHERE run_id IS NULL').get()?.n,0);
  assert.equal(annotateTiebaReplies(f.store,{account,replies:[pending,mention]},start+30).newCount,0);
  assert.equal(isTiebaReplySeen(f.store,'other-account',pending),false);
 }finally{f.cleanup();}
});

test('checkNow lights the badge, get_tieba_replies annotates and clears it, and the watch never wakes viewed IDs',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:[owner]});let now=start,reads=0;
 const item=reply('301'),page={account,page:1,hasMore:false,replies:[item]};
 const client=new TiebaAccountClient(async action=>{
  if(action==='status')return {state:'logged_in',profileSaved:true,identity:account,verifiedAt:now};
  reads++;return action==='mentions'?{...page,mentions:[{...item,isThread:false,threadTitle:'测试'}]}:page;
 });
 try{
  const state=new ExplorationState(f.store,f.cfg,()=>now);state.save({enabled:true});
  const watcher=new TiebaReplyWatch(state,()=>true,client,()=>now);cursors(f.store);
  await watcher.checkNow();assert.equal(reads,1);assert.equal(tiebaReplyBadge(f.store).redDot,true);
  assert.equal(state.status().tiebaRedDot.unreadCount,1);
  assert.equal(state.status().active,null,'pre-check only updates the inbox; it does not wake a run');
  await watcher.checkNow();assert.equal(reads,1,'60-second check limit');
  const tools=shared(f,client),tool=tiebaTools.find(t=>t.function.name==='get_tieba_replies')!;
  const read=()=>tools.execute(tool,{},message('',{group:'private:'+owner,user:owner}),'read',()=> 'badge-read');
  const first=(await read())!.result;
  assert.equal(first.newCount,1);assert.equal(first.replies[0].isNew,true);assert.equal(first.redDotCleared,true);
  assert.equal(tiebaReplyBadge(f.store).redDot,false);
  const again=(await read())!.result;assert.equal(again.newCount,0);assert.equal(again.replies[0].isNew,false);
  now+=60001;await watcher.checkNow();assert.equal(tiebaReplyBadge(f.store).redDot,false);
  now+=300000;watcher.tick();await watcher.idle();watcher.tick(false);
  assert.equal(state.status().active,null);assert.equal(tiebaReplyBadge(f.store).unreadCount,0);
 }finally{f.cleanup();}
});

test('Tieba reply tools and wake notifications derive scope from the actual reply target',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:[owner]}),dir=path.join(f.root,'tieba');
 fs.mkdirSync(dir);
 fs.writeFileSync(path.join(dir,'installed.json'),'{}');
 const topic='https://tieba.baidu.com/p/200';
 const child={...reply('302'),isFloor:true,replyTarget:undefined,replyToPostId:'900'};
 const session=new TiebaSessionManager(dir,async()=>({
  async identity(){return account;},async login(){},async frame(){return Buffer.alloc(0);},async input(){},async close(){},
  async replies(page){return {page,hasMore:false,replies:[reply('301'),child]};},
  async mentions(page){return {page,hasMore:false,mentions:[
   {...reply('401'),threadTitle:'主题里的 @',isThread:true,url:topic,replyTarget:topic},
   {...reply('402'),threadTitle:'未定位的 @',isThread:false,isFloor:true,replyTarget:undefined,targetStatus:'unresolved'},
  ]};},
  async read(url){
   assert.equal(url,'https://tieba.baidu.com/p/comment?tid=200&pid=900&pn=1');
   return {status:'content',thread:{id:'200'},parentPost:{id:'900',parentPostId:null,floor:2},posts:[{id:child.id,parentPostId:'900'}]};
  },
 }));
 const client=new TiebaAccountClient(async(action,input:any)=>{
  assert.ok(action==='replies'||action==='mentions');
  return session[action](input.page);
 });
 try{
  const tools=shared(f,client),m=message('',{group:'private:'+owner,user:owner});
  const read=async(kind:string)=>(await tools.execute(tiebaTools.find(t=>t.function.name==='get_tieba_'+kind)!,{},m,'read',()=> 'scope-read'))!.result[kind];
  const replies=await read('replies'),mentions=await read('mentions');
  assert.deepEqual(replies.map((r:TiebaReply)=>r.replyScope),['floor','subreply']);
  assert.equal(replies[1].replyTarget,'https://tieba.baidu.com/p/comment?tid=200&pid=900&pn=1#302');
  assert.deepEqual(mentions.map((r:TiebaReply)=>r.replyScope),['thread',null]);

  const now=()=>start+300000,state=new ExplorationState(f.store,f.cfg,now),watcher=new TiebaReplyWatch(state,()=>true,client,now);
  state.save({enabled:true});
  cursors(f.store);
  event(f.store,{...reply('405'),isFloor:true,targetStatus:'verified',replyTarget:'https://tieba.baidu.com/p/comment?tid=200&pid=900#405',replyScope:'floor'},'mention');
  event(f.store,reply('406'));
  watcher.tick(false);
  const wake=JSON.parse(String(state.status().active?.instruction));
  assert.deepEqual(wake.mentions.map((r:TiebaReply)=>r.replyScope),['subreply']);
  assert.deepEqual(wake.replies.map((r:TiebaReply)=>r.replyScope),['floor']);
 }finally{await session.close();f.cleanup();}
});

test('pre-check skips disabled and leased inboxes and handles unconfigured/offline accounts without reads',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:[owner]});let calls=0;
 try{
  const state=new ExplorationState(f.store,f.cfg,()=>start);
  const disabled=new TiebaReplyWatch(state,()=>false,new TiebaAccountClient(async()=>{calls++;throw Error('unexpected');}),()=>start);
  await disabled.checkNow();assert.equal(calls,0);
  for(const offline of [false,true]){
   f.store.db.prepare("DELETE FROM meta WHERE key IN ('tieba:reply-badge-check','tieba:reply-watch','tieba:mention-watch')").run();
   const watcher=new TiebaReplyWatch(state,()=>true,new TiebaAccountClient(async action=>{
    calls++;assert.equal(action,'status');if(offline)throw Error('offline');return {state:'unconfigured',profileSaved:false,identity:null,lastIdentity:null};
   }),()=>start);
   await watcher.checkNow();await watcher.checkNow();
   assert.equal(tiebaReplyBadge(f.store).redDot,false);
  }
  assert.equal(calls,2);
  f.store.db.prepare("DELETE FROM meta WHERE key='tieba:reply-badge-check'").run();cursors(f.store);
  for(const kind of ['reply','mention']){
   const key='tieba:'+kind+'-watch',cursor=JSON.parse(f.store.getMeta(key)!);f.store.setMeta(key,JSON.stringify({...cursor,lease:'other-worker',leaseUntil:start+120000}));
  }
  await new TiebaReplyWatch(state,()=>true,new TiebaAccountClient(async()=>{calls++;throw Error('unexpected');}),()=>start).checkNow();
  assert.equal(calls,2);
 }finally{f.cleanup();}
});

test('seen receipts keep only the latest 10000 IDs per account',()=>{
 const f=fixture();
 try{
  markTiebaRepliesSeen(f.store,account.id,Array.from({length:10002},(_,i)=>String(i)),'reply',start);
  markTiebaRepliesSeen(f.store,'another',['retained'],'mention',start);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM tieba_reply_seen WHERE account=?').get(account.id)?.n,10000);
  assert.equal(isTiebaReplySeen(f.store,'another',reply('retained')),true);
 }finally{f.cleanup();}
});

test('a stalled pre-check times out and a late inbox response cannot relight the badge',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:[owner]});let release!:(page:unknown)=>void,reads=0;
 const delayed=new Promise(resolve=>{release=resolve;}),keepAlive=setTimeout(()=>{},3500);
 try{
  const state=new ExplorationState(f.store,f.cfg,()=>start);cursors(f.store);
  const watcher=new TiebaReplyWatch(state,()=>true,new TiebaAccountClient(async action=>{
   if(action==='status')return {state:'logged_in',profileSaved:true,identity:account,verifiedAt:start};
   reads++;return delayed;
  }),()=>start);
  const began=Date.now();await watcher.checkNow();
  assert.equal(reads,1);assert.ok(Date.now()-began<3000);
  const cursor=JSON.parse(f.store.getMeta('tieba:mention-watch')!);
  assert.equal(cursor.lastError,'TIEBA_READ_TIMEOUT');assert.equal(cursor.lease,undefined);
  release({account,page:1,hasMore:false,mentions:[reply('601')]});
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(tiebaReplyBadge(f.store).redDot,false);
  assert.equal(state.status().active,null);
 }finally{clearTimeout(keepAlive);release?.({});f.cleanup();}
});
