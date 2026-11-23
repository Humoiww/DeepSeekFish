import fs from 'node:fs';
import path from 'node:path';
import {safePath} from '../paths.js';
import {diagnosticSafe} from '../diagnostics.js';
import {bridgeRecordKinds,maxRecordBytes,taskIdPattern,type BridgeEvent,type BridgeRecord,type BridgeRecordKind,type BridgeRecordSummary} from './agy-bridge-types.js';

const secret='(?:authorization|cookie|bduss|stoken|skey|password(?:_?md5)?|credential|(?:[a-z0-9]+[_-])*(?:token|api[_-]?key|secret|password|passwd)|client[_-]?secret)';
const secretField=new RegExp('(?:^|[_-])'+secret+'$','i');
const sourcePath=/^(?:(?:home\/fishops\/DeepSeekFish|srv\/deepseekfish\/app)\/)?(?:src|tests|docs|scripts|deploy|assets|prompts|personas)(?:\/[A-Za-z0-9_-]{1,35})+$/;
const evidenceName=(kind:'agy'|'codex',id:string)=>'verification/'+(kind==='agy'?'agy-':'')+id+'.json';

export function bridgeText(value:unknown,limit=2400){
 if(typeof value!=='string'||!value)return undefined;
 return String(diagnosticSafe(value))
  .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,'[凭据省略]')
  .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:Basic|Bearer|Digest)\s+[^\r\n"'\s]+/gi,'$1[凭据省略]')
  .replace(new RegExp('(["\']?'+secret+'["\']?\\s*(?:[:=]|\\s)\\s*)(?:"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|[^\\s,;]+)','gi'),'$1[凭据省略]')
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|ya29\.[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{25,}|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]+)\b/g,'[凭据省略]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[凭据省略]@')
  .replace(/\b[A-Za-z0-9_+/=-]{36,}\b/g,word=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(word)||/^[a-f0-9]{40}$/.test(word)||sourcePath.test(word)?word:'[长凭据或二进制省略]')
  .slice(0,limit);
}

function projected(value:unknown,depth=0):unknown{
 if(depth>5)return undefined;
 if(typeof value==='string')return bridgeText(value,1400);
 if(typeof value==='boolean'||typeof value==='number'||value===null)return value;
 if(Array.isArray(value))return value.slice(0,12).map(item=>projected(item,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,25)
  .filter(([key])=>!secretField.test(key)&&!['thinking','raw_content','encrypted_content','env','environment','output','stdout','stderr'].includes(key))
  .map(([key,item])=>[bridgeText(key,80)??'',projected(item,depth+1)]));
}

const valueText=(value:unknown)=>typeof value==='string'?bridgeText(value):value===undefined?undefined:bridgeText(JSON.stringify(projected(value)));
const contentText=(value:any):string|undefined=>Array.isArray(value)?
 value.filter(item=>['input_text','output_text','text','Text'].includes(item?.type)).map(item=>item.text??item.content).filter(text=>typeof text==='string').join('\n'):
 typeof value==='string'?value:undefined;
const time=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):undefined;

function event(at:number|undefined,role:string,title:string,text?:unknown,exitCode?:unknown):BridgeEvent{
 return {at,role,title,text:valueText(text),...(typeof exitCode==='number'?{exitCode}:{})};
}

function agyEvents(row:any){
 const at=time(row.created_at??row.timestamp);
 if(row.type==='USER_INPUT')return [event(at,'user','输入',contentText(row.content))];
 if(row.type==='PLANNER_RESPONSE'){
  const out:BridgeEvent[]=[];
  if(typeof row.summary==='string'&&row.summary.trim())out.push(event(at,'assistant','思考摘要',row.summary));
  for(const call of (Array.isArray(row.tool_calls)?row.tool_calls:[]).slice(0,12)){
   const name=bridgeText(call?.name,100);
   if(name)out.push(event(at,name==='finish'?'assistant':'tool',name==='finish'?'结构化决策':'调用 '+name,call.args));
  }
  return out;
 }
 if(['FINAL_OUTPUT','ASSISTANT_MESSAGE','MODEL_OUTPUT'].includes(row.type))return [event(at,'assistant','答复',contentText(row.content))];
 return [];
}

