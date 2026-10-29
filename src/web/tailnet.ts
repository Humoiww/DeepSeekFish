import { createServer, request, type IncomingMessage } from 'node:http';

const reads=new Set(['/','/web.css','/web.js','/fish.svg','/api/status','/api/sessions','/api/session','/api/file','/api/image','/api/qq']);
const writes=new Set(['/api/bootstrap','/api/sessions','/api/chat','/api/settings','/api/codex-quota/refresh','/api/images/reset','/api/cancel','/api/qq']);

export type TailnetAccess={owner:(address:string,port:number)=>Promise<boolean>;token:string};
/** Fixed-target gateway. Owner devices use Tailscale identity, with the local
 * credential kept entirely on the server. No browser token is needed. */
export function tailnetGateway(publicHost:string,upstreamPort=17862,access?:TailnetAccess){
  const publicOrigin='http://'+publicHost,localHost='127.0.0.1:'+upstreamPort;
  const deny=(res:import('node:http').ServerResponse,status:number,error:string)=>{
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify({error}));
  };
  const server=createServer(async(req,res)=>{
    if(req.headersDistinct.host?.length!==1||req.headers.host!==publicHost||
      req.headers.origin&&req.headers.origin!==publicOrigin||req.headers['sec-fetch-site']==='cross-site'){
      deny(res,403,'LOCAL_ONLY');return;
    }
    if(!req.url?.startsWith('/')||req.url.startsWith('//')){deny(res,400,'INVALID_PATH');return;}
    if(access){
      let owner=false;
      try{owner=await access.owner(req.socket.remoteAddress??'',req.socket.remotePort??0);}catch{}
      if(!owner){deny(res,403,'TAILNET_OWNER_REQUIRED');return;}
      if(req.method==='GET'&&req.url==='/api/access'){
        res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify({tailnetOwner:true,tokenRequired:false}));return;
      }
    }
    const url=new URL(req.url,publicOrigin),allowed=req.method==='GET'?reads:req.method==='POST'?writes:null;
    if(!allowed?.has(url.pathname)){deny(res,403,'LOCAL_REVIEW_REQUIRED');return;}
    if(Number(req.headers['content-length'])>32768){deny(res,413,'BODY_LIMIT');return;}
    // Forward only application headers; strip approval, proxy and hop headers.
    const headers:IncomingMessage['headers']={host:localHost};
    for(const key of ['authorization','content-type','accept'])if(req.headers[key])headers[key]=req.headers[key];
    if(access)headers.authorization='Bearer '+access.token;
    if(req.headers.origin)headers.origin='http://'+localHost;
    const upstream=request({hostname:'127.0.0.1',port:upstreamPort,path:url.pathname+url.search,method:req.method,headers},response=>{
      res.writeHead(response.statusCode??502,response.headers);response.pipe(res);
      response.on('error',()=>res.destroy());
    });
    upstream.on('error',()=>{if(!res.headersSent)deny(res,502,'WEBUI_UNAVAILABLE');else res.destroy();});
    req.on('aborted',()=>upstream.destroy());
    res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
    req.pipe(upstream);
  });
  server.headersTimeout=10000;server.requestTimeout=150000;
  server.on('upgrade',(_req,socket)=>socket.destroy());
  server.on('connect',(_req,socket)=>socket.destroy());
  return server;
}
