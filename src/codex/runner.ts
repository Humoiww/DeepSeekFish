import fs from 'node:fs';
import { safePath } from '../paths.js';
import { FishError } from '../types.js';
import { RpcProcess } from './process.js';
import { appServerSpec,disabledFeatures,PERMISSION_PROFILE,taskDirectory } from './platform.js';
import { initialize,probeIsolation } from './probe.js';
export { childEnvironment,codexEntry,permissionArgs,PERMISSION_PROFILE } from './platform.js';

export interface TaskRunner { run(cwd:string,brief:string,signal:AbortSignal):Promise<string> }
export class AppServerRunner implements TaskRunner {
  constructor(private root:string){}
  async run(cwd:string,brief:string,signal:AbortSignal):Promise<string>{
    if(!['linux','win32'].includes(process.platform))throw new FishError('CODEX_PLATFORM_UNSUPPORTED');
    cwd=taskDirectory(this.root,cwd);
    if(!fs.existsSync(safePath(this.root,'runtime/codex-home/auth.json')))throw new FishError('CODEX_PROJECT_LOGIN_REQUIRED');
    const rpc=new RpcProcess(appServerSpec(this.root,cwd),signal);
    try{
      await initialize(rpc,cwd);
      const account=await rpc.call('account/read',{refreshToken:false});
      if(account.account?.type!=='chatgpt')throw new FishError('CODEX_CHATGPT_PROJECT_LOGIN_REQUIRED');
      await probeIsolation(rpc,this.root,cwd);
      const threadResult=await rpc.call('thread/start',{cwd,ephemeral:true,approvalPolicy:'never',permissions:PERMISSION_PROFILE,
        config:{web_search:'disabled',mcp_servers:{},features:disabledFeatures}});
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
