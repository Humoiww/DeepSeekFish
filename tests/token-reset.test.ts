import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request} from 'node:http';
import {fixture} from './helpers.js';
import {dayKey,Ledger} from '../src/budget/ledger.js';
import {Store} from '../src/storage/db.js';
import {createWebApp} from '../src/web/app.js';
import {webServer} from '../src/web/server.js';
import {tailnetGateway} from '../src/web/tailnet.js';

test('cash reset preserves actual token totals, reservations, other quotas and history',()=>{
 const f=fixture({dailyCny:5}),second=new Store(f.root);try{
  const model=f.ledger.reserve('model','private:owner','owner',1000,100);f.ledger.settle(model,{input:100,output:50,cachedInput:80,uncachedInput:20});
  f.ledger.settleSearch(f.ledger.reserve('search','web:one','webui'),true);f.ledger.add('image',3);
  const yesterday=dayKey(Date.now()-86400000);f.ledger.add('costNano',900,'*',yesterday);
  const before=f.ledger.costSummary(),receipt=f.ledger.receipt(model),result=f.ledger.resetCosts();
  assert.equal(result.clearedCny,before.used);assert.equal(result.retainedCny,0);assert.equal(f.ledger.value('costNano'),0);
  assert.equal(new Ledger(second,f.cfg).value('costNano'),0);assert.equal(f.ledger.value('costNano','*',yesterday),900);
  assert.equal(f.ledger.value('tokens'),150);assert.equal(f.ledger.value('cachedInput'),80);assert.equal(f.ledger.value('requests','u:owner'),1);
  assert.equal(f.ledger.value('image'),3);assert.equal(f.cfg().dailyCny,5);assert.deepEqual(f.ledger.receipt(model),receipt);
  assert.equal(f.ledger.costSummary().reset,before.used);assert.equal(f.ledger.resetCosts().clearedCny,0);
 }finally{second.close();f.cleanup();}
});
test('cash reset retains held/unknown, later settlements and refunds stay correct',()=>{
 const f=fixture();try{
  const done=f.ledger.reserve('model','g','u',100,100);f.ledger.settle(done,{input:50,output:10});
  const held=f.ledger.reserve('model','g','u',1000,100),unknown=f.ledger.reserve('model','g2','u',500,100);f.ledger.settle(unknown);
  const searchHeld=f.ledger.reserve('search','g','u'),searchUnknown=f.ledger.reserve('search','g2','u');f.ledger.settleSearch(searchUnknown,undefined);
  const result=f.ledger.resetCosts();assert.equal(result.clearedCny,f.ledger.receipt(done)!.amountCny);assert.equal(result.pendingCny,0.0078);assert.equal(result.uncertainCny,0.0068);assert.equal(result.retainedCny,0.0146);
  f.ledger.settle(held,{input:100,output:20});f.ledger.settleSearch(searchHeld,false);
  assert.equal(f.ledger.costSummary().pending,0);assert.equal(f.ledger.resetCosts().clearedCny,f.ledger.receipt(held)!.amountCny);
  assert.equal(f.ledger.costSummary().used,0.0068);assert.equal(f.ledger.resetCosts().clearedCny,0);assert.equal(f.store.getMeta('budgetFault'),undefined);
 }finally{f.cleanup();}
});
test('phone owner can reset through the gateway and real WebUI endpoint; bad bodies and unauthorized requests cannot reset',async()=>{
 const f=fixture(),app=createWebApp(f.root,true),store=new Store(f.root,'webui-mock-budget.sqlite'),ledger=new Ledger(store,f.cfg);
 const upstreamPort=44000+Math.floor(Math.random()*10000),{server:upstream}=webServer(app,upstreamPort);
 upstream.listen(upstreamPort,'127.0.0.1');await once(upstream,'listening');
 const publicHost='100.123.219.112:17863';let owner=true;
 const gateway=tailnetGateway(publicHost,upstreamPort,{token:app.token,owner:async()=>owner});gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
 const port=(gateway.address() as import('node:net').AddressInfo).port;
 const call=(data:unknown={},method='POST')=>new Promise<{status:number;body:any}>((resolve,reject)=>{
  const req=request({hostname:'127.0.0.1',port,path:'/api/costs/reset',method,headers:{host:publicHost,origin:'http://'+publicHost,'content-type':'application/json'}},res=>{
   let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(body)}));
  });req.on('error',reject);req.end(method==='POST'?JSON.stringify(data):undefined);
 });
 try{
  ledger.settle(ledger.reserve('model','private:owner','owner',500,100),{input:200,output:30});
  assert.equal((await call({},'GET')).status,403);assert.equal((await call({day:'yesterday'})).status,400);assert.equal(ledger.value('tokens'),230);
  owner=false;assert.equal((await call()).status,403);assert.equal(ledger.value('tokens'),230);owner=true;
  const reset=await call();assert.equal(reset.status,200);assert.equal(reset.body.costReset.clearedCny>0,true);assert.equal(reset.body.budgets.cost.used,0);
  assert.equal(ledger.value('tokens','g:private:owner'),230);assert.ok(!JSON.stringify(reset.body).includes(app.token));
  const denied=await fetch('http://127.0.0.1:'+upstreamPort+'/api/costs/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,401);await denied.body?.cancel();
 }finally{
  gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);store.close();await app.close();f.cleanup();
 }
});
