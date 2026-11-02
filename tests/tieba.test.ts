import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import {browsePage,postPublic,type PublicPoster} from '../src/search/public-web.js';
import {tiebaPage} from '../src/search/tieba.js';

const user={id:12,name:'吧友',portrait:'https://example.com/avatar.jpg'};
const forum={id:7,name:'任意兴趣'};
const thread={id:'12345',title:'讨论',author:user,reply_num:100};
const fixture=(data:any):PublicPoster=>async url=>({url,type:'application/json',bytes:Buffer.from(JSON.stringify(data))});
const post={id:'56789',floor:2,time:1793626428,author_id:12,sub_post_number:5,content:[{type:0,text:'真实正文'},
 {type:3,origin_src:'https://example.com/original.gif',cdn_src:'https://example.com/thumbnail.jpg'},
 {type:1,text:'出处',link:'https://example.com/source'}]};

test('any chosen bar uses signed public read POST, preserves pinned threads and follows native pagination',async()=>{
 const read:PublicPoster=async(url,body)=>{
  assert.equal(url,'https://tiebac.baidu.com/c/f/frs/page');
  assert.equal(body.get('kw'),'任意兴趣');assert.equal(body.get('pn'),'2');assert.equal(body.get('sort_type'),'1');
  assert.equal(body.get('BDUSS'),null);assert.equal(body.get('STOKEN'),null);
  const p=Object.fromEntries(body),sign=p.sign;delete p.sign;
  assert.equal(sign,createHash('md5').update(Object.keys(p).sort().map(k=>k+'='+p[k]).join('')+'tiebaclient!!!').digest('hex'));
  return fixture({error_code:0,forum,user_list:[user],page:{current_page:2,total_page:3,has_more:1},thread_list:[
   {...thread,author:null,author_id:12,is_top:1,create_time:1700000000,first_post_content:[{type:0,text:'旧置顶'}]},
   {...thread,id:'12346',create_time:1793626428,first_post_content:[{type:0,text:'新讨论'}]},
  ]})(url,body);
 };
 const page=await tiebaPage('https://tieba.baidu.com/f?kw=任意兴趣&pn=50',read);
 assert.equal(page?.status,'content');assert.equal(page?.coverage,'forum_thread_previews');assert.equal(page?.latestVerified,false);
 assert.equal(page?.posts[0].pinned,true);assert.equal(page?.posts[0].author.name,'吧友');assert.equal(page?.posts[1].pinned,false);
 assert.match(page?.nextPage??'',/pn=100/);assert.match(page?.text??'',/新讨论/);assert.equal(page?.images.length,0);
});
test('thread text can be continued, images exclude avatars, floors link to correctly scoped nested comments',async()=>{
 const data={error_code:0,forum,thread,user_list:[user],post_list:[{...post,content:[{type:0,text:'长'.repeat(5100)},...post.content]}],page:{current_page:2,total_page:4,has_more:1}};
 const reader=async()=>{throw Error('should use the public mobile POST, not blocked HTML GET');};
 const page=await browsePage('https://tieba.baidu.com/p/12345?pn=2',0,undefined,reader,'',0,fixture(data));
 assert.equal(page.text.length,5000);assert.equal(page.nextTextOffset,5000);assert.ok('posts' in page);
 assert.equal(page.posts[0].id,'56789');assert.equal(page.posts[0].author.name,'吧友');assert.match(page.posts[0].url,/pn=2/);
 const comments=new URL(page.posts[0].commentsUrl);assert.equal(comments.searchParams.get('tid'),'12345');assert.equal(comments.searchParams.get('pid'),'56789');
 assert.equal(page.images.length,1);assert.equal(page.images[0].url,'https://example.com/original.gif');assert.match(page.nextPage!,/pn=3/);
 const rest=await browsePage(page.url,0,undefined,reader,'',5000,fixture(data));assert.match(rest.text,/真实正文/);assert.equal(rest.nextTextOffset,null);
});
test('nested comments retain parent, authors and times without claiming missing comments were read',async()=>{
 const data={error_code:0,forum,thread,post:{...post,author:user},subpost_num:5,page:{current_page:1,total_page:2,total_count:5},
  subpost_list:[{id:'67890',author:{id:13,name_show:'另一吧友'},time:1793626429,content:[{type:0,text:'回复：不同观点'}]}]};
 const page=await tiebaPage('https://tieba.baidu.com/p/comment?tid=12345&pid=56789',async(url,body)=>{
  assert.equal(url,'https://tiebac.baidu.com/c/f/pb/floor');assert.equal(body.get('kz'),'12345');assert.equal(body.get('pid'),'56789');return fixture(data)(url,body);
 });
 assert.equal(page?.coverage,'floor_comments');assert.equal(page?.posts[0].parentPostId,'56789');assert.equal(page?.posts[0].author.name,'另一吧友');
 assert.match(page?.text??'',/父楼 56789.*吧友：真实正文/);assert.match(page?.text??'',/不同观点/);
 assert.ok(page&&'returned' in page);assert.equal(page.returned,1);assert.equal(page.totalReported,5);assert.match(page.nextPage!,/pn=2/);
 const wrong=await tiebaPage('https://tieba.baidu.com/p/comment?tid=12345&pid=999',fixture(data));assert.equal(wrong?.status,'unavailable');assert.match(wrong!.unavailable[0].error,/PARENT_POST_MISMATCH/);
});
test('malformed or denied public data is an unavailable result, never a synthetic successful read',async()=>{
 for(const data of [{error_code:4},{error_code:0,forum:{id:8,name:'另一个吧'},thread_list:[]},{error_code:0,forum}]){
  const page=await tiebaPage('https://tieba.baidu.com/f?kw=任意兴趣',fixture(data));assert.equal(page?.status,'unavailable');assert.equal(page?.text,'');assert.equal(page?.latestVerified,false);
 }
 const challenge=await tiebaPage('https://tieba.baidu.com/p/12345',async url=>({url,type:'text/html',bytes:Buffer.from('验证码')}));assert.match(challenge!.unavailable[0].error,/NOT_JSON/);
 await assert.rejects(tiebaPage('https://tieba.baidu.com/p/12345?pn=-1',fixture({})),/PAGE_INVALID/);
 assert.equal(await tiebaPage('https://tieba.baidu.com.evil.example/p/12345',async()=>{throw Error('unexpected');}),undefined);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(tiebaPage('https://tieba.baidu.com/p/12345',async()=>{throw cancelled.signal.reason;},cancelled.signal));
});
test('public mobile POST retains DNS pinning and certificate verification, refuses arbitrary targets and redirects',async t=>{
 let privateDns=false,requests=0;
 t.mock.method(dns,'lookup',async()=>[{address:privateDns?'100.64.0.1':'1.1.1.1',family:4}]);
 t.mock.method(https,'request',(url:URL,options:any,callback:any)=>{
  requests++;assert.equal(options.method,'POST');assert.equal(options.maxVersion,'TLSv1.2');assert.notEqual(options.rejectUnauthorized,false);
  assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);assert.equal(options.agent,false);
  options.lookup(url.hostname,{all:true},(err:any,addresses:any)=>{assert.equal(err,null);assert.deepEqual(addresses,[{address:'1.1.1.1',family:4}]);});
  const req=new EventEmitter() as any;req.end=(body:Buffer)=>{
   assert.equal(body.toString(),'kw=test');const res=new EventEmitter() as any;res.statusCode=302;res.headers={location:'https://other.example/'};res.destroy=()=>{};queueMicrotask(()=>callback(res));
  };return req;
 });
 const body=new URLSearchParams({kw:'test'});
 for(const url of ['https://example.com/c/f/frs/page','https://tiebac.baidu.com/c/c/thread/add','https://tiebac.baidu.com/c/f/frs/page?extra=x'])assert.throws(()=>postPublic(url,body),/TARGET_DENIED/);
 assert.equal(requests,0);await assert.rejects(postPublic('https://tiebac.baidu.com/c/f/frs/page',body),/POST_REDIRECT_REJECTED/);assert.equal(requests,1);
 privateDns=true;await assert.rejects(postPublic('https://tiebac.baidu.com/c/f/frs/page',body),/PRIVATE_ADDRESS/);assert.equal(requests,1);
});
