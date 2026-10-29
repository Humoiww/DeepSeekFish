import { createServer,request,type IncomingMessage } from 'node:http';

/** Dedicated fixed backend; authenticated human NapCat UI, never a model tool. */
export function napcatGateway(host:string,token:string,owner:(address:string,port:number)=>Promise<boolean>,port=6099){
  async function permitted(req:IncomingMessage):Promise<boolean>{
    return req.headers.host===host&&(!req.headers.origin||req.headers.origin==='http://'+host)&&
      await owner(req.socket.remoteAddress??'',req.socket.remotePort??0);
  }
  function headers(req:IncomingMessage){return {...req.headers,host:'127.0.0.1:'+port,...(req.headers.origin?{origin:'http://127.0.0.1:'+port}:{})};}
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    try{
      if(!await permitted(req)){res.writeHead(403);res.end('Tailscale owner access required');return;}
      if(!req.url?.startsWith('/')||req.url.startsWith('//')){res.writeHead(400);res.end();return;}
      if(req.method==='GET'&&req.url==='/'){res.writeHead(302,{location:'/webui?token='+encodeURIComponent(token)});res.end();return;}
      const upstream=request({hostname:'127.0.0.1',port,path:req.url,method:req.method,headers:headers(req)},response=>{
        res.writeHead(response.statusCode??502,{...response.headers,'cache-control':'no-store','referrer-policy':'no-referrer'});response.pipe(res);
      });
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('QQ login service unavailable');});
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream);
    }catch{if(!res.headersSent)res.writeHead(503);res.end('QQ login gateway unavailable');}
  });
  server.on('upgrade',(req,socket,head)=>{void(async()=>{
    if(!await permitted(req)||!req.url?.startsWith('/')||req.url.startsWith('//')){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
    const upstream=request({hostname:'127.0.0.1',port,path:req.url,method:'GET',headers:headers(req)});
    upstream.on('upgrade',(response,remote,remoteHead)=>{
      socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).filter(([,v])=>v!==undefined).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
      if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);remote.pipe(socket);socket.pipe(remote);
      remote.on('error',()=>socket.destroy());socket.on('error',()=>remote.destroy());socket.on('close',()=>remote.destroy());remote.on('close',()=>socket.destroy());
    });
    upstream.on('response',()=>socket.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());upstream.end();
  })().catch(()=>socket.destroy());});
  server.headersTimeout=15000;server.requestTimeout=30000;return server;
}
