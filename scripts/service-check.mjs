// Runs in the service's actual systemd namespace before every start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const root='/srv/deepseekfish/app';
function requireDenied(name,fn){
  try{fn();}catch(e){if(['EACCES','EPERM','EROFS','ENOENT'].includes(e.code))return;throw e;}
  throw Error('SERVICE_BOUNDARY_FAILED: '+name);
}
if(os.userInfo().username!=='deepseekfish')throw Error('SERVICE_ACCOUNT_REQUIRED');
for(const p of [root,path.join(root,'runtime'),path.join(root,'dist/src/cli.js'),process.execPath]) {
  if(fs.statSync(p).uid!==0)throw Error('ROOT_OWNED_RELEASE_REQUIRED: '+p);
  requireDenied('release-write',()=>fs.accessSync(p,fs.constants.W_OK));
}
requireDenied('management-home',()=>fs.accessSync('/home',fs.constants.R_OK));
for(const key of ['OPENAI_API_KEY','DEEPSEEK_API_KEY','QQBOT_SECRET','SSH_AUTH_SOCK','CODEX_HOME'])if(process.env[key])throw Error('UNEXPECTED_CREDENTIAL_ENV: '+key);
if(process.env.FISH_CODEX_IMAGE_ONLY==='1'){
  const home=fs.statSync(path.join(root,'runtime/codex-home'));
  if(home.uid!==process.getuid()||(home.mode&0o077)!==0)throw Error('PRIVATE_CODEX_HOME_REQUIRED');
  const {checkSandbox}=await import('../dist/src/codex/probe.js');
  const result=await checkSandbox(root);
  if(!result.ok)throw Error('SERVICE_SANDBOX_FAILED: '+result.error);
  const {linuxSpec}=await import('../dist/src/codex/platform.js');
  const {makeDir}=await import('../dist/src/paths.js');
  const id='probe-'+randomUUID(),cwd=makeDir(root,'runtime/workspace/'+id);
  try{
    const spec=linuxSpec(root,cwd,[]),separator=spec.args.lastIndexOf('--');
    spec.args.splice(separator+1,1,'/usr/bin/bash','--noprofile','--norc','-c','printf CODEX_BASH_READY');
    const shell=spawnSync(spec.command,spec.args,{cwd,env:spec.env,encoding:'utf8',timeout:5000});
    if(shell.status!==0||shell.stdout!=='CODEX_BASH_READY')throw Error('SERVICE_CODEX_SHELL_BOOTSTRAP_FAILED');
  }finally{fs.rmSync(cwd,{recursive:true,force:true});fs.rmSync(path.join(root,'runtime/tmp/codex-'+id),{recursive:true,force:true});}
  console.log('Service preflight passed: separate UID, immutable release, hidden management home, image-only Codex, full sandbox probe passed.');
}else{
  requireDenied('codex-home-write',()=>fs.accessSync(path.join(root,'runtime/codex-home'),fs.constants.W_OK));
  requireDenied('codex-payload',()=>fs.readdirSync(path.join(root,'node_modules/@openai')));
  if(fs.existsSync(path.join(root,'runtime/codex-home/auth.json')))throw Error('CODEX_LOGIN_NOT_ALLOWED_IN_THIS_SERVICE');
  const shell=spawnSync('/bin/true',[],{timeout:1000});
  if(!['EACCES','EPERM'].includes(shell.error?.code))throw Error('SERVICE_NOEXEC_REQUIRED');
  console.log('Service preflight passed: separate UID, immutable release, management home hidden, Codex payload hidden, shell execution denied.');
}
