// Inspect the pinned official binary with the project's environment and zero model turns.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot,prepare } from '../dist/src/config.js';
import { codexEntry,childEnvironment,permissionArgs,PERMISSION_PROFILE } from '../dist/src/codex/runner.js';
import { RpcProcess } from '../dist/src/codex/process.js';
const root=projectRoot();prepare(root);
const cwd=path.join(root,'runtime/workspace'),env=childEnvironment(root),entry=codexEntry(root);
const out=fs.mkdtempSync(path.join(root,'runtime/cache/codex-schema-'));
const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const expected=readJson(path.join(root,'package.json')).dependencies['@openai/codex'];
const runCli=(...args)=>execFileSync(process.execPath,[entry,...args],{cwd,env,encoding:'utf8',timeout:60000}).trim();
const cliVersion=runCli('--version');
if(cliVersion!==`codex-cli ${expected}`)throw new Error('CODEX_PINNED_VERSION_MISMATCH');
const features=new Set(runCli('features','list').split(/\r?\n/).map(line=>line.trim().split(/\s+/,1)[0]));
if(!features.has('image_generation')||!features.has('image_generation_animation'))throw new Error('CODEX_IMAGE_FEATURE_MISSING');
runCli('app-server','generate-json-schema','--experimental','--out',out);
const turn=readJson(path.join(out,'v2/TurnStartParams.json'));
const completed=readJson(path.join(out,'v2/ItemCompletedNotification.json'));
const localImage=turn.definitions.UserInput.oneOf.find(item=>item.properties?.type?.enum?.includes('localImage'));
const image=completed.definitions.ThreadItem.oneOf.find(item=>item.properties?.type?.enum?.includes('imageGeneration'));
const inputImage=completed.definitions.ImageGenerationInputImage;
if(!localImage?.required?.includes('path')||!image?.required?.includes('status')||
   !image?.properties?.savedPath||!image?.properties?.inputImages||!image?.properties?.failure||
   !['fileId','result'].every(key=>image.anyOf?.some(variant=>variant.required?.includes(key)))||
   !['path','sha256'].every(key=>inputImage?.required?.includes(key)))throw new Error('CODEX_IMAGE_PROTOCOL_MISMATCH');
const abort=new AbortController();const deadline=setTimeout(()=>abort.abort(),10000);
const rpc=new RpcProcess({command:process.execPath,args:[entry,'app-server','--listen','stdio://',...permissionArgs(cwd)],cwd,env},abort.signal);
try{
  const init=await rpc.call('initialize',{clientInfo:{name:'deepseekfish-protocol-check',version:'0.1.0'},capabilities:{experimentalApi:true}});rpc.notify('initialized');
  const account=await rpc.call('account/read',{refreshToken:false});
  const profiles=await rpc.call('permissionProfile/list',{cwd});
  if(!profiles.data.some(p=>p.id===PERMISSION_PROFILE&&p.allowed))throw new Error('PROFILE_NOT_AVAILABLE');
  console.log(JSON.stringify({cliVersion,protocol:'initialize/initialized/account/read/permissionProfile/list',server:init.userAgent,profile:PERMISSION_PROFILE,projectAccountPresent:!!account.account,imageProtocol:true,schemaDirectory:out,modelTurns:0}));
}finally{clearTimeout(deadline);await rpc.stop();}
