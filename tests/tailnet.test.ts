import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer,request,type Server } from 'node:http';
import { once } from 'node:events';
import { tailnetGateway } from '../src/web/tailnet.js';

const publicHost='100.123.219.112:17863';
async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as import('node:net').AddressInfo).port;}
test('tailnet gateway validates origin, preserves auth/stream, strips approval and denies management routes',async()=>{
  let seen:any,count=0;
  const upstream=createServer((req,res)=>{count++;seen={url:req.url,headers:req.headers};res.writeHead(200,{'content-type':'application/x-ndjson','content-security-policy':"default-src 'self'"});res.write('{"type":"start"}\n');setImmediate(()=>res.end('{"type":"done"}\n'));});
  const upstreamPort=await listen(upstream),gateway=tailnetGateway(publicHost,upstreamPort),port=await listen(gateway);
  const call=(url:string,headers:Record<string,string>={},method='GET')=>new Promise<{status:number;body:string;headers:any}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path:url,method,headers:{Host:publicHost,...headers}},res=>{let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode!,body,headers:res.headers}));});req.on('error',reject);req.end();
  });
  try{
    const ok=await call('/api/chat',{Origin:'http://'+publicHost,Authorization:'Bearer dummy','x-fish-local-approval':'forged','x-forwarded-host':'evil.example'},'POST');
    assert.equal(ok.status,200);assert.match(ok.body,/"done"/);assert.equal(ok.headers['content-security-policy'],"default-src 'self'");
    assert.equal(seen.headers.host,'127.0.0.1:'+upstreamPort);assert.equal(seen.headers.origin,'http://127.0.0.1:'+upstreamPort);assert.equal(seen.headers.authorization,'Bearer dummy');assert.equal(seen.headers['x-fish-local-approval'],undefined);assert.equal(seen.headers['x-forwarded-host'],undefined);
    for(const route of ['/api/approve','/api/open','/api/stop'])assert.equal((await call(route,{},'POST')).status,403);
    assert.equal((await call('/api/status',{Host:'evil.example'})).status,403);
    assert.equal((await call('/api/status',{Origin:'https://evil.example'})).status,403);
    assert.equal((await call('/api/status',{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal(count,1);
    assert.equal((await call('/api/bootstrap',{},'POST')).status,200);
  }finally{gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);}
});

test('owner devices enter without browser credentials; the upstream token never leaves the gateway',async()=>{
  let seen:any,owner=true,peer='';
  const upstream=createServer((req,res)=>{seen=req.headers;res.setHeader('content-type','application/json');res.end(JSON.stringify({mock:false}));});
  const upstreamPort=await listen(upstream),gateway=tailnetGateway(publicHost,upstreamPort,{token:'server-only-secret',owner:async address=>{peer=address;return owner;}}),port=await listen(gateway);
  const call=(route:string,headers:Record<string,string>={})=>new Promise<{status:number;body:string}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port,path:route,headers:{Host:publicHost,...headers}},res=>{let body='';res.on('data',part=>{body+=part;});res.on('end',()=>resolve({status:res.statusCode!,body}));});req.on('error',reject);req.end();
  });
  try{
    const access=await call('/api/access');assert.equal(access.status,200);assert.deepEqual(JSON.parse(access.body),{tailnetOwner:true,tokenRequired:false});
    const status=await call('/api/status',{'x-forwarded-for':'100.1.2.3',authorization:'Bearer wrong-browser-token'});
    assert.equal(status.status,200);assert.equal(seen.authorization,'Bearer server-only-secret');assert.equal(status.body.includes('server-only-secret'),false);assert.equal(peer,'127.0.0.1');
    owner=false;assert.equal((await call('/api/status')).status,403);assert.equal((await call('/api/access')).status,403);
  }finally{gateway.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>gateway.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);}
});
