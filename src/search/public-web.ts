import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { Parser } from 'htmlparser2';
import { FishError } from '../types.js';
import { publicUrl } from './provider.js';
import { pageEvidence } from './evidence.js';
import { bilibiliSpace } from './bilibili.js';
import {twitterPage} from './twitter.js';
import {redditPage} from './reddit.js';
import {blueskyPage} from './bluesky.js';
import {mastodonPage} from './mastodon.js';
import {parseFeed} from './feeds.js';
import {socialOutput} from './social-common.js';
import { tiebaPage } from './tieba.js';
import { MAX_IMAGE_BYTES } from '../image/limits.js';

export function publicAddress(address:string):boolean{
  if(isIP(address)===4){
    const [a,b,c]=address.split('.').map(Number);
    return publicUrl('https://'+address)&&!(a===192&&b===0||a===192&&b===88&&c===99||a===192&&b===0&&c===2||a===198&&b===51&&c===100||a===203&&b===0&&c===113);
  }
  // Global IPv6 unicast only; exclude protocol assignments, documentation and 6to4.
  if(isIP(address)!==6)return false;
  const [first,second]=address.split(':').map(v=>parseInt(v||'0',16));
  return first>=0x2000&&first<0x4000&&first!==0x2002&&first!==0x3fff&&!(first===0x2001&&(second<0x200||second===0xdb8));
}
export interface PublicResource {url:string;type:string;bytes:Buffer;fetchedAt?:string;cached?:boolean}
export type PublicReader=(url:string,limit:number,signal?:AbortSignal)=>Promise<PublicResource>;
export type PublicPoster=(url:string,body:URLSearchParams,signal?:AbortSignal)=>Promise<PublicResource>;
/** Pin checked DNS addresses on every hop; never forward cookies, auth or local files. */
export const readPublic:PublicReader=(raw,limit,signal)=>requestPublic(raw,limit,signal);
async function requestPublic(raw:string,limit:number,signal?:AbortSignal,post?:Buffer):Promise<PublicResource>{
  const joined=AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]);
  for(let hop=0;hop<6;hop++){
    joined.throwIfAborted();
    if(typeof raw!=='string'||raw.length>8192||!publicUrl(raw))throw new FishError('WEB_PUBLIC_URL_REQUIRED');
    const url=new URL(raw);url.hash='';
    const addresses=await new Promise<{address:string;family:number}[]>((resolve,reject)=>{
      const abort=()=>reject(joined.reason);joined.addEventListener('abort',abort,{once:true});
      dns.lookup(url.hostname,{all:true}).then(resolve,reject).finally(()=>joined.removeEventListener('abort',abort));
    });joined.throwIfAborted();
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new FishError('WEB_PRIVATE_ADDRESS');
    const address=addresses.find(a=>a.family===4)??addresses[0];
    const response=await new Promise<{status:number;location?:string;type:string;bytes:Buffer}>((resolve,reject)=>{
      const options={
        agent:false as const,signal:joined,
        headers:{'User-Agent':'DeepSeekFish/0.1 (+https://github.com/Humoiww/DeepSeekFish)','Accept':'text/html,application/xhtml+xml,text/plain,image/*;q=0.9,*/*;q=0.5','Accept-Encoding':'identity'},
        lookup:((_host:any,opts:any,cb:any)=>opts.all?cb(null,[address]):cb(null,address.address,address.family)) as any,
      };
      const onResponse=(res:http.IncomingMessage)=>{
        const status=res.statusCode??0,type=String(res.headers['content-type']??'');
        if([301,302,303,307,308].includes(status)){res.destroy();resolve({status,location:res.headers.location,type,bytes:Buffer.alloc(0)});return;}
        if(status<200||status>=300){res.destroy();reject(new FishError('WEB_HTTP_'+status));return;}
        if(Number(res.headers['content-length']??0)>limit){res.destroy();reject(new FishError('WEB_BODY_TOO_LARGE'));return;}
        if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new FishError('WEB_ENCODING_UNSUPPORTED'));return;}
        const chunks:Buffer[]=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>limit){res.destroy(new FishError('WEB_BODY_TOO_LARGE'));return;}chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>resolve({status,type,bytes:Buffer.concat(chunks)}));
      };
      const request=post?https.request(url,{...options,method:'POST',maxVersion:'TLSv1.2',headers:{...options.headers,'Content-Type':'application/x-www-form-urlencoded','Content-Length':String(post.length)}},onResponse):(url.protocol==='https:'?https:http).get(url,options,onResponse);
      request.on('error',reject);if(post)request.end(post);
    });
    if(response.location){if(post)throw new FishError('WEB_POST_REDIRECT_REJECTED');raw=new URL(response.location,url).href;continue;}
    if(response.status>=300)throw new FishError('WEB_REDIRECT_INVALID');
    return {url:url.href,type:response.type,bytes:response.bytes};
  }
  throw new FishError('WEB_REDIRECT_LIMIT');
}
/** Only these public read APIs accept a POST body; models cannot choose an API action. */
export const postPublic:PublicPoster=(raw,body,signal)=>{
  const url=new URL(raw);
  if(url.origin!=='https://tiebac.baidu.com'||url.search||url.hash||!['/c/f/frs/page','/c/f/pb/page','/c/f/pb/floor'].includes(url.pathname))throw new FishError('WEB_POST_TARGET_DENIED');
  const bytes=Buffer.from(body.toString());if(bytes.length>16384)throw new FishError('WEB_BODY_TOO_LARGE');
  return requestPublic(url.href,2097152,signal,bytes);
};
export function imageAddress(raw:string,base?:string){
  const u=new URL(raw,base);
  if(u.hostname==='github.com'&&/^\/[^/]+\/[^/]+\/(blob|raw)\/.+\.(png|jpe?g|gif|webp)$/i.test(u.pathname)){
    u.hostname='raw.githubusercontent.com';u.pathname=u.pathname.replace(/\/(blob|raw)\//,'/');
  }
  u.hash='';return u.href;
}
export function pageAssets(html:string,base:string){
  let title='',text='',mainText='',articleText='',titleDepth=0,skip=0,main=0,article=0,anchor:{url:string;label:string;rank:number}|undefined;
  const images=new Map<string,{url:string;label:string;kind:string;rank:number}>(),links=new Map<string,{url:string;label:string;rank:number}>();
  const rank=()=>article?4:main?3:1;
  const absolute=(raw:string)=>{try{const u=new URL(raw,base);u.hash='';return publicUrl(u.href)?u.href:undefined;}catch{return undefined;}};
  const addLink=(raw:string,label='',priority=rank())=>{const url=absolute(raw);if(!url)return;const prior=links.get(url);if(!prior||priority>prior.rank)links.set(url,{url,label:label.slice(0,160),rank:priority});};
  const addImage=(raw:string,label='',kind='image',priority=rank())=>{
    const resolved=absolute(raw);if(!resolved)return;const url=imageAddress(resolved),prior=images.get(url);
    if(!prior||priority>prior.rank||!prior.label&&label)images.set(url,{url,label:label.slice(0,240),kind,rank:Math.max(priority,prior?.rank??0)});
  };
  const parser=new Parser({
    onopentag(name,a){
      if(name==='main')main++;if(name==='article')article++;
      if(['script','style','template'].includes(name))skip++;
      if(name==='title')titleDepth++;
      if(name==='img'||name==='source'){
        for(const attr of ['src','data-src','data-original','data-lazy-src'])if(a[attr])addImage(a[attr],a.alt??'');
        for(const attr of ['srcset','data-srcset'])for(const item of (a[attr]??'').split(',')){const src=item.trim().split(/\s+/)[0];if(src)addImage(src,a.alt??'');}
      }
      if(name==='meta'&&/^(og:image(?::url)?|twitter:image(?::src)?)$/i.test(a.property??a.name??'')&&a.content)addImage(a.content,'网页预览图','page_preview',0);
      if(name==='video'&&a.poster)addImage(a.poster,'视频封面','video_cover');
      if(name==='link'&&a.rel==='alternate'&&/application\/(?:rss|atom)\+xml/i.test(a.type??'')&&a.href)addLink(a.href,a.title??'RSS/Atom 订阅',3);
      if(name==='script'&&a.src)addLink(a.src,'网页脚本（可读取公开数据入口，不执行）',0);
      if(name==='link'&&['modulepreload','preload'].includes(a.rel)&&a.href)addLink(a.href,'网页资源',0);
      if(name==='a'&&a.href){const url=absolute(a.href);if(url){addLink(url,a.title??'');anchor=links.get(url);if(/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(url))addImage(url,a.title??'');}}
    },
    ontext(value){if(skip)return;if(titleDepth)title+=value;if(text.length<200000)text+=value+' ';if(main&&mainText.length<200000)mainText+=value+' ';if(article&&articleText.length<200000)articleText+=value+' ';if(anchor)anchor.label=(anchor.label+value).slice(0,160);},
    onclosetag(name){if(['script','style','template'].includes(name))skip=Math.max(0,skip-1);if(name==='title')titleDepth=Math.max(0,titleDepth-1);if(name==='main')main=Math.max(0,main-1);if(name==='article')article=Math.max(0,article-1);if(name==='a')anchor=undefined;},
  },{decodeEntities:true});parser.end(html);
  for(const match of html.matchAll(/(!?)\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/g)){
    if(match[1])addImage(match[3],match[2],'image',4);else addLink(match[3],match[2],4);
  }
  // Discover public data files referenced by static pages and scripts without evaluating code.
  for(const m of html.matchAll(/["']((?:https?:\/\/|\/|\.\.?\/)[^\s"'<>]{1,8192}\.(?:json|m?js)(?:\?[^\s"'<>]*)?)["']/g))addLink(m[1],m[1].includes('.json')?'公开数据索引':'网页脚本',m[1].includes('.json')?4:0);
  return {title:title.trim().slice(0,200),text:(articleText||mainText||text).replace(/\s+/g,' ').trim(),images:[...images.values()].sort((a,b)=>b.rank-a.rank).map(({rank,...i})=>i),links:[...links.values()].sort((a,b)=>b.rank-a.rank).map(({rank,...i})=>i)};
}
function jsonAssets(value:unknown,base:string){
  const images=new Map<string,{url:string;label:string;kind:string}>(),links=new Map<string,{url:string;label:string}>();
  const visit=(node:any,depth=0)=>{
    if(!node||typeof node!=='object'||depth>40)return;
    const label=[node.alt,node.name,node.title,node.description].find(v=>typeof v==='string')??'';
    for(const [key,v] of Object.entries(node)){
      if(typeof v==='string'){
        if(key==='preview'&&(typeof node.original==='string'||typeof node.path==='string'))continue;
        if(v.startsWith('#')||/\s/.test(v)||! /\.(png|jpe?g|gif|webp|json)(?:[?#]|$)/i.test(v))continue;
        try{
          const url=new URL(v,base).href;if(!publicUrl(url))continue;
          if(/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(url))images.set(url,{url:imageAddress(url),label:String(label).slice(0,240),kind:'image'});
          else if(/\.json(?:[?#]|$)/i.test(url))links.set(url,{url,label:String(label).slice(0,160)});
        }catch{}
      }else if(v&&typeof v==='object')visit(v,depth+1);
    }
  };visit(value);return {title:'公开JSON数据',text:JSON.stringify(value).slice(0,200000),images:[...images.values()],links:[...links.values()]};
}
export async function browsePage(url:string,offset=0,signal?:AbortSignal,reader:PublicReader=readPublic,query='',textOffset=0,poster:PublicPoster=postPublic){
  if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(textOffset)||textOffset<0||textOffset>200000||typeof query!=='string'||query.length>200)throw new FishError('WEB_OFFSET_INVALID');
  if(typeof url!=='string'||url.length>8192||!publicUrl(url))throw new FishError('WEB_PUBLIC_URL_REQUIRED');
  const tieba=await tiebaPage(url,poster,signal);
  if(tieba)return {...tieba,text:tieba.text.slice(textOffset,textOffset+5000),textOffset,nextTextOffset:textOffset+5000<tieba.text.length?textOffset+5000:null,
    images:tieba.images.slice(offset,offset+25),links:tieba.links.slice(offset,offset+25),totalImages:tieba.images.length,totalLinks:tieba.links.length,nextOffset:Math.max(tieba.images.length,tieba.links.length)>offset+25?offset+25:null};
  const feed=await bilibiliSpace(url,reader,signal);
  if(feed)return {...feed,text:feed.text.slice(textOffset,textOffset+5000),textOffset,nextTextOffset:textOffset+5000<feed.text.length?textOffset+5000:null,
    images:feed.images.slice(offset,offset+25),links:feed.links.slice(offset,offset+25),totalImages:feed.images.length,totalLinks:feed.links.length,nextOffset:Math.max(feed.images.length,feed.links.length)>offset+25?offset+25:null};
  for(const read of [twitterPage,redditPage,blueskyPage,mastodonPage]){const page=await read(url,reader,signal);if(page)return socialOutput(page,offset,textOffset,query);}
  const r=await reader(url,2097152,signal);
  if(/^image\//i.test(r.type))return {url:r.url,title:'图片',status:'image',fetchedAt:new Date().toISOString(),latestVerified:false,text:'',textOffset:0,nextTextOffset:null,images:[{url:r.url,kind:'image',label:'直接图片地址'}],links:[],totalImages:1,totalLinks:0,nextOffset:null};
  if(!/^(text\/|application\/(xhtml\+xml|atom\+xml|rss\+xml|xml|json|javascript))/i.test(r.type))throw new FishError('WEB_PAGE_TYPE_UNSUPPORTED');
  let html:string;try{html=new TextDecoder(/charset=["']?([^;\s"']+)/i.exec(r.type)?.[1]??'utf-8').decode(r.bytes);}catch{html=r.bytes.toString('utf8');}
  const subscription=parseFeed(html,r.url);if(subscription)return socialOutput(subscription,offset,textOffset,query);
  let p;try{p=/json/i.test(r.type)||/^\s*[\[{]/.test(html)?jsonAssets(JSON.parse(html),r.url):pageAssets(html,r.url);}catch{p=pageAssets(html,r.url);}
  const terms=query.toLowerCase().split(/\s+/).filter(Boolean),images=terms.length?p.images.filter(i=>terms.every(t=>(i.label+' '+i.url).toLowerCase().includes(t))):p.images;
  const end=offset+25,content=p.text.slice(textOffset,textOffset+5000);
  return {url:r.url,title:p.title,fetchedAt:new Date().toISOString(),...pageEvidence(p.title,p.text,/<script\b/i.test(html)),text:content,textOffset,nextTextOffset:textOffset+content.length<p.text.length?textOffset+content.length:null,images:images.slice(offset,end),links:p.links.slice(offset,end),totalImages:images.length,totalLinks:p.links.length,nextOffset:Math.max(images.length,p.links.length)>end?end:null};
}
export async function downloadWebImage(url:string,signal?:AbortSignal,reader:PublicReader=readPublic){
  if(typeof url!=='string'||!publicUrl(url))throw new FishError('WEB_PUBLIC_URL_REQUIRED');
  const r=await reader(imageAddress(url),MAX_IMAGE_BYTES,signal);
  if(/^(text\/|application\/(json|xhtml\+xml))/i.test(r.type))throw new FishError('WEB_IMAGE_EXPECTED');
  return r;
}
