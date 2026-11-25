import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Parser} from 'htmlparser2';
import {FishError} from '../types.js';
import {hash} from './workspace.js';

const localNotes=['AGENTS.md','InkFishChan.md'];
const ignoredSiteRoots=new Set(['.git','node_modules','.cloudflare',...localNotes]);
const gitPrefix=['--literal-pathspecs','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false'];
const gitEnv={PATH:'/usr/bin:/bin',HOME:process.env.HOME,LANG:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',
 GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1'};
const gitBinary='/usr/bin/git';
type NetworkGit=(command:string,args:string[],env:NodeJS.ProcessEnv,maxMs:number)=>Promise<{
 code:number|null;timedOut:boolean;error:string;output:string;
}>;
type SiteEntry={hash:string};

class SiteError extends FishError {
 constructor(code:string,detail?:string){
  super(code);
  if(detail) this.message=detail;
 }
}

export function siteRoots(cwd:string){
 return fs.readdirSync(cwd).filter(name=>!ignoredSiteRoots.has(name));
}

function localGit(cwd:string,args:string[],code:string){
 const result=spawnSync(gitBinary,[...gitPrefix,...args],{cwd,env:gitEnv,timeout:10000,maxBuffer:12*1024*1024});
 if(result.error||result.status!==0)throw new SiteError(code,(result.error?.message??(result.stderr.toString()||result.stdout.toString().slice(0,2000))).trim());
 return result.stdout;
}

function readGuardedFile(cwd:string,name:string){
 const file=path.join(cwd,name);
 const stat=fs.lstatSync(file,{throwIfNoEntry:false});
 if(!stat&&localNotes.includes(name))return undefined;
 if(!stat?.isFile()||stat.nlink!==1||stat.size>1024*1024)throw new SiteError('DEV_AGY_SITE_METADATA_CHANGED',name);
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{return hash(fs.readFileSync(fd));}finally{fs.closeSync(fd);}
}

export class AgySite {
 private readonly metadata:Map<string,string|undefined>;
 private head:string;
 readonly hasLocalBuild:boolean;

 private constructor(readonly cwd:string,private network:NetworkGit){
  const code='DEV_AGY_SITE_REPOSITORY_INVALID';
  if(!fs.lstatSync(cwd,{throwIfNoEntry:false})?.isDirectory()||
    !fs.lstatSync(path.join(cwd,'.git'),{throwIfNoEntry:false})?.isDirectory()||
    this.git(['rev-parse','--show-toplevel'],code)!==cwd)throw new SiteError(code,cwd);
  this.metadata=new Map(['.git/config',...localNotes].map(name=>[name,readGuardedFile(cwd,name)]));
  this.head=this.git(['rev-parse','--verify','HEAD'],code);
  this.hasLocalBuild=fs.existsSync(path.join(cwd,'node_modules/.bin/cf'));
 }

 static async prepare(cwd:string,network:NetworkGit){
  const site=new AgySite(cwd,network);
  site.assertUnstaged();
  if(site.git(['status','--porcelain','--untracked-files=all'],'DEV_AGY_SITE_STATUS_FAILED')){
   throw new SiteError('DEV_AGY_SITE_DIRTY','小屋工作区有未提交的改动，请先处理。');
  }
  await site.remote(['fetch','origin','main'],'DEV_AGY_SITE_FETCH_FAILED');
  site.assertUnstaged();
  const remote=site.git(['rev-parse','--verify','refs/remotes/origin/main'],'DEV_AGY_SITE_FETCH_FAILED');
  if(remote!==site.git(['rev-parse','--verify','FETCH_HEAD'],'DEV_AGY_SITE_FETCH_FAILED')){
   throw new SiteError('DEV_AGY_SITE_FETCH_FAILED','FETCH_HEAD 与 origin/main 不一致。');
  }
  if(remote!==site.head){
   site.git(['merge-base','--is-ancestor',site.head,remote],'DEV_AGY_SITE_BASE_DIVERGED');
   site.git(['merge','--ff-only','refs/remotes/origin/main'],'DEV_AGY_SITE_FAST_FORWARD_FAILED');
   site.head=remote;
  }
  site.assertUnstaged();
  if(site.git(['status','--porcelain','--untracked-files=all'],'DEV_AGY_SITE_STATUS_FAILED')){
   throw new SiteError('DEV_AGY_SITE_DIRTY','同步后小屋工作区出现未提交的改动。');
  }
  return site;
 }

 private git(args:string[],code:string){
  return localGit(this.cwd,args,code).toString().trim();
 }

 private assertUnstaged(){
  if(!fs.lstatSync(path.join(this.cwd,'.git'),{throwIfNoEntry:false})?.isDirectory()){
   throw new SiteError('DEV_AGY_SITE_METADATA_CHANGED','.git');
  }
  for(const [name,original] of this.metadata){
   if(readGuardedFile(this.cwd,name)!==original)throw new SiteError('DEV_AGY_SITE_METADATA_CHANGED',name);
  }
  if(this.git(['branch','--show-current'],'DEV_AGY_SITE_BRANCH_CHANGED')!=='main'){
   throw new SiteError('DEV_AGY_SITE_BRANCH_CHANGED','小屋检出必须处于 main。');
  }
  if(this.git(['rev-parse','HEAD'],'DEV_AGY_SITE_HEAD_CHANGED')!==this.head){
   throw new SiteError('DEV_AGY_SITE_HEAD_CHANGED','本地 HEAD 已发生变化。');
  }
  this.git(['diff','--cached','--quiet','HEAD','--'],'DEV_AGY_SITE_INDEX_CHANGED');
 }

 original(name:string){
  return localGit(this.cwd,['cat-file','blob',this.head+':'+name],'DEV_AGY_SITE_DIFF_CHECK_FAILED');
 }

 check(changed:string[]){
  this.assertUnstaged();
  this.git(['diff','--check','--',...changed],'DEV_AGY_SITE_DIFF_CHECK_FAILED');
 }

 private async remote(args:string[],code:string){
  const result=await this.network(gitBinary,[...gitPrefix,...args],gitEnv,60000);
  if(result.code!==0||result.timedOut){
   const detail=[result.timedOut?'Git 请求超过 60 秒，远端状态需要核对。':'',result.error,result.output].filter(Boolean).join('\n');
   throw new SiteError(code,detail.trim());
  }
 }

 async publish(taskId:string,changed:string[],after:ReadonlyMap<string,SiteEntry>){
  this.assertUnstaged();
  this.git(['add','-A','--',...changed],'DEV_AGY_SITE_ADD_FAILED');
  this.git(['diff','--cached','--check','HEAD','--'],'DEV_AGY_SITE_DIFF_CHECK_FAILED');
  const staged=localGit(this.cwd,['diff','--cached','--name-only','--no-renames','-z','HEAD','--'],'DEV_AGY_SITE_INDEX_CHANGED')
   .toString().split('\0').filter(Boolean).sort();
  if(staged.length!==changed.length||staged.some((name,index)=>name!==changed[index])){
   throw new SiteError('DEV_AGY_SITE_INDEX_CHANGED','暂存区与已审阅的文件列表不一致。');
  }
  for(const name of staged){
   const expected=after.get(name);
   if(!expected)continue;
   const blob=localGit(this.cwd,['cat-file','blob',':'+name],'DEV_AGY_SITE_INDEX_CHANGED');
   if(hash(blob)!==expected.hash)throw new SiteError('DEV_AGY_SITE_INDEX_CHANGED',name);
  }
  const tree=this.git(['write-tree'],'DEV_AGY_SITE_COMMIT_FAILED');
  this.git(['commit','-m','Update InkFishChan site ('+taskId.slice(0,8)+')'],'DEV_AGY_SITE_COMMIT_FAILED');
  const head=this.git(['rev-parse','HEAD'],'DEV_AGY_SITE_COMMIT_FAILED');
  if(this.git(['rev-parse',head+'^{tree}'],'DEV_AGY_SITE_COMMIT_FAILED')!==tree||
    this.git(['rev-parse',head+'^'],'DEV_AGY_SITE_COMMIT_FAILED')!==this.head){
   throw new SiteError('DEV_AGY_SITE_COMMIT_FAILED','提交内容或父提交与验收结果不一致。');
  }
  const commit=this.git(['rev-parse','--short',head],'DEV_AGY_SITE_COMMIT_FAILED');
  // Push the reviewed commit even if a concurrent local command moves main.
  return {commit,push:()=>this.remote(['push','origin',head+':refs/heads/main'],'DEV_AGY_SITE_PUSH_FAILED')};
 }
}

export function siteHtmlIssues(html:string){
 const issues=new Set<string>();
 const parser=new Parser({onopentag(name,attributes){
  if(name==='script'&&!attributes.src)issues.add('内联 script');
  if(name==='style'||Object.hasOwn(attributes,'style'))issues.add('内联样式');
  for(const [attribute,value] of Object.entries(attributes)){
   if(/^on[a-z]/.test(attribute))issues.add('内联事件处理器');
   if(/^javascript:/i.test(value.replace(/[\t\n\r]/g,'').trimStart()))issues.add('javascript: URL');
  }
 }});
 parser.end(html);
 return [...issues];
}
