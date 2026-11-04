import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { makeDir,safePath } from '../paths.js';
import { Store,redact,senderNames } from '../storage/db.js';
import { FishError,type Message,type ModelTool } from '../types.js';
import { PROJECT_TIMEZONE } from '../time.js';

const DAY=86400000,OFFSET=8*3600000;
export function memoryDay(at=Date.now()):string{return new Date(at+OFFSET).toISOString().slice(0,10);}
export function dayStart(at=Date.now()):number{return Math.floor((at+OFFSET)/DAY)*DAY-OFFSET;}
export interface MemoryEvent {id:string;conversation:string;actor:string;role:'user'|'assistant';text:string;at:number;source?:string;sender?:Message['sender'];replyTo?:string}
function storedEvent(row:any){const {sender,reply_to,...event}=row;return {...event,...(sender?{sender:senderNames(JSON.parse(sender))}:{}),...(reply_to?{replyTo:reply_to}:{})};}
export interface RecallScope {mode:'recent'|'date'|'search';since:number;until?:number;term?:string;needsReference?:boolean}
export const recallTools:ModelTool[]=[{type:'function',function:{name:'recall_chat',description:'需要回看旧聊天时检索当前会话。默认今天和昨天；query 关键词或 date 香港日期 YYYY-MM-DD 可查更早记录。offset 翻更早的6条，messageId/textOffset 续读单条全文。',parameters:{type:'object',properties:{query:{type:'string',maxLength:100},date:{type:'string'},offset:{type:'integer',minimum:0},messageId:{type:'string'},textOffset:{type:'integer',minimum:0}},additionalProperties:false}}}];
export function recallScope(query:string,now=Date.now()):RecallScope{
  const recent:RecallScope={mode:'recent',since:dayStart(now)-DAY};
  const date=/(20\d{2})[年/-](\d{1,2})[月/-](\d{1,2})日?/.exec(query);
  if(date){const since=Date.UTC(Number(date[1]),Number(date[2])-1,Number(date[3]))-OFFSET;
    if(memoryDay(since)===`${date[1]}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}`)return {mode:'date',since,until:since+DAY};}
  if(/前天/.test(query))return {mode:'date',since:dayStart(now)-2*DAY,until:dayStart(now)-DAY};
  if(/昨天|昨日/.test(query))return {mode:'date',since:dayStart(now)-DAY,until:dayStart(now)};
  if(/今天|今日/.test(query))return {mode:'date',since:dayStart(now),until:dayStart(now)+DAY};
  if(/上(?:个)?星期|上周/.test(query)){
    const weekday=(new Date(now+OFFSET).getUTCDay()+6)%7,monday=dayStart(now)-weekday*DAY;
    return {mode:'date',since:monday-7*DAY,until:monday};
  }
  if(/上个月/.test(query)){
    const date=new Date(now+OFFSET),month=Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)-OFFSET;
    return {mode:'date',since:Date.UTC(date.getUTCFullYear(),date.getUTCMonth()-1,1)-OFFSET,until:month};
  }
  const quoted=/[“「『"]([^”」』"]{2,40})[”」』"]/.exec(query)?.[1];
  if(/还记得|回忆|之前|以前|上次|历史|那天/.test(query)){
    const term=quoted??query.replace(/你还记得|还记得|帮我|回忆一下|回忆|之前|以前|上次|我们|我说过的|说过|说的|提到的|提到|那个|那件事|事情|一下|什么|关于|吗|呢|么|[，。？！?！\s]/g,'').slice(0,40);
    if(term.length>=2)return {mode:'search',since:0,term};
    return {...recent,needsReference:true};
  }
  return recent;
}
export class MemoryJournal {
  constructor(private root:string,private store:Store){
    makeDir(root,'runtime/memory/days');
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_events(seq INTEGER PRIMARY KEY,event_id TEXT,conversation TEXT,actor TEXT,role TEXT,text TEXT,observed INTEGER,day TEXT,source TEXT,UNIQUE(conversation,event_id));
      CREATE INDEX IF NOT EXISTS memory_scope_time ON memory_events(conversation,observed);
      CREATE TABLE IF NOT EXISTS person_observations(id TEXT PRIMARY KEY,conversation TEXT,person TEXT,observed INTEGER,kind TEXT,data TEXT);
      CREATE INDEX IF NOT EXISTS person_scope_time ON person_observations(conversation,person,observed);`);
    store.transaction(()=>{
      const columns=store.db.prepare('PRAGMA table_info(memory_events)').all() as any[];
      for(const name of ['sender','reply_to'])if(!columns.some(c=>c.name===name))store.db.exec('ALTER TABLE memory_events ADD COLUMN '+name+' TEXT');
    });
  }
  record(event:MemoryEvent):void{
    const clean={...event,sender:senderNames(event.sender),text:redact(event.text).slice(0,16000)},day=memoryDay(event.at);
    const changed=this.store.db.prepare('INSERT OR IGNORE INTO memory_events(event_id,conversation,actor,role,text,observed,day,source,sender,reply_to) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(clean.id,clean.conversation,clean.actor,clean.role,clean.text,clean.at,day,clean.source??'qq',JSON.stringify(clean.sender??null),clean.replyTo??null).changes;
    if(!changed)return;
    const folder=makeDir(this.root,'runtime/memory/days/'+day),name=createHash('sha256').update(event.conversation).digest('hex').slice(0,24)+'.jsonl';
    const file=safePath(folder,name),fd=fs.openSync(file,fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{if(fs.fstatSync(fd).nlink!==1)throw Error('MEMORY_LINK_REJECTED');fs.writeSync(fd,JSON.stringify({...clean,day})+'\n');}finally{fs.closeSync(fd);}
  }
  backfill():void{
    for(const row of this.store.db.prepare('SELECT * FROM messages ORDER BY at,rowid').all() as any[])
      this.record({id:row.id,conversation:row.grp,actor:row.usr,role:row.usr==='DeepSeekFish'?'assistant':'user',text:row.text,at:row.at,source:'existing-chat-window',sender:row.sender?senderNames(JSON.parse(row.sender)):undefined,replyTo:row.reply_to??undefined});
  }
  read(conversation:string,args:any,now=Date.now()){
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['query','date','offset','messageId','textOffset'].includes(k))||
      args.query!==undefined&&(typeof args.query!=='string'||args.query.length>100)||
      !Number.isSafeInteger(args.offset??0)||(args.offset??0)<0||!Number.isSafeInteger(args.textOffset??0)||(args.textOffset??0)<0)
      throw new FishError('INVALID_TOOL_ARGS');
    const columns='event_id AS id,actor,role,text,observed AS at,source,sender,reply_to';
    if(args.messageId!==undefined){
      if(typeof args.messageId!=='string'||args.query!==undefined||args.date!==undefined||args.offset!==undefined)throw new FishError('INVALID_TOOL_ARGS');
      const row=this.store.db.prepare(`SELECT ${columns} FROM memory_events WHERE conversation=? AND event_id=?`).get(conversation,args.messageId) as any;
      if(!row)throw new FishError('MEMORY_NOT_FOUND');
      const offset=args.textOffset??0,text=String(row.text).slice(offset,offset+2000);
      return {timezone:PROJECT_TIMEZONE,events:[{...storedEvent(row),text}],textOffset:offset,nextTextOffset:offset+text.length<row.text.length?offset+text.length:null};
    }
    if(args.textOffset!==undefined)throw new FishError('INVALID_TOOL_ARGS');
    const params:any[]=[conversation];let where='conversation=?';
    if(args.date!==undefined){
      if(typeof args.date!=='string'||!/^20\d{2}-\d{2}-\d{2}$/.test(args.date))throw new FishError('INVALID_TOOL_ARGS');
      const start=Date.parse(args.date+'T00:00:00+08:00');
      if(!Number.isFinite(start)||memoryDay(start)!==args.date)throw new FishError('INVALID_TOOL_ARGS');
      where+=' AND observed>=? AND observed<?';params.push(start,start+DAY);
    }else if(!args.query?.trim()){where+=' AND observed>=?';params.push(dayStart(now)-DAY);}
    if(args.query?.trim()){where+=' AND instr(lower(text),lower(?))>0';params.push(args.query.trim());}
    const offset=args.offset??0;
    const rows=this.store.db.prepare(`SELECT ${columns} FROM memory_events WHERE ${where} ORDER BY observed DESC,seq DESC LIMIT 7 OFFSET ?`).all(...params,offset) as any[];
    return {timezone:PROJECT_TIMEZONE,events:rows.slice(0,6).reverse().map(row=>({...storedEvent(row),text:String(row.text).slice(0,1500),...(row.text.length>1500?{nextTextOffset:1500}:{})})),offset,nextOffset:rows.length>6?offset+6:null};
  }
  recall(conversation:string,query:string,exclude:Pick<Message,'id'>[]=[],now=Date.now()){
    const scope=recallScope(query,now),params:any[]=[conversation,scope.since];let where='conversation=? AND observed>=?';
    if(scope.until!==undefined){where+=' AND observed<?';params.push(scope.until);}
    if(scope.term){where+=' AND instr(lower(text),lower(?))>0';params.push(scope.term);}
    const rows=this.store.db.prepare(`SELECT event_id AS id,actor,role,text,observed AS at,source,sender,reply_to FROM memory_events WHERE ${where} ORDER BY observed DESC,seq DESC LIMIT 80`).all(...params) as any[];
    const skipped=new Set(exclude.map(m=>m.id)),selected:any[]=[];let bytes=0;
    for(const row of rows){if(skipped.has(row.id))continue;const text=String(row.text).slice(0,2000),cost=Buffer.byteLength(text)+160;if(bytes+cost>12000)continue;bytes+=cost;selected.push({...storedEvent(row),text});}
    return {timezone:PROJECT_TIMEZONE,...scope,events:selected.reverse(),archiveRetained:true};
  }
}
