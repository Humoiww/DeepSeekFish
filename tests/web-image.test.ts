import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fixture } from './helpers.js';
import { makeDir } from '../src/paths.js';
import { CHARACTER_REFERENCE,BUNDLED_CHARACTER_REFERENCE } from '../src/character.js';
import { createWebApp } from '../src/web/app.js';
import { webServer } from '../src/web/server.js';
import { requestsImage,validateImagePlan } from '../src/web/images.js';
import { MockImageProvider } from '../src/image/provider.js';
import { mockQuota } from '../src/codex/quota.js';
import type { ImageRunner } from '../src/image/codex-smoke.js';
import { CodexDiagnostics } from '../src/codex/diagnostics.js';

const plan={subject:'蓝发少女',scene:'窗边喝茶',style:'水彩插画',composition:'方形，主体居中',lighting:'晨光',palette:'蓝白色',details:'无文字'};
const call=(args:unknown=plan,name='generate_image')=>({id:'plan-1',type:'function',function:{name,arguments:JSON.stringify(args)}});
const reply=(calls:any[])=>new Response(JSON.stringify({choices:[{message:{content:'',tool_calls:calls}}],usage:{prompt_tokens:20,completion_tokens:10}}));
async function png(root:string){const dir=makeDir(root,'runtime/fixtures');await new MockImageProvider().generate('fixture',dir);return fs.readFileSync(path.join(dir,'mock.png'));}
function web(mock=true,http?:typeof fetch,runner?:ImageRunner){const f=fixture();const app=createWebApp(f.root,mock,http,runner,{async read(){return mockQuota();},async close(){}});if(!mock){app.configure({apiKey:'fixture-key'});fs.writeFileSync(path.join(f.root,'runtime/codex-home/auth.json'),'{}');}return {f,app,async close(){await app.close();f.cleanup();}};}
const signal=()=>new AbortController().signal;

