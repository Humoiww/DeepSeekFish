import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Config } from '../config.js';
import { Ledger } from '../budget/ledger.js';
import { FishError } from '../types.js';
import { boundedJson } from '../agent/model.js';

export interface SearchResult { title:string; url:string; snippet:string; summary?:string; date?:string|null; siteName?:string|null }
export interface FetchedPage {url:string;title:string;content:string;truncated:boolean;fetchedAt:string}
export interface SearchProvider { search(query:string):Promise<SearchResult[]>;fetch?(url:string):Promise<FetchedPage> }
/** No arbitrary URL fetching: only a fixed official API. IPv6 literals fail closed. */
export function publicUrl(raw:string): boolean {
  try {
    const u=new URL(raw),host=u.hostname.toLowerCase().replace(/\.$/,'');
    if (!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port&& !['80','443'].includes(u.port)) return false;
    if (!host.includes('.')||host.includes(':')||host.startsWith('[')||/\.(localhost|local|internal|lan|home|test|invalid)$/.test(host)) return false;
    if (isIP(host)) {
      const [a,b]=host.split('.').map(Number);
      return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a>=224||a===198&&[18,19].includes(b)||a===192&&b===0);
    }
    return /^[a-z0-9.-]+$/.test(host);
  } catch { return false; }
}
export class DeepSeekSearchProvider implements SearchProvider {
  constructor(private key:string, private cfg:()=>Config, private http:typeof fetch=fetch) {}
  async search(query:string):Promise<SearchResult[]> {
    if (!this.key) throw new FishError('DEEPSEEK_KEY_MISSING');
    const res=await this.http('https://api.deepseek.com/v1/tools/search',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(this.cfg().searchTimeoutMs),
      headers:{authorization:'Bearer '+this.key,'content-type':'application/json'},
      body:JSON.stringify({query,count:this.cfg().searchCount,need_content:false}),
    });
    if(!res.ok){await res.body?.cancel();throw new FishError('SEARCH_HTTP_'+res.status);}
    const data=await boundedJson(res);
    if(!Array.isArray(data.results))throw new FishError('SEARCH_INVALID_RESPONSE');
    return data.results.filter((r:any)=>typeof r.url==='string'&&publicUrl(r.url)).slice(0,this.cfg().searchCount).map((r:any)=>({
      title:String(r.title??'').slice(0,120),url:r.url.slice(0,8192),snippet:String(r.snippet??r.summary??'').slice(0,500),
      summary:String(r.summary??r.snippet??'').slice(0,1200),date:typeof r.date==='string'?r.date.slice(0,50):null,siteName:typeof r.site_name==='string'?r.site_name.slice(0,120):null,
    }));
  }
  async fetch(url:string):Promise<FetchedPage>{
    if(!this.key)throw new FishError('DEEPSEEK_KEY_MISSING');
    if(typeof url!=='string'||url.length>8192||!publicUrl(url))throw new FishError('FETCH_PUBLIC_URL_REQUIRED');
    const res=await this.http('https://api.deepseek.com/v1/tools/fetch',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(this.cfg().searchTimeoutMs),
      headers:{authorization:'Bearer '+this.key,'content-type':'application/json'},body:JSON.stringify({url}),
    });
    if(!res.ok){await res.body?.cancel();throw new FishError('FETCH_HTTP_'+res.status);}
    const data=await boundedJson(res);
    if(typeof data.title!=='string'||typeof data.content!=='string'||!data.content.trim())throw new FishError('FETCH_INVALID_RESPONSE');
    return {url,title:data.title.slice(0,200),content:data.content.slice(0,200000),truncated:data.content.length>200000,fetchedAt:new Date().toISOString()};
  }
}
export class MockSearchProvider implements SearchProvider {
  async search(query:string):Promise<SearchResult[]> { return [{title:'Mock 搜索：'+query,url:'https://example.com/mock',snippet:'这是离线测试结果。'}]; }
  async fetch(url:string):Promise<FetchedPage>{return {url,title:'Mock 网页',content:'这是离线网页正文。',truncated:false,fetchedAt:new Date().toISOString()};}
}
export class SearchService {
  private pending=new Map<string,Promise<unknown>>();
  constructor(private provider:SearchProvider,private ledger:Ledger,private cfg:()=>Config) {}
  async search(query:string,group:string,user:string):Promise<SearchResult[]> {
    if(!this.cfg().search)throw new FishError('SEARCH_DISABLED');
    if(typeof query!=='string')throw new FishError('SEARCH_QUERY_LENGTH');
    query=query.trim();
    if([...query].length<1||[...query].length>128)throw new FishError('SEARCH_QUERY_LENGTH');
    // A search query is text sent to the fixed API, not a URL fetched by this host.
    return this.cached<SearchResult[]>('search:'+query+'|'+this.cfg().searchCount,group,user,()=>this.provider.search(query));
  }
  async fetch(url:string,group:string,user:string,offset=0){
    if(!this.cfg().search)throw new FishError('SEARCH_DISABLED');
    if(typeof url!=='string'||url.length>8192||!publicUrl(url))throw new FishError('FETCH_PUBLIC_URL_REQUIRED');
    if(!Number.isSafeInteger(offset)||offset<0||offset>200000)throw new FishError('FETCH_OFFSET_INVALID');
    const normalized=new URL(url);normalized.hash='';url=normalized.href;
    if(!this.provider.fetch)throw new FishError('FETCH_UNAVAILABLE');
    const page=await this.cached<FetchedPage>('fetch:'+url,group,user,()=>this.provider.fetch!(url));
    const content=page.content.slice(offset,offset+6000),nextOffset=offset+content.length<page.content.length?offset+content.length:null;
    return {...page,content,offset,totalCharacters:page.content.length,nextOffset,truncated:nextOffset!==null||page.truncated};
  }
  private async cached<T>(identity:string,group:string,user:string,operation:()=>Promise<T>):Promise<T>{
    const key=createHash('sha256').update(identity).digest('hex');
    const cached=this.ledger.store.db.prepare('SELECT value FROM cache WHERE key=? AND expires>?').get(key,Date.now()) as any;
    if(cached)return JSON.parse(cached.value);
    const running=this.pending.get(key);if(running)return running as Promise<T>;
    const pending=(async()=>{
      const id=this.ledger.reserve('search',group,user);
      try{
        const result=await operation();
        this.ledger.store.db.prepare('INSERT OR REPLACE INTO cache VALUES (?,?,?)').run(key,Date.now()+600000,JSON.stringify(result));
        return result;
      }catch(e){this.ledger.error();throw e;}finally{this.ledger.settle(id);}
    })();
    this.pending.set(key,pending);try{return await pending;}finally{this.pending.delete(key);}
  }
}
