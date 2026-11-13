import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import dns from 'node:dns/promises';
import https from 'node:https';
import {gzipSync} from 'node:zlib';
import {FishError} from '../src/types.js';
import {APP_POST_URL,AppPostFailure,encodeAddFloor,encodeAddPost,parseAddPostResponse,sendAppReply} from '../src/tieba/app-post.js';
import {postingTarget,postingRequest,TiebaPosting,type PublishInput,type PostingReader} from '../src/tieba/posting.js';
import {TiebaBrowser} from '../src/capture/tieba-browser.js';
import {pbBytes,pbNumber,pbString,parseFields} from '../src/tieba/protobuf.js';
import {replyRequest,replyPage} from '../src/tieba/replies.js';
import {tiebaPage} from '../src/search/tieba.js';

const fixture=JSON.parse(fs.readFileSync('tests/fixtures/tieba-app-post.json','utf8'));
const response=(key:string)=>Buffer.from(fixture.responses[key],'hex');
const forum={id:'28340562',name:'肥鱼避难所'},who={id:'7129084874',name:'fixture'},policy={mode:'live' as const,accountId:who.id};
const input:PublishInput={action:'reply',forumId:forum.id,threadId:'11193581226',content:'离线协议样本，不会发送。'};
const parent={id:'154137712467',author:{id:'5761543338',name:'离线吧友',portrait:'tb.fixture'}};
const child={id:'154137729422',parentPostId:parent.id,author:{id:'9007199254740993',name:'离线吧友',portrait:'tb.fixture'}};
const reader:PostingReader={followed:async()=>[forum],read:async url=>({status:'content',forum,thread:{id:input.threadId},posts:url.includes('/comment')?[child]:[parent]}),publicRead:async()=>({status:'empty',forum,posts:[]})};
function temporary(t:any){const base=path.resolve('runtime/verification');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'tieba-app-'));const db=Object.assign(new TiebaPosting(dir),{fixtureDir:dir});t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});return db;}
function unpack(body:Buffer){const start=body.indexOf('\r\n\r\n')+4,end=body.lastIndexOf('\r\n--');assert.ok(start>=4&&end>start);return body.subarray(start,end);}

