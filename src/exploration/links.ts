import type {Store} from '../storage/db.js';
import {publicUrl} from '../search/provider.js';

const tools=['browse_page','fetch_page','search_web','download_image'];
const rows=(value:unknown):any[]=>Array.isArray(value)?value:[];

/** Store only public result URLs. Search terms, tool arguments and
 * guesses in model text do not establish a discovery. */
function remember(store:Store,values:unknown[]){
 const put=store.db.prepare('INSERT OR IGNORE INTO exploration_public_links(url) VALUES (?)');
 const seen=new Set<string>();
 for(const value of values){
  if(typeof value!=='string'||value.length>8192||!publicUrl(value))continue;
  const address=new URL(value);
  if([...address.searchParams.keys()].some(key=>/^(?:auth|authorization|session|(?:access_|refresh_|id_)?token|skey|p_skey|rkey)$/i.test(key)))continue;
  const url=address.href;
  if(!seen.has(url)){seen.add(url);put.run(url);}
 }
}

export function rememberExplorationLinks(store:Store,tool:string,result:any){
 if(!tools.includes(tool)||!result||result.error)return;
 if(tool==='search_web'){remember(store,rows(result.results).map(item=>item?.url));return;}
 if(tool==='download_image'){
  const images:any[]=Array.isArray(result.images)?result.images:[result];
  remember(store,images.filter(item=>item?.saved===true).map(item=>item.image?.sourceUrl));return;
 }
 if(!['content','image','empty','partial'].includes(result.status)||result.access?.mode==='authenticated'||result.access?.mode==='login_required')return;
 remember(store,[result.url,result.nextPage,result.thread?.url,result.thread?.replyTarget,
  ...rows(result.links).map(item=>item?.url),...rows(result.images).map(item=>item?.url),
  ...rows(result.posts).flatMap(item=>[item?.url,item?.replyTarget,item?.commentsUrl])]);
}

export function importExplorationLinks(store:Store){
 const key='exploration:public-links-v1';if(store.getMeta(key))return;
 store.transaction(()=>{
  if(store.getMeta(key))return;
  const history=store.db.prepare("SELECT tool,data FROM exploration_observations WHERE tool IN ('browse_page','fetch_page','search_web','download_image')");
  for(const row of history.iterate()){
   let result:any;
   try{result=JSON.parse(String(row.data)).result;}catch{continue;}
   if(!result||result.error)continue;
   if(row.tool==='search_web')remember(store,rows(result.sources).map(item=>item?.url));
   else if(row.tool==='download_image')remember(store,rows(result.sources).filter(item=>item?.id).map(item=>item.url));
   else if(typeof result.excerpt==='string'&&result.excerpt.trim()||rows(result.sources).some(item=>item?.url))
    remember(store,[result.url,...rows(result.sources).map(item=>item?.url)]);
  }
  store.setMeta(key,'1');
 });
}
