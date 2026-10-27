import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeDir, safePath, writePrivate } from '../paths.js';
import { loadConfig } from '../config.js';
import { FishError, codeOf } from '../types.js';
import { Store } from '../storage/db.js';
import { Ledger } from '../budget/ledger.js';
import { AppServerRunner, type CodexImageItem } from '../codex/runner.js';
import { collectArtifacts, type Artifact } from '../codex/artifacts.js';
import { verifyPng } from './provider.js';

/** Accept only a native imageGeneration completion, never an agent's claimed path.
 * CODEX_HOME/generated_images is a trusted harness output, not model filesystem access. */
export function captureCodexImage(root:string,cwd:string,images:CodexImageItem[],maxBytes:number):string{
  if(images.length!==1)throw new FishError('CODEX_IMAGE_UNSUPPORTED_OR_MISSING');
  const item=images[0];
  if(item.failure||item.status!=='completed')throw new FishError('CODEX_IMAGE_GENERATION_FAILED');
  const target=safePath(cwd,'image.png');
  let created=false;
  try{
    if(item.savedPath){
      const generated=makeDir(root,'runtime/codex-home/generated_images');
      const base=path.resolve(item.savedPath).startsWith(generated+path.sep)?generated:cwd;
      const relative=path.relative(base,path.resolve(item.savedPath)).split(path.sep).join('/');
      const source=safePath(base,relative);
      if(path.extname(source).toLowerCase()!=='.png')throw new FishError('CODEX_IMAGE_NOT_PNG');
      verifyPng(base,relative,maxBytes);
      if(source!==target){fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);created=true;}
    }else if(item.result){
      const base64=item.result.replace(/^data:image\/png;base64,/, '');
      if(base64.length>Math.ceil(maxBytes/3)*4||!base64.length||base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw new FishError('CODEX_IMAGE_INVALID_DATA');
      fs.writeFileSync(target,Buffer.from(base64,'base64'),{flag:'wx',mode:0o600});
      created=true;
    }else throw new FishError('CODEX_IMAGE_ATTACHMENT_UNAVAILABLE');
    return verifyPng(cwd,'image.png',maxBytes);
  }catch(e){
    // This generated task directory belongs exclusively to this attempt.
    if(created)fs.rmSync(target,{force:true});
    throw e;
  }
}

export interface ImageSmokeReport {ok:boolean;id:string;source:'codex-app-server';error?:string;nativeImageCompletions?:number;manifest?:Artifact[];outputDir?:string;elapsedMs:number}
export function publishCodexImage(root:string,id:string,maxBytes:number):Artifact[]{
  if(!/^[a-z0-9-]{1,64}$/.test(id))throw new FishError('INVALID_TASK_ID');
  const cwd=safePath(root,'runtime/workspace/'+id);
  verifyPng(cwd,'image.png',maxBytes);
  // Native Codex can create empty .git/.codex/.agents/.aws protection directories.
  // collectArtifacts ignores empty directories, rejects links, and validates the
  // whole file set before publishing. image.png consumes the only file allowance.
  return collectArtifacts(root,id,1,maxBytes);
}
export async function codexImageSmoke(root:string,prompt:string,reviewed:boolean):Promise<ImageSmokeReport>{
  if(!reviewed)throw new FishError('CODEX_IMAGE_LOCAL_REVIEW_REQUIRED');
  if(!prompt.trim()||prompt.length>2000)throw new FishError('CODEX_IMAGE_PROMPT_LIMIT');
  const id=randomUUID(),started=Date.now();
  const report:ImageSmokeReport={ok:false,id,source:'codex-app-server',elapsedMs:0};
  let store:Store|undefined,ledger:Ledger|undefined,codexReservation:string|undefined,imageReservation:string|undefined;
  let stopUnconfirmed=false;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const cancelled=()=>controller.abort();
  process.once('SIGINT',cancelled);process.once('SIGTERM',cancelled);
  try{
    if(!fs.existsSync(safePath(root,'runtime/codex-home/auth.json')))throw new FishError('CODEX_PROJECT_LOGIN_REQUIRED');
    const cfg=loadConfig(root),cwd=makeDir(root,'runtime/workspace/'+id);
    store=new Store(root);ledger=new Ledger(store,()=>cfg);
    // Same live ledger as QQ: no hidden second allowance for the smoke test.
    codexReservation=ledger.reserve('codex','local-cli','local-human',0,0,cfg.codexTimeoutMs);
    imageReservation=ledger.reserve('image','local-cli','local-human');
    timer=setTimeout(cancelled,cfg.codexTimeoutMs);
    const result=await new AppServerRunner(root).generateImage(cwd,prompt,controller.signal);
    controller.signal.throwIfAborted();
    report.nativeImageCompletions=result.images.length;
    captureCodexImage(root,cwd,result.images,cfg.maxArtifactBytes);
    // App-server has already stopped. Publish precisely one verified image.
    const manifest=publishCodexImage(root,id,cfg.maxArtifactBytes);
    report.ok=true;report.manifest=manifest;report.outputDir=safePath(root,'runtime/outputs/'+id);
  }catch(e){
    stopUnconfirmed=codeOf(e)==='CODEX_PROCESS_NOT_TERMINATED';
    report.error=controller.signal.aborted?'CODEX_IMAGE_CANCELLED_OR_TIMED_OUT':codeOf(e);
    if(ledger)ledger.error();
  }finally{
    if(timer)clearTimeout(timer);
    process.removeListener('SIGINT',cancelled);process.removeListener('SIGTERM',cancelled);
    if(codexReservation&&!stopUnconfirmed)ledger!.settle(codexReservation,undefined,Date.now()-started);
    if(imageReservation)ledger!.settle(imageReservation);
    store?.close();report.elapsedMs=Date.now()-started;
    // No prompt, account details, raw protocol, image base64 or credentials in logs.
    writePrivate(root,'runtime/logs/codex-image-last.json',JSON.stringify(report,null,2)+'\n');
  }
  return report;
}
