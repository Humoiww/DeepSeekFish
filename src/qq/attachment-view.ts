import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {MAX_IMAGE_BYTES,MAX_VISION_ORIGINAL_BYTES} from '../image/limits.js';
import {imageMime} from '../memory/people.js';
import {diagnosticSafe} from '../diagnostics.js';
import {FishError,type ChatPart,type QQAttachment} from '../types.js';
import {decodeMedia} from './media-decoder.js';
import {mp4Info,wordText} from './attachment-formats.js';

const textLimit=2*1024*1024,textPage=3000;
type Preview={content:Record<string,unknown>;parts:ChatPart[]};
type ViewOptions={offset:number;page:number;atSeconds?:number};
const supportedText=/\.(txt|text|csv|tsv|md|jsonl?|xml|html?|yaml|yml|ini|conf|log|sql|[jt]sx?|py|sh|toml|srt|vtt|css)$/i;
function prefix(file:string,length:number){
 const fd=fs.openSync(file,'r');
 try{const bytes=Buffer.alloc(length);return bytes.subarray(0,fs.readSync(fd,bytes,0,length,0));}
 finally{fs.closeSync(fd);}
}
function pagedText(text:string,offset:number,mode:string,sourceTruncated=false){
 const safe:string=diagnosticSafe(text.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g,''));
 const content=safe.slice(offset,offset+textPage);
 return {mode,text:content,offset,nextOffset:offset+content.length<safe.length?offset+content.length:null,sourceTruncated,untrustedContent:true};
}
function decodeText(bytes:Buffer,knownText:boolean,truncated:boolean){
 const encoding=bytes.subarray(0,2).equals(Buffer.from([255,254]))?'utf-16le':
  bytes.subarray(0,2).equals(Buffer.from([254,255]))?'utf-16be':'utf-8';
 let text:string;
 try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes,{stream:truncated});}
 catch{
  if(!knownText)return;
  try{text=new TextDecoder('gb18030',{fatal:true}).decode(bytes,{stream:truncated});}catch{return;}
 }
 if(/[\x00-\x08\x0b-\x0c\x0e-\x1f]/.test(text.slice(0,2048)))return;
 return text;
}
function nativeProgram(name:'ffmpeg'|'pdftotext'){
 return ['/usr/bin/','/usr/local/bin/'].map(dir=>dir+name).find(file=>fs.existsSync(file));
}
// Use fixed commands and verified local originals. No shell, provider URL,
// arbitrary argument list or application credential reaches an external reader.
function nativeRead(program:string,args:string[],limit:number,signal:AbortSignal,input?:string):Promise<Buffer>{
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const env:NodeJS.ProcessEnv={LANG:'C.UTF-8',MALLOC_ARENA_MAX:'2'};
  for(const key of ['TMPDIR','TMP','TEMP','SystemRoot'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(program,args,{env,stdio:[input?'pipe':'ignore','pipe','ignore'],windowsHide:true});
  let failure:unknown,bytes=0;
  const chunks:Buffer[]=[];
  const stop=(error:unknown)=>{failure??=error;child.kill('SIGKILL');};
  const abort=()=>stop(signal.reason),timer=setTimeout(()=>stop(new FishError('QQ_ATTACHMENT_PREVIEW_TIMEOUT')),12000);
  signal.addEventListener('abort',abort,{once:true});
  child.on('error',()=>stop(new FishError('QQ_ATTACHMENT_PREVIEW_UNAVAILABLE')));
  child.stdout!.on('data',(chunk:Buffer)=>{
   bytes+=chunk.length;
   if(bytes>limit)stop(new FishError('QQ_ATTACHMENT_PREVIEW_LIMIT'));
   else chunks.push(chunk);
  });
  const stream=input?fs.createReadStream(input):undefined;
  if(stream){
   stream.on('error',()=>stop(new FishError('QQ_ATTACHMENT_FILE_MISSING')));
   child.stdin!.on('error',()=>{});stream.pipe(child.stdin!);
  }
  child.on('close',code=>{
   stream?.destroy();clearTimeout(timer);signal.removeEventListener('abort',abort);
   if(failure){reject(failure);return;}
   if(code!==0){reject(new FishError('QQ_ATTACHMENT_PREVIEW_FAILED'));return;}
   resolve(Buffer.concat(chunks,bytes));
  });
 });
}