function codexEvents(row:any):BridgeEvent[]{
 if(!row||typeof row!=='object')return [];
 const at=time(row.timestamp),p=row.payload??row;
 const item=p.item??(row.type==='item.started'||row.type==='item.completed'?row.item:undefined);
 const kind=item?.type?.toLowerCase().replace(/_/g,'');
 if(kind==='commandexecution'){
  const name=row.type==='item.started'?'开始执行命令':'执行命令';
  const command=bridgeText(item.command,900),output=bridgeText(item.aggregatedOutput??item.aggregated_output,1400);
  return [event(at,'tool',name,[command,output].filter(Boolean).join('\n'),item.exitCode??item.exit_code)];
 }
 if(kind==='filechange'){
  const changes=Array.isArray(item.changes)?item.changes.map((entry:any)=>({path:entry?.path,kind:entry?.kind??entry?.type})):
   Object.keys(item.changes??{});
  return [event(at,'tool','文件改动',changes)];
 }
 if(kind==='reasoning'&&(item.summary??item.summary_text))return [event(at,'assistant','思考摘要',item.summary??item.summary_text)];
 if(kind==='agentmessage'||kind==='usermessage')return [event(at,kind==='agentmessage'?'assistant':'user',
  kind==='agentmessage'?'答复':'任务输入',contentText(item.content??item.text))];
 if(p.type==='message'&&['user','assistant'].includes(p.role)){
  const content=contentText(p.content);
  if(content&&!/^<(?:environment_context|permissions instructions|skills_instructions)>/.test(content.trim())){
   return [event(at,p.role,p.role==='user'?'任务输入':'答复',content)];
  }
 }
 if(p.type==='task_complete')return [event(at,'assistant','最终答复',p.last_agent_message)];
 if(p.type==='function_call'||p.type==='custom_tool_call'){
  return [event(at,'tool','调用 '+(bridgeText(p.name,100)??'工具'),p.arguments??(p.name==='apply_patch'?undefined:p.input))];
 }
 return [];
}

export function liveCodexEvents(row:unknown){return codexEvents(row).filter(item=>item.role==='tool'||item.role==='assistant');}

