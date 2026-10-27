import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, message } from './helpers.js';
import { MockModel, BudgetedModel } from '../src/agent/model.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';
import { MockTransport } from '../src/qq/adapter.js';
import { MockSearchProvider, SearchService } from '../src/search/provider.js';
import { MockImageProvider, CodexImageProvider } from '../src/image/provider.js';
import { Bot } from '../src/agent/bot.js';
import { SocialGate } from '../src/social/gate.js';
function setup(){
  const f=fixture({codex:true,search:true,images:true,bufferMs:10000});
  const provider=new MockModel(),model=new BudgetedModel(provider,f.ledger,f.cfg),tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),transport=new MockTransport();
  const search=new SearchService(new MockSearchProvider(),f.ledger,f.cfg);
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,model,tasks,search,new MockImageProvider(),transport);
  return {...f,bot,provider,tasks,transport};
}
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
    await f.bot.receive(message('/fish search http://127.0.0.1'));assert.equal(f.ledger.value('search'),1);
  }finally{await f.bot.stop();f.cleanup();}
});
test('budget exhausted and disabled bot cannot invoke provider; bounded rolling history',async()=>{
  const f=setup();try{
    f.set({dailyTokens:1});await f.bot.receive(message());await f.bot.flush();assert.equal(f.provider.calls,0);
    f.set({enabled:false});await f.bot.receive(message());await f.bot.flush();assert.equal(f.provider.calls,0);
    f.set({enabled:true,windowSize:3});for(let i=0;i<10;i++)await f.bot.receive(message('ordinary '+i,{mentioned:false,event:'ordinary'}));await f.bot.flush();
    assert.equal(f.store.history('g',100).length,3);
    f.store.clear('g');assert.equal(f.store.history('g',100).length,0);
  }finally{await f.bot.stop();f.cleanup();}
});
test('SocialGate observes activity/topic changes and persists cooldown/daily cap',()=>{
  const f=fixture({autonomous:true,probability:1,activity:1,dailyInterjections:1});try{
    const gate=new SocialGate(f.cfg,f.ledger,()=>0),now=Date.now();
    const a=message('AI真有意思',{mentioned:false,event:'ordinary',at:now-1000}),b=message('AI好玩',{mentioned:false,event:'ordinary',at:now});
    assert.equal(gate.decide([a,b],now),'interest');
    assert.equal(gate.decide([a,{...b,text:'今天吃什么'}],now),undefined);
    assert.equal(gate.decide([{...a,at:now-200000}],now),undefined);
    gate.record('g');assert.equal(gate.decide([a,b],now),undefined);
    f.store.setMeta('lastSpoke:g','0');f.ledger.reserve('interjection','g','u');assert.equal(gate.decide([a,b],now),undefined);
    assert.equal(gate.decide([message('explicit')],now),'mention');
  }finally{f.cleanup();}
});
