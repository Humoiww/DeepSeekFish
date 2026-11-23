import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import {runInNewContext} from 'node:vm';
import {browsePage,postPublic,type PublicPoster} from '../src/search/public-web.js';
import {tiebaPage,tiebaTarget} from '../src/search/tieba.js';
import {publishInput,publishSectionFeedback,postingRequest} from '../src/tieba/posting.js';
import {TiebaBrowser,preSubmitStalled} from '../src/capture/tieba-browser.js';
import {WebPostGate} from '../src/tieba/web-post.js';

const user={id:12,name:'吧友',portrait:'https://example.com/avatar.jpg'};
const forum={id:7,name:'任意兴趣'};
const thread={id:'12345',title:'讨论',author:user,reply_num:100};
const fixture=(data:any):PublicPoster=>async url=>({url,type:'application/json',bytes:Buffer.from(JSON.stringify(data))});
const post={id:'56789',floor:2,time:1793626428,author_id:12,sub_post_number:5,content:[{type:0,text:'真实正文'},
 {type:3,origin_src:'https://example.com/original.gif',cdn_src:'https://example.com/thumbnail.jpg'},
 {type:1,text:'出处',link:'https://example.com/source'}]};

test('native pre-submit deadline requires zero dispatched writes and bounded preflight idle/total time',()=>{
 const started=100000;
 assert.equal(preSubmitStalled(0,started,started,started+34999),false);
 assert.equal(preSubmitStalled(0,started,started+10001,started+35000),false);
 assert.equal(preSubmitStalled(0,started,started+10000,started+35000),true);
 assert.equal(preSubmitStalled(0,started,started+44999,started+45000),true);
 for(const writes of [1,2])for(const elapsed of [35000,45000,239999,300000])assert.equal(preSubmitStalled(writes,started,started,started+elapsed),false);
});

test('a stalled native submit disarms before evidence and returns a confirmed not-submitted receipt',async t=>{
 let now=100000;t.mock.method(Date,'now',()=>now);
 const browser:any=Object.create(TiebaBrowser.prototype),plan={...postingRequest({action:'reply',forumId:'7',threadId:'12345',content:'离线回复'},{id:'7',name:'测试吧'},'official_web'),traceId:'offline-stall'};
 browser.webGate=new WebPostGate(plan,()=>{});browser.lifetime=new AbortController();browser.shots=[];
 browser.blockedOrigins=new Set(['https://blocked.example']);browser.pageFailures=[{status:403}];
 browser.nativeSubmitView=async()=>{
  if(browser.nativeSubmit?.phase==='wait_native_publish_request')now+=20000;
  return {button:'发表',loading:true,notices:[],challenge:false};
 };
 browser.clickElement=async()=>{now+=45000;};
 browser.captureEvidence=async(stage:string)=>{
  if(stage==='pre_submit_stalled')assert.equal(browser.webGate.armed,false);
  browser.shots.push({id:stage,stage,at:now});
 };
 let writes=0,outcome:any;
 await assert.rejects(browser.submitWebPost(()=>writes++,(value:any)=>{outcome=value;}),(error:any)=>{
  assert.equal(error.message,'TIEBA_WEB_PRE_SUBMIT_FAILED');assert.equal(error.receipt.reason,'pre_submit_stalled');
  assert.equal(error.receipt.notSubmitted,true);assert.equal(error.receipt.accepted,false);assert.equal(error.receipt.httpAttempts,0);
  assert.deepEqual(error.receipt.blockedOrigins,['https://blocked.example']);assert.deepEqual(error.receipt.pageFailures,[{status:403}]);
  assert.ok(error.receipt.evidence.some((shot:any)=>shot.stage==='pre_submit_stalled'));return true;
 });
 assert.equal(writes,0);assert.equal(browser.webGate.armed,false);assert.equal(outcome.receipt.notSubmitted,true);
 assert.ok(!browser.shots.some((shot:any)=>shot.stage==='waiting'),'a terminal outcome skips the same-iteration waiting screenshot');
});

