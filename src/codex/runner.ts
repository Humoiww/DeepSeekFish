import {validateGif,type GifOptions} from '../image/options.js';
import fs from 'node:fs';
import path from 'node:path';
import { safePath } from '../paths.js';
import { FishError,codeOf } from '../types.js';
import { RpcProcess } from './process.js';
import { appServerSpec,executionFeatures,PERMISSION_PROFILE,taskDirectory } from './platform.js';
import { initialize,probeIsolation } from './probe.js';
import { verifyPng } from '../image/provider.js';
import { rateLimitFailure } from './rate-limit.js';
import { CodexDiagnostics } from './diagnostics.js';
import { readReference } from '../image/references.js';
export { childEnvironment,codexEntry,permissionArgs,PERMISSION_PROFILE } from './platform.js';

export interface TaskRunner { run(cwd:string,brief:string,signal:AbortSignal):Promise<string> }
export interface CodexImageItem {id:string;type:'imageGeneration';status:string;savedPath?:string|null;result?:string;fileId?:string;failure?:unknown;inputImages?:{path:string;sha256:string}[]}
export interface CodexRunResult {text:string;images:CodexImageItem[]}
export class AppServerRunner implements TaskRunner {
  constructor(private root:string){}
  async run(cwd:string,brief:string,signal:AbortSignal):Promise<string>{
    if(process.env.FISH_CODEX_IMAGE_ONLY==='1')throw new FishError('CODEX_IMAGE_ONLY');
    return (await this.execute(cwd,brief,signal,false)).text;
  }
  async generateImage(cwd:string,prompt:string,signal:AbortSignal,referencePath?:string,additionalReferences:string[]=[],gif?:GifOptions):Promise<CodexRunResult>{
    return this.execute(cwd,prompt,signal,true,referencePath,additionalReferences,gif);
  }
  private async execute(cwd:string,brief:string,signal:AbortSignal,imageGeneration:boolean,referencePath?:string,additionalReferences:string[]=[],gif?:GifOptions):Promise<CodexRunResult>{
    if(!['linux','win32'].includes(process.platform))throw new FishError('CODEX_PLATFORM_UNSUPPORTED');
    if(gif!==undefined)gif=validateGif(gif);
    cwd=taskDirectory(this.root,cwd);
    const diagnostic=new CodexDiagnostics(this.root,path.basename(cwd),brief,imageGeneration,referencePath);
    diagnostic.record.request.gif=gif;
    diagnostic.record.request.referencePaths=[...(referencePath?[referencePath]:[]),...additionalReferences];
    let processRpc:RpcProcess|undefined,final='',fallback='',failureCode:string|undefined,nativeGifDenied=false,stderrTail='';
    try{
    if(referencePath){
      if(referencePath!==safePath(cwd,'character-reference.png'))throw new FishError('CODEX_IMAGE_REFERENCE_INVALID');
      verifyPng(cwd,'character-reference.png',10485760);
    }
    if(additionalReferences.length>3)throw new FishError('CODEX_IMAGE_REFERENCE_INVALID');
    for(const file of additionalReferences){
      const relative=path.relative(cwd,file);
      if(!/^selected-reference-[1-3]\.(?:png|jpg|gif|webp)$/.test(relative)||file!==safePath(cwd,relative))throw new FishError('CODEX_IMAGE_REFERENCE_INVALID');
      readReference(cwd,relative);
    }
    if(!fs.existsSync(safePath(this.root,'runtime/codex-home/auth.json')))throw new FishError('CODEX_PROJECT_LOGIN_REQUIRED');
    const features=executionFeatures(imageGeneration),images:CodexImageItem[]=[],seenImages=new Set<string>();
    const rpc=new RpcProcess(appServerSpec(this.root,cwd,process.platform,imageGeneration),signal);
    processRpc=rpc;
    rpc.on('notice',(method:string,p:any)=>diagnostic.notice(method,p));
    rpc.on('serverRequest',p=>diagnostic.event('server-request',p));
    rpc.on('rpcError',p=>diagnostic.event('rpc-error',p));
    rpc.on('stderr',text=>{diagnostic.stderr(text);stderrTail=(stderrTail+text).slice(-8192);if(/image generation failed: http 400.*GIF output is not enabled for this request\./.test(stderrTail))nativeGifDenied=true;});
      diagnostic.event('app-server-started');
      await initialize(rpc,cwd);
      const account=await rpc.call('account/read',{refreshToken:false});
      if(account.account?.type!=='chatgpt')throw new FishError('CODEX_CHATGPT_PROJECT_LOGIN_REQUIRED');
      await probeIsolation(rpc,this.root,cwd);
      diagnostic.event('sandbox-probe-passed');
      diagnostic.event('thread-requested',{permissions:PERMISSION_PROFILE,features});
      const threadResult=await rpc.call('thread/start',{cwd,ephemeral:true,approvalPolicy:'never',permissions:PERMISSION_PROFILE,
        config:{web_search:'disabled',mcp_servers:{},features},
        ...(imageGeneration?{developerInstructions:'This is one locally authorized single-image request. Use only the built-in image generation tool, exactly once, generating one PNG or animated GIF as requested. No shell tools, external APIs, paid API keys, MCP, code-drawn images, or substitute images. If the built-in tool is unavailable, report unsupported. Do not retry or edit. The harness will collect the generated image; do not move files or read credentials.'}: {})});
      diagnostic.record.threadId=threadResult.thread?.id;diagnostic.record.model=threadResult.model;
      if(threadResult.activePermissionProfile?.id!==PERMISSION_PROFILE)throw new FishError('CODEX_EFFECTIVE_PROFILE_MISMATCH');
      const {thread}=threadResult;
      if(!thread?.id)throw new FishError('CODEX_INVALID_THREAD');
      let turnId:string|undefined;
      const done=new Promise<CodexRunResult>((resolve,reject)=>{
        const failure=(e:Error)=>reject(e);
        rpc.on('failure',failure);
        rpc.on('notice',(method:string,p:any)=>{
          if(p?.threadId!==thread.id)return;
          const limited=rateLimitFailure(p?.error??p?.turn?.error??p?.item?.failure);
          if(limited){reject(limited);void rpc.stop().catch(()=>{});return;}
          if(method==='turn/started')turnId=p.turn?.id;
          if(imageGeneration&&['item/started','item/completed'].includes(method)&&p.item?.type==='imageGeneration'){
            seenImages.add(p.item.id);
            if(seenImages.size>1){reject(new FishError('CODEX_IMAGE_SINGLE_CALL_LIMIT'));void rpc.stop();return;}
            if(method==='item/completed'&&!images.some(item=>item.id===p.item.id))images.push(p.item);
          }
          if(method==='item/completed'&&p.item?.type==='agentMessage'){
            const text=String(p.item.text??'').slice(0,12000);
            if(p.item.phase==='final_answer')final=text;
            else if(p.item.phase==null||p.item.phase==='partial_answer')fallback=text;
          }
          if(method==='turn/completed'&&(!turnId||p.turn?.id===turnId)){
            if(p.turn?.status!=='completed')reject(new FishError('CODEX_TURN_FAILED'));
            else if(!imageGeneration&&!(final||fallback).trim())reject(new FishError('CODEX_EMPTY_RESULT'));
            else resolve({text:final||fallback,images});
          }
        });
      });
      // Observe a rejection even if turn/start itself fails first.
      void done.catch(()=>{});
      diagnostic.event('turn-requested',{referenceAttached:!!referencePath||!!additionalReferences.length,referenceCount:Number(!!referencePath)+additionalReferences.length});
      await rpc.call('turn/start',{threadId:thread.id,cwd,approvalPolicy:'never',permissions:PERMISSION_PROFILE,
        input:[{type:'text',text:imageGeneration?
          'Use your built-in image generation tool to generate exactly one image for this prompt, PNG or animated GIF as requested. Do not call any separate Image API or create a replacement with code. No retries.\n'+(gif!==undefined?'Use the native image_gen.imagegen gif argument '+JSON.stringify(gif)+'. Return native GIF, not a static sprite sheet.\n':'')+brief:
          '只处理以下有限任务。仅在当前目录创建产物；不访问私人文件、凭据、网络或其他项目。\n'+brief},
          ...[...(referencePath?[referencePath]:[]),...additionalReferences].map(path=>({type:'localImage',path}))]});
      const result=await done;
      if(nativeGifDenied)throw new FishError('CODEX_NATIVE_GIF_NOT_ENABLED');
      return result;
    }catch(e){failureCode=codeOf(e);throw e;}
    finally{try{await processRpc?.stop();}catch(e){failureCode=codeOf(e);throw e;}finally{diagnostic.finish(final||fallback,failureCode);}}
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
