import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { fixture } from './helpers.js';
import { createWebApp } from '../src/web/app.js';
import { webServer } from '../src/web/server.js';
import { SessionWorkspace } from '../src/web/workspace.js';
import type { WireMessage } from '../src/web/model.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';

const reply=(message:any,usage={prompt_tokens:20,completion_tokens:10})=>new Response(JSON.stringify({choices:[{message}],usage}));
const call=(id:string,name:string,args:unknown)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
function web(mock=true,http?:typeof fetch){const f=fixture();const app=createWebApp(f.root,mock,http);return {f,app,async close(){await app.close();f.cleanup();}};}

test('WebUI mock is independent from QQ; sessions and generated files remain isolated',async()=>{
  const w=web();try{
    const a=w.app.createSession(),b=w.app.createSession(),events:any[]=[];
    await w.app.chat(a.id,'创建 hello.md','agent',new AbortController().signal,e=>events.push(e));
    assert.equal(w.app.detail(a.id).turns[0].state,'completed');assert.equal(w.app.detail(a.id).files[0].name,'hello.md');
    assert.deepEqual(w.app.detail(b.id).files,[]);assert.deepEqual(w.app.detail(b.id).turns,[]);
    assert.ok(events.some(e=>e.type==='tool'&&e.event.name==='write_file'));
    assert.ok(events.some(e=>e.type==='answer'&&e.text.includes('离线演示')));
  }finally{await w.close();}
});
test('workspace rejects cross-session paths, hidden files, executable tricks, links and size/quantity overflow',async()=>{
  const w=web();try{
    const a=w.app.createSession(),workspace=w.app.workspace(a.id);
    for(const p of ['../secret.txt','/etc/passwd','C:/private.txt','.env','dir/.codex/auth.json','auth.json','file.exe','NUL.txt','a\\b.txt'])assert.throws(()=>workspace.write(p,'bad'));
    workspace.write('hello.md','hello');assert.equal(workspace.read('hello.md'),'hello');
    const linked=path.join(workspace.cwd,'link.txt');fs.symlinkSync(path.join(workspace.cwd,'hello.md'),linked);
    assert.throws(()=>workspace.read('link.txt'),/PATH_LINK/);fs.rmSync(linked);
    fs.linkSync(path.join(workspace.cwd,'hello.md'),linked);assert.throws(()=>workspace.write('link.txt','bad'),/FILE_REJECTED/);fs.rmSync(linked);
    assert.throws(()=>workspace.write('big.txt','x'.repeat(65537)),/TOO_LARGE/);
    for(let i=0;i<19;i++)workspace.write(i+'.txt','x');assert.throws(()=>workspace.write('21.txt','x'),/QUOTA/);
  }finally{await w.close();}
});
test('DeepSeek sends real tool wire format, settles each request, and never exposes credentials',async()=>{
  let calls=0;const payloads:any[]=[];
  const http=(async(url:any,opts:any)=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(opts.redirect,'error');assert.equal(opts.headers.authorization,'Bearer fixture-key');
    const p=JSON.parse(opts.body);payloads.push(p);assert.equal(p.thinking.type,'disabled');
    return calls===1?reply({content:'',tool_calls:[call('c1','write_file',{path:'plan.md',content:'a useful plan'})]}):reply({content:'文件已保存。'});
  }) as typeof fetch;
  const w=web(false,http);try{
    w.app.configure({apiKey:'fixture-key'});const s=w.app.createSession();await w.app.chat(s.id,'create plan','agent',new AbortController().signal,()=>{});
    assert.equal(calls,2);assert.equal(w.app.workspace(s.id).read('plan.md'),'a useful plan');
    assert.equal(payloads[1].messages.at(-1).role,'tool');assert.equal(payloads[1].messages.at(-1).tool_call_id,'c1');
    assert.equal((w.app.status().budgets.usage as any[]).find(x=>x.metric==='tokens'&&x.scope==='*')?.value,60);
    assert.ok(!JSON.stringify(w.app.status()).includes('fixture-key'));
    assert.ok(fs.statSync(path.join(w.f.root,'runtime/data/webui-secrets.json')).mode&0o600);
  }finally{await w.close();}
});
test('plain chat never executes tool calls; agent tool allowlist denies shell, private paths and disabled search',async()=>{
  const requests:any[]=[];let count=0;
  const http=(async(_u:any,opts:any)=>{const p=JSON.parse(opts.body);requests.push(p);count++;
    if(p.messages.at(-1).role==='tool')return reply({content:'操作被限制。'});
    return reply({content:'',tool_calls:[call('a'+count,'write_file',{path:'../secret.txt',content:'bad'}),call('b'+count,'shell',{command:'whoami'}),call('c'+count,'search_web',{query:'test'})]});
  }) as typeof fetch;
  const w=web(false,http);try{
    w.app.configure({apiKey:'fixture-key'});const a=w.app.createSession();
    await w.app.chat(a.id,'try tools','chat',new AbortController().signal,()=>{});
    assert.equal(requests[0].tools,undefined);assert.equal(w.app.detail(a.id).turns[0].answer,'TOOL_LIMIT_OR_DISABLED');
    const b=w.app.createSession();await w.app.chat(b.id,'try tools','agent',new AbortController().signal,()=>{});
    const t=w.app.detail(b.id).turns[0];assert.equal(t.state,'completed');assert.equal(t.trace.length,3);assert.ok(t.trace.every((e:any)=>e.state==='failed'));
    assert.deepEqual(w.app.workspace(b.id).list(),[]);assert.ok(!fs.existsSync(path.join(w.f.root,'runtime/workspace/secret.txt')));
  }finally{await w.close();}
});
test('tool loops and concurrency are bounded; cancellation stops upstream and releases session lock',async()=>{
  let calls=0;const http=(async(_u:any,opts:any)=>{calls++;return reply({content:'',tool_calls:[call('c'+calls,'list_files',{})]});}) as typeof fetch;
  const w=web(false,http);try{
    w.app.configure({apiKey:'fixture-key'});const a=w.app.createSession();await w.app.chat(a.id,'loop','agent',new AbortController().signal,()=>{});
    assert.equal(calls,4);assert.equal(w.app.detail(a.id).turns[0].answer,'TOOL_LIMIT_OR_DISABLED');
  }finally{await w.close();}
  const hanging=(async(_u:any,opts:any)=>new Promise((_resolve,reject)=>{opts.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})) as typeof fetch;
  const h=web(false,hanging);try{
    h.app.configure({apiKey:'fixture-key'});const a=h.app.createSession(),abort=new AbortController();
    const pending=h.app.chat(a.id,'wait','chat',abort.signal,()=>{});
    await assert.rejects(h.app.chat(a.id,'concurrent','chat',abort.signal,()=>{}),/CHAT_BUSY/);
    abort.abort();await pending;assert.equal(h.app.detail(a.id).busy,false);assert.equal(h.app.detail(a.id).turns[0].answer,'CHAT_CANCELLED');
  }finally{await h.close();}
});
test('WebUI budget is checked before HTTP, no-key requests cost nothing, and QQ recovery preserves active web leases',async()=>{
  let calls=0;const http=(async()=>{calls++;return reply({content:'hello'});}) as typeof fetch;
  const w=web(false,http);try{
    const s=w.app.createSession();await assert.rejects(w.app.chat(s.id,'hello','chat',new AbortController().signal,()=>{}),/KEY_MISSING/);assert.equal(calls,0);
    w.app.configure({apiKey:'fixture-key',dailyTokens:1000});await w.app.chat(s.id,'hello','chat',new AbortController().signal,()=>{});assert.equal(calls,0);assert.equal(w.app.detail(s.id).turns[0].answer,'TOKEN_BUDGET_EXHAUSTED');
    const lease=w.f.ledger.reserve('codex','web:'+s.id,'webui-local');
    new Tasks(w.f.root,w.f.store,w.f.ledger,w.f.cfg,new MockTaskRunner()).recover();
    const row:any=w.f.store.db.prepare('SELECT state FROM reservations WHERE id=?').get(lease);assert.equal(row.state,'held');
  }finally{await w.close();}
});
test('Codex delegation only queues; mock execution still requires a separate local approval',async()=>{
  const w=web();try{
    w.app.configure({codexQueue:true});const s=w.app.createSession();await w.app.chat(s.id,'请交给 Codex 创建文件','agent',new AbortController().signal,()=>{});
    const t=w.app.tasks.list()[0];assert.equal(t.state,'waiting');assert.equal(w.app.detail(s.id).files.length,0);
    w.app.tasks.approve(t.id);await w.app.tasks.idle();assert.equal(w.app.tasks.get(t.id).state,'succeeded');
  }finally{await w.close();}
});
test('HTTP WebUI guards bootstrap replay, token, Origin/Host, downloads and local approval headers',async()=>{
  const w=web();
  // Static assets are shipped in the real checkout; fixtures only exercise API paths.
  let stopped=false;
  const port=22000+Math.floor(Math.random()*20000),{server,launchUrl}=webServer(w.app,port,()=>{stopped=true;});
  try{
    server.listen(port,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+port;
    const headers={authorization:'Bearer '+w.app.token,'content-type':'application/json'};
    const post=(route:string,value:unknown,extra={})=>fetch(base+'/api/'+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
    const code=new URLSearchParams(new URL(launchUrl).hash.slice(1)).get('bootstrap');
    assert.equal((await post('bootstrap',{code},{origin:'https://evil.example'})).status,403);
    assert.equal((await post('bootstrap',{code})).status,200);assert.equal((await post('bootstrap',{code})).status,401);
    assert.equal((await fetch(base+'/api/open',{method:'POST'})).status,401);
    const fresh:any=await (await post('open',{})).json();
    const newCode=new URLSearchParams(new URL(fresh.launchUrl).hash.slice(1)).get('bootstrap');
    assert.notEqual(newCode,code);assert.equal((await post('bootstrap',{code:newCode})).status,200);
    assert.equal((await fetch(base+'/api/status')).status,401);
    const spoofed=await new Promise<number>((resolve,reject)=>{const req=request(base+'/api/status',{headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode!);});req.on('error',reject);req.end();});assert.equal(spoofed,403);
    const s:any=await (await post('sessions',{})).json();w.app.workspace(s.id).write('note.html','<script>alert(1)</script>');
    const file=await fetch(base+'/api/file?id='+s.id+'&path=note.html',{headers});assert.equal(file.status,200);assert.match(file.headers.get('content-disposition')??'',/attachment/);assert.match(file.headers.get('content-security-policy')??'',/sandbox/);
    assert.equal((await fetch(base+'/api/file?id='+s.id+'&path=..%2Fsecret.txt',{headers})).status,400);
    assert.equal((await post('approve',{id:'unknown',reviewed:true})).status,400);
    const r=await post('chat',{sessionId:s.id,text:'hello',mode:'chat'});const lines=(await r.text()).trim().split('\n').map(l=>JSON.parse(l));assert.ok(lines.some(e=>e.type==='done'));
    assert.equal((await post('settings',{endpoint:'http://localhost'})).status,400);
    assert.deepEqual(await (await post('stop',{})).json(),{ok:true});
    await new Promise(resolve=>setTimeout(resolve,150));assert.equal(stopped,true);
  }finally{await w.app.close();server.close();await once(server,'close');w.f.cleanup();}
});
