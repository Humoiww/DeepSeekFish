import {Parser} from 'htmlparser2';
import type {PublicReader} from './public-web.js';
import {FishError} from '../types.js';
import {parseFeed} from './feeds.js';
import {failure,htmlContent,safeLink,socialRead,socialJson,str,timestamp,unavailable,type SocialPage,type SocialPost} from './social-common.js';

function listing(data:any,raw:string,sourceUrl:string,fetchedAt:string):SocialPage{
 const posts:SocialPost[]=[],links:SocialPage['links']=[];let after='';
 function walk(node:any,depth=0){
  if(depth>12||posts.length>=200||!node)return;
  if(Array.isArray(node)){for(const child of node)walk(child,depth+1);return;}
  const d=node.data;if(!d)return;
  if(node.kind==='Listing'){after=str(d.after)||after;walk(d.children,depth+1);return;}
  if(!['t1','t3'].includes(node.kind))return;
  const id=str(d.name)||node.kind+'_'+str(d.id),url=safeLink(d.permalink,raw),body=htmlContent(str(d.selftext_html??d.body_html),url??raw);
  const text=str(d.selftext??d.body)||body.text;
  const images:SocialPost['images']=[];
  const image=(src:unknown,kind:string,label='')=>{const link=safeLink(typeof src==='string'?src.replaceAll('&amp;','&'):src,raw);if(link)images.push({url:link,kind,label,postId:id});};
  if(d.post_hint==='image')image(d.url_overridden_by_dest??d.url,'post_image');
  for(const item of d.gallery_data?.items??[]){const m=d.media_metadata?.[item.media_id];if(m?.status==='valid')image(m.s?.gif??m.s?.u,'post_image',str(item.caption));}
  if(!images.length)for(const p of d.preview?.images??[])image(p.source?.url,d.is_video?'video_cover':'post_preview');
  posts.push({id,url,author:{name:str(d.author),url:safeLink('/user/'+encodeURIComponent(str(d.author)),raw)},publishedAt:timestamp(d.created_utc),title:str(d.title),text:[str(d.title),text].filter(Boolean).join('\n'),images,kind:node.kind==='t1'?'comment':'post',parentId:str(d.parent_id)||null,subreddit:str(d.subreddit),links:body.links.slice(0,25)});
  if(d.replies)walk(d.replies,depth+1);
 }
 walk(data);
 if(!Array.isArray(data)&&data?.kind!=='Listing')throw new FishError('REDDIT_LISTING_INVALID');
 const next=new URL(sourceUrl);if(after)next.searchParams.set('after',after);
 if(after)links.push({url:next.href,label:'下一页'});
 return {url:raw,sourceUrl,provider:'Reddit public JSON',coverage:'returned_posts_and_comments',title:'Reddit',status:posts.length?'content':'empty',fetchedAt,latestVerified:false,posts,postsTruncated:posts.length>=200,links,nextPage:after?next.href:null,unavailable:[],notice:'只包含本次实际返回的帖子和评论；折叠/更多评论未加载，parentId 保留原始回复关系。'};
}
function embed(html:string,raw:string,id:string):SocialPost|undefined{
 let verified=false,depth=0,capture=0,titleDepth=0,content='',title='',author='',publishedAt:string|null=null,url=raw;
 const p=new Parser({onopentag(name,a){
  depth++;
  // The official embed carries a post identity in tracking data, not an avatar.
  if(a['data-faceplate-tracking-context'])try{const post=JSON.parse(a['data-faceplate-tracking-context']).post;if(post?.id==='t3_'+id){verified=true;url=safeLink(post.url,raw)??url;}}catch{}
  if(name==='faceplate-timeago'&&a.ts&&!publishedAt)publishedAt=timestamp(a.ts);
  if(name==='a'&&a.href&&!author){const m=/^https:\/\/(?:www\.)?reddit\.com\/user\/([^/?]+)/.exec(a.href);if(m)author=m[1];}
  if(name==='shreddit-embed-title')titleDepth=depth;
  if(a.id==='t3_'+id+'-post-rtjson-content')capture=depth;
  if(capture)content+='<'+name+Object.entries(a).filter(([k])=>['href','src','alt'].includes(k)).map(([k,v])=>' '+k+'="'+v.replaceAll('"','&quot;')+'"').join('')+'>';
 },ontext(t){if(capture)content+=t.replaceAll('&','&amp;').replaceAll('<','&lt;');if(titleDepth)title+=t;},onclosetag(name){if(capture)content+='</'+name+'>';if(depth===capture)capture=0;if(depth===titleDepth)titleDepth=0;depth--; }},{decodeEntities:true});p.end(html);
 if(!verified)return;
 const body=htmlContent(content,raw),text=[title.trim(),body.text].filter(Boolean).join('\n');if(!text)return;
 return {id:'t3_'+id,url,author:{name:author,url:safeLink('/user/'+encodeURIComponent(author),raw)},publishedAt,text,images:body.images,kind:'post'};
}
export async function redditPage(raw:string,reader:PublicReader,signal?:AbortSignal):Promise<SocialPage|undefined>{
 const archived=await redditArchive(raw,reader,signal);if(archived)return archived;
 const u=new URL(raw),host=u.hostname.replace(/^(www|old|new|np|m|embed)\./,'');if(!['reddit.com','redd.it'].includes(host))return;
 let path=u.pathname.replace(/\.(?:json|rss)\/?$/,'').replace(/\/+$/,'');
 if(host==='redd.it'){if(!/^\/[a-z0-9]+$/i.test(path))return;path='/comments'+path;}
 if(!/^(?:\/r\/[A-Za-z0-9_+]+(?:\/(?:new|hot|top|rising|controversial|search))?|\/(?:user|u)\/[A-Za-z0-9_-]+(?:\/(?:submitted|comments))?|(?:\/r\/[^/]+)?\/comments\/[a-z0-9]+(?:\/[^/]*)?(?:\/[a-z0-9]+)?|\/search|\/(?:new|hot|top|rising))$/i.test(path))return;
 const postId=/(?:^|\/)comments\/([a-z0-9]+)/i.exec(path)?.[1],commentId=/(?:^|\/)comments\/[a-z0-9]+\/[^/]*\/([a-z0-9]+)/i.exec(path)?.[1];
 const base=new URL('https://www.reddit.com'+path+'/');
 for(const key of ['after','before','sort','t','q','restrict_sr'])if(u.searchParams.has(key))base.searchParams.set(key,u.searchParams.get(key)!);
 base.searchParams.set('limit','20');
 const rss=new URL(base),json=new URL(base);rss.pathname+='.rss';json.pathname+='.json';json.searchParams.set('raw_json','1');
 const errors:SocialPage['unavailable']=[],endpoints=u.pathname.includes('.json')?[json,rss]:[rss,json];
 for(const endpoint of endpoints){
  try{
   const r=await socialRead(reader,endpoint.href,signal);let page:SocialPage;
   if(endpoint===json)page=listing(JSON.parse(r.bytes.toString('utf8')),raw,r.url,r.fetchedAt!);
   else{
    const feed=parseFeed(r.bytes.toString('utf8'),r.url,r.fetchedAt);if(!feed)throw new FishError('REDDIT_FEED_INVALID');page={...feed,url:raw,provider:'Reddit public RSS',coverage:postId?'post_and_flat_comment_feed':'subreddit_or_user_feed'};
    page.notice=postId?'RSS 只返回部分评论，未提供评论父节点时不能推断嵌套关系。':'只代表当前公开订阅页；置顶/排序不代表全站最新。';
    if(!postId&&page.posts.length){const next=new URL(rss);next.searchParams.delete('before');next.searchParams.set('after',page.posts.at(-1)!.id);page.nextPage=next.href;page.links.push({url:next.href,label:'下一页（可能已到底）'});}
   }
   if(postId&&!page.posts.some(p=>p.id==='t3_'+postId||p.url?.includes('/comments/'+postId+'/')))throw new FishError('REDDIT_POST_ID_MISMATCH');
   if(commentId&&!page.posts.some(p=>p.id==='t1_'+commentId))throw new FishError('REDDIT_COMMENT_NOT_RETURNED');
   const commentsUrl=postId?archive+'/comments/tree?link_id=t3_'+postId+'&limit=100':null;
   if(commentsUrl)page.links.push({url:commentsUrl,label:'归档评论树（可能滞后）'});
   return {...page,commentsUrl,cached:r.cached??false,unavailable:errors};
  }catch(e){if(signal?.aborted)throw e;errors.push(failure(endpoint.href,e));}
 }
 // Embeds still expose a public root post on hosts where anonymous JSON is disabled.
 if(postId&&!commentId){
  const endpoint='https://embed.reddit.com'+path+'/';
  try{
   const r=await socialRead(reader,endpoint,signal),post=embed(r.bytes.toString('utf8'),raw,postId);if(!post)throw new FishError('REDDIT_EMBED_INVALID');
   return {url:raw,sourceUrl:r.url,provider:'Reddit official embed',coverage:'embedded_post_only',title:'Reddit',status:'content',fetchedAt:r.fetchedAt!,latestVerified:false,posts:[post],links:[{url:archive+'/comments/tree?link_id=t3_'+postId+'&limit=100',label:'归档评论树（可能滞后）'}],commentsUrl:archive+'/comments/tree?link_id=t3_'+postId+'&limit=100',nextPage:null,unavailable:errors,notice:'仅取得嵌入原帖，不包含评论或完整媒体。'};
  }catch(e){if(signal?.aborted)throw e;errors.push(failure(endpoint,e));}
 }
 // A separately identified public archive can still answer when native feeds
 // are rate limited. It cannot establish the current/latest state of Reddit.
 const subreddit=/^\/r\/([A-Za-z0-9_]+)(?:\/(new|hot|top|rising|controversial))?$/.exec(path);
 if(!commentId&&(postId||subreddit)&&!base.searchParams.has('after')&&!base.searchParams.has('before')){
  const endpoint=new URL(archive+(postId?'/posts/ids':'/posts/search'));
  if(postId)endpoint.searchParams.set('ids',postId);else{endpoint.searchParams.set('subreddit',subreddit![1]);endpoint.searchParams.set('sort','desc');endpoint.searchParams.set('limit','10');}
  const page=await redditArchive(endpoint.href,reader,signal);
  if(page?.status==='content')return {...page,url:raw,unavailable:[...errors,...page.unavailable]};
  errors.push(...page?.unavailable??[]);
 }
 return unavailable(raw,'Reddit',errors);
}

