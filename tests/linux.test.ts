import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { projectRoot,prepare } from '../src/config.js';
import { makeDir,safePath } from '../src/paths.js';
import { appServerSpec,bubblewrap,linuxSpec,permissionArgs,taskDirectory } from '../src/codex/platform.js';
import { probeIsolation } from '../src/codex/probe.js';
import type { RpcProcess } from '../src/codex/process.js';
import { fixture } from './helpers.js';

test('task cwd accepts generated children only; Windows launcher remains explicit MXC',()=>{
  const f=fixture();try{
    const cwd=makeDir(f.root,'runtime/workspace/test');assert.equal(taskDirectory(f.root,cwd),cwd);
    for(const p of [f.root,path.join(f.root,'runtime/workspace'),path.join(f.root,'runtime/workspace/test/nested'),path.join(f.root,'runtime/data')])assert.throws(()=>taskDirectory(f.root,p),/CODEX_INVALID_WORKDIR/);
    const spec=appServerSpec(f.root,cwd,'win32');assert.ok(spec.command.endsWith('powershell.exe'));
    const encoded=spec.args[spec.args.indexOf('-CommandBase64')+1];const line=Buffer.from(encoded,'base64').toString('utf16le');
    assert.ok(line.includes('windows.sandbox'));assert.ok(line.includes('mxc'));assert.ok(!line.includes('danger-full-access'));
    assert.throws(()=>appServerSpec(f.root,cwd,'darwin'),/CODEX_PLATFORM_UNSUPPORTED/);
  }finally{f.cleanup();}
});
test('Linux mount allowlist omits host home/repo root and keeps runtime reads separate from auth',()=>{
  if(process.platform!=='linux')return;
  const root=projectRoot(),cwd=makeDir(root,'runtime/workspace/probe-layout');
  try{
    const spec=linuxSpec(root,cwd,[]);
    assert.ok(spec.args.includes('--unshare-pid'));assert.ok(spec.args.includes('--die-with-parent'));assert.ok(spec.args.includes('--remount-ro'));
    for(let i=0;i<spec.args.length;i++)if(['--bind','--ro-bind'].includes(spec.args[i]))assert.ok(!['/','/home',root].includes(spec.args[i+1]));
    const profile=permissionArgs(cwd,root).join(' ');assert.ok(profile.includes(':root'));assert.ok(profile.includes('arg0-linux'));assert.ok(!profile.includes('auth.json'));
    assert.equal(spec.env.DEEPSEEK_API_KEY,undefined);assert.equal(spec.env.SSH_AUTH_SOCK,undefined);
  }finally{fs.rmSync(cwd,{recursive:true,force:true});fs.rmSync(safePath(root,'runtime/tmp/codex-probe-layout'),{recursive:true,force:true});}
});
test('isolation probe rejects broken positive control and real host write escapes',async()=>{
  const f=fixture(),cwd=makeDir(f.root,'runtime/workspace/probe-unit');
  try{
    const broken={async call(){return {exitCode:127,stdout:'',stderr:''};}} as unknown as RpcProcess;
    await assert.rejects(probeIsolation(broken,f.root,cwd),/POSITIVE_CONTROL/);
    const malicious={async call(_method:string,p:any){
      const file=p.command.at(-1),nonce=p.command.at(-2);
      if(p.command[0]==='/bin/cat'||p.command[0]==='cmd.exe')return {exitCode:1,stdout:''};
      fs.writeFileSync(file,nonce);return {exitCode:0,stdout:nonce};
    }} as unknown as RpcProcess;
    if(process.platform==='linux')await assert.rejects(probeIsolation(malicious,f.root,cwd),/WRITE_ISOLATION/);
  }finally{f.cleanup();}
});
test('Linux PID namespace stops a detached setsid descendant on cancellation',{timeout:6000},async(t)=>{
  if(process.platform!=='linux'){t.skip('Linux namespace test');return;}
  const root=projectRoot();if(!bubblewrap(root)){t.skip('bubblewrap unavailable; real runner fails closed');return;}
  const cwd=makeDir(root,'runtime/workspace/probe-pid-'+process.pid);
  const spec=linuxSpec(root,cwd,[]),separator=spec.args.lastIndexOf('--');
  spec.args.splice(separator+1,1,'/bin/sh','-c',
    'setsid /bin/sh -c \'while :; do printf x >> heartbeat.txt; sleep 0.02; done\' & printf "NAMESPACE_READY\\n"; while :; do sleep 1; done');
  const proc=spawn(spec.command,spec.args,{cwd,env:spec.env,detached:true,stdio:['ignore','pipe','pipe']});
  let output='';proc.stdout.on('data',b=>{output+=b;});proc.stderr.resume();
  const ended=once(proc,'close');
  t.after(()=>{try{if(proc.pid)process.kill(-proc.pid,'SIGKILL');}catch{}fs.rmSync(cwd,{recursive:true,force:true});fs.rmSync(safePath(root,'runtime/tmp/codex-'+path.basename(cwd)),{recursive:true,force:true});});
  const ready=await Promise.race([new Promise<boolean>(resolve=>proc.stdout.on('data',()=>{if(output.includes('NAMESPACE_READY'))resolve(true);})),ended.then(()=>false),delay(2000).then(()=>false)]);
  if(!ready){try{if(proc.pid)process.kill(-proc.pid,'SIGKILL');}catch{}await ended;t.skip('Host refuses bubblewrap namespaces; sandbox-check will refuse real tasks');return;}
  await delay(100);assert.ok(fs.existsSync(path.join(cwd,'heartbeat.txt')));
  process.kill(-proc.pid!,'SIGKILL');await ended;await delay(50);
  const before=fs.readFileSync(path.join(cwd,'heartbeat.txt'),'utf8');await delay(80);assert.equal(fs.readFileSync(path.join(cwd,'heartbeat.txt'),'utf8'),before);
});
