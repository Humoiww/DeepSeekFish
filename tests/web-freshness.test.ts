import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {browsePage} from '../src/search/public-web.js';
import {SearchService,searchEvidence,type SearchProvider} from '../src/search/provider.js';
import {FishError,type ChatMessage} from '../src/types.js';
import {inputBound,BudgetedModel} from '../src/agent/model.js';
import {knowledgeTokens} from '../src/memory/knowledge.js';
import {TokenBudgetError} from '../src/budget/ledger.js';

test('search timestamps survive caching; explicit refresh is charged once; index is not latest evidence',async()=>{
 const f=fixture({search:true,dailyTokens:100000,groupDailyTokens:100000});let searches=0,reads=0;
 const provider:SearchProvider={async search(){searches++;return [{title:'旧动态',url:'https://example.com/old',snippet:'旧文',date:'2026-04-29'}];},async fetch(url){reads++;return {url,title:'验证码',content:'',truncated:false,fetchedAt:'2026-11-01T00:00:00Z'};}};
 try{
  const service=new SearchService(provider,f.ledger,f.cfg),first=await service.search('动态','g','u');
  assert.ok(first[0].retrievedAt);assert.equal(searchEvidence(first).latestVerified,false);
  assert.deepEqual(await service.search('动态','g','u'),first);assert.equal(searches,1);
  await service.search('动态','g','u',true);assert.equal(searches,2);assert.equal(f.ledger.value('webTokens'),5000);
  assert.equal((await service.fetch('https://example.com','g','u')).status,'challenge');
  await service.fetch('https://example.com','g','u');assert.equal(reads,1);
  await service.fetch('https://example.com','g','u',0,true);assert.equal(reads,2);
 }finally{f.cleanup();}
});
test('public JSON retains non-image content; challenge pages are not article evidence',async()=>{
 const json=await browsePage('https://example.com/feed.json',0,undefined,async url=>({url,type:'application/json',bytes:Buffer.from(JSON.stringify({posts:[{id:'a',text:'今天的新动态',date:'2026-11-01'}]}))}));
 assert.match(json.text,/今天的新动态/);assert.equal(json.status,'content');
 const challenge=await browsePage('https://example.com',0,undefined,async url=>({url,type:'text/html',bytes:Buffer.from('<title>验证码_站点</title><div id="app"></div><script src="/app.js"></script>')}));
 assert.equal(challenge.status,'challenge');assert.equal(challenge.latestVerified,false);
 const shell=await browsePage('https://example.com',0,undefined,async url=>({url,type:'text/html',bytes:Buffer.from('<div id="app"></div><script src="/app.js"></script>')}));
 assert.equal(shell.status,'client_rendered');
});
test('Bilibili full-feed failure falls back to public opus with explicit partial coverage and pagination',async()=>{
 const urls:string[]=[];
 const page=await browsePage('https://space.bilibili.com/123/dynamic',0,undefined,async url=>{
  urls.push(url);if(!url.includes('/opus/'))throw new FishError('WEB_HTTP_412');
  return {url,type:'application/json',bytes:Buffer.from(JSON.stringify({code:0,data:{has_more:true,offset:'98',items:[{opus_id:'99',content:'新图文',pub_time:'',jump_url:'//www.bilibili.com/opus/99',cover:{url:'https://i0.hdslb.com/new.jpg'}}]}}))};
 });
 assert.equal(urls.length,2);assert.equal(page.status,'content');
 assert.ok('coverage' in page);assert.equal(page.coverage,'image_text_posts_only');assert.equal(page.latestVerified,false);
 assert.equal(page.posts[0].publishedAt,null);assert.equal(page.posts[0].url,'https://www.bilibili.com/opus/99');
 assert.equal(page.images[0].kind,'post_cover');assert.match(page.nextPage!,/offset=98/);assert.equal(page.unavailable[0].error,'WEB_HTTP_412');
 const blocked=await browsePage('https://space.bilibili.com/123/dynamic',0,undefined,async url=>({url,type:'application/json',bytes:Buffer.from('{"code":-352}') }));
 assert.equal(blocked.status,'unavailable');assert.deepEqual(blocked.images,[]);
});
test('Bilibili full feed retains pinned marker, source timestamps and video cover distinction',async()=>{
 const page=await browsePage('https://space.bilibili.com/123/dynamic',0,undefined,async url=>({url,type:'application/json',bytes:Buffer.from(JSON.stringify({code:0,data:{items:[{id_str:'99',type:'DYNAMIC_TYPE_AV',modules:{module_author:{pub_ts:1793491200},module_tag:{text:'置顶'},module_dynamic:{major:{archive:{title:'置顶视频',cover:'https://i0.hdslb.com/video.jpg'}}}}}],has_more:false}}))}));
 assert.ok('posts' in page);assert.equal(page.posts[0].pinned,true);assert.equal(page.posts[0].publishedAt,'2026-11-01T00:00:00.000Z');assert.equal(page.images[0].kind,'video_cover');
});
test('Chinese tool contexts fit remaining budget with official tokens, while actual usage and exhausted budget remain enforced',async()=>{
 const f=fixture({dailyTokens:1000000,groupDailyTokens:1000000,maxOutputTokens:256});
 const messages:ChatMessage[]=[{role:'user',content:'这是公开网页里的中文文字与图片描述。'.repeat(1800)}];
 const bound=inputBound(messages),actual=knowledgeTokens(messages[0].content as string);
 assert.ok(bound>actual);assert.ok(bound<Buffer.byteLength(JSON.stringify(messages))*.65);
 try{
  f.ledger.add('tokens',927529);f.ledger.add('tokens',927529,'g:g');let called=0;
  const provider={kind:'fixture',async complete(){called++;return {text:'收到',usage:{input:actual,output:2}};}};
  await new BudgetedModel(provider,f.ledger,f.cfg).call('g','u',messages);assert.equal(called,1);assert.equal(f.ledger.value('tokens'),927529+actual+2);assert.equal(f.store.getMeta('budgetFault'),undefined);
  f.set({dailyTokens:f.ledger.value('tokens')});
  assert.throws(()=>f.ledger.reserve('model','g','u',100,0),(e:any)=>e instanceof TokenBudgetError&&e.remaining===0&&e.notice.includes('00:00'));
 }finally{f.cleanup();}
});
