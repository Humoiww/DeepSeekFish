import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browsePage,type PublicReader} from '../src/search/public-web.js';
import {socialRead,timestamp} from '../src/search/social-common.js';
import {parseFeed} from '../src/search/feeds.js';
import {FishError} from '../src/types.js';
import {fixture} from './helpers.js';
import {createWebApp} from '../src/web/app.js';
const json=(url:string,data:any)=>({url,type:'application/json',bytes:Buffer.from(JSON.stringify(data))});
const xml=(url:string,body:string)=>({url,type:'application/atom+xml',bytes:Buffer.from(body)});
const tweet=(id='20',extra:any={})=>({id,type:'status',url:'https://x.com/alice/status/'+id,text:'A public post',author:{id:'1',name:'Alice',screen_name:'alice',avatar_url:'https://images.example.com/avatar.jpg'},created_timestamp:1793491200,media:{photos:[{url:'https://images.example.com/post.jpg'}]},...extra});
const atom=`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Community</title><icon>https://example.com/avatar.png</icon><entry><id>t3_abc</id><title>A question</title><author><name>/u/Alice</name><uri>https://www.reddit.com/user/Alice</uri></author><published>2026-11-01T00:00:00Z</published><link href="https://www.reddit.com/r/test/comments/abc/question/"/><content type="html">&lt;p&gt;Post body &amp;amp; details&lt;/p&gt;&lt;img src="https://example.com/photo.jpg"/&gt;</content></entry><entry><id>t1_def</id><author><name>/u/Bob</name></author><link href="https://www.reddit.com/r/test/comments/abc/question/def/"/><content type="html">&lt;p&gt;I disagree&lt;/p&gt;</content></entry></feed>`;

