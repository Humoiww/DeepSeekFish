import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../storage/db.js';
import {safePath} from '../paths.js';
import {FishError,type Message} from '../types.js';
import {MAX_IMAGE_BYTES} from '../image/limits.js';
import {QQImageLibrary} from './image-library.js';

export interface CatalogFile {id:string;name:string;bytes:number;kind:'image'|'artifact';relative:string;label:string;source:string}
export interface FileResolver {resolveFile(message:Message,fileId:string,signal?:AbortSignal):Promise<CatalogFile>}
export function fileName(name:unknown):string{
 if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name)>240||/[\\/\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..')throw new FishError('QQ_FILE_NAME_INVALID');
 return name;
}
export function catalogPath(root:string,file:CatalogFile):string{
 // Only trusted catalog descriptors reach here, never a model-provided path.
 if(!file.relative.startsWith('runtime/outputs/')&&!file.relative.startsWith('runtime/memory/')&&!file.relative.startsWith('assets/character/')&&!file.relative.startsWith('runtime/character/'))throw new FishError('FILE_NOT_AVAILABLE');
 const p=safePath(root,file.relative),st=fs.lstatSync(p);
 if(!st.isFile()||st.nlink!==1||st.size!==file.bytes||st.size>MAX_IMAGE_BYTES)throw new FishError('FILE_NOT_AVAILABLE');
 fileName(file.name);return p;
}
/** Catalog of already authorized outputs and scoped originals, not host files. */
export class QQFileLibrary {
 constructor(private root:string,private store:Store,private images:QQImageLibrary){}
 private entries(conversation:string,user:string):CatalogFile[]{
  const files:CatalogFile[]=this.images.entries(conversation,user).map(i=>{
   let name=path.basename(i.path);
   if(i.sourceUrl)try{const candidate=decodeURIComponent(new URL(i.sourceUrl).pathname.split('/').at(-1)??'');fileName(candidate);name=candidate;}catch{}
   return {id:i.id,name,bytes:fs.statSync(i.path).size,kind:'image',relative:path.relative(this.root,i.path).split(path.sep).join('/'),label:i.label,source:i.source};
  });
  const append=(db:DatabaseSync)=>{
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
