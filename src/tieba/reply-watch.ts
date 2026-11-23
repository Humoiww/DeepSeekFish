import {randomUUID} from 'node:crypto';
import {FishError,codeOf} from '../types.js';
import type {ExplorationState} from '../exploration/state.js';
import {TiebaAccountClient} from './client.js';
import {threadReplyTarget,type TiebaReply} from './replies.js';
import type {TiebaMention} from './mentions.js';
import {ensureTiebaReplyBadge,isTiebaReplySeen} from './reply-badge.js';

type Kind='reply'|'mention';
type Notice=TiebaReply&Partial<TiebaMention>;
type PendingNotice={id:string;kind:Kind;payload:string;detected:number};
const feeds={reply:{key:'tieba:reply-watch',error:'TIEBA_REPLIES_FORMAT_CHANGED'},mention:{key:'tieba:mention-watch',error:'TIEBA_MENTIONS_FORMAT_CHANGED'}} as const;
const minute=60000,delay=5*minute;
/** The pre-check never holds exploration behind the capture worker's long queue. */
async function boundedRead<T>(read:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!signal)return read();
 signal.throwIfAborted();
 let abort!:()=>void;
 const timeout=new Promise<never>((_resolve,reject)=>{abort=()=>reject(new FishError('TIEBA_READ_TIMEOUT'));signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([read(),timeout]);}finally{signal.removeEventListener('abort',abort);}
}
type Cursor={account:string;since:number;page:number;scanStarted:number|null;nextCheck:number;lastCheck:number|null;lastError:string|null;pausedAt?:number;lease?:string;leaseUntil?:number};
/** Independent inbox cursors feed one durable exploration queue. */
export class TiebaReplyWatch {
 private pending?:Promise<void>;
 private nextFeed:Kind='mention';
 constructor(private state:ExplorationState,private enabled:()=>boolean,private client=new TiebaAccountClient(),private now=Date.now){
  ensureTiebaReplyBadge(state.store);
  state.store.transaction(()=>{
   state.store.db.exec(`CREATE TABLE IF NOT EXISTS tieba_reply_events(account TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,created INTEGER NOT NULL,detected INTEGER NOT NULL,due INTEGER NOT NULL,run_id TEXT,payload TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'reply',PRIMARY KEY(account,id));
    CREATE INDEX IF NOT EXISTS tieba_reply_pending ON tieba_reply_events(owner,account,run_id,due);`);
   if(!state.store.db.prepare('PRAGMA table_info(tieba_reply_events)').all().some(column=>column.name==='kind'))state.store.db.exec("ALTER TABLE tieba_reply_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply'");
  });
 }
 private cursor(kind:Kind):Cursor|undefined{const value=this.state.store.getMeta(feeds[kind].key);return value?JSON.parse(value):undefined;}
 tick(allowRead=true){
  if(!this.enabled()||!this.state.settings().enabled)return;
  this.wake();
  if(!allowRead||this.pending)return;
  for(const kind of [this.nextFeed,this.nextFeed==='reply'?'mention':'reply'] as const){
   const cursor=this.cursor(kind);
   if(cursor&&(cursor.nextCheck>this.now()||(cursor.leaseUntil??0)>this.now()))continue;
   this.nextFeed=kind==='reply'?'mention':'reply';
   this.pending=this.poll(kind).catch(e=>{this.state.store.audit('tieba-'+kind+'-watch','',codeOf(e));}).finally(()=>{this.pending=undefined;});
   break;
  }
 }
 async idle(){await this.pending;}
 /** One read-only inbox page, no wakeup or model call. Failures are advisory. */
 async checkNow(){
  try{
   if(!this.enabled()||this.pending)return;
   const now=this.now(),last=this.state.store.getMeta('tieba:reply-badge-check');
   const checked=[this.cursor('reply')?.lastCheck,this.cursor('mention')?.lastCheck,...(last?[Number(last)]:[])];
   if(checked.some(at=>typeof at==='number'&&now-at<minute))return;
   this.state.store.setMeta('tieba:reply-badge-check',String(now));
   for(const kind of [this.nextFeed,this.nextFeed==='reply'?'mention':'reply'] as const){
    const cursor=this.cursor(kind);
    if(cursor&&(cursor.nextCheck>now||(cursor.leaseUntil??0)>now))continue;
    this.nextFeed=kind==='reply'?'mention':'reply';
    this.pending=this.poll(kind,AbortSignal.timeout(1500)).catch(()=>{}).finally(()=>{this.pending=undefined;});
    await this.pending;break;
   }
  }catch{/* Disabled, unconfigured and offline inboxes never fail exploration. */}
 }
 private async poll(kind:Kind,signal?:AbortSignal){
  const {key,error}=feeds[kind];
  const owner=this.state.settings().owner;this.state.assertOwner(owner);
  const lease=randomUUID(),acquired=this.state.store.transaction(()=>{
   const c=this.cursor(kind);if(c&&(c.nextCheck>this.now()||(c.leaseUntil??0)>this.now()))return false;
   this.state.store.setMeta(key,JSON.stringify({...c,nextCheck:this.now()+minute,lease,leaseUntil:this.now()+120000}));return true;
  });if(!acquired)return;
  let cursor=this.cursor(kind)!;
  try{
   const status=await boundedRead(()=>this.client.status(),signal),account=status.identity??status.lastIdentity;
   if(!account||!status.profileSaved||!(signal?['logged_in']:['logged_in','needs_check','check_failed']).includes(status.state)){
    cursor.lastError=status.lastError?.code??(status.state==='unconfigured'?'TIEBA_NOT_CONFIGURED':'TIEBA_LOGIN_REQUIRED');cursor.pausedAt=this.now();return;
   }
   if(cursor.pausedAt!==undefined&&(status.verifiedAt??0)<=cursor.pausedAt)return;
   cursor.pausedAt=undefined;
   if(cursor.account!==account.id){cursor={account:account.id,since:Math.floor(this.now()/1000)*1000,page:1,scanStarted:null,nextCheck:this.now()+minute,lastCheck:null,lastError:null,lease,leaseUntil:this.now()+120000};}
   if(cursor.scanStarted===null)cursor.scanStarted=this.now();
   if(this.cursor(kind)?.lease===lease)this.state.store.setMeta(key,JSON.stringify(cursor));
   const page=await boundedRead(()=>kind==='reply'?this.client.replies(cursor.page):this.client.mentions(cursor.page),signal);
   if(page.account?.id!==account.id)throw new FishError('TIEBA_ACCOUNT_CHANGED');
   const notices:Notice[]=kind==='reply'?page.replies:page.mentions;
   if(!Array.isArray(notices)||typeof page.hasMore!=='boolean'||page.page!==cursor.page)throw new FishError(error);
   this.state.store.transaction(()=>{
    // Re-check human configuration after the asynchronous platform read.
    if(this.state.settings().owner!==owner)return;
    const existing=this.state.store.db.prepare('SELECT min(due) AS due FROM tieba_reply_events WHERE account=? AND owner=? AND run_id IS NULL').get(account.id,owner) as any;
    const due=existing?.due??this.now()+delay;
    const prior=this.state.store.db.prepare('SELECT kind,payload FROM tieba_reply_events WHERE account=? AND id=? AND owner=? AND run_id IS NULL');
    const save=this.state.store.db.prepare(`INSERT INTO tieba_reply_events(account,id,owner,created,detected,due,run_id,payload,kind) VALUES (?,?,?,?,?,?,NULL,?,?)
     ON CONFLICT DO UPDATE SET payload=excluded.payload,kind=excluded.kind
     WHERE tieba_reply_events.owner=excluded.owner AND tieba_reply_events.run_id IS NULL`);
    for(const r of notices){
     if(r.author.id===account.id||r.time<cursor.since||isTiebaReplySeen(this.state.store,account.id,r,kind))continue;
     const old=prior.get(account.id,r.id,owner) as Pick<PendingNotice,'kind'|'payload'>|undefined;
     const earlier=old?JSON.parse(old.payload) as Notice:undefined;
     const chosen=old?.kind==='mention'&&kind==='reply'?earlier!:r;
     const verified=[r,earlier].find(item=>item?.targetStatus==='verified');
     const notice=verified?{...chosen,targetStatus:verified.targetStatus,parentPostId:verified.parentPostId,
      floor:verified.floor,replyTo:verified.replyTo,replyTarget:verified.replyTarget,targetError:undefined}:chosen;
     save.run(account.id,r.id,owner,r.time,this.now(),due,JSON.stringify(notice),old?.kind==='mention'?'mention':kind);
    }
    // Completed receipts are bounded. The persisted scan watermark prevents
    // old inbox entries from becoming new again after receipt pruning.
    this.state.store.db.prepare('DELETE FROM tieba_reply_events WHERE kind=? AND run_id IS NOT NULL AND created<? AND rowid NOT IN (SELECT rowid FROM tieba_reply_events WHERE kind=? ORDER BY detected DESC LIMIT 10000)').run(kind,cursor.since,kind);
   });
   const crossed=notices.some(r=>r.time<cursor.since);
   if(page.hasMore&&!crossed){if(cursor.page>=10000)throw new FishError(kind==='reply'?'TIEBA_REPLIES_PAGE_LIMIT':'TIEBA_MENTIONS_PAGE_LIMIT');cursor.page++;cursor.nextCheck=this.now();}
   else{cursor.since=Math.max(cursor.since,cursor.scanStarted-60000);cursor.scanStarted=null;cursor.page=1;}
   cursor.lastCheck=this.now();cursor.lastError=null;
   this.state.store.setMeta('tieba:reply-badge-account',account.id);
  }catch(e){
   const code=codeOf(e);cursor.lastError=code;cursor.nextCheck=this.now()+minute;
   const retryable=/^TIEBA_(BUSY|PROFILE_BUSY|LOGIN_IN_PROGRESS|WORKER_UNAVAILABLE|WORKER_RESPONSE_FAILED|READ_TIMEOUT|READ_NETWORK_FAILED|READ_HTTP_5\d\d)$/.test(code);
   if(!retryable&&(kind==='reply'||['TIEBA_LOGIN_REQUIRED','TIEBA_ACCOUNT_CHANGED','TIEBA_NOT_CONFIGURED'].includes(code)))cursor.pausedAt=this.now();
   this.state.store.audit('tieba-'+kind+'-watch','',code);
  }finally{
   // A process crash leaves a short lease; another process resumes the same
   // cursor after it expires rather than starting duplicate account reads.
   if(this.cursor(kind)?.lease===lease)this.state.store.setMeta(key,JSON.stringify({...cursor,lease:undefined,leaseUntil:undefined}));
  }
 }
 private wake(){
  const reply=this.cursor('reply'),mention=this.cursor('mention'),owner=this.state.settings().owner;
  if(reply?.account&&mention?.account&&reply.account!==mention.account)return;
  const replyAccount=reply?.pausedAt===undefined?reply?.account??'':'',mentionAccount=mention?.pausedAt===undefined?mention?.account??'':'';
  if(!replyAccount&&!mentionAccount)return;
  this.state.store.transaction(()=>{
   this.state.recover();
   const rows=(this.state.store.db.prepare(`SELECT id,kind,payload,detected FROM tieba_reply_events WHERE owner=? AND run_id IS NULL AND due<=?
    AND ((kind='reply' AND account=?) OR (kind='mention' AND account=?)) ORDER BY detected,id LIMIT 20`).all(owner,this.now(),replyAccount,mentionAccount) as PendingNotice[])
    .filter(row=>{const notice:Notice=JSON.parse(row.payload),account=row.kind==='mention'?mentionAccount:replyAccount;return notice.author.id!==account&&!isTiebaReplySeen(this.state.store,account,notice,row.kind);});
   if(!rows.length)return;
   const format=(r:PendingNotice)=>{
    const p:Notice=JSON.parse(r.payload),resolved=!p.isFloor||p.targetStatus==='verified';
    return {id:p.id,threadId:p.threadId,threadTitle:p.threadTitle,forum:p.forum,floor:p.floor??null,author:p.author??null,replyTo:p.replyTo??null,text:p.text,
      threadReplyTarget:threadReplyTarget(p.threadId),replyTarget:resolved?p.replyTarget:undefined,url:p.url,parentPostId:resolved?p.parentPostId:null,replyToPostId:p.replyToPostId??p.parentPostId,
      isThread:p.isThread,isFloor:p.isFloor,publishedAt:p.time,detectedAt:r.detected,targetStatus:p.targetStatus,targetError:p.targetError};
   };
   const mentions=rows.filter(r=>r.kind==='mention').map(format),replies=rows.filter(r=>r.kind==='reply').map(format);
   const trigger=mentions.length?'tieba_mention':'tieba_reply',accountId=mentionAccount||replyAccount;
   const reminder=mentions.length?(replies.length?'贴吧有人 @ 你，也有新回复。':'贴吧有人 @ 你。'):'贴吧有新回复，想看可以看看。';
   const notification={kind:trigger,reminder,accountId,count:rows.length,
    replyHint:'通知里的 threadReplyTarget 用于向整个主题盖新楼。只有明确想回通知中的楼层或那个人的子回复时，才用其 replyTarget 和对应 replyScope。',
    ...(mentions.length?{mentions,openWith:'browse_page'}:{}),...(replies.length?{replies,readWith:'get_tieba_replies'}:{})};
   const queued=this.state.enqueue(trigger,JSON.stringify(notification));if(queued.reused)return;
   const assign=this.state.store.db.prepare('UPDATE tieba_reply_events SET run_id=? WHERE account=? AND owner=? AND id=? AND run_id IS NULL');
   for(const row of rows)assign.run(queued.run.id,accountId,owner,row.id);
   this.state.store.audit(mentions.length?'tieba-mention-wake':'tieba-reply-wake','private:'+owner,JSON.stringify({runId:queued.run.id,replies:replies.length,mentions:mentions.length,delayMs:delay}));
  });
 }
}
