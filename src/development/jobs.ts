import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,randomBytes} from 'node:crypto';
import {FishError} from '../types.js';
import type {Tree} from './workspace.js';
import type {Answers,Question} from './clarification.js';
import type {DevelopmentIntent} from './intake.js';
import type {Store} from '../storage/db.js';
import type {AgyDelivery,AgyStage,AgyTurnResult} from './agy-bridge-types.js';

export type Request={source:string;messageId:string;text:string;at:number;taskRef?:string;intent?:DevelopmentIntent;activityChainId?:string};
export type Trial={entry:'web'|'qq';text:string;mode?:'chat'|'agent';turns?:{tool?:string;args?:unknown;reply?:string}[];expected:string};
export type Job={
 id:string;owner:string;grant:string;version:number;requests:Request[];
 backend?:'agy'|'codex';agyStage?:AgyStage;codexRetries?:number;agySummary?:AgyTurnResult['summary'];
 goal:string;criteria:string[];phase:'code'|'candidate'|'deploy'|'live'|'done'|'blocked'|'cancelled';
 created:number;modified:number;base?:Tree;thread?:string;threadPending?:boolean;priorTurn?:string|null;turn?:string;turnVersion?:number;
 workspaceId?:string; mode?:'question'; // Historical records from the old question-only path.
 followUps?:{request:Request;turnId:string;state:'sending'|'accepted'|'unknown'}[];
 codexSelection?:{model:string;effort:string;turnId:string};
 codexRetryAt?:number;
 codexActivity?:{turnId:string;step:string;at:number};
 codexApprovals?:{id:string;at:number;turnId:string;action:string;status:string;source?:string}[];
 clarifications?:{turnId:string;itemId:string;questions:Question[];answers?:Answers;error?:string}[];
 codexText?:string;repair?:string;round:number;candidate?:string;ticket?:string;deployment?:{revision:string;before:string;pids?:number[];restartedAt?:number};
 /** Historical trial records from development jobs that used local replay. */
 trials:{kind:'candidate'|'live';revision:string;version:number;input:Trial;observed?:unknown;passed?:boolean;reason?:string}[];
 reason?:string;report?:string;
};
export type Lease={id:string;grant:string;version:number};
const terminal=(job:Job)=>['done','blocked','cancelled'].includes(job.phase);
export function boundActivityChain(shared:Store,owner:string,request:Request|undefined){
 const intent=request?.intent;
 const marker=intent?.action==='send'?/^(\[activity-chain:[a-f0-9-]{36}\])\n/.exec(intent.brief)?.[1]:undefined;
 if(!marker)return request?.activityChainId?null:undefined;
 if(!shared.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_chains'").get())return null;
 const row=shared.db.prepare('SELECT id,state FROM activity_chains WHERE owner=? AND marker=?').get(owner,marker) as {id:string;state:string}|undefined;
 return row&&(!request?.activityChainId||request.activityChainId===row.id)?row:null;
}

export class Jobs{
 readonly db:DatabaseSync;
 constructor(root:string){
  this.db=new DatabaseSync(path.join(root,'runtime/data/development.sqlite'));
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS incoming(source TEXT PRIMARY KEY,body TEXT NOT NULL,received INTEGER NOT NULL,handled INTEGER,requested INTEGER);
    CREATE TABLE IF NOT EXISTS development(id TEXT PRIMARY KEY,body TEXT NOT NULL,created INTEGER NOT NULL,phase TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS development_phase ON development(phase,created);
    CREATE TABLE IF NOT EXISTS development_conversation(owner TEXT PRIMARY KEY,last_job TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS development_activity_pending(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'ready',created INTEGER NOT NULL,attempt INTEGER);`);
  // The task UPSERT can override a trigger's INSERT OR IGNORE policy.
  // Give the outbox insert its own conflict target so repeats coalesce.
  this.tx(()=>this.db.exec(`DROP TRIGGER IF EXISTS development_activity_insert;
    DROP TRIGGER IF EXISTS development_activity_update;
    CREATE TRIGGER development_activity_insert AFTER INSERT ON development BEGIN
      INSERT INTO development_activity_pending(id) VALUES (NEW.id) ON CONFLICT(id) DO NOTHING;
    END;
    CREATE TRIGGER development_activity_update AFTER UPDATE ON development BEGIN
      INSERT INTO development_activity_pending(id) VALUES (NEW.id) ON CONFLICT(id) DO NOTHING;
    END;
    INSERT OR IGNORE INTO development_activity_pending SELECT id FROM development;`));
  if(!this.db.prepare('PRAGMA table_info(incoming)').all().some(column=>column.name==='requested')){
   this.tx(()=>{
    if(this.db.prepare('PRAGMA table_info(incoming)').all().some(column=>column.name==='requested'))return;
    this.db.exec('ALTER TABLE incoming ADD COLUMN requested INTEGER; UPDATE incoming SET requested=received WHERE handled IS NULL;');
   });
  }
  if(!this.db.prepare('PRAGMA table_info(notices)').all().some(column=>column.name==='narrate')){
   this.tx(()=>{
    if(this.db.prepare('PRAGMA table_info(notices)').all().some(column=>column.name==='narrate'))return;
    this.db.exec(`ALTER TABLE notices ADD COLUMN narrate INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE notices ADD COLUMN spoken TEXT;
     ALTER TABLE notices ADD COLUMN speech_attempts INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE notices ADD COLUMN next_speech INTEGER NOT NULL DEFAULT 0;
     UPDATE notices SET narrate=1 WHERE state='ready';`);
   });
  }
 }
 tx<T>(work:()=>T){this.db.exec('BEGIN IMMEDIATE');try{const value=work();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 record(request:Request){this.db.prepare('INSERT OR IGNORE INTO incoming(source,body,received) VALUES (?,?,?)').run(request.source,JSON.stringify(request),Date.now());}
 request(source:string,at:number,intent:DevelopmentIntent){
  this.db.prepare("UPDATE incoming SET requested=?,body=json_set(body,'$.intent',json(?)) WHERE source=? AND handled IS NULL AND requested IS NULL")
   .run(at,JSON.stringify(intent),source);
 }
 queueChainDiscussions(shared:Store,owner:string){
  // The QQ service creates these rows only from authenticated owner messages.
  if(!shared.db.prepare("SELECT 1 FROM pragma_table_info('activity_chains') WHERE name='discussion_brief'").get())return;
  const waiting=shared.db.prepare(`SELECT id,marker,instruction,discussion_brief AS question,updated
   FROM activity_chains WHERE owner=? AND state='waiting_discussion' AND discussion_step IS NOT NULL
    AND discussion_brief IS NOT NULL ORDER BY updated LIMIT 20`).all(owner);
  if(!waiting.length)return;
  this.tx(()=>{
   for(const row of waiting){
    const marker=String(row.marker),id=/^\[activity-chain:([a-f0-9-]{36})\]$/.exec(marker)?.[1];
    if(!id)continue;
    const source='chain-discussion:'+id,question=String(row.question),at=Number(row.updated);
    this.record({source,messageId:source,text:String(row.instruction),at,activityChainId:String(row.id)});
    const brief=marker+'\n此环节只讨论并给出结论。下文是肥鱼在任务链里提出的问题。后续操作留给肥鱼。\n'+question;
    this.request(source,at,{action:'send',brief,goal:question,criteria:[]});
   }
  });
 }
 pruneUnrequested(now:number){
  return this.db.prepare('DELETE FROM incoming WHERE requested IS NULL AND received<? RETURNING source').all(now-3600000).map(row=>String(row.source));
 }
 pending(kind:'all'|'cancel'|'send'='all'):Request|undefined{
  const action="json_extract(body,'$.intent.action')";
  // The native bridge uses `send` to steer the active turn. A new chain's
  // discussion gets its own turn, while regular follow-ups can still steer.
  const filter=kind==='all'?'':kind==='cancel'?` AND ${action}='cancel'`:
   ` AND ${action}<>'cancel' AND substr(json_extract(body,'$.intent.brief'),1,length('[activity-chain:'))<>'[activity-chain:'`;
  const row=this.db.prepare('SELECT body FROM incoming WHERE handled IS NULL AND requested IS NOT NULL'+filter+' ORDER BY requested,rowid LIMIT 1').get();
  if(!row)return;
  const request=JSON.parse(String(row.body));
  if(request.intent&&request.intent.action!=='cancel')request.intent.action='send';
  return request;
 }
 handled(request:Request){this.db.prepare('UPDATE incoming SET handled=? WHERE source=?').run(Date.now(),request.source);}
 defer(request:Request){this.db.prepare('UPDATE incoming SET handled=NULL WHERE source=?').run(request.source);}
 cancelMessages(at:number){
  this.db.prepare(`UPDATE incoming SET handled=? WHERE handled IS NULL AND requested IS NOT NULL
    AND json_extract(body,'$.intent.action')<>'cancel' AND json_extract(body,'$.at')<=?`).run(Date.now(),at);
 }
 get(id:string):Job|undefined{const row=this.db.prepare('SELECT body FROM development WHERE id=?').get(id);return row?JSON.parse(String(row.body)):undefined;}
 list(active=true):Job[]{return this.db.prepare("SELECT body FROM development "+(active?"WHERE phase IN ('code','candidate','deploy','live') ":"")+"ORDER BY created "+(active?"":"DESC LIMIT 20")).all().map(row=>JSON.parse(String(row.body)));}
 status(owner:string){
  return this.db.prepare(`SELECT id, phase, created AS createdAt, substr(json_extract(body,'$.goal'),1,1000) AS goal,
    json_extract(body,'$.modified') AS updatedAt, json_extract(body,'$.round') AS rounds,
    json_extract(body,'$.mode') AS mode,
    json_extract(body,'$.backend') AS backend, json_extract(body,'$.agyStage') AS agyStage,
    json_extract(body,'$.codexActivity.step') AS codexStep, json_extract(body,'$.codexActivity.at') AS codexUpdatedAt,
    json_extract(body,'$.deployment.revision') AS deployedRevision,
    json_extract(body,'$.deployment.restartedAt') AS deployedAt,
    substr(json_extract(body,'$.reason'),1,500) AS reason, substr(json_extract(body,'$.report'),1,1500) AS report,
    CASE WHEN phase='done' THEN substr(json_extract(body,'$.codexText'),1,4000) END AS codexHandoff
    FROM development WHERE json_extract(body,'$.owner')=?
    ORDER BY (phase IN ('code','candidate','deploy','live')) DESC, created DESC LIMIT 20`).all(owner);
 }
 lastAgyDelivery(owner:string):AgyDelivery|undefined{
  const row=this.db.prepare(`SELECT body FROM development WHERE json_extract(body,'$.owner')=?
    AND phase IN ('done','blocked','cancelled')
    AND json_extract(body,'$.backend')='agy'
    AND json_extract(body,'$.requests[0].activityChainId') IS NULL
    AND (json_extract(body,'$.agySummary.decision')='delegate_codex'
      OR json_extract(body,'$.agyStage') IN ('codex','codex_retry','verify','review'))
    ORDER BY json_extract(body,'$.modified') DESC, rowid DESC LIMIT 1`).get(owner);
  if(!row)return;
  const job=JSON.parse(String(row.body)) as Job;
  const revision=job.deployment?.revision;
  const verified=job.phase==='done'&&!!revision&&revision===job.candidate;
  const files=job.agySummary?.changedFiles??[];
  const changed=files.length?' · 改动 '+files.slice(0,4).join('、')+(files.length>4?' 等 '+files.length+' 个文件':''):'';
  const text=(job.goal.slice(0,180)+' · '+(verified?'已上线 '+revision.slice(0,12):'未上线')+changed)
   .replace(/\s+/g,' ').trim().slice(0,600);
  return {text,at:job.modified};
 }
 lastDeployment(owner:string){
  return this.db.prepare(`SELECT id, json_extract(body,'$.goal') AS goal, json_extract(body,'$.deployment.revision') AS revision,
    json_extract(body,'$.deployment.restartedAt') AS restartedAt
    FROM development WHERE phase='done' AND json_extract(body,'$.owner')=?
    AND json_extract(body,'$.deployment.revision') IS NOT NULL
    ORDER BY restartedAt DESC LIMIT 1`).get(owner);
 }
 activityPending(){
  return this.db.prepare(`SELECT d.id,d.body FROM development_activity_pending AS p
    JOIN development AS d USING (id) ORDER BY d.created DESC LIMIT 20`).all() as {id:string;body:string}[];
 }
 activityWritten(id:string,body:string){
  this.db.prepare(`DELETE FROM development_activity_pending WHERE id=? AND
    EXISTS(SELECT 1 FROM development WHERE id=? AND body=?)`).run(id,id,body);
 }
 conversation(owner:string){
  const bound=this.db.prepare('SELECT last_job FROM development_conversation WHERE owner=?').get(owner);
  if(bound){
   const job=this.get(String(bound.last_job));
   if(job?.owner!==owner)throw new FishError('DEV_CODEX_SESSION_MISMATCH');
   return job;
  }
  const row=this.db.prepare(`SELECT body FROM development WHERE json_extract(body,'$.owner')=?
    AND json_extract(body,'$.thread') IS NOT NULL AND json_extract(body,'$.turn') IS NOT NULL
    ORDER BY (phase='done') DESC,created DESC LIMIT 1`).get(owner);
  return row?JSON.parse(String(row.body)) as Job:undefined;
 }
 create(owner:string,request:Request,goal:string,criteria:string[],backend?:Job['backend']){
  if(this.list().length)throw new FishError('DEV_CODEX_BUSY');
  const recent=backend==='agy'?undefined:this.conversation(owner);
  const previous=recent?.backend==='agy'?undefined:recent;
  const id=randomUUID(),now=Date.now();
  const job:Job={id,owner,grant:randomBytes(32).toString('hex'),version:1,requests:[request],goal,criteria,backend,
   phase:'code',created:now,modified:now,round:0,trials:[],workspaceId:previous?.workspaceId??previous?.id??id,
   thread:previous?.thread,threadPending:previous?.threadPending,priorTurn:previous?.turn??previous?.priorTurn};
  this.save(job);
  this.db.prepare(`INSERT INTO development_conversation VALUES (?,?)
    ON CONFLICT(owner) DO UPDATE SET last_job=excluded.last_job`).run(owner,id);
  return job;
 }
 save(job:Job){
  job.modified=Date.now();
  this.db.prepare('INSERT INTO development VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,phase=excluded.phase').run(job.id,JSON.stringify(job),job.created,job.phase);
 }
 guard(lease:Lease,phase?:Job['phase']){
  const job=this.get(lease.id);
  if(!job||terminal(job)||job.grant!==lease.grant||job.version!==lease.version||phase&&phase!==job.phase)throw new FishError('DEV_GRANT_REVOKED');
  return job;
 }
 update(lease:Lease,change:Partial<Job>){
  return this.tx(()=>{const job=this.guard(lease);Object.assign(job,change);this.save(job);return job;});
 }
 notify(id:string,body:string){
  this.db.prepare('INSERT OR IGNORE INTO notices(id,text,created,narrate) VALUES (?,?,?,1)').run(id,body,Date.now());
 }
 finish(lease:Lease,phase:'done'|'blocked',reason:string,report:string,finalize?:(job:Job)=>void){
  this.tx(()=>{
   const job=this.guard(lease);
   finalize?.(job);
   this.save({...job,phase,reason,report,grant:''});
   if(!job.requests[0]?.activityChainId)this.notify('terminal:'+job.id,report);
  });
 }
}
