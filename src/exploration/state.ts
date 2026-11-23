import {randomUUID,randomInt} from 'node:crypto';
import {redact,type Store} from '../storage/db.js';
import {sanitizeGroupName} from '../memory/group-names.js';
import {ProviderError} from '../diagnostics.js';
import {FishError} from '../types.js';
import {conversationAllowed,type Config} from '../config.js';
import {publicUrl} from '../search/provider.js';
import {dailyPostHint,setDailyPostHint} from '../tieba/daily-post.js';
import {tiebaReplyBadge} from '../tieba/reply-badge.js';
import type {PublishInput} from '../tieba/posting.js';
import {importExplorationLinks,rememberExplorationLinks} from './links.js';

export const random=()=>randomInt(0,0x100000000)/0x100000000;
export type ExplorationSettings={enabled:boolean;owner:string;minMinutes:number;maxMinutes:number;probability:number;maxRunMinutes:number;runTokens:number;allowImages:boolean;allowPublicPosts:boolean};
export const explorationDefaults:ExplorationSettings={enabled:false,owner:'',minMinutes:9,maxMinutes:11,probability:0.028,maxRunMinutes:60,runTokens:0,allowImages:false,allowPublicPosts:false};
export const interval=(s:ExplorationSettings,rng=random)=>Math.round((s.minMinutes+(s.maxMinutes-s.minMinutes)*rng())*60000);
export const expectedPerDay=(s:ExplorationSettings)=>1440/((s.minMinutes+s.maxMinutes)/2)*s.probability;
export type ExplorationRun={id:string;owner:string;trigger:string;state:string;created:number;started:number|null;finished:number|null;lease:number;lock:string|null;error:string|null;tokens:number;web_tokens:number;web_nano:number;unknown_tokens:number;shared:number;note:string|null;cancel:number;instruction?:string|null};
const active="state IN ('queued','running')";
export type CuriosityOrigin={originKind:'exploration'|'group'|'private';groupName?:string|null;conversation?:string|null};
export function ensureCuriositySchema(store:Store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS curiosity_entries(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL,removed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS curiosity_revisions(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,run_id TEXT NOT NULL,version INTEGER NOT NULL,at INTEGER NOT NULL,entry TEXT NOT NULL);`);
 const migrate=()=>{
  const columns=store.db.prepare('PRAGMA table_info(curiosity_entries)').all();
  for(const name of ['origin_kind','group_name','conversation'])if(!columns.some(c=>c.name===name))store.db.exec('ALTER TABLE curiosity_entries ADD COLUMN '+name+' TEXT');
 };
 if(store.db.isTransaction)migrate();else store.transaction(migrate);
}
/** Old entries and revisions are untrusted too. Public reads project fields
 * explicitly and remove account-shaped numbers even from legacy free text. */
export function curiosityPublicText(text:string,accounts:readonly string[]=[]){
 const privateNumbers=new Set(accounts.map(account=>account.replace(/^(?:private|group):/,'')));
 const sanitize=(value:string)=>redact(value).normalize('NFKC').replace(/(?:private:|group:)\S+/gi,'[会话已隐去]')
  .replace(/(?:QQ|群号|群号码|帐号|账号)\s*[:：=]?\s*[0-9]{1,20}/gi,'[账号已隐去]')
  .replace(/[0-9]+/g,number=>number.length>=5||privateNumbers.has(number)?'[号码已隐去]':number);
 const decoded=text.replace(/(?:%[0-9a-f]{2})+/gi,part=>{
  try{return decodeURIComponent(part);}catch{return part;}
 });
 const clean=sanitize(decoded);
 return clean===decoded?sanitize(text):clean;
}
function publicEntry(row:any,accounts:readonly string[]=[]){
 const safe=(text:string)=>curiosityPublicText(text,[...accounts,String(row.conversation??'')]);
 const sources=typeof row.sources==='string'?JSON.parse(row.sources):row.sources??[];
 return {id:row.id,title:safe(String(row.title??'')),
  ...(row.content!==undefined?{content:safe(String(row.content))}:{}),
  preview:safe(String(row.preview??row.content??'')).slice(0,500),
  sources:sources.filter((url:unknown)=>typeof url==='string'&&publicUrl(url)&&safe(url)===url),
  ...(row.created!==undefined?{created:row.created}:{}),...(row.updated!==undefined?{updated:row.updated}:{}),
  version:row.version,removed:row.removed,
  ...(row.origin_kind??row.originKind?{originKind:row.origin_kind??row.originKind}:{}),
  ...(row.group_name??row.groupName?{groupName:safe(sanitizeGroupName(row.group_name??row.groupName)??'')}:{}),};
}
export function readCuriosity(store:Store,args:any={},accounts:readonly string[]=[]){
 ensureCuriositySchema(store);
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['id','query','offset','removed'].includes(k))||
  args.id!==undefined&&(typeof args.id!=='string'||args.id.length>80)||args.removed!==undefined&&typeof args.removed!=='boolean'||
  !Number.isSafeInteger(args.offset??0)||(args.offset??0)<0||args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200))throw new FishError('INVALID_TOOL_ARGS');
 if(args.id){
  const row=store.db.prepare('SELECT * FROM curiosity_entries WHERE id=?').get(args.id);
  if(!row)throw new ProviderError('CURIOSITY_NOT_FOUND',{stage:'lookup_entry'});
  const revisions=store.db.prepare('SELECT version,at,entry FROM curiosity_revisions WHERE id=? ORDER BY version DESC LIMIT 10').all(args.id);
  return {entry:publicEntry(row,accounts),revisions:revisions.map(r=>({version:r.version,at:r.at,entry:publicEntry(JSON.parse(String(r.entry)),[...accounts,String(row.conversation??'')])}))};
 }
 const rows=store.db.prepare("SELECT id,title,substr(content,1,500) AS preview,sources,updated,version,removed,origin_kind,group_name,conversation FROM curiosity_entries WHERE removed=? AND (?='' OR instr(lower(title||content),lower(?))>0) ORDER BY updated DESC,id LIMIT 11 OFFSET ?")
  .all(Number(args.removed===true),args.query??'',args.query??'',args.offset??0);
 return {entries:rows.slice(0,10).map(row=>publicEntry(row,accounts)),nextOffset:rows.length>10?(args.offset??0)+10:null};
}
export function writeCuriosity(store:Store,run:string,args:any,now=Date.now(),origin?:CuriosityOrigin){
 ensureCuriositySchema(store);
 if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['id','version','title','content','sources','remove'].includes(k))||args.id!==undefined&&typeof args.id!=='string'||args.remove!==undefined&&typeof args.remove!=='boolean')throw new FishError('INVALID_TOOL_ARGS');
 const write=()=>{
  const old=args.id?store.db.prepare('SELECT * FROM curiosity_entries WHERE id=?').get(args.id):undefined;
  if(args.id&&!old)throw new ProviderError('CURIOSITY_NOT_FOUND',{stage:'lookup_entry'});
  if(old&&args.version!==old.version)throw new ProviderError('CURIOSITY_VERSION_CHANGED',{stage:'check_entry_version',currentVersion:old.version,submittedVersion:Number.isSafeInteger(args.version)?args.version:null});
  const title=args.title??old?.title,content=args.content??old?.content,sources=args.sources??(old?JSON.parse(String(old.sources)):[]);
  if(typeof title!=='string'||!title.trim()||title.length>200||typeof content!=='string'||content.length>32000||!Array.isArray(sources)||sources.length>50||sources.some(u=>typeof u!=='string'||u.length>8192||!publicUrl(u)))throw new FishError('CURIOSITY_ENTRY_INVALID');
  const id=old?.id??randomUUID(),version=Number(old?.version??0)+1,originKind=origin?.originKind??old?.origin_kind??'exploration',
   groupName=origin?sanitizeGroupName(origin.groupName)??null:old?.group_name??null,conversation=origin?.conversation??old?.conversation??null,
   entry={id,title,content,sources,removed:args.remove??false,version,originKind,...(groupName?{groupName}:{})};
  store.db.prepare(`INSERT INTO curiosity_entries(id,title,content,sources,created,updated,version,removed,origin_kind,group_name,conversation) VALUES (?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,sources=excluded.sources,updated=excluded.updated,version=excluded.version,removed=excluded.removed,origin_kind=excluded.origin_kind,group_name=excluded.group_name,conversation=excluded.conversation`)
   .run(id,title,content,JSON.stringify(sources),old?.created??now,now,version,Number(entry.removed),originKind,groupName,conversation);
  store.db.prepare('INSERT INTO curiosity_revisions(id,run_id,version,at,entry) VALUES (?,?,?,?,?)').run(id,run,version,now,JSON.stringify(entry));return entry;
 };
 return store.db.isTransaction?write():store.transaction(write);
}
export class ExplorationState{
  constructor(public store:Store,private cfg:()=>Config,private now=Date.now,private rng=random){
    store.db.exec(`CREATE TABLE IF NOT EXISTS exploration_schedule(id INTEGER PRIMARY KEY CHECK(id=1),next_check INTEGER,last_check INTEGER,checks INTEGER NOT NULL DEFAULT 0,hits INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO exploration_schedule(id) VALUES (1);
      CREATE TABLE IF NOT EXISTS exploration_runs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,trigger TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,started INTEGER,finished INTEGER,lease INTEGER NOT NULL DEFAULT 0,lock TEXT,error TEXT,tokens INTEGER NOT NULL DEFAULT 0,shared INTEGER NOT NULL DEFAULT 0,note TEXT,cancel INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS exploration_one_active ON exploration_runs((1)) WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS exploration_effects(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,owner TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,result TEXT);
      CREATE INDEX IF NOT EXISTS exploration_effect_lookup ON exploration_effects(owner,fingerprint,state);
      CREATE TABLE IF NOT EXISTS curiosity_entries(id TEXT PRIMARY KEY,title TEXT NOT NULL,content TEXT NOT NULL,sources TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL,removed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS curiosity_revisions(seq INTEGER PRIMARY KEY,id TEXT NOT NULL,run_id TEXT NOT NULL,version INTEGER NOT NULL,at INTEGER NOT NULL,entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exploration_proposals(task_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,created INTEGER NOT NULL);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS exploration_observations(run_id TEXT NOT NULL,step INTEGER NOT NULL,tool TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(run_id,step))');
    store.transaction(()=>{if(!store.db.prepare('PRAGMA table_info(exploration_runs)').all().some((c:any)=>c.name==='instruction'))store.db.exec('ALTER TABLE exploration_runs ADD COLUMN instruction TEXT');
    for(const column of ['web_tokens','unknown_tokens','web_nano'])if(!store.db.prepare('PRAGMA table_info(exploration_runs)').all().some((c:any)=>c.name===column))store.db.exec('ALTER TABLE exploration_runs ADD COLUMN '+column+' INTEGER NOT NULL DEFAULT 0');
    store.db.exec("UPDATE exploration_runs SET state='failed' WHERE state='paused' AND finished IS NOT NULL AND error IS NOT NULL");});
    ensureCuriositySchema(store);
    importExplorationLinks(store);
  }
  settings():ExplorationSettings{
    const configured=JSON.parse(this.store.getMeta('exploration:settings')??'{}'),users=this.cfg().privateUsers;
    return {...explorationDefaults,owner:users.length===1?users[0]:'',...configured};
  }
  save(input:any){
    const previous=this.settings(),s={...previous,...input};
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!Object.hasOwn(explorationDefaults,k))||
      ['enabled','allowImages','allowPublicPosts'].some(k=>typeof s[k]!=='boolean')||typeof s.owner!=='string'||s.owner!==''&&!/^[1-9]\d{0,19}$/.test(s.owner)||
      !Number.isFinite(s.minMinutes)||s.minMinutes<0.1||s.minMinutes>10080||!Number.isFinite(s.maxMinutes)||s.maxMinutes<s.minMinutes||s.maxMinutes>10080||
      !Number.isFinite(s.probability)||s.probability<0||s.probability>1||!Number.isFinite(s.maxRunMinutes)||s.maxRunMinutes<1||s.maxRunMinutes>1440||
      !Number.isSafeInteger(s.runTokens)||s.runTokens<0||s.runTokens>10000000)throw new FishError('EXPLORATION_SETTINGS_INVALID');
    if((s.enabled||s.owner)&&!this.cfg().privateUsers.includes(s.owner))throw new FishError('EXPLORATION_OWNER_NOT_ALLOWED');
    this.store.transaction(()=>{
      this.store.setMeta('exploration:settings',JSON.stringify(s));
      this.store.db.prepare('UPDATE exploration_schedule SET next_check=? WHERE id=1').run(s.enabled?this.now()+interval(s,this.rng):null);
      if(previous.enabled&&!s.enabled||s.owner!==previous.owner)this.store.db.prepare(`UPDATE exploration_runs SET cancel=1 WHERE ${active}`).run();
    });return this.status();
  }
  assertOwner(owner:string){if(!this.cfg().enabled||!owner||!conversationAllowed(this.cfg(),'private:'+owner)||this.settings().owner!==owner)throw new FishError('EXPLORATION_OWNER_NOT_ALLOWED');}
  get(id:string){const r=this.store.db.prepare('SELECT * FROM exploration_runs WHERE id=?').get(id) as ExplorationRun|undefined;if(!r)throw new FishError('EXPLORATION_NOT_FOUND');return r;}
  recover(){
    this.store.db.prepare("UPDATE exploration_runs SET state='interrupted',finished=?,error='PROCESS_INTERRUPTED',lock=NULL,lease=0 WHERE state='running' AND lease<=?").run(this.now(),this.now());
    this.store.db.prepare("UPDATE exploration_runs SET state='cancelled',finished=? WHERE state='queued' AND cancel=1").run(this.now());
    // A stale manual queue is not a collection of work to catch up after offline time.
    this.store.db.prepare("UPDATE exploration_runs SET state='interrupted',finished=?,error='QUEUED_WHILE_OFFLINE' WHERE state='queued' AND trigger NOT IN ('tieba_reply','tieba_mention') AND created<?").run(this.now(),this.now()-3600000);
  }
  /** Called inside the caller's transaction, so event receipts and enqueue
   * commit together. Reused active runs are never overwritten. */
  enqueue(trigger:string,instruction?:string){
    const owner=this.settings().owner;this.assertOwner(owner);
    const prior=this.store.db.prepare(`SELECT * FROM exploration_runs WHERE ${active}`).get() as ExplorationRun|undefined;
    if(prior)return {run:prior,reused:true};
    const id=randomUUID();this.store.db.prepare("INSERT INTO exploration_runs(id,owner,trigger,state,created,instruction) VALUES (?,?,?,'queued',?,?)").run(id,owner,trigger,this.now(),instruction??null);return {run:this.get(id),reused:false};
  }
  manual(instruction?:string){if(instruction!==undefined&&(typeof instruction!=='string'||!instruction.trim()||instruction.length>4000))throw new FishError('INVALID_EXPLORATION_INSTRUCTION');return this.store.transaction(()=>{this.recover();const result=this.enqueue('manual',instruction);if(instruction!==undefined&&result.reused)throw new FishError('EXPLORATION_BUSY');return result;});}
  /** Trusted internal owner signal; no QQ event or special model prompt.
   * The one-reply authorization is durable and absent from ordinary runs. */
  simulatedOwnerSignal(instruction:string,publication:{action:'reply'|'thread'|'comment';retryOf?:string;threadId?:string;requireImage?:boolean}={action:'reply'}){
    if(typeof instruction!=='string'||!instruction.trim()||instruction.length>4000)throw new FishError('INVALID_EXPLORATION_INSTRUCTION');
    if(!['reply','thread','comment'].includes(publication.action)||publication.retryOf!==undefined&&(typeof publication.retryOf!=='string'||!publication.retryOf||publication.retryOf.length>240))throw new FishError('EXPLORATION_PUBLICATION_NOT_AUTHORIZED');
    if(publication.threadId!==undefined&&(publication.action==='thread'||typeof publication.threadId!=='string'||!(/^[1-9]\d{0,19}$/).test(publication.threadId)))throw new FishError('EXPLORATION_PUBLICATION_NOT_AUTHORIZED');
    if(publication.requireImage!==undefined&&typeof publication.requireImage!=='boolean'||publication.requireImage&&publication.action==='comment')throw new FishError('EXPLORATION_PUBLICATION_NOT_AUTHORIZED');
    return this.store.transaction(()=>{
      this.recover();const result=this.enqueue('simulated_owner_signal',instruction);if(result.reused)throw new FishError('EXPLORATION_BUSY');
      this.store.setMeta('exploration:publication-grant:'+result.run.id,JSON.stringify({...publication,attempts:1,usedBy:null}));
      this.store.audit('simulated_owner_signal','private:'+result.run.owner,JSON.stringify({runId:result.run.id,instruction,publication,maxPublications:1}));return result;
    });
  }
  reservePublication(run:Pick<ExplorationRun,'id'|'trigger'>,input:PublishInput,callId:string){
    if(run.trigger!=='simulated_owner_signal')return;
    return this.store.transaction(()=>{
      const key='exploration:publication-grant:'+run.id,grant=JSON.parse(this.store.getMeta(key)??'null');
      // Legacy signals used the model's reply action for both reply depths.
      const action=grant?.threadId||grant?.requireImage||grant?.action==='comment'?input.action:input.action==='comment'?'reply':input.action;
      if(!grant||action!==grant.action||grant.threadId&&input.threadId!==grant.threadId||grant.requireImage&&!input.imageIds?.length)throw new FishError('EXPLORATION_PUBLICATION_NOT_AUTHORIZED');
      // Consume before any I/O. A failed/unknown attempt cannot change target
      // or call ID and try again. Recorded outcomes have a separate read tool.
      if(grant.usedBy)throw new FishError('EXPLORATION_PUBLICATION_ALLOWANCE_USED');
      this.store.setMeta(key,JSON.stringify({...grant,usedBy:callId,usedAt:this.now()}));
      return typeof grant.retryOf==='string'?grant.retryOf:undefined;
    });
  }
  check(){return this.store.transaction(()=>{
    this.recover();const s=this.settings(),row=this.store.db.prepare('SELECT * FROM exploration_schedule WHERE id=1').get() as any;
    if(!s.enabled)return {checked:false,hit:false};
    this.assertOwner(s.owner);
    if(row.next_check===null){this.store.db.prepare('UPDATE exploration_schedule SET next_check=? WHERE id=1').run(this.now()+interval(s,this.rng));return {checked:false,hit:false};}
    if(row.next_check>this.now())return {checked:false,hit:false};
    // Exactly one roll after a long offline gap, never replay missed ticks.
    const hit=this.rng()<s.probability;
    this.store.db.prepare('UPDATE exploration_schedule SET next_check=?,last_check=?,checks=checks+1,hits=hits+? WHERE id=1').run(this.now()+interval(s,this.rng),this.now(),Number(hit));
    return {checked:true,hit,...(hit?this.enqueue('random'):{})};
  });}
  claim(){return this.store.transaction(()=>{
    this.recover();const r=this.store.db.prepare("SELECT * FROM exploration_runs WHERE state='queued' AND cancel=0 ORDER BY created LIMIT 1").get() as ExplorationRun|undefined;
    if(!r)return;this.assertOwner(r.owner);const lock=randomUUID();
    this.store.db.prepare("UPDATE exploration_runs SET state='running',started=?,lease=?,lock=? WHERE id=? AND state='queued'").run(this.now(),this.now()+60000,lock,r.id);return this.get(r.id);
  });}
  guard(id:string,lock:string){const r=this.get(id);if(r.lock!==lock||r.state!=='running'||r.cancel||r.lease<=this.now())throw new FishError('EXPLORATION_CANCELLED');this.assertOwner(r.owner);return r;}
  heartbeat(id:string,lock:string){this.guard(id,lock);this.store.db.prepare('UPDATE exploration_runs SET lease=? WHERE id=? AND lock=?').run(this.now()+60000,id,lock);}
  finish(id:string,lock:string,state:string,error:string|null=null,note:string|null=null){this.store.db.prepare("UPDATE exploration_runs SET state=?,error=?,note=?,finished=?,lease=0,lock=NULL WHERE id=? AND lock=? AND state='running'").run(state,error,note,this.now(),id,lock);}
  cancel(runId?:unknown){
    if(runId===undefined){
      this.store.db.prepare(`UPDATE exploration_runs SET cancel=1 WHERE ${active}`).run();
      return {ok:true};
    }
    if(typeof runId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId))
      throw new FishError('INVALID_EXPLORATION_ID');
    const {changes}=this.store.db.prepare(`UPDATE exploration_runs SET cancel=1 WHERE id=? AND ${active}`).run(runId);
    return {ok:true,requested:changes!==0};
  }
  history(query='',offset=0,owner?:string){
    if(typeof query!=='string'||query.length>200||!Number.isSafeInteger(offset)||offset<0)throw new FishError('INVALID_TOOL_ARGS');
    const rows=this.store.db.prepare("SELECT id,state,created,started,finished,note,tokens,web_tokens,shared FROM exploration_runs r WHERE (?='' OR r.owner=?) AND (?='' OR instr(lower(coalesce(r.note,'')),lower(?))>0 OR EXISTS(SELECT 1 FROM exploration_observations o WHERE o.run_id=r.id AND instr(lower(o.data),lower(?))>0)) ORDER BY created DESC LIMIT 11 OFFSET ?").all(owner??'',owner??'',query,query,query,offset) as any[];
    return {runs:rows.slice(0,10),nextOffset:rows.length>10?offset+10:null};
  }
  observation(run:string,step:number,tool:string,args:any,result:any){
    // Compact factual index outlives verbose traces; this is not a required model report.
    const a=JSON.stringify(args),summary:any={};
    for(const k of ['url','title','error','stage','submissionStatus','requestSent','requestId','elapsedMs','providerCode','retcode','sent','deliveryStatus','imageId','catalogId','id','version','state','billing'])if(result?.[k]!==undefined)summary[k]=result[k];
    summary.excerpt=String(result?.text??result?.content??result?.description??'').slice(0,600);
    const candidates=result?.results??result?.images;
    summary.sources=(Array.isArray(candidates)?candidates:[]).slice(0,8).map((r:any)=>({url:r.url??r.image?.sourceUrl,id:r.id??r.image?.id,title:String(r.title??r.description??'').slice(0,200)}));
    this.store.db.prepare('INSERT OR IGNORE INTO exploration_observations VALUES (?,?,?,?,?)').run(run,step,tool,JSON.stringify({arguments:a.length>3000?{excerpt:a.slice(0,3000)}:args,result:summary}),this.now());
    rememberExplorationLinks(this.store,tool,result);
  }
  observations(id:string,offset=0){const rows=this.store.db.prepare('SELECT step,tool,data,at FROM exploration_observations WHERE run_id=? ORDER BY step LIMIT 11 OFFSET ?').all(id,offset) as any[];return {observations:rows.slice(0,10).map(r=>({...r,...JSON.parse(r.data),data:undefined})),nextOffset:rows.length>10?offset+10:null};}
  status(){
    const s=this.settings(),eventColumns=this.store.db.prepare('PRAGMA table_info(tieba_reply_events)').all();
    const notificationStatus=(kind:'reply'|'mention')=>{
      const watch=JSON.parse(this.store.getMeta('tieba:'+kind+'-watch')??'null');
      const pending=eventColumns.some(column=>column.name==='kind')?this.store.db.prepare('SELECT count(*) AS count,min(due) AS due FROM tieba_reply_events WHERE run_id IS NULL AND owner=? AND account=? AND kind=?').get(s.owner,watch?.account??'',kind):null;
      return {lastCheck:watch?.lastCheck??null,lastError:watch?.lastError??null,paused:watch?.pausedAt!==undefined,pending};
    };
    return {settings:s,expectedPerDay:expectedPerDay(s),schedule:this.store.db.prepare('SELECT * FROM exploration_schedule WHERE id=1').get(),
      tiebaReplies:notificationStatus('reply'),tiebaMentions:notificationStatus('mention'),
      tiebaRedDot:tiebaReplyBadge(this.store),
      tiebaDailyPost:dailyPostHint(this.store,this.now()),
      active:this.store.db.prepare(`SELECT * FROM exploration_runs WHERE ${active}`).get()??null,last:this.store.db.prepare('SELECT * FROM exploration_runs ORDER BY created DESC LIMIT 1').get()??null,
      recent:this.store.db.prepare('SELECT * FROM exploration_runs ORDER BY created DESC LIMIT 20').all(),lastError:this.store.db.prepare('SELECT error,finished FROM exploration_runs WHERE error IS NOT NULL ORDER BY created DESC LIMIT 1').get()??null,
      worker:JSON.parse(this.store.getMeta('exploration:worker')??'null'),owners:this.cfg().privateUsers,groups:this.cfg().groups,
      proposals:this.store.db.prepare('SELECT p.run_id,t.id,t.request,t.brief,t.state,t.created FROM exploration_proposals p JOIN tasks t ON t.id=p.task_id ORDER BY p.created DESC LIMIT 20').all()};
  }
  setDailyPost(input:unknown){setDailyPostHint(this.store,input,this.now());return this.status();}
  journal(args:any={}){const c=this.cfg();return readCuriosity(this.store,args,[...c.groups,...c.privateUsers,...c.admins]);}
  writeJournal(run:string,args:any){return writeCuriosity(this.store,run,args,this.now());}
}
