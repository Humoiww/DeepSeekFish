import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {FishError,codeOf,type ModelTool} from '../types.js';
import type {PublicPoster} from '../search/public-web.js';
import type {TiebaIdentity} from './session.js';
import {APP_POST_URL,AppPostFailure} from './app-post.js';
import type {WebOutcome} from './web-post.js';
import type {Store} from '../storage/db.js';

export interface FollowedForum {id:string;name:string}
export interface PublishInput {action:'thread'|'reply'|'comment';forumId:string;title?:string;content:string;threadId?:string;postId?:string;page?:number;subPostId?:string;commentPage?:number}
export interface PostingPolicy {mode:'preview'|'live';accountId:string}
export interface SystemDeletion {postId:string;threadId:string;category:'system';reason:string;time:string;timeZone:'Asia/Hong_Kong';source:'tieba_account_recycle'}
export interface PostingReader {followed(userId:string):Promise<FollowedForum[]>;read(url:string):Promise<any>;publicRead?(url:string):Promise<any>;deletion?(postId:string,threadId:string):Promise<SystemDeletion|null>}
export interface ReplyTarget {id:string;postId:string;name:string;portrait:string|null}
export interface PostingRequest {protocol:'legacy_thread_form'|'app_protobuf'|'official_web';action:PublishInput['action'];url:string;fields:Record<string,string>}
const numeric=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v);
const publishFields=['action','forumId','title','content','threadId','postId','page','subPostId','commentPage'];
class PublishInputError extends FishError {
 constructor(code:string,readonly field:string,readonly reason:string){super(code);}
}
const invalidInput=(field:string,reason:string,code='TIEBA_PUBLISH_INPUT_INVALID'):never=>{throw new PublishInputError(code,field,reason);};
const fingerprintOf=(account:string,v:PublishInput)=>createHash('sha256').update(JSON.stringify([account,v.action,v.forumId,v.threadId??'',v.postId??'',v.subPostId??'',v.title??'',v.content])).digest('hex');
export function publishInput(v:any):PublishInput{
 if(!v||typeof v!=='object'||Array.isArray(v))invalidInput('$','入参必须是对象。');
 const unknown=Object.keys(v).find(k=>!publishFields.includes(k));
 if(unknown)invalidInput(/^[a-zA-Z_][a-zA-Z_0-9]{0,39}$/.test(unknown)?unknown:'$','不支持此参数。预演或真实发布由管理员配置，先用get_tieba_account查看posting.mode；单次调用不能传preview或mode切换模式。');
 if(!['thread','reply','comment'].includes(v.action))invalidInput('action','只能是thread（新主题）、reply（帖子新楼层）或comment（楼中楼）。');
 if(!numeric(v.forumId))invalidInput('forumId','必须是get_tieba_account返回的关注吧ID字符串，并与目标帖子所属吧一致。');
 if(typeof v.content!=='string'||!v.content.trim()||v.content.length>20000||v.content.includes('\0'))invalidInput('content','必须是非空正文字符串，至多20000字符，不能含空字符。');
 if(v.commentPage!==undefined&&(!Number.isInteger(v.commentPage)||v.commentPage<1||v.commentPage>10000))invalidInput('commentPage','必须是1至10000的整数。','TIEBA_PAGE_INVALID');
 if(v.subPostId!==undefined&&(!numeric(v.subPostId)||v.action!=='comment'))invalidInput('subPostId','仅comment可传，值为读到的子回复ID字符串。');
 if(v.commentPage!==undefined&&v.action!=='comment')invalidInput('commentPage','仅comment可传子回复页码。');
 if(v.page!==undefined&&(!Number.isInteger(v.page)||v.page<1||v.page>10000))invalidInput('page','必须是1至10000的整数。','TIEBA_PAGE_INVALID');
 if(v.action==='thread'){
  if(typeof v.title!=='string'||!v.title.trim()||v.title.length>200)invalidInput('title','thread必须传非空标题，至多200字符。');
  for(const field of ['threadId','postId','page'])if(v[field]!==undefined)invalidInput(field,'thread创建新主题，不传threadId、postId或page。');
 }else {
  if(v.title!==undefined)invalidInput('title','只有thread传title。');
  if(!numeric(v.threadId))invalidInput('threadId','reply和comment必须传实际读到的帖子ID字符串。');
  if(v.action==='comment'&&!numeric(v.postId))invalidInput('postId','comment必须传父楼层ID；可选subPostId指定子回复。');
  if(v.action==='reply'&&v.postId!==undefined)invalidInput('postId','reply在帖子中盖新楼，不传postId；回复某个楼层请用comment。');
 }
 if(Buffer.byteLength(JSON.stringify(v),'utf8')>14000)invalidInput('$','整份入参JSON超过14000字节，请缩短正文。','TIEBA_PUBLISH_INPUT_TOO_LARGE');
 return {...v,content:v.content.trim(),...(v.title?{title:v.title.trim()}:{})};
}
/** The same validator protects the private transport and gives both model
 * entry points actionable feedback before any account RPC or write intent. */
