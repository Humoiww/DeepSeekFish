import fs from 'node:fs';
import { makeDir,safePath,writePrivate } from '../paths.js';
import { redact } from '../storage/db.js';

export interface CodexRecord {
  id:string;startedAt:number;finishedAt?:number;outcome:string;
  request:{prompt:string;imageGeneration:boolean;referencePath?:string};
  threadId?:string;turnId?:string;model?:string;
  events:{at:number;method:string;detail:unknown}[];
  messages:{id:string;phase?:string;text:string}[];
  images:unknown[];finalText?:string;error?:string;
  delivery?:{ok:boolean;error?:string;nativeImageCompletions?:number};
}
function clean(value:unknown):any{
  if(typeof value==='string')return redact(value.slice(0,12000))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[REDACTED JWT]')
    .replace(/("?(?:refresh_token|id_token|access_token|api_key|authorization|cookie)"?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,'$1[REDACTED]')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,'[image data omitted]');
  if(Array.isArray(value))return value.slice(0,100).map(clean);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,32).map(([k,v])=>[k,/^(?:result|access_token|refresh_token|id_token|api_key|authorization|cookie)$/i.test(k)?'[omitted]':clean(v)]));
  return value;
}
export function saveCodexRecord(root:string,record:CodexRecord):void{
  try{
    if(!/^[a-z0-9-]{1,64}$/.test(record.id))return;
    makeDir(root,'runtime/logs/codex');
    const name='runtime/logs/codex/'+record.id+'.json',tmp=name+'.tmp';
    const safe=clean(record);
    if(Buffer.byteLength(JSON.stringify(safe))>200000){
      safe.truncated=true;safe.request.prompt=safe.request.prompt.slice(0,4000);
      safe.messages=safe.messages.slice(-4).map((m:any)=>({...m,text:m.text.slice(0,4000)}));
      safe.events=safe.events.slice(-20).map((e:any)=>({...e,detail:{omittedForSize:true}}));
      safe.finalText=safe.finalText?.slice(0,8000);
    }
    writePrivate(root,tmp,JSON.stringify(safe,null,2)+'\n');
    fs.renameSync(safePath(root,tmp),safePath(root,name));
  }catch{console.error('CODEX_RECORD_WRITE_FAILED');}
}
export function readCodexRecord(root:string,id:string):CodexRecord|undefined{
  try{
    if(!/^[a-z0-9-]{1,64}$/.test(id))return;
    const file=safePath(root,'runtime/logs/codex/'+id+'.json');
    if(fs.statSync(file).size>262144)return;
    return JSON.parse(fs.readFileSync(file,'utf8'));
  }catch{return;}
}
export class CodexDiagnostics {
  readonly record:CodexRecord;private lastSave=0;
  constructor(private root:string,id:string,prompt:string,imageGeneration:boolean,referencePath?:string){
    this.record={id,startedAt:Date.now(),outcome:'running',request:{prompt:clean(prompt),imageGeneration,referencePath},events:[],messages:[],images:[]};this.save(true);
  }
  private save(force=false){if(force||Date.now()-this.lastSave>250){saveCodexRecord(this.root,this.record);this.lastSave=Date.now();}}
  event(method:string,detail:unknown={}){if(this.record.events.length<100)this.record.events.push({at:Date.now(),method,detail:clean(detail)});this.save(['turn-requested','rpc-error','server-request'].includes(method));}
  stderr(text:string){
    const lines=text.replace(/\u001b\[[0-9;]*m/g,'').split('\n').filter(line=>/warn|error|failed|denied|panic|unavailable|permission/i.test(line));
    if(lines.length)this.event('process-stderr',{text:lines.join('\n').slice(0,4000)});
  }
  message(id:string,text:string,phase?:string,append=false){
    let message=this.record.messages.find(m=>m.id===id);
    if(!message){if(this.record.messages.length>=12)return;message={id,text:''};this.record.messages.push(message);}
    message.text=clean((append?message.text:'')+text);if(phase)message.phase=phase;this.save();
  }
  notice(method:string,p:any){
    if(method==='item/agentMessage/delta'&&typeof p.delta==='string'){this.message(p.itemId??'stream',p.delta,undefined,true);return;}
    const item=p?.item;
    this.event(method,{threadId:p?.threadId,turnId:p?.turnId??p?.turn?.id,itemId:item?.id,type:item?.type,status:item?.status??p?.turn?.status,
      name:item?.name,tool:item?.tool,server:item?.server,arguments:item?.arguments,command:item?.command,error:p?.error??p?.turn?.error??item?.error});
    if(method==='turn/started')this.record.turnId=p?.turn?.id;
    if(method==='item/completed'&&item?.type==='agentMessage')this.message(item.id,String(item.text??''),item.phase);
    if(method==='item/completed'&&item?.type==='imageGeneration'){
      if(this.record.images.length<4)this.record.images.push(clean({id:item.id,status:item.status,savedPath:item.savedPath,inputImages:item.inputImages,failure:item.failure,inlineBytes:typeof item.result==='string'?item.result.length:0,hasFileId:!!item.fileId}));
      this.save(true);
    }
  }
  finish(finalText:string,error?:string){this.record.finishedAt=Date.now();this.record.outcome=error?'failed':'returned';this.record.finalText=clean(finalText);this.record.error=error;this.save(true);}
}