test('dispatched native publication ignores the pre-submit deadline and waits for its platform receipt',async t=>{
 let now=100000;t.mock.method(Date,'now',()=>now);
 const browser:any=Object.create(TiebaBrowser.prototype),plan={...postingRequest({action:'reply',forumId:'7',threadId:'12345',content:'离线回复'},{id:'7',name:'测试吧'},'official_web'),traceId:'offline-dispatched'};
 browser.webGate=new WebPostGate(plan,()=>{});browser.shots=[];browser.blockedOrigins=new Set();browser.pageFailures=[];
 browser.lifetime={signal:{aborted:false,throwIfAborted(){now+=20000;}}};
 let views=0,writes=0;
 browser.nativeSubmitView=async()=>{views++;return {button:'发表',loading:true,notices:views>1?['请完成安全验证']:[],challenge:views>1};};
 browser.clickElement=async()=>{
  assert.equal(browser.webGate.allow({request:{url:plan.url,method:'POST',headers:{},postData:new URLSearchParams(plan.fields).toString()}}),true);
  now+=60000;
 };
 browser.captureEvidence=async(stage:string)=>{
  assert.notEqual(stage,'pre_submit_stalled');browser.shots.push({id:stage,stage,at:now});
  if(stage==='waiting')browser.webReceived({id:'67890',receipt:{accepted:true,httpStatus:200}});
 };
 const result=await browser.submitWebPost(()=>writes++,()=>{});
 assert.equal(result.id,'67890');assert.equal(result.receipt.httpAttempts,1);assert.equal(result.receipt.notSubmitted,undefined);
 assert.equal(views,1);assert.equal(writes,1);
});

test('native verification, login and restriction notices finish only before dispatch',async()=>{
 for(const [notice,challenge,code] of [['请完成滑块验证',true,'TIEBA_PUBLICATION_CHALLENGE'],['请先登录后回复',false,'TIEBA_LOGIN_REQUIRED'],['操作过于频繁，请稍后再试',false,'TIEBA_WEB_PRE_SUBMIT_FAILED']] as const){
  const browser:any=Object.create(TiebaBrowser.prototype),plan=postingRequest({action:'reply',forumId:'7',threadId:'12345',content:'离线回复'},{id:'7',name:'测试吧'},'official_web');
  browser.webGate=new WebPostGate(plan,()=>{});browser.lifetime=new AbortController();browser.shots=[];
  browser.blockedOrigins=new Set();browser.pageFailures=[];browser.clickElement=async()=>{};browser.captureEvidence=async()=>{};
  let clicked=false;browser.nativeSubmitView=async()=>{const page={button:'发表',loading:false,notices:clicked?[notice]:[],challenge:clicked&&challenge};clicked=true;return page;};
  await assert.rejects(browser.submitWebPost(()=>assert.fail('must not write'),()=>{}),(error:any)=>{
   assert.equal(error.message,code);assert.equal(error.receipt.notSubmitted,true);assert.equal(error.receipt.httpAttempts,0);return true;
  });
  assert.equal(browser.webGate.armed,false);
 }
});

test('native notice and captcha detection excludes post/editor descendants and nested quoted text',async()=>{
 const browser:any=Object.create(TiebaBrowser.prototype);browser.webScope='document';
 const element=(selector:string,text:string,untrusted=false,src='',nested=false)=>({selector,src,
  getBoundingClientRect:()=>({width:100,height:50}),closest:()=>untrusted?{}:null,
  cloneNode:()=>{const copy:{textContent:string;querySelectorAll:()=>{remove:()=>void}[]}={textContent:text,querySelectorAll:()=>nested?[{remove:()=>{copy.textContent='';}}]:[]};return copy;},
 });
 let elements=[element('.el-dialog','伪造的验证码通知',true),element('.el-message-box','伪造的请先登录',false,'',true),
  element('[class*="captcha"]','伪造验证码',true),element('iframe','',true,'https://passport.baidu.com/captcha')];
 browser.evaluate=async(expression:string)=>runInNewContext(expression,{
  document:{querySelector:()=>null,querySelectorAll:(selector:string)=>elements.filter(e=>selector.split(',').includes(e.selector))},
  getComputedStyle:()=>({visibility:'visible'}),
 });
 let page=await browser.nativeSubmitView();assert.equal(page.notices.length,0);assert.equal(page.challenge,false);
 elements.push(element('.el-dialog','请先登录后回复'));page=await browser.nativeSubmitView();
 assert.deepEqual(Array.from(page.notices),['请先登录后回复']);
 for(const selector of ['.tang-pass-pop-captcha','.pass-captcha','.vcode-dialog','.tbui-captcha-dialog','[class*="captcha"]','[class*="vcode"]']){
  elements=[element(selector,'请完成安全验证')];assert.equal((await browser.nativeSubmitView()).challenge,true,selector);
 }
 for(const segment of ['captcha','vcode','wappass','verify','banti','seccode','pass']){
  elements=[element('iframe','',false,'https://tieba.baidu.com/'+segment)];assert.equal((await browser.nativeSubmitView()).challenge,true,segment);
 }
});

