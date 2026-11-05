import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './helpers.js';
import {BudgetedModel,DeepSeekModel,modelPayload} from '../src/agent/model.js';
import {traceModel} from '../src/agent/model-trace.js';
import {diagnosticSafe,errorDiagnostic} from '../src/diagnostics.js';
import {writePrivateAtomic} from '../src/paths.js';
import {ActivityHistory} from '../src/web/activity.js';
import {WebModel} from '../src/web/model.js';
import type {ChatMessage} from '../src/types.js';

test('timeout preserves the actual input, native roles, error cause and unknown reservation before/after I/O',async()=>{
 const f=fixture(),trace:any[]=[],messages:ChatMessage[]=[{role:'system',content:'系统'}, {role:'user',content:'之前的问题'}, {role:'assistant',content:'之前的回答'}, {role:'user',content:'当前的问题'}];
 const file='runtime/logs/qq/timeout.json';fs.mkdirSync(f.root+'/runtime/logs/qq');
 const save=()=>writePrivateAtomic(f.root,file,JSON.stringify({request:'当前的问题',state:trace.at(-1)?.state,trace}));
 try{
  const http=(async()=>{
   const pending=JSON.parse(fs.readFileSync(f.root+'/'+file,'utf8')).trace[0];assert.equal(pending.state,'running');assert.equal(pending.reservation.state,'held');assert.deepEqual(pending.request.messages,messages);
   throw new DOMException('The operation was aborted due to timeout','TimeoutError');
  }) as typeof fetch;
  const model=new BudgetedModel(new DeepSeekModel('fixture-key',f.cfg,http),f.ledger,f.cfg);
  await assert.rejects(traceModel(trace,save,modelPayload(f.cfg(),messages,256),0,onReservation=>model.complete('g','u',messages,{onReservation})),/DEEPSEEK_TIMEOUT/);
  const e=trace[0];assert.equal(e.state,'failed');assert.equal(e.error,'DEEPSEEK_TIMEOUT');assert.equal(e.diagnostic.cause.name,'TimeoutError');assert.match(e.diagnostic.cause.message,/timeout/);assert.equal(e.diagnostic.details.timeoutMs,30000);assert.ok(e.durationMs>=0);assert.equal(e.reservation.state,'unknown');assert.equal(f.ledger.value('tokens'),e.reservation.reservedTokens);
  const d=await new ActivityHistory(f.root,f.store,f.store).detail('qq:timeout');assert.equal(d.usage.calls,1);assert.equal(d.usage.known,false);assert.equal(d.usage.unreportedCalls,1);assert.equal(d.usage.unconfirmedTokens,e.reservation.reservedTokens);
  const modelEvent=d.events.find(e=>e.type==='model')!;assert.equal(modelEvent.state,'failed');assert.deepEqual(modelEvent.request.messages,messages);assert.equal(modelEvent.diagnostic.cause.name,'TimeoutError');
 }finally{f.cleanup();}
});

test('HTTP provider details and network causes survive redaction; response bodies are bounded',async()=>{
 const f=fixture();try{
  const body={error:{code:'service_unavailable_error',message:'service is too busy',type:'server_error'},apiKey:'secret-key'};
  const provider=new DeepSeekModel('fixture-key',f.cfg,(async()=>new Response(JSON.stringify(body),{status:503,headers:{'x-request-id':'req-test','set-cookie':'secret-cookie'}})) as typeof fetch);
  await assert.rejects(provider.complete([{role:'user',content:'a'}],10),(e:any)=>{
   const d=errorDiagnostic(e);assert.equal(e.code,'DEEPSEEK_HTTP_503');assert.equal(d.details.httpStatus,503);assert.equal(d.details.requestId,'req-test');assert.equal(d.details.provider.error.message,'service is too busy');assert.ok(!JSON.stringify(d).includes('secret-key'));assert.ok(!JSON.stringify(d).includes('secret-cookie'));return true;
  });
  const plain=new DeepSeekModel('fixture-key',f.cfg,(async()=>new Response('upstream unavailable '+('x'.repeat(10000)),{status:502})) as typeof fetch);
  await assert.rejects(plain.complete([{role:'user',content:'a'}],10),(e:any)=>{assert.match(e.diagnostic.provider.text,/upstream unavailable/);assert.equal(e.diagnostic.provider.truncated,true);assert.ok(e.diagnostic.provider.text.length<=8192);return true;});
  const network=new DeepSeekModel('fixture-key',f.cfg,(async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('connection reset'),{code:'ECONNRESET'})});}) as typeof fetch);
  await assert.rejects(network.complete([{role:'user',content:'a'}],10),(e:any)=>{assert.equal(e.code,'DEEPSEEK_NETWORK_ERROR');assert.equal(errorDiagnostic(e).cause.cause.nativeCode,'ECONNRESET');return true;});
 }finally{f.cleanup();}
});

