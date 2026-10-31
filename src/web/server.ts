import fs from 'node:fs';
import { createServer,type IncomingMessage } from 'node:http';
import { randomBytes,timingSafeEqual } from 'node:crypto';
import { safePath } from '../paths.js';
import { FishError,codeOf } from '../types.js';
import type { WebApp } from './app.js';

async function body(req:IncomingMessage):Promise<any>{
  const chunks:Buffer[]=[];let length=0;
  for await(const part of req){length+=part.length;if(length>32768)throw new FishError('BODY_LIMIT');chunks.push(part);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}
  catch{throw new FishError('INVALID_JSON');}
}
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function webServer(app:WebApp,port=17862,onStop:()=>void=()=>{}){
  let bootstrap=randomBytes(32).toString('hex'),expires=Date.now()+300000;
  const origin=`http://127.0.0.1:${port}`;
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
    try{
      if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')||req.headers.host!==`127.0.0.1:${port}`||
        req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){
        res.statusCode=403;throw new FishError('LOCAL_ONLY');
      }
      const url=new URL(req.url??'/',origin);
      const assets:Record<string,[string,string]>={'/':['index.html','text/html'],'/web.css':['web.css','text/css'],'/web.js':['web.js','text/javascript'],'/fish.svg':['fish.svg','image/svg+xml']};
      if(req.method==='GET'&&assets[url.pathname]){
        const [name,type]=assets[url.pathname];res.setHeader('Content-Type',type+'; charset=utf-8');
        res.end(fs.readFileSync(safePath(app.root,'src/web/public/'+name)));return;
      }
      res.setHeader('Content-Type','application/json; charset=utf-8');
      if(req.method==='POST'&&url.pathname==='/api/bootstrap'){
        const b=await body(req);
        if(!bootstrap||Date.now()>expires||typeof b.code!=='string'||!equal(b.code,bootstrap)){res.statusCode=401;throw new FishError('BOOTSTRAP_EXPIRED');}
        bootstrap='';res.end(JSON.stringify({token:app.token}));return;
      }
      if(!equal(req.headers.authorization??'','Bearer '+app.token)){res.statusCode=401;throw new FishError('LOCAL_AUTH_REQUIRED');}
      let value:unknown;
      if(req.method==='GET'&&url.pathname==='/api/status')value=app.status();
      else if(req.method==='GET'&&url.pathname==='/api/persona')value=app.persona();
      else if(req.method==='GET'&&url.pathname==='/api/prompts')value=app.prompts();
      else if(req.method==='GET'&&url.pathname==='/api/qq')value=await app.qqStatus();
      else if(req.method==='GET'&&url.pathname==='/api/sessions')value=app.sessions();
      else if(req.method==='GET'&&url.pathname==='/api/session')value=app.detail(url.searchParams.get('id'));
      else if(req.method==='GET'&&url.pathname==='/api/image'){
        const image=app.image(url.searchParams.get('sessionId'),url.searchParams.get('id'));
        res.setHeader('Content-Type','image/png');res.setHeader('Content-Disposition','inline; filename="image.png"');
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.end(image);return;
      }
      else if(req.method==='GET'&&url.pathname==='/api/file'){
        const workspace=app.workspace(url.searchParams.get('id')),name=url.searchParams.get('path')??'';
        const content=workspace.read(name);res.setHeader('Content-Type','text/plain; charset=utf-8');
        res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(name.split('/').at(-1)!));
        res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.end(content);return;
      }else if(req.method==='POST'){
        const b=await body(req);
        if(url.pathname==='/api/sessions')value=app.createSession();
        else if(url.pathname==='/api/open'){
          bootstrap=randomBytes(32).toString('hex');expires=Date.now()+300000;
          value={launchUrl:origin+'/#bootstrap='+bootstrap,mock:app.mock};
        }
        else if(url.pathname==='/api/persona')value=app.savePersona(b);
        else if(url.pathname==='/api/settings')value=app.configure(b);
        else if(url.pathname==='/api/qq')value=app.configureQQ(b);
        else if(url.pathname==='/api/codex-quota/refresh')value=await app.refreshQuota();
        else if(url.pathname==='/api/images/reset')value=app.resetImages();
        else if(url.pathname==='/api/chat'){
          const abort=new AbortController();
          const disconnected=()=>{if(!res.writableEnded)abort.abort();};res.once('close',disconnected);
          let started=false;
          try{
            await app.chat(b.sessionId,b.text,b.mode,abort.signal,event=>{
              if(res.destroyed)return;
              if(!started){res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');res.flushHeaders();started=true;}
              res.write(JSON.stringify(event)+'\n');
            },b.imageConfirmed===true);res.end();return;
          }finally{res.removeListener('close',disconnected);}
        }else if(url.pathname==='/api/approve'){
          if(b.reviewed!==true||typeof b.id!=='string'||req.headers['x-fish-local-approval']!==b.id)throw new FishError('LOCAL_REVIEW_REQUIRED');
          app.tasks.approve(b.id);value={ok:true,id:b.id};
        }else if(url.pathname==='/api/cancel'){if(typeof b.id!=='string')throw new FishError('INVALID_TASK_ID');app.tasks.cancel(b.id);value={ok:true};}
        else if(url.pathname==='/api/stop'){value={ok:true};res.once('finish',()=>setTimeout(onStop,100));}
        else{res.statusCode=404;throw new FishError('NOT_FOUND');}
      }else{res.statusCode=404;throw new FishError('NOT_FOUND');}
      res.end(JSON.stringify(value));
    }catch(e){
      if(res.headersSent){if(!res.destroyed)res.end(JSON.stringify({type:'error',error:codeOf(e)})+'\n');return;}
      if(res.statusCode===200)res.statusCode=400;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({error:codeOf(e)}));
    }
  });
  server.requestTimeout=150000;server.headersTimeout=10000;
  return {server,url:origin,launchUrl:origin+'/#bootstrap='+bootstrap};
}
