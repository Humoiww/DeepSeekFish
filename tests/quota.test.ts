import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { CodexQuotaMonitor,normalizeQuota,quotaPolicy,type QuotaReader } from '../src/codex/quota.js';
import { CodexRateLimitError,rateLimitFailure } from '../src/codex/rate-limit.js';
import { createWebApp } from '../src/web/app.js';
import { webServer } from '../src/web/server.js';
import { MockImageProvider } from '../src/image/provider.js';
import { makeDir } from '../src/paths.js';

const raw=(remaining=80)=>({ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent:100-remaining,windowDurationMins:10080,resetsAt:2000000000},secondary:null}});
const reader=(value:()=>unknown):QuotaReader=>({async read(){return value();},async close(){}});
test('quota parsing prefers pool map, recognizes a primary weekly window and never invents missing data',()=>{
  const s=normalizeQuota({...raw(),rateLimitsByLimitId:{other:{limitId:'other',primary:null,secondary:{usedPercent:75,windowDurationMins:300,resetsAt:2000000000}}},accountId:'do-not-return',token:'private'});
  assert.equal(s.pools.length,1);assert.equal(s.pools[0].id,'other');assert.equal(s.pools[0].windows[0].remainingPercent,25);assert.equal(quotaPolicy(s).decision,'confirm');
  assert.equal(JSON.stringify(s).includes('do-not-return'),false);
  assert.equal(normalizeQuota(raw()).pools[0].windows[0].windowDurationMins,10080);
  assert.equal(quotaPolicy(normalizeQuota({rateLimits:{primary:{usedPercent:null}}})).decision,'pause');
  assert.equal(quotaPolicy(normalizeQuota(raw(),Date.now()-330001)).reason,'CODEX_QUOTA_UNKNOWN');
  for(const [remaining,decision] of [[31,'allow'],[30,'confirm'],[10,'confirm'],[9,'pause'],[0,'pause']] as const)assert.equal(quotaPolicy(normalizeQuota(raw(remaining))).decision,decision);
  assert.equal(quotaPolicy(normalizeQuota({...raw(99),ordinaryUsageAllowed:false})).decision,'pause');
  assert.equal(quotaPolicy(normalizeQuota({rateLimits:{...raw().rateLimits,rateLimitReachedType:'rate_limit_reached'}})).decision,'pause');
});
test('monitor requires per-request confirmation, blocks unavailable data and persists provider backoff across restart',async()=>{
  const f=fixture();let value:any=raw(20),calls=0;
  const r=reader(()=>{calls++;return value;});const monitor=new CodexQuotaMonitor(f.store,false,r);
  try{
    await assert.rejects(monitor.beforeImage(),/CONFIRM_REQUIRED/);await monitor.beforeImage(true);await assert.rejects(monitor.beforeImage(),/CONFIRM_REQUIRED/);
    value={};await assert.rejects(monitor.beforeImage(true),/QUOTA_UNKNOWN/);
    value=raw(9);await assert.rejects(monitor.beforeImage(true),/QUOTA_LOW/);
    monitor.limited(new CodexRateLimitError(Date.now()-1));value={...raw(90),ordinaryUsageAllowed:null};await assert.rejects(monitor.beforeImage(true),/RATE_LIMITED/);value=raw(90);await monitor.beforeImage();
    const limited=rateLimitFailure({data:{codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429}},retryAfterSeconds:120}})!;
    assert.equal(limited.code,'CODEX_RATE_LIMITED');monitor.limited(limited);await monitor.close();
    const restored=new CodexQuotaMonitor(f.store,false,reader(()=>raw(90)));
    try{await assert.rejects(restored.beforeImage(true),/RATE_LIMITED/);assert.ok(restored.status().retryAt!>Date.now());}finally{await restored.close();}
    assert.ok(calls>=3);assert.deepEqual(f.ledger.snapshot(),[]);
    assert.equal(rateLimitFailure({message:'429 fake text'}),undefined);
  }finally{await monitor.close();f.cleanup();}
});
test('local reset retains reservations, attempts and unrelated usage, and refuses active/unknown leases',()=>{
  const f=fixture();try{
    const general=f.ledger.reserve('codex','g','u',0,0,1000);f.ledger.settle(general,undefined,200);
    const pair=f.ledger.reserveImageJob('web:test','u',1000);
    assert.throws(()=>f.ledger.resetImages(),/BUSY_OR_UNCERTAIN/);
    f.ledger.settle(pair.codex,undefined,300);f.ledger.settle(pair.image);
    assert.equal(f.ledger.value('codexMs'),500);f.ledger.resetImages();
    assert.equal(f.ledger.value('image'),0);assert.equal(f.ledger.value('imageAttempts'),1);assert.equal(f.ledger.value('codex'),1);assert.equal(f.ledger.value('codexMs'),200);
    f.ledger.resetImages();assert.equal(f.ledger.value('codexMs'),200);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM reservations').get() as any).n,3);
    const held=f.ledger.reserve('codex','g','u');f.store.db.prepare("UPDATE reservations SET state='unknown' WHERE id=?").run(held);assert.throws(()=>f.ledger.resetImages(),/BUSY_OR_UNCERTAIN/);
  }finally{f.cleanup();}
});
test('image allowance is checked against refreshed quota; confirmation cannot override pause, and 429 stops subsequent jobs',async()=>{
  const f=fixture();let remaining=20,rateLimited=false,modelCalls=0,runnerCalls=0;
  const plan={subject:'猫',scene:'窗边',style:'水彩',composition:'方形',lighting:'晨光',palette:'蓝白',details:'无文字'};
  const http=(async()=>{modelCalls++;return new Response(JSON.stringify({choices:[{message:{content:'',tool_calls:[{id:'c',type:'function',function:{name:'generate_image',arguments:JSON.stringify(plan)}}]}}],usage:{prompt_tokens:20,completion_tokens:10}}));}) as typeof fetch;
  const app=createWebApp(f.root,false,http,{async generateImage(cwd){runnerCalls++;if(rateLimited)throw new CodexRateLimitError(Date.now()+120000);const dir=makeDir(f.root,'runtime/codex-home/generated_images');await new MockImageProvider().generate('fixture',dir);return {text:'',images:[{id:'n',type:'imageGeneration',status:'completed',savedPath:path.join(dir,'mock.png')}]};}},reader(()=>raw(remaining)));
  try{
    app.configure({apiKey:'fixture-key'});fs.writeFileSync(path.join(f.root,'runtime/codex-home/auth.json'),'{}');const s=app.createSession(),sig=new AbortController().signal;
    await app.chat(s.id,'画一张猫','chat',sig,()=>{});assert.equal(app.detail(s.id).turns[0].answer,'CODEX_QUOTA_CONFIRM_REQUIRED');assert.equal(modelCalls,0);
    await app.chat(s.id,'画一张猫','chat',sig,()=>{},true);assert.equal(app.detail(s.id).turns[1].state,'completed');assert.equal(runnerCalls,1);
    remaining=9;await app.chat(s.id,'画一张猫','chat',sig,()=>{},true);assert.equal(app.detail(s.id).turns[2].answer,'CODEX_QUOTA_LOW');assert.equal(modelCalls,1);
    remaining=80;rateLimited=true;await app.chat(s.id,'画一张猫','chat',sig,()=>{});assert.equal(runnerCalls,2);assert.equal(app.detail(s.id).turns[3].answer,'CODEX_RATE_LIMITED');
    app.resetImages();await app.chat(s.id,'画一张猫','chat',sig,()=>{},true);assert.equal(runnerCalls,2);assert.equal(app.detail(s.id).turns[4].answer,'CODEX_RATE_LIMITED');
  }finally{await app.close();f.cleanup();}
});
test('quota refresh and reset endpoints require existing local authentication',async()=>{
  const f=fixture(),app=createWebApp(f.root,true),port=44000+Math.floor(Math.random()*10000),{server}=webServer(app,port);
  try{
    server.listen(port,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+port;
    const post=(route:string,auth=true)=>fetch(base+'/api/'+route,{method:'POST',headers:auth?{authorization:'Bearer '+app.token,'content-type':'application/json'}:{'content-type':'application/json'},body:'{}'});
    assert.equal((await post('images/reset',false)).status,401);assert.equal((await post('codex-quota/refresh',false)).status,401);
    const status:any=await (await post('codex-quota/refresh')).json();assert.equal(status.codexQuota.mock,true);assert.equal(status.imageLimits.daily,20);
    assert.equal((await post('images/reset')).status,200);assert.equal((await post('images/reset')).status,200);
  }finally{await app.close();server.close();await once(server,'close');f.cleanup();}
});
