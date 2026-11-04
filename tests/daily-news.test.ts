import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {writePrivate} from '../src/paths.js';
import {DailyNews,newsSlot,newsMemory,newsStatus} from '../src/qq/daily-news.js';
import {MemoryJournal} from '../src/memory/journal.js';
import {knowledgeSnapshot} from '../src/memory/knowledge.js';
import {FishError,type ChatMessage} from '../src/types.js';
import type {BudgetedModel} from '../src/agent/model.js';
import {PROJECT_TIMEZONE} from '../src/time.js';

const morning=Date.parse('2026-11-03T08:00:00+08:00'),url='https://example.com/news/today';
function setup(){
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],search:true}),journal=new MemoryJournal(f.root,f.store);
  writePrivate(f.root,'runtime/data/daily-news.json',JSON.stringify({enabled:true,owner:'20002',startsOn:'2026-11-03',timezone:PROJECT_TIMEZONE}));
  let now=morning,modelCalls=0,searches=0,fetches=0,newsRound=0,sendFailure='',sends=0,unverifiedSource=false;
  const deliveries:any[]=[],contexts:ChatMessage[][]=[];
  const call=(name:string,args:unknown)=>({text:'',tool_calls:[{id:'call-'+modelCalls,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}],usage:{input:100,output:50}});
  const model:Pick<BudgetedModel,'complete'>={async complete(_group,user,m,options){
    modelCalls++;contexts.push(structuredClone(m));
    if(user==='memory-review')return call('finish_memory',{memory:{version:knowledgeSnapshot(f.root).version,changes:[{action:'add',text:'记住主人喜欢鲸鱼。'}]}});
    assert.ok(options?.tools?.some(t=>t.function.name==='update_knowledge'));
    if(++newsRound===1)return call('search_web',{query:'鲸鱼 近期 新闻'});
    if(newsRound===2)return call('fetch_page',{url});
    return call('draft_news',{text:'翻到个有意思的鲸鱼消息，给你看看。',sources:[unverifiedSource?'https://example.com/invented':url]});
  }};
  const search={async search(_q:string,_g:string,_u:string,fresh?:boolean){searches++;assert.equal(fresh,true);return [{title:'鲸鱼的新发现',url,snippet:'公开研究新闻'}];},async fetch(){fetches++;return {url,title:'鲸鱼的新发现',content:'今日的研究报道',status:'content',latestVerified:false,truncated:false,fetchedAt:new Date(now).toISOString(),offset:0,totalCharacters:8,nextOffset:null};}};
  const transport={async send(m:any,text:string){sends++;if(sendFailure)throw new FishError(sendFailure);deliveries.push({m,text});}};
  const daily=()=>new DailyNews(f.root,f.store,f.cfg,model,search,transport,()=>now);
  return {...f,journal,daily,contexts,deliveries,clock:(at:number)=>{now=at;},fakeSource:()=>{unverifiedSource=true;},fail:(code:string)=>{sendFailure=code;},counts:()=>({modelCalls,searches,fetches,sends})};
}
test('08:00 Hong Kong starts one bounded morning window; setup date and pause are respected',async()=>{
  assert.equal(newsSlot(morning-1).inWindow,false);assert.equal(newsSlot(morning).inWindow,true);assert.equal(newsSlot(morning+4*3600000).inWindow,false);
  const f=setup();try{
    f.clock(morning-1);assert.equal((await f.daily().run()).state,'not_due');assert.equal(f.counts().modelCalls,0);
    f.clock(morning-86400000);assert.equal((await f.daily().run()).state,'not_due');
    f.set({enabled:false});await assert.rejects(f.daily().run(),/DISABLED/);
  }finally{f.cleanup();}
});
test('morning reviews memory and researches real sources, sends only to the owner once across restarts',async(t)=>{
  t.mock.method(Date,'now',()=>morning);
  const f=setup();try{
    for(const [id,conversation,text] of [['owner','private:20002','我喜欢鲸鱼'],['other','private:30003','别人的秘密'],['group','g','群里的秘密']] as const)f.journal.record({id,conversation,text,actor:'u',role:'user',at:morning-3600000});
    assert.equal((await f.daily().run()).state,'sent');assert.equal(f.deliveries.length,1);assert.equal(f.deliveries[0].m.group,'private:20002');assert.match(f.deliveries[0].text,/https:\/\/example.com\/news\/today/);
    assert.ok(!JSON.stringify(f.contexts).includes('秘密'));assert.match(knowledgeSnapshot(f.root).content,/主人喜欢鲸鱼/);
    assert.equal((await f.daily().run()).state,'sent');assert.deepEqual(f.counts(),{modelCalls:4,searches:1,fetches:1,sends:1});
    assert.equal(newsStatus(f.root,f.store,morning).last?.state,'sent');assert.equal(f.store.history('private:20002',6).at(-1)?.user,'DeepSeekFish');
  }finally{f.cleanup();}
});
test('unknown QQ send outcome never auto-repeats; known connection failure retries the saved draft only',async()=>{
  for(const code of ['ONEBOT_ACTION_TIMEOUT','ONEBOT_NOT_CONNECTED']){
    const f=setup();try{
      f.fail(code);await assert.rejects(f.daily().run());const before=f.counts();f.fail('');
      const state=(await f.daily().run()).state;
      assert.equal(f.counts().modelCalls,before.modelCalls);assert.equal(f.counts().searches,1);
      if(code==='ONEBOT_ACTION_TIMEOUT'){assert.equal(state,'unknown');assert.equal(f.counts().sends,1);}
      else{assert.equal(state,'sent');assert.equal(f.counts().sends,2);}
    }finally{f.cleanup();}
  }
});
test('active leases and stale submitting records cannot produce a duplicate message',async()=>{
  const f=setup();try{
    const daily=f.daily();f.store.db.prepare("INSERT INTO daily_news(day,owner,state,updated,lease) VALUES ('2026-11-03','20002','preparing',?,?)").run(morning,morning+60000);
    assert.equal((await daily.run()).state,'preparing');assert.equal(f.counts().modelCalls,0);
    f.store.db.prepare("UPDATE daily_news SET state='sending',lease=0").run();assert.equal((await f.daily().run()).state,'unknown');assert.equal(f.counts().sends,0);
  }finally{f.cleanup();}
});
test('news memory excludes older dates and limits text input; standalone review sends no QQ message',async()=>{
  const f=setup();try{
    for(let i=0;i<80;i++)f.journal.record({id:String(i),conversation:'private:20002',actor:'u',role:'user',text:'长篇聊天。'.repeat(200),at:morning-i});
    f.journal.record({id:'old',conversation:'private:20002',actor:'u',role:'user',text:'三天前的话',at:morning-3*86400000});
    const memory=newsMemory(f.store,'20002',morning);assert.ok(memory.textTokens<=2000);assert.ok(!JSON.stringify(memory).includes('三天前的话'));
    await f.daily().remember();assert.equal(f.counts().sends,0);assert.equal(f.counts().searches,0);assert.equal(f.counts().modelCalls,1);
  }finally{f.cleanup();}
});
test('unverified final links cannot be sent as researched news',async()=>{
  const f=setup();try{f.fakeSource();await assert.rejects(f.daily().run(),/TOOL_LIMIT/);assert.equal(f.counts().sends,0);assert.ok(JSON.stringify(f.contexts).includes('DAILY_NEWS_SOURCES_REQUIRED'));}
  finally{f.cleanup();}
});
test('background review can autonomously recall, update and finish without a QQ send',async()=>{
  const f=setup();let round=0;
  try{
    f.journal.record({id:'owner-rule',conversation:'private:20002',actor:'owner',role:'user',text:'我喜欢鲸鱼',at:morning-60000});
    f.journal.record({id:'other-rule',conversation:'private:30003',actor:'other',role:'user',text:'其他人的秘密',at:morning-60000});
    const model:Pick<BudgetedModel,'complete'>={async complete(_group,_user,m,options){
      assert.ok(options?.tools?.some(t=>t.function.name==='recall_chat'));
      const input=JSON.parse(String(m[1].content));assert.ok(input.qqWebTools.some((t:any)=>t.name==='download_image'));assert.ok(input.qqTools.includes('read_forward'));assert.ok(input.qqTools.includes('send_image'));
      assert.ok(!JSON.stringify(m).includes('其他人的秘密'));
      const [name,args]=++round===1?['recall_chat',{}]:round===2?['update_knowledge',{version:0,changes:[{action:'add',text:'主人喜欢鲸鱼'}]}]:['finish_memory',{}];
      return {text:'',tool_calls:[{id:'recall-'+round,type:'function',function:{name:String(name),arguments:JSON.stringify(args)}}],usage:{input:100,output:50}};
    }};
    const search={async search(){throw Error('unexpected search');},async fetch(){throw Error('unexpected fetch');}};
    const daily=new DailyNews(f.root,f.store,f.cfg,model,search,{async send(){throw Error('unexpected send');}},()=>morning);
    const result=await daily.remember();assert.equal(result.ok,true);assert.equal(round,3);assert.equal(result.version,1);assert.match(result.content,/喜欢鲸鱼/);
  }finally{f.cleanup();}
});
