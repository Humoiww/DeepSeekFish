import fs from 'node:fs';
import {spawn,type ChildProcess} from 'node:child_process';
import https from 'node:https';
import dns from 'node:dns/promises';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {gunzipSync,inflateSync,brotliDecompressSync} from 'node:zlib';
import {followedForums,type FollowedForum,type SystemDeletion,postingRequest} from '../tieba/posting.js';
import {Pipe} from './cdp.js';
import {FishError} from '../types.js';
import type {AccountBrowser,TiebaIdentity,LoginInput} from '../tieba/session.js';
import {tiebaPage} from '../search/tieba.js';
import {publicAddress,type PublicPoster} from '../search/public-web.js';
import {replyRequest,replyPage} from '../tieba/replies.js';
import {sendAppReply,AppPostFailure} from '../tieba/app-post.js';
import {WebPostGate,webPostResponse,webPostResult,type WebOutcome} from '../tieba/web-post.js';
import {MODERATOR_PRE,MODERATOR_SUBMIT,moderatorReceipt,moderatorResult,type ModeratorReceipt} from '../tieba/moderator.js';
interface ModeratorPage {forumId:string;declaration?:string;escaped?:string;armed:boolean;writes:number;eligibility?:ModeratorReceipt;receipt?:ModeratorReceipt;before?:()=>void;outcome?:(result:any)=>void}

