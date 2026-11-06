import type {PublicReader} from './public-web.js';
import {FishError} from '../types.js';
import {failure,htmlContent,safeLink,socialJson,str,timestamp,unavailable,type SocialPage,type SocialPost} from './social-common.js';

export async function mastodonPage(raw:string,reader:PublicReader,signal?:AbortSignal):Promise<SocialPage|undefined>{
 const u=new URL(raw),post=/^\/(?:@[^/]+|users\/[^/]+\/statuses)\/(\d+)\/?$/.exec(u.pathname),profile=/^\/@([A-Za-z0-9_]+)\/?$/.exec(u.pathname);
 const direct=/^\/api\/v1\/(?:statuses\/(\d+)(\/context)?|accounts\/(\d+)\/statuses)$/.exec(u.pathname);
 if(!post&&!profile&&!direct)return;
 // @user paths also exist outside Mastodon: a failed detection falls back to HTML.
 const errors:SocialPage['unavailable']=[];let source=raw;
 try{
  let endpoint:URL;
  if(profile){source=u.origin+'/api/v1/accounts/lookup?acct='+encodeURIComponent(profile[1]);const {data}=await socialJson(reader,source,signal);if(!/^\d+$/.test(data.id??''))return;endpoint=new URL(u.origin+'/api/v1/accounts/'+data.id+'/statuses');}
  else endpoint=new URL(direct?u.href:u.origin+'/api/v1/statuses/'+post![1]);
  const feed=endpoint.pathname.includes('/accounts/'),context=endpoint.pathname.endsWith('/context');
  if(feed)endpoint.searchParams.set('limit','10');source=endpoint.href;
  const {r,data}=await socialJson(reader,source,signal);
  if(feed&&!Array.isArray(data)||context&&(!Array.isArray(data.ancestors)||!Array.isArray(data.descendants))||!feed&&!context&&String(data.id)!==(post?.[1]??direct?.[1]))throw new FishError('MASTODON_RESPONSE_INVALID');
  const posts:SocialPost[]=[],seen=new Set<string>();
  function add(p:any,kind='post',depth=0){
   if(!p||depth>4||posts.length>=150||seen.has(str(p.id)))return;seen.add(str(p.id));
   if(p.reblog){add(p.reblog,'reblogged_post',depth+1);const original=posts.find(x=>x.id===p.reblog.id);if(original)original.repostedBy={id:str(p.account?.id),handle:str(p.account?.acct),name:str(p.account?.display_name)};return;}
   const body=htmlContent(str(p.content),raw),a=p.account??{},images:SocialPost['images']=[];
   for(const media of p.media_attachments??[]){const image=safeLink(media.type==='image'?media.url:media.preview_url,raw);if(image)images.push({url:image,kind:media.type==='image'?'post_image':'video_cover',label:str(media.description),postId:str(p.id)});}
   posts.push({id:str(p.id),url:safeLink(p.url??p.uri,raw),author:{id:str(a.id),name:str(a.display_name)||str(a.acct),handle:str(a.acct),url:safeLink(a.url,raw)},publishedAt:timestamp(p.created_at),text:[str(p.spoiler_text),body.text].filter(Boolean).join('\n'),images,kind,parentId:str(p.in_reply_to_id)||null,links:body.links.slice(0,25)});
  }
  if(feed)for(const p of data)add(p);else if(context){for(const p of data.ancestors)add(p,'ancestor');for(const p of data.descendants)add(p,'reply');}else add(data);
  const commentsUrl=!feed&&!context?u.origin+'/api/v1/statuses/'+data.id+'/context':null,next=new URL(endpoint);if(feed&&data.length)next.searchParams.set('max_id',String(data.at(-1).id));
  return {url:raw,sourceUrl:r.url,provider:'Mastodon instance public API',coverage:context?'returned_ancestors_and_replies':feed?'account_statuses':'single_post',title:'Mastodon',status:posts.length?'content':'empty',fetchedAt:r.fetchedAt!,latestVerified:false,posts,postsTruncated:posts.length>=150,links:[...(commentsUrl?[{url:commentsUrl,label:'查看回复上下文'}]:[]),...(feed&&data.length?[{url:next.href,label:'下一页'}]:[])],commentsUrl,nextPage:feed&&data.length?next.href:null,unavailable:errors,notice:'仅此实例公开可见的内容；其他实例可能尚未同步，视频只含封面。'};
 }catch(e){if(signal?.aborted)throw e;if(!direct)return;errors.push(failure(source,e));return unavailable(raw,'Mastodon',errors);}
}