test('successful model snapshots do not mutate, expose secrets or count the same native tool action twice',async()=>{
 const f=fixture(),trace:any[]=[],messages:ChatMessage[]=[{role:'system',content:'hello'}, {role:'user',content:[{type:'text',text:'图'}, {type:'image_url',image_url:{url:'data:image/png;base64,AAABBB',detail:'high'}}]}];
 const tools=[{type:'function' as const,function:{name:'browse_page',description:'browse',parameters:{type:'object'}}}],toolCall={id:'native-id',type:'function',function:{name:'browse_page',arguments:'{"url":"https://example.com/?token=secret-url"}'}};
 try{
  const model=new BudgetedModel(new DeepSeekModel('fixture-key',f.cfg,(async()=>new Response(JSON.stringify({id:'response-123',choices:[{finish_reason:'tool_calls',message:{content:'去看看',tool_calls:[toolCall]}}],usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:60,prompt_cache_miss_tokens:40}}))) as typeof fetch),f.ledger,f.cfg);
  await traceModel(trace,()=>{},modelPayload(f.cfg(),messages,256,{tools}),0,onReservation=>model.complete('g','u',messages,{tools,onReservation}));
  messages[0].content='changed';assert.equal(trace[0].request.messages[0].content,'hello');assert.equal(trace[0].responseId,'response-123');assert.ok(!JSON.stringify(trace[0].request).includes('AAABBB'));
  trace.push({name:'browse_page',round:0,callId:'native-id',state:'failed',result:{error:'INTERNAL_ERROR'},diagnostic:errorDiagnostic(new TypeError('missing title'))});
  fs.mkdirSync(f.root+'/runtime/logs/qq');fs.writeFileSync(f.root+'/runtime/logs/qq/native.json',JSON.stringify(diagnosticSafe({trace})));
  const d=await new ActivityHistory(f.root,f.store,f.store).detail('qq:native');assert.equal(d.usage.total,120);assert.equal(d.usage.cachedInput,60);assert.equal(d.counts.tools,1);assert.equal(d.events.find(e=>e.type==='tool')?.diagnostic.message,'missing title');assert.ok(!JSON.stringify(d).includes('secret-url'));
 }finally{f.cleanup();}
});

test('web model has the same timeout diagnosis and budget denial is not a fabricated API call',async()=>{
 const f=fixture(),trace:any[]=[];try{
  const web=new WebModel(()=> 'fixture-key',f.cfg,f.ledger,false,(async()=>{throw new DOMException('timed out','TimeoutError');}) as typeof fetch),messages=[{role:'user' as const,content:'hello'}];
  await assert.rejects(traceModel(trace,()=>{},modelPayload(f.cfg(),messages,256),0,onReservation=>web.complete('web:test',messages,[],new AbortController().signal,false,onReservation)),/DEEPSEEK_TIMEOUT/);
  assert.equal(trace[0].reservation.state,'unknown');assert.equal(trace[0].diagnostic.cause.name,'TimeoutError');
  f.set({dailyCny:0});const denied:any[]=[];
  await assert.rejects(traceModel(denied,()=>{},modelPayload(f.cfg(),messages,256),0,onReservation=>web.complete('web:test',messages,[],new AbortController().signal,false,onReservation)),/CNY_BUDGET/);
  assert.equal(denied[0].notRequested,true);assert.equal(denied[0].reservation,undefined);
 }finally{f.cleanup();}
});

test('generic errors retain causes and stacks while sensitive values and cycles stay bounded',()=>{
 const cause=Object.assign(new Error('download https://example.com/x?rkey=secret-rkey&x=1'),{code:'ECONNRESET'}),e=new TypeError('bad structure',{cause});
 const d=errorDiagnostic(e);assert.equal(d.code,'INTERNAL_ERROR');assert.equal(d.name,'TypeError');assert.match(d.stack,/bad structure/);assert.equal(d.cause.nativeCode,'ECONNRESET');assert.ok(!JSON.stringify(d).includes('secret-rkey'));
 const cycle=new Error('cycle');cycle.cause=cycle;assert.ok(JSON.stringify(errorDiagnostic(cycle)).length<10000);
 const safe=diagnosticSafe({cookie:'secret-cookie',note:'Authorization: Bearer secret-bearer\nCookie: a=secret-session; b=secret-other',json:'{"password":"secret-pass"}',image_url:{url:'data:image/png;base64,AAAA'}});
 for(const secret of ['secret-cookie','secret-bearer','secret-session','secret-other','secret-pass','base64,AAAA'])assert.ok(!JSON.stringify(safe).includes(secret));
});
