import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {SearchService,DeepSeekSearchProvider} from '../src/search/provider.js';
import {networkPricing} from '../src/budget/pricing.js';
import {Store} from '../src/storage/db.js';
import {Ledger} from '../src/budget/ledger.js';
import {validateConfig} from '../src/config.js';

test('web calls share price-converted tokens with model calls, no second daily count cap',()=>{
  const f=fixture({dailyTokens:1000000,groupDailyTokens:1000000});try{
    assert.equal(networkPricing('deepseek-flash').tokensPerRequest,2500);assert.equal(networkPricing('deepseek-v4-pro').tokensPerRequest,569);
    assert.equal('searchDaily' in validateConfig({searchDaily:1}),false);
    for(let i=0;i<21;i++)f.ledger.settleSearch(f.ledger.reserve('search','g','u'),true);
    assert.equal(f.ledger.value('tokens'),52500);assert.equal(f.ledger.value('webTokens'),52500);
    const model=f.ledger.reserve('model','g','u',100,100);f.ledger.settle(model,{input:50,output:30});assert.equal(f.ledger.value('tokens'),52580);
    f.set({dailyTokens:55079});assert.throws(()=>f.ledger.reserve('search','g','u'),/TOKEN_BUDGET/);
    const second=new Store(f.root);try{assert.equal(new Ledger(second,f.cfg).value('tokens'),52580);}finally{second.close();}
  }finally{f.cleanup();}
});
test('known empty/failed calls refund, ambiguous errors stay charged, cache does not pay again',async()=>{
  const f=fixture({search:true});let calls=0;
  const http=(async(_url:any,options:any)=>{
    calls++;const q=JSON.parse(options.body).query;
    if(q==='fail')return new Response('{}',{status:503});if(q==='unknown')throw Error('connection lost');
    return new Response(JSON.stringify({results:q==='empty'?[]:[{url:q==='filtered'?'http://127.0.0.1':'https://example.com',title:'found'}]}));
  }) as typeof fetch;
  const s=new SearchService(new DeepSeekSearchProvider('test',f.cfg,http),f.ledger,f.cfg);
  try{
    await s.search('empty','g','u');assert.equal(f.ledger.value('tokens'),0);
    await assert.rejects(s.search('fail','g','u'));assert.equal(f.ledger.value('tokens'),0);
    await assert.rejects(s.search('unknown','g','u'));assert.equal(f.ledger.value('tokens'),2500);
    await s.search('ok','g','u');await s.search('ok','g','u');assert.equal(calls,4);assert.equal(f.ledger.value('tokens'),5000);
    await s.search('filtered','g','u');assert.equal(f.ledger.value('tokens'),7500);
    assert.equal(f.ledger.value('input'),0);assert.equal(f.ledger.value('webTokens'),7500);
  }finally{f.cleanup();}
});

test('default groups and WebUI share the daily cap; explicit group caps are visible and live',async()=>{
 const {createWebApp}=await import('../src/web/app.js'),{createApp}=await import('../src/app.js');
 const {conversationTokenLimit,TokenBudgetError}=await import('../src/budget/ledger.js');
 const f=fixture(),web=createWebApp(f.root,false),qq=createApp(f.root,true);
 const shared=new Store(f.root);
 try{
  assert.equal(conversationTokenLimit(f.cfg(),'g'),1000000);
  f.ledger.add('tokens',70000,'g:g');f.ledger.add('tokens',70000);
  f.ledger.settle(f.ledger.reserve('model','g','u',1000,100),{input:100,output:10});
  web.configure({dailyTokens:800000,groupDailyTokens:250000});
  assert.equal(web.status().budgets.dailyTokens,800000);assert.equal(web.status().budgets.groupDailyTokens,250000);
  qq.store.setMeta('settings',shared.getMeta('settings')!);assert.equal(qq.cfg().dailyTokens,800000);assert.equal(qq.cfg().groupDailyTokens,250000);
  const saved=JSON.parse(shared.getMeta('settings')!);assert.equal(saved.dailyTokens,800000);assert.equal(saved.groupDailyTokens,250000);
  // Simulate the other process updating the shared meta, with WebUI already running.
  shared.setMeta('settings',JSON.stringify({...saved,dailyTokens:900000,groupDailyTokens:0}));assert.equal(web.status().settings.dailyTokens,900000);
  assert.equal(web.status().settings.groupDailyTokens,0);
  assert.match(new TokenBudgetError('tokens',6000,10000,'conversation').notice,/本群/);
 }finally{await qq.bot.stop();qq.store.close();shared.close();await web.close();f.cleanup();}
});
