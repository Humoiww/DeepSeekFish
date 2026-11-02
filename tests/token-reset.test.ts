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

test('token reset clears today across QQ/Web scopes but retains historical usage, records, limits and other quotas',()=>{
 const f=fixture({dailyTokens:100000,groupDailyTokens:100000}),second=new Store(f.root);
 try{
  const model=f.ledger.reserve('model','private:owner','owner',1000,100);f.ledger.settle(model,{input:100,output:50});
  f.ledger.settleSearch(f.ledger.reserve('search','web:one','webui'),true);
  f.ledger.add('image',3);f.ledger.add('codex',4);f.ledger.add('codexMs',8000);
  const yesterday=dayKey(Date.now()-86400000);f.ledger.add('tokens',900,'*',yesterday);
  const reservations=f.store.db.prepare('SELECT * FROM reservations ORDER BY id').all(),input=f.ledger.value('input'),output=f.ledger.value('output');
  const result=f.ledger.resetTokens();assert.equal(result.clearedTokens,2650);assert.equal(result.clearedWebTokens,2500);assert.equal(result.retainedTokens,0);
  for(const scope of ['*','g:private:owner','g:web:one'])for(const metric of ['tokens','webTokens'])assert.equal(f.ledger.value(metric,scope),0);
  assert.equal(new Ledger(second,f.cfg).value('tokens'),0);assert.equal(f.ledger.value('tokens','*',yesterday),900);
  assert.equal(f.ledger.value('input'),input);assert.equal(f.ledger.value('output'),output);assert.equal(f.ledger.value('requests','u:owner'),1);
  assert.equal(f.ledger.value('image'),3);assert.equal(f.ledger.value('codex'),4);assert.equal(f.ledger.value('codexMs'),8000);assert.equal(f.cfg().dailyTokens,100000);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM reservations ORDER BY id').all(),reservations);
  const audit=f.store.db.prepare("SELECT detail FROM audit WHERE kind='local-token-reset'").get() as {detail:string};assert.equal(JSON.parse(audit.detail).clearedTokens,2650);
  assert.equal(f.ledger.resetTokens().clearedTokens,0);
 }finally{second.close();f.cleanup();}
});

test('reset during requests preserves held and unknown charges, later settlement/refund and repeated reset stay correct',()=>{
 const f=fixture({dailyTokens:100000,groupDailyTokens:100000});
 try{
  const done=f.ledger.reserve('model','g','u',100,100);f.ledger.settle(done,{input:50,output:10});
  const held=f.ledger.reserve('model','g','u',1000,100),unknown=f.ledger.reserve('model','g2','u',500,100);f.ledger.settle(unknown);
  const searchHeld=f.ledger.reserve('search','g','u'),searchUnknown=f.ledger.reserve('search','g2','u');f.ledger.settleSearch(searchUnknown,undefined);
  const result=f.ledger.resetTokens();assert.equal(result.clearedTokens,60);assert.equal(result.pendingTokens,3600);assert.equal(result.uncertainTokens,3100);assert.equal(result.retainedTokens,6700);
  assert.equal(f.ledger.value('tokens','g:g'),3600);assert.equal(f.ledger.value('tokens','g:g2'),3100);
  f.ledger.settle(held,{input:100,output:20});f.ledger.settleSearch(searchHeld,false);
  assert.equal(f.ledger.value('tokens'),3220);assert.equal(f.ledger.value('tokens','g:g'),120);assert.equal(f.ledger.value('webTokens'),2500);
  assert.equal(f.ledger.resetTokens().clearedTokens,120);assert.equal(f.ledger.value('tokens'),3100);assert.equal(f.ledger.resetTokens().clearedTokens,0);
  assert.equal(f.store.getMeta('budgetFault'),undefined);
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
  const req=request({hostname:'127.0.0.1',port,path:'/api/tokens/reset',method,headers:{host:publicHost,origin:'http://'+publicHost,'content-type':'application/json'}},res=>{
   let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(body)}));
  });req.on('error',reject);req.end(method==='POST'?JSON.stringify(data):undefined);
 });
 try{
  ledger.settle(ledger.reserve('model','private:owner','owner',500,100),{input:200,output:30});
  assert.equal((await call({},'GET')).status,403);assert.equal((await call({day:'yesterday'})).status,400);assert.equal(ledger.value('tokens'),230);
  owner=false;assert.equal((await call()).status,403);assert.equal(ledger.value('tokens'),230);owner=true;
  const reset=await call();assert.equal(reset.status,200);assert.equal(reset.body.tokenReset.clearedTokens,230);assert.equal(reset.body.budgets.usage.find((x:any)=>x.scope==='*'&&x.metric==='tokens').value,0);
  assert.equal(ledger.value('tokens','g:private:owner'),0);assert.ok(!JSON.stringify(reset.body).includes(app.token));
  const denied=await fetch('http://127.0.0.1:'+upstreamPort+'/api/tokens/reset',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,401);await denied.body?.cancel();
 }finally{
  gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);store.close();await app.close();f.cleanup();
 }
});