const HOME='https://tieba.baidu.com/';
export const LOGIN='https://passport.baidu.com/v2/?login&tpl=tb&u='+encodeURIComponent(HOME);
export function baiduResource(raw:string){
 try{const u=new URL(raw);return u.protocol==='about:'&&u.href==='about:blank'||['data:','blob:'].includes(u.protocol)||u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(['ppui-static-pc.cdn.bcebos.com','hercules.cdn.bcebos.com','banti-static.cdn.bcebos.com','tieba-ares.cdn.bcebos.com','bioc-static.cdn.bcebos.com','bioc-static-standby.cdn.bcebos.com','bioc-static-su-standby.cdn.bcebos.com'].includes(u.hostname)||['baidu.com','bdstatic.com','bdimg.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)));}catch{return false;}
}
export function identityData(value:any):TiebaIdentity|null{
 if(!value||typeof value!=='object')throw new FishError('TIEBA_IDENTITY_FORMAT_CHANGED');
 const info=value.data??value;
 if(info.is_login===0||info.is_login===false||info.is_login==='0'||info.is_login==='false')return null;
 const user=info.user??info,id=String(user.user_id??user.id??''),name=user.user_name_show??user.name_show??user.show_nickname??user.user_nickname??user.user_name??user.name;
 if(/^[1-9]\d{0,19}$/.test(id)&&typeof name==='string'&&name.trim())return {id,name:name.slice(0,100)};
 throw new FishError('TIEBA_IDENTITY_FORMAT_CHANGED');
}
/** c/s/login validates an existing cookie session and returns current user
 * info. It is not the interactive sign-in or a publishing endpoint. */
export async function verifyIdentity(poster:PublicPoster){
  const r=await poster('https://tiebac.baidu.com/c/s/login',new URLSearchParams({_client_type:'2',_client_version:'12.64.1.1'}));
  let data:any;try{data=JSON.parse(r.bytes.toString('utf8'));}catch{throw new FishError('TIEBA_IDENTITY_FORMAT_CHANGED');}
  if(!['0',0].includes(data?.error_code)){
   if(/(?:bduss.*(?:invalid|失效|无效|不合法)|未登录|登录.*(?:失效|过期)|重新登录)/i.test(String(data?.error_msg??'')))return null;
   throw new FishError('TIEBA_IDENTITY_REJECTED');
  }
  return identityData({data:{is_login:1,user:data.user}});
}
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
/** A real persistent Chromium profile. Only this isolated process can inspect
 * its cookies, and only the fixed read API can use them. */
export class TiebaBrowser implements AccountBrowser {
 private pipe:Pipe;private pages=new Map<string,Promise<string>>();private sessions:string[]=[];private closed=false;private blockedOrigins=new Set<string>();private deadline:NodeJS.Timeout;
 private webGate?:WebPostGate;private webScope='document';private webRequests=new Map<string,{session:string;status:number}>();private onWebOutcome?:(outcome:WebOutcome)=>void;
 private moderator?:ModeratorPage;private moderatorRequests=new Map<string,{session:string;status:number;phase:'eligibility'|'submit';work:ModeratorPage}>();
 private constructor(private child:ChildProcess,private profile:string){
  this.pipe=new Pipe(child,(url,params)=>{
   if(!baiduResource(url))return false;
   const u=new URL(url);
   if(params?.request?.method==='POST'&&u.origin==='https://tieba.baidu.com'&&[MODERATOR_PRE,MODERATOR_SUBMIT].includes(u.pathname)){
    const work=this.moderator,phase=u.pathname===MODERATOR_PRE?'eligibility':'submit',fields=Object.fromEntries(new URLSearchParams(params.request.postData??''));
    if(!work||fields.forum_id!==work.forumId)return false;
    if(phase==='submit'){
     if(!work.armed||work.writes||fields.declaration!==work.escaped)return false;
     work.before?.();work.armed=false;work.writes++;
    }
    if(params.networkId)this.moderatorRequests.set(params.networkId,{session:params.sessionId??this.sessions.at(-1)!,status:0,phase,work});return true;
   }
   if(params?.request?.method==='POST'&&u.hostname==='tieba.baidu.com'&&(/\/f\/commit\//.test(u.pathname)||/^\/c\/c\/(post|thread)\/add/.test(u.pathname))){
    if(!this.webGate?.allow(params)){
     if(this.webGate?.armed&&!this.webGate.writes){this.webGate.armed=false;this.webReceived({error:'TIEBA_WEB_REQUEST_NOT_VERIFIED',receipt:{transport:'official_web',accepted:false,idGenerated:false,notSubmitted:true,guardReason:this.webGate.blockedReason||'unexpected_endpoint',fieldNames:this.webGate.fieldNames}});}return false;
    }
    if(params.networkId)this.webRequests.set(params.networkId,{session:params.sessionId??this.sessions.at(-1)!,status:0});return true;
   }return true;
  });
  this.deadline=setTimeout(()=>{void this.close();},15*60000);this.deadline.unref();
  this.pipe.onEvent=e=>{
   if(e.method==='Fetch.requestPaused')e.params.sessionId=e.sessionId;
   const pending=this.webRequests.get(e.params?.requestId);
   if(pending&&e.method==='Network.responseReceived')pending.status=e.params.response.status;
   if(pending&&e.method==='Network.loadingFinished')void this.webResponse(e.params.requestId,pending);
   if(pending&&e.method==='Network.loadingFailed'){this.webRequests.delete(e.params.requestId);this.webReceived({error:'TIEBA_PUBLICATION_UNCONFIRMED',receipt:{transport:'official_web',responseKind:'network_error'}});}
   const application=this.moderatorRequests.get(e.params?.requestId);
   if(application&&e.method==='Network.responseReceived')application.status=e.params.response.status;
   if(application&&e.method==='Network.loadingFinished')void this.moderatorResponse(e.params.requestId,application);
   if(application&&e.method==='Network.loadingFailed'){this.moderatorRequests.delete(e.params.requestId);const receipt:ModeratorReceipt={phase:application.phase,httpStatus:application.status,accepted:false,responseKind:'network_error'};if(application.phase==='eligibility')application.work.eligibility=receipt;else{application.work.receipt=receipt;application.work.outcome?.(moderatorResult(receipt,true));}}
   if(e.method==='Fetch.requestPaused'&&!baiduResource(e.params.request.url)&&this.blockedOrigins.size<20){try{this.blockedOrigins.add(new URL(e.params.request.url).origin);}catch{}}
   if(e.method==='Target.attachedToTarget'){
    const p=e.params;
    const ready=this.setup(p.sessionId,p.targetInfo.type).then(()=>p.sessionId).catch(()=>{throw new FishError('TIEBA_BROWSER_FAILED');});ready.catch(()=>{});
    if(p.targetInfo.type==='page'){this.pages.set(p.targetInfo.targetId,ready);this.sessions.push(p.sessionId);}
   }
  };
 }
 static async open(profile:string,executable='/srv/deepseekfish/capture/browser/chrome-headless-shell'){
  fs.mkdirSync(profile,{recursive:true,mode:0o700});if(fs.lstatSync(profile).isSymbolicLink())throw new FishError('TIEBA_PROFILE_INVALID');
  const child=spawn(executable,['--headless','--disable-gpu','--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync','--password-store=basic','--disk-cache-size=16777216','--media-cache-size=1','--remote-debugging-pipe','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe'],detached:true,env:{PATH:'/usr/bin:/bin',HOME:profile,TMPDIR:'/tmp',LANG:'zh_CN.UTF-8',TZ:'Asia/Hong_Kong'}});
  child.on('error',()=>{});(child.stderr as NodeJS.ReadableStream).on('data',()=>{});
  const browser=new TiebaBrowser(child,profile);
  try{await browser.pipe.call('Browser.getVersion');await browser.pipe.call('Browser.setDownloadBehavior',{behavior:'deny'});
   await browser.pipe.call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
   const {targetId}=await browser.pipe.call('Target.createTarget',{url:'about:blank'});
   if(!browser.pages.has(targetId)){const {sessionId}=await browser.pipe.call('Target.attachToTarget',{targetId,flatten:true});if(!browser.pages.has(targetId)){const ready=browser.setup(sessionId,'page').then(()=>sessionId);browser.pages.set(targetId,ready);browser.sessions.push(sessionId);}}
   await browser.session();return browser;
  }catch{await browser.close();throw new FishError('TIEBA_BROWSER_START_FAILED');}
 }
 private async setup(session:string,type:string){
  await this.pipe.call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},session);
  if(type==='page'){
   await this.pipe.call('Page.enable',{},session);
   await this.pipe.call('Emulation.setDeviceMetricsOverride',{width:1000,height:800,deviceScaleFactor:1,mobile:false},session);
   await this.pipe.call('Network.enable',{},session);
   await this.pipe.call('Network.setUserAgentOverride',{userAgent:'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',acceptLanguage:'zh-CN,zh;q=0.9'},session);
  }
  await this.pipe.call('Runtime.runIfWaitingForDebugger',{},session);
 }
 private async session(){const {targetInfos}=await this.pipe.call('Target.getTargets'),live=new Map(targetInfos.map((t:any)=>[t.targetId,t]));for(const [id,ready] of [...this.pages].reverse()){const t:any=live.get(id);if(t?.type==='page'&&baiduResource(t.url))return await ready;}throw new FishError('TIEBA_LOGIN_PAGE_CLOSED');}
 private async navigate(url:string){const s=await this.session();await this.pipe.call('Page.navigate',{url},s);await sleep(1200);return s;}
 async login(){await this.navigate(LOGIN);for(let i=0;i<15;i++){const ready=await this.evaluate(`!!document.querySelector('img[src*=qrcode],.tang-pass-qrcode-img,.qrcode')||Array.from(document.querySelectorAll('input')).some(e=>e.offsetWidth>0&&e.offsetHeight>0&&['text','password','tel'].includes(e.type))`);if(ready)break;await sleep(300);}}
 async loginInfo(){const info=await this.evaluate(`(()=>{const t=document.body?.innerText||'';return {bodyCharacters:t.length,inputCount:document.querySelectorAll('input').length,frameCount:document.querySelectorAll('iframe').length,title:document.title.slice(0,120),origin:location.origin+location.pathname,qrVisible:!!document.querySelector('img[src*=qrcode],canvas,.tang-pass-qrcode-img,.qrcode'),challenge:/验证码|安全验证|安全检测/.test(t),blocked:/403 Forbidden|Access Denied|ERR_|页面不存在|无法访问此网站|Bad Gateway/.test(t)};})()`);return {...info,blockedOrigins:[...this.blockedOrigins]};}
 private async evaluate(expression:string,session?:string){const r=await this.pipe.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session??await this.session());if(r.exceptionDetails)throw new FishError('TIEBA_PAGE_REQUEST_FAILED');return r.result?.value;}
 private webReceived(outcome:WebOutcome){const safe=this.webGate?.received(outcome);if(safe)this.onWebOutcome?.(safe);}
 private async webResponse(id:string,pending:{session:string;status:number}){
  this.webRequests.delete(id);
  try{const r=await this.pipe.call('Network.getResponseBody',{requestId:id},pending.session),body=Buffer.from(r.body,r.base64Encoded?'base64':'utf8');if(body.length>2097152)throw new FishError('TIEBA_READ_LIMIT');this.webReceived(webPostResponse(body,pending.status,{bduss:await this.bduss()??'',tbs:''}));}
  catch{this.webReceived({error:'TIEBA_PUBLICATION_UNCONFIRMED',receipt:{transport:'official_web',responseKind:'unavailable'}});}
 }
 private async moderatorResponse(id:string,pending:{session:string;status:number;phase:'eligibility'|'submit';work:ModeratorPage}){
  this.moderatorRequests.delete(id);let receipt:ModeratorReceipt;
  try{const r=await this.pipe.call('Network.getResponseBody',{requestId:id},pending.session),bytes=Buffer.from(r.body,r.base64Encoded?'base64':'utf8');if(bytes.length>2097152)throw new FishError('TIEBA_READ_LIMIT');receipt=moderatorReceipt(bytes,pending.status,pending.phase);}
  catch{receipt={phase:pending.phase,httpStatus:pending.status,accepted:false,responseKind:'unexpected'};}
  if(pending.phase==='eligibility')pending.work.eligibility=receipt;
  else{pending.work.receipt=receipt;pending.work.outcome?.(moderatorResult(receipt,true));}
 }
 private async moderatorCandidate(account:{id:string;name:string}){
  return this.evaluate(`(()=>{const self=window.PageData?.user||{};if(String(self.user_id)!==${JSON.stringify(account.id)})return null;const portrait=String(self.portrait||'').split('?')[0],name=${JSON.stringify(account.name)};const row=Array.from(document.querySelectorAll('tr.candidate_item')).find(e=>{const a=e.querySelector('a.user_name');if(!a||e.querySelector('.apply_type')?.innerText.trim()!=='小吧主')return false;return portrait&&new URL(a.href).searchParams.get('id')===portrait||a.getAttribute('title')===name;});if(!row)return null;return {name:row.querySelector('a.user_name')?.innerText,role:'small_moderator',information:(row.innerText+'\\n'+(row.nextElementSibling?.innerText||'')).slice(0,1800),pageUrl:location.origin+location.pathname+location.search};})()`);
 }
 async moderatorApplication(forum:{id:string;name:string},account:{id:string;name:string},declaration?:string,before?:()=>void,outcome?:(result:any)=>void){
  const work:ModeratorPage={forumId:forum.id,declaration,armed:false,writes:0,before,outcome};this.moderator=work;
  const url='https://tieba.baidu.com/bawu2/platform/listCandidateInfo?ie=utf-8&word='+encodeURIComponent(forum.name);
  await this.navigate(url);
  for(let i=0;i<24;i++){if(await this.evaluate(`!!document.querySelector('.j_btn_apply_assist')`))break;await sleep(250);}
  const binding=await this.evaluate(`({accountId:String(window.PageData?.user?.user_id||''),forumId:String(window.PageData?.forum?.forum_id||'')})`);
  if(binding?.accountId!==account.id||binding?.forumId!==forum.id){const page=await this.loginInfo();return {submitted:false,requestSent:false,applicationStatus:page.challenge?'requires_human':'unavailable',error:page.challenge?'TIEBA_MODERATOR_VERIFICATION_REQUIRED':'TIEBA_MODERATOR_PAGE_NOT_VERIFIED',page,forum,url};}
  const ownCandidate=await this.moderatorCandidate(account);
  await this.clickElement(`document.querySelector('.j_btn_apply_assist')`);
  for(let i=0;i<40;i++){if(work.eligibility)break;await sleep(200);}
  const requirements=await this.evaluate(`document.querySelector('.assist_apply_dlg')?.innerText?.slice(0,4000)||Array.from(document.querySelectorAll('.dialogJ')).map(e=>e.innerText).join('\\n').slice(0,4000)||''`);
  if(!work.eligibility?.accepted)return {...(work.eligibility?moderatorResult(work.eligibility,false):{submitted:false,requestSent:false,applicationStatus:'unknown',error:'TIEBA_MODERATOR_ELIGIBILITY_UNCONFIRMED'}),requirements,ownCandidate,forum,url};
  for(let i=0;i<15;i++){if(await this.evaluate(`!!document.querySelector('.assist_apply_dlg .j_statement')`))break;await sleep(200);}
  const ready=await this.evaluate(`!!document.querySelector('.assist_apply_dlg .j_statement')&&!!document.querySelector('.assist_apply_dlg .j_submit')`);
  if(!ready)return {submitted:false,requestSent:false,applicationStatus:'unavailable',error:'TIEBA_MODERATOR_FORM_CHANGED',requirements,ownCandidate,forum,url};
  if(declaration===undefined)return {submitted:false,requestSent:false,applicationStatus:'eligible',requirements,ownCandidate,forum,url,receipt:work.eligibility};
  work.escaped=await this.evaluate(`window.$?.tb?.escapeHTML(${JSON.stringify(declaration)})`);
  if(typeof work.escaped!=='string')throw new FishError('TIEBA_MODERATOR_FORM_CHANGED');
  await this.clickElement(`document.querySelector('.assist_apply_dlg .j_statement')`);const session=await this.session();
  for(const type of ['keyDown','keyUp'])await this.pipe.call('Input.dispatchKeyEvent',{type,key:'a',modifiers:2,windowsVirtualKeyCode:65},session);
  await this.pipe.call('Input.insertText',{text:declaration},session);
  if(!await this.evaluate(`document.querySelector('.assist_apply_dlg .j_statement')?.value===${JSON.stringify(declaration)}`))throw new FishError('TIEBA_MODERATOR_CONTENT_NOT_VERIFIED');
  work.armed=true;await this.clickElement(`document.querySelector('.assist_apply_dlg .j_submit')`);
  for(let i=0;i<80;i++){if(work.receipt)break;await sleep(200);}work.armed=false;
  const result=work.receipt?moderatorResult(work.receipt,true):{submitted:work.writes?null:false,requestSent:work.writes>0,applicationStatus:'unknown',deliveryStatus:'unconfirmed',error:'TIEBA_MODERATOR_UNCONFIRMED',retryScheduled:false};
  if(work.receipt?.accepted){await this.navigate(url);await sleep(500);}
  return {...result,requirements,forum,url,ownCandidate:work.receipt?.accepted?await this.moderatorCandidate(account):ownCandidate};
 }
 private async clickElement(expression:string){
  const point=await this.evaluate(`(()=>{const e=${expression};if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`);
  if(!point)throw new FishError('TIEBA_WEB_COMPOSER_CHANGED');const session=await this.session();
  for(const type of ['mouseMoved','mousePressed','mouseReleased'])await this.pipe.call('Input.dispatchMouseEvent',{type,...point,button:type==='mouseMoved'?'none':'left',clickCount:1},session);
 }
 /** Prepare only. Submission remains disarmed until the caller has persisted
  * the outbox intent and explicitly requests the one normal button click. */
 async prepareWebPost(request:ReturnType<typeof postingRequest>){
  try{return await this.prepareWebComposer(request);}catch(e){
   // No submit is armed during preparation. A missing editor/target is a
   // known local failure, not an uncertain delivery or platform rejection.
   throw new AppPostFailure(e instanceof FishError?e.code:'TIEBA_WEB_PREPARATION_FAILED',{transport:'official_web',stage:'preparation',accepted:false,idGenerated:false,notSubmitted:true,httpAttempts:0});
  }
 }
 private async prepareWebComposer(request:ReturnType<typeof postingRequest>){
  if(!['reply','comment'].includes(request.action))throw new FishError('TIEBA_WEB_ACTION_NOT_SUPPORTED');
  this.webGate=new WebPostGate(request,()=>{});this.onWebOutcome=undefined;
  this.webScope='document';
  // The official page resolves pid to the containing page. Scrolling page
  // one cannot find a later parent, even if the read adapter verified it.
  await this.navigate('https://tieba.baidu.com/p/'+request.fields.tid+(request.action==='comment'?'?pid='+request.fields.quote_id+'#'+request.fields.quote_id:''));
  let ready=false;for(let i=0;i<24;i++){ready=await this.evaluate(`location.pathname==='/p/'+${JSON.stringify(request.fields.tid)}&&!!document.querySelector('.pc-pb-reply-box .reply-input')`);if(ready)break;await sleep(250);}
  if(!ready)throw new FishError('TIEBA_WEB_COMPOSER_CHANGED');
  if(request.action==='reply')await this.clickElement(`document.querySelector('.pc-pb-reply-box .reply-input')`);
  else {
   // Observed official Vue2 page: parent floors carry data-id; sub replies
   // expose their real IDs in the rendered description component's props.
   // Inspect those bindings only to locate the ordinary Reply button.
   const parent=JSON.stringify(request.fields.quote_id),child=JSON.stringify(request.fields.sub_post_id??''),floorSelector=JSON.stringify('.pb-comment-item[data-id="'+request.fields.quote_id+'"]');
   const description=`(()=>{const floor=document.querySelector(${floorSelector});if(!floor)return null;return Array.from(floor.querySelectorAll('.pc-pb-comments-desc')).find(e=>{const p=e.__vue__?.$props;return p&&String(p.commentData?.id)===(${child}||${parent})&&String(p.pid||'')===(${child}?${parent}:'');});})()`;
   const control=`${description}?.querySelector('.reply-container')`;
   let found=false;
   for(let i=0;i<40;i++){
    if(await this.evaluate(`!!${control}`)){found=true;break;}
    const more=`document.querySelector(${floorSelector})?.querySelector('.show-more-lzl')`;
    if(request.fields.sub_post_id&&await this.evaluate(`!!${more}`))await this.clickElement(more);
    else await this.pipe.call('Input.dispatchMouseEvent',{type:'mouseWheel',x:600,y:350,deltaX:0,deltaY:550},await this.session());
    await sleep(250);
   }
   if(!found)throw new FishError('TIEBA_WEB_REPLY_TARGET_NOT_VISIBLE');
   this.webScope=request.fields.sub_post_id?`${description}?.closest('.pb-lzl-item')`:`document.querySelector(${floorSelector})?.querySelector(':scope > .comment-content')`;
   await this.clickElement(control);
  }
  const editor=`(${this.webScope})?.querySelector('#tb-editor-pb-content .ql-editor[contenteditable=true]')`,content=request.editorContent??request.fields.content;
  for(let i=0;i<12;i++){if(await this.evaluate(`!!${editor}`))break;await sleep(200);}
  await this.clickElement(editor);
  const session=await this.session();
  await this.pipe.call('Input.dispatchKeyEvent',{type:'keyDown',key:'a',modifiers:2,windowsVirtualKeyCode:65},session);await this.pipe.call('Input.dispatchKeyEvent',{type:'keyUp',key:'a',modifiers:2,windowsVirtualKeyCode:65},session);
  await this.pipe.call('Input.insertText',{text:content},session);
  const matches=await this.evaluate(`(()=>{const e=${editor};return (e?.innerText||'').replace(/\\s+/g,'')===${JSON.stringify(content.replace(/\s+/g,''))};})()`);
  if(!matches)throw new FishError('TIEBA_WEB_CONTENT_NOT_VERIFIED');
  return {prepared:true,transport:'official_web',action:request.action,threadId:request.fields.tid,ready:!this.webGate.outcome};
 }
 async submitWebPost(beforeWrite:()=>void,onOutcome:(outcome:WebOutcome)=>void){
  if(!this.webGate||this.webGate.writes)throw new FishError('TIEBA_WEB_SUBMISSION_ALREADY_STARTED');
  this.webGate=new WebPostGate(this.webGate.plan,beforeWrite);this.onWebOutcome=onOutcome;this.webGate.armed=true;
  await this.clickElement(`(${this.webScope})?.querySelector('.publish-btn:not([disabled])')`);
  for(let i=0;i<80;i++){if(this.webGate.outcome)return webPostResult(this.webGate.outcome,this.webGate.plan.fields.tid);await sleep(250);}
  this.webGate.armed=false;throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');
 }
 async isWebPublishInput(input:LoginInput){
  if(!this.webGate||this.webGate.writes)return false;
  const button=`(${this.webScope})?.querySelector('.publish-btn:not([disabled])')`;
  if(input.kind==='click')return !!await this.evaluate(`(()=>{const e=document.elementFromPoint(${input.x},${input.y})?.closest('.publish-btn:not([disabled])');return !!e&&e===${button};})()`);
  if(input.kind==='key'&&input.key==='Enter')return !!await this.evaluate(`(()=>{const e=document.activeElement?.closest('.publish-btn:not([disabled])');return !!e&&e===${button};})()`);
  return false;
 }
 webPublication(){return this.webGate?{writes:this.webGate.writes,outcome:this.webGate.outcome??null}:null;}
 async identity(){
  const poster=await this.accountPoster();return poster?verifyIdentity(poster):null;
 }
 async frame(){const r=await this.pipe.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},await this.session());if(typeof r.data!=='string'||r.data.length>8000000)throw new FishError('TIEBA_FRAME_INVALID');return Buffer.from(r.data,'base64');}
 holdForInteraction(){clearTimeout(this.deadline);}
 async input(v:LoginInput){
  if(this.webGate)this.webGate.humanAt=Date.now();
  const s=await this.session(),send=(params:Record<string,unknown>)=>this.pipe.call('Input.dispatchMouseEvent',params,s);
  if(v.kind==='text')await this.pipe.call('Input.insertText',{text:v.text},s);
  else if(v.kind==='key'){
   const key=v.key==='SelectAll'?'a':v.key!,code:Record<string,number>={Enter:13,Tab:9,Backspace:8,Escape:27,ArrowLeft:37,ArrowRight:39,ArrowUp:38,ArrowDown:40,a:65};
   for(const type of ['keyDown','keyUp'])await this.pipe.call('Input.dispatchKeyEvent',{type,key,windowsVirtualKeyCode:code[key],nativeVirtualKeyCode:code[key],...(key==='a'?{modifiers:2}:{}),...(key==='Enter'&&type==='keyDown'?{text:'\r'}:{})},s);
  }else if(v.kind==='scroll')await send({type:'mouseWheel',x:500,y:400,deltaX:0,deltaY:v.delta});
  else {
   await send({type:'mouseMoved',x:v.x,y:v.y});await send({type:'mousePressed',x:v.x,y:v.y,button:'left',clickCount:1});
   if(v.kind==='drag')for(let i=1;i<=12;i++){await send({type:'mouseMoved',x:v.x!+(v.toX!-v.x!)*i/12,y:v.y!+(v.toY!-v.y!)*i/12,button:'left',buttons:1});await sleep(25);}
   await send({type:'mouseReleased',x:v.kind==='drag'?v.toX:v.x,y:v.kind==='drag'?v.toY:v.y,button:'left',clickCount:1});
  }
  await sleep(400);
 }
 private async bduss(){
  const cookies=await this.pipe.call('Storage.getCookies');
  const cookie=(name:string)=>cookies.cookies?.find((c:any)=>c.name===name&&['baidu.com','.baidu.com','tieba.baidu.com','.tieba.baidu.com'].includes(c.domain))?.value;
  const value=cookie('BDUSS');return typeof value==='string'&&value?value:null;
 }
 private async accountPoster(writing=false):Promise<PublicPoster|null>{
  const bduss=await this.bduss();if(!bduss)return null;
  const poster:PublicPoster=async(raw,body,signal)=>{
   const u=new URL(raw);if(u.origin!=='https://tiebac.baidu.com'||!['/c/f/frs/page','/c/f/pb/page','/c/f/pb/floor','/c/s/login','/c/f/forum/like',...(writing?['/c/c/thread/add']:[])].includes(u.pathname)||u.search)throw new FishError('TIEBA_READ_TARGET_DENIED');
   const fields=Object.fromEntries(body);delete fields.sign;if(u.pathname==='/c/s/login')fields.bdusstoken=bduss;else fields.BDUSS=bduss;
   const privateBody=new URLSearchParams(fields);privateBody.set('sign',createHash('md5').update(Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('')+'tiebaclient!!!').digest('hex'));
   return this.request(raw,Buffer.from(privateBody.toString()),'application/x-www-form-urlencoded',signal);
  };
  return poster;
 }
 private async request(raw:string,bytes:Buffer,type:string,signal?:AbortSignal,userAgent='bdtb for Android 12.64.1.1',compressed=false):ReturnType<PublicPoster>{
   const u=new URL(raw),addresses=await dns.lookup(u.hostname,{all:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new FishError('TIEBA_PRIVATE_ADDRESS');const address=addresses.find(a=>a.family===4)??addresses[0];
   return new Promise((resolve,reject)=>{
    const req=https.request(u,{method:'POST',agent:false,signal:AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]),maxVersion:'TLSv1.2',headers:{'content-type':type,'content-length':bytes.length,'user-agent':userAgent,...(compressed?{'accept-encoding':'gzip, deflate, br'}:{}),...(type.startsWith('multipart/')?{'x_bd_data_type':'protobuf'}:{})},lookup:((_host:any,opts:any,cb:any)=>opts.all?cb(null,[address]):cb(null,address.address,address.family)) as any},res=>{
     if(res.statusCode!==200){res.destroy();reject(new FishError('TIEBA_READ_HTTP_'+res.statusCode));return;}
     const parts:Buffer[]=[];let size=0;res.on('data',(b:Buffer)=>{size+=b.length;if(size>2097152)res.destroy(new FishError('TIEBA_READ_LIMIT'));else parts.push(b);});res.on('error',reject);res.on('end',()=>{
      try{let body=Buffer.concat(parts);const encoding=res.headers['content-encoding'],options={maxOutputLength:2097152};
       if(encoding==='gzip')body=gunzipSync(body,options);else if(encoding==='deflate')body=inflateSync(body,options);else if(encoding==='br')body=brotliDecompressSync(body,options);else if(encoding&&encoding!=='identity')throw new FishError('TIEBA_READ_ENCODING_UNSUPPORTED');
       resolve({url:raw,type:String(res.headers['content-type']??'application/octet-stream'),bytes:body});
      }catch(e){reject(e instanceof FishError?e:new FishError('TIEBA_READ_DECODE_FAILED'));}
     });
    });req.on('error',()=>reject(new FishError('TIEBA_READ_NETWORK_FAILED')));req.end(bytes);
   });
 }
 async replies(page:number){
  const bduss=await this.bduss();if(!bduss)throw new FishError('TIEBA_LOGIN_REQUIRED');
  const request=replyRequest(bduss,page),response=await this.request('https://tiebac.baidu.com/c/u/feed/replyme?cmd=303007',request.body,request.type) as {bytes:Buffer};
  return replyPage(response.bytes,page);
 }
 async followed(userId:string):Promise<FollowedForum[]>{const poster=await this.accountPoster();if(!poster)throw new FishError('TIEBA_LOGIN_REQUIRED');return followedForums(poster,userId);}
 async deletion(postId:string,threadId:string):Promise<SystemDeletion|null>{
  if(!/^[1-9]\d{0,19}$/.test(postId)||! /^[1-9]\d{0,19}$/.test(threadId))throw new FishError('TIEBA_POST_ID_REQUIRED');
  await this.navigate('https://tieba.baidu.com/pmc/recycle');
  let opened=false;
  for(let i=0;i<12;i++){opened=await this.evaluate(`(()=>{const t=document.querySelector('li[data-type="system"]');if(!t)return false;t.click();return true;})()`);if(opened)break;await sleep(250);}
  if(!opened)throw new FishError('TIEBA_DELETION_STATE_UNAVAILABLE');await sleep(1800);
  const result=await this.evaluate(`(()=>{if(new URL(location.href).searchParams.get('tab')!=='system')return {ready:false};const rows=Array.from(document.querySelectorAll('a[href*="/pmc/post/appeal?"]')).map(a=>{const u=new URL(a.href),cells=Array.from(a.closest('tr')?.querySelectorAll('td')||[]).map(e=>e.textContent.trim());return {postId:u.searchParams.get('pid'),threadId:u.searchParams.get('tid'),reason:([...cells].reverse().find(s=>/被系统删除/.test(s))||'').slice(0,600),time:(cells.find(s=>/^\\d{4}-\\d{2}-\\d{2} /.test(s))||'').slice(0,40)};});return {ready:/全部记录/.test(document.body?.innerText||''),rows};})()`);
  if(!result?.ready)throw new FishError('TIEBA_DELETION_STATE_UNAVAILABLE');
  const found=result.rows?.find((r:any)=>r.postId===postId&&r.threadId===threadId);if(!found)return null;
  if(!found.reason)throw new FishError('TIEBA_DELETION_STATE_UNAVAILABLE');
  return {...found,source:'tieba_account_recycle',category:'system',timeZone:'Asia/Hong_Kong'};
 }
 async sendPost(request:ReturnType<typeof postingRequest>){
  const poster=await this.accountPoster(true);if(!poster)throw new FishError('TIEBA_LOGIN_REQUIRED');
  const auth=await poster('https://tiebac.baidu.com/c/s/login',new URLSearchParams({_client_type:'2',_client_version:'12.64.1.1'}));
  let login:any;try{login=JSON.parse(auth.bytes.toString());}catch{throw new FishError('TIEBA_IDENTITY_FORMAT_CHANGED');}
  if(!['0',0].includes(login?.error_code)||typeof login?.anti?.tbs!=='string')throw new FishError('TIEBA_LOGIN_REQUIRED');
  if(request.protocol==='app_protobuf'){
   const bduss=await this.bduss();if(!bduss)throw new FishError('TIEBA_LOGIN_REQUIRED');
   return sendAppReply(request,{bduss,tbs:login.anti.tbs,nameShow:typeof login.user?.name_show==='string'?login.user.name_show:undefined},(url,body,type)=>this.request(url,body,type,undefined,'aiotieba/4.8.1',true));
  }
  if(request.protocol!=='legacy_thread_form'||request.action!=='thread'||request.url!=='https://tiebac.baidu.com/c/c/thread/add')throw new FishError('TIEBA_POST_TRANSPORT_INVALID');
  const result=await poster(request.url,new URLSearchParams({...request.fields,tbs:login.anti.tbs}));
  let d:any;try{d=JSON.parse(result.bytes.toString());}catch{throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');}
  if(d?.need_vcode||d?.anti?.need_vcode)throw new FishError('TIEBA_PUBLICATION_CHALLENGE');
  if(!['0',0].includes(d?.error_code))throw new FishError('TIEBA_PUBLICATION_REJECTED');
  const thread=request.url.endsWith('/thread/add'),id=String(thread?(d.thread?.id??d.thread_id??d.tid??d.data?.tid??d.data?.thread_id??d.thread_info?.thread_id??''):(d.post?.id??d.post_id??d.pid??d.data?.pid??d.data?.post_id??''));
  if(!/^[1-9]\d{0,19}$/.test(id))throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');
  const receipt:Record<string,unknown>={errorCode:d.error_code};
  for(const k of ['is_audit','audit_status','is_post_visible','need_vcode','is_posted']){
   const v=d[k]??d.post?.[k]??d.thread?.[k];if(typeof v==='boolean'||typeof v==='number'||typeof v==='string'&&/^[0-9_-]{1,24}$/.test(v))receipt[k]=v;
  }
  return {id,url:'https://tieba.baidu.com/p/'+(thread?id:request.fields.tid)+(thread?'':'?pid='+id+'#'+id),receipt};
 }
 async read(url:string){
  const poster=await this.accountPoster();if(!poster)throw new FishError('TIEBA_LOGIN_REQUIRED');
  const result=await tiebaPage(url,poster);if(!result)throw new FishError('TIEBA_READ_TARGET_DENIED');return result;
 }
 async close(){
  if(this.closed)return;this.closed=true;clearTimeout(this.deadline);
  if(this.child.exitCode===null&&this.child.pid){
   const exited=once(this.child,'exit').catch(()=>{});
   await this.pipe.call('Browser.close',{},undefined,1500).catch(()=>{});
   await Promise.race([exited,sleep(1200)]);
   if(this.child.exitCode===null){try{process.kill(-this.child.pid,'SIGKILL');}catch{}await Promise.race([exited,sleep(1000)]);}
  }
 }
}
