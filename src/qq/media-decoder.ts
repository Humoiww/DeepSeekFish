import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MAX_IMAGE_BYTES} from '../image/limits.js';
import {imageMime} from '../memory/people.js';
import {FishError} from '../types.js';

export interface DecodedMedia {mime:string;pages:number;width:number;height:number;durationMs:number;frames:{index:number;atMs:number;png:Buffer}[]}
const worker=fileURLToPath(new URL('./media-codec-worker.js',import.meta.url)),MAX_OUTPUT=20*1024*1024;
function launch(){
 const env:NodeJS.ProcessEnv={UV_THREADPOOL_SIZE:'1',MALLOC_ARENA_MAX:'2'};
 for(const key of ['PATH','SystemRoot','WINDIR','PATHEXT','LANG','LC_ALL','TZ','TMPDIR','TMP','TEMP','XDG_CACHE_HOME'])if(process.env[key])env[key]=process.env[key];
 return spawn(process.execPath,['--max-old-space-size=64',worker],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
}
/** One native decoder at a time, bounded queued input and a killable deadline.
 * A hung libvips operation must not occupy the main QQ process's worker pool. */
export class MediaDecoder {
 private active=false;private bytes=0;private jobs:{input:Buffer;resolve:(value:DecodedMedia)=>void;reject:(error:unknown)=>void}[]=[];
 constructor(private timeoutMs=12000,private start:()=>ChildProcessWithoutNullStreams=launch){}
 decode(input:Buffer):Promise<DecodedMedia>{
  if(input.length>MAX_IMAGE_BYTES)return Promise.reject(new FishError('QQ_MEDIA_TOO_LARGE'));
  try{imageMime(input);}catch(e){return Promise.reject(e);}
  if(this.jobs.length+Number(this.active)>=4||this.bytes+input.length>2*MAX_IMAGE_BYTES)return Promise.reject(new FishError('QQ_MEDIA_BUSY'));
  this.bytes+=input.length;
  return new Promise((resolve,reject)=>{this.jobs.push({input,resolve,reject});this.next();});
 }
 private next(){
  if(this.active)return;const job=this.jobs.shift();if(!job)return;this.active=true;
  void this.run(job.input).then(job.resolve,job.reject).finally(()=>{this.bytes-=job.input.length;this.active=false;this.next();});
 }
 private run(input:Buffer):Promise<DecodedMedia>{return new Promise((resolve,reject)=>{
  let child:ChildProcessWithoutNullStreams;try{child=this.start();}catch(e){reject(e);return;}
  const chunks:Buffer[]=[];let size=0,stderr='',failure:Error|undefined;
  const stop=(error:Error)=>{failure??=error;child.kill('SIGKILL');};
  const timeout=setTimeout(()=>stop(new FishError('QQ_MEDIA_DECODE_TIMEOUT')),this.timeoutMs);timeout.unref();
  child.on('error',e=>{failure=e;});child.stdin.on('error',()=>{});
  child.stdout.on('data',(part:Buffer)=>{size+=part.length;if(size>MAX_OUTPUT)stop(new FishError('QQ_MEDIA_PREVIEW_LIMIT'));else chunks.push(part);});
  child.stderr.on('data',(part:Buffer)=>{stderr=(stderr+part.toString()).slice(-512);});
  child.on('close',code=>{
   clearTimeout(timeout);
   if(failure){reject(failure);return;}
   if(code!==0){const known=stderr.trim().split(/\r?\n/).findLast(line=>/^QQ_MEDIA_[A-Z_]+$/.test(line));reject(new FishError(known??'QQ_MEDIA_DECODE_FAILED'));return;}
   try{
    const output=Buffer.concat(chunks);if(output.length<4)throw Error();const length=output.readUInt32BE(0);if(length>16384||length+4>output.length)throw Error();
    const meta=JSON.parse(output.subarray(4,4+length).toString());let offset=4+length;
    if(!['image/png','image/jpeg','image/gif','image/webp'].includes(meta.mime)||![meta.pages,meta.width,meta.height,meta.durationMs].every(Number.isSafeInteger)||meta.pages<1||meta.pages>500||meta.width<1||meta.height<1||meta.width*meta.height>24000000||meta.durationMs<0||!Array.isArray(meta.frames)||meta.frames.length<1||meta.frames.length>4)throw Error();
    const frames=meta.frames.map((f:any)=>{if(!Number.isSafeInteger(f.bytes)||f.bytes<12||offset+f.bytes>output.length||!Number.isSafeInteger(f.index)||f.index<0||f.index>=meta.pages||!Number.isSafeInteger(f.atMs)||f.atMs<0)throw Error();const png=output.subarray(offset,offset+f.bytes);offset+=f.bytes;if(imageMime(png)!=='image/png')throw Error();return {index:f.index,atMs:f.atMs,png};});
    if(offset!==output.length)throw Error();resolve({mime:meta.mime,pages:meta.pages,width:meta.width,height:meta.height,durationMs:meta.durationMs,frames});
   }catch{reject(new FishError('QQ_MEDIA_DECODE_RESPONSE_INVALID'));}
  });
  child.stdin.end(input);
 });}
}
const decoder=new MediaDecoder();
export const decodeMedia=(bytes:Buffer)=>decoder.decode(bytes);