export function publishInputFeedback(v:unknown){
 try{publishInput(v);return undefined;}catch(e){
  if(!(e instanceof PublishInputError))throw e;
  return {error:e.code,stage:'input_validation',submitted:false,published:false,requestSent:false,
   issue:{field:e.field,reason:e.reason},allowedFields:publishFields,
   requiredByAction:{thread:['action','forumId','content','title'],reply:['action','forumId','content','threadId'],comment:['action','forumId','content','threadId','postId']}};
 }
}
/** Small live owner status, including failures before a publishing outbox
 * exists. Detailed history stays in the ordinary private activity traces. */
export async function trackTiebaPublication<T>(store:Store,input:any,requestId:string,operation:()=>Promise<T>):Promise<T>{
 const startedAt=Date.now(),request=Object.fromEntries(['action','forumId','threadId','postId','subPostId','title','content'].filter(k=>typeof input?.[k]==='string').map(k=>[k,input[k].slice(0,k==='content'?1000:200)]));
 const record=(result:any)=>store.transaction(()=>{
  const previous=JSON.parse(store.getMeta('tieba:last-attempt')??'null');if(previous&&previous.startedAt>startedAt)return;
  const summary=Object.fromEntries(['error','stage','issue','submitted','published','requestSent','deliveryStatus','id','url','receipt'].filter(k=>result?.[k]!==undefined).map(k=>[k,result[k]]));
  store.setMeta('tieba:last-attempt',JSON.stringify({requestId,startedAt,at:Date.now(),request,result:summary}));
 });
 record({stage:'running'});
 try{const result=await operation();record(result);return result;}catch(e){record({error:codeOf(e),stage:'tool_error'});throw e;}
}
export async function followedForums(poster:PublicPoster,userId:string){
 const forums=new Map<string,FollowedForum>();
 for(let page=1;page<=100;page++){
  const r=await poster('https://tiebac.baidu.com/c/f/forum/like',new URLSearchParams({_client_type:'2',_client_version:'12.64.1.1',friend_uid:userId,page_no:String(page),page_size:'50'}));
  let d:any;try{d=JSON.parse(r.bytes.toString('utf8'));}catch{throw new FishError('TIEBA_FOLLOW_LIST_INVALID');}
  if(!['0',0].includes(d?.error_code))throw new FishError('TIEBA_FOLLOW_LIST_REJECTED');
  const list=d.forum_list;
  if(!list||typeof list!=='object'||Array.isArray(list)||![0,1,'0','1'].includes(d.has_more))throw new FishError('TIEBA_FOLLOW_LIST_INVALID');
  for(const key of ['non-gconforum','gconforum']){
   if(list[key]!==undefined&&!Array.isArray(list[key]))throw new FishError('TIEBA_FOLLOW_LIST_INVALID');
   for(const f of list[key]??[]){const id=String(f.id??'');if(!numeric(id)||typeof f.name!=='string'||!f.name)throw new FishError('TIEBA_FOLLOW_LIST_INVALID');forums.set(id,{id,name:f.name.slice(0,100)});}
  }
  if(Number(d.has_more)===0)return [...forums.values()];
 }
 throw new FishError('TIEBA_FOLLOW_LIST_INCOMPLETE');
}
export async function postingTarget(input:PublishInput,identity:TiebaIdentity,policy:PostingPolicy,reader:PostingReader){
 if(identity.id!==policy.accountId)throw new FishError('TIEBA_ACCOUNT_NOT_AUTHORIZED');
 const followed=await reader.followed(identity.id),forum=followed.find(f=>f.id===input.forumId);
 if(!forum)throw new FishError('TIEBA_FORUM_READ_ONLY');
 let replyTo:ReplyTarget|undefined;
 if(input.action!=='thread'){
  const page=await reader.read('https://tieba.baidu.com/p/'+input.threadId+'?pn='+(input.page??1));
  if(page?.status!=='content'||String(page.thread?.id)!==input.threadId)throw new FishError('TIEBA_THREAD_NOT_VERIFIED');
  if(String(page.forum?.id)!==forum.id)throw new FishError('TIEBA_FORUM_MISMATCH');
  if(input.action==='comment'){
   const parent=page.posts?.find((p:any)=>p.id===input.postId);if(!parent)throw new FishError('TIEBA_FLOOR_NOT_VERIFIED');
   if(!numeric(parent.author?.id))throw new FishError('TIEBA_REPLY_TARGET_IDENTITY_UNAVAILABLE');
   replyTo={id:parent.author.id,postId:parent.id,name:parent.author.name??'',portrait:parent.author.portrait??null};
  }
  if(input.subPostId){
   const comments=await reader.read('https://tieba.baidu.com/p/comment?tid='+input.threadId+'&pid='+input.postId+'&pn='+(input.commentPage??1));
   const target=comments.posts?.find((p:any)=>p.id===input.subPostId&&p.parentPostId===input.postId);
   if(comments.status!=='content'||String(comments.forum?.id)!==forum.id||String(comments.thread?.id)!==input.threadId||!target||!numeric(target.author?.id))throw new FishError('TIEBA_COMMENT_NOT_VERIFIED');
   if(typeof target.author.name!=='string'||!target.author.name||typeof target.author.portrait!=='string'||! /^[a-zA-Z0-9_.-]{1,200}$/.test(target.author.portrait))throw new FishError('TIEBA_REPLY_TARGET_METADATA_UNAVAILABLE');
   replyTo={id:target.author.id,postId:target.id,name:target.author.name,portrait:target.author.portrait};
  }
 }
 return {...forum,...(replyTo?{replyTo}:{})};
}
/** Plain-text first. Target IDs are server-verified before these API fields
 * are built. CSRF/session fields are added only by the isolated browser. */
