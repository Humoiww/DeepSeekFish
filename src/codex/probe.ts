import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeDir, safePath, writePrivate } from '../paths.js';
import { FishError,codeOf } from '../types.js';
import { RpcProcess } from './process.js';
import { appServerSpec,PERMISSION_PROFILE } from './platform.js';

export async function initialize(rpc:RpcProcess,cwd:string):Promise<void>{
  await rpc.call('initialize',{clientInfo:{name:'deepseekfish',title:'DeepSeekFish',version:'0.1.0'},capabilities:{experimentalApi:true}});
  rpc.notify('initialized');
  const profiles=await rpc.call('permissionProfile/list',{cwd});
  if(!profiles.data?.some((p:any)=>p.id===PERMISSION_PROFILE&&p.allowed===true))throw new FishError('CODEX_RESTRICTED_PROFILE_UNAVAILABLE');
}
export async function probeIsolation(rpc:RpcProcess,root:string,cwd:string):Promise<void>{
  const id=path.basename(cwd),nonce='FISH_'+randomUUID().replaceAll('-','');
  const positive=safePath(cwd,'probe-'+nonce+'.txt');
  // The home canary is visible to app-server, but must remain hidden from model commands.
  const outside=[`runtime/data/canary-${id}.txt`,`runtime/codex-home/canary-${id}.txt`];
  const writes=[`runtime/data/write-probe-${id}.txt`,`runtime/codex-home/write-probe-${id}.txt`];
  const run=(command:string[])=>rpc.call('command/exec',{command,cwd,permissionProfile:PERMISSION_PROFILE,timeoutMs:5000});
  const read=(p:string)=>process.platform==='win32'?['cmd.exe','/d','/c','type',p]:['/bin/cat',p];
  const write=(p:string)=>process.platform==='win32'?['cmd.exe','/d','/c',`echo ${nonce}> "${p}" & type "${p}"`]:
    ['/bin/sh','-c','printf "%s" "$1" > "$2" && cat "$2"','fish-probe',nonce,p];
  try{
    for(const p of outside)writePrivate(root,p,nonce);
    const ok=await run(write(positive));
    if(ok.exitCode!==0||!String(ok.stdout).includes(nonce)||!fs.existsSync(positive))throw new FishError('CODEX_SANDBOX_POSITIVE_CONTROL_FAILED');
    for(const p of outside){
      const denied=await run(read(safePath(root,p)));
      if(!Number.isInteger(denied.exitCode)||denied.exitCode===0||String(denied.stdout).includes(nonce))throw new FishError('CODEX_READ_ISOLATION_FAILED');
    }
    for(const p of writes){
      const denied=await run(write(safePath(root,p)));
      // bubblewrap may allow a new file in a synthetic, private tmpfs parent.
      // Such files are not host writes and disappear with the namespace. The
      // invariant is that no forbidden HOST path is created or modified.
      if(!Number.isInteger(denied.exitCode)||fs.existsSync(safePath(root,p)))throw new FishError('CODEX_WRITE_ISOLATION_FAILED');
    }
  }finally{
    fs.rmSync(positive,{force:true});for(const p of [...outside,...writes])fs.rmSync(safePath(root,p),{force:true});
  }
}
/** Explicit, keyless diagnostic: never creates a thread or starts a model turn. */
export async function checkSandbox(root:string):Promise<{ok:boolean;platform:string;modelTurns:number;error?:string}>{
  const cwd=makeDir(root,'runtime/workspace/probe-'+randomUUID());
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),35000);
  let rpc:RpcProcess|undefined;
  try{
    rpc=new RpcProcess(appServerSpec(root,cwd),abort.signal);
    await initialize(rpc,cwd);await probeIsolation(rpc,root,cwd);
    return {ok:true,platform:process.platform,modelTurns:0};
  }catch(e){return {ok:false,platform:process.platform,modelTurns:0,error:codeOf(e)};}
  finally{
    clearTimeout(timer);await rpc?.stop();
    fs.rmSync(cwd,{recursive:true,force:true});
    fs.rmSync(safePath(root,'runtime/tmp/codex-'+path.basename(cwd)),{recursive:true,force:true});
  }
}
