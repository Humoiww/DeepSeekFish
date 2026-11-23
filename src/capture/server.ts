import {toolFailure} from '../agent/tool-feedback.js';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {Pipe} from './cdp.js';
import {TiebaSessionManager} from '../tieba/session.js';
import {TiebaBrowser} from './tieba-browser.js';
import {TiebaOperationQueue} from '../tieba/queue.js';
import {publishInput} from '../tieba/posting.js';
import {FishError} from '../types.js';
import {stageTiebaImage,tiebaImageId,TIEBA_IMAGE_BYTES} from '../tieba/images.js';

const base='/srv/deepseekfish/capture',browser=base+'/browser/chrome-headless-shell';
const allowed=(raw:string)=>{try{const u=new URL(raw);return ['about:','data:','blob:'].includes(u.protocol)||u.protocol==='https:'&&(u.hostname==='aegis.cdn-go.cn'||['qq.com','qpic.cn','qlogo.cn','gtimg.cn','gtimg.com','idqqimg.com','tencent.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)));}catch{return false;}};
async function capture(uin:string,cookie:string,postId?:string){
  const dir=fs.mkdtempSync(base+'/state/job-');let child:ChildProcess|undefined,timer:NodeJS.Timeout|undefined;
  try{
    child=spawn(browser,['--headless','--disable-gpu','--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync','--password-store=basic','--remote-debugging-pipe','--user-data-dir='+dir,'about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe'],detached:true,env:{PATH:'/usr/bin:/bin',HOME:base+'/state',TMPDIR:'/tmp',LANG:'C.UTF-8'}});
    child.on('error',()=>{});(child.stderr as NodeJS.ReadableStream).on('data',()=>{});
    timer=setTimeout(()=>{try{process.kill(-child!.pid!,'SIGKILL');}catch{}},22000);
    const rpc=new Pipe(child,allowed),failed:string[]=[],blocked:string[]=[];
    rpc.onEvent=p=>{if(p.method==='Network.loadingFailed'&&failed.length<20)failed.push(p.params.errorText);if(p.method==='Fetch.requestPaused'&&!allowed(p.params.request.url)&&blocked.length<20){try{const u=new URL(p.params.request.url);blocked.push(u.origin+u.pathname);}catch{}}};
    const {targetId}=await rpc.call('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc.call('Target.attachToTarget',{targetId,flatten:true});
    await rpc.call('Page.enable',{},sessionId);await rpc.call('Network.enable',{},sessionId);
    await rpc.call('Network.setUserAgentOverride',{userAgent:'Mozilla/5.0 (X11; Linux '+(process.arch==='arm64'?'aarch64':'x86_64')+') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',acceptLanguage:'zh-CN,zh;q=0.9'},sessionId);
    await rpc.call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},sessionId);
    await rpc.call('Emulation.setDeviceMetricsOverride',{width:1200,height:1500,deviceScaleFactor:1,mobile:false},sessionId);
    const cookies=cookie.split(';').map(v=>{const i=v.indexOf('=');return {name:v.slice(0,i).trim(),value:v.slice(i+1).trim()};}).filter(v=>['uin','skey','p_uin','p_skey','pt4_token','ptcz'].includes(v.name)).map(v=>({...v,domain:'.qzone.qq.com',path:'/',secure:true}));
    await rpc.call('Network.setCookies',{cookies},sessionId);
    const pageUrl='https://user.qzone.qq.com/'+uin+(postId?'/mood/'+encodeURIComponent(postId):'/311');
    await rpc.call('Page.navigate',{url:pageUrl},sessionId);
    await new Promise(resolve=>setTimeout(resolve,14500));
    const frameTexts:string[]=[],tree=await rpc.call('Page.getFrameTree',{},sessionId);
    for(const frame of (tree.frameTree?.childFrames??[]).slice(0,3)){
      try{const world=await rpc.call('Page.createIsolatedWorld',{frameId:frame.frame.id,worldName:'snapshot-reader'},sessionId);
        const text=await rpc.call('Runtime.evaluate',{expression:'document.body?.innerText?.slice(0,8000)||""',contextId:world.executionContextId,returnByValue:true},sessionId);
        frameTexts.push(String(text.result?.value??''));
      }catch{}
    }
    await rpc.call('Runtime.evaluate',{expression:'(()=>{const f=document.getElementById("app_canvas_frame");if(f)f.style.minHeight="1100px";})()'},sessionId);
    const {result}=await rpc.call('Runtime.evaluate',{expression:'JSON.stringify({title:document.title,text:document.body.innerText.slice(0,10000),frames:Array.from(document.querySelectorAll("iframe")).map(f=>({id:f.id,url:new URL(f.src||"about:blank").origin+new URL(f.src||"about:blank").pathname}))})',returnByValue:true},sessionId);
    const page=JSON.parse(result?.value??'{}');page.text=[page.text,...frameTexts].join('\n');
    const image=await rpc.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},sessionId);
    if(typeof image.data!=='string'||image.data.length>12000000)throw Error('CAPTURE_IMAGE_LIMIT');
    // Do not return cookies, headers, CDP events or a persisted browser profile.
    return {png:image.data,page:{title:String(page.title??'').slice(0,200),text:String(page.text??'').slice(0,10000),url:pageUrl},diagnostics:{frames:page.frames,frameTextLengths:frameTexts.map(t=>t.length),failed,blocked},sandboxEnabled:true};
  }finally{
    clearTimeout(timer);if(child?.pid){const ended=once(child,'exit').catch(()=>{});try{process.kill(-child.pid,'SIGTERM');}catch{};await Promise.race([ended,new Promise(resolve=>setTimeout(resolve,500))]);try{process.kill(-child.pid,'SIGKILL');}catch{}}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
if(process.env.LISTEN_PID!==String(process.pid)||process.env.LISTEN_FDS!=='1')throw Error('CAPTURE_SOCKET_REQUIRED');
const tieba=new TiebaSessionManager('/srv/deepseekfish/app/runtime/tieba-account',(profile,signal)=>TiebaBrowser.open(profile,undefined,signal));
// The original screenshot worker also runs without a Tieba installation.
// Its writable state directory can hold unconfigured-operation diagnostics.
const operations=new TiebaOperationQueue(fs.existsSync('/srv/deepseekfish/app/runtime/tieba-account')?'/srv/deepseekfish/app/runtime/tieba-account':base+'/state/tieba-queue',{
 describe:()=>tieba.timeoutInfo(),cancel:()=>tieba.cancelTimedOutOperation(),restart:()=>{setTimeout(()=>process.exit(1),100).unref();}
});
tieba.setIdleClose(()=>operations.enqueue('close',{source:'idle'},async()=>{const s=tieba.status();if(s.waitingUntil&&s.waitingUntil<=Date.now()&&!s.interaction)await tieba.close();}));
async function dispatchTieba(action:string,input:any):Promise<any>{
 if(action==='account')return tieba.account();
 if(action==='verify')return tieba.verifyPublication(input.requestId);
 if(action==='history')return tieba.postingHistory(input.offset??0);
 if(action==='queue')return operations.snapshot(input.offset??0,input.activeOnly??false,input.replies??false,input.selectedId);
 if(action==='replies')return tieba.replies(input.page);
 if(action==='mentions')return tieba.mentions(input.page);
 if(action==='publish')return tieba.publish(input.input,input.requestId,input.authorizedRetryOf);
 if(action==='moderator')return tieba.moderator(input.input,input.requestId);
 if(action==='status')return tieba.status();
 if(action==='start')return tieba.start();
 if(action==='check')return tieba.check();
 if(action==='publication-start')return tieba.startPublication(input.requestId);
 if(action==='publication-submit')return tieba.submitPublication();
 if(action==='publication-check')return tieba.checkPublication();
 if(action==='logout')return tieba.logout();
 if(action==='close'){await tieba.close();return {...tieba.status(),closed:true};}
 if(action==='frame')return {png:(await tieba.frame()).toString('base64')};
 if(action==='publication-frame'){const frame=await tieba.publicationFrame(input.requestId);return {png:frame.bytes.toString('base64'),requestId:frame.requestId,at:frame.at};}
 if(action==='publication-evidence')return {png:tieba.publicationEvidence(input.requestId,input.id).toString('base64'),requestId:input.requestId,at:Date.now()};
 if(action==='input'){const {requestId,scene,...gesture}=input;return tieba.input(gesture);}
 if(action==='read')return tieba.read(input.url);
 throw new FishError('TIEBA_ACTION_DENIED');
}
operations.restore((payload,signal)=>tieba.withOperationSignal(signal,()=>dispatchTieba('publish',payload)));
process.on('SIGTERM',()=>{operations.stop();server.close();void operations.drained().then(()=>tieba.close(true)).finally(()=>{operations.close();process.exit(0);});setTimeout(()=>{void tieba.close(true).finally(()=>process.exit(1));},45000).unref();});
let busy=false;
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  const streaming=req.headers['x-fish-queue-wait']==='1';let heartbeat:NodeJS.Timeout|undefined;
  try{
    if(req.method!=='POST'||req.url!=='/capture'&&!req.url?.startsWith('/tieba/')){res.writeHead(404);res.end('{}');return;}
    if(busy&&req.url==='/capture'){res.writeHead(429);res.end('{"error":"CAPTURE_BUSY"}');return;}
    if(req.url==='/tieba/stage-image'){
      const wire=req.headers['x-fish-image-metadata'],size=Number(req.headers['content-length']);
      if(typeof wire!=='string'||wire.length>1024||!Number.isSafeInteger(size)||size<12||size>TIEBA_IMAGE_BYTES||req.headers['content-type']!=='application/octet-stream')throw new FishError('TIEBA_IMAGE_INPUT_INVALID');
      const meta=JSON.parse(Buffer.from(wire,'base64url').toString());
      if(typeof meta?.requestId!=='string'||!meta.requestId||meta.requestId.length>240||!tiebaImageId(meta.imageId))throw new FishError('TIEBA_IMAGE_INPUT_INVALID');
      const chunks:Buffer[]=[];let used=0;
      for await(const part of req){used+=part.length;if(used>size)throw new FishError('TIEBA_IMAGE_INPUT_INVALID');chunks.push(part);}
      if(used!==size)throw new FishError('TIEBA_IMAGE_INPUT_INVALID');
      const staged=stageTiebaImage('/srv/deepseekfish/app/runtime/tieba-account',meta.requestId,meta.imageId,Buffer.concat(chunks,used));
      res.end(JSON.stringify({rpcVersion:1,value:staged}));return;
    }
    let body='';for await(const b of req){body+=b;if(Buffer.byteLength(body)>16384)throw Error('CAPTURE_INPUT_LIMIT');}
    const input=JSON.parse(body);
    if(req.url?.startsWith('/tieba/')){
      let value:unknown;
      const action=req.url.slice(7);
      if(!input||Array.isArray(input)||typeof input!=='object')throw new FishError('TIEBA_INPUT_INVALID');
      if(!['input','read','publish','replies','mentions','verify','publication-start','publication-submit','publication-frame','publication-evidence','moderator','queue','history'].includes(action)&&Object.keys(input).length)throw new FishError('TIEBA_INPUT_INVALID');
      const allowed:Record<string,string[]>={'publication-start':['requestId'],'publication-submit':['requestId'],queue:['offset','activeOnly','replies','selectedId'],history:['offset'],verify:['requestId'],replies:['page'],mentions:['page'],publish:['input','requestId','authorizedRetryOf'],moderator:['input','requestId'],read:['url'], 'publication-frame':['requestId'],'publication-evidence':['requestId','id']};
      if(allowed[action]&&Object.keys(input).some(k=>!allowed[action].includes(k)))throw new FishError('TIEBA_INPUT_INVALID');
      if(['input','publication-start','publication-submit'].includes(action)&&input.requestId!==undefined&&(typeof input.requestId!=='string'||!input.requestId||input.requestId.length>240))throw new FishError('TIEBA_REQUEST_ID_INVALID');
      if(action==='input'&&input.scene!==undefined&&(typeof input.scene!=='string'||!input.scene||input.scene.length>64))throw new FishError('TIEBA_INPUT_INVALID');
      if(['queue','history'].includes(action)&&input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||input.offset<0||input.offset>100000))throw new FishError('TIEBA_INPUT_INVALID');
      if(action==='queue'&&input.activeOnly!==undefined&&typeof input.activeOnly!=='boolean')throw new FishError('TIEBA_INPUT_INVALID');
      if(action==='queue'&&input.replies!==undefined&&typeof input.replies!=='boolean')throw new FishError('TIEBA_INPUT_INVALID');
      if(action==='queue'&&input.selectedId!==undefined&&(typeof input.selectedId!=='string'||!input.selectedId||input.selectedId.length>240))throw new FishError('TIEBA_INPUT_INVALID');
      if(action==='publish'){input.input=publishInput(input.input);if(typeof input.requestId!=='string'||!input.requestId||input.requestId.length>240)throw new FishError('TIEBA_REQUEST_ID_INVALID');}
      if(['status','history','queue','publication-evidence'].includes(action))value=await dispatchTieba(action,input);
      else {
       const s=tieba.status(),work=s.interaction==='application'?s.moderatorWork:s.publicationWork;
       const selectRecord=action==='publication-start'&&input.requestId!==undefined;
       const pinned=selectRecord?undefined:['publication-submit','input','publication-frame'].includes(action)&&input.requestId?input.requestId:
        ['publication-start','publication-submit','publication-check','input','frame','close'].includes(action)?work?.requestId:undefined;
       const sceneBound=['input','frame','publication-frame','close','publication-submit'].includes(action),scene=input.scene??s.browserScene;
       const livePointer=action==='input'&&(input.kind==='pointer_down'||input.kind==='pointer_move');
       if(livePointer){
        const current=tieba.status(),active=current.interaction==='application'?current.moderatorWork:current.publicationWork;
        if(current.browserScene!==scene||pinned&&active?.requestId!==pinned)throw new FishError('TIEBA_PUBLICATION_WINDOW_CHANGED');
        value=await dispatchTieba(action,input);
       }else{
        const metadata:Record<string,unknown>={...(input.requestId?{requestId:input.requestId}:pinned?{requestId:pinned}:{}),...(action==='publish'?{...input.input}:action==='publication-submit'||action==='publication-start'&&!selectRecord?s.publicationWork?.input??{}:{})};
        if(action==='input'&&s.interaction==='publication'&&['prepared','challenge'].includes(s.publicationWork?.stage??'')&&(input.kind==='click'||input.kind==='key'&&input.key==='Enter'))metadata.publicationInput=true;
        if(action==='read'){try{const u=new URL(input.url);metadata.target=u.origin+u.pathname;}catch{}}
        if(action==='moderator')metadata.forumId=input.input?.forumId;
        if(streaming){heartbeat=setInterval(()=>{if(!res.destroyed)res.write(' ');},5000);heartbeat.unref();res.on('close',()=>clearInterval(heartbeat));}
        value=await operations.enqueue(action,metadata,signal=>tieba.withOperationSignal(signal,async()=>{
         const current=tieba.status(),active=current.interaction==='application'?current.moderatorWork:current.publicationWork;
         if(sceneBound&&current.browserScene!==scene||pinned&&active?.requestId!==pinned){
          // A queued close belongs to the old window. If it has already ended,
          // there is nothing to close; never close a later user's new page.
          if(action==='close')return {...current,closed:false,closeReason:'window_changed',notice:'原窗口已结束或切换，本次关闭已跳过，当前窗口未被关闭。'};
          throw new FishError('TIEBA_PUBLICATION_WINDOW_CHANGED');
         }
         return dispatchTieba(action,input);
        }),{...(action==='publish'?{payload:input,key:'publish:'+input.requestId}:['frame','publication-frame'].includes(action)?{key:action+':'+(pinned??'login')}:{})});
       }
      }
      clearInterval(heartbeat);if(!res.destroyed)res.end(JSON.stringify(streaming?{rpcVersion:1,value}:value));return;

    }
    if(!/^[1-9]\d{4,19}$/.test(input.uin)||typeof input.cookie!=='string'||input.cookie.length>12000||/[\r\n\0]/.test(input.cookie))throw Error('CAPTURE_INPUT_INVALID');
    if(input.postId!==undefined&&(typeof input.postId!=='string'||!/^[a-zA-Z0-9._-]{1,120}$/.test(input.postId)))throw Error('CAPTURE_INPUT_INVALID');
    busy=true;try{res.end(JSON.stringify(await capture(input.uin,input.cookie,input.postId)));}finally{busy=false;}
  }catch(e){clearInterval(heartbeat);if(!res.headersSent)res.writeHead(502);const code=e instanceof Error&&/^TIEBA_[A-Z_0-9]+$/.test(e.message)?e.message:'CAPTURE_FAILED';if(!res.destroyed)res.end(JSON.stringify(streaming?{rpcVersion:1,error:code,feedback:toolFailure(e,'capture_worker')}:{error:code}));}
});
server.requestTimeout=0;server.headersTimeout=5000;server.listen({fd:3},()=>console.log('Private Qzone screenshot service ready; Chromium sandbox enabled.'));
