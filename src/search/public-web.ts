import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { Parser } from 'htmlparser2';
import { FishError } from '../types.js';
import { publicUrl } from './provider.js';

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
export interface PublicResource {url:string;type:string;bytes:Buffer}
export type PublicReader=(url:string,limit:number,signal?:AbortSignal)=>Promise<PublicResource>;
/** Pin checked DNS addresses on every hop; never forward cookies, auth or local files. */
export const readPublic:PublicReader=async(raw,limit,signal)=>{
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
      const request=(url.protocol==='https:'?https:http).get(url,{
        agent:false,signal:joined,
        headers:{'User-Agent':'DeepSeekFish/0.1 (+https://github.com/Humoiww/DeepSeekFish)','Accept':'text/html,application/xhtml+xml,text/plain,image/*;q=0.9,*/*;q=0.5','Accept-Encoding':'identity'},
        lookup:((_host:any,opts:any,cb:any)=>opts.all?cb(null,[address]):cb(null,address.address,address.family)) as any,
      },res=>{
        const status=res.statusCode??0,type=String(res.headers['content-type']??'');
        if([301,302,303,307,308].includes(status)){res.destroy();resolve({status,location:res.headers.location,type,bytes:Buffer.alloc(0)});return;}
        if(status<200||status>=300){res.destroy();reject(new FishError('WEB_HTTP_'+status));return;}
        if(Number(res.headers['content-length']??0)>limit){res.destroy();reject(new FishError('WEB_BODY_TOO_LARGE'));return;}
        if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new FishError('WEB_ENCODING_UNSUPPORTED'));return;}
        const chunks:Buffer[]=[];let size=0;
        res.on('data',chunk=>{size+=chunk.length;if(size>limit){res.destroy(new FishError('WEB_BODY_TOO_LARGE'));return;}chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>resolve({status,type,bytes:Buffer.concat(chunks)}));
      });request.on('error',reject);
    });
    if(response.location){raw=new URL(response.location,url).href;continue;}
    if(response.status>=300)throw new FishError('WEB_REDIRECT_INVALID');
    return {url:url.href,type:response.type,bytes:response.bytes};
  }
  throw new FishError('WEB_REDIRECT_LIMIT');
};
export function pageAssets(html:string,base:string){
  let title='',text='',titleDepth=0,skip=0,anchor:{url:string;label:string}|undefined;
  const images=new Map<string,{url:string;label:string;kind:string}>(),links=new Map<string,{url:string;label:string}>();
  const absolute=(raw:string)=>{try{const u=new URL(raw,base);u.hash='';return publicUrl(u.href)?u.href:undefined;}catch{return undefined;}};
  const addImage=(raw:string,label='',kind='image')=>{const url=absolute(raw);if(url&&images.size<1000&&!images.has(url))images.set(url,{url,label:label.slice(0,160),kind});};
  const parser=new Parser({
    onopentag(name,a){
      if(['script','style','template'].includes(name))skip++;
      if(name==='title')titleDepth++;
      if(name==='img'||name==='source'){
        for(const attr of ['src','data-src','data-original','data-lazy-src'])if(a[attr])addImage(a[attr],a.alt??'');
        for(const attr of ['srcset','data-srcset'])for(const item of (a[attr]??'').split(',')){const src=item.trim().split(/\s+/)[0];if(src)addImage(src,a.alt??'');}
      }
      if(name==='meta'&&/^(og:image(?::url)?|twitter:image(?::src)?)$/i.test(a.property??a.name??'')&&a.content)addImage(a.content,'网页预览图','page_preview');
      if(name==='video'&&a.poster)addImage(a.poster,'视频封面','video_cover');
      if(name==='a'&&a.href){const url=absolute(a.href);if(url){anchor={url,label:''};if(links.size<1000&&!links.has(url))links.set(url,anchor);if(/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(url))addImage(url,a.title??'');}}
    },
    ontext(value){if(skip)return;if(titleDepth)title+=value;if(text.length<100000)text+=value+' ';if(anchor)anchor.label=(anchor.label+value).slice(0,160);},
    onclosetag(name){if(['script','style','template'].includes(name))skip=Math.max(0,skip-1);if(name==='title')titleDepth=Math.max(0,titleDepth-1);if(name==='a')anchor=undefined;},
  },{decodeEntities:true});parser.end(html);
  // Fetch APIs and raw Markdown documents often expose images in Markdown syntax.
  for(const match of html.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|\.\.?\/[^\s)]+)\)/g))addImage(match[2],match[1]);
  return {title:title.trim().slice(0,200),text:text.replace(/\s+/g,' ').trim(),images:[...images.values()],links:[...links.values()]};
}
export async function browsePage(url:string,offset=0,signal?:AbortSignal,reader:PublicReader=readPublic){
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000)throw new FishError('WEB_OFFSET_INVALID');
  const r=await reader(url,2097152,signal);
  if(/^image\//i.test(r.type))return {url:r.url,images:[{url:r.url,kind:'image',label:'直接图片地址'}],links:[],nextOffset:null};
  if(!/^(text\/|application\/(xhtml\+xml|json))/i.test(r.type))throw new FishError('WEB_PAGE_TYPE_UNSUPPORTED');
  let html:string;try{html=new TextDecoder(/charset=["']?([^;\s"']+)/i.exec(r.type)?.[1]??'utf-8').decode(r.bytes);}catch{html=r.bytes.toString('utf8');}
  const p=pageAssets(html,r.url),end=offset+25;
  return {url:r.url,title:p.title,text:p.text.slice(0,5000),images:p.images.slice(offset,end),links:p.links.slice(offset,end),totalImages:p.images.length,totalLinks:p.links.length,nextOffset:Math.max(p.images.length,p.links.length)>end?end:null};
}
export async function downloadWebImage(url:string,signal?:AbortSignal,reader:PublicReader=readPublic){
  // GitHub's blob page is HTML; resolve its explicit raw download URL for raster assets.
  if(typeof url!=='string'||!publicUrl(url))throw new FishError('WEB_PUBLIC_URL_REQUIRED');
  const u=new URL(url);
  if(u.hostname==='github.com'&&/^\/[^/]+\/[^/]+\/blob\/.+\.(png|jpe?g|gif|webp)$/i.test(u.pathname)){u.hostname='raw.githubusercontent.com';u.pathname=u.pathname.replace('/blob/','/');url=u.href;}
  const r=await reader(url,10485760,signal);
  if(/^(text\/|application\/(json|xhtml\+xml))/i.test(r.type))throw new FishError('WEB_IMAGE_EXPECTED');
  return r; // Existing bounded raster decoder validates actual bytes, dimensions and animation.
}