test('three request vectors match the pinned upstream encoders byte for byte',()=>{
 for(const v of fixture.requests){const b=v.kind==='reply'?encodeAddFloor(v.args):encodeAddPost(v.args);assert.equal(b.toString('hex'),v.hex,v.kind);}
 assert.match(fixture.source,/06e1657eb5262d3d2337466debf0a7ca1c165fbf/);
 assert.equal(parseAddPostResponse(response('success')).pid,'9007199254740993');
 assert.throws(()=>parseAddPostResponse(Buffer.from([0x12,0xff])),/UNCONFIRMED/);
});
test('driver sends multipart protobuf to cmd 309731 with current session TBS and one write',async t=>{
 const plan=postingRequest(input,forum);let writes=0,authReads=0;
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);
 t.mock.method(https,'request',(url:any,options:any,callback:any)=>{
  writes++;assert.equal(String(url),APP_POST_URL);assert.equal(options.method,'POST');assert.equal(options.headers['x_bd_data_type'],'protobuf');assert.equal(options.headers['user-agent'],'aiotieba/4.8.1');assert.match(options.headers['content-type'],/^multipart\/form-data; boundary=/);assert.match(options.headers['accept-encoding'],/gzip/);
  const req=new EventEmitter() as any;req.end=(body:Buffer)=>{assert.equal(options.headers['content-length'],body.length);assert.match(body.toString(),/name="data"; filename="file"/);assert.equal(unpack(body).toString('hex'),fixture.requests[0].hex);queueMicrotask(()=>{const res=new EventEmitter() as any;res.statusCode=200;res.headers={'content-type':'application/octet-stream','content-encoding':'gzip'};callback(res);res.emit('data',gzipSync(response('success')));res.emit('end');});};return req;
 });
 const fake={accountPoster:async()=>async(url:string)=>{authReads++;assert.ok(url.endsWith('/c/s/login'));return {bytes:Buffer.from(JSON.stringify({error_code:0,anti:{tbs:'OFFLINE_TBS'},user:{name_show:'离线鱼'}}))};},bduss:async()=>'OFFLINE_BDUSS',request:(...args:any[])=>(TiebaBrowser.prototype as any).request(...args)};
 const result=await TiebaBrowser.prototype.sendPost.call(fake as any,plan);assert.equal(writes,1);assert.equal(authReads,1);assert.equal(result.id,'9007199254740993');assert.ok(!JSON.stringify(result).includes('OFFLINE_'));assert.equal(result.receipt?.accepted,true);
});
test('floor and child reply references come from verified targets, not model-supplied identities',async()=>{
 const direct={...input,action:'comment' as const,postId:parent.id},nested={...direct,subPostId:child.id};
 const a=postingRequest(direct,await postingTarget(direct,who,policy,reader)),b=postingRequest(nested,await postingTarget(nested,who,policy,reader));
 assert.equal(a.fields.reply_uid,parent.author.id);assert.equal(a.fields.sub_post_id,'');assert.equal(b.fields.reply_uid,child.author.id);assert.equal(b.fields.quote_id,parent.id);assert.equal(b.fields.repostid,parent.id);assert.equal(b.fields.sub_post_id,child.id);assert.equal(b.fields.content,'回复 #(reply, tb.fixture, 离线吧友) :'+input.content);
 await assert.rejects(postingTarget({...nested,forumId:'99'},who,policy,reader),/READ_ONLY/);
 await assert.rejects(postingTarget({...nested,subPostId:'999'},who,policy,reader),/COMMENT_NOT_VERIFIED/);
 const normalized=await tiebaPage('https://tieba.baidu.com/p/comment?tid='+input.threadId+'&pid='+parent.id,async url=>({url,type:'application/json',bytes:Buffer.from(JSON.stringify({error_code:0,forum,thread:{id:input.threadId},post:{id:parent.id,content:[]},page:{current_page:1,total_count:1},subpost_num:1,user_list:[child.author],subpost_list:[{id:child.id,author:{id:child.author.id},content:[{type:0,text:'fixture'}],time:1794567857}]}))}));
 assert.equal(normalized?.posts[0].author.portrait,'tb.fixture');
});
test('captcha, rejection, missing ID, malformed body and timeout never retry or select a web writer',async()=>{
 const plan=postingRequest(input,forum);
 const cases:[Buffer|Error,string][]=[
  [response('captcha'),'TIEBA_PUBLICATION_CHALLENGE'],[response('captchaWithZeroCode'),'TIEBA_PUBLICATION_CHALLENGE'],[response('rejected'),'TIEBA_PUBLICATION_REJECTED'],[response('acceptedNoId'),'TIEBA_PUBLICATION_UNCONFIRMED'],
  [Buffer.from('<html>百度安全验证</html>'),'TIEBA_PUBLICATION_CHALLENGE'],[Buffer.from('{"error_code":121,"error_msg":"denied"}'),'TIEBA_PUBLICATION_REJECTED'],[Buffer.from([0x12,0xff]),'TIEBA_PUBLICATION_UNCONFIRMED'],[new FishError('TIEBA_READ_NETWORK_FAILED'),'TIEBA_READ_NETWORK_FAILED']
 ];
 for(const [body,code] of cases){let calls=0;await assert.rejects(sendAppReply(plan,fixture.requests[0].args,async url=>{calls++;assert.equal(url,APP_POST_URL);if(body instanceof Error)throw body;return {bytes:body};}),(e:any)=>e.code===code);assert.equal(calls,1,code);}
 const auth=fixture.requests[0].args,message='请输入验证码 BDUSS='+auth.bduss+' tbs='+auth.tbs+' https://example.invalid/verify?token=private';
 for(const bytes of [pbBytes(1,Buffer.concat([pbNumber(1,5),pbString(2,message)])),Buffer.from(JSON.stringify({error_code:5,error_msg:message}))])await assert.rejects(sendAppReply(plan,auth,async()=>({bytes})),(e:any)=>{assert.equal(e.code,'TIEBA_PUBLICATION_CHALLENGE');assert.equal(e.receipt.errorCode,5);assert.match(e.receipt.errorMessage,/请输入验证码/);assert.ok(!JSON.stringify(e.receipt).includes('OFFLINE_'));assert.ok(!JSON.stringify(e.receipt).includes('example.invalid'));return true;});
});
test('uncertain and rejected outbox outcomes block identical submissions under a new call ID',async t=>{
 for(const key of ['acceptedNoId','rejected','captcha','timeout']){
  const db=temporary(t);let writes=0;
  const send=(plan:any)=>sendAppReply(plan,fixture.requests[0].args,async()=>{writes++;if(key==='timeout')throw new FishError('TIEBA_READ_NETWORK_FAILED');return {bytes:response(key)};});
  const a=await db.publish(input,'first',who,policy,reader,send);
  (db as any).db.prepare('UPDATE tieba_actions SET fingerprint=?').run(createHash('sha256').update(JSON.stringify([who.id,input])).digest('hex'));
  (db as any).db.exec('PRAGMA user_version=0');
  const reopened=new TiebaPosting(db.fixtureDir);let b:any;try{b=await reopened.publish({content:input.content,threadId:input.threadId,forumId:input.forumId,action:input.action},'second',who,policy,reader,send);}finally{reopened.close();}
  assert.equal(writes,1);assert.equal(a.published,false);assert.equal(b.reused,true);assert.equal(b.retryScheduled,false);
  if(key==='acceptedNoId'){assert.equal(a.submitted,true);assert.equal(a.deliveryStatus,'unconfirmed');}
  if(key==='captcha')assert.equal(a.error,'TIEBA_PUBLICATION_CHALLENGE');
  if(key==='timeout'){assert.equal(a.submitted,null);assert.equal(a.deliveryStatus,'unconfirmed');}
 }
});
test('HTTP acceptance and generated ID remain separate from public visibility and later system deletion',async t=>{
 const db=temporary(t),id='9007199254740993';let visible=false,removed=false,writes=0;const at=new Date().toISOString();
 const reads:PostingReader={...reader,publicRead:async()=>({status:visible?'content':'empty',forum,thread:{id:input.threadId},posts:visible?[{id,author:who,content:input.content,publishedAt:at}]:[]}),deletion:async()=>removed?{postId:id,threadId:input.threadId!,category:'system',source:'tieba_account_recycle',reason:'因存在涉嫌异常行为被系统删除',time:'2026-11-13 19:10:09',timeZone:'Asia/Hong_Kong'}:null};
 const a=await db.publish(input,'accepted',who,policy,reads,async plan=>{writes++;return sendAppReply(plan,fixture.requests[0].args,async()=>({bytes:response('success')}));});
 assert.equal(a.deliveryStatus,'accepted');assert.equal(a.submitted,true);assert.equal(a.published,false);assert.equal(a.receipt.idGenerated,true);
 visible=true;const b=await db.verify('accepted',who,reads);assert.equal(b.deliveryStatus,'confirmed');assert.equal(b.visibility,'public');assert.ok(b.lastPubliclyVisibleAt);
 visible=false;removed=true;const c=await db.verify('accepted',who,reads);assert.equal(c.deliveryStatus,'deleted');assert.equal(c.visibility,'removed_by_system');assert.equal(c.deletion?.reason,'因存在涉嫌异常行为被系统删除');assert.equal(c.lastPubliclyVisibleAt,b.lastPubliclyVisibleAt);
 assert.equal((await db.publish(input,'no-resend',who,policy,reads,async()=>{writes++;throw Error('must not run');})).reused,true);assert.equal(writes,1);
 const located=await tiebaPage('https://tieba.baidu.com/p/'+input.threadId+'?pid='+id,async(url,body)=>{
  assert.equal(body.get('pid'),null);assert.equal(body.get('r'),'1');assert.equal(body.get('rn'),'30');
  return {url,type:'application/json',bytes:Buffer.from(JSON.stringify({error_code:0,forum,thread:{id:input.threadId},page:{current_page:1,total_page:1},user_list:[who],post_list:[{id,author_id:who.id,time:Math.floor(Date.parse(at)/1000),floor:18,content:[{type:0,text:input.content}]}]}))};
 });assert.equal(located?.posts[0].id,id);assert.equal(located?.posts[0].author.id,who.id);assert.ok(located&&'target' in located);assert.equal(located.target?.found,true);assert.deepEqual(new URL(located.posts[0].url).searchParams.getAll('pid'),[id]);
});
test('shared codec preserves existing ReplyMe read messages, pagination and 64-bit identities',()=>{
 const request=replyRequest('OFFLINE_BDUSS',2),root=parseFields(unpack(request.body))[0].b!,data=parseFields(root),common=parseFields(data.find(f=>f.n===3)!.b!);
 assert.equal(data.find(f=>f.n===1)?.v,2n);assert.equal(common.find(f=>f.n===2)?.b?.toString(),'12.64.1.1');
 const user=Buffer.concat([pbNumber(2,9007199254740993n),pbString(4,'fixture')]);
 const row=Buffer.concat([pbNumber(1,11193581226n),pbNumber(2,154137712467n),pbNumber(3,1794567857),pbString(5,'fixture'),pbString(6,'离线回复'),pbBytes(9,user)]);
 const body=pbBytes(2,Buffer.concat([pbBytes(1,pbNumber(3,1)),pbBytes(2,row)]));
 assert.equal(replyPage(body,1).replies[0].author.id,'9007199254740993');assert.equal(replyPage(body,1).replies[0].text,'离线回复');
});
