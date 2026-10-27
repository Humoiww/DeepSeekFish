import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, message } from './helpers.js';
import { safePath, makeDir } from '../src/paths.js';
import { projectRoot } from '../src/config.js';
import { collectArtifacts } from '../src/codex/artifacts.js';
import { verifyArtifact } from '../src/codex/verify.js';
import { Tasks } from '../src/codex/tasks.js';
import { RpcProcess } from '../src/codex/process.js';
import { MockTaskRunner, AppServerRunner, childEnvironment } from '../src/codex/runner.js';
test('canonical path boundary rejects absolute, traversal, Windows ADS/device and ancestor symlink/junction',()=>{
  const f=fixture();try{
    for(const input of ['../secret','/etc/passwd','C:/Users/a','C:\\Users\\a','a/../../b','a/./b','a\\b','x:stream','NUL.txt','a.','a '])assert.throws(()=>safePath(f.root,input));
    const outside=makeDir(f.root,'runtime/data/private');
    fs.symlinkSync(outside,path.join(f.root,'runtime/workspace/link'),'junction');
    assert.throws(()=>safePath(f.root,'runtime/workspace/link/secret.txt'),/PATH_LINK/);
    assert.throws(()=>makeDir(path.join(f.root,'runtime/workspace/link'),'nested'),/PATH_LINK/);
  }finally{f.cleanup();}
});
test('artifacts validate complete set, hashes, byte count, file count and hardlinks',()=>{
  const f=fixture();try{
    const task=makeDir(f.root,'runtime/workspace/ok');fs.writeFileSync(path.join(task,'hello.txt'),'hello');
    const manifest=collectArtifacts(f.root,'ok',2,100);assert.equal(manifest.length,1);
    const p=path.join(f.root,'runtime/outputs/ok/hello.txt');verifyArtifact(p,manifest[0],100);fs.writeFileSync(p,'changed');assert.throws(()=>verifyArtifact(p,manifest[0],100),/ARTIFACT_CHANGED/);
    const bad=makeDir(f.root,'runtime/workspace/bad');fs.writeFileSync(path.join(bad,'a.txt'),'good');fs.writeFileSync(path.join(bad,'b.exe'),'bad');
    assert.throws(()=>collectArtifacts(f.root,'bad',10,100),/ARTIFACT_TYPE/);assert.ok(!fs.existsSync(path.join(f.root,'runtime/outputs/bad')));
    const big=makeDir(f.root,'runtime/workspace/big');fs.writeFileSync(path.join(big,'big.txt'),'123456');assert.throws(()=>collectArtifacts(f.root,'big',2,5),/ARTIFACT_LIMIT/);
    const many=makeDir(f.root,'runtime/workspace/many');fs.writeFileSync(path.join(many,'a.txt'),'a');fs.writeFileSync(path.join(many,'b.txt'),'b');assert.throws(()=>collectArtifacts(f.root,'many',1,100),/ARTIFACT_LIMIT/);
    const hard=makeDir(f.root,'runtime/workspace/hard');fs.linkSync(path.join(task,'hello.txt'),path.join(hard,'leak.txt'));assert.throws(()=>collectArtifacts(f.root,'hard',2,100),/ARTIFACT_LINK/);
  }finally{f.cleanup();}
});
test('Codex task timeout/cancel settle state and never collect interrupted artifacts',async()=>{
  const f=fixture({codex:true,codexTimeoutMs:20,codexDaily:10});
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner(200));try{
    const a=tasks.enqueue(message(),'create','create');tasks.approve(a.id);await tasks.idle();assert.equal(tasks.get(a.id).state,'timed_out');
    const b=tasks.enqueue(message(),'create','create');tasks.approve(b.id);tasks.cancel(b.id);await tasks.idle();assert.equal(tasks.get(b.id).state,'cancelled');
    assert.ok(!fs.existsSync(path.join(f.root,'runtime/outputs',a.id)));assert.ok(!fs.existsSync(path.join(f.root,'runtime/outputs',b.id)));
    const c=tasks.enqueue(message(),'create','create');tasks.cancel(c.id);assert.equal(tasks.get(c.id).state,'cancelled');assert.throws(()=>tasks.approve(c.id),/TASK_NOT_WAITING/);
  }finally{await tasks.stop();f.cleanup();}
});
test('failed/unsafe task outputs are retained as failure, never published as success',async()=>{
  const f=fixture({codex:true});
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,{async run(cwd){fs.writeFileSync(path.join(cwd,'bad.exe'),'x');return 'done';}});
  try{const t=tasks.enqueue(message(),'create','create');tasks.approve(t.id);await tasks.idle();assert.equal(tasks.get(t.id).state,'failed');assert.equal(tasks.get(t.id).result,'ARTIFACT_TYPE');}
  finally{await tasks.stop();f.cleanup();}
});
test('JSON-RPC approval is declined, cancellation kills actual process tree on POSIX',{timeout:5000},async(t)=>{
  if(process.platform==='win32'){t.skip('POSIX process group test; Windows Job Object requires native smoke');return;}
  const f=fixture(),abort=new AbortController();
  const rpc=new RpcProcess({command:process.execPath,args:[path.join(projectRoot(),'tests/fixtures/rpc-child.mjs')],cwd:f.root,env:{PATH:process.env.PATH}},abort.signal);
  t.after(async()=>{abort.abort();await rpc.stop();});
  try{
    await rpc.call('initialize');const result=await rpc.call('spawn');assert.ok(result.pid>0&&result.child>0);
    const notice=once(rpc,'notice');await rpc.call('approval');const [method,p]=await notice;assert.equal(method,'approvalResult');assert.equal(p.decision,'decline');
    await delay(100);const heartbeat=path.join(f.root,'heartbeat.txt');assert.ok(fs.existsSync(heartbeat));
    const hanging=rpc.call('hang');abort.abort();await assert.rejects(hanging,/CODEX_ABORTED/);await rpc.stop();
    await delay(50);const last=fs.readFileSync(heartbeat,'utf8');await delay(80);assert.equal(fs.readFileSync(heartbeat,'utf8'),last);
    assert.throws(()=>process.kill(result.pid,0));
  }finally{await rpc.stop();f.cleanup();}
});
test('real runner fails closed on non-Windows; child env excludes ambient secrets',async()=>{
  const f=fixture();try{
    process.env.FISH_TEST_SECRET='secret';process.env.OPENAI_API_KEY='do-not-inherit';
    const env=childEnvironment(f.root);assert.equal(env.FISH_TEST_SECRET,undefined);assert.equal(env.OPENAI_API_KEY,undefined);assert.ok(env.CODEX_HOME!.startsWith(f.root));
    if(process.platform!=='win32')await assert.rejects(new AppServerRunner(f.root).run(f.root,'task',new AbortController().signal),/CODEX_WINDOWS_REQUIRED/);
  }finally{delete process.env.FISH_TEST_SECRET;delete process.env.OPENAI_API_KEY;f.cleanup();}
});