export function postingRequest(input:PublishInput,forum:FollowedForum&{replyTo?:ReplyTarget}):PostingRequest{
 const fields:Record<string,string>={_client_type:'2',_client_version:input.action==='thread'?'12.64.1.1':'22.12.1.0',fid:forum.id,kw:forum.name,content:input.content};
 if(input.action==='thread')fields.title=input.title!;
 else {fields.tid=input.threadId!;if(input.action==='comment'){
  if(!forum.replyTo)throw new FishError('TIEBA_REPLY_TARGET_IDENTITY_UNAVAILABLE');
  fields.quote_id=input.postId!;fields.repostid=input.postId!;fields.sub_post_id=input.subPostId??'';fields.reply_uid=forum.replyTo.id;
  if(input.subPostId)fields.content='回复 #(reply, '+forum.replyTo.portrait+', '+forum.replyTo.name.replace(/[()]/g,'')+') :'+input.content;
 }}
 return {protocol:input.action==='thread'?'legacy_thread_form':'app_protobuf',action:input.action,url:input.action==='thread'?'https://tiebac.baidu.com/c/c/thread/add':APP_POST_URL,fields};
}
/** A missing response ID is not permission to re-send. Confirm only a unique
 * self-authored item in the correct scope, with matching text and time. */
export async function findPublication(input:PublishInput,forum:FollowedForum,who:TiebaIdentity,reader:PostingReader,since:number,expectedId?:string,inspect?:(page:any)=>void){
 const norm=(v:unknown)=>String(v??'').replace(/\\r\\n|\\n|\\r/g,'\n').replace(/\s+/g,''),wanted=norm(input.content);
 if(input.action==='thread'&&expectedId){
  const full=await reader.read('https://tieba.baidu.com/p/'+expectedId);inspect?.(full);
  const first=full?.posts?.find((p:any)=>p.floor===1);
  if(full?.status==='content'&&String(full.forum?.id)===forum.id&&full.thread?.id===expectedId&&full.thread?.author?.id===who.id&&full.thread?.title===input.title&&first?.author?.id===who.id&&Date.parse(first.publishedAt)>=since-2000&&norm(full.text).includes(wanted))return {id:expectedId,url:'https://tieba.baidu.com/p/'+expectedId};
  return null;
 }
 const url=input.action==='thread'?'https://tieba.baidu.com/f?kw='+encodeURIComponent(forum.name):input.action==='reply'?'https://tieba.baidu.com/p/'+input.threadId+(expectedId?'?pid='+expectedId:''):'https://tieba.baidu.com/p/comment?tid='+input.threadId+'&pid='+input.postId;
 let page=await reader.read(url);inspect?.(page);if(page?.status!=='content'||String(page.forum?.id)!==forum.id)return null;
 if(input.action!=='thread'&&!expectedId&&Number(page.totalPages)>1){page=await reader.read(url+(url.includes('?')?'&':'?')+'pn='+page.totalPages);inspect?.(page);}
 if(page?.status!=='content'||String(page.forum?.id)!==forum.id)return null;
 const hits=(page.posts??[]).filter((p:any)=>(!expectedId||p.id===expectedId)&&p.author?.id===who.id&&Date.parse(p.publishedAt)>=since-2000&&Date.parse(p.publishedAt)<=Date.now()+2000&&(input.action!=='thread'||p.title===input.title)&&(input.action!=='comment'||p.parentPostId===input.postId)&&(norm(p.content)===wanted||p.contentTruncated&&wanted.startsWith(norm(p.content))||input.subPostId&&!p.contentTruncated&&norm(p.content).startsWith('回复')&&norm(p.content).endsWith(wanted)));
 if(hits.length!==1)return null;const hit=hits[0];
 if(input.action==='thread'){
  const full=await reader.read('https://tieba.baidu.com/p/'+hit.id);
  if(full?.status!=='content'||full.thread?.author?.id!==who.id||String(full.forum?.id)!==forum.id||!norm(full.text).includes(wanted))return null;
 }
 return {id:hit.id,url:input.action==='thread'?'https://tieba.baidu.com/p/'+hit.id:'https://tieba.baidu.com/p/'+input.threadId+'?pid='+hit.id+'#'+hit.id};
}
/** An allocated ID acknowledges submission, not public visibility. Re-check
 * without posting; the account view may include content hidden from others. */
