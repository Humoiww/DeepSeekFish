import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { Store } from '../src/storage/db.js';
import { Ledger, dayKey } from '../src/budget/ledger.js';
import { MockModel, BudgetedModel } from '../src/agent/model.js';
import { qqResources } from '../src/qq/resources.js';
test('QQ private shares global CNY while per-group cash caps and denial diagnostics are explicit',async()=>{
 const f=fixture({dailyCny:0.08,groupDailyCny:0.03,maxOutputTokens:256});try{
  const group='private:20002';for(const scope of ['*','g:'+group])f.ledger.add('costNano',30000000,scope);
  const lease=f.ledger.reserve('model',group,'20002',8000,256);f.ledger.settle(lease,{input:500,output:50,cachedInput:400,uncachedInput:100});
  const resources=qqResources(f.cfg(),f.ledger,group,'20002');assert.equal(resources.energy.daily,0.08);assert.equal(resources.energy.conversationDaily,0.08);assert.ok(resources.energy.conversationRemaining>0.049);
  f.ledger.add('costNano',29000000,'g:g');assert.throws(()=>f.ledger.reserve('model','g','20002',1001,0),/CNY_BUDGET_EXHAUSTED/);
  f.set({dailyCny:0});const provider=new MockModel(),model=new BudgetedModel(provider,f.ledger,f.cfg);
  await assert.rejects(model.call(group,'20002',[{role:'user',content:'hello'}]),/CNY_BUDGET_EXHAUSTED/);assert.equal(provider.calls,0);
  const denial=JSON.parse((f.store.db.prepare("SELECT detail FROM audit WHERE kind='budget-denied' ORDER BY id DESC LIMIT 1").get() as any).detail);
  assert.equal(denial.reason,'cost');assert.equal(denial.scope,'daily');assert.ok(denial.requiredCny>0);
 }finally{f.cleanup();}
});
test('cash/request limits precheck provider, actual usage settles and survives reopen',async()=>{
 const f=fixture({dailyCny:1,groupDailyCny:0.5,userDailyRequests:1});try{
  const provider=new MockModel(),model=new BudgetedModel(provider,f.ledger,f.cfg);
  const result=await model.complete('g','admin',[{role:'user',content:'hello'}]);
  await assert.rejects(model.call('g','admin',[{role:'user',content:'{}'}]),/DAILY_REQUEST_LIMIT/);
  assert.equal(provider.calls,1);assert.ok(result.billing!.amountCny>0);
  const second=new Store(f.root);try{const ledger=new Ledger(second,f.cfg);assert.deepEqual(ledger.receipt(result.billing!.reservationId),result.billing);assert.equal(ledger.value('tokens'),f.ledger.value('input')+f.ledger.value('output'));}finally{second.close();}
  f.set({dailyCny:0});await assert.rejects(model.call('g','new',[{role:'user',content:'{}'}]),/CNY_BUDGET/);assert.equal(provider.calls,1);
 }finally{f.cleanup();}
});
test('four processes cannot overbook the cash allowance, including off-peak reservation',async()=>{
 const f=fixture({dailyCny:0.001,groupDailyCny:0,userDailyRequests:100});
 const workers=Array.from({length:4},()=>new Worker(new URL('./budget-worker.js',import.meta.url),{workerData:{root:f.root,config:f.cfg()}}));
 try{
  await Promise.all(workers.map(w=>once(w,'message')));const results=workers.map(w=>once(w,'message'));workers.forEach(w=>w.postMessage('go'));
  assert.equal((await Promise.all(results)).reduce((sum,[n])=>sum+Number(n),0),10);assert.equal(f.ledger.costSummary().used,0.001);assert.equal(f.ledger.value('tokens'),200);
 }finally{await Promise.all(workers.map(w=>w.terminate()));f.cleanup();}
});
test('errors retain held tokens; usage anomaly locks further calls; settlement is idempotent',()=>{
  const f=fixture();try{
    const r=f.ledger.reserve('model','g','u',100,20);f.ledger.settle(r);assert.equal(f.ledger.value('tokens'),120);
    const s=f.ledger.reserve('model','g','v',100,20);f.ledger.settle(s,{input:50,output:10});f.ledger.settle(s,{input:0,output:0});assert.equal(f.ledger.value('tokens'),180);
    const a=f.ledger.reserve('model','g','z',10,10);f.ledger.settle(a,{input:30,output:2});
    assert.throws(()=>f.ledger.reserve('model','g','a',1,1),/BUDGET_USAGE_FAULT/);
    assert.equal(dayKey(Date.parse('2026-10-27T15:59:59Z')),'2026-10-27');assert.equal(dayKey(Date.parse('2026-10-27T16:00:00Z')),'2026-10-28');
  }finally{f.cleanup();}
});
test('image/task limits, global concurrency, time reservations persist',()=>{
  const f=fixture({imageDaily:1,codexDaily:2,codexDailyMs:1000});try{
    f.ledger.reserve('image','g','u');assert.throws(()=>f.ledger.reserve('image','g','u'),/IMAGE_BUDGET/);
    const id=f.ledger.reserve('codex','g','u',0,0,600);assert.throws(()=>f.ledger.reserve('codex','g','u',0,0,200),/CODEX_BUSY/);
    f.ledger.settle(id,undefined,200);assert.equal(f.ledger.value('codexMs'),200);
    assert.throws(()=>f.ledger.reserve('codex','g','u',0,0,801),/CODEX_TIME_BUDGET/);
    f.ledger.reserve('codex','g','u',0,0,800);assert.throws(()=>f.ledger.reserve('codex','g','u'),/CODEX_BUDGET/);
  }finally{f.cleanup();}
});
