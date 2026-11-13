import {randomUUID} from 'node:crypto';
import {FishError,codeOf} from '../types.js';
import type {ExplorationState} from '../exploration/state.js';
import {TiebaAccountClient} from './client.js';
import type {TiebaReply} from './replies.js';

const key='tieba:reply-watch',minute=60000,delay=5*minute;
type Cursor={account:string;since:number;page:number;scanStarted:number|null;nextCheck:number;lastCheck:number|null;lastError:string|null;pausedAt?:number;lease?:string;leaseUntil?:number};
/** One inexpensive account-inbox read per minute; no model call. The existing
 * exploration worker owns this lifecycle, queue and shared money budget. */
export class TiebaReplyWatch {
 private pending?:Promise<void>;
 constructor(private state:ExplorationState,private enabled:()=>boolean,private client=new TiebaAccountClient(),private now=Date.now){
  state.store.db.exec(`CREATE TABLE IF NOT EXISTS tieba_reply_events(account TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,created INTEGER NOT NULL,detected INTEGER NOT NULL,due INTEGER NOT NULL,run_id TEXT,payload TEXT NOT NULL,PRIMARY KEY(account,id));
   CREATE INDEX IF NOT EXISTS tieba_reply_pending ON tieba_reply_events(owner,account,run_id,due);`);
 }
 private cursor():Cursor|undefined{const value=this.state.store.getMeta(key);return value?JSON.parse(value):undefined;}
 tick(allowRead=true){
  if(!this.enabled()||!this.state.settings().enabled)return;
  this.wake();
  if(!allowRead)return;
  if(!this.pending){const c=this.cursor();if(c&&(c.nextCheck>this.now()||(c.leaseUntil??0)>this.now()))return;
   this.pending=this.poll().catch(e=>{this.state.store.audit('tieba-reply-watch','','后台回复读取失败：'+codeOf(e));}).finally(()=>{this.pending=undefined;});
  }
 }
 async idle(){await this.pending;}
 private async poll(){
  const owner=this.state.settings().owner;this.state.assertOwner(owner);
  const lease=randomUUID(),acquired=this.state.store.transaction(()=>{
   const c=this.cursor();if(c&&(c.nextCheck>this.now()||(c.leaseUntil??0)>this.now()))return false;
   this.state.store.setMeta(key,JSON.stringify({...c,nextCheck:this.now()+minute,lease,leaseUntil:this.now()+120000}));return true;
  });if(!acquired)return;
  let cursor=this.cursor()!;
  try{
   const status=await this.client.status(),account=status.identity??status.lastIdentity;
   if(!account||!status.profileSaved||!['logged_in','needs_check','check_failed'].includes(status.state)){
    cursor.lastError=status.lastError?.code??(status.state==='unconfigured'?'TIEBA_NOT_CONFIGURED':'TIEBA_LOGIN_REQUIRED');cursor.pausedAt=this.now();return;
   }
   if(cursor.pausedAt!==undefined&&(status.verifiedAt??0)<=cursor.pausedAt)return;
   cursor.pausedAt=undefined;
   if(cursor.account!==account.id){cursor={account:account.id,since:Math.floor(this.now()/1000)*1000,page:1,scanStarted:null,nextCheck:this.now()+minute,lastCheck:null,lastError:null,lease,leaseUntil:this.now()+120000};}
   if(cursor.scanStarted===null)cursor.scanStarted=this.now();
   if(this.cursor()?.lease===lease)this.state.store.setMeta(key,JSON.stringify(cursor));
   const page=await this.client.replies(cursor.page);
   if(page.account?.id!==account.id)throw new FishError('TIEBA_ACCOUNT_CHANGED');
   if(!Array.isArray(page.replies)||typeof page.hasMore!=='boolean'||page.page!==cursor.page)throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');
   this.state.store.transaction(()=>{
    // Re-check human configuration after the asynchronous platform read.
    if(this.state.settings().owner!==owner)return;
    const existing=this.state.store.db.prepare('SELECT min(due) AS due FROM tieba_reply_events WHERE account=? AND owner=? AND run_id IS NULL').get(account.id,owner) as any;
    const due=existing?.due??this.now()+delay;
    for(const r of page.replies as TiebaReply[]){
     if(r.author.id===account.id||r.time<cursor.since)continue;
     this.state.store.db.prepare('INSERT OR IGNORE INTO tieba_reply_events VALUES (?,?,?,?,?,?,NULL,?)').run(account.id,r.id,owner,r.time,this.now(),due,JSON.stringify(r));
    }
    // Completed receipts are bounded. The persisted scan watermark prevents
    // old inbox entries from becoming new again after receipt pruning.
    this.state.store.db.prepare('DELETE FROM tieba_reply_events WHERE run_id IS NOT NULL AND created<? AND rowid NOT IN (SELECT rowid FROM tieba_reply_events ORDER BY detected DESC LIMIT 10000)').run(cursor.since);
   });
   const crossed=page.replies.some((r:TiebaReply)=>r.time<cursor.since);
   if(page.hasMore&&!crossed){if(cursor.page>=10000)throw new FishError('TIEBA_REPLIES_PAGE_LIMIT');cursor.page++;cursor.nextCheck=this.now();}
   else{cursor.since=Math.max(cursor.since,cursor.scanStarted-60000);cursor.scanStarted=null;cursor.page=1;}
   cursor.lastCheck=this.now();cursor.lastError=null;
  }catch(e){
   const code=codeOf(e);cursor.lastError=code;cursor.nextCheck=this.now()+minute;
   if(!/^(TIEBA_(BUSY|PROFILE_BUSY|LOGIN_IN_PROGRESS|WORKER_UNAVAILABLE|WORKER_RESPONSE_FAILED|READ_NETWORK_FAILED|READ_HTTP_5\d\d))$/.test(code))cursor.pausedAt=this.now();
   this.state.store.audit('tieba-reply-watch','',code);
  }finally{
   // A process crash leaves a short lease; another process resumes the same
   // cursor after it expires rather than starting duplicate account reads.
   if(this.cursor()?.lease===lease)this.state.store.setMeta(key,JSON.stringify({...cursor,lease:undefined,leaseUntil:undefined}));
  }
 }
 private wake(){
  const cursor=this.cursor(),owner=this.state.settings().owner;if(!cursor?.account||cursor.pausedAt!==undefined)return;
  this.state.store.transaction(()=>{
   this.state.recover();
   const rows=this.state.store.db.prepare('SELECT * FROM tieba_reply_events WHERE account=? AND owner=? AND run_id IS NULL ORDER BY detected,id LIMIT 20').all(cursor.account,owner) as any[];
   if(!rows.length||rows[0].due>this.now())return;
   const count=Number((this.state.store.db.prepare('SELECT count(*) AS n FROM tieba_reply_events WHERE account=? AND owner=? AND run_id IS NULL').get(cursor.account,owner) as any).n);
   const notification={kind:'tieba_reply',reminder:'贴吧有新回复，想看可以看看。',accountId:cursor.account,count,replies:rows.map(r=>{const p=JSON.parse(r.payload);return {id:p.id,threadId:p.threadId,parentPostId:p.parentPostId,isFloor:p.isFloor,url:p.url};}),readWith:'get_tieba_replies'};
   const queued=this.state.enqueue('tieba_reply',JSON.stringify(notification));if(queued.reused)return;
   this.state.store.db.prepare('UPDATE tieba_reply_events SET run_id=? WHERE account=? AND owner=? AND run_id IS NULL').run(queued.run.id,cursor.account,owner);
   this.state.store.audit('tieba-reply-wake','private:'+owner,JSON.stringify({runId:queued.run.id,replies:count,delayMs:delay}));
  });
 }
}
