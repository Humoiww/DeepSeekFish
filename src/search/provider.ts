import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Config } from '../config.js';
import { Ledger } from '../budget/ledger.js';
import { FishError } from '../types.js';
import { boundedJson } from '../agent/model.js';

export interface SearchResult { title:string; url:string; snippet:string }
export interface SearchProvider { search(query:string):Promise<SearchResult[]> }
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
      title:String(r.title??'').slice(0,120),url:r.url.slice(0,2048),snippet:String(r.snippet??r.summary??'').slice(0,500),
    }));
  }
}
export class MockSearchProvider implements SearchProvider {
  async search(query:string):Promise<SearchResult[]> { return [{title:'Mock 搜索：'+query,url:'https://example.com/mock',snippet:'这是离线测试结果。'}]; }
}
export class SearchService {
  private pending=new Map<string,Promise<SearchResult[]>>();
  constructor(private provider:SearchProvider,private ledger:Ledger,private cfg:()=>Config) {}
  async search(query:string,group:string,user:string):Promise<SearchResult[]> {
    if(!this.cfg().search)throw new FishError('SEARCH_DISABLED');
    query=query.trim();
    if([...query].length<1||[...query].length>128)throw new FishError('SEARCH_QUERY_LENGTH');
    // Reject explicit unsafe URLs; never interpret file paths or execute fetched content.
    if(/(?:file|ftp|gopher):|localhost|\b127\.|\b10\.\d|\b192\.168\.|\b169\.254\.|\b172\.(?:1[6-9]|2\d|3[01])\./i.test(query))throw new FishError('SEARCH_UNSAFE_QUERY');
    for(const url of query.match(/https?:\/\/[^\s]+/g)??[])if(!publicUrl(url))throw new FishError('SEARCH_UNSAFE_QUERY');
    const key=createHash('sha256').update(query+'|'+this.cfg().searchCount).digest('hex');
    const cached=this.ledger.store.db.prepare('SELECT value FROM cache WHERE key=? AND expires>?').get(key,Date.now()) as any;
    if(cached)return JSON.parse(cached.value);
    const running=this.pending.get(key);if(running)return running;
    const operation=(async()=>{
      const id=this.ledger.reserve('search',group,user);
      try{
        const results=await this.provider.search(query);
        this.ledger.store.db.prepare('INSERT OR REPLACE INTO cache VALUES (?,?,?)').run(key,Date.now()+600000,JSON.stringify(results));
        return results;
      }catch(e){this.ledger.error();throw e;}finally{this.ledger.settle(id);}
    })();
    this.pending.set(key,operation);try{return await operation;}finally{this.pending.delete(key);}
  }
}
