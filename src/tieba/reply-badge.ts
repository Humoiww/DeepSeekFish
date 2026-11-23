import type {Store} from '../storage/db.js';
import type {TiebaReply} from './replies.js';

export type TiebaReplyKind='reply'|'mention';
type Watch={account?:string;since?:number;lastCheck?:number|null;lastError?:string|null};
type BadgeMeta={checkedAt?:number;clearedAt?:number};
const metaKey=(account:string)=>'tieba:reply-badge:'+account;
const hasEvents=(store:Store)=>!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tieba_reply_events'").get();
const watch=(store:Store,kind:TiebaReplyKind):Watch=>JSON.parse(store.getMeta('tieba:'+kind+'-watch')??'{}');

export function ensureTiebaReplyBadge(store:Store){
 store.db.exec(`CREATE TABLE IF NOT EXISTS tieba_reply_seen(account TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,seen_at INTEGER NOT NULL,PRIMARY KEY(account,id));
  CREATE INDEX IF NOT EXISTS tieba_reply_seen_recent ON tieba_reply_seen(account,seen_at DESC);`);
}

/** Platform content is data only. An old watermark is a baseline, except for
 * items explicitly waiting in the durable notification queue. */
export function isTiebaReplySeen(store:Store,account:string,item:Pick<TiebaReply,'id'|'time'>,kind:TiebaReplyKind='reply'){
 ensureTiebaReplyBadge(store);
 if(store.db.prepare('SELECT 1 FROM tieba_reply_seen WHERE account=? AND id=?').get(account,item.id))return true;
 if(hasEvents(store)){
  const event=store.db.prepare('SELECT run_id FROM tieba_reply_events WHERE account=? AND id=?').get(account,item.id);
  if(event)return event.run_id!==null;
 }
 const cursor=watch(store,kind),baseline=cursor.account===account?cursor:watch(store,'reply');
 return baseline.account===account&&Number.isFinite(baseline.since)&&item.time<baseline.since!;
}

export function tiebaReplyBadge(store:Store,account?:string){
 ensureTiebaReplyBadge(store);
 const reply=watch(store,'reply'),mention=watch(store,'mention');
 const selected=account??store.getMeta('tieba:reply-badge-account')??reply.account??mention.account??null;
 const meta:BadgeMeta=selected?JSON.parse(store.getMeta(metaKey(selected))??'{}'):{};
 const cursors=[reply,mention].filter(c=>!!selected&&c.account===selected);
 const checks=[meta.checkedAt,...cursors.map(c=>c.lastCheck)].filter((at):at is number=>typeof at==='number');
 const checkedAt=checks.length?Math.max(...checks):null;
 let unreadReplies=0,unreadMentions=0;
 if(selected&&hasEvents(store)){
  const hasKind=store.db.prepare('PRAGMA table_info(tieba_reply_events)').all().some(c=>c.name==='kind');
  const rows=store.db.prepare(`SELECT ${hasKind?'e.kind':"'reply'"} AS kind,count(*) AS count FROM tieba_reply_events e
   WHERE e.account=? AND e.run_id IS NULL AND NOT EXISTS(SELECT 1 FROM tieba_reply_seen s WHERE s.account=e.account AND s.id=e.id)
   AND CASE WHEN json_valid(e.payload) THEN coalesce(json_extract(e.payload,'$.author.id'),'')!=? ELSE 0 END GROUP BY 1`).all(selected,selected);
  for(const row of rows)if(row.kind==='mention')unreadMentions+=Number(row.count);else unreadReplies+=Number(row.count);
 }
 const unreadCount=unreadReplies+unreadMentions,redDot=unreadCount>0;
 const unavailable=cursors.some(c=>!!c.lastError&&(c.lastCheck??0)>=(meta.checkedAt??0));
 const status=unavailable?'unavailable':checkedAt!==null?'ok':'unchecked';
 const message=(redDot?`贴吧小红点亮着：有 ${unreadCount} 条未读新通知（回复 ${unreadReplies}、@ ${unreadMentions}），想看可以查看。`:
  '贴吧小红点未亮：没有已知的未读新回复或 @，无需重复查看旧回复。')+
  (status==='unavailable'?' 最近检查未成功，以上是本地已知状态。':status==='unchecked'?' 尚未完成收件箱检查。':'');
 return {redDot,unreadCount,unreadReplies,unreadMentions,account:selected,checkedAt,clearedAt:meta.clearedAt??null,status,message};
}

export function markTiebaRepliesSeen(store:Store,account:string,ids:readonly string[],kind:TiebaReplyKind='reply',now=Date.now()){
 ensureTiebaReplyBadge(store);
 const write=()=>{
  const save=store.db.prepare('INSERT INTO tieba_reply_seen(account,id,kind,seen_at) VALUES (?,?,?,?) ON CONFLICT(account,id) DO UPDATE SET kind=excluded.kind,seen_at=excluded.seen_at');
  const clear=hasEvents(store)?store.db.prepare('DELETE FROM tieba_reply_events WHERE account=? AND id=? AND run_id IS NULL'):undefined;
  for(const id of new Set(ids)){
   save.run(account,id,kind,now);clear?.run(account,id);
  }
  store.db.prepare('DELETE FROM tieba_reply_seen WHERE account=? AND rowid NOT IN (SELECT rowid FROM tieba_reply_seen WHERE account=? ORDER BY seen_at DESC,rowid DESC LIMIT 10000)').run(account,account);
  const meta:BadgeMeta=JSON.parse(store.getMeta(metaKey(account))??'{}');
  store.setMeta(metaKey(account),JSON.stringify({...meta,clearedAt:now}));
 };
 if(store.db.isTransaction)write();else store.transaction(write);
}

export function annotateTiebaReplies<T extends {account?:{id:string}|null;replies:TiebaReply[]}>(store:Store,page:T,now=Date.now()):Omit<T,'replies'>&{
 replies:Array<TiebaReply&{isNew:boolean}>;newCount:number;redDotCleared:boolean;badgeNote:string;
}{
 ensureTiebaReplyBadge(store);
 const write=()=>{
  const account=page.account?.id;
  const replies=page.replies.map(reply=>({...reply,isNew:!!account&&reply.author.id!==account&&!isTiebaReplySeen(store,account,reply)}));
  const newCount=new Set(replies.filter(reply=>reply.isNew).map(reply=>reply.id)).size;
  if(account){
   markTiebaRepliesSeen(store,account,replies.map(reply=>reply.id),'reply',now);
   const meta:BadgeMeta=JSON.parse(store.getMeta(metaKey(account))??'{}');
   store.setMeta(metaKey(account),JSON.stringify({...meta,checkedAt:now}));
   store.setMeta('tieba:reply-badge-account',account);
  }
  return {...page,replies,newCount,redDotCleared:!!account,badgeNote:account?
   `本页有 ${newCount} 条新回复；本页回复已标为看过，对应小红点已清除。`:'未提供贴吧账号，无法确认新旧或清除未读记录。'};
 };
 return store.db.isTransaction?write():store.transaction(write);
}