export async function viewAttachment(file:string,meta:{id:string;kind:QQAttachment['kind'];name:string|null;bytes:number;mime:string|null},options:ViewOptions,signal:AbortSignal):Promise<Preview>{
 const head=prefix(file,Math.min(meta.bytes,1024)),name=meta.name??'';
 let mime:string|undefined;
 try{mime=imageMime(head);}catch{}
 if(mime){
  if(meta.bytes>MAX_IMAGE_BYTES)return {content:{mode:'metadata',mime,reason:'QQ_ATTACHMENT_IMAGE_PREVIEW_LIMIT'},parts:[]};
  const decoded=await decodeMedia(fs.readFileSync(file));signal.throwIfAborted();
  let room=MAX_VISION_ORIGINAL_BYTES;
  const frames=decoded.frames.filter(frame=>{if(frame.png.length>room)return false;room-=frame.png.length;return true;});
  if(!frames.length)return {content:{mode:'metadata',mime,reason:'QQ_ATTACHMENT_IMAGE_PREVIEW_LIMIT'},parts:[]};
  return {content:{mode:'image_samples',mime,width:decoded.width,height:decoded.height,frames:decoded.pages,durationMs:decoded.durationMs,
   samples:frames.map(frame=>({frame:frame.index+1,atMs:frame.atMs}))},parts:frames.map(frame=>({type:'image_url',image_url:{url:'data:image/png;base64,'+frame.png.toString('base64'),detail:'low'}}))};
 }
 if(/\.docx$/i.test(name)&&head.subarray(0,4).equals(Buffer.from([80,75,3,4]))){
  return {content:pagedText(wordText(file,meta.bytes),options.offset,'docx_text'),parts:[]};
 }
 const pdfOffset=head.indexOf('%PDF-');
 if(pdfOffset===0||pdfOffset>0&&(/\.pdf$/i.test(name)||meta.mime==='application/pdf')){
  const program=nativeProgram('pdftotext');
  if(!program)return {content:{mode:'metadata',mime:'application/pdf',reason:'QQ_ATTACHMENT_PDF_PREVIEW_UNAVAILABLE'},parts:[]};
  const data=await nativeRead(program,['-f',String(options.page),'-l',String(options.page),'-layout','-','-'],textLimit,signal,file);
  return {content:{...pagedText(data.toString('utf8'),options.offset,'pdf_text'),page:options.page},parts:[]};
 }
 const box=head.toString('ascii',4,8);
 const isMp4=['ftyp','moov','mdat','wide'].includes(box)||meta.kind==='video'&&/\.(?:mp4|mov|m4v)$/i.test(name);
 const mediaFormat=isMp4?'mov':head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))?'matroska':
  head.toString('ascii',0,4)==='RIFF'&&head.toString('ascii',8,12)==='AVI '?'avi':undefined;
 if(mediaFormat){
  const metaInfo:Partial<ReturnType<typeof mp4Info>> & {format:string}=isMp4?mp4Info(file,meta.bytes):{format:mediaFormat};
  const audioOnly=meta.kind==='audio'||isMp4&&metaInfo.audio&&!metaInfo.width;
  const program=audioOnly?undefined:nativeProgram('ffmpeg');
  if(!program)return {content:{mode:'metadata',...metaInfo,reason:audioOnly?'QQ_ATTACHMENT_AUDIO_METADATA_ONLY':'QQ_ATTACHMENT_VIDEO_PREVIEW_UNAVAILABLE'},parts:[]};
  const time=options.atSeconds??(metaInfo.durationSeconds?Math.min(metaInfo.durationSeconds/2,30):0);
  if(metaInfo.durationSeconds!==undefined&&time>=metaInfo.durationSeconds)throw new FishError('QQ_ATTACHMENT_MEDIA_TIME_OUTSIDE');
  const png=await nativeRead(program,['-hide_banner','-loglevel','error','-nostdin','-max_alloc','33554432',
   '-protocol_whitelist','file,pipe','-format_whitelist',mediaFormat,'-f',mediaFormat,...(isMp4?['-enable_drefs','0','-use_absolute_path','0']:[]),
   '-threads','1','-ss',String(time),'-i',file,'-map','0:v:0','-an','-sn','-dn','-vf','scale=640:640:force_original_aspect_ratio=decrease',
   '-frames:v','1','-threads','1','-c:v','png','-f','image2pipe','pipe:1'],2*1024*1024,signal);
  if(!png.length||imageMime(png)!=='image/png')throw new FishError('QQ_ATTACHMENT_VIDEO_FRAME_MISSING');
  return {content:{mode:'video_frame',...metaInfo,requestedAtSeconds:time,coverage:'one_frame_without_audio'},
   parts:[{type:'image_url',image_url:{url:'data:image/png;base64,'+png.toString('base64'),detail:'low'}}]};
 }
 const knownText=supportedText.test(name)||!!meta.mime?.startsWith('text/');
 if(knownText||meta.kind==='file'&&decodeText(head,false,head.length<meta.bytes)!==undefined){
  const bytes=prefix(file,Math.min(meta.bytes,textLimit));
  const text=decodeText(bytes,knownText,bytes.length<meta.bytes);
  if(text!==undefined)return {content:pagedText(text,options.offset,'text',bytes.length<meta.bytes),parts:[]};
 }
 return {content:{mode:'metadata',reason:'QQ_ATTACHMENT_PREVIEW_FORMAT_UNSUPPORTED'},parts:[]};
}
