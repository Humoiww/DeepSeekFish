import type {PublicReader} from './public-web.js';
import {FishError} from '../types.js';
import {failure,safeLink,socialJson,str,timestamp,unavailable,type SocialPage,type SocialPost} from './social-common.js';
const api='https://public.api.bsky.app/xrpc/';
export async function blueskyPage(raw:string,reader:PublicReader,signal?:AbortSignal):Promise<SocialPage|undefined>{
 const u=new URL(raw),match=u.hostname==='bsky.app'?/^\/profile\/([^/]+)(?:\/post\/([a-z0-9]+))?\/?$/.exec(u.pathname):null;
 const direct=u.origin==='https://public.api.bsky.app'&&['/xrpc/app.bsky.feed.getPostThread','/xrpc/app.bsky.feed.getAuthorFeed'].includes(u.pathname);if(!match&&!direct)return;
 const errors:SocialPage['unavailable']=[];let source=raw;
 try{
  let endpoint:URL;
  if(match){
   let actor=decodeURIComponent(match[1]);
   if(match[2]){
    if(!actor.startsWith('did:')){source=api+'com.atproto.identity.resolveHandle?handle='+encodeURIComponent(actor);const {data}=await socialJson(reader,source,signal);if(!/^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(data.did??''))throw new FishError('BLUESKY_HANDLE_UNRESOLVED');actor=data.did;}
    endpoint=new URL(api+'app.bsky.feed.getPostThread');endpoint.searchParams.set('uri','at://'+actor+'/app.bsky.feed.post/'+match[2]);endpoint.searchParams.set('depth','2');endpoint.searchParams.set('parentHeight','2');
   }else{endpoint=new URL(api+'app.bsky.feed.getAuthorFeed');endpoint.searchParams.set('actor',actor);}
  }else{
   endpoint=new URL(api+u.pathname.split('/').at(-1));for(const key of ['uri','actor','cursor','filter'])if(u.searchParams.has(key))endpoint.searchParams.set(key,u.searchParams.get(key)!);
   if(endpoint.pathname.endsWith('getPostThread')){endpoint.searchParams.set('depth','2');endpoint.searchParams.set('parentHeight','2');}
  }
  const thread=endpoint.pathname.endsWith('getPostThread');if(!thread)endpoint.searchParams.set('limit','10');source=endpoint.href;
  const {r,data}=await socialJson(reader,source,signal);if(data.error||thread&&!data.thread||!thread&&!Array.isArray(data.feed))throw new FishError('BLUESKY_RESPONSE_INVALID');
  if(thread&&data.thread.post&&data.thread.post.uri!==endpoint.searchParams.get('uri'))throw new FishError('BLUESKY_POST_ID_MISMATCH');
  const posts:SocialPost[]=[],seen=new Set<string>();
  function add(p:any,kind='post',depth=0,reason?:any){
   if(!p||depth>6||posts.length>=150)return;
   const id=str(p.uri);if(!id||seen.has(id))return;seen.add(id);
   const a=p.author??{},record=p.record??p.value??{},url=safeLink('https://bsky.app/profile/'+encodeURIComponent(str(a.did)||str(a.handle))+'/post/'+encodeURIComponent(id.split('/').at(-1)!),raw),images:SocialPost['images']=[],links:SocialPage['links']=[];
   const e=p.embed??{};function media(m:any){for(const i of m.images??[]){const src=safeLink(i.fullsize??i.thumb,raw);if(src)images.push({url:src,kind:i.fullsize?'post_image':'post_preview',label:str(i.alt),postId:id});}if(m.thumbnail){const src=safeLink(m.thumbnail,raw);if(src)images.push({url:src,kind:'video_cover',label:str(m.alt),postId:id});}if(m.external){const ext=safeLink(m.external.uri,raw);if(ext)links.push({url:ext,label:str(m.external.title)});}}
   media(e);if(e.media)media(e.media);
   for(const f of record.facets??[])for(const feature of f.features??[]){const link=safeLink(feature.uri,raw);if(link)links.push({url:link,label:link});}
   const quote=e.record?.record??e.record;
   posts.push({id,url,author:{id:str(a.did),name:str(a.displayName)||str(a.handle),handle:str(a.handle)},publishedAt:timestamp(record.createdAt),text:str(record.text),images,kind:p.notFound||p.blocked?'unavailable':kind,parentId:str(record.reply?.parent?.uri)||null,links:links.slice(0,25),...(quote?.uri?{quotedPostId:quote.uri}:{}),...(reason?.by?{repostedBy:{id:str(reason.by.did),handle:str(reason.by.handle),name:str(reason.by.displayName)}}:{})});
   if(quote?.uri)add(quote,'quoted_post',depth+1);
  }
  function walk(node:any,depth=0){if(!node||depth>6)return;add(node.post??node,depth?'thread_post':'post');if(node.parent)walk(node.parent,depth+1);for(const reply of node.replies??[])walk(reply,depth+1);}
  if(thread)walk(data.thread);else for(const item of data.feed)add(item.post,'post',0,item.reason);
  const next=new URL(endpoint),cursor=str(data.cursor);if(cursor)next.searchParams.set('cursor',cursor);
  return {url:raw,sourceUrl:r.url,provider:'Bluesky public AppView',coverage:thread?'returned_thread':'author_feed',title:'Bluesky',status:posts.some(p=>p.kind!=='unavailable')?'content':posts.length?'unavailable':'empty',fetchedAt:r.fetchedAt!,cached:r.cached??false,latestVerified:false,posts,postsTruncated:posts.length>=150,links:cursor?[{url:next.href,label:'下一页'}]:[],nextPage:cursor?next.href:null,unavailable:errors,notice:thread?'评论返回两层，可打开具体回复链接继续读取。':'保留实际作者、引用和转发人，当前页不代表全部帖子。'};
 }catch(e){if(signal?.aborted)throw e;errors.push(failure(source,e));return unavailable(raw,'Bluesky',errors);}
}
