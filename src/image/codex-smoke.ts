import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeDir, safePath, writePrivate } from '../paths.js';
import { loadConfig,type Config } from '../config.js';
import { FishError, codeOf } from '../types.js';
import { Store } from '../storage/db.js';
import { Ledger } from '../budget/ledger.js';
import { AppServerRunner, type CodexImageItem,type CodexRunResult } from '../codex/runner.js';
import { collectArtifacts, type Artifact } from '../codex/artifacts.js';
import { verifyPng,MockImageProvider } from './provider.js';
import { prepareCharacterPortrait,verifyCharacterReference,type CharacterReference } from './character-reference.js';
import { CodexRateLimitError } from '../codex/rate-limit.js';
import { readCodexRecord,saveCodexRecord,type CodexRecord } from '../codex/diagnostics.js';

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

export interface ImageSmokeReport {ok:boolean;id:string;source:'codex-app-server'|'mock';error?:string;retryAt?:number;nativeImageCompletions?:number;manifest?:Artifact[];outputDir?:string;elapsedMs:number;diagnostic?:CodexRecord}
export function publishCodexImage(root:string,id:string,maxBytes:number):Artifact[]{
  if(!/^[a-z0-9-]{1,64}$/.test(id))throw new FishError('INVALID_TASK_ID');
  const cwd=safePath(root,'runtime/workspace/'+id);
  verifyPng(cwd,'image.png',maxBytes);
  // Native Codex can create empty .git/.codex/.agents/.aws protection directories.
  // collectArtifacts ignores empty directories, rejects links, and validates the
  // whole file set before publishing. image.png consumes the only file allowance.
  return collectArtifacts(root,id,1,maxBytes);
}
export interface ImageRunner {generateImage(cwd:string,prompt:string,signal:AbortSignal,referencePath?:string):Promise<CodexRunResult>}
export interface ImageJobOptions {cfg:Config;ledger:Ledger;group:string;signal:AbortSignal;mock?:boolean;character?:boolean;runner?:ImageRunner}

/** Cheap preflight, repeated atomically at dispatch. Does not enable any global switch. */
export function checkImageCapacity(root:string,cfg:Config,ledger:Ledger,mock=false):void{
  if(ledger.store.getMeta('budgetFault'))throw new FishError('BUDGET_USAGE_FAULT');
  if(!mock&&!fs.existsSync(safePath(root,'runtime/codex-home/auth.json')))throw new FishError('CODEX_PROJECT_LOGIN_REQUIRED');
  if(ledger.value('image')>=cfg.imageDaily)throw new FishError('IMAGE_BUDGET_EXHAUSTED');
  if(ledger.value('codex')>=cfg.codexDaily)throw new FishError('CODEX_BUDGET_EXHAUSTED');
  if(ledger.value('codexMs')+cfg.codexTimeoutMs>cfg.codexDailyMs)throw new FishError('CODEX_TIME_BUDGET');
  if(ledger.store.db.prepare("SELECT id FROM reservations WHERE kind='codex' AND state='held'").get())throw new FishError('CODEX_BUSY');
}

/** Trusted caller supplies a single human image request; never expose this as a
 * general model tool. Same capture, isolation and live quota as the CLI. */
export async function runCodexImage(root:string,prompt:string,options:ImageJobOptions):Promise<ImageSmokeReport>{
  if(!prompt.trim()||prompt.length>7000)throw new FishError('CODEX_IMAGE_PROMPT_LIMIT');
  const {cfg,ledger,group,mock=false}=options,id=randomUUID(),started=Date.now();
  const report:ImageSmokeReport={ok:false,id,source:mock?'mock':'codex-app-server',elapsedMs:0};
  let reservation:{codex:string;image:string}|undefined,stopUnconfirmed=false,reference:CharacterReference|undefined;
  const signal=AbortSignal.any([options.signal,AbortSignal.timeout(cfg.codexTimeoutMs)]);
  try{
    signal.throwIfAborted();checkImageCapacity(root,cfg,ledger,mock);
    const cwd=makeDir(root,'runtime/workspace/'+id);
    const prepared=prepareCharacterPortrait(root,cwd,prompt,options.character);reference=prepared.reference;
    reservation=ledger.reserveImageJob(group,'local-human',cfg.codexTimeoutMs);
    if(mock){
      await new MockImageProvider().generate('offline fixture only',cwd);
      fs.renameSync(safePath(cwd,'mock.png'),safePath(cwd,'image.png'));
    }else{
      const result=await (options.runner??new AppServerRunner(root)).generateImage(cwd,prepared.prompt,signal,reference?.path);
      signal.throwIfAborted();report.nativeImageCompletions=result.images.length;
      captureCodexImage(root,cwd,result.images,cfg.maxArtifactBytes);
      if(reference)verifyCharacterReference(result.images,reference);
    }
    signal.throwIfAborted();
    if(reference){fs.rmSync(reference.path,{force:true});reference=undefined;}
    report.manifest=publishCodexImage(root,id,cfg.maxArtifactBytes);
    report.outputDir=safePath(root,'runtime/outputs/'+id);report.ok=true;
  }catch(e){
    stopUnconfirmed=codeOf(e)==='CODEX_PROCESS_NOT_TERMINATED';
    report.error=signal.aborted?'CODEX_IMAGE_CANCELLED_OR_TIMED_OUT':codeOf(e);
    if(e instanceof CodexRateLimitError)report.retryAt=e.retryAt;
    if(reservation)ledger.error();
  }finally{
    if(reference&&!stopUnconfirmed)fs.rmSync(reference.path,{force:true});
    if(reservation){
      if(!stopUnconfirmed)ledger.settle(reservation.codex,undefined,Date.now()-started);
      ledger.settle(reservation.image);
    }
    report.elapsedMs=Date.now()-started;
    const diagnostic=readCodexRecord(root,id);
    if(diagnostic){diagnostic.delivery={ok:report.ok,error:report.error,nativeImageCompletions:report.nativeImageCompletions};saveCodexRecord(root,diagnostic);report.diagnostic=diagnostic;}
  }
  return report;
}
export async function codexImageSmoke(root:string,prompt:string,reviewed:boolean):Promise<ImageSmokeReport>{
  if(!reviewed)throw new FishError('CODEX_IMAGE_LOCAL_REVIEW_REQUIRED');
  if(!prompt.trim()||prompt.length>2000)throw new FishError('CODEX_IMAGE_PROMPT_LIMIT');
  const store=new Store(root),cfg=loadConfig(root),ledger=new Ledger(store,()=>cfg),controller=new AbortController();
  const cancelled=()=>controller.abort();process.once('SIGINT',cancelled);process.once('SIGTERM',cancelled);
  try{
    const report=await runCodexImage(root,prompt,{cfg,ledger,group:'local-cli',signal:controller.signal});
    writePrivate(root,'runtime/logs/codex-image-last.json',JSON.stringify(report,null,2)+'\n');return report;
  }finally{process.removeListener('SIGINT',cancelled);process.removeListener('SIGTERM',cancelled);store.close();}
}
