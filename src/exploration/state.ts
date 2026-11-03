import {randomUUID,randomInt} from 'node:crypto';
import type {Store} from '../storage/db.js';
import {FishError} from '../types.js';
import {conversationAllowed,type Config} from '../config.js';
import {publicUrl} from '../search/provider.js';

export const random=()=>randomInt(0,0x100000000)/0x100000000;
export type ExplorationSettings={enabled:boolean;owner:string;minMinutes:number;maxMinutes:number;probability:number;maxRunMinutes:number;runTokens:number;allowImages:boolean;allowPublicPosts:boolean};
export const explorationDefaults:ExplorationSettings={enabled:false,owner:'',minMinutes:9,maxMinutes:11,probability:0.028,maxRunMinutes:60,runTokens:0,allowImages:false,allowPublicPosts:false};
export const interval=(s:ExplorationSettings,rng=random)=>Math.round((s.minMinutes+(s.maxMinutes-s.minMinutes)*rng())*60000);
export const expectedPerDay=(s:ExplorationSettings)=>1440/((s.minMinutes+s.maxMinutes)/2)*s.probability;
export type ExplorationRun={id:string;owner:string;trigger:string;state:string;created:number;started:number|null;finished:number|null;lease:number;lock:string|null;error:string|null;tokens:number;web_tokens:number;unknown_tokens:number;shared:number;note:string|null;cancel:number};
const active="state IN ('queued','running')";
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
    store.transaction(()=>{for(const column of ['web_tokens','unknown_tokens'])if(!store.db.prepare('PRAGMA table_info(exploration_runs)').all().some((c:any)=>c.name===column))store.db.exec('ALTER TABLE exploration_runs ADD COLUMN '+column+' INTEGER NOT NULL DEFAULT 0');});
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
    this.store.db.prepare("UPDATE exploration_runs SET state='interrupted',finished=?,error='QUEUED_WHILE_OFFLINE' WHERE state='queued' AND created<?").run(this.now(),this.now()-3600000);
  }
  private insert(trigger:string){
    const owner=this.settings().owner;this.assertOwner(owner);
    const prior=this.store.db.prepare(`SELECT * FROM exploration_runs WHERE ${active}`).get() as ExplorationRun|undefined;
    if(prior)return {run:prior,reused:true};
    const id=randomUUID();this.store.db.prepare("INSERT INTO exploration_runs(id,owner,trigger,state,created) VALUES (?,?,?,'queued',?)").run(id,owner,trigger,this.now());return {run:this.get(id),reused:false};
  }
  manual(){return this.store.transaction(()=>{this.recover();return this.insert('manual');});}
  check(){return this.store.transaction(()=>{
    this.recover();const s=this.settings(),row=this.store.db.prepare('SELECT * FROM exploration_schedule WHERE id=1').get() as any;
    if(!s.enabled)return {checked:false,hit:false};
    this.assertOwner(s.owner);
    if(row.next_check===null){this.store.db.prepare('UPDATE exploration_schedule SET next_check=? WHERE id=1').run(this.now()+interval(s,this.rng));return {checked:false,hit:false};}
    if(row.next_check>this.now())return {checked:false,hit:false};
    // Exactly one roll after a long offline gap, never replay missed ticks.
    const hit=this.rng()<s.probability;
    this.store.db.prepare('UPDATE exploration_schedule SET next_check=?,last_check=?,checks=checks+1,hits=hits+? WHERE id=1').run(this.now()+interval(s,this.rng),this.now(),Number(hit));
    return {checked:true,hit,...(hit?this.insert('random'):{})};
  });}
  claim(){return this.store.transaction(()=>{
    this.recover();const r=this.store.db.prepare("SELECT * FROM exploration_runs WHERE state='queued' AND cancel=0 ORDER BY created LIMIT 1").get() as ExplorationRun|undefined;
    if(!r)return;this.assertOwner(r.owner);const lock=randomUUID();
    this.store.db.prepare("UPDATE exploration_runs SET state='running',started=?,lease=?,lock=? WHERE id=? AND state='queued'").run(this.now(),this.now()+60000,lock,r.id);return this.get(r.id);
  });}
  guard(id:string,lock:string){const r=this.get(id);if(r.lock!==lock||r.state!=='running'||r.cancel||r.lease<=this.now())throw new FishError('EXPLORATION_CANCELLED');this.assertOwner(r.owner);return r;}
  heartbeat(id:string,lock:string){this.guard(id,lock);this.store.db.prepare('UPDATE exploration_runs SET lease=? WHERE id=? AND lock=?').run(this.now()+60000,id,lock);}
  finish(id:string,lock:string,state:string,error:string|null=null,note:string|null=null){this.store.db.prepare("UPDATE exploration_runs SET state=?,error=?,note=?,finished=?,lease=0,lock=NULL WHERE id=? AND lock=? AND state='running'").run(state,error,note,this.now(),id,lock);}
  cancel(){this.store.db.prepare(`UPDATE exploration_runs SET cancel=1 WHERE ${active}`).run();return {ok:true};}
  history(query='',offset=0,owner?:string){
    if(typeof query!=='string'||query.length>200||!Number.isSafeInteger(offset)||offset<0)throw new FishError('INVALID_TOOL_ARGS');
    const rows=this.store.db.prepare("SELECT id,state,created,note,tokens,web_tokens,shared FROM exploration_runs r WHERE (?='' OR r.owner=?) AND (?='' OR instr(lower(coalesce(r.note,'')),lower(?))>0 OR EXISTS(SELECT 1 FROM exploration_observations o WHERE o.run_id=r.id AND instr(lower(o.data),lower(?))>0)) ORDER BY created DESC LIMIT 11 OFFSET ?").all(owner??'',owner??'',query,query,query,offset) as any[];
    return {runs:rows.slice(0,10),nextOffset:rows.length>10?offset+10:null};
  }
  observation(run:string,step:number,tool:string,args:any,result:any){
    // Compact factual index outlives verbose traces; this is not a required model report.
    const a=JSON.stringify(args),summary:any={};
    for(const k of ['url','title','error','sent','deliveryStatus','imageId','catalogId','id','version','state','billing'])if(result?.[k]!==undefined)summary[k]=result[k];
    summary.excerpt=String(result?.text??result?.content??result?.description??'').slice(0,600);
    summary.sources=(result?.results??result?.images??[]).slice(0,8).map((r:any)=>({url:r.url??r.image?.sourceUrl,id:r.id??r.image?.id,title:String(r.title??r.description??'').slice(0,200)}));
    this.store.db.prepare('INSERT OR IGNORE INTO exploration_observations VALUES (?,?,?,?,?)').run(run,step,tool,JSON.stringify({arguments:a.length>3000?{excerpt:a.slice(0,3000)}:args,result:summary}),this.now());
  }
  observations(id:string,offset=0){const rows=this.store.db.prepare('SELECT step,tool,data,at FROM exploration_observations WHERE run_id=? ORDER BY step LIMIT 11 OFFSET ?').all(id,offset) as any[];return {observations:rows.slice(0,10).map(r=>({...r,...JSON.parse(r.data),data:undefined})),nextOffset:rows.length>10?offset+10:null};}
  status(){
    const s=this.settings();return {settings:s,expectedPerDay:expectedPerDay(s),schedule:this.store.db.prepare('SELECT * FROM exploration_schedule WHERE id=1').get(),
      active:this.store.db.prepare(`SELECT * FROM exploration_runs WHERE ${active}`).get()??null,last:this.store.db.prepare('SELECT * FROM exploration_runs ORDER BY created DESC LIMIT 1').get()??null,
      recent:this.store.db.prepare('SELECT * FROM exploration_runs ORDER BY created DESC LIMIT 20').all(),lastError:this.store.db.prepare('SELECT error,finished FROM exploration_runs WHERE error IS NOT NULL ORDER BY created DESC LIMIT 1').get()??null,
      worker:JSON.parse(this.store.getMeta('exploration:worker')??'null'),owners:this.cfg().privateUsers,groups:this.cfg().groups,
      proposals:this.store.db.prepare('SELECT p.run_id,t.id,t.request,t.brief,t.state,t.created FROM exploration_proposals p JOIN tasks t ON t.id=p.task_id ORDER BY p.created DESC LIMIT 20').all()};
  }
  journal(args:any={}){
    if(!args||Object.keys(args).some(k=>!['id','query','offset','removed'].includes(k))||!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0||args.query!==undefined&&(typeof args.query!=='string'||args.query.length>200))throw new FishError('INVALID_TOOL_ARGS');
    if(args.id){const entry=this.store.db.prepare('SELECT * FROM curiosity_entries WHERE id=?').get(args.id) as any;if(!entry)throw new FishError('CURIOSITY_NOT_FOUND');return {entry:{...entry,sources:JSON.parse(entry.sources)},revisions:this.store.db.prepare('SELECT version,at,entry FROM curiosity_revisions WHERE id=? ORDER BY version DESC LIMIT 10').all(args.id)};}
    const rows=this.store.db.prepare('SELECT id,title,substr(content,1,500) AS preview,sources,updated,version,removed FROM curiosity_entries WHERE removed=? AND (?=\'\' OR instr(lower(title||content),lower(?))>0) ORDER BY updated DESC LIMIT 11 OFFSET ?').all(Number(args.removed===true),args.query??'',args.query??'',args.offset??0) as any[];
    return {entries:rows.slice(0,10).map(r=>({...r,sources:JSON.parse(r.sources)})),nextOffset:rows.length>10?(args.offset??0)+10:null};
  }
  writeJournal(run:string,args:any){
    if(!args||Object.keys(args).some(k=>!['id','version','title','content','sources','remove'].includes(k))||args.id!==undefined&&typeof args.id!=='string'||args.remove!==undefined&&typeof args.remove!=='boolean')throw new FishError('INVALID_TOOL_ARGS');
    return this.store.transaction(()=>{
      const old=args.id?this.store.db.prepare('SELECT * FROM curiosity_entries WHERE id=?').get(args.id) as any:undefined;
      if(args.id&&!old)throw new FishError('CURIOSITY_NOT_FOUND');if(old&&args.version!==old.version)throw new FishError('CURIOSITY_VERSION_CHANGED');
      const title=args.title??old?.title,content=args.content??old?.content,sources=args.sources??(old?JSON.parse(old.sources):[]);
      if(typeof title!=='string'||!title.trim()||title.length>200||typeof content!=='string'||content.length>32000||!Array.isArray(sources)||sources.length>50||sources.some(u=>typeof u!=='string'||u.length>8192||!publicUrl(u)))throw new FishError('CURIOSITY_ENTRY_INVALID');
      const id=old?.id??randomUUID(),version=(old?.version??0)+1,entry={id,title,content,sources,removed:args.remove??false,version};
      this.store.db.prepare('INSERT INTO curiosity_entries VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,content=excluded.content,sources=excluded.sources,updated=excluded.updated,version=excluded.version,removed=excluded.removed').run(id,title,content,JSON.stringify(sources),old?.created??this.now(),this.now(),version,Number(entry.removed));
      this.store.db.prepare('INSERT INTO curiosity_revisions(id,run_id,version,at,entry) VALUES (?,?,?,?,?)').run(id,run,version,this.now(),JSON.stringify(entry));return entry;
    });
  }
}
