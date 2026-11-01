import type { PublicReader } from './public-web.js';
import { FishError,codeOf } from '../types.js';
import { publicUrl } from './provider.js';

const api='https://api.bilibili.com/x/polymer/web-dynamic/v1/';
const link=(raw:unknown,base:string)=>{try{const u=new URL(String(raw??''),base);return raw&&publicUrl(u.href)?u.href:null;}catch{return null;}};
/** This is a URL reader, not a chat-intent router. No credentials or captcha
 * bypass: try the public full feed, then report the narrower public opus feed. */
export async function bilibiliSpace(raw:string,reader:PublicReader,signal?:AbortSignal){
  const u=new URL(raw),match=u.hostname==='space.bilibili.com'?/^\/(\d+)(?:\/dynamic)?\/?$/.exec(u.pathname):null;
  const direct=u.hostname==='api.bilibili.com'&&['/x/polymer/web-dynamic/v1/feed/space','/x/polymer/web-dynamic/v1/opus/feed/space'].includes(u.pathname);
  if(!match&&!direct)return;
  const uid=match?.[1]??u.searchParams.get('host_mid');
  if(!uid||!/^\d{1,20}$/.test(uid))throw new FishError('BILIBILI_UID_INVALID');
  const offset=u.searchParams.get('offset')??'';if(offset&&!/^\d{1,30}$/.test(offset))throw new FishError('BILIBILI_OFFSET_INVALID');
  const failures:{url:string;error:string}[]=[];
  const paths=direct?[u.pathname.includes('/opus/')?'opus/feed/space':'feed/space']:['feed/space','opus/feed/space'];
  for(const path of paths){
    const endpoint=new URL(api+path);endpoint.searchParams.set('host_mid',uid);if(offset)endpoint.searchParams.set('offset',offset);
    const sourceUrl=endpoint.href;
    try{
      const resource=await reader(sourceUrl,2097152,signal),data=JSON.parse(resource.bytes.toString('utf8'));
      if(data.code!==0)throw new FishError('BILIBILI_API_'+String(data.code));
      if(!Array.isArray(data.data?.items))throw new FishError('BILIBILI_FEED_INVALID');
      const limited=path.startsWith('opus/');
      const posts=data.data.items.map((item:any,index:number)=>{
        const author=item.modules?.module_author,body=item.modules?.module_dynamic,major=body?.major;
        const id=String(item.opus_id??item.id_str??''),url=link(item.jump_url??(id?'https://www.bilibili.com/opus/'+id:null),sourceUrl);
        const content=String(item.content??body?.desc?.text??major?.opus?.summary?.text??major?.archive?.title??'');
        const pinned=item.modules?.module_tag?.text==='置顶';
        const media=(limited?[{src:item.cover?.url,kind:'post_cover'}]:[
          ...(major?.draw?.items??[]).map((p:any)=>({src:p.src,kind:'post_image'})),
          ...(major?.opus?.pics??[]).map((p:any)=>({src:p.url,kind:'post_image'})),
          ...(major?.archive?.cover?[{src:major.archive.cover,kind:'video_cover'}]:[]),
        ]).map((p:any)=>({url:link(p.src,sourceUrl),kind:p.kind,label:'动态 '+id})).filter((p:any)=>p.url);
        const timestamp=author?.pub_ts;
        return {position:index+1,id,url,type:item.type??'image_text',pinned,
          publishedAt:Number.isFinite(timestamp)&&timestamp>0?new Date(timestamp*1000).toISOString():null,
          publishedLabel:author?.pub_time??item.pub_time??null,content:content.slice(0,2000),truncated:content.length>2000,images:media};
      });
      const next=new URL(sourceUrl);if(data.data.offset)next.searchParams.set('offset',String(data.data.offset));
      return {url:raw,sourceUrl,title:'B站用户 '+uid+' 的公开动态',status:'content',fetchedAt:new Date().toISOString(),
        coverage:limited?'image_text_posts_only':'space_dynamics',latestVerified:false,
        notice:limited?'只取得公开图文列表，不含全部视频/转发；不能据此确认整体最新动态。空发布时间表示接口未提供。':'保留接口顺序；置顶不等于最新，按发布时间核对。',
        unavailable:failures,posts:posts.slice(0,10),totalPosts:posts.length,
        text:posts.map((p:any)=>JSON.stringify(p)).join('\n'),images:posts.flatMap((p:any)=>p.images),
        links:[...posts.filter((p:any)=>p.url).map((p:any)=>({url:p.url,label:p.content.slice(0,120)||p.id})),
          ...(data.data.has_more&&data.data.offset?[{url:next.href,label:'下一页动态'}]:[])],
        nextPage:data.data.has_more&&data.data.offset?next.href:null};
    }catch(e){if(signal?.aborted)throw e;failures.push({url:sourceUrl,error:codeOf(e)});}
  }
  return {url:raw,title:'B站公开动态',status:'unavailable',fetchedAt:new Date().toISOString(),coverage:'none',latestVerified:false,
    notice:'未能读取动态列表，不能从搜索摘要确认最新动态。',unavailable:failures,text:'',images:[],links:[],posts:[],nextPage:null};
}