test('image intent comes from explicit current requests; questions, code and negative requests remain chat',()=>{
  for(const text of ['画一张你自己的图，场景你来设计','帮我生成一张猫猫图','来张图','给个自拍','给我个自拍','在你的小房间，给个自拍','给我一张图','我要一张图','generate an image of a cat'])assert.equal(requestsImage(text),true,text);
  for(const text of ['不要生成图片','不要给个自拍','如果我说给个自拍会怎样','解释一下给个自拍这句话','如何生成一张图？','帮我写生图接口代码','解释这个提示词','请查看文件','你会生成图片吗'])assert.equal(requestsImage(text),false,text);
  assert.throws(()=>validateImagePlan({...plan,path:'/tmp/x'}),/INVALID_IMAGE_PLAN/);
  assert.throws(()=>validateImagePlan({...plan,subject:7}),/INVALID_IMAGE_PLAN/);
  assert.throws(()=>validateImagePlan({...plan,subject:'x'.repeat(301)}),/INVALID_IMAGE_PLAN/);
});
test('natural image request plans, generates one clearly labelled mock and persists its owned artifact',async()=>{
  const w=web();try{
    const s=w.app.createSession(),other=w.app.createSession(),events:any[]=[];
    await w.app.chat(s.id,'帮我生成一张猫猫图','chat',signal(),e=>events.push(e));
    const turn=w.app.detail(s.id).turns[0];assert.equal(turn.state,'completed');assert.match(turn.answer,/不是 AI 作品/);
    assert.equal(turn.images.length,1);assert.equal(turn.images[0].mock,true);
    assert.ok(events.findIndex(e=>e.type==='tool'&&e.event.name==='image_plan')<events.findIndex(e=>e.type==='image'));
    const bytes=w.app.image(s.id,turn.images[0].id);assert.equal(bytes.readUInt32BE(16),1);
    assert.throws(()=>w.app.image(other.id,turn.images[0].id),/IMAGE_NOT_FOUND/);
    assert.deepEqual(w.app.workspace(s.id).list(),[]);assert.deepEqual(w.f.ledger.snapshot(),[]);
    for(let i=1;i<20;i++)await w.app.chat(s.id,'画一张猫','chat',signal(),()=>{});
    assert.equal(w.app.status().imageLimits.daily,20);assert.equal((w.app.status().budgets.usage as any[]).find(x=>x.metric==='image'&&x.scope==='*').value,20);
    const usage=JSON.stringify(w.app.status().budgets.usage);
    await w.app.chat(s.id,'画一张猫','chat',signal(),()=>{});
    assert.equal(w.app.detail(s.id).turns[20].answer,'IMAGE_BUDGET_EXHAUSTED');assert.equal(JSON.stringify(w.app.status().budgets.usage),usage);
    const output=path.join(w.f.root,'runtime/outputs',turn.images[0].id,'image.png');fs.appendFileSync(output,'tamper');
    assert.throws(()=>w.app.image(s.id,turn.images[0].id),/ARTIFACT_CHANGED/);
  }finally{await w.close();}
});
test('DeepSeek plan reaches the code runner, original self intent survives rewriting, and reference evidence is required',async()=>{
  let payload:any,seenPrompt='',seenReference='';let runnerCalls=0;let bytes:Buffer;
  const runner:ImageRunner={async generateImage(cwd,prompt,_signal,reference){runnerCalls++;seenPrompt=prompt;seenReference=reference??'';
    return {text:'untrusted assistant text',images:[{id:'native',type:'imageGeneration',status:'completed',result:bytes.toString('base64'),inputImages:reference?[{path:reference,sha256:createHash('sha256').update(fs.readFileSync(reference)).digest('hex')}]:[]}]};}};
  const http=(async(_u:any,options:any)=>{payload=JSON.parse(options.body);return reply([call()]);}) as typeof fetch;
  const w=web(false,http,runner);try{
    bytes=await png(w.f.root);const dir=makeDir(w.f.root,'runtime/character');fs.writeFileSync(path.join(dir,'whalechan-reference.png'),bytes);
    const s=w.app.createSession();await w.app.chat(s.id,'画一张你自己的图，穿原来的服饰','chat',signal(),()=>{});
    assert.equal(runnerCalls,1);assert.equal(payload.tools.length,1);assert.equal(payload.tools[0].function.name,'generate_image');
    assert.match(seenPrompt,/窗边喝茶/);assert.match(seenPrompt,/用户原始要求：画一张你自己的图/);assert.match(seenPrompt,/鲸鳍耳/);
    assert.ok(seenReference.endsWith('/character-reference.png'));assert.equal(fs.existsSync(seenReference),false);
    const turn=w.app.detail(s.id).turns[0];assert.equal(turn.state,'completed');assert.equal(turn.images[0].mock,false);
    assert.deepEqual(w.app.image(s.id,turn.images[0].id),bytes);assert.equal(w.f.ledger.value('image'),1);assert.equal(w.f.ledger.value('codex'),1);
    assert.deepEqual(fs.readFileSync(path.join(w.f.root,CHARACTER_REFERENCE)),bytes);
  }finally{await w.close();}
});
test('extra tools, invalid plans and missing reference never dispatch; model cannot authorize image from an ordinary turn',async()=>{
  let runnerCalls=0,calls=0;
  const runner:ImageRunner={async generateImage(){runnerCalls++;throw Error('must not dispatch');}};
  const http=(async()=>{calls++;return reply(calls===1?[call(),call(plan,'shell')]:[call({...plan,path:'../secret'})]);}) as typeof fetch;
  const w=web(false,http,runner);try{
    const a=w.app.createSession();await w.app.chat(a.id,'画一张猫','chat',signal(),()=>{});assert.equal(w.app.detail(a.id).turns[0].answer,'IMAGE_PLAN_REQUIRED');
    await w.app.chat(a.id,'画一张狗','agent',signal(),()=>{});assert.equal(w.app.detail(a.id).turns[1].answer,'INVALID_IMAGE_PLAN');
    await w.app.chat(a.id,'画一张你自己','chat',signal(),()=>{});assert.equal(w.app.detail(a.id).turns[2].answer,'CHARACTER_REFERENCE_MISSING');assert.equal(calls,2);
    await w.app.chat(a.id,'hello','chat',signal(),()=>{});assert.equal(w.app.detail(a.id).turns[3].answer,'TOOL_LIMIT_OR_DISABLED');
    assert.equal(runnerCalls,0);assert.equal(w.f.ledger.value('image'),0);assert.equal(w.f.ledger.value('codex'),0);
  }finally{await w.close();}
});
test('failed/cancelled image jobs never publish or retry and keep attempts charged',async()=>{
  for(const cancelled of [false,true]){
    let calls=0;const abort=new AbortController();
    const runner:ImageRunner={async generateImage(_cwd,_prompt,s){calls++;if(cancelled){abort.abort();s.throwIfAborted();}return {text:'I generated it',images:[]};}};
    const w=web(false,(async()=>reply([call()])) as typeof fetch,runner);try{
      const a=w.app.createSession();await w.app.chat(a.id,'画一张猫','chat',abort.signal,()=>{});
      const turn=w.app.detail(a.id).turns[0];assert.equal(turn.state,'failed');assert.deepEqual(turn.images,[]);assert.equal(calls,1);
      assert.equal(turn.answer,cancelled?'CHAT_CANCELLED':'CODEX_IMAGE_UNSUPPORTED_OR_MISSING');assert.equal(w.f.ledger.value('image'),1);
      assert.equal(w.app.detail(a.id).busy,false);assert.equal(w.f.store.db.prepare("SELECT id FROM reservations WHERE state='held'").get(),undefined);
    }finally{await w.close();}
  }
});
test('image and Codex reservations are atomic when allowance is exhausted',()=>{
  const f=fixture({imageDaily:1});try{f.ledger.reserve('image','g','u');assert.throws(()=>f.ledger.reserveImageJob('web:fixture','u',1000),/IMAGE_BUDGET_EXHAUSTED/);assert.equal(f.ledger.value('codex'),0);assert.equal(f.ledger.value('codexMs'),0);}finally{f.cleanup();}
});
test('self portrait without native reference-use evidence fails after dispatch and does not publish',async()=>{
  let bytes:Buffer,referencePath='';
  const runner:ImageRunner={async generateImage(_cwd,_prompt,_signal,reference){referencePath=reference??'';return {text:'used the reference',images:[{id:'native',type:'imageGeneration',status:'completed',result:bytes.toString('base64')}]};}};
  const w=web(false,(async()=>reply([call()])) as typeof fetch,runner);try{
    bytes=await png(w.f.root);const dir=makeDir(w.f.root,'assets/character');fs.writeFileSync(path.join(w.f.root,BUNDLED_CHARACTER_REFERENCE),bytes);
    const s=w.app.createSession();await w.app.chat(s.id,'画一张你的图','chat',signal(),()=>{});
    const turn=w.app.detail(s.id).turns[0];assert.equal(turn.answer,'CHARACTER_REFERENCE_NOT_USED');assert.deepEqual(turn.images,[]);
    assert.equal(fs.existsSync(referencePath),false);assert.equal(w.f.ledger.value('image'),1);assert.deepEqual(fs.readdirSync(path.join(w.f.root,'runtime/outputs')),[]);
  }finally{await w.close();}
});
test('self portrait with no native image shows the actual Codex reply in a persistent call record',async()=>{
  let root='';
  const runner:ImageRunner={async generateImage(cwd,prompt,_signal,reference){
    const record=new CodexDiagnostics(root,path.basename(cwd),prompt,true,reference);
    record.notice('item/completed',{item:{type:'agentMessage',id:'message',phase:'final_answer',text:'The image tool returned no image.'}});
    record.finish('The image tool returned no image.');return {text:'The image tool returned no image.',images:[]};
  }};
  const w=web(false,(async()=>reply([call()])) as typeof fetch,runner);root=w.f.root;
  try{
    const dir=makeDir(root,'assets/character');fs.writeFileSync(path.join(dir,'whalechan-reference.png'),await png(root));
    const s=w.app.createSession();await w.app.chat(s.id,'画一张你自己','chat',signal(),()=>{});
    const turn=w.app.detail(s.id).turns[0];assert.equal(turn.answer,'CODEX_IMAGE_UNSUPPORTED_OR_MISSING');
    const trace=turn.trace.find((e:any)=>e.name==='codex_record');assert.ok(trace);
    const record=JSON.parse(trace.result);assert.equal(record.finalText,'The image tool returned no image.');
    assert.equal(record.delivery.error,'CODEX_IMAGE_UNSUPPORTED_OR_MISSING');assert.equal(record.delivery.nativeImageCompletions,0);
    assert.deepEqual(turn.images,[]);
  }finally{await w.close();}
});
test('PNG endpoint needs local auth and session ownership, and rechecks the file hash',async()=>{
  const w=web(),port=42000+Math.floor(Math.random()*10000),{server}=webServer(w.app,port);
  try{
    const s=w.app.createSession(),other=w.app.createSession();await w.app.chat(s.id,'画一张猫','chat',signal(),()=>{});
    const id=w.app.detail(s.id).turns[0].images[0].id;
    server.listen(port,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+port,route='/api/image?sessionId='+s.id+'&id='+id,headers={authorization:'Bearer '+w.app.token};
    assert.equal((await fetch(base+route)).status,401);const r=await fetch(base+route,{headers});assert.equal(r.status,200);assert.match(r.headers.get('content-type')??'',/image\/png/);assert.match(r.headers.get('content-security-policy')??'',/sandbox/);await r.arrayBuffer();
    assert.equal((await fetch(base+route.replace(s.id,other.id),{headers})).status,400);
    fs.appendFileSync(path.join(w.f.root,'runtime/outputs',id,'image.png'),'x');assert.equal((await fetch(base+route,{headers})).status,400);
  }finally{await w.app.close();server.close();await once(server,'close');w.f.cleanup();}
});