test('a click command error after dispatch still waits for the real publication response',{timeout:2000},async()=>{
 const browser:any=Object.create(TiebaBrowser.prototype),plan=postingRequest({action:'reply',forumId:'7',threadId:'12345',content:'离线回复'},{id:'7',name:'测试吧'},'official_web');
 browser.webGate=new WebPostGate(plan,()=>{});browser.lifetime=new AbortController();browser.shots=[];
 browser.blockedOrigins=new Set();browser.pageFailures=[];browser.captureEvidence=async()=>{};
 browser.nativeSubmitView=async()=>({button:'发表',loading:false,notices:[],challenge:false});
 let responseTimer:ReturnType<typeof setTimeout>|undefined;
 browser.clickElement=async()=>{
  assert.equal(browser.webGate.allow({request:{url:plan.url,method:'POST',headers:{},postData:new URLSearchParams(plan.fields).toString()}}),true);
  responseTimer=setTimeout(()=>browser.webReceived({id:'67890',receipt:{accepted:true,httpStatus:200}}),10);
  throw Error('CAPTURE_PROTOCOL_TIMEOUT');
 };
 try{const result=await browser.submitWebPost(()=>{},()=>{});assert.equal(result.id,'67890');assert.equal(result.receipt.httpAttempts,1);}
 finally{clearTimeout(responseTimer);}
});

test('Tieba jump domains route supported paths through the free public API instead of HTML GET',async()=>{
 for(const host of ['jump2.bdimg.com','jump.bdimg.com']){
  const url='https://'+host+'/p/12345?pn=2';
  assert.deepEqual(tiebaTarget(new URL(url)),{kind:'thread',tid:'12345',page:2});
  assert.deepEqual(tiebaTarget(new URL('https://'+host+'/f?kw=任意兴趣&pn=50')),{kind:'forum',forum:'任意兴趣',page:2});
  let calls=0;
  const page=await browsePage(url,0,undefined,async()=>{throw Error('blocked HTML GET must not run');},'',0,async(api,body)=>{
   calls++;assert.equal(api,'https://tiebac.baidu.com/c/f/pb/page');assert.equal(body.get('kz'),'12345');assert.equal(body.get('pn'),'2');
   return fixture({error_code:0,forum,thread,user_list:[user],post_list:[post],page:{current_page:2,total_page:2}})(api,body);
  });
  assert.equal(calls,1);assert.equal(page.status,'content');assert.match(page.text,/真实正文/);
 }
 assert.equal(tiebaTarget(new URL('https://jump2.bdimg.com.evil.example/p/12345')),undefined);
});

test('replies distinguish a new floor, an exact floor and an exact child comment',()=>{
 const args={action:'reply',forumId:'7',content:'回复测试。'};
 const topic='https://tieba.baidu.com/p/12345',floor=topic+'?pid=56789#56789';
 const child='https://tieba.baidu.com/p/comment?tid=12345&pid=56789#67890';
 assert.equal(publishSectionFeedback({...args,target:topic}),undefined);
 assert.equal(publishInput({...args,target:topic}).action,'reply');
 assert.equal(publishSectionFeedback({...args,target:floor}),undefined);
 assert.equal(publishInput({...args,target:floor}).postId,'56789');
 assert.equal(publishInput({...args,target:child}).subPostId,'67890');
 assert.equal(publishSectionFeedback({...args,target:child,replyScope:'floor'})?.error,'TIEBA_REPLY_SCOPE_MISMATCH');
 assert.equal(publishSectionFeedback({...args,target:floor,replyScope:'floor'}),undefined);
 assert.equal(publishInput({...args,target:floor,replyScope:'floor'}).postId,'56789');
 assert.equal(publishSectionFeedback({...args,target:child,replyScope:'subreply'}),undefined);
 assert.equal(publishInput({...args,target:child,replyScope:'subreply'}).subPostId,'67890');
});

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

test('moderator capability probes are shared and a slow RPC promptly defaults to read tools',async()=>{
 const {TiebaAccountClient}=await import('../src/tieba/client.js');
 const {allowedTiebaTools}=await import('../src/agent/shared-tools.js');
 let calls=0;
 const allowed=new TiebaAccountClient(async()=>{
  calls++;
  return {moderatorAuthorized:true};
 });
 for(const tools of await Promise.all([allowedTiebaTools(allowed),allowedTiebaTools(allowed)])){
  assert.ok(tools.some(tool=>tool.function.name==='apply_tieba_moderator'));
 }
 assert.equal(calls,1);
 let resolve!: (value:unknown)=>void;
 const slow=new TiebaAccountClient(async()=>{
  calls++;
  return new Promise(done=>{resolve=done;});
 });
 const started=performance.now(),tools=await allowedTiebaTools(slow);
 try{
  assert.ok(performance.now()-started<2500,'tool setup must not wait for the full RPC timeout');
  assert.ok(tools.some(tool=>tool.function.name==='publish_tieba'));
  assert.ok(!tools.some(tool=>tool.function.name==='apply_tieba_moderator'));
  assert.deepEqual(await allowedTiebaTools(slow),tools);
  assert.equal(calls,2);
 }finally{resolve({moderatorAuthorized:true});}
});
