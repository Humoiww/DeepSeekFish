import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ExplorationState} from '../src/exploration/state.js';
import {MemoryIndex} from '../src/memory/index.js';
import {MemoryJournal} from '../src/memory/journal.js';
import {toolFailure} from '../src/agent/tool-feedback.js';
import {fixture} from './helpers.js';
import {cacheGroupNames,groupName} from '../src/memory/group-names.js';
import {writeCuriosity,readCuriosity,ensureCuriositySchema} from '../src/exploration/state.js';
import {PromptNumberGuard} from '../src/agent/prompt-numbers.js';
import type {ChatMessage} from '../src/types.js';

test('the local index backfills chat and exploration, updates with the archive, and scopes genuine evidence',()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['12345']});
 try{
  const journal=new MemoryJournal(f.root,f.store),state=new ExplorationState(f.store,f.cfg);
  const at=Date.parse('2026-11-21T00:05:00+08:00'),now=()=>at;
  const record=(id:string,owner:string,text:string)=>journal.record({id,conversation:'private:'+owner,actor:owner,role:'user',text,at});
  record('source','12345','请记住回执中的公开状态。');
  for(const [args,field,reason] of [
   [{messageId:'source',query:'回执'},'query','incompatible_with_messageId'],
   [{textOffset:1},'textOffset','requires_messageId'],
   [{date:'2026-02-31'},'date','invalid_calendar_date'],
   [{message_id:'source'},'message_id','unknown_field'],
  ] as const){
   assert.throws(()=>journal.read('private:12345',args,at),error=>{
    assert.deepEqual(toolFailure(error,'recall_chat'),{error:'INVALID_TOOL_ARGS',stage:'recall_chat',field,reason});
    return true;
   });
  }
  record('private','56789','另一个会话的回执中的公开状态。');
  const {run}=state.manual();
  state.observation(run.id,0,'publish_tieba',{content:'公开状态'},{deliveryStatus:'accepted',requestId:'receipt'});
  state.observation(run.id,1,'search_memory',{query:'公开状态'},{});
  const index=new MemoryIndex(f.store);
  const chat=index.search('12345',{query:'回执 公开状态',date:'2026-11-21'});
  assert.deepEqual(chat.items.map(item=>item.id),['chat:source']);
  const action=index.search('12345',{query:'公开状态',kind:'activity'}).items;
  assert.deepEqual(action.map(item=>item.id),['action:'+run.id+':0']);
  const receipt=index.read('12345',{id:action[0].id});
  assert.equal(receipt.deliveryStatus,'accepted');
  assert.equal(receipt.requestId,'receipt');
  assert.throws(()=>index.read('12345',{id:'chat:private'}),/MEMORY_REFERENCE_NOT_FOUND/);
  assert.throws(()=>index.search('12345',{query:'公开状态',date:'2026-02-31'}),/INVALID_TOOL_ARGS/);
  assert.deepEqual(index.search('12345',{query:'回执',date:'2026-11-20'}).items,[]);
  record('later','12345','后来取得了实时复查回执。');
  assert.equal(index.search('12345',{query:'实时复查'}).items[0].id,'chat:later');
  f.store.db.prepare('UPDATE memory_events SET text=? WHERE event_id=?').run('后来已经复核成功。','later');
  assert.deepEqual(index.search('12345',{query:'实时复查'}).items,[]);
  assert.equal(index.search('12345',{query:'复核成功'}).items[0].id,'chat:later');
  f.store.db.prepare('DELETE FROM memory_events WHERE event_id=?').run('later');
  assert.deepEqual(index.search('12345',{query:'复核成功'}).items,[]);
  assert.deepEqual(index.search('12345',{query:'" OR ( '}).items,[]);
  const note={title:'公开复查',text:'平台受理后查公开状态',references:[action[0].id,'chat:source']};
  assert.throws(()=>index.remember('12345',{...note,references:['chat:private']},'chat:source',now()),/MEMORY_REFERENCE_NOT_FOUND/);
  const saved=index.remember('12345',note,'chat:source',now());
  assert.equal(index.remember('12345',{...note,references:[...note.references].reverse()},'chat:source',now()).reused,true);
  assert.deepEqual(index.search('12345',{kind:'note',query:'公开复查 受理'}).items.map(item=>item.id),[saved.id]);
  assert.equal(index.read('12345',{id:saved.id}).text,note.text);
  assert.throws(()=>index.read('56789',{id:saved.id}),/MEMORY_REFERENCE_NOT_FOUND/);
  assert.deepEqual(index.remember('12345',{title:'补充',text:'短记'},'chat:source',now()).references,['chat:source']);
 }finally{f.cleanup();}
});

