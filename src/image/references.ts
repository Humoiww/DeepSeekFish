import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safePath } from '../paths.js';
import { FishError } from '../types.js';
import { imageMime } from '../memory/people.js';
import { verifyPng } from './provider.js';
import type { CharacterReference } from './character-reference.js';

export interface SelectedReference {id:string;label:string;path:string}
export function readReference(root:string,relative:string,maxBytes=10485760){
  const file=safePath(root,relative),st=fs.lstatSync(file);
  if(!st.isFile()||st.nlink!==1||st.size<12||st.size>maxBytes)throw new FishError('IMAGE_REFERENCE_INVALID');
  const bytes=fs.readFileSync(file),mime=imageMime(bytes);
  if(mime==='image/png')verifyPng(root,relative,maxBytes);
  return {file,bytes,mime};
}
export function stageReferences(root:string,cwd:string,selected:SelectedReference[]):CharacterReference[]{
  if(selected.length>3)throw new FishError('IMAGE_REFERENCE_LIMIT');
  let budget=20971520;const staged:CharacterReference[]=[];
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