const archive='https://arctic-shift.photon-reddit.com/api';
async function redditArchive(raw:string,reader:PublicReader,signal?:AbortSignal):Promise<SocialPage|undefined>{
 const u=new URL(raw);if(u.origin!=='https://arctic-shift.photon-reddit.com'||!['/api/posts/ids','/api/posts/search','/api/comments/tree'].includes(u.pathname))return;
 try{
  const endpoint=new URL(u);if(!endpoint.pathname.endsWith('/ids'))endpoint.searchParams.set('limit',endpoint.pathname.endsWith('/tree')?'100':'10');
  const {r,data}=await socialJson(reader,endpoint.href,signal);if(!Array.isArray(data.data))throw new FishError('REDDIT_ARCHIVE_INVALID');
  const comments=endpoint.pathname.endsWith('/tree'),isIds=endpoint.pathname.endsWith('/ids');
  const native={kind:'Listing',data:{children:comments?data.data:data.data.map((d:any)=>({kind:'t3',data:d}))}},page=listing(native,'https://www.reddit.com',r.url,r.fetchedAt!);
  if(isIds){const ids=(endpoint.searchParams.get('ids')??'').split(',');if(page.posts.some(p=>!ids.includes(p.id.replace(/^t3_/,''))))throw new FishError('REDDIT_ARCHIVE_ID_MISMATCH');}
  for(const p of page.posts){const original=data.data.map((d:any)=>d.kind==='t1'?d.data:d).find((d:any)=>String(d.id)===p.id.replace(/^t[13]_/,''));p.archivedAt=timestamp(original?.retrieved_on??original?._meta?.retrieved_on);}
  const next=new URL(endpoint),last=data.data.at(-1),cursor=!comments&&!isIds&&typeof last?.created_utc==='number';if(cursor)next.searchParams.set('before',String(last.created_utc));
  const postId=isIds&&data.data.length===1?str(data.data[0].id):null,commentsUrl=postId?archive+'/comments/tree?link_id=t3_'+postId+'&limit=100':null;
  return {...page,url:raw,provider:'Arctic Shift (third-party public Reddit archive)',coverage:comments?'archived_comment_tree':'archived_posts',commentsUrl,
   links:[...(cursor?[{url:next.href,label:'更早的归档帖子'}]:[]),...(commentsUrl?[{url:commentsUrl,label:'归档评论树'}]:[])],nextPage:cursor?next.href:null,
   notice:'备用公开归档，可能滞后、不完整；不能据此确认当前最新帖子或当前可见状态。列表按发帖时间排序，非实时热门榜。archivedAt 是归档抓取时间，不是发帖时间。'};
 }catch(e){if(signal?.aborted)throw e;return unavailable(raw,'Arctic Shift (public archive)',[failure(raw,e)]);}
}
