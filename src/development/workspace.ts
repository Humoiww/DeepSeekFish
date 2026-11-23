import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {FishError} from '../types.js';
import {linuxSpec} from '../codex/platform.js';
import {safePath} from '../paths.js';

export type Tree=Record<string,string>;
export type Delta={name:string;old:string|null;next:string|null};
const roots=['src','assets','docs','tests','third_party','prompts','personas'];
const reserved=(name:string)=>name==='src/development'||name.startsWith('src/development/');
export const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export const revision=(tree:Tree)=>hash(Object.keys(tree).sort().map(k=>k+'\t'+tree[k]+'\n').join(''));
export const compare=(before:Tree,after:Tree):Delta[]=>[...new Set([...Object.keys(before),...Object.keys(after)])].sort().filter(k=>before[k]!==after[k]).map(name=>({name,old:before[name]??null,next:after[name]??null}));
const nameSafe=(name:string)=>name.length<=250&&name.split('/').every(p=>/^[\p{L}\p{N}_. @+-]+$/u.test(p)&&p!=='.'&&p!=='..'&&!p.startsWith('.'));
export function files(root:string){
 const result:Tree={};
 function visit(name:string){
  const file=safePath(root,name),stat=fs.lstatSync(file,{throwIfNoEntry:false});if(!stat)return;
  if(!nameSafe(name))throw new FishError('DEV_UNSUPPORTED_FILENAME');
  if(stat.isDirectory()){for(const entry of fs.readdirSync(file))visit(name+'/'+entry);return;}
  if(!stat.isFile()||stat.nlink!==1||stat.size>40*1024*1024)throw new FishError('DEV_UNSAFE_WORKSPACE_FILE');
  result[name]=hash(fs.readFileSync(file));
 }
 for(const name of roots)visit(name);
 return result;
}
export function transfer(from:string,to:string,changes:Delta[]){
 for(const entry of changes){
  const target=safePath(to,entry.name);
  if(entry.next===null){fs.rmSync(target,{force:true});continue;}
  const bytes=fs.readFileSync(safePath(from,entry.name));
  if(hash(bytes)!==entry.next)throw new FishError('DEV_SOURCE_CHANGED_DURING_COPY');
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{mode:0o600});
 }
}

export function prepareWorkspace(installation:string,cwd:string,live:Tree,previous?:Tree){
 if(previous===undefined){
  transfer(installation,cwd,compare({},live));
  for(const name of ['package.json','tsconfig.json','README.md','AGENTS.md'])fs.copyFileSync(safePath(installation,name),safePath(cwd,name));
  return [];
 }
 const current=files(cwd),authored=new Set(compare(previous,current).map(change=>change.name)),upstream=compare(previous,live);
 const conflicts=upstream.filter(change=>authored.has(change.name)&&current[change.name]!==live[change.name]).map(change=>change.name);
 // A conflicting path starts from the newer production copy. The old edit
 // is provided to the same Codex session as repair context, never deployed.
 const conflictsWithEdits=conflicts.map(name=>({name,candidate:current[name]&&name.endsWith('.ts')?fs.readFileSync(safePath(cwd,name),'utf8').slice(0,16000):undefined}));
 transfer(installation,cwd,upstream);
 return conflictsWithEdits;
}

export function prepareConversationWorkspace(installation:string,cwd:string,live:Tree,archive:string){
 const current=files(cwd),changes=compare(current,live),manifest=path.join(archive,'changes.json');
 // A fresh authorization starts from production. Keep the previous draft
 // with its deletions before touching the native conversation's checkout.
 if(changes.length&&Object.keys(current).length&&!fs.existsSync(manifest)){
  fs.mkdirSync(archive,{recursive:true,mode:0o700});
  transfer(cwd,archive,changes.flatMap(({name,old})=>old===null?[]:[{name,old:null,next:old}]));
  fs.writeFileSync(manifest+'.tmp',JSON.stringify(changes),{mode:0o600});
  fs.renameSync(manifest+'.tmp',manifest);
 }
 transfer(installation,cwd,changes);
 for(const name of ['package.json','tsconfig.json','README.md','AGENTS.md'])fs.copyFileSync(safePath(installation,name),safePath(cwd,name));
}

export function changesForRelease(base:Tree,cwd:string){
 const changes=compare(base,files(cwd));
 if(changes.some(entry=>reserved(entry.name)))throw new FishError('DEV_AUTHORITY_FILES_IMMUTABLE');
 return changes;
}

export function restoreAuthorityFiles(installation:string,cwd:string,base:Tree,candidate:Tree){
 const edits=compare(base,candidate).filter(change=>reserved(change.name));
 transfer(installation,cwd,edits.map(({name,old,next})=>({name,old:next,next:old})));
 return edits.map(change=>change.name);
}

export function compiledTree(root:string){
 const result:Tree={};
 const dist=path.join(root,'dist/src');
 if(!fs.existsSync(dist))return result;
 for(const entry of fs.readdirSync(dist,{recursive:true,withFileTypes:true})){
  if(entry.isDirectory())continue;
  const name=path.relative(root,path.join(entry.parentPath,entry.name)).split(path.sep).join('/');
  if(!entry.isFile()||!nameSafe(name)||!/\.js(?:\.map)?$/.test(name))throw new FishError('DEV_UNSAFE_BUILD_OUTPUT');
  result[name]=hash(fs.readFileSync(safePath(root,name)));
 }
 return result;
}

export async function localTrial(root:string,installation:string,cwd:string,harness:string,args:string[],input:unknown,signal:AbortSignal){
 signal.throwIfAborted();
 const spec=linuxSpec(root,cwd,args,{installation,trial:harness});
 return new Promise<{ok:boolean;out:string;error:string}>((resolve,reject)=>{
  const process=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,stdio:['pipe','pipe','pipe'],detached:true});
  let out='',error='';
  const kill=()=>{if(process.pid)try{globalThis.process.kill(-process.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(kill,120000),onAbort=()=>kill();
  signal.addEventListener('abort',onAbort,{once:true});
  process.stdout.setEncoding('utf8').on('data',data=>{out+=data;});
  process.stderr.setEncoding('utf8').on('data',data=>{error+=data;});
  process.stdin.on('error',()=>{});
  process.once('error',err=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);reject(err);});
  process.once('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);resolve({ok:code===0,out,error});});
  process.stdin.end(input===undefined?'':JSON.stringify(input));
 });
}
