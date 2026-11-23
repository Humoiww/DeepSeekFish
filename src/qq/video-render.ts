import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {ProviderError} from '../diagnostics.js';
import {MAX_IMAGE_BYTES} from '../image/limits.js';
import {makeDir,safePath} from '../paths.js';
import type {Store} from '../storage/db.js';
import {FishError,type Message} from '../types.js';
import {findVideoFile,videoDirectory} from './file-library.js';
import type {VideoPlan} from './video-plan.js';

const worker=fileURLToPath(new URL('./video-render-worker.js',import.meta.url));
async function render(plan:VideoPlan,target:string,signal:AbortSignal){
 signal.throwIfAborted();
 const env:NodeJS.ProcessEnv={UV_THREADPOOL_SIZE:'1',MALLOC_ARENA_MAX:'2'};
 for(const key of ['PATH','SystemRoot','WINDIR','LANG','LC_ALL','TMPDIR','TMP','TEMP','XDG_CACHE_HOME']){
  if(process.env[key])env[key]=process.env[key];
 }
 const child=spawn(process.execPath,['--max-old-space-size=64',worker],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
 let failure:unknown,stderr='',bytes=0;
 const stop=(error:unknown)=>{failure??=error;child.kill('SIGKILL');};
 const abort=()=>stop(signal.reason);
 const timeout=setTimeout(()=>stop(new FishError('QQ_VIDEO_RENDER_TIMEOUT')),30000);
 const exited=new Promise<number|null>(resolve=>child.once('close',resolve));
 child.on('error',stop);
 child.stdin.on('error',()=>{});
 child.stderr.setEncoding('utf8').on('data',part=>{stderr=(stderr+part).slice(-2000);});
 signal.addEventListener('abort',abort,{once:true});
 const bound=new Transform({transform(chunk:Buffer,_encoding,done){
  bytes+=chunk.length;
  if(bytes>MAX_IMAGE_BYTES)done(new FishError('QQ_FILE_TOO_LARGE'));
  else done(null,chunk);
 }});
 const written=pipeline(child.stdout,bound,fs.createWriteStream(target,{mode:0o600,flags:'wx'})).catch(stop);
 child.stdin.end(JSON.stringify(plan));
 try{
  const [code]=await Promise.all([exited,written]);
  if(failure)throw failure;
  if(code!==0||!bytes)throw new ProviderError('QQ_VIDEO_RENDER_FAILED',{exitCode:code,stderr});
  return bytes;
 }finally{
  clearTimeout(timeout);
  signal.removeEventListener('abort',abort);
 }
}

/** One renderer per QQ process keeps native memory bounded. A failed render
 * releases its place in the queue, and a completed request reuses its file. */
export class QQVideoRenderer {
 private queue=Promise.resolve();
 constructor(private root:string,private store:Store){}
 create(message:Message,plan:VideoPlan,signal:AbortSignal){
  const id='video-'+createHash('sha256').update(JSON.stringify([message.group,message.id,plan])).digest('hex');
  const job=this.queue.then(async()=>{
   signal.throwIfAborted();
   const existing=findVideoFile(this.root,this.store,message.group,id);
   if(existing)return existing;
   makeDir(this.root,videoDirectory);
   const target=safePath(this.root,videoDirectory+'/'+id+'.mp4');
   const temp=safePath(this.root,videoDirectory+'/'+randomUUID()+'.tmp');
   try{
    const bytes=await render(plan,temp,signal);
    signal.throwIfAborted();
    return this.store.transaction(()=>{
     const existing=findVideoFile(this.root,this.store,message.group,id);
     if(existing)return existing;
     fs.renameSync(temp,target);
     this.store.db.prepare('INSERT INTO qq_generated_videos VALUES (?,?,?,?,?)')
      .run(id,message.group,plan.durationSeconds,bytes,Date.now());
     const file=findVideoFile(this.root,this.store,message.group,id);
     if(!file)throw new FishError('FILE_NOT_AVAILABLE');
     return file;
    });
   }finally{fs.rmSync(temp,{force:true});}
  });
  this.queue=job.then(()=>{},()=>{});
  return job;
 }
}
