// Keyless diagnostics only. Does not start a model turn or change host policy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { prepare } from '../dist/src/config.js';
import { makeDir } from '../dist/src/paths.js';
import { appServerSpec, linuxExecutable, PERMISSION_PROFILE, childEnvironment } from '../dist/src/codex/platform.js';
import { RpcProcess } from '../dist/src/codex/process.js';
import { initialize, probeIsolation } from '../dist/src/codex/probe.js';

process.umask(0o077);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if(fs.existsSync(path.join(root,'runtime/codex-home/auth.json')))throw Error('Run diagnostics in a credential-free checkout');
prepare(root);
const id='probe-'+randomUUID(),cwd=makeDir(root,'runtime/workspace/'+id);
const report={at:new Date().toISOString(),modelTurns:0,tests:{}};
function run(command,args,env=childEnvironment(root)) {
  const r=spawnSync(command,args,{cwd,env,encoding:'utf8',timeout:10000,maxBuffer:32768});
  return {exitCode:r.status,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.code};
}
const spec=appServerSpec(root,cwd),separator=spec.args.indexOf('--');
const mounts=spec.args.slice(0,separator+1),nativeArgs=spec.args.slice(separator+2);
try {
  report.tests.outer=run(spec.command,[...mounts,'/bin/sh','-c',
    'cat /proc/self/attr/current; id; test ! -e /home; test ! -e /root'],spec.env);
  report.tests.nested=run(spec.command,[...mounts,'/usr/bin/bwrap','--unshare-user','--ro-bind','/','/','/bin/true'],spec.env);
  report.tests.innerPayload=run(spec.command,[...mounts,'/usr/bin/bwrap','--unshare-user','--unshare-pid','--ro-bind','/','/','--proc','/proc','/bin/sh','-c',
    'cat /proc/self/attr/current; grep CapEff /proc/self/status; python3 -c \'import os\ntry:\n os.unshare(os.CLONE_NEWUSER|os.CLONE_NEWNS)\nexcept PermissionError:\n print("combined namespace setup denied")\nelse:\n raise SystemExit("unexpected namespace capability")\''],spec.env);
  for(const [label,launch] of Object.entries({
    // This control runs only the native restricted profile, never a model/job.
    nativeOnly:{command:linuxExecutable(root),args:nativeArgs,cwd,env:spec.env},
    projectNested:spec,
  })) {
    const control=new AbortController(),timer=setTimeout(()=>control.abort(),20000);
    let rpc,stderr='';
    try {
      rpc=new RpcProcess(launch,control.signal);
      rpc.child.stderr.on('data',b=>{stderr=(stderr+String(b)).slice(-4096);});
      await initialize(rpc,cwd);
      const target=path.join(cwd,label+'.txt');
      const r=await rpc.call('command/exec',{command:['/bin/sh','-c','printf probe-ok > "$1" && cat "$1"','diagnostic',target],cwd,permissionProfile:PERMISSION_PROFILE,timeoutMs:5000});
      report.tests[label]={initialized:true,exitCode:r.exitCode,stdout:r.stdout,stderr:r.stderr,hostFileCreated:fs.existsSync(target)};
      if(r.exitCode===0){
        await probeIsolation(rpc,root,cwd);
        report.tests[label].projectFileCanariesPassed=true;
        // Synthetic broker endpoint: no real management token or credential.
        let accepted=false;
        const server=createServer(socket=>{accepted=true;socket.end();});
        server.listen(0,'127.0.0.1');await once(server,'listening');
        try {
          const port=server.address().port;
          const network=await rpc.call('command/exec',{command:['/usr/bin/python3','-c',
            'import socket\ntry:\n s=socket.socket();s.settimeout(1);s.connect(("127.0.0.1",'+port+'));print("connected")\nexcept OSError as e:\n print("blocked:",e.errno)'],cwd,permissionProfile:PERMISSION_PROFILE,timeoutMs:5000});
          report.tests[label].loopbackBrokerProbe={exitCode:network.exitCode,result:network.stdout.trim(),stderr:network.stderr,accepted};
        }finally{server.close();await once(server,'close');}
      }
    }catch(e){report.tests[label]={error:e.message,stderr};}
    finally{clearTimeout(timer);await rpc?.stop();}
  }
  // Dummy values only: demonstrate that mode 0600 is not a same-UID boundary.
  const canary=path.join(cwd,'same-uid-canary.txt');fs.writeFileSync(canary,'dummy-not-a-credential',{mode:0o600});
  report.tests.sameUid=run('/usr/bin/python3',['-c',
    'import os,subprocess,sys; p=subprocess.Popen(["/bin/sleep","10"],env={"FISH_CANARY":"dummy-not-a-credential"}); '+
    '\ntry:\n print("file-readable:",open(sys.argv[1]).read()=="dummy-not-a-credential"); print("child-environ-readable:",b"FISH_CANARY=" in open("/proc/%d/environ"%p.pid,"rb").read())\nfinally:\n p.terminate();p.wait()',canary]);
  const forbidden=['OPENAI_API_KEY','DEEPSEEK_API_KEY','QQBOT_SECRET','ONEBOT_ACCESS_TOKEN','SSH_AUTH_SOCK','HOME','NODE_OPTIONS'];
  const original=Object.fromEntries(forbidden.map(k=>[k,process.env[k]]));
  try {
    for(const k of forbidden)process.env[k]='dummy';
    report.tests.childEnvironment={inheritedForbiddenKeys:forbidden.filter(k=>k in childEnvironment(root))};
  }finally{for(const k of forbidden)original[k]===undefined?delete process.env[k]:process.env[k]=original[k];}
  console.log(JSON.stringify(report,null,2));
  const out=makeDir(root,'runtime/logs');
  fs.writeFileSync(path.join(out,'sandbox-diagnosis.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
}finally {
  fs.rmSync(cwd,{recursive:true,force:true});
  fs.rmSync(path.join(root,'runtime/tmp/codex-'+id),{recursive:true,force:true});
}
