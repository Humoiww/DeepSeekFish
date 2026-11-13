import fs from 'node:fs';
import {spawn,type ChildProcess} from 'node:child_process';
import https from 'node:https';
import dns from 'node:dns/promises';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {followedForums,type FollowedForum,postingRequest} from '../tieba/posting.js';
import {Pipe} from './cdp.js';
import {FishError} from '../types.js';
import type {AccountBrowser,TiebaIdentity,LoginInput} from '../tieba/session.js';
import {tiebaPage} from '../search/tieba.js';
import {publicAddress,type PublicPoster} from '../search/public-web.js';

const HOME='https://tieba.baidu.com/';
export const LOGIN='https://passport.baidu.com/v2/?login&tpl=tb&u='+encodeURIComponent(HOME);
export function baiduResource(raw:string){
 try{const u=new URL(raw);return u.protocol==='about:'&&u.href==='about:blank'||['data:','blob:'].includes(u.protocol)||u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(['ppui-static-pc.cdn.bcebos.com','hercules.cdn.bcebos.com'].includes(u.hostname)||['baidu.com','bdstatic.com','bdimg.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)));}catch{return false;}
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
 private constructor(private child:ChildProcess,private profile:string){
  this.pipe=new Pipe(child,baiduResource);
  this.deadline=setTimeout(()=>{void this.close();},15*60000);this.deadline.unref();
  this.pipe.onEvent=e=>{
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
 async identity(){
  const poster=await this.accountPoster();return poster?verifyIdentity(poster):null;
 }
 async frame(){const r=await this.pipe.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},await this.session());if(typeof r.data!=='string'||r.data.length>8000000)throw new FishError('TIEBA_FRAME_INVALID');return Buffer.from(r.data,'base64');}
 async input(v:LoginInput){
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
 private async accountPoster(writing=false):Promise<PublicPoster|null>{
  // The normalizer chooses three read-only endpoints, never a supplied action.
  const cookies=await this.pipe.call('Storage.getCookies');
  const cookie=(name:string)=>cookies.cookies?.find((c:any)=>c.name===name&&['baidu.com','.baidu.com','tieba.baidu.com','.tieba.baidu.com'].includes(c.domain))?.value;
  const bduss=cookie('BDUSS');if(typeof bduss!=='string'||!bduss)return null;
  const poster:PublicPoster=async(raw,body,signal)=>{
   const u=new URL(raw);if(u.origin!=='https://tiebac.baidu.com'||!['/c/f/frs/page','/c/f/pb/page','/c/f/pb/floor','/c/s/login','/c/f/forum/like',...(writing?['/c/c/thread/add','/c/c/post/add']:[])].includes(u.pathname)||u.search)throw new FishError('TIEBA_READ_TARGET_DENIED');
   const fields=Object.fromEntries(body);delete fields.sign;if(u.pathname==='/c/s/login')fields.bdusstoken=bduss;else fields.BDUSS=bduss;
   const privateBody=new URLSearchParams(fields);privateBody.set('sign',createHash('md5').update(Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('')+'tiebaclient!!!').digest('hex'));
   const addresses=await dns.lookup(u.hostname,{all:true});if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new FishError('TIEBA_PRIVATE_ADDRESS');const address=addresses.find(a=>a.family===4)??addresses[0];
   const bytes=Buffer.from(privateBody.toString());
   return new Promise((resolve,reject)=>{
    const req=https.request(u,{method:'POST',agent:false,signal:AbortSignal.any([AbortSignal.timeout(20000),...(signal?[signal]:[])]),maxVersion:'TLSv1.2',headers:{'content-type':'application/x-www-form-urlencoded','content-length':bytes.length,'user-agent':'bdtb for Android 12.64.1.1'},lookup:((_host:any,opts:any,cb:any)=>opts.all?cb(null,[address]):cb(null,address.address,address.family)) as any},res=>{
     if(res.statusCode!==200){res.destroy();reject(new FishError('TIEBA_READ_HTTP_'+res.statusCode));return;}
     const parts:Buffer[]=[];let size=0;res.on('data',(b:Buffer)=>{size+=b.length;if(size>2097152)res.destroy(new FishError('TIEBA_READ_LIMIT'));else parts.push(b);});res.on('error',reject);res.on('end',()=>resolve({url:raw,type:'application/json',bytes:Buffer.concat(parts)}));
    });req.on('error',()=>reject(new FishError('TIEBA_READ_NETWORK_FAILED')));req.end(bytes);
   });
  };
  return poster;
 }
 async followed(userId:string):Promise<FollowedForum[]>{const poster=await this.accountPoster();if(!poster)throw new FishError('TIEBA_LOGIN_REQUIRED');return followedForums(poster,userId);}
 async sendPost(request:ReturnType<typeof postingRequest>){
  const poster=await this.accountPoster(true);if(!poster)throw new FishError('TIEBA_LOGIN_REQUIRED');
  const auth=await poster('https://tiebac.baidu.com/c/s/login',new URLSearchParams({_client_type:'2',_client_version:'12.64.1.1'}));
  let login:any;try{login=JSON.parse(auth.bytes.toString());}catch{throw new FishError('TIEBA_IDENTITY_FORMAT_CHANGED');}
  if(!['0',0].includes(login?.error_code)||typeof login?.anti?.tbs!=='string')throw new FishError('TIEBA_LOGIN_REQUIRED');
  const result=await poster(request.url,new URLSearchParams({...request.fields,tbs:login.anti.tbs}));
  let d:any;try{d=JSON.parse(result.bytes.toString());}catch{throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');}
  if(d?.need_vcode||d?.anti?.need_vcode)throw new FishError('TIEBA_PUBLICATION_CHALLENGE');
  if(!['0',0].includes(d?.error_code))throw new FishError('TIEBA_PUBLICATION_REJECTED');
  const thread=request.url.endsWith('/thread/add'),id=String(thread?(d.thread?.id??d.thread_id??d.tid??d.data?.tid??d.data?.thread_id??d.thread_info?.thread_id??''):(d.post?.id??d.post_id??d.pid??d.data?.pid??d.data?.post_id??''));
  if(!/^[1-9]\d{0,19}$/.test(id))throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');
  return {id,url:'https://tieba.baidu.com/p/'+(thread?id:request.fields.tid)+(thread?'':'?pid='+id+'#'+id)};
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