type Entry={info:BridgeRecordSummary;root:string;file:string};
const agyMarker=/^(?:\/plan )?DeepSeekFish bridge task ([a-f0-9-]{36})\r?$/m;
function recordTask(file:string,kind:'agy'|'codex',workspaces:string){
 const {parts}=readWindow(file,64000,kind==='agy'?32000:0);
 let taskId:string|undefined;
 for(const line of parts.join('\n').split('\n')){
  try{
   const row=JSON.parse(line);
   if(kind==='codex'&&row.type==='session_meta'){
    const cwd=row.payload?.cwd;
    if(typeof cwd!=='string'||path.dirname(cwd)!==workspaces)return;
    const id=path.basename(cwd);
    return taskIdPattern.test(id)?id:undefined;
   }
   if(kind==='agy'&&row.type==='USER_INPUT'){
    const id=agyMarker.exec(contentText(row.content)??'')?.[1];
    if(id&&taskIdPattern.test(id))taskId=id;
   }
  }catch{/* Ignore partial or unrelated rows. */}
 }
 return taskId;
}
const retention=20;
const matchRollout=/^rollout-.*-([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl$/;
const dirs=(directory:string)=>{
 try{return fs.readdirSync(directory,{withFileTypes:true});}
 catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
};

function readWindow(file:string,head:number,tail:number){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const info=fs.fstatSync(fd);
  if(!info.isFile()||info.nlink!==1)throw Error('unsafe record');
  const read=(start:number,count:number)=>{
   const buf=Buffer.alloc(Math.min(count,info.size-start));
   const size=fs.readSync(fd,buf,0,buf.length,start);
   return buf.subarray(0,size).toString('utf8');
  };
  if(info.size<=head+tail)return {parts:[read(0,info.size)],truncated:false};
  const first=read(0,head);
  if(!tail)return {parts:[first],truncated:true};
  const last=read(info.size-tail,tail);
  return {parts:[first.slice(0,first.lastIndexOf('\n')+1),last.slice(last.indexOf('\n')+1)],truncated:true};
 }finally{fs.closeSync(fd);}
}

export class BridgeRecords{
 private cache=new Map<BridgeRecordKind,{at:number;records:Entry[]}>();
 constructor(private root:string,private native:{agy?:string;codex?:string}={}){}
 private entries(kind:BridgeRecordKind){
  const cached=this.cache.get(kind);
  const now=Date.now();
  if(cached&&now-cached.at<900)return cached.records;
  const records:Entry[]=[];
  const folder=(relative:string)=>safePath(this.root,relative);
  const add=(id:string,relative:string,root=this.root)=>{
   try{
    const file=safePath(root,relative),stat=fs.lstatSync(file,{throwIfNoEntry:false});
    if(!stat?.isFile()||stat.nlink!==1)return;
    let taskId=root!==this.root&&kind!=='patch'?recordTask(file,kind,path.join(this.root,'workspaces')):undefined;
    let updatedAt=stat.mtimeMs;
    if(kind!=='patch'){
     const receipt=folder(evidenceName(kind,id));
     const evidence=fs.lstatSync(receipt,{throwIfNoEntry:false});
     if(evidence?.isFile()&&evidence.nlink===1){
      updatedAt=Math.max(updatedAt,evidence.mtimeMs);
      if(kind==='codex'&&!taskId){
       const bound=JSON.parse(readWindow(receipt,60000,0).parts[0])?.taskId;
       if(typeof bound==='string'&&taskIdPattern.test(bound))taskId=bound;
      }
     }
    }
    if(root!==this.root&&!taskId)return;
    records.push({root,file:relative,info:{kind,id,updatedAt,bytes:stat.size,taskId}});
   }catch{/* Ignore a disappeared or linked session. */}
  };
  if(kind==='agy'){
   const visit=(root:string,base:string)=>{
    for(const entry of dirs(base?safePath(root,base):root)){
     if(entry.isDirectory()&&taskIdPattern.test(entry.name)){
      const relative=[base,entry.name,'.system_generated/logs/transcript.jsonl'].filter(Boolean).join('/');
      add(entry.name,relative,root);
     }
    }
   };
   visit(this.root,'agy-sessions/brain');
   if(this.native.agy&&fs.lstatSync(this.native.agy,{throwIfNoEntry:false})?.isDirectory())visit(this.native.agy,'');
  }else if(kind==='codex'){
   const visit=(root:string,relative:string,depth:number)=>{
    for(const entry of dirs(relative?safePath(root,relative):root).sort((a,b)=>b.name.localeCompare(a.name))){
     const file=[relative,entry.name].filter(Boolean).join('/');
     if(depth<3&&entry.isDirectory()&&/^\d{2,4}$/.test(entry.name))visit(root,file,depth+1);
     if(depth===3&&entry.isFile()){
      const match=matchRollout.exec(entry.name);
      if(match)add(match[1],file,root);
     }
    }
   };
   visit(this.root,'codex-sessions/sessions',0);
   if(this.native.codex&&fs.lstatSync(this.native.codex,{throwIfNoEntry:false})?.isDirectory())visit(this.native.codex,'',0);
  }else{
   for(const entry of dirs(folder('patches'))){
    const id=entry.name.replace(/\.patch$/,'');
    if(entry.isFile()&&entry.name.endsWith('.patch')&&taskIdPattern.test(id))add(id,'patches/'+entry.name);
   }
  }
  const seen=new Set<string>();
  const recent=records.sort((a,b)=>b.info.updatedAt-a.info.updatedAt).filter(({info})=>{
   if(seen.has(info.id))return false;
   seen.add(info.id);
   return true;
  }).slice(0,retention);
  this.cache.set(kind,{at:now,records:recent});
  return recent;
 }
 agyProgress(taskId:string){
  const entry=this.entries('agy').find(({info})=>info.taskId===taskId);
  if(!entry)return [];
  const file=safePath(entry.root,entry.file);
  const {parts}=readWindow(file,0,450000);
  const steps:BridgeEvent[]=[];
  let current=false;
  for(const line of parts.join('\n').split('\n')){
   try{
    const row=JSON.parse(line);
    if(row?.type==='USER_INPUT'){
     current=agyMarker.exec(contentText(row.content)??'')?.[1]===taskId;
     if(current)steps.length=0;
    }
    if(current)steps.push(...agyEvents(row).filter(step=>step.role==='tool'));
   }catch{/* Ignore a partial transcript row. */}
  }
  return steps.slice(-55);
 }
 list(){
  return bridgeRecordKinds.flatMap(kind=>this.entries(kind).map(({info})=>info));
 }
 read(kind:BridgeRecordKind,id:string):BridgeRecord|undefined{
  const entry=this.entries(kind).find(item=>item.info.id===id);
  if(!entry)return;
  const record={...entry.info};
  const {parts,truncated}=readWindow(safePath(entry.root,entry.file),kind==='patch'?32000:64000,kind==='patch'?0:450000);
  if(kind==='patch')return {ok:true,record:{...record,taskId:id},steps:[],patch:bridgeText(parts[0],32000)??'',truncated};
  const steps:BridgeEvent[]=[];
  for(const line of parts.join('\n').split('\n')){
   if(!line||line.length>514000)continue;
   try{
    const row=JSON.parse(line);
    const source=kind==='agy'&&row.type==='USER_INPUT'?contentText(row.content):
     kind==='codex'&&row.type==='session_meta'?row.payload?.cwd:undefined;
    if(typeof source==='string'&&!record.taskId){
     const candidate=kind==='agy'?/"taskId"\s*:\s*"([a-f0-9-]{36})"/.exec(source)?.[1]:
      /\/workspaces\/([a-f0-9-]{36})(?:\/|$)/.exec(source)?.[1];
     if(candidate&&taskIdPattern.test(candidate))record.taskId=candidate;
    }
    steps.push(...(kind==='agy'?agyEvents(row):codexEvents(row)));
   }catch{/* An unfinished JSONL line is not a complete event. */}
  }
  {
   const file=safePath(this.root,evidenceName(kind,id));
   try{
    const evidence=JSON.parse(readWindow(file,60000,0).parts[0]);
    if(taskIdPattern.test(evidence.taskId))record.taskId=evidence.taskId;
    for(const step of evidence.steps??[]){
     if(typeof step?.title==='string')steps.push(event(step.at,'bridge',step.title,step.text,step.exitCode));
    }
   }catch{/* Older sessions may have no bridge-side evidence. */}
  }
  const limited=steps.length>55?[...steps.slice(0,5),...steps.slice(-50)]:steps;
  const result:BridgeRecord={ok:true,record,steps:limited,truncated:truncated||steps.length>limited.length};
  while(Buffer.byteLength(JSON.stringify(result))>maxRecordBytes&&limited.length>5){
   limited.splice(5,1);
   result.truncated=true;
  }
  return result;
 }
}
