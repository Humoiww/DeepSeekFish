#!/usr/bin/env node
// Public reads only: no login, account cookies, QQ messages or paid model calls.
import {browsePage} from '../dist/src/search/public-web.js';
const ids=process.argv.slice(2);
if(!ids.length||ids.some(id=>!/^\d{1,20}$/.test(id))){console.error('Usage: node scripts/check-bilibili-public.mjs UID [UID ...]');process.exit(1);}
for(const uid of ids){
  const page=await browsePage('https://space.bilibili.com/'+uid+'/dynamic');
  console.log(JSON.stringify({uid,status:page.status,sourceUrl:page.sourceUrl,coverage:page.coverage,totalPosts:page.totalPosts,
    latestOnPage:page.latestOnPage,posts:page.posts?.slice(0,3).map(p=>({id:p.id,author:p.author,pinned:p.pinned,type:p.type,publishedAt:p.publishedAt,content:p.content.slice(0,180),images:p.images})),nextPage:page.nextPage},null,2));
  if(page.status!=='content'||page.coverage!=='space_dynamics'||!page.latestOnPage)process.exitCode=1;
}
