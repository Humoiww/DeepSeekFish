import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Store,redact } from '../storage/db.js';
import { makeDir,safePath } from '../paths.js';
import { FishError,codeOf,type Message,type ChatPart,type ModelTool } from '../types.js';
import { imageMime } from '../memory/people.js';
import { dayStart } from '../memory/journal.js';

// Load the native decoder only in the QQ media path; WebUI/Codex do not need
// additional native executable mappings just because they import the CLI.
let decoder:Promise<(typeof import('sharp'))['default']>|undefined;
function imageDecoder(){return decoder??=import('sharp').then(({default:sharp})=>{sharp.concurrency(1);sharp.cache({memory:16,files:0,items:20});return sharp;});}
const MAX_BYTES=10485760,MAX_PIXELS=16777216;
const options={limitInputPixels:MAX_PIXELS,failOn:'warning' as const};
const CDN=new Set(['multimedia.nt.qq.com.cn','multimedia.nt.qq.com','gchat.qpic.cn','c2cpicdw.qpic.cn','gchat.qlogo.cn']);
export function qqImageUrl(value:string):URL{
  let url:URL;try{url=new URL(value);}catch{throw new FishError('QQ_MEDIA_URL_DENIED');}
  if(value.length>4096||!['http:','https:'].includes(url.protocol)||!CDN.has(url.hostname)||url.username||url.password||url.port||url.hash)throw new FishError('QQ_MEDIA_URL_DENIED');
  url.protocol='https:';return url;
}
export async function decodeMedia(bytes:Buffer){
  if(bytes.length>MAX_BYTES)throw new FishError('QQ_MEDIA_TOO_LARGE');
  const sharp=await imageDecoder();
  const mime=imageMime(bytes),meta=await sharp(bytes,options).metadata();
  if(!meta.width||!meta.height||meta.width*(meta.pageHeight??meta.height)>MAX_PIXELS)throw new FishError('QQ_MEDIA_PIXEL_LIMIT');
  const pages=meta.pages??1;if(pages>500)throw new FishError('QQ_MEDIA_FRAME_LIMIT');
  const count=Math.min(4,pages),indices=Array.from({length:count},(_,i)=>count===1?0:Math.round(i*(pages-1)/(count-1)));
  const frames:{index:number;atMs:number;png:Buffer}[]=[];
  for(const index of indices){
    const png=await sharp(bytes,{...options,page:index,pages:1}).rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).png().timeout({seconds:5}).toBuffer();
    frames.push({index,atMs:(meta.delay??[]).slice(0,index).reduce((a,b)=>a+b,0),png});
  }
  return {mime,pages,width:meta.width,height:meta.pageHeight??meta.height,durationMs:(meta.delay??[]).reduce((a,b)=>a+b,0),frames};
}
interface MediaRow {id:string;conversation:string;sender:string;path:string;bytes:number;meta:string;observed:number;meme:number;description:string;tags:string;last_sent:number}
export interface ReceivedMedia {messageId:string;id?:string;error?:string;position:number;stickerHint?:boolean}
export class QQMedia {
  constructor(private root:string,private store:Store,private fallback?:(file:string)=>Promise<string>,private http:typeof fetch=fetch){
    makeDir(root,'runtime/memory/media');
    store.db.exec(`CREATE TABLE IF NOT EXISTS qq_media(id TEXT PRIMARY KEY,conversation TEXT,sender TEXT,path TEXT,bytes INTEGER,meta TEXT,observed INTEGER,meme INTEGER,description TEXT,tags TEXT,last_sent INTEGER);
      CREATE INDEX IF NOT EXISTS qq_media_scope ON qq_media(conversation,observed);
      CREATE TABLE IF NOT EXISTS qq_media_messages(conversation TEXT,message_id TEXT,position INTEGER,media_id TEXT,PRIMARY KEY(conversation,message_id,position));`);
  }
  private async download(value:string,signal?:AbortSignal):Promise<Buffer>{
    const response=await this.http(qqImageUrl(value),{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])])});
    if(!response.ok||!response.body){await response.body?.cancel();throw new FishError('QQ_MEDIA_DOWNLOAD_FAILED');}
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES)throw new FishError('QQ_MEDIA_TOO_LARGE');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    return Buffer.concat(chunks);
  }
  private async keepOriginal(conversation:string,sender:string,bytes:Buffer,at:number,sourceImageId?:string){
    const id='media-'+createHash('sha256').update(conversation+'\0').update(bytes).digest('hex').slice(0,32);
    const known=this.store.db.prepare('SELECT id FROM qq_media WHERE id=? AND conversation=?').get(id,conversation);
    if(known){this.store.db.prepare('UPDATE qq_media SET observed=? WHERE id=?').run(at,id);return id;}
    const size=(this.store.db.prepare('SELECT coalesce(sum(bytes),0) AS n FROM qq_media').get() as {n:number}).n;
    if(size+bytes.length>536870912)throw new FishError('QQ_MEDIA_STORAGE_FULL');
    const decoded=await decodeMedia(bytes),folder='runtime/memory/media/'+id;makeDir(this.root,folder);
    const relative=folder+'/original.'+decoded.mime.split('/')[1],{frames,...meta}=decoded;
    try{
      fs.writeFileSync(safePath(this.root,relative),bytes,{flag:'wx',mode:0o600});
      for(const frame of frames)fs.writeFileSync(safePath(this.root,folder+'/frame-'+frame.index+'.png'),frame.png,{flag:'wx',mode:0o600});
      const info={...meta,frames:frames.map(({png,...frame})=>frame),...(sourceImageId?{sourceImageId}:{})};
      this.store.db.prepare('INSERT INTO qq_media VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,conversation,sender,relative,bytes.length,JSON.stringify(info),at,0,'','[]',0);
    }catch(e){fs.rmSync(safePath(this.root,folder),{recursive:true,force:true});throw e;}
    return id;
  }
  async collect(conversation:string,imageId:string,bytes:Buffer,description:unknown,tags:unknown){
    // The caller obtains bytes by resolving an opaque, conversation-scoped catalog ID.
    if(typeof imageId!=='string'||!imageId||imageId.length>180||typeof description!=='string'||!description.trim()||description.length>300||!Array.isArray(tags)||tags.length>6||tags.some(t=>typeof t!=='string'||!t.trim()||t.length>30))throw new FishError('QQ_MEDIA_DESCRIPTION_INVALID');
    const id=await this.keepOriginal(conversation,'DeepSeekFish',bytes,Date.now(),imageId);
    return this.remember(conversation,[{id,description,tags,meme:true}],[id])[0];
  }
  async ingest(batch:Message[],signal?:AbortSignal):Promise<ReceivedMedia[]>{
    const result:ReceivedMedia[]=[];
    for(const m of batch)for(const [position,attachment] of (m.images??[]).entries()){
      if(result.length>=4){result.push({messageId:m.id,position,error:'QQ_MEDIA_BATCH_LIMIT'});continue;}
      try{
        signal?.throwIfAborted();
        const prior=this.store.db.prepare('SELECT media_id FROM qq_media_messages WHERE conversation=? AND message_id=? AND position=?').get(m.group,m.id,position) as {media_id:string}|undefined;
        if(prior){result.push({messageId:m.id,position,id:prior.media_id,stickerHint:attachment.stickerHint});continue;}
        let bytes:Buffer;
        try{if(!attachment.url)throw new FishError('QQ_IMAGE_URL_MISSING');bytes=await this.download(attachment.url,signal);}
        catch(e){if(!attachment.file||!this.fallback||signal?.aborted)throw e;bytes=await this.download(await this.fallback(attachment.file),signal);}
        const id=await this.keepOriginal(m.group,m.user,bytes,m.at);
        this.store.db.prepare('INSERT INTO qq_media_messages VALUES (?,?,?,?)').run(m.group,m.id,position,id);
        result.push({messageId:m.id,position,id,stickerHint:attachment.stickerHint});
      }catch(e){result.push({messageId:m.id,position,error:codeOf(e)});this.store.audit('media-error',m.group,codeOf(e));}
    }
    return result;
  }
  private row(conversation:string,id:string,memeOnly=false):MediaRow{
    const row=this.store.db.prepare('SELECT * FROM qq_media WHERE id=? AND conversation=?').get(id,conversation) as unknown as MediaRow|undefined;
    if(!row||memeOnly&&!row.meme)throw new FishError('QQ_MEDIA_NOT_AVAILABLE');return row;
  }
  describe(conversation:string,id:string){const r=this.row(conversation,id),m=JSON.parse(r.meta);return {id,sourceImageId:m.sourceImageId,animated:m.pages>1,frames:m.pages,sampledFrames:m.frames.map((f:any)=>f.index+1),durationMs:m.durationMs,description:r.description,tags:JSON.parse(r.tags),meme:!!r.meme};}
  parts(conversation:string,media:ReceivedMedia[]):ChatPart[]{
    const parts:ChatPart[]=[],seen=new Set<string>();
    const allowance=Math.max(1,Math.floor(8/Math.max(1,new Set(media.flatMap(m=>m.id?[m.id]:[])).size)));
    for(const item of media){
      if(!item.id){parts.push({type:'text',text:JSON.stringify({imagePosition:item.position+1,error:item.error})});continue;}
      if(seen.has(item.id))continue;seen.add(item.id);
      const row=this.row(conversation,item.id),meta=JSON.parse(row.meta);
      const frames=meta.frames.length<=allowance?meta.frames:Array.from({length:allowance},(_,i)=>meta.frames[allowance===1?0:Math.round(i*(meta.frames.length-1)/(allowance-1))]);
      parts.push({type:'text',text:JSON.stringify({...this.describe(conversation,item.id),messageId:item.messageId,sampledFrames:frames.map((f:any)=>f.index+1),stickerHint:item.stickerHint,source:'QQ收到的图片',sampling:meta.pages>1?'按顺序抽帧，不是完整视频':undefined})});
      for(const frame of frames){
        const file=safePath(this.root,'runtime/memory/media/'+item.id+'/frame-'+frame.index+'.png');
        parts.push({type:'text',text:JSON.stringify({imageId:item.id,frame:frame.index+1,atMs:frame.atMs})},
          {type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(file).toString('base64'),detail:'high'}});
      }
    }
    return parts;
  }
  remember(conversation:string,records:unknown,allowed:string[]){
    if(!Array.isArray(records)||records.length!==allowed.length||new Set(records.map(r=>r?.id)).size!==records.length)throw new FishError('QQ_MEDIA_DESCRIPTION_REQUIRED');
    return this.store.transaction(()=>records.map(r=>{
      if(!r||!allowed.includes(r.id)||typeof r.meme!=='boolean'||typeof r.description!=='string'||!r.description.trim()||r.description.length>300||!Array.isArray(r.tags)||r.tags.length>6||r.tags.some((t:unknown)=>typeof t!=='string'||!t.trim()||t.length>30)||Object.keys(r).some(k=>!['id','description','meme','tags'].includes(k)))throw new FishError('QQ_MEDIA_DESCRIPTION_INVALID');
      this.row(conversation,r.id);
      this.store.db.prepare('UPDATE qq_media SET description=?,tags=?,meme=? WHERE id=? AND conversation=?').run(redact(r.description.trim()),JSON.stringify(r.tags.map((t:string)=>redact(t.trim()))),Number(r.meme),r.id,conversation);
      return this.describe(conversation,r.id);
    }));
  }
  context(conversation:string){
    const rows=this.store.db.prepare('SELECT id FROM qq_media WHERE conversation=? AND observed>=? ORDER BY observed DESC LIMIT 6').all(conversation,dayStart()-86400000) as {id:string}[];
    return {recentImages:rows.map(r=>this.describe(conversation,r.id)),memes:this.find(conversation,'').slice(0,6)};
  }
  find(conversation:string,query:string){return this.browse(conversation,query).memes;}
  browse(conversation:string,query:string,offset=0){
    if(typeof query!=='string'||query.length>100||!Number.isInteger(offset)||offset<0||offset>10000)throw new FishError('QQ_MEME_QUERY_INVALID');
    const rows=this.store.db.prepare('SELECT id,description,tags,last_sent FROM qq_media WHERE conversation=? AND meme=1 ORDER BY last_sent ASC,observed DESC LIMIT 500').all(conversation) as {id:string;description:string;tags:string;last_sent:number}[];
    const words=query.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
    const found=rows.filter(r=>!words.length||words.some(w=>(r.description+r.tags).toLowerCase().includes(w)));
    return {memes:found.slice(offset,offset+12).map(r=>({...this.describe(conversation,r.id),lastSent:r.last_sent||null})),total:found.length,nextOffset:offset+12<found.length?offset+12:null};
  }
  original(conversation:string,id:string):Buffer{
    const r=this.row(conversation,id,true),file=safePath(this.root,r.path),st=fs.lstatSync(file);
    if(!st.isFile()||st.nlink!==1||st.size!==r.bytes||st.size>MAX_BYTES)throw new FishError('QQ_MEDIA_FILE_INVALID');
    const bytes=fs.readFileSync(file);imageMime(bytes);return bytes;
  }
  sent(conversation:string,id:string){this.store.db.prepare('UPDATE qq_media SET last_sent=? WHERE id=? AND conversation=?').run(Date.now(),id,conversation);}
}
export function mediaTools(ids:string[]):ModelTool[]{return [
  ...(ids.length?[{type:'function' as const,function:{name:'remember_images',description:'将本次图片的可见内容、文字、动图变化记入后台；识别为表情包则收藏。聊天可以自行接梗。',parameters:{type:'object',properties:{images:{type:'array',minItems:ids.length,maxItems:ids.length,items:{type:'object',properties:{id:{type:'string',enum:ids},description:{type:'string',maxLength:300},meme:{type:'boolean',description:'表达情绪、反应或梗的表情图；普通照片和截图不自动算表情包'},tags:{type:'array',maxItems:6,items:{type:'string',maxLength:30},description:'情绪、含义及适合的聊天场景'}},required:['id','description','meme','tags'],additionalProperties:false}}},required:['images'],additionalProperties:false}}}]:[]),
  {type:'function',function:{name:'collect_meme',description:'从图库收藏表情，包括自己生成的图。imageId 来自图库或生图结果；本轮没看过原图时先返回图片，看图后再调用保存描述/标签，已有收藏则更新。',parameters:{type:'object',properties:{imageId:{type:'string'},description:{type:'string',maxLength:300},tags:{type:'array',maxItems:6,items:{type:'string',maxLength:30}}},required:['imageId','description','tags'],additionalProperties:false}}},
  {type:'function',function:{name:'find_memes',description:'按含义或情绪找已收藏的表情包；空查询浏览，nextOffset 可继续下一页。',parameters:{type:'object',properties:{query:{type:'string',maxLength:100},offset:{type:'integer',minimum:0,maximum:10000}},required:['query'],additionalProperties:false}}},
  {type:'function',function:{name:'send_meme',description:'发送收藏表情；id 发一张，ids 发多张。也可以只发图，动图发送原动画，同一轮重复ID返回已有送达状态。',parameters:{type:'object',properties:{id:{type:'string'},ids:{type:'array',minItems:1,maxItems:12,items:{type:'string'}}},additionalProperties:false}}}
];}
