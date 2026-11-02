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
import { knowledgeTokens } from '../src/memory/knowledge.js';

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

test('two read pages keep their exact story text across rounds while bulky metadata stays retrievable by section',()=>{
 const ctx=new TurnContext(),pages=Array.from({length:2},(_,page)=>({url:'https://tieba.baidu.com/p/123?pn='+(page+1),title:'故事',status:'content',text:('第'+page+'章：角色醒来，看到了新世界。\n').repeat(45),
  posts:Array.from({length:10},(_,i)=>({id:String(i),floor:i+1,author:{name:'作者'},commentsUrl:'https://tieba.baidu.com/p/comment?tid=123&pid='+i})),
  images:Array.from({length:23},(_,i)=>({url:'https://example.com/'+('very-long-image-address-'.repeat(12))+i+'.jpg',label:'配图'+i})),links:[{url:'https://tieba.baidu.com/p/123?pn='+(page+2),label:'下一页'}],nextPage:'https://tieba.baidu.com/p/123?pn='+(page+2)}));
 const messages=pages.map((p,i)=>ctx.result('browse_page','page'+i,p,i));
 const original=knowledgeTokens(JSON.stringify(pages));
 ctx.compact(2);
 assert.deepEqual(messages.map(m=>JSON.parse(String(m.content)).text),pages.map(p=>p.text),'reading page two must not erase page one');
 assert.ok(contextMetrics(messages,[]).textTokens<original*.55);
 ctx.compact(12);assert.deepEqual(messages.map(m=>JSON.parse(String(m.content)).text),pages.map(p=>p.text));
 assert.deepEqual(ctx.read({resultId:'page0'}).content,pages[0].text,'default recovery is readable body, not an escaped JSON envelope');
 const images=ctx.read({resultId:'page0',section:'images',offset:10});assert.deepEqual(images.items,pages[0].images.slice(10,20));assert.equal(images.nextOffset,20);
 assert.deepEqual(ctx.read({resultId:'page0',section:'posts'}).items,pages[0].posts);
 let full='',offset=0;do{const chunk=ctx.read({resultId:'page0',section:'raw',offset});full+=chunk.content;offset=chunk.nextOffset!;}while(offset!==null);
 assert.deepEqual(JSON.parse(full),pages[0]);assert.throws(()=>ctx.read({resultId:'page0',section:'private'}),/INVALID_TOOL_ARGS/);
 const slice=ctx.result('read_tool_result','slice',ctx.read({resultId:'page0',section:'raw'}),3);ctx.compact(5);
 assert.equal(JSON.parse(String(slice.content)).resultId,'page0');assert.equal(JSON.parse(String(slice.content)).previouslyRead,true);assert.ok(String(slice.content).length<250);
});

test('many read pages share a bounded text window, with exact omitted text and provider pagination recoverable',()=>{
 const ctx=new TurnContext(),pages=Array.from({length:4},(_,i)=>({url:'https://example.com/'+i,content:('长篇叙述第'+i+'节。').repeat(1800),source:'DeepSeek Fetch',offset:0,nextOffset:6000,totalCharacters:19000,truncated:true}));
 const messages=pages.map((p,i)=>ctx.result('fetch_page','p'+i,p,i));ctx.compact(4);
 const views=messages.map(m=>JSON.parse(String(m.content)));assert.ok(views.reduce((sum,v)=>sum+knowledgeTokens(v.content),0)<=4000);assert.equal(views[3].source,'DeepSeek Fetch');
 assert.ok(views[0].retainedText);assert.equal(views[3].nextOffset,6000);assert.equal(views[3].truncated,true);
 let text='',offset=0;do{const r=ctx.read({resultId:'p0',offset});text+=r.content;offset=r.nextOffset!;}while(offset!==null);
 assert.equal(text,pages[0].content);
 const structured={text:'正文见 posts',posts:[{content:'真正的B站动态',author:{name:'作者'}}]};
 assert.deepEqual(JSON.parse(String(ctx.result('browse_page','feed',structured,5).content)),structured);
 const empty=ctx.result('browse_page','empty',{text:'',textOffset:7000,nextTextOffset:null,posts:[{id:1}],images:Array.from({length:20},()=>({url:'https://example.com/a.png'}))},6);
 ctx.compact(7);const view=JSON.parse(String(empty.content));assert.equal(view.text,'');assert.equal(view.textOffset,7000);assert.equal(view.nextTextOffset,null);assert.equal(view.images.length,2);assert.equal(view.details.images.count,20);
});

test('QQ ends a long tool turn through native reply even if the closing response first emits textual protocol',async()=>{
 const f=fixture({bufferMs:10000}),transport=new MockTransport();let rounds=0,closingCalls=0;
 const provider:Model={kind:'fixture',async complete(_messages,_max,options){
  rounds++;assert.equal(options?.final,undefined);
  if(rounds<=15){assert.equal(options?.toolChoice,undefined);return {text:'',tool_calls:[{id:'recall-'+rounds,type:'function',function:{name:'recall_chat',arguments:'{}'}}],usage:{input:100,output:20}};}
  closingCalls++;assert.deepEqual(options?.tools?.map(t=>t.function.name),['reply']);assert.equal(options?.toolChoice,'reply');
  if(closingCalls===1)return {text:'<｜｜DSML｜｜ invoke name="read_tool_result">not a native call',usage:{input:100,output:20}};
  return {text:'',tool_calls:[{id:'done',type:'function',function:{name:'reply',arguments:JSON.stringify({text:'先聊聊已经读到的这段。'})}}],usage:{input:100,output:20}};
 }};
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
 try{await bot.receive(message('从头讲一部分'));await bot.flush();assert.equal(rounds,17);assert.equal(closingCalls,2);assert.deepEqual(transport.sent.map(x=>x.text),['先聊聊已经读到的这段。']);}
 finally{await bot.stop();f.cleanup();}
});
