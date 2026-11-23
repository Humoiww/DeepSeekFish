import { publicUrl } from '../search/provider.js';

function sourceUrl(value:unknown):URL|null {
  if(typeof value!=='string'||value.length>8192||/[\s\\]/.test(value)||!publicUrl(value))return null;
  return new URL(value);
}

function isTracking(url:URL,key:string){
  if(/^utm_/i.test(key)||['gclid','dclid','fbclid','msclkid'].includes(key))return true;
  const host=url.hostname;
  if(/(^|\.)sohu\.com$/.test(host))return key==='scm'||key==='spm';
  if(/(^|\.)163\.com$/.test(host))return key==='spss';
  if(/(^|\.)zaobao\.com(?:\.sg)?$/.test(host))return key==='ref'&&url.searchParams.getAll(key).every(v=>v.startsWith('article-sidebar-'));
  if(/(^|\.)bilibili\.com$/.test(host))return key==='spm_id_from'||key==='vd_source';
  return false;
}

function sameArticle(original:URL,citation:URL){
  if(original.origin!==citation.origin||original.pathname!==citation.pathname||original.hash!==citation.hash)return false;
  // Only omissions are allowed. Keep every other parameter, including repeated
  // values, order and post/floor identifiers, even when a tracker is present.
  const kept=original.search.slice(1).split('&').filter(field=>{
    const key=field.split('=',1)[0];
    return citation.searchParams.has(key)||!isTracking(original,key);
  });
  return kept.join('&')===citation.search.slice(1);
}

type LinkedItem={url?:string|null;replyTarget?:string|null;kind?:string};
type NewsPage={url:string;status:string;posts?:LinkedItem[];links?:{url?:string|null}[];parentPost?:LinkedItem;thread?:LinkedItem|null};

/** The URLs returned by this research attempt, independent of chat history and context compaction. */
export class NewsSources {
  private originals=new Map<string,URL>();

  add(value:string|null|undefined){
    if(!value)return;
    const url=sourceUrl(value);
    if(url)this.originals.set(value,url);
  }

  page(page:NewsPage){
    if(page.status!=='content'&&page.status!=='partial')return;
    this.add(page.url);
    for(const post of [page.thread,page.parentPost,...(page.posts??[])]){
      if(!post||post.kind==='unavailable')continue;
      this.add(post.url);
      this.add(post.replyTarget);
    }
    for(const link of page.links??[])this.add(link.url);
  }

  check(values:unknown){
    const list=Array.isArray(values)?values:[];
    const entries=[...this.originals];
    const invalidSources:{index:number;value:unknown;reason:string}[]=[];
    const nearby=new Set<string>();
    for(const [i,value] of list.entries()){
      const url=sourceUrl(value);
      if(url&&(this.originals.has(value)||entries.some(([,original])=>sameArticle(original,url))))continue;
      invalidSources.push({index:i+1,value,reason:url?'与本次取得的来源链接不匹配':'需要完整的公开网页 URL'});
      if(url){
        const onSite=entries.filter(([,original])=>original.origin===url.origin);
        const closest=onSite.find(([,original])=>original.pathname===url.pathname)??onSite[0];
        if(closest)nearby.add(closest[0]);
      }
    }
    if(list.length>=1&&list.length<=4&&!invalidSources.length)return;
    const availableSources=[...new Set([...nearby,...this.originals.keys()])].slice(0,8);
    return {error:'DAILY_NEWS_SOURCES_REQUIRED',invalidSources,availableSources,
      message:[!Array.isArray(values)?'sources 应为链接数组。':list.length<1||list.length>4?`sources 收到 ${list.length} 条，需要 1～4 条。`:'',
        invalidSources.length?'列出的条目未匹配本次查到的来源，index 从 1 开始。':'',
        availableSources.length?'availableSources 是本轮实际返回的可用原链接，可选与正文对应的链接重新提交。':'本轮尚未取得可引用的来源链接。'].filter(Boolean).join('')};
  }
}
