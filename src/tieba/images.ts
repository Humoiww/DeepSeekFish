import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {makeDir,safePath} from '../paths.js';
import {FishError} from '../types.js';
import type {SelectedReference} from '../image/references.js';

export const TIEBA_IMAGE_COUNT=9;
export const TIEBA_IMAGE_BYTES=10*1024*1024;
export const tiebaImageId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9-]{1,180}$/.test(value);
const extensions=['.png','.jpg','.gif','.webp'];
const key=(requestId:string,id:string)=>createHash('sha256').update(JSON.stringify([requestId,id])).digest('hex');

export function stageTiebaImage(dir:string,requestId:string,id:string,bytes:Buffer){
 if(!requestId||requestId.length>240||!tiebaImageId(id)||bytes.length<12||bytes.length>TIEBA_IMAGE_BYTES)throw new FishError('TIEBA_IMAGE_INPUT_INVALID');
 const ext=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'.png':
  bytes.subarray(0,3).equals(Buffer.from([255,216,255]))?'.jpg':
  /^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))?'.gif':
  bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'.webp':'';
 if(!ext)throw new FishError('TIEBA_IMAGE_FORMAT_UNSUPPORTED');
 const base=makeDir(dir,'post-images'),name=key(requestId,id)+ext;
 const file=safePath(base,name),temp=safePath(base,randomUUID()+'.tmp');
 for(const entry of fs.readdirSync(base)){
  if(!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(entry))continue;
  const old=safePath(base,entry),st=fs.lstatSync(old,{throwIfNoEntry:false});
  if(st?.isFile()&&Date.now()-st.mtimeMs>3*86400000)fs.rmSync(old,{force:true});
 }
 try{fs.writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
 for(const other of extensions)if(other!==ext)fs.rmSync(safePath(base,key(requestId,id)+other),{force:true});
 return {staged:true,id};
}

export async function stageTiebaAttachments(
 root:string,ids:string[],selected:SelectedReference[],send:(id:string,bytes:Buffer)=>Promise<unknown>,signal:AbortSignal
){
 const {readReference}=await import('../image/references.js');
 for(const [index,item] of selected.entries()){
  signal.throwIfAborted();
  const {bytes}=readReference(root,path.relative(root,item.path),TIEBA_IMAGE_BYTES);
  await send(ids[index],bytes);
 }
}

export function tiebaImagePaths(dir:string,requestId:string,ids:string[]){
 return ids.map(id=>{
  const stem='post-images/'+key(requestId,id);
  for(const ext of extensions){
   const file=safePath(dir,stem+ext),st=fs.lstatSync(file,{throwIfNoEntry:false});
   if(st?.isFile()&&st.nlink===1&&st.size>=12&&st.size<=TIEBA_IMAGE_BYTES)return file;
  }
  throw new FishError('TIEBA_IMAGE_NOT_STAGED');
 });
}