test('X preserves actual authors, quotes, reply parents and media, exposes cursors without choosing to follow',async()=>{
 const calls:string[]=[];const reader:PublicReader=async url=>{calls.push(url);return json(url,{code:200,status:tweet(),thread:[tweet()],replies:[tweet('21',{replying_to:{status:'20',screen_name:'alice'},quote:tweet('19',{author:{id:'2',name:'Bob'},text:'quoted text'}),media:{videos:[{url:'https://example.com/movie.mp4',thumbnail_url:'https://example.com/video.jpg'}]}})],cursor:{bottom:'abc=def'}});};
 const p=await browsePage('https://api.fxtwitter.com/2/conversation/20',0,undefined,reader);
 assert.equal(calls.length,1);assert.ok('posts' in p);assert.equal(p.posts.length,3);assert.equal(p.posts[1].parentId,'20');assert.equal(p.posts[1].quotedPostId,'19');assert.equal(p.posts[2].author.name,'Bob');assert.equal(p.posts[2].kind,'quoted_post');assert.equal(p.images[1].kind,'video_cover');assert.ok(!p.images.some((i:any)=>i.url.includes('avatar')));assert.equal(p.latestVerified,false);assert.match(p.nextPage!,/cursor=abc%3Ddef/);assert.match(p.text,/quoted text/);
});
test('X profile/search, thread continuation and unavailable posts retain identity and coverage',async()=>{
 const urls:string[]=[];const reader:PublicReader=async url=>{urls.push(url);return json(url,{code:200,results:[tweet('55',{reposted_by:{id:'3',screen_name:'carol'}}),{type:'thread',statuses:[tweet('56')]},{type:'tombstone',id:'57',reason:'deleted'}],cursor:{bottom:'next'}});};
 const p=await browsePage('https://twitter.com/carol',0,undefined,reader);assert.ok('posts' in p);assert.equal(p.posts[0].author.name,'Alice');assert.equal((p.posts[0].repostedBy as any).handle,'carol');assert.equal(p.posts[2].kind,'unavailable');assert.equal(p.posts[2].unavailableReason,'deleted');assert.equal(p.posts[2].publishedAt,null);
 await browsePage(p.nextPage!,0,undefined,reader);assert.match(urls[1],/cursor=next/);
 await browsePage('https://x.com/search?q=cats&f=live',0,undefined,reader);assert.match(urls[2],/q=cats&feed=latest/);
});
test('X fallback uses official embed; wrong post, denial and cancellation never become fabricated content',async()=>{
 const r:PublicReader=async url=>url.includes('oembed')?json(url,{url:'https://twitter.com/alice/status/20',author_name:'Alice',html:'<blockquote><p>embed text</p></blockquote>'}):json(url,{code:200,status:tweet('999')});
 const p=await browsePage('https://x.com/alice/status/20',0,undefined,r);assert.ok('coverage' in p);assert.equal(p.coverage,'embedded_post_only');assert.equal(p.unavailable[0].error,'TWITTER_POST_ID_MISMATCH');assert.match(p.text,/embed text/);
 let n=0;const abort=new AbortController();await assert.rejects(browsePage('https://x.com/alice/status/20',0,abort.signal,async()=>{n++;abort.abort();throw new Error('cancel');}));assert.equal(n,1);
 const blocked=await browsePage('https://x.com/alice/status/20',0,undefined,async()=>{throw new FishError('WEB_HTTP_403');});assert.equal(blocked.status,'unavailable');assert.equal(blocked.text,'');assert.equal(blocked.images.length,0);
});
test('Reddit RSS returns post and comments, never avatar or fabricated parentage; JSON 403 falls back',async()=>{
 const calls:string[]=[];const p=await browsePage('https://old.reddit.com/r/test/comments/abc/.json',0,undefined,async url=>{calls.push(url);if(url.includes('.json'))throw new FishError('WEB_HTTP_403');return xml(url,atom);});
 assert.ok('posts' in p);assert.equal(calls.length,2);assert.equal(p.coverage,'post_and_flat_comment_feed');assert.equal(p.posts[0].id,'t3_abc');assert.equal(p.posts[1].kind,'comment');assert.equal(p.posts[1].parentId,undefined);assert.match(p.text,/A question\nPost body & details/);assert.match(p.text,/I disagree/);assert.equal(p.images.length,1);assert.equal(p.images[0].url,'https://example.com/photo.jpg');assert.equal(p.unavailable[0].error,'WEB_HTTP_403');assert.equal(p.posts[0].publishedAt,'2026-11-01T00:00:00.000Z');
 const wrong=await browsePage('https://www.reddit.com/comments/wrong/',0,undefined,async url=>xml(url,atom));assert.equal(wrong.status,'unavailable');
 const missing=await browsePage('https://www.reddit.com/r/test/comments/abc/question/missing/',0,undefined,async url=>xml(url,atom));assert.equal(missing.status,'unavailable');
});
test('Reddit pagination remains explicit; native JSON keeps nested comment parent IDs',async()=>{
 const requests:string[]=[];const reader:PublicReader=async url=>{requests.push(url);return xml(url,atom.replace(/<entry><id>t1_def<\/id>[\s\S]*?<\/entry>/,''));};
 const feed=await browsePage('https://www.reddit.com/r/test/new/',0,undefined,reader);assert.ok('nextPage' in feed);assert.match(feed.nextPage!,/after=t3_abc/);assert.equal(requests.length,1);await browsePage(feed.nextPage!,0,undefined,reader);assert.equal(requests.length,2);
 const listing=(children:any[])=>({kind:'Listing',data:{children}}),comment=(id:string,parent:string,replies?:any)=>({kind:'t1',data:{id,name:'t1_'+id,parent_id:parent,author:'reader',body:'comment '+id,permalink:'/r/test/comments/abc/question/'+id+'/',replies}});
 const p=await browsePage('https://www.reddit.com/comments/abc/.json',0,undefined,async url=>json(url,[listing([{kind:'t3',data:{id:'abc',name:'t3_abc',title:'Title',selftext:'root',author:'writer',permalink:'/comments/abc/'}}]),listing([comment('one','t3_abc',listing([comment('two','t1_one')]))])]));
 assert.ok('posts' in p);assert.equal(p.posts.length,3);assert.equal(p.posts[2].parentId,'t1_one');assert.match(p.text,/comment two/);
});
test('Reddit official embed fallback identifies target body, not login HTML or another post',async()=>{
 const tracking=JSON.stringify({post:{id:'t3_abc',url:'https://www.reddit.com/comments/abc/'}}).replaceAll('"','&quot;');
 const html='<a href="https://www.reddit.com/user/Alice/">Alice</a><faceplate-timeago ts="2026-11-01T00:00:00Z"></faceplate-timeago><faceplate-tracker data-faceplate-tracking-context="'+tracking+'"><shreddit-embed-title>Question</shreddit-embed-title></faceplate-tracker><div id="t3_abc-post-rtjson-content"><p>Real body</p></div><div>unrelated footer</div>';
 const p=await browsePage('https://redd.it/abc',0,undefined,async url=>{if(!url.includes('embed.'))throw new FishError('WEB_HTTP_429');return {url,type:'text/html',bytes:Buffer.from(html)};});
 assert.ok('coverage' in p);assert.equal(p.coverage,'embedded_post_only');assert.match(p.text,/Question\nReal body/);assert.ok(!p.text.includes('footer'));assert.equal(p.posts[0].author.name,'Alice');assert.equal(p.unavailable.length,2);
 const blocked=await browsePage('https://redd.it/abc',0,undefined,async url=>({url,type:'text/html',bytes:Buffer.from('<title>Sign in</title>')}));assert.equal(blocked.status,'unavailable');
});
test('Bluesky resolves handles to DID and preserves reply/quote authors; model opens next post itself',async()=>{
 const calls:string[]=[];const bpost=(did:string,key:string,text:string,extra:any={})=>({uri:'at://'+did+'/app.bsky.feed.post/'+key,author:{did,handle:did==='did:plc:alice'?'alice.test':'bob.test',displayName:did},record:{text,createdAt:'2026-11-01T00:00:00Z',...extra}});
 const reader:PublicReader=async url=>{calls.push(url);if(url.includes('resolveHandle'))return json(url,{did:'did:plc:alice'});return json(url,{thread:{post:{...bpost('did:plc:alice','abc','original'),embed:{images:[{fullsize:'https://example.com/photo.jpg',alt:'image'}]}},replies:[{post:bpost('did:plc:bob','def','reply',{reply:{parent:{uri:'at://did:plc:alice/app.bsky.feed.post/abc'}}})}]}});};
 const p=await browsePage('https://bsky.app/profile/alice.test/post/abc',0,undefined,reader);assert.ok('posts' in p);assert.equal(calls.length,2);assert.match(decodeURIComponent(calls[1]),/uri=at:\/\/did:plc:alice/);assert.equal(p.posts[1].author.handle,'bob.test');assert.equal(p.posts[1].parentId,'at://did:plc:alice/app.bsky.feed.post/abc');assert.equal(p.images[0].kind,'post_image');
 const different=await browsePage('https://bsky.app/profile/alice.test/post/wrong',0,undefined,reader);assert.equal(different.status,'unavailable');
});
test('Mastodon arbitrary public instance supports posts, replies and original media without author avatars',async()=>{
 const calls:string[]=[];const status=(id:string,parent:string|null=null)=>({id,url:'https://social.example.com/@user/'+id,created_at:'2026-11-01T00:00:00Z',account:{id:'user1',acct:'user',avatar:'https://example.com/avatar.jpg'},content:'<p>Hello <a href="https://example.com/a">link</a></p>',in_reply_to_id:parent,media_attachments:[{type:'image',url:'https://example.com/original.jpg',preview_url:'https://example.com/thumb.jpg'}]});
 const reader:PublicReader=async url=>{calls.push(url);return json(url,url.endsWith('/context')?{ancestors:[],descendants:[status('124','123')]}:status('123'));};
 const p=await browsePage('https://social.example.com/@user/123',0,undefined,reader);assert.ok('commentsUrl' in p);assert.equal(p.images.length,1);assert.equal(p.images[0].url,'https://example.com/original.jpg');assert.equal(calls.length,1);
 const replies=await browsePage(String(p.commentsUrl),0,undefined,reader);assert.ok('posts' in replies);assert.equal(replies.posts[0].parentId,'123');assert.equal(calls.length,2);
});
test('RSS/Atom public feeds and discovery work without executing XML entities; text stays paginated',async()=>{
 const p=await browsePage('https://example.com/feed.xml',0,undefined,async url=>xml(url,atom));assert.ok('provider' in p);assert.equal(p.provider,'RSS/Atom');assert.match(p.text,/A question/);
 assert.equal(parseFeed('<html>login</html>','https://example.com'),undefined);
 const malicious='<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss><channel><title>Test</title><item><guid>x</guid><description>&secret;</description></item></channel></rss>';
 const feed=parseFeed(malicious,'https://example.com');assert.ok(feed);assert.ok(!feed.posts[0].text.includes('root:'));assert.equal(timestamp(Number.MAX_VALUE),null);
 const ordinary=await browsePage('https://any-public-site.example.com',0,undefined,async url=>({url,type:'text/html',bytes:Buffer.from('<title>Independent website</title><article>Content</article><link rel="alternate" type="application/rss+xml" href="/rss"/>')}));assert.equal(ordinary.status,'content');assert.ok(ordinary.links.some(l=>l.url==='https://any-public-site.example.com/rss'));
 const long=await browsePage('https://x.com/alice/status/20',0,undefined,async url=>json(url,{code:200,status:tweet('20',{text:'abc'.repeat(4000)})}));assert.equal(long.text.length,5000);assert.equal(long.nextTextOffset,5000);
});
test('social response cache is bounded, cancellable, deduplicated and preserves original fetch time',async()=>{
 let calls=0;const reader:PublicReader=async url=>{calls++;return {...json(url,{ok:true}),fetchedAt:'2026-11-01T00:00:00Z'};};
 await Promise.all([socialRead(reader,'https://example.com/1'),socialRead(reader,'https://example.com/1')]);assert.equal(calls,1);
 const hit=await socialRead(reader,'https://example.com/1');assert.equal(hit.cached,true);assert.equal(hit.fetchedAt,'2026-11-01T00:00:00Z');
 for(let i=2;i<=34;i++)await socialRead(reader,'https://example.com/'+i);await socialRead(reader,'https://example.com/1');assert.equal(calls,35);
 await assert.rejects(socialRead(reader,'https://example.com/1',AbortSignal.abort()));assert.equal(calls,35);
});
test('WebUI offers unified browsing only with search enabled, executes model-selected read and logs native tool result',async()=>{
 const f=fixture();let count=0;const payloads:any[]=[],reads:string[]=[];
 const http=(async(_url:any,options:any)=>{const body=JSON.parse(options.body);payloads.push(body);count++;return new Response(JSON.stringify({choices:[{message:count===1?{content:'',tool_calls:[{id:'read1',type:'function',function:{name:'browse_page',arguments:JSON.stringify({url:'https://x.com/alice/status/20'})}}]}:{content:'Read it'}}],usage:{prompt_tokens:20,completion_tokens:10}}));}) as typeof fetch;
 const app=createWebApp(f.root,false,http,undefined,undefined,async url=>{reads.push(url);return json(url,{code:200,status:tweet()});});
 try{
  app.configure({apiKey:'fixture-key',search:true});const session=app.createSession();await app.chat(session.id,'Read this post','agent',new AbortController().signal,()=>{});
  assert.equal(payloads[0].tool_choice,'auto');assert.ok(payloads[0].tools.some((t:any)=>t.function.name==='browse_page'));assert.equal(reads.length,1);assert.equal(payloads[1].messages.at(-1).role,'tool');assert.equal(payloads[1].messages.at(-1).tool_call_id,'read1');assert.match(payloads[1].messages.at(-1).content,/A public post/);
  const turn=app.detail(session.id).turns[0];assert.equal(turn.state,'completed');assert.ok(turn.trace.some((t:any)=>t.name==='browse_page'&&t.state==='completed'));assert.equal(app.status().web.requests,0);
  app.configure({search:false});await app.chat(session.id,'Hi','agent',new AbortController().signal,()=>{});assert.ok(!payloads.at(-1).tools.some((t:any)=>t.function.name==='browse_page'));assert.equal(reads.length,1);
 }finally{await app.close();f.cleanup();}
});

