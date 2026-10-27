import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { App } from '../app.js';
import { FishError, codeOf } from '../types.js';

const page=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DeepSeekFish 状态</title>
<style>body{max-width:1000px;margin:40px auto;padding:20px;font:16px system-ui;background:#0b1320;color:#dce9f4}input,button{padding:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere}label{display:block;margin:20px 0}</style>
<h1>DeepSeekFish 本机状态</h1><p>仅监听 127.0.0.1。管理命令请使用本地 CLI。输入 runtime/data/admin-token 中的令牌查看状态。</p>
<label>本机令牌 <input id="token" type="password" autocomplete="off"></label><button id="refresh">刷新状态</button><pre id="status">等待本机认证</pre>
<script src="/status.js"></script></html>`;
const js=`document.getElementById('refresh').onclick=async()=>{try{const r=await fetch('/api/status',{headers:{Authorization:'Bearer '+document.getElementById('token').value}});document.getElementById('status').textContent=JSON.stringify(await r.json(),null,2)}catch{document.getElementById('status').textContent='读取失败'}};`;
async function body(req:IncomingMessage):Promise<any>{
  let data='';for await(const part of req){data+=part;if(Buffer.byteLength(data)>8192)throw new FishError('BODY_LIMIT');}
  try{return JSON.parse(data||'{}');}catch{throw new FishError('INVALID_JSON');}
}
export function adminServer(app:App,onStop:()=>void){
  const port=app.cfg().port;
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
    try{
      if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')||req.headers.host!==`127.0.0.1:${port}`||
        req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`||req.headers['sec-fetch-site']==='cross-site'){
        res.statusCode=403;throw new FishError('LOCAL_ONLY');
      }
      const url=new URL(req.url??'/',`http://127.0.0.1:${port}`);
      if(req.method==='GET'&&url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page);return;}
      if(req.method==='GET'&&url.pathname==='/status.js'){res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(js);return;}
      const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+app.token);
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.statusCode=401;throw new FishError('LOCAL_AUTH_REQUIRED');}
      res.setHeader('Content-Type','application/json; charset=utf-8');
      let value:unknown;
      if(req.method==='GET'&&url.pathname==='/api/status')value=app.status();
      else if(req.method==='GET'&&url.pathname==='/api/tasks')value=app.tasks.list();
      else if(req.method==='GET'&&url.pathname==='/api/history')value=app.store.history(url.searchParams.get('group')??'',app.cfg().windowSize);
      else if(req.method==='POST'){
        const b=await body(req);
        if(url.pathname==='/api/set'){app.set(b.key,b.value);value={ok:true};}
        else if(url.pathname==='/api/clear'){if(typeof b.group!=='string')throw new FishError('INVALID_GROUP');app.store.clear(b.group);value={ok:true};}
        else if(url.pathname==='/api/cancel'){app.tasks.cancel(b.id);value={ok:true};}
        else if(url.pathname==='/api/approve'){
          if(b.reviewed!==true||req.headers['x-fish-local-approval']!==b.id)throw new FishError('LOCAL_REVIEW_REQUIRED');
          app.tasks.approve(b.id);value={ok:true,id:b.id};
        }else if(url.pathname==='/api/mock-message'&&app.mock){
          if(typeof b.text!=='string'||b.text.length>2000)throw new FishError('INVALID_MESSAGE');
          await app.bot.receive({id:crypto.randomUUID(),group:b.group??app.cfg().groups[0],user:b.user??app.cfg().admins[0],text:b.text,at:Date.now(),mentioned:b.mentioned!==false,event:'mention'});
          await app.bot.flush();value={ok:true,sent:(app.transport as any).sent};
        }else if(url.pathname==='/api/stop'){value={ok:true};setImmediate(onStop);}
        else{res.statusCode=404;throw new FishError('NOT_FOUND');}
      }else{res.statusCode=404;throw new FishError('NOT_FOUND');}
      res.end(JSON.stringify(value));
    }catch(e){if(res.statusCode===200)res.statusCode=400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:codeOf(e)}));}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
