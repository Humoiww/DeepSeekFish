import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer,request } from 'node:http';
import { once } from 'node:events';
import { napcatGateway } from '../src/qq/napcat-gateway.js';

test('private QQ login gateway rejects other owners and origins, redirects owner and streams the fixed backend',async()=>{
  const upstream=createServer((req,res)=>{assert.equal(req.headers.host,'127.0.0.1:'+upstreamPort);res.setHeader('content-type','application/json');res.end(JSON.stringify({path:req.url}));});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const upstreamPort=(upstream.address() as any).port;
  let allowed=true;
  const gateway=napcatGateway('100.100.100.100:17864','fixture-webui-token',async()=>allowed,upstreamPort);
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');const port=(gateway.address() as any).port;
  const call=(path:string,headers:Record<string,string>={})=>new Promise<{status:number;headers:any;body:string}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path,headers:{host:'100.100.100.100:17864',...headers}},res=>{let body='';res.on('data',b=>{body+=b;});res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body}));});req.on('error',reject);req.end();
  });
  try{
    const root=await call('/');assert.equal(root.status,302);assert.equal(root.headers.location,'/webui?token=fixture-webui-token');
    const page=await call('/webui');assert.deepEqual(JSON.parse(page.body),{path:'/webui'});
    assert.equal((await call('/',{origin:'https://untrusted.invalid'})).status,403);
    allowed=false;assert.equal((await call('/')).status,403);
  }finally{gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);}
});
