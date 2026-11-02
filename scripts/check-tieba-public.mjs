#!/usr/bin/env node
// Read public forums/posts/comments only; no login, paid model calls or QQ sends.
import {browsePage} from '../dist/src/search/public-web.js';
const inputs=process.argv.slice(2);
if(!inputs.length){console.error('Usage: node scripts/check-tieba-public.mjs 吧名 [贴吧帖子/楼中楼URL ...]');process.exit(1);}
for(const input of inputs){
  const url=/^https?:\/\//.test(input)?input:'https://tieba.baidu.com/f?kw='+encodeURIComponent(input);
  const page=await browsePage(url);
  console.log(JSON.stringify({url:page.url,status:page.status,sourceUrl:page.sourceUrl,coverage:page.coverage,
    forum:page.forum,thread:page.thread,page:page.page,returned:page.returned,totalReported:page.totalReported,
    posts:page.posts?.slice(0,3),text:page.text.slice(0,500),imageCount:page.totalImages,nextPage:page.nextPage,
    unavailable:page.unavailable},null,2));
  if(page.status!=='content'||!page.coverage?.startsWith('forum_')&&!['thread_floors','floor_comments'].includes(page.coverage))process.exitCode=1;
}
