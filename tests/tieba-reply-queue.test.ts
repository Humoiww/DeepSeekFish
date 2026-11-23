import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fixture} from './helpers.js';
import {TiebaOperationQueue} from '../src/tieba/queue.js';
import {TiebaAccountClient} from '../src/tieba/client.js';
import {TiebaPosting} from '../src/tieba/posting.js';
import {webServer} from '../src/web/server.js';
import type {WebApp} from '../src/web/app.js';

test('Tieba reply queue assembles one item per reply and retains selected details across pages',()=>{
 const f=fixture(),dir=path.join(f.root,'runtime','tieba');
 const queue=new TiebaOperationQueue(dir,{describe:()=>({}),async cancel(){},restart(){}});
 const db=new DatabaseSync(path.join(dir,'actions.sqlite'));
 try{
  db.exec('CREATE TABLE tieba_actions(id TEXT PRIMARY KEY,request TEXT,result TEXT,state TEXT,created INTEGER)');
  const persist=db.prepare('INSERT INTO tieba_actions VALUES (?,?,?,?,?)');
  const operation=db.prepare('INSERT INTO tieba_operations(id,action,state,created,finished,metadata,result) VALUES (?,?,?,?,?,?,?)');
  const request={action:'reply',threadId:'18420',forumId:'5',content:'第一句真回帖'};
  persist.run('first',JSON.stringify(request),JSON.stringify({requestId:'first',id:'601020',publicVerified:true,
    visibility:'public',verifiedAt:56,checks:{public:{status:'content'}}}),'confirmed',10);
  operation.run('post-first','publish','done',10,12,JSON.stringify({...request,requestId:'first'}),'{}');
  operation.run('verify-first','verify','done',50,56,'{"requestId":"first"}','{}');
  operation.run('read-thread','read','done',57,58,'{}','{}');
  operation.run('screen-shot','frame','done',58,59,'{"requestId":"first"}','{}');
  operation.run('failed-before-ledger','publish','done',20,30,JSON.stringify({...request,requestId:'failed',content:'没有提交的一条'}),'{"outcome":"failed","error":"TIEBA_LOGIN_REQUIRED"}');
  operation.run('not-a-reply','publish','done',56,60,'{"requestId":"thread","action":"thread"}','{}');
  operation.run('still-running','publish','running',57,null,JSON.stringify({...request,requestId:'running'}),null);
  for(let i=0;i<21;i++)operation.run('later-'+i,'publish','done',60+i,90+i,JSON.stringify({...request,requestId:'later-'+i}),'{}');

  const firstPage=queue.snapshot(0,false,true,'first');
  assert.ok('selected' in firstPage);
  assert.equal(firstPage.counts.completed,23);
  assert.equal(firstPage.completed.length,20);
  assert.equal(firstPage.hasMore,true);
  assert.deepEqual(firstPage.active.map(item=>item.id),['running']);
  assert.equal(firstPage.selected?.id,'first');
  assert.equal(firstPage.selected?.metadata.content,request.content);
  assert.equal(firstPage.selected?.result?.visibility,'public');
  assert.equal(firstPage.selected?.result?.checks.public.status,'content');
  assert.deepEqual(firstPage.selected?.steps.map(step=>step.action),['publish','verify']);

  const secondPage=queue.snapshot(20,false,true,'failed');
  assert.ok('selected' in secondPage);
  assert.equal(secondPage.hasMore,false);
  assert.equal(secondPage.completed.filter(item=>item.id==='first').length,1);
  assert.equal(secondPage.selected?.result?.error,'TIEBA_LOGIN_REQUIRED');
  assert.equal(secondPage.selected?.canVerify,false);
  assert.equal(queue.snapshot().completed[0].action,'publish');
 }finally{db.close();queue.close();f.cleanup();}
});

test('the existing WebUI route verifies only the selected reply and preserves the account action',async()=>{
 const f=fixture();
 const calls:{action:string;input:unknown}[]=[];
 const tieba=new TiebaAccountClient(async(action,input)=>{
  calls.push({action,input});
  if(action==='verify')return {requestId:(input as {requestId:string}).requestId,publicVerified:true};
  if(action==='queue')return {view:'replies'};
  return {state:'logged_in'};
 });
 const findPort=createServer();
 findPort.listen(0,'127.0.0.1');await once(findPort,'listening');
 const port=(findPort.address() as import('node:net').AddressInfo).port;
 await new Promise<void>(resolve=>findPort.close(()=>resolve()));
 const app={root:f.root,token:'fixture',tieba,tiebaAudit(){}} as unknown as WebApp;
 const {server}=webServer(app,port);
 server.listen(port,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+port;
 const headers={authorization:'Bearer fixture','content-type':'application/json'};
 const post=(value:unknown)=>fetch(base+'/api/tieba/publication-check',{method:'POST',headers,body:JSON.stringify(value)});
 try{
  assert.equal((await fetch(base+'/api/tieba/queue?replies=1&offset=20&selectedId=older',{headers})).status,200);
  assert.deepEqual(await (await post({requestId:'selected'})).json(),{requestId:'selected',publicVerified:true});
  assert.equal((await post({requestId:'selected',submit:true})).status,400);
  assert.equal((await post({})).status,200);
  assert.deepEqual(calls,[
   {action:'queue',input:{offset:20,replies:true,selectedId:'older'}},
   {action:'verify',input:{requestId:'selected'}},
   {action:'publication-check',input:undefined},
  ]);
 }finally{
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.cleanup();
 }
});

test('reply verification requires a matching body and author from the public reader',async()=>{
 const f=fixture(),dir=path.join(f.root,'runtime','tieba');
 const queue=new TiebaOperationQueue(dir,{describe:()=>({}),async cancel(){},restart(){}});
 const posting=new TiebaPosting(dir),db=new DatabaseSync(path.join(dir,'actions.sqlite'));
 const now=Date.now(),who={id:'55',name:'fixture'},request={action:'reply',threadId:'1885',forumId:'5',content:'回帖正文'};
 try{
  db.prepare('INSERT INTO tieba_actions VALUES (?,?,?,?,?,?,?)').run('reply',who.id,'fixture','accepted',JSON.stringify(request),
   JSON.stringify({submitted:true,id:'7614',receipt:{accepted:true}}),now-3000);
  const hits:string[]=[];
  const result=await posting.verify('reply',who,{
   async followed(){return [];},
   async read(){throw new Error('the public match already provides evidence');},
   async publicRead(url){
    hits.push(url);
    return {status:'content',forum:{id:request.forumId},posts:[
     {id:'7614',author:{id:who.id},publishedAt:new Date(now-1000).toISOString(),content:request.content},
    ]};
   },
  });
  assert.deepEqual(hits,['https://tieba.baidu.com/p/1885?pid=7614']);
  assert.equal(result.publicVerified,true);
  assert.equal(result.visibility,'public');
  assert.equal(result.observed.id,'7614');
 }finally{db.close();posting.close();queue.close();f.cleanup();}
});
