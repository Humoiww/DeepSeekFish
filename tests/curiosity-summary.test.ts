import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {fixture} from './helpers.js';
import {BudgetedModel} from '../src/agent/model.js';
import {personaSettings} from '../src/character.js';
import {MemoryJournal} from '../src/memory/journal.js';
import {CuriositySummaryWorker} from '../src/memory/curiosity-summary.js';
import {cacheGroupNames} from '../src/memory/group-names.js';
import {readCuriosity} from '../src/exploration/state.js';
import type {ChatMessage,Model} from '../src/types.js';

function setup(){
 const f=fixture({qqTransport:'onebot',privateUsers:['11223344'],groups:['88776655','88776666'],admins:['11223344']}),journal=new MemoryJournal(f.root,f.store);
 let now=Date.parse('2026-11-22T12:00:00Z'),calls=0,decision='save_curiosity_summary',content='讨论让我想到观察鲸鱼需要耐心。';
 const inputs:ChatMessage[][]=[];
 const provider:Model={kind:'offline',async complete(messages,_max,options){
  calls++;inputs.push(messages);
  const personality=messages.at(-1);
  assert.equal(personality?.role,'system');
  assert.equal(typeof personality?.content,'string');
  for(const block of personaSettings(f.root).blocks){
   if(block.kind!=='kaomoji')assert.ok(String(personality?.content).includes(block.text.trim()));
  }
  assert.equal(options?.toolChoice,undefined);
  const args=decision==='save_curiosity_summary'?{title:'观察的耐心',content}:{};
  return {text:'',tool_calls:[{id:'decision-'+calls,type:'function',function:{name:decision,arguments:JSON.stringify(args)}}],usage:{input:100,output:30}};
 }};
 const model=new BudgetedModel(provider,f.ledger,f.cfg),options={now:()=>now};
 const worker=new CuriositySummaryWorker(f.root,f.store,f.cfg,model,options);
 const record=(id:string,conversation='88776655',role:'assistant'|'user'='assistant',text='聊聊鲸鱼。',at=now)=>journal.record({id,conversation,role,text,at,actor:role==='assistant'?'DeepSeekFish':'55667788'});
 return {...f,journal,worker,model,options,record,inputs,calls:()=>calls,clock:(value:number)=>{now=value;},advance:(ms:number)=>{now+=ms;},now:()=>now,
  skip:()=>{decision='skip_curiosity_summary';},content:(value:string)=>{content=value;},async close(){await worker.stop();f.cleanup();}};
}
const idle=30*60000;

test('only bot speech triggers an idle summary, with per-conversation silence and durable skip',async()=>{
 const f=setup();
 try{
  cacheGroupNames(f.store,[{group_id:'88776655',group_name:'鲸鱼研究会'}]);
  f.record('chatter','88776666','user');f.advance(idle);await f.worker.tick();assert.equal(f.calls(),0);
  f.record('markup','88776666','assistant','<｜｜DSML｜｜ invoke name="reply">');
  f.record('bot');f.advance(idle-1);await f.worker.tick();assert.equal(f.calls(),0);
  f.record('new-bot');f.advance(idle-1);await f.worker.tick();assert.equal(f.calls(),0,'new bot speech resets that conversation');
  f.record('more-chatter','88776655','user');f.advance(1);await f.worker.tick();assert.equal(f.calls(),1,'human chatter does not reset bot silence');
  const list=readCuriosity(f.store,{});assert.equal(list.entries?.length,1);assert.equal(list.entries?.[0].groupName,'鲸鱼研究会');assert.equal(list.entries?.[0].originKind,'group');
  const row=f.store.db.prepare('SELECT conversation,group_name FROM curiosity_entries').get();assert.equal(row?.conversation,'88776655');
  assert.equal(f.ledger.value('tokens'),130,'the background call uses the shared BudgetedModel ledger');
  await f.worker.tick();assert.equal(f.calls(),1);
  f.skip();f.record('owner-bot','private:11223344');f.advance(idle);await f.worker.tick();assert.equal(f.calls(),2);
  assert.equal(readCuriosity(f.store,{}).entries?.length,1,'skip writes no entry');
  await f.worker.tick();assert.equal(f.calls(),2);
  const restarted=new CuriositySummaryWorker(f.root,f.store,f.cfg,f.model,f.options);
  try{await restarted.tick();assert.equal(f.calls(),2,'completed watermarks persist');}finally{await restarted.stop();}
  const logs=fs.readdirSync(f.root+'/runtime/logs/daily-news');assert.equal(logs.filter(name=>name.startsWith('curiosity-')).length,2);
 }finally{await f.close();}
});

