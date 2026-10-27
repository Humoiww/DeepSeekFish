import fs from 'node:fs';
import path from 'node:path';
import { safePath, writePrivate } from '../paths.js';
import { FishError } from '../types.js';
import { RpcProcess, type ProcessSpec } from './process.js';

export interface TaskRunner { run(cwd:string,brief:string,signal:AbortSignal):Promise<string> }
export function childEnvironment(root:string):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const k of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL'])if(process.env[k])env[k]=process.env[k];
  env.CODEX_HOME=safePath(root,'runtime/codex-home');
  env.TMP=env.TEMP=env.TMPDIR=safePath(root,'runtime/tmp');
  env.XDG_CACHE_HOME=safePath(root,'runtime/cache');
  env.NO_COLOR='1';env.CODEX_DISABLE_UPDATE_CHECK='1';
  return env;
}
export function codexEntry(root:string):string{return safePath(root,'node_modules/@openai/codex/bin/codex.js');}
export const PERMISSION_PROFILE='deepseekfish-restricted-v1';
export function permissionArgs(cwd:string):string[]{
  // Actual 0.164.0 schema exposes named profiles as experimental fields.
  // Its legacy workspaceWrite schema has NO readOnlyAccess field, despite
  // documentation examples. Never send that silently ignored field.
  return ['-c',`default_permissions="${PERMISSION_PROFILE}"`,
    '-c',`permissions.${PERMISSION_PROFILE}.filesystem={":root"="deny",":minimal"="read",${JSON.stringify(cwd)}="write"}`,
    '-c',`permissions.${PERMISSION_PROFILE}.network.enabled=false`];
}
export class AppServerRunner implements TaskRunner {
  constructor(private root:string){}
  async run(cwd:string,brief:string,signal:AbortSignal):Promise<string>{
    // Linux/macOS are intentionally not silently enabled: target Windows
    // boundary has its own native job owner and mandatory MXC selection.
    if(process.platform!=='win32')throw new FishError('CODEX_WINDOWS_REQUIRED');
    if(!fs.existsSync(safePath(this.root,'runtime/codex-home/auth.json')))throw new FishError('CODEX_PROJECT_LOGIN_REQUIRED');
    const command=[process.execPath,codexEntry(this.root),'app-server','--listen','stdio://',
      '-c','windows.sandbox="mxc"','-c','approval_policy="never"',...permissionArgs(cwd),
      '-c','cli_auth_credentials_store="file"','-c','web_search="disabled"','-c','mcp_servers={}',
      '-c','features.multi_agent=false','-c','features.apps=false','-c','features.hooks=false','-c','features.image_generation=false',
      '-c','features.plugins=false','-c','features.remote_plugin=false','-c','features.computer_use=false','-c','features.browser_use=false',
      '-c','features.skill_mcp_dependency_install=false','-c','features.workspace_dependencies=false'];
    const quote=(s:string)=>'"'+s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
    const line=command.map(quote).join(' ');
    const spec:ProcessSpec={command:path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
      args:['-NoProfile','-NonInteractive','-File',safePath(this.root,'scripts/windows-job.ps1'),'-OwnerPid',String(process.pid),'-CommandBase64',Buffer.from(line,'utf16le').toString('base64')],
      cwd,env:childEnvironment(this.root)};
    const rpc=new RpcProcess(spec,signal);
    try{
      await rpc.call('initialize',{clientInfo:{name:'deepseekfish',title:'DeepSeekFish',version:'0.1.0'},capabilities:{experimentalApi:true}});
      rpc.notify('initialized');
      const account=await rpc.call('account/read',{refreshToken:false});
      if(account.account?.type!=='chatgpt')throw new FishError('CODEX_CHATGPT_PROJECT_LOGIN_REQUIRED');
      const profiles=await rpc.call('permissionProfile/list',{cwd});
      if(!profiles.data?.some((p:any)=>p.id===PERMISSION_PROFILE&&p.allowed===true))throw new FishError('CODEX_RESTRICTED_PROFILE_UNAVAILABLE');
      // Confirm the effective sandbox can deny an existing OUTSIDE-workspace
      // canary before any model turn. This is evidence, not a general proof.
      const canaryRel='runtime/data/canary-'+path.basename(cwd)+'.txt';
      writePrivate(this.root,canaryRel,'DeepSeekFish outside-workspace canary');
      const canary=safePath(this.root,canaryRel);
      try{
        const probe=await rpc.call('command/exec',{command:['cmd.exe','/d','/c','type',canary],cwd,permissionProfile:PERMISSION_PROFILE,timeoutMs:5000});
        if(probe.exitCode===0||String(probe.stdout).includes('DeepSeekFish outside-workspace canary'))throw new FishError('CODEX_READ_ISOLATION_FAILED');
        const denied=safePath(this.root,'runtime/data/write-probe-'+path.basename(cwd)+'.txt');
        const write=await rpc.call('command/exec',{command:['cmd.exe','/d','/c',`echo forbidden > "${denied}"`],cwd,permissionProfile:PERMISSION_PROFILE,timeoutMs:5000});
        if(write.exitCode===0||fs.existsSync(denied)){if(fs.existsSync(denied))fs.unlinkSync(denied);throw new FishError('CODEX_WRITE_ISOLATION_FAILED');}
      }finally{fs.unlinkSync(canary);}
      const threadResult=await rpc.call('thread/start',{cwd,ephemeral:true,approvalPolicy:'never',permissions:PERMISSION_PROFILE,
        config:{web_search:'disabled',mcp_servers:{},features:{multi_agent:false,apps:false,hooks:false,image_generation:false,plugins:false,remote_plugin:false,computer_use:false,browser_use:false,skill_mcp_dependency_install:false,workspace_dependencies:false}}});
      if(threadResult.activePermissionProfile?.id!==PERMISSION_PROFILE)throw new FishError('CODEX_EFFECTIVE_PROFILE_MISMATCH');
      const {thread}=threadResult;
      if(!thread?.id)throw new FishError('CODEX_INVALID_THREAD');
      let final='',fallback='';let turnId:string|undefined;
      const done=new Promise<string>((resolve,reject)=>{
        const failure=(e:Error)=>reject(e);
        rpc.on('failure',failure);
        rpc.on('notice',(method:string,p:any)=>{
          if(p?.threadId!==thread.id)return;
          if(method==='turn/started')turnId=p.turn?.id;
          if(method==='item/completed'&&p.item?.type==='agentMessage'){
            const text=String(p.item.text??'').slice(0,12000);
            if(p.item.phase==='final_answer')final=text;
            else if(p.item.phase==null||p.item.phase==='partial_answer')fallback=text;
          }
          if(method==='turn/completed'&&(!turnId||p.turn?.id===turnId)){
            if(p.turn?.status!=='completed')reject(new FishError('CODEX_TURN_FAILED'));
            else if(!(final||fallback).trim())reject(new FishError('CODEX_EMPTY_RESULT'));
            else resolve(final||fallback);
          }
        });
      });
      // Observe a rejection even if turn/start itself fails first.
      void done.catch(()=>{});
      await rpc.call('turn/start',{threadId:thread.id,cwd,approvalPolicy:'never',permissions:PERMISSION_PROFILE,
        input:[{type:'text',text:'只处理以下有限任务。仅在当前目录创建产物；不访问私人文件、凭据、网络或其他项目。\n'+brief}]});
      return await done;
    }finally{await rpc.stop();}
  }
}
export class MockTaskRunner implements TaskRunner {
  constructor(private delayMs=10){}
  async run(cwd:string,brief:string,signal:AbortSignal):Promise<string>{
    await new Promise<void>((resolve,reject)=>{
      signal.throwIfAborted();
      const aborted=()=>{clearTimeout(timer);reject(new FishError('CODEX_ABORTED'));};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve();},this.delayMs);
      signal.addEventListener('abort',aborted,{once:true});
    });
    signal.throwIfAborted();fs.writeFileSync(safePath(cwd,'result.txt'),'Mock Codex artifact\n'+brief,{flag:'wx'});
    return '【Mock】生成 result.txt';
  }
}
