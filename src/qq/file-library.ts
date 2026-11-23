import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../storage/db.js';
import {safePath} from '../paths.js';
import {FishError,type Message} from '../types.js';
import {MAX_IMAGE_BYTES} from '../image/limits.js';
import type {QQImageLibrary} from './image-library.js';

const countdownId='countdown-video';
const countdownName='countdown-5-4-3-2-1-go.mp4';
const countdownPath='assets/'+countdownName;
export const generatedVideoId=/^video-[a-f0-9]{64}$/;
export const videoDirectory='runtime/data/qq-videos';

export interface CatalogFile {id:string;name:string;bytes:number;kind:'image'|'artifact';relative:string;label:string;source:string}
export interface FileResolver {resolveFile(message:Message,fileId:string,signal?:AbortSignal):Promise<CatalogFile>}
export function fileName(name:unknown):string{
 if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name)>240||/[\\/\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..')throw new FishError('QQ_FILE_NAME_INVALID');
 return name;
}
export function catalogPath(root:string,file:CatalogFile):string{
 // Only trusted catalog descriptors reach here, never a model-provided path.
 const countdown=file.id===countdownId&&file.relative===countdownPath&&file.kind==='artifact'&&file.name===countdownName;
 const video=generatedVideoId.test(file.id)&&file.kind==='artifact'&&file.relative===videoDirectory+'/'+file.id+'.mp4';
 if(!countdown&&!video&&!file.relative.startsWith('runtime/outputs/')&&!file.relative.startsWith('runtime/memory/')&&!file.relative.startsWith('assets/character/')&&!file.relative.startsWith('runtime/character/'))throw new FishError('FILE_NOT_AVAILABLE');
 const p=safePath(root,file.relative),st=fs.lstatSync(p);
 if(!st.isFile()||st.nlink!==1||st.size!==file.bytes||st.size>MAX_IMAGE_BYTES)throw new FishError('FILE_NOT_AVAILABLE');
 fileName(file.name);return p;
}
type VideoRow={id:string;seconds:number;bytes:number};
function videoFile(row:VideoRow):CatalogFile{
 return {id:row.id,name:'动画-'+row.seconds+'秒.mp4',bytes:row.bytes,kind:'artifact',relative:videoDirectory+'/'+row.id+'.mp4',
  label:row.seconds+'秒动画视频',source:'qq-video'};
}
export function findVideoFile(root:string,store:Store,conversation:string,id:string):CatalogFile|undefined{
 if(!generatedVideoId.test(id))return;
 const row=store.db.prepare('SELECT id,seconds,bytes FROM qq_generated_videos WHERE id=? AND conversation=?').get(id,conversation) as VideoRow|undefined;
 if(!row)return;
 const file=videoFile(row);
 catalogPath(root,file);
 return file;
}
/** Catalog of already authorized outputs and scoped originals, not host files. */
export class QQFileLibrary {
 constructor(private root:string,private store:Store,private images?:QQImageLibrary,private options:{bundledCountdown?:boolean}={}){}
 private entries(conversation:string,user:string):CatalogFile[]{
  const files:CatalogFile[]=(this.images?.entries(conversation,user)??[]).map(i=>{
   let name=path.basename(i.path);
   if(i.sourceUrl)try{const candidate=decodeURIComponent(new URL(i.sourceUrl).pathname.split('/').at(-1)??'');fileName(candidate);name=candidate;}catch{}
   return {id:i.id,name,bytes:fs.statSync(i.path).size,kind:'image',relative:path.relative(this.root,i.path).split(path.sep).join('/'),label:i.label,source:i.source};
  });
  if(this.options.bundledCountdown&&conversation==='private:'+user)try{
   const stat=fs.lstatSync(safePath(this.root,countdownPath),{throwIfNoEntry:false});
   if(stat?.isFile()&&stat.nlink===1&&stat.size>0&&stat.size<=MAX_IMAGE_BYTES)files.unshift({
    id:countdownId,name:countdownName,bytes:stat.size,kind:'artifact',relative:countdownPath,
    label:'竖屏无声倒计时视频，从五倒数到一，随后显示 GO',source:'bundled',
   });
  }catch{}
  const seenVideos=new Set<string>();
  const append=(db:DatabaseSync)=>{
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='qq_generated_videos' AND type='table'").get()){
    const videos=db.prepare('SELECT id,seconds,bytes FROM qq_generated_videos WHERE conversation=? ORDER BY created DESC').all(conversation) as VideoRow[];
    for(const row of videos)try{
     if(seenVideos.has(row.id))continue;
     const item=videoFile(row);catalogPath(this.root,item);files.push(item);seenVideos.add(row.id);
    }catch{}
   }
   const rows=db.prepare("SELECT id,manifest FROM tasks WHERE grp=? AND state='succeeded' AND manifest IS NOT NULL ORDER BY created DESC LIMIT 100").all(conversation) as {id:string;manifest:string}[];
   for(const row of rows){
    if(!/^[a-f0-9-]{36}$/.test(row.id))continue;
    let manifest:any;try{manifest=JSON.parse(row.manifest);}catch{continue;}
    if(!Array.isArray(manifest))continue;
    for(const a of manifest.slice(0,100))try{
     if(typeof a.name!=='string'||!Number.isSafeInteger(a.bytes))continue;
     const id='artifact-'+row.id+'-'+createHash('sha256').update(a.name).digest('hex').slice(0,20);
     if(files.some(f=>f.id===id))continue;
     const item:CatalogFile={id,name:fileName(path.posix.basename(a.name)),bytes:a.bytes,kind:'artifact',relative:'runtime/outputs/'+row.id+'/'+a.name,label:a.name,source:'codex'};
     catalogPath(this.root,item);files.push(item);
    }catch{}
   }
  };
  append(this.store.db);
  // The existing trusted broker and QQ archive may use different databases.
  const archive=safePath(this.root,'runtime/data/fish.sqlite');
  if(fs.existsSync(archive)){
   const db=new DatabaseSync(archive,{readOnly:true});try{db.exec('PRAGMA busy_timeout=2000');append(db);}finally{db.close();}
  }
  return files;
 }
 list(conversation:string,user:string,offset=0){
  if(!Number.isInteger(offset)||offset<0||offset>10000)throw new FishError('FILE_CATALOG_QUERY_INVALID');
  const all=this.entries(conversation,user);
  return {files:all.slice(offset,offset+20).map(({relative,...file})=>file),total:all.length,nextOffset:offset+20<all.length?offset+20:null};
 }
 resolve(conversation:string,user:string,id:unknown):CatalogFile{
  if(typeof id!=='string'||id.length>180)throw new FishError('FILE_NOT_AVAILABLE');
  const file=this.entries(conversation,user).find(f=>f.id===id);if(!file)throw new FishError('FILE_NOT_AVAILABLE');
  catalogPath(this.root,file);return file;
 }
}