test('startup and downtime archives do not become a catch-up queue; expired segments never call models',async()=>{
 const f=setup();
 try{
  f.record('old-archive');f.advance(idle);
  const restarted=new CuriositySummaryWorker(f.root,f.store,f.cfg,f.model,f.options);
  try{
   await restarted.tick();assert.equal(f.calls(),0,'recent pre-start speech is baselined too');
   f.record('fresh');f.advance(7*3600000);await restarted.tick();assert.equal(f.calls(),0,'older than the bounded recency window');
   f.record('new-session');f.advance(idle);await restarted.tick();assert.equal(f.calls(),1);
  }finally{await restarted.stop();}
 }finally{await f.close();}
});

test('summary toggles and conversation authorization are live; private summaries redact identifiers',async()=>{
 const f=setup();
 try{
  f.record('owner','private:11223344');f.content('QQ 11223344 与群号 88776655 的聊天让我想到耐心。');f.advance(idle);
  f.set({curiosityAutoSummary:false});await f.worker.tick();assert.equal(f.calls(),0);
  f.set({curiosityAutoSummary:true,enabled:false});await f.worker.tick();assert.equal(f.calls(),0);
  f.set({enabled:true});await f.worker.tick();assert.equal(f.calls(),1);
  const row=f.store.db.prepare('SELECT * FROM curiosity_entries').get()!;
  assert.equal(row.origin_kind,'private');assert.equal(row.group_name,null);assert.ok(!String(row.content).includes('11223344'));assert.ok(!String(row.content).includes('88776655'));
  assert.match(String(f.inputs[0][0].content),/无法追溯个人/);
  f.record('revoked','88776655');f.set({groups:['88776666']});f.advance(idle);await f.worker.tick();assert.equal(f.calls(),1);
 }finally{await f.close();}
});

test('simultaneous workers serialize a conversation; shutdown aborts a pending bounded model call',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['11223344'],groups:['88776655']}),journal=new MemoryJournal(f.root,f.store);
 let now=Date.now(),calls=0,entered!:()=>void;
 const ready=new Promise<void>(resolve=>{entered=resolve;});
 const provider:Model={kind:'offline',async complete(_messages,_max,options){calls++;entered();return new Promise<never>((_resolve,reject)=>{options!.signal!.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});}};
 const model=new BudgetedModel(provider,f.ledger,f.cfg),one=new CuriositySummaryWorker(f.root,f.store,f.cfg,model,{now:()=>now}),two=new CuriositySummaryWorker(f.root,f.store,f.cfg,model,{now:()=>now});
 try{
  await one.tick();await two.tick();
  journal.record({id:'bot',conversation:'88776655',actor:'DeepSeekFish',role:'assistant',text:'值得想想。',at:now});now+=idle;
  const pending=one.tick();
  await Promise.race([ready,pending.then(()=>assert.fail('summary finished before starting the model'))]);
  await two.tick();assert.equal(calls,1);
  await one.stop();await pending;assert.equal(f.store.db.prepare('SELECT lock FROM curiosity_summary_watermarks WHERE conversation=?').get('88776655')?.lock,null);
 }finally{await one.stop();await two.stop();f.cleanup();}
});