test('Reddit native failure can read a clearly dated archive without claiming current/latest or hot ranking',async()=>{
 const calls:string[]=[];const reader:PublicReader=async url=>{calls.push(url);if(!url.includes('arctic-shift'))throw new FishError('WEB_HTTP_429');return json(url,{data:[{id:'abc',author:'Alice',title:'Archived title',selftext:'Old body',permalink:'/r/test/comments/abc/',created_utc:1793491200,retrieved_on:1793577600}]});};
 const p=await browsePage('https://www.reddit.com/r/test/hot/',0,undefined,reader);assert.ok('posts' in p);assert.equal(calls.length,3);assert.equal(p.status,'content');assert.equal(p.coverage,'archived_posts');assert.equal(p.latestVerified,false);assert.equal(p.posts[0].publishedAt,'2026-11-01T00:00:00.000Z');assert.equal(p.posts[0].archivedAt,'2026-11-02T00:00:00.000Z');assert.match(p.notice!,/归档/);assert.match(p.nextPage!,/before=1793491200/);assert.equal(p.unavailable.length,2);
 const q=await browsePage(p.nextPage!,0,undefined,reader);assert.ok('posts' in q);assert.equal(calls.length,4);
});
test('social provenance survives QQ context compaction and all identity details remain recoverable',async()=>{
 const {TurnContext}=await import('../src/agent/context.js');
 const p=await browsePage('https://x.com/carol',0,undefined,async url=>json(url,{code:200,results:[tweet('20',{reposted_by:{screen_name:'carol'},quote:tweet('19',{author:{name:'Bob'}})})]}));
 const context=new TurnContext(),m=context.result('browse_page','social',p,0);context.compact(1);const view=JSON.parse(String(m.content));
 assert.match(view.provider,/FxEmbed/);assert.equal(view.latestVerified,false);assert.match(view.text,/Alice @alice/);assert.match(view.text,/转发人 carol/);assert.match(view.text,/被引用原帖/);assert.equal(view.totalPosts,2);
 const details=context.read({resultId:'social',section:'posts'}) as any;assert.equal(details.items[0].author.id,'1');assert.equal(details.items[1].author.name,'Bob');
});
