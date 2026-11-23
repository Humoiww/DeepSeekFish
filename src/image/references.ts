import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safePath } from '../paths.js';
import { FishError } from '../types.js';
import { imageMime } from '../memory/people.js';
import { verifyPng } from './provider.js';
import type { CharacterReference } from './character-reference.js';
import { MAX_IMAGE_BYTES,MAX_REFERENCE_BYTES } from './limits.js';
import {MAX_VISION_ORIGINAL_BYTES} from './limits.js';
import {decodeMedia} from '../qq/media-decoder.js';

export interface SelectedReference {id:string;label:string;path:string}
export function readReference(root:string,relative:string,maxBytes=MAX_IMAGE_BYTES){
  const file=safePath(root,relative),st=fs.lstatSync(file);
  if(!st.isFile()||st.nlink!==1||st.size<12||st.size>maxBytes)throw new FishError('IMAGE_REFERENCE_INVALID');
  const bytes=fs.readFileSync(file),mime=imageMime(bytes);
  if(mime==='image/png')verifyPng(root,relative,maxBytes);
  return {file,bytes,mime};
}
export function stageReferences(root:string,cwd:string,selected:SelectedReference[]):CharacterReference[]{
  if(selected.length>3)throw new FishError('IMAGE_REFERENCE_LIMIT');
  let budget=MAX_REFERENCE_BYTES;const staged:CharacterReference[]=[];
  try{for(const [i,item] of selected.entries()){
    const relative=path.relative(root,item.path).split(path.sep).join('/'),image=readReference(root,relative);
    budget-=image.bytes.length;if(budget<0)throw new FishError('IMAGE_REFERENCE_LIMIT');
    const ext=image.mime==='image/jpeg'?'jpg':image.mime.split('/')[1],target=safePath(cwd,'selected-reference-'+(i+1)+'.'+ext);
    fs.writeFileSync(target,image.bytes,{flag:'wx',mode:0o600});
    staged.push({path:target,sha256:createHash('sha256').update(image.bytes).digest('hex')});
  }return staged;}catch(e){for(const ref of staged)fs.rmSync(ref.path,{force:true});throw e;}
}
export function verifySelectedReferences(items:{inputImages?:CharacterReference[]}[],references:CharacterReference[]){
  if(references.some(ref=>items.length!==1||!items[0].inputImages?.some(input=>input.path===ref.path&&input.sha256===ref.sha256)))throw new FishError('IMAGE_REFERENCES_NOT_USED');
}
/** Keep the native generator's originals intact. Large initial vision inputs
 * use the existing bounded decoder, rather than uploading the original twice. */
export async function prepareReferenceVision(cwd:string,files:string[],signal:AbortSignal){
 const previews:string[]=[],inputs:{originalPath:string;path:string;originalBytes:number;inputBytes:number}[]=[];
 try{
  for(const [i,file] of files.entries()){
   signal.throwIfAborted();const original=readReference(cwd,path.basename(file));
   if(original.bytes.length<=MAX_VISION_ORIGINAL_BYTES){inputs.push({originalPath:file,path:file,originalBytes:original.bytes.length,inputBytes:original.bytes.length});continue;}
   const decoded=await decodeMedia(original.bytes);signal.throwIfAborted();const bytes=decoded.frames[0]?.png;
   if(!bytes?.length)throw new FishError('IMAGE_REFERENCE_PREVIEW_FAILED');
   const target=safePath(cwd,'vision-reference-'+(i+1)+'.png');fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});previews.push(target);
   inputs.push({originalPath:file,path:target,originalBytes:original.bytes.length,inputBytes:bytes.length});
  }
  return {inputs,previews};
 }catch(e){for(const file of previews)fs.rmSync(file,{force:true});throw e;}
}