async function publicationVisibility(input:PublishInput,forum:FollowedForum,who:TiebaIdentity,reader:PostingReader,since:number,id?:string){
 const checks:Record<string,unknown>={};let observed:{id:string;url:string}|null=null;
 for(const access of ['public','account'] as const){
  const read=access==='public'?reader.publicRead:reader.read;
  if(!read){checks[access]={error:'TIEBA_PUBLIC_READ_UNAVAILABLE'};continue;}
  try{
   const hit=await findPublication(input,forum,who,{...reader,read},since,id,page=>{checks[access]={status:page?.status??'unavailable',returned:page?.returned??0,totalReported:page?.totalReported??null,platformNotice:page?.platformNotice??null,errors:(page?.unavailable??[]).map((v:any)=>v.error).slice(0,5)};});
   if(hit){observed=hit;if(access==='public')return {publicVerified:true,visibility:'public',observed,checks,verifiedAt:Date.now()};}
  }catch(e){checks[access]={error:codeOf(e)};}
 }
 let deletion:SystemDeletion|null=null;
 if(id&&reader.deletion){try{const found=await reader.deletion(id,input.action==='thread'?id:input.threadId!);checks.deletion={checked:true,coverage:'recycle_first_page',matched:!!found};if(found?.postId===id&&found.threadId===(input.action==='thread'?id:input.threadId)&&found.category==='system'&&found.source==='tieba_account_recycle')deletion=found;}catch(e){checks.deletion={error:codeOf(e)};}}
 return {publicVerified:false,visibility:deletion?'removed_by_system':observed?'author_only':'not_observed',observed,checks,...(deletion?{deletion}:{}),verifiedAt:Date.now()};
}
export class TiebaPosting {
 private db:DatabaseSync;
 constructor(dir:string){
  this.db=new DatabaseSync(path.join(dir,'actions.sqlite'));fs.chmodSync(path.join(dir,'actions.sqlite'),0o600);this.db.exec('PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS tieba_actions(id TEXT PRIMARY KEY,account TEXT,fingerprint TEXT,state TEXT,request TEXT,result TEXT,created INTEGER);');
  // Older fingerprints depended on JSON key order. Normalize only the derived
  // dedupe key; original requests/results and uncertain outcomes stay intact.
  if(Number((this.db.prepare('PRAGMA user_version').get() as any).user_version)<1){
   this.db.exec('BEGIN IMMEDIATE');try{
    if(Number((this.db.prepare('PRAGMA user_version').get() as any).user_version)<1){
     for(const r of this.db.prepare('SELECT id,account,request,fingerprint FROM tieba_actions').all() as any[]){
      let input:PublishInput;try{input=publishInput(JSON.parse(r.request));}catch{continue;}
      const fingerprint=fingerprintOf(r.account,input);if(r.fingerprint!==fingerprint)this.db.prepare('UPDATE tieba_actions SET fingerprint=? WHERE id=?').run(fingerprint,r.id);
     }this.db.exec('PRAGMA user_version=1');
    }this.db.exec('COMMIT');
   }catch(e){this.db.exec('ROLLBACK');this.db.close();throw e;}
  }
  // Preview text is bounded; unknown/live receipts are never silently discarded.
  this.db.exec("DELETE FROM tieba_actions WHERE state='preview' AND id NOT IN (SELECT id FROM tieba_actions WHERE state='preview' ORDER BY created DESC LIMIT 500)");
 }
 close(){this.db.close();}
 history(){return this.db.prepare('SELECT id,account,state,request,result,created FROM tieba_actions ORDER BY created DESC LIMIT 30').all().map((r:any)=>({...r,request:JSON.parse(r.request),result:JSON.parse(r.result??'{}')}));}
 recoverySource(identity:TiebaIdentity){
  const row=this.history().find(r=>r.account===identity.id&&r.state==='rejected'&&(r.result.error==='TIEBA_PUBLICATION_CHALLENGE'||r.result.receipt?.notSubmitted===true)&&r.result.submitted===false&&!r.result.id);
  if(!row)throw new FishError('TIEBA_NO_REJECTED_PUBLICATION');return row;
 }
 webAttempt(requestId:string){
  const row=this.db.prepare('SELECT result FROM tieba_actions WHERE id=?').get(requestId) as any;if(!row)throw new FishError('TIEBA_PUBLICATION_NOT_FOUND');
  const prior=JSON.parse(row.result??'{}');
  if(prior.id||Number(prior.receipt?.httpAttempts)>0&&!(prior.error==='TIEBA_PUBLICATION_CHALLENGE'&&prior.submitted===false))throw new FishError('TIEBA_WEB_SUBMISSION_ALREADY_STARTED');
  const result={...prior,submitted:null,published:false,deliveryStatus:'unconfirmed',error:null,receipt:{transport:'official_web',httpAttempts:Number(prior.receipt?.httpAttempts??0)+1},initialResult:prior.initialResult??prior,retryScheduled:false};
  this.db.prepare('UPDATE tieba_actions SET state=?,result=? WHERE id=?').run('held',JSON.stringify(result),requestId);
 }
 webOutcome(requestId:string,outcome:WebOutcome){
  const row=this.db.prepare('SELECT request,result FROM tieba_actions WHERE id=?').get(requestId) as any;if(!row)throw new FishError('TIEBA_PUBLICATION_NOT_FOUND');
  const input=JSON.parse(row.request),prior=JSON.parse(row.result??'{}');if(prior.id&&outcome.id!==prior.id)return prior;
  const rejected=outcome.receipt.accepted===false&&!outcome.id&&(outcome.receipt.notSubmitted===true||['TIEBA_PUBLICATION_CHALLENGE','TIEBA_PUBLICATION_REJECTED'].includes(outcome.error??''));
  const state=outcome.id?'accepted':rejected?'rejected':'unknown';
  const result={...prior,submitted:outcome.receipt.accepted===true?true:rejected?false:null,published:false,deliveryStatus:state==='accepted'?'accepted':rejected?'failed':'unconfirmed',receipt:outcome.receipt,error:outcome.error??null,...(outcome.id?{id:outcome.id,url:'https://tieba.baidu.com/p/'+input.threadId+'?pid='+outcome.id+'#'+outcome.id}:{}),retryScheduled:false};
  this.db.prepare('UPDATE tieba_actions SET state=?,result=? WHERE id=?').run(state,JSON.stringify(result),requestId);return result;
 }
 async verify(requestId:string,identity:TiebaIdentity,reader:PostingReader){
  if(typeof requestId!=='string'||!requestId||requestId.length>240)throw new FishError('TIEBA_REQUEST_ID_INVALID');
  const row=this.db.prepare('SELECT * FROM tieba_actions WHERE id=? AND account=?').get(requestId,identity.id) as any;
  if(!row)throw new FishError('TIEBA_PUBLICATION_NOT_FOUND');
  const prior=JSON.parse(row.result??'{}');if(['preview','rejected','held'].includes(row.state))return {...prior,state:row.state,requestId,retryScheduled:false};
  const input=publishInput(JSON.parse(row.request)),forum=prior.forum??{id:input.forumId,name:''};
  const proof=await publicationVisibility(input,forum,identity,reader,row.created,numeric(prior.id)?prior.id:undefined);
  const observed=proof.observed,state=proof.publicVerified?'confirmed':proof.visibility==='removed_by_system'?'deleted':numeric(prior.id)||observed||prior.receipt?.accepted===true?'accepted':'unknown',lastPubliclyVisibleAt=proof.publicVerified?proof.verifiedAt:prior.lastPubliclyVisibleAt??null;
  const result={submitted:state!=='unknown'?true:prior.submitted??null,published:proof.publicVerified,deliveryStatus:state==='confirmed'?'confirmed':state==='deleted'?'deleted':state==='accepted'?'accepted':'unconfirmed',requestId,
   ...(numeric(prior.id)?{id:prior.id,url:prior.url}:observed??{}),...(prior.receipt?{receipt:prior.receipt}:{}),forum,action:input.action,
   ...proof,lastPubliclyVisibleAt,...(!proof.publicVerified&&lastPubliclyVisibleAt&&state!=='deleted'?{visibility:'no_longer_observed'}:{}),retryScheduled:false,initialResult:prior.initialResult??prior,
   ...(state==='confirmed'?{}:{notice:'尚未读到公开内容；平台接受请求不等于公开发布，当前不会自动重发。'})};
  const updated=this.db.prepare('UPDATE tieba_actions SET state=?,result=?,fingerprint=? WHERE id=? AND result=?').run(state,JSON.stringify(result),fingerprintOf(identity.id,input),requestId,row.result);
  return updated.changes?result:JSON.parse((this.db.prepare('SELECT result FROM tieba_actions WHERE id=?').get(requestId) as any).result);
 }
 async publish(raw:unknown,requestId:string,identity:TiebaIdentity,policy:PostingPolicy,reader:PostingReader,send:(request:ReturnType<typeof postingRequest>)=>Promise<{id:string;url:string;receipt?:Record<string,unknown>}>,humanRetryOf?:string){
  const input=publishInput(raw);if(identity.id!==policy.accountId)throw new FishError('TIEBA_ACCOUNT_NOT_AUTHORIZED');if(!['preview','live'].includes(policy.mode))throw new FishError('TIEBA_PUBLISH_DISABLED');if(typeof requestId!=='string'||!requestId||requestId.length>240)throw new FishError('TIEBA_REQUEST_ID_INVALID');
  const fingerprint=fingerprintOf(identity.id,input);
  const prior=this.db.prepare("SELECT id,fingerprint,state,result FROM tieba_actions WHERE id=? OR id=? OR (account=? AND fingerprint=? AND state IN ('held','unknown','accepted','deleted')) ORDER BY created DESC LIMIT 1").get(requestId,humanRetryOf??'',identity.id,fingerprint) as any;
  if(prior){
   if(prior.fingerprint!==fingerprint)throw new FishError('TIEBA_REQUEST_ID_REUSED');const saved=JSON.parse(prior.result??'{}');
   const allowed=humanRetryOf===prior.id&&requestId!==prior.id&&prior.state==='rejected'&&saved.submitted===false&&!saved.id&&saved.receipt?.accepted===false;
   if(!allowed)return {...saved,state:prior.state,reused:true,retryScheduled:false};
  }else if(humanRetryOf)throw new FishError('TIEBA_RECOVERY_SOURCE_CHANGED');
  const forum=await postingTarget(input,identity,policy,reader),request=postingRequest(input,forum);
  const preview={published:false,mode:'preview',state:'preview',account:identity,forum,action:input.action,request:input,endpoint:request.url,notice:'预演已保存，没有向贴吧发送发布请求。'};
  if(policy.mode==='preview'){
   this.db.prepare('INSERT INTO tieba_actions VALUES (?,?,?,?,?,?,?)').run(requestId,identity.id,fingerprint,'preview',JSON.stringify(input),JSON.stringify(preview),Date.now());return preview;
  }
  if(policy.mode!=='live')throw new FishError('TIEBA_PUBLISH_DISABLED');
  this.db.prepare('INSERT INTO tieba_actions VALUES (?,?,?,?,?,?,?)').run(requestId,identity.id,fingerprint,'held',JSON.stringify(input),JSON.stringify({published:false,deliveryStatus:'unconfirmed',retryScheduled:false}),Date.now());
  let result:any,state:string;
  try{const sent=await send(request);if(!numeric(sent.id))throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');state='accepted';result={submitted:true,published:false,deliveryStatus:'accepted',...sent,forum,action:input.action,requestId,retryScheduled:false};}
  catch(e){
   const error=codeOf(e),receipt=e instanceof AppPostFailure?e.receipt:undefined,returnedId=receipt?.id;
   const rejected=receipt?.accepted!==true&&(receipt?.notSubmitted===true||['TIEBA_PUBLICATION_REJECTED','TIEBA_PUBLICATION_CHALLENGE','TIEBA_LOGIN_REQUIRED','TIEBA_ACCOUNT_CHANGED','TIEBA_FORUM_READ_ONLY'].includes(error)||/^TIEBA_READ_HTTP_4[0-9][0-9]$/.test(error));
   state=rejected?'rejected':receipt?.accepted===true?'accepted':'unknown';result={submitted:receipt?.accepted===true?true:rejected?false:null,published:false,deliveryStatus:rejected?'failed':state==='accepted'?'accepted':'unconfirmed',error,...(receipt?{receipt}:{}),...(numeric(returnedId)?{id:returnedId,url:'https://tieba.baidu.com/p/'+input.threadId+'?pid='+returnedId+'#'+returnedId}:{}),forum,action:input.action,requestId,retryScheduled:false};
  }
  // Save the returned ID before doing any readback. A restart cannot turn an
  // accepted submission into permission to post the same content again.
  this.db.prepare('UPDATE tieba_actions SET state=?,result=? WHERE id=?').run(state,JSON.stringify(result),requestId);
  return state==='rejected'||result.error==='TIEBA_PUBLICATION_CHALLENGE'?result:this.verify(requestId,identity,reader);
 }
}
export const tiebaTools:ModelTool[]=[
 {type:'function',function:{name:'check_tieba_publication',description:'用发言回执的requestId复查公开/本人可见性。只读，不会重发。',parameters:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}}},
 {type:'function',function:{name:'get_tieba_replies',description:'查看自己贴吧账号收到的回复，包括帖子、楼中楼、作者和链接。page翻页。',parameters:{type:'object',properties:{page:{type:'integer',minimum:1,maximum:10000}},additionalProperties:false}}},
 {type:'function',function:{name:'get_tieba_account',description:'查看自己的贴吧身份、实际关注的吧和发言模式。其他吧仍可用browse_page阅读。',parameters:{type:'object',properties:{},additionalProperties:false}}},
 {"type":"function","function":{"name":"publish_tieba","description":"在自己关注的吧发表内容。action区分新主题thread、帖子新楼层reply和楼中楼comment，各自必填项见参数说明。ID取自实际账号与读帖结果。预演/真实发布由管理员配置的posting.mode决定，可用get_tieba_account查询；本接口没有preview或mode参数，单次调用不能切换模式。参数错误会在请求发出前返回具体字段和原因。","parameters":{"type":"object","properties":{"action":{"type":"string","enum":["thread","reply","comment"],"description":"thread=新主题：需title，不传threadId/postId/page；reply=帖子新楼层：需threadId，不传title/postId；comment=楼中楼：需threadId和父楼层postId，可传subPostId。"},"forumId":{"type":"string","pattern":"^[1-9][0-9]{0,19}$","description":"get_tieba_account返回的关注吧ID；必须与目标帖子所属吧一致。"},"content":{"type":"string","minLength":1,"maxLength":20000,"description":"要发表的正文。"},"title":{"type":"string","minLength":1,"maxLength":200,"description":"仅thread必填的新主题标题。"},"threadId":{"type":"string","pattern":"^[1-9][0-9]{0,19}$","description":"reply和comment必填，来自读帖结果的帖子ID。"},"postId":{"type":"string","pattern":"^[1-9][0-9]{0,19}$","description":"仅comment必填：实际读到的父楼层ID。reply不传此项。"},"subPostId":{"type":"string","pattern":"^[1-9][0-9]{0,19}$","description":"仅comment可选：回复父楼层下某条子回复时填该子回复ID；后台核对真实身份。"},"page":{"type":"integer","minimum":1,"maximum":10000,"description":"仅reply/comment可传，目标父楼层所在帖子页码，默认1。"},"commentPage":{"type":"integer","minimum":1,"maximum":10000,"description":"仅comment可传，目标子回复所在楼中楼页码，默认1。"}},"required":["action","forumId","content"],"additionalProperties":false}}}
];