test('group and curiosity index use live authorization, collision-free handles and real names',()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['11223344'],groups:['88776655','88776666']});
 try{
  const journal=new MemoryJournal(f.root,f.store),at=Date.now();
  cacheGroupNames(f.store,[{group_id:88776655,group_name:'鲸鱼研究会\n'},{group_id:88776666,group_name:'小猫茶室'}]);
  assert.equal(groupName(f.store,'88776655'),'鲸鱼研究会');
  for(const conversation of ['private:11223344','88776655','88776666','99999999'])journal.record({id:'same:event',conversation,actor:'55667788',sender:{nickname:'阿猫',card:'猫猫'},role:'user',text:'观察鲸鱼的讨论',at});
  const entry=writeCuriosity(f.store,'offline',{title:'鲸鱼观察',content:'从鲸鱼研究会的交流想到观察的耐心。'},at,{originKind:'group',groupName:'鲸鱼研究会',conversation:'88776655'});
  ensureCuriositySchema(f.store);ensureCuriositySchema(f.store);
  const old=new MemoryIndex(f.store);
  assert.deepEqual(old.search('11223344',{query:'鲸鱼'}).items.map(row=>row.id),['chat:same:event']);
  const index=new MemoryIndex(f.store,{cfg:f.cfg});
  const found=index.search('11223344',{query:'鲸鱼',kind:'group'}).items;
  assert.equal(found.length,2);assert.equal(new Set(found.map(row=>row.id)).size,2);
  const handle='group:88776655:same:event',detail=index.read('11223344',{id:handle,kind:'group',conversation:'88776655'});
  assert.equal(detail.groupName,'鲸鱼研究会');assert.equal(detail.speakerLabel,'猫猫');assert.equal(detail.sender.nickname,'阿猫');
  assert.equal(detail.text,'观察鲸鱼的讨论');assert.deepEqual(detail.readWith,{tool:'read_memory',args:{id:handle}});
  assert.deepEqual(index.search('11223344',{query:'鲸鱼',conversation:'88776655',kind:'group'}).items.map(row=>row.id),[handle]);
  assert.equal(index.read('11223344',{id:'curiosity:'+entry.id}).groupName,'鲸鱼研究会');
  assert.throws(()=>index.read('55667788',{id:handle}),/MEMORY_REFERENCE_NOT_FOUND/);
  f.set({groups:['88776666']});assert.throws(()=>index.read('11223344',{id:handle}),/MEMORY_REFERENCE_NOT_FOUND/);
  f.set({groupChatSearch:false,curiosityPublicSearch:false});
  assert.deepEqual(index.search('11223344',{query:'鲸鱼',kind:'group'}).items,[]);
  assert.deepEqual(index.search('11223344',{query:'鲸鱼',kind:'curiosity'}).items,[]);
  assert.throws(()=>index.search('11223344',{query:'鲸鱼',conversation:'88776666'}),/CONVERSATION_NOT_ALLOWED/);
  assert.throws(()=>index.read('11223344',{id:'curiosity:'+entry.id}),/MEMORY_REFERENCE_NOT_FOUND/);
 }finally{f.cleanup();}
});

test('public curiosity projects legacy revisions and hides conversation and account numbers',()=>{
 const f=fixture();
 try{
  const encodedAccount='%31%31%32%32%33%33%34%34';
  const first=writeCuriosity(f.store,'offline',{
   title:'来自群号 88776655 的想法',
   content:'QQ 11223344 在 private:11223344 提到鲸鱼。旧账号 '+encodedAccount,
   sources:['https://example.com/88776655','https://example.com/'+encodedAccount,'https://example.com/whales'],
  },Date.now(),{originKind:'group',groupName:'鲸鱼研究会',conversation:'88776655'});
  writeCuriosity(f.store,'offline',{id:first.id,version:1,content:'以耐心观察鲸鱼。'});
  for(const args of [{},{id:first.id}]){
   const result=readCuriosity(f.store,args),encoded=JSON.stringify(result);
   assert.match(encoded,/鲸鱼研究会/);assert.match(encoded,/group/);
   assert.ok(!encoded.includes('88776655'));assert.ok(!encoded.includes('11223344'));assert.ok(!encoded.includes('conversation'));assert.ok(!encoded.includes('run_id'));
   assert.ok(!encoded.includes(encodedAccount));assert.ok(encoded.includes('https://example.com/whales'));
  }
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM curiosity_revisions').get() as any).n,2);
 }finally{f.cleanup();}
});

test('number guard learns senders and group handles from both memory result tools',()=>{
 const f=fixture();
 try{
  for(const name of ['search_memory','read_memory']){
   const messages:ChatMessage[]=[{role:'assistant',content:'',tool_calls:[{id:'lookup',type:'function',function:{name,arguments:'{}'}}]},
    {role:'tool',tool_call_id:'lookup',content:JSON.stringify({id:'group:88776655:event',actor:'55667788',groupName:'鲸鱼研究会',text:'[QQ 11223344] 资料'})}];
   const guard=new PromptNumberGuard(messages,f.store);
   for(const number of ['88776655','55667788','11223344'])assert.throws(()=>guard.text(number),/PROMPT_NUMBER_BLOCKED/);
   guard.text('鲸鱼研究会里有人聊过鲸鱼。');
  }
 }finally{f.cleanup();}
});
