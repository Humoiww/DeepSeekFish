import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safePath, makeDir, noLinks } from '../paths.js';
import { FishError } from '../types.js';

export interface Artifact { name:string; bytes:number; sha256:string }
const allowed=new Set(['.txt','.md','.json','.csv','.ts','.js','.py','.html','.css','.svg','.png','.jpg','.webp','.pdf']);
export function collectArtifacts(root:string,id:string,maxFiles:number,maxBytes:number):Artifact[] {
  if(!/^[a-z0-9-]{1,64}$/.test(id))throw new FishError('INVALID_TASK_ID');
  const workspace=safePath(root,'runtime/workspace/'+id);
  const found:{source:string;name:string;bytes:number}[]=[];let bytes=0,entries=0;
  function walk(dir:string,depth:number):void {
    if(depth>8)throw new FishError('ARTIFACT_DEPTH');
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(++entries>maxFiles*10+100)throw new FishError('ARTIFACT_ENTRIES');
      const source=safePath(workspace,path.relative(workspace,path.join(dir,entry.name)).split(path.sep).join('/'));
      const st=fs.lstatSync(source);
      if(st.isSymbolicLink()||st.nlink!==1 && st.isFile())throw new FishError('ARTIFACT_LINK');
      if(st.isDirectory()){walk(source,depth+1);continue;}
      if(!st.isFile())throw new FishError('ARTIFACT_TYPE');
      if(!allowed.has(path.extname(entry.name).toLowerCase())||entry.name.startsWith('.')||/^(?:auth|credentials|config)\.json$/i.test(entry.name))throw new FishError('ARTIFACT_TYPE');
      bytes+=st.size;
      if(bytes>maxBytes||found.length>=maxFiles)throw new FishError('ARTIFACT_LIMIT');
      found.push({source,name:path.relative(workspace,source).split(path.sep).join('/'),bytes:st.size});
    }
  }
  walk(workspace,0);
  // Validate the WHOLE set first; publish only after child process termination.
  const output=makeDir(root,'runtime/outputs/'+id);
  if(fs.readdirSync(output).length)throw new FishError('OUTPUT_EXISTS');
  try {
    return found.map(f=>{
      const target=safePath(output,f.name); fs.mkdirSync(path.dirname(target),{recursive:true});noLinks(target);
      fs.copyFileSync(f.source,target,fs.constants.COPYFILE_EXCL);
      return {name:f.name,bytes:f.bytes,sha256:createHash('sha256').update(fs.readFileSync(target)).digest('hex')};
    });
  }catch(e){fs.rmSync(output,{recursive:true,force:true});throw e;}
}
