// Keyless inspection of the locally pinned official binary; never reads an
// existing user's auth or starts a model turn. All writes remain in runtime/.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { projectRoot,prepare } from '../dist/src/config.js';
import { codexEntry,childEnvironment,permissionArgs,PERMISSION_PROFILE } from '../dist/src/codex/runner.js';
import { RpcProcess } from '../dist/src/codex/process.js';
const root=projectRoot();prepare(root);
const out=root+'/runtime/research/codex-schema';fs.mkdirSync(out,{recursive:true});
const proc=spawn(process.execPath,[codexEntry(root),'app-server','generate-json-schema','--experimental','--out',out],{cwd:root+'/runtime/workspace',env:childEnvironment(root),stdio:'ignore'});
const [exit]=await once(proc,'exit');if(exit!==0)throw new Error('SCHEMA_GENERATION_FAILED');
const abort=new AbortController();const deadline=setTimeout(()=>abort.abort(),10000);
const rpc=new RpcProcess({command:process.execPath,args:[codexEntry(root),'app-server','--listen','stdio://',...permissionArgs(root+'/runtime/workspace')],cwd:root+'/runtime/workspace',env:childEnvironment(root)},abort.signal);
try{
  const init=await rpc.call('initialize',{clientInfo:{name:'deepseekfish-protocol-check',version:'0.1.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
  const account=await rpc.call('account/read',{refreshToken:false});
  const profiles=await rpc.call('permissionProfile/list',{cwd:root+'/runtime/workspace'});
  if(!profiles.data.some(p=>p.id===PERMISSION_PROFILE&&p.allowed))throw new Error('PROFILE_NOT_AVAILABLE');
  console.log(JSON.stringify({protocol:'initialize/initialized/account/read/permissionProfile/list',server:init.userAgent,profile:PERMISSION_PROFILE,projectAccountPresent:!!account.account,schemaDirectory:out,modelTurns:0}));
}finally{clearTimeout(deadline);await rpc.stop();}
