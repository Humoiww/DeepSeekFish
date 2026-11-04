import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/storage/db.js';
import {normalizeOneBot} from '../src/qq/onebot.js';
import {MemoryJournal,memoryDay} from '../src/memory/journal.js';
import {dialogueMessages} from '../src/agent/context.js';
import {Bot} from '../src/agent/bot.js';
import {BudgetedModel} from '../src/agent/model.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {MockTransport} from '../src/qq/adapter.js';
import {SearchService,MockSearchProvider} from '../src/search/provider.js';
import {MockImageProvider} from '../src/image/provider.js';
import {knowledgeSnapshot,updateKnowledge} from '../src/memory/knowledge.js';
import {newsMemory} from '../src/qq/daily-news.js';
import type {ChatMessage,Model} from '../src/types.js';
import {fixture,message} from './helpers.js';

const native=(user=20002,extra:any={})=>({post_type:'message',message_type:'group',self_id:10001,group_id:123456,user_id:user,message_id:1,time:Math.floor(Date.now()/1000),sender:{user_id:user,nickname:'同名',card:'群名片'},message:[{type:'text',data:{text:'你好'}}],...extra});
test('OneBot retains actual names beside authoritative account IDs, never roles or names from mismatched senders',()=>{
 const a=normalizeOneBot(native(),'10001')!,b=normalizeOneBot(native(30003),'10001')!;
 assert.notEqual(a.user,b.user);assert.deepEqual(a.sender,b.sender);assert.deepEqual(a.sender,{nickname:'同名',card:'群名片'});
 assert.equal(normalizeOneBot(native(20002,{sender:{user_id:30003,nickname:'伪造'}}),'10001')?.sender,undefined);
 const hostile=normalizeOneBot(native(30003,{sender:{user_id:30003,nickname:'老大\n'+ '长'.repeat(200),role:'owner',card:'',password:'secret'}}),'10001')!;
 assert.equal(hostile.user,'30003');assert.equal(hostile.sender?.nickname?.length,100);assert.deepEqual(Object.keys(hostile.sender!),['nickname']);assert.ok(!hostile.sender?.nickname?.includes('\n'));
 assert.deepEqual(normalizeOneBot(native(20002,{message_type:'private'}),'10001')?.sender,{nickname:'同名'});
 assert.equal(normalizeOneBot(native(20002,{sender:undefined}),'10001')?.sender,undefined);
});

test('legacy archives migrate without inventing names; per-message identity survives rename, group changes, pruning and restart',()=>{
 const f=fixture(),file=f.root+'/runtime/data/identity.sqlite';let s:Store|undefined;
 const old=new DatabaseSync(file),now=Date.now();
 old.exec(`CREATE TABLE messages(id TEXT,grp TEXT,usr TEXT,text TEXT,at INTEGER,mentioned INTEGER,event TEXT,PRIMARY KEY(grp,id));
 CREATE TABLE memory_events(seq INTEGER PRIMARY KEY,event_id TEXT,conversation TEXT,actor TEXT,role TEXT,text TEXT,observed INTEGER,day TEXT,source TEXT,UNIQUE(conversation,event_id));`);
 old.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?)').run('legacy','g','20002','旧消息',now-1000,1,'mention');old.close();
 try{
  s=new Store(f.root,'identity.sqlite');let j=new MemoryJournal(f.root,s);j.backfill();
  assert.equal(j.read('g',{messageId:'legacy'}).events[0].sender,undefined);
  const events=[message('同一个人旧称呼',{id:'a',user:'20002',at:now,sender:{nickname:'同名',card:'旧名片'}}),message('同一个人新称呼',{id:'b',user:'20002',at:now+1,sender:{nickname:'新昵称',card:'新名片'}}),message('另一个同名的人',{id:'c',user:'30003',at:now+2,sender:{nickname:'同名',card:'旧名片'}}),message('另一个群的名片',{id:'d',group:'g2',user:'20002',at:now+3,sender:{nickname:'新昵称',card:'第二群名片'}}),message('回复另一个人',{id:'reply',user:'DeepSeekFish',replyTo:'30003',at:now+4})];
  for(const m of events){s.observe(m,24,20);j.record({id:m.id,conversation:m.group,actor:m.user,role:m.user==='DeepSeekFish'?'assistant':'user',text:m.text,at:m.at,sender:m.sender,replyTo:m.replyTo});}
  assert.equal(s.observe({...events[0],sender:{nickname:'重复事件篡改'}},24,20),false);
  s.close();s=new Store(f.root,'identity.sqlite');j=new MemoryJournal(f.root,s);
  const history=s.history('g',20),dialogue=dialogueMessages(history,[events[4]]);
  assert.match(String(dialogue.find(m=>String(m.content).includes('同一个人旧称呼'))?.content),/QQ 20002.*旧名片/);
  assert.match(String(dialogue.find(m=>String(m.content).includes('另一个同名的人'))?.content),/QQ 30003.*旧名片/);
  assert.match(String(dialogue.at(-1)?.content),/回复 QQ 30003/);
  s.prune(24,1);assert.equal(s.history('g',20).length,1);
  assert.equal(j.read('g',{messageId:'a'}).events[0].sender.card,'旧名片');
  assert.equal(j.read('g',{messageId:'b'}).events[0].sender.card,'新名片');
  assert.equal(j.read('g2',{messageId:'d'}).events[0].sender.card,'第二群名片');
  assert.equal(j.read('g',{messageId:'reply'}).events[0].replyTo,'30003');
  assert.equal(j.read('g',{query:'同一个人'}).events.length,2);
  assert.equal(j.recall('g','回忆一下“旧称呼”',[],now+10).events[0].actor,'20002');
  const archive=f.root+'/runtime/memory/days/'+memoryDay(now),lines=fs.readdirSync(archive).flatMap(p=>fs.readFileSync(archive+'/'+p,'utf8').trim().split('\n').map(s=>JSON.parse(s)));
  assert.equal(lines.find(e=>e.id==='a').sender.card,'旧名片');assert.equal(lines.find(e=>e.id==='reply').replyTo,'30003');
 }finally{s?.close();f.cleanup();}
});

