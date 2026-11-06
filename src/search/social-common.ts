import {Parser} from 'htmlparser2';
import type {PublicReader,PublicResource} from './public-web.js';
import {publicUrl} from './provider.js';
import {FishError,codeOf} from '../types.js';

export type SocialImage={url:string;kind:string;label:string;postId?:string};
export type SocialPost={id:string;url:string|null;author:{id?:string;name:string;handle?:string;url?:string|null};publishedAt:string|null;text:string;images:SocialImage[];parentId?:string|null;kind?:string;[key:string]:unknown};
export type SocialPage={url:string;sourceUrl:string;provider:string;coverage:string;title:string;status:string;fetchedAt:string;latestVerified:false;posts:SocialPost[];links:{url:string;label:string}[];nextPage:string|null;notice?:string;unavailable:{url:string;error:string}[];[key:string]:unknown};
export const str=(v:unknown)=>typeof v==='string'?v:'';
export const safeLink=(raw:unknown,base:string)=>{try{if(typeof raw!=='string'||!raw.trim())return null;const u=new URL(raw,base);return publicUrl(u.href)?u.href:null;}catch{return null;}};
export const timestamp=(value:unknown)=>{const ms=typeof value==='number'?value*1000:Date.parse(str(value));return Number.isFinite(ms)&&ms>0&&ms<=8640000000000000?new Date(ms).toISOString():null;};
export function htmlContent(html:string,base:string){
 let text='',skip=0;const images:SocialImage[]=[],links:{url:string;label:string}[]=[];
 const p=new Parser({onopentag(name,a){if(['script','style','template'].includes(name))skip++;if(skip)return;if(['p','div','br','li','blockquote'].includes(name))text+='\n';const url=safeLink(a.src??a.href,base);if(url&&name==='img')images.push({url,kind:'post_image',label:(a.alt??'').slice(0,200)});if(url&&name==='a')links.push({url,label:(a.title??url).slice(0,160)});},ontext(t){if(!skip&&text.length<200000)text+=t;},onclosetag(n){if(['script','style','template'].includes(n))skip=Math.max(0,skip-1);if(n==='p')text+='\n';}},{decodeEntities:true});p.end(html);
 return {text:text.trim().replace(/\n{3,}/g,'\n\n'),images,links};
}
// Short-lived public response cache: scrolling the same post/feed should not hit
// Reddit's rate limit again. Bounded memory, original retrieval time, no cookies.
const caches=new WeakMap<PublicReader,Map<string,{at:number;r:PublicResource}>>();
const inflight=new WeakMap<PublicReader,Map<string,Promise<PublicResource>>>();
export async function socialRead(reader:PublicReader,url:string,signal?:AbortSignal){
 signal?.throwIfAborted();let cache=caches.get(reader);if(!cache)caches.set(reader,cache=new Map());
 const now=Date.now();for(const [key,v] of cache)if(now-v.at>60000)cache.delete(key);
 const hit=cache.get(url);if(hit)return {...hit.r,cached:true};
 let pending=inflight.get(reader);if(!pending)inflight.set(reader,pending=new Map());
 // Do not share a cancellable request with another session.
 const key=signal?null:url;if(key&&pending.has(key))return pending.get(key)!;
 const request=reader(url,2097152,signal).then(r=>{const result={...r,fetchedAt:r.fetchedAt??new Date().toISOString()};cache!.set(url,{at:Date.now(),r:result});let bytes=[...cache!.values()].reduce((n,v)=>n+v.r.bytes.length,0);for(const [k,v] of cache!){if(cache!.size<=32&&bytes<=8*1024*1024)break;cache!.delete(k);bytes-=v.r.bytes.length;}return result;});
 if(key)pending.set(key,request);try{return await request;}finally{if(key)pending.delete(key);}
}
export async function socialJson(reader:PublicReader,url:string,signal?:AbortSignal){const r=await socialRead(reader,url,signal);let data:any;try{data=JSON.parse(r.bytes.toString('utf8'));}catch{throw new FishError('SOCIAL_RESPONSE_NOT_JSON');}return {r,data};}
export const failure=(url:string,e:unknown)=>({url,error:codeOf(e)});
export function unavailable(url:string,provider:string,failures:SocialPage['unavailable']):SocialPage{return {url,sourceUrl:url,provider,coverage:'none',title:provider,status:'unavailable',fetchedAt:new Date().toISOString(),latestVerified:false,posts:[],links:[],nextPage:null,unavailable:failures,notice:'这些公开入口未返回目标内容；可改用 search_web/fetch_page 或其他来源，错误见 unavailable。'};}
/** Page content once, with per-item identity/relationships alongside it. */
export function socialOutput(page:SocialPage,offset:number,textOffset:number,query:string){
 const terms=query.toLowerCase().split(/\s+/).filter(Boolean),all=page.posts.filter(p=>terms.every(t=>(p.text+' '+p.author.name+' '+p.id).toLowerCase().includes(t))),posts=all.slice(offset,offset+10);
 const text=posts.map(p=>{
  const by=p.repostedBy as {name?:string;handle?:string}|undefined;
  return '['+p.id+'] '+p.author.name+(p.author.handle?' @'+p.author.handle:'')+(p.publishedAt?' · '+p.publishedAt:'')+
   (p.parentId?' · 回复 '+p.parentId:'')+(p.kind==='quoted_post'?' · 被引用原帖':'')+(p.quotedPostId?' · 引用 '+p.quotedPostId:'')+
   (by?' · 转发人 '+(by.handle||by.name||'未知'):'')+(p.kind==='unavailable'?' · 不可用 '+String(p.unavailableReason??''):'')+'\n'+p.text;
 }).join('\n\n');
 const content=text.slice(textOffset,textOffset+5000),images=posts.flatMap(p=>p.images).slice(0,25);
 return {...page,posts:posts.map(({text,images,links,...p})=>({...p,characters:text.length,imageCount:images.length})),text:content,textOffset,nextTextOffset:textOffset+content.length<text.length?textOffset+content.length:null,
  images,imagesTruncated:posts.reduce((n,p)=>n+p.images.length,0)>images.length,links:[...page.links,...posts.filter(p=>p.url).map(p=>({url:p.url!,label:p.id+' · '+p.author.name})),...posts.flatMap(p=>Array.isArray(p.links)?p.links:[])].slice(0,30),totalPosts:all.length,totalImages:all.flatMap(p=>p.images).length,totalLinks:page.links.length+all.length,nextOffset:offset+10<all.length?offset+10:null};
}
