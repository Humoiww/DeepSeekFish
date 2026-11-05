import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {SearchService,DeepSeekSearchProvider} from '../src/search/provider.js';
import {networkPricing} from '../src/budget/pricing.js';
import {Store} from '../src/storage/db.js';
import {Ledger} from '../src/budget/ledger.js';
import {validateConfig} from '../src/config.js';

test('web calls share CNY with model calls, no second daily count cap',()=>{
  const f=fixture({dailyCny:5,groupDailyCny:0});try{
    assert.equal(networkPricing('deepseek-flash').cnyPerRequest,0.005);assert.equal(networkPricing('deepseek-v4-pro').cnyPerRequest,0.005);
    assert.equal('searchDaily' in validateConfig({searchDaily:1}),false);assert.equal(validateConfig({dailyTokens:0,groupDailyTokens:1}).dailyCny,5);
    for(let i=0;i<21;i++)f.ledger.settleSearch(f.ledger.reserve('search','g','u'),true);
    assert.equal(f.ledger.costSummary().used,0.105);assert.equal(f.ledger.value('tokens'),0);
    const model=f.ledger.reserve('model','g','u',100,100);f.ledger.settle(model,{input:50,output:30});assert.equal(f.ledger.value('tokens'),80);
    f.set({dailyCny:f.ledger.costSummary().used+0.0049});assert.throws(()=>f.ledger.reserve('search','g','u'),/CNY_BUDGET/);
    const second=new Store(f.root);try{assert.equal(new Ledger(second,f.cfg).value('tokens'),80);}finally{second.close();}
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
    await assert.rejects(s.search('unknown','g','u'));assert.equal(f.ledger.costSummary().used,0.005);
    await s.search('ok','g','u');await s.search('ok','g','u');assert.equal(calls,4);assert.equal(f.ledger.costSummary().used,0.01);
    await s.search('filtered','g','u');assert.equal(f.ledger.costSummary().used,0.015);
    assert.equal(f.ledger.value('input'),0);assert.equal(f.ledger.value('tokens'),0);
  }finally{f.cleanup();}
});

test('default groups and WebUI share the daily cap; explicit group caps are visible and live',async()=>{
 const {createWebApp}=await import('../src/web/app.js'),{createApp}=await import('../src/app.js');
 const {conversationCostLimit,BudgetError}=await import('../src/budget/ledger.js');
 const f=fixture(),web=createWebApp(f.root,false),qq=createApp(f.root,true);
 const shared=new Store(f.root);
 try{
  assert.equal(conversationCostLimit(f.cfg(),'g'),5);
  f.ledger.add('tokens',70000,'g:g');f.ledger.add('tokens',70000);
  f.ledger.settle(f.ledger.reserve('model','g','u',1000,100),{input:100,output:10});
  web.configure({dailyCny:8,groupDailyCny:2.5});
  assert.equal(web.status().budgets.dailyCny,8);assert.equal(web.status().budgets.groupDailyCny,2.5);
  qq.store.setMeta('settings',shared.getMeta('settings')!);assert.equal(qq.cfg().dailyCny,8);assert.equal(qq.cfg().groupDailyCny,2.5);
  const saved=JSON.parse(shared.getMeta('settings')!);assert.equal(saved.dailyCny,8);assert.equal(saved.groupDailyCny,2.5);
  // Simulate the other process updating the shared meta, with WebUI already running.
  shared.setMeta('settings',JSON.stringify({...saved,dailyCny:9,groupDailyCny:0}));assert.equal(web.status().settings.dailyCny,9);
  assert.equal(web.status().settings.groupDailyCny,0);
  const reopened=createWebApp(f.root,false);try{assert.equal(reopened.status().budgets.cost.daily,9);assert.equal(reopened.status().settings.groupDailyCny,0);}finally{await reopened.close();}
  for(const dailyCny of [-1,NaN,Infinity,'5',1e20])assert.throws(()=>web.configure({dailyCny}),/INVALID_WEB_SETTINGS/);
  assert.match(new BudgetError('cost',0.006,0.01,'conversation').notice,/本群/);
 }finally{await qq.bot.stop();qq.store.close();shared.close();await web.close();f.cleanup();}
});
