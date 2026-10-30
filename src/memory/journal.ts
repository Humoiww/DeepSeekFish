import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { makeDir,safePath } from '../paths.js';
import { Store,redact } from '../storage/db.js';
import type { Message } from '../types.js';
import { PROJECT_TIMEZONE } from '../time.js';

const DAY=86400000,OFFSET=8*3600000;
export function memoryDay(at=Date.now()):string{return new Date(at+OFFSET).toISOString().slice(0,10);}
export function dayStart(at=Date.now()):number{return Math.floor((at+OFFSET)/DAY)*DAY-OFFSET;}
export interface MemoryEvent {id:string;conversation:string;actor:string;role:'user'|'assistant';text:string;at:number;source?:string}
export interface RecallScope {mode:'recent'|'date'|'search';since:number;until?:number;term?:string;needsReference?:boolean}
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
  }
  record(event:MemoryEvent):void{
    const clean={...event,text:redact(event.text).slice(0,16000)},day=memoryDay(event.at);
    const changed=this.store.db.prepare('INSERT OR IGNORE INTO memory_events(event_id,conversation,actor,role,text,observed,day,source) VALUES (?,?,?,?,?,?,?,?)')
      .run(clean.id,clean.conversation,clean.actor,clean.role,clean.text,clean.at,day,clean.source??'qq').changes;
    if(!changed)return;
    const folder=makeDir(this.root,'runtime/memory/days/'+day),name=createHash('sha256').update(event.conversation).digest('hex').slice(0,24)+'.jsonl';
    const file=safePath(folder,name),fd=fs.openSync(file,fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{if(fs.fstatSync(fd).nlink!==1)throw Error('MEMORY_LINK_REJECTED');fs.writeSync(fd,JSON.stringify({...clean,day})+'\n');}finally{fs.closeSync(fd);}
  }
  backfill():void{
    for(const row of this.store.db.prepare('SELECT * FROM messages ORDER BY at,rowid').all() as any[])
      this.record({id:row.id,conversation:row.grp,actor:row.usr,role:row.usr==='DeepSeekFish'?'assistant':'user',text:row.text,at:row.at,source:'existing-chat-window'});
  }
  recall(conversation:string,query:string,exclude:Pick<Message,'id'>[]=[],now=Date.now()){
    const scope=recallScope(query,now),params:any[]=[conversation,scope.since];let where='conversation=? AND observed>=?';
    if(scope.until!==undefined){where+=' AND observed<?';params.push(scope.until);}
    if(scope.term){where+=' AND instr(lower(text),lower(?))>0';params.push(scope.term);}
    const rows=this.store.db.prepare(`SELECT event_id AS id,actor,role,text,observed AS at,source FROM memory_events WHERE ${where} ORDER BY observed DESC,seq DESC LIMIT 80`).all(...params) as any[];
    const skipped=new Set(exclude.map(m=>m.id)),selected:any[]=[];let bytes=0;
    for(const row of rows){if(skipped.has(row.id))continue;const text=String(row.text).slice(0,2000),cost=Buffer.byteLength(text)+160;if(bytes+cost>12000)continue;bytes+=cost;selected.push({...row,text});}
    return {timezone:PROJECT_TIMEZONE,...scope,events:selected.reverse(),archiveRetained:true};
  }
}
