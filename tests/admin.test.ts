import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../src/app.js';
import { adminServer } from '../src/admin/server.js';
import { fixture } from './helpers.js';
test('localhost admin rejects unauthenticated, CSRF and Host spoof; settings/history/queue work',async()=>{
  const f=fixture();f.store.close();
  const port=20000+Math.floor(Math.random()*20000),app=createApp(f.root,true,{port,codex:true});
  const server=adminServer(app,()=>{});
  try{
    server.listen(port,'127.0.0.1');await once(server,'listening');
    const base=`http://127.0.0.1:${port}`,headers={authorization:'Bearer '+app.token,'content-type':'application/json'};
    assert.equal((await fetch(base+'/api/status')).status,401);
    assert.equal((await fetch(base+'/api/status',{headers:{...headers,origin:'https://evil.example'}})).status,403);
    const spoofed=await new Promise<number>((resolve,reject)=>{
      const req=request(base+'/api/status',{headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();
    });
    assert.equal(spoofed,403);
    const get=await fetch(base+'/api/status',{headers});assert.equal(get.status,200);const status:any=await get.json();assert.equal(status.codex.unattended,false);assert.equal(status.mode,'mock');
    const post=async(route:string,b:unknown,extra={})=>fetch(base+'/api/'+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(b)});
    assert.equal((await post('set',{key:'autonomous',value:true})).status,200);assert.equal(app.cfg().autonomous,true);
    assert.equal((await post('set',{key:'admins',value:['attacker']})).status,400);
    assert.equal((await post('mock-message',{text:'/fish codex create'})).status,200);
    const task=app.tasks.list()[0];assert.equal(task.state,'waiting');
    assert.equal((await post('approve',{id:task.id,reviewed:true})).status,400);
    assert.equal((await post('approve',{id:task.id,reviewed:true},{'x-fish-local-approval':task.id})).status,200);
    await app.tasks.idle();assert.equal(app.tasks.get(task.id).state,'succeeded');
    await post('clear',{group:'demo-group'});assert.equal(app.store.history('demo-group',20).length,0);
    assert.equal((await post('set',{key:'enabled',value:false})).status,200);
  }finally{await app.bot.stop();server.close();await once(server,'close');app.store.close();const fs=await import('node:fs');fs.rmSync(f.root,{recursive:true,force:true});}
});
