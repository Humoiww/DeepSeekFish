import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { Store } from '../src/storage/db.js';
import { Ledger, dayKey } from '../src/budget/ledger.js';
import { MockModel, BudgetedModel } from '../src/agent/model.js';
test('global/group/user budget checked BEFORE provider; actual usage settles and survives reopen',async()=>{
  const f=fixture({dailyTokens:20000,groupDailyTokens:15000,userDailyRequests:1});
  try{
    const provider=new MockModel(),model=new BudgetedModel(provider,f.ledger,f.cfg);
    await model.call('g','admin',[{role:'user',content:JSON.stringify({messages:[{text:'hello'}]})}]);
    await assert.rejects(model.call('g','admin',[{role:'user',content:'{}'}]),/TOKEN_BUDGET/);
    assert.equal(provider.calls,1);assert.ok(f.ledger.value('input')>0);
    const second=new Store(f.root),ledger=new Ledger(second,f.cfg);
    assert.equal(ledger.value('tokens'),f.ledger.value('input')+f.ledger.value('output'));second.close();
    f.set({dailyTokens:1});await assert.rejects(model.call('g','new',[{role:'user',content:'{}'}]),/TOKEN_BUDGET/);assert.equal(provider.calls,1);
  }finally{f.cleanup();}
});
test('separate worker connections cannot overbook atomic reservations',async()=>{
  const f=fixture({dailyTokens:200,groupDailyTokens:200,userDailyRequests:100});
  const workers=Array.from({length:4},()=>new Worker(new URL('./budget-worker.js',import.meta.url),{workerData:{root:f.root,config:f.cfg()}}));
  try{
    await Promise.all(workers.map(w=>once(w,'message')));
    const results=workers.map(w=>once(w,'message'));workers.forEach(w=>w.postMessage('go'));
    const accepted=(await Promise.all(results)).reduce((sum,[n])=>sum+Number(n),0);
    assert.equal(accepted,10);assert.equal(f.ledger.value('tokens'),200);
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
test('search/image/task limits, global concurrency, time reservations persist',()=>{
  const f=fixture({searchDaily:1,imageDaily:1,codexDaily:2,codexDailyMs:1000});try{
    f.ledger.reserve('search','g','u');assert.throws(()=>f.ledger.reserve('search','g2','v'),/SEARCH_BUDGET/);
    f.ledger.reserve('image','g','u');assert.throws(()=>f.ledger.reserve('image','g','u'),/IMAGE_BUDGET/);
    const id=f.ledger.reserve('codex','g','u',0,0,600);assert.throws(()=>f.ledger.reserve('codex','g','u',0,0,200),/CODEX_BUSY/);
    f.ledger.settle(id,undefined,200);assert.equal(f.ledger.value('codexMs'),200);
    assert.throws(()=>f.ledger.reserve('codex','g','u',0,0,801),/CODEX_TIME_BUDGET/);
    f.ledger.reserve('codex','g','u',0,0,800);assert.throws(()=>f.ledger.reserve('codex','g','u'),/CODEX_BUDGET/);
  }finally{f.cleanup();}
});
