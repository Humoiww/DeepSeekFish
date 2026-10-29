import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn,type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

const base='/srv/deepseekfish/capture',browser=base+'/browser/chrome-headless-shell';
const allowed=(raw:string)=>{try{const u=new URL(raw);return ['about:','data:','blob:'].includes(u.protocol)||u.protocol==='https:'&&(u.hostname==='aegis.cdn-go.cn'||['qq.com','qpic.cn','qlogo.cn','gtimg.cn','gtimg.com','idqqimg.com','tencent.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)));}catch{return false;}};
class Pipe {
  onEvent?:(event:any)=>void;
  private seq=0;private buffer='';private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  constructor(private child:ChildProcess){
    const decoder=new StringDecoder('utf8');
    (child.stdio[4] as NodeJS.ReadableStream).on('data',(bytes:Buffer)=>{
      this.buffer+=decoder.write(bytes);if(this.buffer.length>24000000){child.kill('SIGKILL');return;}
      for(let i;(i=this.buffer.indexOf('\0'))>=0;){const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);let p:any;try{p=JSON.parse(line);}catch{continue;}
        if(p.id){const pending=this.pending.get(p.id);if(pending){this.pending.delete(p.id);p.error?pending.reject(Error('CAPTURE_PROTOCOL_FAILED')):pending.resolve(p.result);}}
        else {this.onEvent?.(p);if(p.method==='Fetch.requestPaused')void this.call(allowed(p.params.request.url)?'Fetch.continueRequest':'Fetch.failRequest',allowed(p.params.request.url)?{requestId:p.params.requestId}:{requestId:p.params.requestId,errorReason:'BlockedByClient'},p.sessionId).catch(()=>{});}
      }
    });
    child.on('exit',()=>{for(const p of this.pending.values())p.reject(Error('CAPTURE_BROWSER_EXIT'));this.pending.clear();});
  }
  call(method:string,params:Record<string,unknown>={},sessionId?:string):Promise<any>{
    const id=++this.seq;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});(this.child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});
  }
}
async function capture(uin:string,cookie:string){
  const dir=fs.mkdtempSync(base+'/state/job-');let child:ChildProcess|undefined,timer:NodeJS.Timeout|undefined;
  try{
    child=spawn(browser,['--headless','--disable-gpu','--disable-background-networking','--disable-component-update','--no-first-run','--disable-sync','--password-store=basic','--remote-debugging-pipe','--user-data-dir='+dir,'about:blank'],{stdio:['ignore','ignore','pipe','pipe','pipe'],detached:true,env:{PATH:'/usr/bin:/bin',HOME:base+'/state',TMPDIR:'/tmp',LANG:'C.UTF-8'}});
    child.on('error',()=>{});(child.stderr as NodeJS.ReadableStream).on('data',()=>{});
    timer=setTimeout(()=>{try{process.kill(-child!.pid!,'SIGKILL');}catch{}},22000);
    const rpc=new Pipe(child),failed:string[]=[],blocked:string[]=[];
    rpc.onEvent=p=>{if(p.method==='Network.loadingFailed'&&failed.length<20)failed.push(p.params.errorText);if(p.method==='Fetch.requestPaused'&&!allowed(p.params.request.url)&&blocked.length<20){try{const u=new URL(p.params.request.url);blocked.push(u.origin+u.pathname);}catch{}}};
    const {targetId}=await rpc.call('Target.createTarget',{url:'about:blank'}),{sessionId}=await rpc.call('Target.attachToTarget',{targetId,flatten:true});
    await rpc.call('Page.enable',{},sessionId);await rpc.call('Network.enable',{},sessionId);
    await rpc.call('Network.setUserAgentOverride',{userAgent:'Mozilla/5.0 (X11; Linux '+(process.arch==='arm64'?'aarch64':'x86_64')+') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',acceptLanguage:'zh-CN,zh;q=0.9'},sessionId);
    await rpc.call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},sessionId);
    await rpc.call('Emulation.setDeviceMetricsOverride',{width:1200,height:1500,deviceScaleFactor:1,mobile:false},sessionId);
    const cookies=cookie.split(';').map(v=>{const i=v.indexOf('=');return {name:v.slice(0,i).trim(),value:v.slice(i+1).trim()};}).filter(v=>['uin','skey','p_uin','p_skey','pt4_token','ptcz'].includes(v.name)).map(v=>({...v,domain:'.qzone.qq.com',path:'/',secure:true}));
    await rpc.call('Network.setCookies',{cookies},sessionId);
    await rpc.call('Page.navigate',{url:'https://user.qzone.qq.com/'+uin+'/311'},sessionId);
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
    return {png:image.data,page:{title:String(page.title??'').slice(0,200),text:String(page.text??'').slice(0,10000),url:'https://user.qzone.qq.com/'+uin+'/311'},diagnostics:{frames:page.frames,frameTextLengths:frameTexts.map(t=>t.length),failed,blocked},sandboxEnabled:true};
  }finally{
    clearTimeout(timer);if(child?.pid){const ended=once(child,'exit').catch(()=>{});try{process.kill(-child.pid,'SIGTERM');}catch{};await Promise.race([ended,new Promise(resolve=>setTimeout(resolve,500))]);try{process.kill(-child.pid,'SIGKILL');}catch{}}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
if(process.env.LISTEN_PID!==String(process.pid)||process.env.LISTEN_FDS!=='1')throw Error('CAPTURE_SOCKET_REQUIRED');
let busy=false;
const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  try{
    if(req.method!=='POST'||req.url!=='/capture'){res.writeHead(404);res.end('{}');return;}
    if(busy){res.writeHead(429);res.end('{"error":"CAPTURE_BUSY"}');return;}
    let body='';for await(const b of req){body+=b;if(Buffer.byteLength(body)>16384)throw Error('CAPTURE_INPUT_LIMIT');}
    const input=JSON.parse(body);if(!/^[1-9]\d{4,19}$/.test(input.uin)||typeof input.cookie!=='string'||input.cookie.length>12000||/[\r\n\0]/.test(input.cookie))throw Error('CAPTURE_INPUT_INVALID');
    busy=true;try{res.end(JSON.stringify(await capture(input.uin,input.cookie)));}finally{busy=false;}
  }catch{if(!res.headersSent)res.writeHead(502);res.end('{"error":"CAPTURE_FAILED"}');}
});
server.requestTimeout=30000;server.headersTimeout=5000;server.listen({fd:3},()=>console.log('Private Qzone screenshot service ready; Chromium sandbox enabled.'));
