import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bot } from '../src/agent/bot.js';
import { BudgetedModel,MockModel } from '../src/agent/model.js';
import { MockTransport } from '../src/qq/adapter.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';
import { SearchService,MockSearchProvider } from '../src/search/provider.js';
import { MockImageProvider } from '../src/image/provider.js';
import type { QQMedia } from '../src/qq/media.js';
import { fixture,message } from './helpers.js';

test('ordinary group traffic costs no model calls or image ingestion; @/keyword uses the current live settings',async()=>{
  const f=fixture({qqTransport:'onebot',bufferMs:10000,autoReply:true,autonomous:true}),provider=new MockModel(),transport=new MockTransport();let ingestions=0;
  const media={ingest:async()=>{ingestions++;return [];},context:()=>({})} as unknown as QQMedia;
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,undefined,undefined,media);
  const ordinary=(text:string,extra:any={})=>message(text,{mentioned:false,event:'ordinary',...extra});
  try{
    for(let i=0;i<12;i++)await bot.receive(ordinary('普通群消息 '+i,{images:[{url:'https://example.com/never-download.png',stickerHint:false}]}));
    await bot.flush();assert.equal(provider.calls,0);assert.equal(ingestions,0);assert.equal(f.ledger.value('tokens'),0);
    await bot.receive(ordinary('大肥鱼来聊两句'));await bot.flush();assert.equal(provider.calls,1);assert.equal(ingestions,1);
    // A keyword in history must not re-trigger a later ordinary message.
    await bot.receive(ordinary('继续普通聊天'));await bot.flush();assert.equal(provider.calls,1);
    await bot.receive(ordinary('dEePsEeK 在吗'));await bot.flush();assert.equal(provider.calls,2);
    f.set({names:[]});await bot.receive(ordinary('肥鱼 Deepseek'));await bot.flush();assert.equal(provider.calls,2);
    await bot.receive(message('[@你]'));await bot.flush();assert.equal(provider.calls,3);
    await bot.receive(message('肥鱼',{group:'blocked'}));await bot.flush();assert.equal(provider.calls,3);
    assert.equal(f.store.history('g',20).filter(m=>m.user==='DeepSeekFish').length,3);
  }finally{await bot.stop();f.cleanup();}
});

test('coalescing group messages never attributes one member’s activation to another member',async()=>{
  const f=fixture({qqTransport:'onebot',bufferMs:10000}),provider=new MockModel(),transport=new MockTransport();
  const recipients:string[]=[],send=transport.send.bind(transport);
  transport.send=async(m,text)=>{recipients.push(m.user);await send(m,text);};
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
  try{
    await bot.receive(message('肥鱼看看我的头像',{user:'member-a',mentioned:false,event:'ordinary'}));
    await bot.receive(message('我只是在路过',{user:'member-b',mentioned:false,event:'ordinary'}));
    await bot.receive(message('看看我的动态',{user:'member-c'}));await bot.flush();
    assert.equal(provider.calls,2);
    assert.deepEqual(recipients,['member-a','member-c']);
    assert.equal(f.ledger.value('requests','u:member-b'),0);
  }finally{await bot.stop();f.cleanup();}
});
