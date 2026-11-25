import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, message,assertPersonaLayout,assertVoiceHint,seedVoiceExamples } from './helpers.js';
import { MockModel, BudgetedModel, messageText } from '../src/agent/model.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';
import { MockTransport } from '../src/qq/adapter.js';
import { MockSearchProvider, SearchService } from '../src/search/provider.js';
import { MockImageProvider, CodexImageProvider } from '../src/image/provider.js';
import { Bot } from '../src/agent/bot.js';
import { SocialGate } from '../src/social/gate.js';
import {cacheGroupNames} from '../src/memory/group-names.js';
import {writeCuriosity} from '../src/exploration/state.js';
import {Affect} from '../src/affect.js';
import {OUTBOUND_VOICE_HINT} from '../src/character.js';
import {qqContextPrompt} from '../src/prompts.js';
import type {ChatMessage,Model} from '../src/types.js';
function setup(){
  const f=fixture({codex:true,search:true,images:true,bufferMs:10000});
  const provider=new MockModel(),model=new BudgetedModel(provider,f.ledger,f.cfg),tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),transport=new MockTransport();
  const search=new SearchService(new MockSearchProvider(),f.ledger,f.cfg);
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,model,tasks,search,new MockImageProvider(),transport);
  return {...f,bot,provider,tasks,transport};
}

test('QQ keeps the static system prompt identical with mood enabled and places persona last',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['20002'],bufferMs:10000});
 const affect=new Affect(f.store),transport=new MockTransport(),inputs:ChatMessage[][]=[];
 const provider:Model={kind:'fixture',async complete(messages,_max,options){
  assertVoiceHint(options?.tools,'reply','text',OUTBOUND_VOICE_HINT,{type:'string'});
  assertVoiceHint(options?.tools,'send_message','text',OUTBOUND_VOICE_HINT,{type:'string'});
  inputs.push(structuredClone(messages));
  return {text:'收到。',usage:{input:20,output:5}};
 }};
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),
  new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),
  new MockImageProvider(),transport,undefined,undefined,undefined,undefined,undefined,undefined,affect);
 try{
  const group='private:20002',user='20002';
  seedVoiceExamples(f.root);
  affect.configure({moodInfluence:'off'});
  await bot.receive(message('说一说海边',{id:'without-mood',group,user}));await bot.flush();
  affect.configure({moodInfluence:'current'});
  await bot.receive(message('接着说说潮汐',{id:'with-mood',group,user}));await bot.flush();
  assert.equal(inputs.length,2);
  assert.deepEqual(inputs[0][0],{role:'system',content:qqContextPrompt(f.root)});
  assert.deepEqual(inputs[1][0],inputs[0][0]);
  const contexts=inputs.map(messages=>JSON.parse(String(messages[1].content)));
  assert.equal(contexts[0].mood,undefined);
  assert.equal(contexts[1].mood,affect.expression());
  assert.match(contexts[1].mood,/肥鱼当前心情/);
  assert.deepEqual(Object.keys(contexts[1]).slice(0,5),['character','timezone','day','qqIdentity','currentTurn']);
  assert.equal(contexts[1].currentTurn.messageId,'with-mood');
  for(const messages of inputs)assertPersonaLayout(f.root,messages);
 }finally{await bot.stop();f.cleanup();}
});

