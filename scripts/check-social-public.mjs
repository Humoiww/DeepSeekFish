// Free public reads only. Supply URLs; no model, QQ send or production data writes.
import {browsePage,readPublic} from '../dist/src/search/public-web.js';
const urls=process.argv.slice(2);
if(!urls.length){console.error('Usage: node scripts/check-social-public.mjs https://x.com/user/status/ID https://www.reddit.com/r/SUB/comments/ID/');process.exitCode=2;}
for(const url of urls){
 const requests=[];
 try{
  const page=await browsePage(url,0,AbortSignal.timeout(90000),async(...args)=>{requests.push(args[0]);return readPublic(...args);});
  console.log(JSON.stringify({url,status:page.status,provider:page.provider,coverage:page.coverage,fetchedAt:page.fetchedAt,posts:page.totalPosts,excerpt:page.text.slice(0,400),images:page.totalImages,nextOffset:page.nextOffset,nextPage:page.nextPage,commentsUrl:page.commentsUrl,unavailable:page.unavailable,requests},null,2));
  if(page.status!=='content'&&page.status!=='empty')process.exitCode=1;
 }catch(e){console.log(JSON.stringify({url,error:e.message,requests}));process.exitCode=1;}
}