test('group turns preserve distinct accounts and reply targets while model-selected memory edits use existing tools',async()=>{
 const f=fixture({qqTransport:'onebot',groups:['123456'],admins:['20002'],privateUsers:['20002'],bufferMs:10000,maxChars:2000}),transport=new MockTransport(),inputs:ChatMessage[][]=[];
 const ownerFact='QQ 20002 希望本鱼称呼其为「老大」。',otherFact='QQ 30003 希望本鱼称呼其为「小林」。';
 updateKnowledge(f.root,{version:0,changes:[{action:'add',text:ownerFact}]});
 const recipients:string[]=[],send=transport.send.bind(transport);transport.send=async(m,text)=>{recipients.push(m.user);await send(m,text);};
 const provider:Model={kind:'fixture',async complete(messages,_max,options){
  inputs.push(structuredClone(messages));const identity=JSON.parse(String(messages[1].content)).qqIdentity;
  assert.equal(identity.speaker,inputs.length===2?'30003':'20002');
  assert.equal(identity.sender.nickname,'同名');assert.ok(options?.tools?.some(t=>t.function.name==='update_knowledge'));
  const args:any={text:'自由回应 '+inputs.length};
  if(inputs.length===2)args.memory={version:knowledgeSnapshot(f.root).version,changes:[{action:'add',text:otherFact}]};
  return {text:'',tool_calls:[{id:'reply-'+inputs.length,type:'function',function:{name:'reply',arguments:JSON.stringify(args)}}],usage:{input:100,output:20}};
 }};
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
 try{
  const m=(user:number,id:number,text:string,mention=true)=>normalizeOneBot(native(user,{message_id:id,sender:{user_id:user,nickname:'同名',card:user===20002?'主人名片':'路人名片'},message:[...(mention?[{type:'at',data:{qq:10001}}]:[]),{type:'text',data:{text}}]}),'10001')!;
  await bot.receive(m(40004,1,'只是路过',false));await bot.flush();assert.equal(inputs.length,0);
  await bot.receive(m(20002,2,'早'));await bot.flush();
  await bot.receive(m(30003,3,'叫我小林'));await bot.flush();
  await bot.receive(m(20002,4,'继续'));await bot.flush();
  assert.deepEqual(recipients,['20002','30003','20002']);assert.equal(inputs.length,3);
  assert.match(String(inputs[1].at(-1)?.content),/QQ 30003.*路人名片.*叫我小林/);
  assert.ok(inputs[1].some(m=>m.role==='assistant'&&String(m.content).includes('[回复 QQ 20002]')));
  assert.match(String(inputs[2][0].content),/QQ 20002.*老大/);assert.match(String(inputs[2][0].content),/QQ 30003.*小林/);
  assert.ok(inputs[2].some(m=>m.role==='assistant'&&String(m.content).includes('[回复 QQ 30003]')));
  const replies=bot.memory.read('123456',{}).events.filter(e=>e.role==='assistant');assert.deepEqual(replies.map(e=>e.replyTo),recipients);
  assert.equal(newsMemory(f.store,'20002').peerQQ,'20002');
  assert.equal(knowledgeSnapshot(f.root).lines.length,2);
  const log=fs.readdirSync(f.root+'/runtime/logs/qq').map(p=>JSON.parse(fs.readFileSync(f.root+'/runtime/logs/qq/'+p,'utf8'))).find(r=>r.messageId==='3');
  assert.equal(log.inputContext.context.qqIdentity.speaker,'30003');assert.equal(log.inputContext.context.qqIdentity.sender.card,'路人名片');
 }finally{await bot.stop();f.cleanup();}
});
