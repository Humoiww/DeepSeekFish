import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentDialogue,TurnContext,contextMetrics } from '../src/agent/context.js';
import { MemoryJournal,dayStart } from '../src/memory/journal.js';
import { BudgetedModel } from '../src/agent/model.js';
import { Bot } from '../src/agent/bot.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';
import { MockTransport } from '../src/qq/adapter.js';
import { MockSearchProvider,SearchService } from '../src/search/provider.js';
import { MockImageProvider } from '../src/image/provider.js';
import { fixture,message } from './helpers.js';
import type { ChatMessage,Model } from '../src/types.js';

test('default dialogue is six recent messages including the current question; long past text cannot fill the prompt',()=>{
  const history=Array.from({length:20},(_,i)=>message('message '+i,{id:String(i),at:i}));
  assert.deepEqual(recentDialogue(history,[history[19]]).map(m=>m.id),['14','15','16','17','18','19']);
  assert.deepEqual(recentDialogue(history,[history[18],history[19]]).map(m=>m.id),['14','15','16','17','18','19']);
  const huge=message('长'.repeat(10000),{at:18}),current=message('当前问题',{at:19});
  assert.deepEqual(recentDialogue([huge,current],[current]),[current]);
  assert.deepEqual(recentDialogue(history,[history[10]]).map(m=>m.id),['5','6','7','8','9','10'],'queued future questions must not leak into this answer');
});

test('explicit recall pages dates and keywords within the conversation, with full long messages still recoverable',()=>{
  const f=fixture(),j=new MemoryJournal(f.root,f.store),now=Date.now();
  try{
    for(let i=0;i<9;i++)j.record({id:'recent-'+i,conversation:'g',actor:'u',role:'user',text:'今天 '+i,at:now+i});
    const long='海边露营'+'长'.repeat(6000),old=dayStart(now)-3*86400000;
    j.record({id:'old',conversation:'g',actor:'u',role:'user',text:long,at:old});
    j.record({id:'private',conversation:'g2',actor:'u',role:'user',text:'海边露营的秘密',at:old});
    const page=j.read('g',{},now);assert.equal(page.events.length,6);assert.equal(page.nextOffset,6);
    assert.deepEqual(j.read('g',{offset:6},now).events.map(e=>e.id),['recent-0','recent-1','recent-2']);
    const match=j.read('g',{query:'海边露营'},now);assert.deepEqual(match.events.map(e=>e.id),['old']);assert.equal((match.events[0] as any).nextTextOffset,1500);
    let restored='',offset=0;
    do{const part=j.read('g',{messageId:'old',textOffset:offset},now);restored+=part.events[0].text;offset=part.nextTextOffset!;}while(offset!==null);
    assert.equal(restored,long);
    assert.throws(()=>j.read('g',{messageId:'private'}),/MEMORY_NOT_FOUND/);
    assert.throws(()=>j.read('g',{conversation:'g2'}),/INVALID_TOOL_ARGS/);
    assert.throws(()=>j.read('g',{date:'2026-02-31'}),/INVALID_TOOL_ARGS/);
    const date=new Date(old+8*3600000).toISOString().slice(0,10);assert.equal(j.read('g',{date},now).events[0].id,'old');
  }finally{f.cleanup();}
});

test('old web results and images shrink without losing native pairs, exact full reads or delivery receipts',()=>{
  const ctx=new TurnContext(),raw={posts:Array.from({length:13},(_,i)=>({id:String(i),text:'网页正文'.repeat(300)}))};
  const call:ChatMessage={role:'assistant',content:'',tool_calls:[{id:'web',type:'function',function:{name:'browse_page',arguments:'{"url":"https://example.com"}'}}]};
  const result=ctx.result('browse_page','web',raw,0),picture=ctx.images({role:'user',content:[{type:'text',text:'{"imageId":"media-one"}'},{type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}}]},0);
  const receipt={created:true,delivered:true,imageId:'done',references:['character'],description:'长'.repeat(2000)};
  const delivered=ctx.result('generate_image','delivery',receipt,0),messages=[call,result,picture,delivered];
  const before=contextMetrics(messages,[]);ctx.compact(1);assert.deepEqual(JSON.parse(String(result.content)),raw);
  ctx.compact(3);const after=contextMetrics(messages,[]);
  assert.equal(after.images,0);assert.ok(after.totalTextTokens<before.totalTextTokens/2);
  assert.equal(result.tool_call_id,call.tool_calls![0].id);assert.equal(call.tool_calls![0].function.name,'browse_page');
  assert.deepEqual(JSON.parse(String(delivered.content)),receipt);
  assert.ok(JSON.stringify(picture).includes('media-one'));
  let restored='',offset=0;do{const p=ctx.read({resultId:'web',offset});restored+=p.content;offset=p.nextOffset!;}while(offset!==null);
  assert.deepEqual(JSON.parse(restored),raw);
  assert.throws(()=>new TurnContext().read({resultId:'web'}),/TOOL_RESULT_NOT_FOUND/);
});

test('QQ offers recall autonomously and only adds old chat after the native tool call',async()=>{
  const f=fixture({bufferMs:10000}),transport=new MockTransport();let rounds=0;
  const provider:Model={kind:'fixture',async complete(messages,_max,options){
    rounds++;assert.ok(options?.tools?.some(t=>t.function.name==='recall_chat'));assert.equal(options?.toolChoice,undefined);
    if(rounds===1){assert.ok(!JSON.stringify(messages).includes('海边露营'));assert.equal(messages.length,8);
      return {text:'',tool_calls:[{id:'recall',type:'function',function:{name:'recall_chat',arguments:'{"query":"海边露营"}'}}],usage:{input:100,output:20}};
    }
    const result=JSON.parse(String(messages.at(-1)!.content));assert.equal(result.events[0].text,'海边露营');
    return {text:'想起来了。',usage:{input:100,output:20}};
  }};
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
  try{
    bot.memory.record({id:'old',conversation:'g',actor:'u',role:'user',text:'海边露营',at:Date.now()-5*86400000});
    for(let i=0;i<20;i++)f.store.observe(message('聊点 '+i,{at:Date.now()-20000+i}),48,20);
    await bot.receive(message('我们上次去哪玩了'));await bot.flush();
    assert.equal(rounds,2);assert.equal(transport.sent[0].text,'想起来了。');
  }finally{await bot.stop();f.cleanup();}
});
