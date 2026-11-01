import type { PublicReader } from './public-web.js';
import { FishError,codeOf } from '../types.js';
import { publicUrl } from './provider.js';

const api='https://api.bilibili.com/x/polymer/web-dynamic/';
const link=(raw:unknown,base:string)=>{try{const u=new URL(String(raw??''),base);return raw&&publicUrl(u.href)?u.href:null;}catch{return null;}};

function parsePost(item:any,base:string,position:number,limited=false,depth=0):any{
  // Desktop uses a module array; web uses a module map. Neither avatar nor
  // author decoration belongs to the dynamic's media.
  const module=(key:string)=>Array.isArray(item.modules)?item.modules.find((m:any)=>m?.[key])?.[key]:item.modules?.[key];
  const author=module('module_author'),body=module('module_dynamic'),major=body?.major;
  const user=author?.user??author,video=body?.dyn_archive??major?.archive;
  const id=String(item.opus_id??item.id_str??''),url=link(item.jump_url??(id?'https://t.bilibili.com/'+id:null),base);
  const content=String(item.content??module('module_desc')?.text??body?.desc?.text??major?.opus?.summary?.text??video?.title??'');
  const pinned=author?.is_top===true||module('module_tag')?.text==='置顶';
  const media=(limited?[{src:item.cover?.url,kind:'post_cover'}]:[
    ...(body?.dyn_draw?.items??major?.draw?.items??[]).map((p:any)=>({src:p.src,kind:'post_image'})),
    ...(major?.opus?.pics??[]).map((p:any)=>({src:p.url,kind:'post_image'})),
    ...(video?.cover?[{src:video.cover,kind:'video_cover'}]:[]),
    ...(body?.dyn_article?.covers??major?.article?.covers??[]).map((src:string)=>({src,kind:'article_cover'})),
  ]).map((p:any)=>({url:link(p.src,base),kind:p.kind,label:'动态 '+id})).filter((p:any)=>p.url);
  const timestamp=author?.pub_ts,original=item.orig??body?.dyn_forward?.item??body?.dyn_forward;
  return {position,id,url,type:item.type??'image_text',pinned,
    author:user?.mid?{uid:String(user.mid),name:user.name??null,official:user.official?.title??user.official_verify?.desc??null}:null,
    publishedAt:Number.isFinite(timestamp)&&timestamp>0?new Date(timestamp*1000).toISOString():null,
    publishedLabel:author?.pub_time??author?.pub_text??item.pub_time??null,content:content.slice(0,2000),truncated:content.length>2000,images:media,
    ...(video?{video:{bvid:video.bvid??null,title:video.title??null,description:video.desc??null,contentObserved:'title_description_cover_only'}}:{}),
    ...(original&&depth<2?{original:parsePost(original,base,position,false,depth+1)}:{})};
}

/** This is a URL reader, not a chat-intent router. No credentials or captcha
 * bypass: try the desktop/web public feeds, then report the narrower opus feed. */
export async function bilibiliSpace(raw:string,reader:PublicReader,signal?:AbortSignal){
  const u=new URL(raw),match=u.hostname==='space.bilibili.com'?/^\/(\d+)(?:\/dynamic)?\/?$/.exec(u.pathname):null;
  if(u.hostname==='t.bilibili.com'&&u.pathname==='/')return {url:raw,title:'B站关注流',status:'target_account_required',fetchedAt:new Date().toISOString(),coverage:'none',latestVerified:false,
    notice:'这是登录账号的关注流首页，不是目标UP的动态。先搜索目标账号的数字UID，再用 browse_page 打开 https://space.bilibili.com/UID/dynamic。',unavailable:[],text:'',images:[],links:[],posts:[],nextPage:null};
  const direct=u.hostname==='api.bilibili.com'&&['/x/polymer/web-dynamic/v1/feed/space','/x/polymer/web-dynamic/desktop/v1/feed/space','/x/polymer/web-dynamic/v1/opus/feed/space'].includes(u.pathname);
  if(!match&&!direct)return;
  const uid=match?.[1]??u.searchParams.get('host_mid');
  if(!uid||!/^\d{1,20}$/.test(uid))throw new FishError('BILIBILI_UID_INVALID');
  const offset=u.searchParams.get('offset')??'';if(offset&&!/^\d{1,30}$/.test(offset))throw new FishError('BILIBILI_OFFSET_INVALID');
  const failures:{url:string;error:string}[]=[];
  const paths=direct?[u.pathname.replace('/x/polymer/web-dynamic/','')]:['desktop/v1/feed/space','v1/feed/space','v1/opus/feed/space'];
  for(const path of paths){
    const endpoint=new URL(api+path);endpoint.searchParams.set('host_mid',uid);if(offset)endpoint.searchParams.set('offset',offset);
    const sourceUrl=endpoint.href;
    try{
      const resource=await reader(sourceUrl,2097152,signal),data=JSON.parse(resource.bytes.toString('utf8'));
      if(data.code!==0)throw new FishError('BILIBILI_API_'+String(data.code));
      if(!Array.isArray(data.data?.items))throw new FishError('BILIBILI_FEED_INVALID');
      const limited=path.includes('/opus/');
      const posts=data.data.items.map((item:any,index:number)=>parsePost(item,sourceUrl,index+1,limited));
      const dated=posts.filter((p:any)=>!p.pinned&&p.publishedAt).sort((a:any,b:any)=>b.publishedAt.localeCompare(a.publishedAt));
      const next=new URL(sourceUrl);if(data.data.offset)next.searchParams.set('offset',String(data.data.offset));
      return {url:raw,sourceUrl,title:'B站用户 '+uid+' 的公开动态',status:'content',fetchedAt:new Date().toISOString(),
        coverage:limited?'image_text_posts_only':'space_dynamics',latestVerified:false,
        notice:limited?'只取得公开图文列表，不含全部视频/转发；不能据此确认整体最新动态。空发布时间表示接口未提供。':'保留接口顺序；置顶不等于最新，按发布时间核对。',
        unavailable:failures,posts,totalPosts:posts.length,latestOnPage:dated.length?{id:dated[0].id,publishedAt:dated[0].publishedAt}:null,
        text:'正文、日期和配图见 posts；置顶单独标记，下一页见 nextPage。',images:posts.flatMap((p:any)=>p.images),
        links:[...posts.filter((p:any)=>p.url).map((p:any)=>({url:p.url,label:p.content.slice(0,120)||p.id})),
          ...(data.data.has_more&&data.data.offset?[{url:next.href,label:'下一页动态'}]:[])],
        nextPage:data.data.has_more&&data.data.offset?next.href:null};
    }catch(e){if(signal?.aborted)throw e;failures.push({url:sourceUrl,error:codeOf(e)});}
  }
  return {url:raw,title:'B站公开动态',status:'unavailable',fetchedAt:new Date().toISOString(),coverage:'none',latestVerified:false,
    notice:'未能读取动态列表，不能从搜索摘要确认最新动态。',unavailable:failures,text:'',images:[],links:[],posts:[],nextPage:null};
}
