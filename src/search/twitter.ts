import type {PublicReader} from './public-web.js';
import {FishError} from '../types.js';
import {failure,htmlContent,safeLink,socialJson,str,timestamp,unavailable,type SocialPage,type SocialPost} from './social-common.js';

const api='https://api.fxtwitter.com';
/** URL adapters choose a public representation, never the agent's topic or next action. */
export async function twitterPage(raw:string,reader:PublicReader,signal?:AbortSignal):Promise<SocialPage|undefined>{
 const u=new URL(raw),host=u.hostname.replace(/^(www|mobile)\./,'');
 let endpoint:URL|undefined,id:string|undefined,conversation=false;
 if(['x.com','twitter.com','fxtwitter.com','vxtwitter.com'].includes(host)){
  id=/^\/(?:[^/]+|i\/web)\/status\/(\d{1,20})(?:\/|$)/.exec(u.pathname)?.[1];
  if(id)endpoint=new URL(api+'/2/status/'+id);
  else if(u.pathname==='/search'&&u.searchParams.get('q')){endpoint=new URL(api+'/2/search');endpoint.searchParams.set('q',u.searchParams.get('q')!);endpoint.searchParams.set('feed',u.searchParams.get('f')==='live'?'latest':'top');}
  else {const handle=/^\/([A-Za-z0-9_]{1,15})\/?$/.exec(u.pathname)?.[1];if(handle&&!['home','explore','search','notifications','messages','settings','login','signup','i','intent','compose'].includes(handle.toLowerCase()))endpoint=new URL(api+'/2/profile/'+handle+'/statuses');}
 }else if(host==='api.fxtwitter.com'&&/^\/2\/(?:status\/\d{1,20}|conversation\/\d{1,20}|profile\/[A-Za-z0-9_]{1,15}\/statuses|search)$/.test(u.pathname)){
  endpoint=new URL(api+u.pathname);for(const k of ['cursor','q','feed','ranking_mode','since','with_replies'])if(u.searchParams.has(k))endpoint.searchParams.set(k,u.searchParams.get(k)!);
  id=/\/(?:status|conversation)\/(\d+)$/.exec(u.pathname)?.[1];conversation=u.pathname.includes('/conversation/');
 }
 if(!endpoint)return;
 if(!id)endpoint.searchParams.set('count','10');
 const errors:SocialPage['unavailable']=[];
 try{
  const {r,data}=await socialJson(reader,endpoint.href,signal);
  if(data.code!==200)throw new FishError('TWITTER_API_'+String(data.code??'INVALID'));
  if(id&&String(data.status?.id)!==id)throw new FishError('TWITTER_POST_ID_MISMATCH');
  if(!id&&!Array.isArray(data.results))throw new FishError('TWITTER_FEED_INVALID');
  const posts:SocialPost[]=[],seen=new Set<string>();
  function add(item:any,kind='post',depth=0){
   if(!item||depth>4||posts.length>=150)return;
   if(item.type==='thread'){for(const child of item.statuses??item.thread??[])add(child,kind,depth+1);return;}
   const pid=str(item.id);if(!pid||seen.has(pid))return;seen.add(pid);
   const a=item.author??{},url=safeLink(item.url,raw),images:SocialPost['images']=[];
   for(const m of item.media?.all??[...(item.media?.photos??[]),...(item.media?.videos??[])]){
    const video=m.type==='video'||m.type==='gif'||!!m.thumbnail_url,src=safeLink(video?m.thumbnail_url:m.url,raw);
    if(src)images.push({url:src,kind:video?'video_cover':'post_image',label:str(m.alt_text),postId:pid});
   }
   const reply=item.replying_to,authorUrl=safeLink(a.url,raw),parentId=typeof reply==='object'&&reply?str(reply.status??reply.status_id??reply.id)||null:null;
   posts.push({id:pid,url,author:{id:str(a.id),name:str(a.name)||str(a.screen_name),handle:str(a.screen_name),url:authorUrl},publishedAt:timestamp(item.created_timestamp??item.created_at),text:str(item.text)||str(item.raw_text?.text),images,kind:item.type==='tombstone'?'unavailable':kind,parentId,
    ...(item.type==='tombstone'?{unavailableReason:str(item.reason)||str(item.text)||'unavailable'}:{}),
    ...(item.reposted_by?{repostedBy:{id:str(item.reposted_by.id),handle:str(item.reposted_by.screen_name),name:str(item.reposted_by.name)}}:{}),
    ...(reply?{replyingTo:typeof reply==='string'?reply:str(reply.screen_name)}:{}),
    ...(item.quote?{quotedPostId:str(item.quote.id)}:{}),
    links:(item.raw_text?.facets??[]).filter((f:any)=>f.type==='url').map((f:any)=>({url:safeLink(f.replacement,raw),label:str(f.display)})).filter((f:any)=>f.url).slice(0,25)});
   if(item.quote)add(item.quote,'quoted_post',depth+1);
  }
  if(id)add(data.status);for(const s of data.thread??[])add(s,'thread_post');for(const s of data.replies??[])add(s,'reply');for(const s of data.results??[])add(s);
  const cursor=str(data.cursor?.bottom),next=new URL(endpoint);if(cursor)next.searchParams.set('cursor',cursor);
  const commentsUrl=id?api+'/2/conversation/'+id:null;
  return {url:raw,sourceUrl:r.url,provider:'FxEmbed (third-party public X reader)',coverage:conversation?'post_and_returned_replies':id?'post_and_returned_thread':'returned_feed',title:'X / Twitter',status:posts.some(p=>p.kind!=='unavailable')?'content':posts.length?'unavailable':'empty',fetchedAt:r.fetchedAt!,cached:r.cached??false,latestVerified:false,posts,postsTruncated:posts.length>=150,
   links:[...(commentsUrl&&!conversation?[{url:commentsUrl,label:'查看此帖公开回复'}]:[]),...(cursor?[{url:next.href,label:'下一页'}]:[])],commentsUrl,nextPage:cursor?next.href:null,unavailable:errors,
   notice:'第三方公开读取。每条保留实际作者；转发人不等于原作者。回复只代表返回的部分，视频图片为封面；不证明全站最新。'};
 }catch(e){if(signal?.aborted)throw e;errors.push(failure(endpoint.href,e));}
 // Official embed is narrower: a single post, no claim to have read replies.
 if(id&&!conversation){
  const embed=new URL('https://publish.twitter.com/oembed');embed.searchParams.set('url','https://x.com/i/web/status/'+id);embed.searchParams.set('omit_script','true');
  try{
   const {r,data}=await socialJson(reader,embed.href,signal),returned=safeLink(data.url,raw);
   if(!returned||!new RegExp('/status/'+id+'(?:/|$)').test(new URL(returned).pathname)||typeof data.html!=='string')throw new FishError('TWITTER_EMBED_INVALID');
   const body=htmlContent(data.html,returned);
   return {url:raw,sourceUrl:r.url,provider:'X official oEmbed',coverage:'embedded_post_only',title:'X / Twitter',status:'content',fetchedAt:r.fetchedAt!,latestVerified:false,posts:[{id,url:returned,author:{name:str(data.author_name),url:safeLink(data.author_url,raw)},publishedAt:null,text:body.text,images:body.images,kind:'post',links:body.links.slice(0,25)}],links:[],nextPage:null,unavailable:errors,notice:'仅取得官方嵌入正文，不含完整媒体/回复；发布时间未取得。'};
  }catch(e){if(signal?.aborted)throw e;errors.push(failure(embed.href,e));}
 }
 return unavailable(raw,'X / Twitter',errors);
}
