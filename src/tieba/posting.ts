import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {FishError,codeOf,type ModelTool} from '../types.js';
import type {PublicPoster} from '../search/public-web.js';
import type {TiebaIdentity} from './session.js';

export interface FollowedForum {id:string;name:string}
export interface PublishInput {action:'thread'|'reply'|'comment';forumId:string;title?:string;content:string;threadId?:string;postId?:string;page?:number;subPostId?:string;commentPage?:number}
export interface PostingPolicy {mode:'preview'|'live';accountId:string}
export interface PostingReader {followed(userId:string):Promise<FollowedForum[]>;read(url:string):Promise<any>;publicRead?(url:string):Promise<any>}
const numeric=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v);
export function publishInput(v:any):PublishInput{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['action','forumId','title','content','threadId','postId','page','subPostId','commentPage'].includes(k))||!['thread','reply','comment'].includes(v.action)||!numeric(v.forumId)||typeof v.content!=='string'||!v.content.trim()||v.content.length>20000||v.content.includes('\0'))throw new FishError('TIEBA_PUBLISH_INPUT_INVALID');
 if(v.commentPage!==undefined&&(!Number.isInteger(v.commentPage)||v.commentPage<1||v.commentPage>10000))throw new FishError('TIEBA_PAGE_INVALID');
 if(v.subPostId!==undefined&&(!numeric(v.subPostId)||v.action!=='comment')||v.commentPage!==undefined&&v.action!=='comment')throw new FishError('TIEBA_PUBLISH_INPUT_INVALID');
 if(v.page!==undefined&&(!Number.isInteger(v.page)||v.page<1||v.page>10000))throw new FishError('TIEBA_PAGE_INVALID');
 if(v.action==='thread'){
  if(typeof v.title!=='string'||!v.title.trim()||v.title.length>200||v.threadId!==undefined||v.postId!==undefined||v.page!==undefined)throw new FishError('TIEBA_PUBLISH_INPUT_INVALID');
 }else if(v.title!==undefined||!numeric(v.threadId)||v.action==='comment'&&!numeric(v.postId)||v.action==='reply'&&v.postId!==undefined)throw new FishError('TIEBA_PUBLISH_INPUT_INVALID');
 if(Buffer.byteLength(JSON.stringify(v),'utf8')>14000)throw new FishError('TIEBA_PUBLISH_INPUT_TOO_LARGE');
 return {...v,content:v.content.trim(),...(v.title?{title:v.title.trim()}:{})};
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
 let replyTo:{id:string;postId:string}|undefined;
 if(input.action!=='thread'){
  const page=await reader.read('https://tieba.baidu.com/p/'+input.threadId+'?pn='+(input.page??1));
  if(page?.status!=='content'||String(page.thread?.id)!==input.threadId)throw new FishError('TIEBA_THREAD_NOT_VERIFIED');
  if(String(page.forum?.id)!==forum.id)throw new FishError('TIEBA_FORUM_MISMATCH');
  if(input.action==='comment'&&!page.posts?.some((p:any)=>p.id===input.postId))throw new FishError('TIEBA_FLOOR_NOT_VERIFIED');
  if(input.subPostId){
   const comments=await reader.read('https://tieba.baidu.com/p/comment?tid='+input.threadId+'&pid='+input.postId+'&pn='+(input.commentPage??1));
   const target=comments.posts?.find((p:any)=>p.id===input.subPostId&&p.parentPostId===input.postId);
   if(comments.status!=='content'||String(comments.forum?.id)!==forum.id||String(comments.thread?.id)!==input.threadId||!target||!numeric(target.author?.id))throw new FishError('TIEBA_COMMENT_NOT_VERIFIED');
   replyTo={id:target.author.id,postId:target.id};
  }
 }
 return {...forum,...(replyTo?{replyTo}:{})};
}
/** Plain-text first. Target IDs are server-verified before these API fields
 * are built. CSRF/session fields are added only by the isolated browser. */
