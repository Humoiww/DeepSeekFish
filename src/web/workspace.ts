import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeDir, safePath } from '../paths.js';
import { FishError } from '../types.js';

export class SessionWorkspace {
  readonly cwd:string;
  constructor(root:string,id:string){
    if(!/^[0-9a-f-]{36}$/.test(id))throw new FishError('INVALID_SESSION');
    this.cwd=makeDir(root,'runtime/workspace/web-'+id);
  }
  private file(name:unknown):string{
    if(typeof name!=='string'||name.length>180||name.split('/').length>5||name.split('/').some(p=>p.startsWith('.'))||
      !/\.(txt|md|json|csv|js|ts|py|html|css|svg)$/i.test(name)||/^(auth|credentials|config)\.json$/i.test(path.basename(name)))throw new FishError('WORKSPACE_FILE_REJECTED');
    const p=safePath(this.cwd,name),st=fs.lstatSync(p,{throwIfNoEntry:false});
    if(st&&(!st.isFile()||st.nlink!==1))throw new FishError('WORKSPACE_FILE_REJECTED');
    return p;
  }
  list():{name:string;bytes:number}[]{
    const result:{name:string;bytes:number}[]=[];let entries=0;
    const walk=(dir:string,depth:number)=>{
      if(depth>5)throw new FishError('WORKSPACE_DEPTH');
      for(const e of fs.readdirSync(dir,{withFileTypes:true})){
        if(++entries>100)throw new FishError('WORKSPACE_ENTRIES');
        const rel=path.relative(this.cwd,path.join(dir,e.name)).split(path.sep).join('/'),p=safePath(this.cwd,rel);
        if(e.isDirectory()){if(e.name.startsWith('.'))throw new FishError('WORKSPACE_FILE_REJECTED');walk(p,depth+1);}
        else{this.file(rel);const st=fs.statSync(p);result.push({name:rel,bytes:st.size});}
      }
    };walk(this.cwd,0);return result;
  }
  read(name:unknown):string{
    const p=this.file(name);if(fs.statSync(p).size>65536)throw new FishError('WORKSPACE_FILE_TOO_LARGE');
    return fs.readFileSync(p,'utf8');
  }
  write(name:unknown,content:unknown):{name:string;bytes:number}{
    if(typeof content!=='string'||Buffer.byteLength(content)>65536)throw new FishError('WORKSPACE_FILE_TOO_LARGE');
    const p=this.file(name),files=this.list(),size=Buffer.byteLength(content);
    if(!files.some(f=>f.name===name)&&files.length>=20||files.filter(f=>f.name!==name).reduce((n,f)=>n+f.bytes,0)+size>1048576)throw new FishError('WORKSPACE_QUOTA');
    fs.mkdirSync(path.dirname(p),{recursive:true});this.file(name);
    const temp=path.join(path.dirname(p),'.write-'+randomUUID());
    try{fs.writeFileSync(temp,content,{flag:'wx',mode:0o600});fs.renameSync(temp,p);}finally{fs.rmSync(temp,{force:true});}
    return {name:String(name),bytes:size};
  }
}