test('QQ private group retrieval and public curiosity share tools while groups cannot cross-read',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['11223344'],admins:['11223344'],groups:['88776655','88776666'],bufferMs:10000}),transport=new MockTransport();
 let name='',args:unknown={},issued=false,output:any,offered:string[]=[];
 const provider:Model={kind:'offline',async complete(messages,_max,options){
  if(!issued){issued=true;offered=options?.tools?.map(t=>t.function.name)??[];return {text:'',tool_calls:[{id:'read',type:'function',function:{name,arguments:JSON.stringify(args)}}],usage:{input:20,output:10}};}
  output=JSON.parse(String(messages.findLast(m=>m.role==='tool')?.content));return {text:'看完啦。',usage:{input:20,output:10}};
 }};
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
 const run=async(tool:string,input:unknown,group='private:11223344')=>{
  name=tool;args=input;issued=false;output=undefined;
  await bot.receive(message('看看记录',{group,user:'11223344'}));await bot.flush();return output;
 };
 try{
  cacheGroupNames(f.store,[{group_id:'88776655',group_name:'鲸鱼研究会'},{group_id:'88776666',group_name:'小猫茶室'}]);
  bot.memory.record({id:'group-event',conversation:'88776666',actor:'55667788',sender:{nickname:'小猫'},role:'user',text:'鲸鱼很有趣',at:Date.now()});
  writeCuriosity(f.store,'offline',{title:'鲸鱼的想法',content:'鲸鱼研究会的交流很有启发。QQ 55667788，群号 88776655。'},Date.now(),{originKind:'group',groupName:'鲸鱼研究会',conversation:'88776655'});
  const list=await run('list_conversations',{});assert.equal(list.private,'private:11223344');assert.equal(list.groups[1].groupName,'小猫茶室');
  const recall=await run('recall_chat',{conversation:'88776666',query:'鲸鱼'});assert.equal(recall.groupName,'小猫茶室');assert.equal(recall.events[0].speakerLabel,'小猫');
  const found=await run('search_memory',{kind:'group',query:'鲸鱼'});assert.equal(found.items[0].groupName,'小猫茶室');
  const read=await run('read_memory',{id:found.items[0].id});assert.equal(read.text,'鲸鱼很有趣');
  for(const group of ['private:11223344','88776655']){
   const journal=await run('read_curiosity',{},group),encoded=JSON.stringify(journal);
   assert.match(encoded,/鲸鱼研究会/);for(const secret of ['88776655','55667788','private:','conversation'])assert.ok(!encoded.includes(secret));
   assert.ok(offered.includes('read_curiosity'));assert.ok(!offered.includes('write_curiosity'));
   if(group==='88776655')for(const tool of ['list_conversations','search_memory','read_memory','remember_memory'])assert.ok(!offered.includes(tool));
  }
  for(const tool of ['list_conversations','search_memory','read_memory'])assert.equal((await run(tool,tool==='search_memory'?{query:'鲸鱼'}:tool==='read_memory'?{id:'group:88776666:group-event'}:{},'88776655')).error,'TOOL_NOT_ALLOWED');
  assert.equal((await run('recall_chat',{conversation:'88776666',query:'鲸鱼'},'88776655')).error,'CONVERSATION_NOT_ALLOWED');
  f.set({groupChatSearch:false,curiosityPublicSearch:false});
  assert.equal((await run('list_conversations',{})).error,'TOOL_NOT_ALLOWED');assert.ok(!offered.includes('list_conversations'));
  assert.equal((await run('read_curiosity',{},'88776655')).error,'TOOL_NOT_ALLOWED');assert.ok(!offered.includes('read_curiosity'));
  assert.equal((await run('recall_chat',{conversation:'88776666',query:'鲸鱼'})).error,'CONVERSATION_NOT_ALLOWED');
 }finally{await bot.stop();f.cleanup();}
});
test('ordinary messages cost zero model calls; mentions coalesce; groups isolate; dedup and self echo',async()=>{
  const f=setup();try{
    await f.bot.receive(message('讨论普通消息',{mentioned:false,event:'ordinary'}));await f.bot.flush();assert.equal(f.provider.calls,0);
    await f.bot.receive(message('其他群的秘密',{group:'g2',mentioned:false,event:'ordinary'}));await f.bot.flush();
    const m=message('你好小鱼');await f.bot.receive(m);await f.bot.receive(m);await f.bot.receive(message('第二条'));await f.bot.receive(message('机器人回声',{bot:true}));await f.bot.flush();
    assert.equal(f.provider.calls,1);assert.equal(f.transport.sent.length,1);assert.equal(f.store.history('g',20).length,3);
    assert.ok(!f.transport.sent[0].text.includes('秘密'));
    await f.bot.receive(message('继续普通消息',{mentioned:false,event:'ordinary'}));await f.bot.flush();assert.equal(f.provider.calls,1,'old mentions must not retrigger');
    await f.bot.receive(message('未知群',{group:'blocked'}));await f.bot.flush();assert.equal(f.store.history('blocked',20).length,0);
  }finally{await f.bot.stop();f.cleanup();}
});
test('nonadmin Codex/image rejected before model; admin request requires local approval; artifacts delivered',async()=>{
  const f=setup();try{
    await f.bot.receive(message('/fish codex 偷读文件',{user:'stranger'}));
    await f.bot.receive(message('/fish image 图片',{user:'stranger'}));assert.equal(f.provider.calls,0);assert.equal(f.tasks.list().length,0);
    await f.bot.receive(message('/fish codex 创建 hello'));const task=f.tasks.list()[0];assert.equal(task.state,'waiting');assert.equal(f.ledger.value('codex'),0);
    f.tasks.approve(task.id);await f.tasks.idle();assert.equal(f.tasks.get(task.id).state,'succeeded');
    assert.equal(f.ledger.value('codex'),1);assert.ok(f.transport.files[0].endsWith('result.txt'));assert.ok(fs.existsSync(f.transport.files[0]));
    await f.bot.receive(message('/fish result '+task.id,{group:'g2'}));assert.ok(f.transport.sent.at(-1)!.text.includes('TASK_GROUP_MISMATCH'));
  }finally{await f.bot.stop();f.cleanup();}
});
test('search cache and source attachment; image Mock is valid and real provider reports unsupported',async()=>{
  const f=setup();try{
    await f.bot.receive(message('/fish search DeepSeek'));await f.bot.receive(message('/fish search DeepSeek'));
    assert.equal(f.ledger.value('search'),1);assert.ok(f.transport.sent.at(-1)!.text.includes('https://example.com/mock'));
    await f.bot.receive(message('/fish image 一张图'));assert.ok(f.transport.files.at(-1)!.endsWith('.png'));
    assert.equal((await new CodexImageProvider().generate()).status,'unsupported');
    await f.bot.receive(message('/fish search http://127.0.0.1'));assert.equal(f.ledger.value('search'),2,'a search string is sent to the fixed provider; it does not fetch a host URL');
  }finally{await f.bot.stop();f.cleanup();}
});
test('budget exhausted and disabled bot cannot invoke provider; bounded rolling history',async()=>{
  const f=setup();try{
    f.set({dailyCny:0});await f.bot.receive(message());await f.bot.flush();assert.equal(f.provider.calls,0);
    f.set({enabled:false});await f.bot.receive(message());await f.bot.flush();assert.equal(f.provider.calls,0);
    f.set({enabled:true,windowSize:3});for(let i=0;i<10;i++)await f.bot.receive(message('ordinary '+i,{mentioned:false,event:'ordinary'}));await f.bot.flush();
    assert.equal(f.store.history('g',100).length,3);
    f.store.clear('g');assert.equal(f.store.history('g',100).length,0);
  }finally{await f.bot.stop();f.cleanup();}
});
test('group activation requires a mention or keyword even with legacy auto-reply and social flags',()=>{
  const f=fixture({autonomous:true,autoReply:true,probability:1,activity:1,dailyInterjections:1});try{
    const gate=new SocialGate(f.cfg,f.ledger,()=>0),now=Date.now();
    const a=message('AI真有意思',{mentioned:false,event:'ordinary',at:now-1000}),b=message('AI好玩',{mentioned:false,event:'ordinary',at:now});
    assert.equal(gate.decide([a,b],now),undefined);
    assert.equal(gate.decide([a,{...b,text:'今天吃什么'}],now),undefined);
    assert.equal(gate.decide([{...a,at:now-200000}],now),undefined);
    gate.record('g');assert.equal(gate.decide([a,b],now),undefined);
    assert.equal(gate.decide([{...b,text:'dEePsEeK 过来看看'}],now),'name');
    f.set({names:[]});assert.equal(gate.decide([{...b,text:'肥鱼 Deepseek'}],now),undefined);
    assert.equal(gate.decide([message('explicit')],now),'mention');
  }finally{f.cleanup();}
});
test('QQ archives full text but does not inject old records, even when the question mentions them',async()=>{
  const f=setup();let payload:any;
  try{
    f.set({historyHours:168});
    const old=message('三天前的海边露营',{at:Date.now()-3*86400000});
    f.store.observe(old,168,20);f.bot.memory.record({id:old.id,conversation:old.group,actor:old.user,role:'user',text:old.text,at:old.at});
    const complete=f.provider.complete.bind(f.provider);
    f.provider.complete=async(messages,max)=>{payload={...JSON.parse(messageText(messages[1])),messages:messages.slice(2).map(m=>({text:messageText(m)}))};return complete(messages,max);};
    await f.bot.receive(message('长消息'+ '甲'.repeat(3000)));await f.bot.flush();
    assert.ok(payload.messages.every((m:any)=>!m.text.includes('三天前')));
    assert.equal(payload.memory,undefined);
    const row=f.store.db.prepare('SELECT text FROM memory_events WHERE role=? ORDER BY seq DESC LIMIT 1').get('user') as any;
    assert.equal(row.text.length,3003);
    await f.bot.receive(message('还记得“海边露营”吗'));await f.bot.flush();
    assert.equal(payload.memory,undefined,'recall is a model-selected tool, not a keyword route');
    assert.equal(f.bot.memory.read('g',{query:'海边露营'}).events[0].id,old.id);
    assert.ok(payload.messages.every((m:any)=>!m.text.includes('三天前')));
  }finally{await f.bot.stop();f.cleanup();}
});