export function postingRequest(input:PublishInput,forum:FollowedForum&{replyTo?:{id:string;postId:string}}){
 const fields:Record<string,string>={_client_type:'2',_client_version:'12.64.1.1',fid:forum.id,kw:forum.name,content:input.content};
 if(input.action==='thread')fields.title=input.title!;
 else {fields.tid=input.threadId!;if(input.action==='comment'){fields.quote_id=input.postId!;fields.repostid=input.postId!;if(forum.replyTo){fields.sub_post_id=forum.replyTo.postId;fields.reply_uid=forum.replyTo.id;}}}
 return {url:'https://tiebac.baidu.com'+(input.action==='thread'?'/c/c/thread/add':'/c/c/post/add'),fields};
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
 const hits=(page.posts??[]).filter((p:any)=>(!expectedId||p.id===expectedId)&&p.author?.id===who.id&&Date.parse(p.publishedAt)>=since-2000&&Date.parse(p.publishedAt)<=Date.now()+2000&&(input.action!=='thread'||p.title===input.title)&&(input.action!=='comment'||p.parentPostId===input.postId)&&(norm(p.content)===wanted||p.contentTruncated&&wanted.startsWith(norm(p.content))));
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
 return {publicVerified:false,visibility:observed?'author_only':'not_observed',observed,checks,verifiedAt:Date.now()};
}
export class TiebaPosting {
 private db:DatabaseSync;
 constructor(dir:string){
  this.db=new DatabaseSync(path.join(dir,'actions.sqlite'));fs.chmodSync(path.join(dir,'actions.sqlite'),0o600);this.db.exec('PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS tieba_actions(id TEXT PRIMARY KEY,account TEXT,fingerprint TEXT,state TEXT,request TEXT,result TEXT,created INTEGER);');
  // Preview text is bounded; unknown/live receipts are never silently discarded.
  this.db.exec("DELETE FROM tieba_actions WHERE state='preview' AND id NOT IN (SELECT id FROM tieba_actions WHERE state='preview' ORDER BY created DESC LIMIT 500)");
 }
 close(){this.db.close();}
 history(){return this.db.prepare('SELECT id,account,state,request,result,created FROM tieba_actions ORDER BY created DESC LIMIT 30').all().map((r:any)=>({...r,request:JSON.parse(r.request),result:JSON.parse(r.result??'{}')}));}
 async verify(requestId:string,identity:TiebaIdentity,reader:PostingReader){
  if(typeof requestId!=='string'||!requestId||requestId.length>240)throw new FishError('TIEBA_REQUEST_ID_INVALID');
  const row=this.db.prepare('SELECT * FROM tieba_actions WHERE id=? AND account=?').get(requestId,identity.id) as any;
  if(!row)throw new FishError('TIEBA_PUBLICATION_NOT_FOUND');
  const prior=JSON.parse(row.result??'{}');if(['preview','rejected','held'].includes(row.state))return {...prior,state:row.state,requestId,retryScheduled:false};
  const input=publishInput(JSON.parse(row.request)),forum=prior.forum??{id:input.forumId,name:''};
  const proof=await publicationVisibility(input,forum,identity,reader,row.created,numeric(prior.id)?prior.id:undefined);
  const observed=proof.observed,state=proof.publicVerified?'confirmed':numeric(prior.id)||observed?'accepted':'unknown',lastPubliclyVisibleAt=proof.publicVerified?proof.verifiedAt:prior.lastPubliclyVisibleAt??null;
  const result={submitted:state!=='unknown',published:proof.publicVerified,deliveryStatus:state==='confirmed'?'confirmed':state==='accepted'?'accepted':'unconfirmed',requestId,
   ...(numeric(prior.id)?{id:prior.id,url:prior.url}:observed??{}),...(prior.receipt?{receipt:prior.receipt}:{}),forum,action:input.action,
   ...proof,lastPubliclyVisibleAt,...(!proof.publicVerified&&lastPubliclyVisibleAt?{visibility:'no_longer_observed'}:{}),retryScheduled:false,initialResult:prior.initialResult??prior,
   ...(state==='confirmed'?{}:{notice:'尚未读到公开内容；平台接受请求不等于公开发布，当前不会自动重发。'})};
  this.db.prepare('UPDATE tieba_actions SET state=?,result=? WHERE id=?').run(state,JSON.stringify(result),requestId);return result;
 }
 async publish(raw:unknown,requestId:string,identity:TiebaIdentity,policy:PostingPolicy,reader:PostingReader,send:(request:ReturnType<typeof postingRequest>)=>Promise<{id:string;url:string;receipt?:Record<string,unknown>}>){
  const input=publishInput(raw);if(identity.id!==policy.accountId)throw new FishError('TIEBA_ACCOUNT_NOT_AUTHORIZED');if(!['preview','live'].includes(policy.mode))throw new FishError('TIEBA_PUBLISH_DISABLED');if(typeof requestId!=='string'||!requestId||requestId.length>240)throw new FishError('TIEBA_REQUEST_ID_INVALID');
  const fingerprint=createHash('sha256').update(JSON.stringify([identity.id,input])).digest('hex');
  const prior=this.db.prepare("SELECT fingerprint,state,result FROM tieba_actions WHERE id=? OR (account=? AND fingerprint=? AND state IN ('held','unknown','accepted')) ORDER BY created DESC LIMIT 1").get(requestId,identity.id,fingerprint) as any;
  if(prior){if(prior.fingerprint!==fingerprint)throw new FishError('TIEBA_REQUEST_ID_REUSED');return {...JSON.parse(prior.result??'{}'),state:prior.state,reused:true,retryScheduled:false};}
  const forum=await postingTarget(input,identity,policy,reader),request=postingRequest(input,forum);
  const preview={published:false,mode:'preview',state:'preview',account:identity,forum,action:input.action,request:input,endpoint:request.url,notice:'预演已保存，没有向贴吧发送发布请求。'};
  if(policy.mode==='preview'){
   this.db.prepare('INSERT INTO tieba_actions VALUES (?,?,?,?,?,?,?)').run(requestId,identity.id,fingerprint,'preview',JSON.stringify(input),JSON.stringify(preview),Date.now());return preview;
  }
  if(policy.mode!=='live')throw new FishError('TIEBA_PUBLISH_DISABLED');
  this.db.prepare('INSERT INTO tieba_actions VALUES (?,?,?,?,?,?,?)').run(requestId,identity.id,fingerprint,'held',JSON.stringify(input),JSON.stringify({published:false,deliveryStatus:'unconfirmed',retryScheduled:false}),Date.now());
  let result:any,state:string;
  try{const sent=await send(request);if(!numeric(sent.id))throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');state='accepted';result={submitted:true,published:false,deliveryStatus:'accepted',...sent,forum,action:input.action,requestId,retryScheduled:false};}
  catch(e){const error=codeOf(e);const rejected=['TIEBA_PUBLICATION_REJECTED','TIEBA_PUBLICATION_CHALLENGE','TIEBA_LOGIN_REQUIRED','TIEBA_ACCOUNT_CHANGED','TIEBA_FORUM_READ_ONLY'].includes(error)||/^TIEBA_READ_HTTP_4[0-9][0-9]$/.test(error);state=rejected?'rejected':'unknown';result={submitted:false,published:false,deliveryStatus:rejected?'failed':'unconfirmed',error,forum,action:input.action,requestId,retryScheduled:false};}
  // Save the returned ID before doing any readback. A restart cannot turn an
  // accepted submission into permission to post the same content again.
  this.db.prepare('UPDATE tieba_actions SET state=?,result=? WHERE id=?').run(state,JSON.stringify(result),requestId);
  return state==='rejected'?result:this.verify(requestId,identity,reader);
 }
}
export const tiebaTools:ModelTool[]=[
 {type:'function',function:{name:'check_tieba_publication',description:'用发言回执的requestId复查公开/本人可见性。只读，不会重发。',parameters:{type:'object',properties:{requestId:{type:'string'}},required:['requestId'],additionalProperties:false}}},
 {type:'function',function:{name:'get_tieba_replies',description:'查看自己贴吧账号收到的回复，包括帖子、楼中楼、作者和链接。page翻页。',parameters:{type:'object',properties:{page:{type:'integer',minimum:1,maximum:10000}},additionalProperties:false}}},
 {type:'function',function:{name:'get_tieba_account',description:'查看自己的贴吧身份、实际关注的吧和发言模式。其他吧仍可用browse_page阅读。',parameters:{type:'object',properties:{},additionalProperties:false}}},
 {type:'function',function:{name:'publish_tieba',description:'向自己关注的吧发主题帖、回帖或回复楼中楼。forumId来自get_tieba_account；threadId/postId/page来自读帖结果。preview模式只保存预演，不会发出。',parameters:{type:'object',properties:{action:{type:'string',enum:['thread','reply','comment']},forumId:{type:'string'},title:{type:'string',description:'新主题标题'},content:{type:'string'},threadId:{type:'string'},postId:{type:'string',description:'楼中楼所挂父楼层ID'},subPostId:{type:'string',description:'可选，要回复的子回复ID；身份由后台核对'},commentPage:{type:'integer',minimum:1},page:{type:'integer',minimum:1,description:'父楼层所在帖子页码，默认1'}},required:['action','forumId','content'],additionalProperties:false}}}
];
