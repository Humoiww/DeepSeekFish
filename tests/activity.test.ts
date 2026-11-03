import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {once} from 'node:events';
import {fixture} from './helpers.js';
import {createWebApp} from '../src/web/app.js';
import {webServer} from '../src/web/server.js';
import {activitySafe} from '../src/web/activity.js';
import {MockImageProvider} from '../src/image/provider.js';
const imageId='11111111-1111-4111-8111-111111111111',at=Date.parse('2026-11-03T08:00:00+08:00');
const call=(id:string,name:string,args:any)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
function log(root:string,folder:string,name:string,value:unknown){const dir=path.join(root,'runtime/logs',folder);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));}
function sample(){return {request:'下载参考图再画一张',conversation:'private:20002',startedAt:at,finishedAt:at+3000,state:'completed',trace:[
 {round:0,usage:{input:100,output:20,cachedInput:60,uncachedInput:40},toolCalls:[call('s','search_web',{query:'参考图'}),call('d','download_image',{url:'https://example.com/image.png?token=secret-download'})]},
 {tool:'search_web',result:{results:[]}}, {tool:'download_image',result:{images:[{error:'WEB_BODY_TOO_LARGE'},{saved:true}]}},
 {round:1,usage:{input:80,output:10,cachedInput:80,uncachedInput:0},toolCalls:[call('g','generate_image',{subject:'测试'})]},
 {tool:'generate_image',phase:'submitted'},{tool:'generate_image',phase:'generated',imageId}, {tool:'generate_image',result:{created:true,imageId}},
 {round:2,usage:{input:10,output:5},toolCalls:[call('send','send_image',{imageId:'generated-'+imageId}),call('r','reply',{text:'画好了。'})]},
 {tool:'send_image',result:{delivered:true}},{tool:'reply',result:{sent:true}}
 ]};}

test('activity preserves native call/result pairs, counts real usage once, and keeps old unknown usage distinct',async()=>{
 const f=fixture(),app=createWebApp(f.root,true);
 try{
  log(f.root,'qq','sample',sample());log(f.root,'qq','old-failure',{request:'旧请求',conversation:'private:30003',at:at-86400000,trace:[{error:'DEEPSEEK_HTTP_400'}]});
  log(f.root,'daily-news','research-today',{at,trace:[{round:0,usage:{input:50,output:10},tool_calls:[call('news','draft_news',{text:'今日新闻'})]},{draft:{text:'今日新闻',sources:[]}}]});
  const all=await app.activity(new URLSearchParams());assert.equal(all.totals.records,3);assert.equal(all.totals.tokens,285);assert.equal(all.totals.modelCalls,4);assert.equal(all.totals.unknownUsage,1);
  const filtered=await app.activity(new URLSearchParams({kind:'qq',from:'2026-11-03',to:'2026-11-03',conversation:'private:20002',q:'WEB_BODY_TOO_LARGE',state:'failed'}));assert.equal(filtered.items.length,1);
  const detail=await app.activityDetail('qq:sample');assert.equal(detail.usage.total,225);assert.equal(detail.durationMs,3000);assert.equal(detail.state,'completed');assert.equal(detail.reply,'画好了。');assert.equal(detail.counts.tools,5);assert.equal(detail.counts.search,1);assert.equal(detail.counts.downloads,1);assert.equal(detail.counts.images,1);assert.equal(detail.counts.sends,1);
  const image=detail.events.find(e=>e.name==='generate_image')!;assert.equal(image.phases?.length,2);assert.equal(image.callId,'g');assert.equal(image.state,'completed');assert.deepEqual(detail.related,['image:'+imageId]);
  assert.equal(detail.usage.cachedInput,140);assert.equal(detail.usage.uncachedInput,40);assert.equal(detail.usage.cacheUnknownInput,10);assert.equal(detail.usage.cacheKnownCalls,2);
  assert.equal(all.totals.cachedInput,140);assert.equal(all.totals.cacheUnknownInput,60);
  const search=detail.events.find(e=>e.name==='search_web')!,download=detail.events.find(e=>e.name==='download_image')!;
  assert.deepEqual(search.decision,download.decision);assert.deepEqual(search.decision?.actions,['search_web','download_image']);assert.equal(search.decision?.call,1);assert.equal(search.decision?.usage?.cachedInput,60);assert.equal(image.decision?.call,2);
  assert.ok(!JSON.stringify(detail).includes('secret-download'));assert.equal((await app.activityDetail('qq:old-failure')).usage.known,false);
  const news=await app.activityDetail('news:research-today');assert.equal(news.events.find(e=>e.name==='draft_news')!.state,'completed');
  await assert.rejects(app.activity(new URLSearchParams({from:'2026-02-31'})),/QUERY_INVALID/);await assert.rejects(app.activityDetail('qq:../../config/local.json'),/NOT_FOUND/);
  const s=app.createSession();await app.chat(s.id,'你好','chat',new AbortController().signal,()=>{});
  const web=await app.activity(new URLSearchParams({kind:'web'}));assert.equal(web.items.length,1);assert.equal(web.items[0].usage.known,true);assert.equal(web.items[0].usage.total,200);assert.equal(web.items[0].usage.calls,1);
 }finally{await app.close();f.cleanup();}
});

test('activity associates repairs by model call rather than round and leaves missing usage unknown',async()=>{
 const f=fixture(),app=createWebApp(f.root,true);try{
  log(f.root,'qq','repair',{request:'重试',trace:[
   {round:0,error:'DEEPSEEK_INVALID_TOOL_CALL',usage:{input:100,output:10,cachedInput:90,uncachedInput:10}},
   {round:0,repair:true,usage:{input:110,output:20,cachedInput:100,uncachedInput:10},toolCalls:[call('s','search_web',{}),call('b','browse_page',{})]},
   {tool:'search_web',result:{ok:true}},{tool:'browse_page',result:{ok:true}},
   {round:1,toolCalls:[call('r','reply',{text:'好了'})]},{tool:'reply',result:{sent:true}}
  ]});
  const d=await app.activityDetail('qq:repair');assert.equal(d.usage.total,240);assert.equal(d.usage.cachedInput,190);assert.equal(d.usage.calls,3);assert.equal(d.usage.unreportedCalls,1);
  assert.equal(d.events.find(e=>e.name==='search_web')?.decision?.call,2);assert.equal(d.events.find(e=>e.name==='search_web')?.decision?.usage?.input,110);
  assert.equal(d.events.find(e=>e.name==='reply')?.decision?.call,3);assert.equal(d.events.find(e=>e.name==='reply')?.decision?.usage,undefined);
 }finally{await app.close();f.cleanup();}
});

test('activity paginates all retained records, rejects symlinks, and reads only known image outputs',async()=>{
 const f=fixture(),app=createWebApp(f.root,true);
 try{
  for(let i=0;i<25;i++)log(f.root,'qq','turn-'+i,{request:'问 '+i,at:at+i,trace:[]});
  fs.writeFileSync(f.root+'/runtime/data/private-file','{"request":"private-do-not-read"}');fs.symlinkSync(f.root+'/runtime/data/private-file',f.root+'/runtime/logs/qq/link.json');
  log(f.root,'codex',imageId,{id:imageId,startedAt:at,finishedAt:at+1000,outcome:'returned',request:{prompt:'两张参考'},delivery:{ok:true},images:[]});
  const dir=f.root+'/runtime/outputs/'+imageId;fs.mkdirSync(dir);await new MockImageProvider().generate('',dir);fs.renameSync(dir+'/mock.png',dir+'/image.png');
  const first=await app.activity(new URLSearchParams({kind:'qq'}));assert.equal(first.totals.records,25);assert.equal(first.items.length,20);assert.equal(first.nextOffset,20);
  const second=await app.activity(new URLSearchParams({kind:'qq',offset:'20'}));assert.equal(second.items.length,5);assert.equal(second.nextOffset,null);
  assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,25);await assert.rejects(app.activityDetail('qq:link'),/NOT_FOUND/);
  assert.equal((await app.activityImage('image:'+imageId)).subarray(1,4).toString(),'PNG');await assert.rejects(app.activityImage('qq:turn-0'),/NOT_FOUND/);
 }finally{await app.close();f.cleanup();}
});

test('activity endpoints use existing owner authentication and never reveal credential fields',async()=>{
 const f=fixture(),app=createWebApp(f.root,true),port=23000+Math.floor(Math.random()*20000),{server}=webServer(app,port);
 try{
  log(f.root,'qq','sample',sample());server.listen(port,'127.0.0.1');await once(server,'listening');const url='http://127.0.0.1:'+port;
  assert.equal((await fetch(url+'/api/activity')).status,401);assert.equal((await fetch(url+'/api/activity/detail?id=qq:sample')).status,401);
  const headers={authorization:'Bearer '+app.token};const result=await fetch(url+'/api/activity',{headers});assert.equal(result.status,200);assert.equal((await result.json() as any).items[0].id,'qq:sample');
  const detail=await fetch(url+'/api/activity/detail?id=qq:sample',{headers});assert.equal(detail.status,200);assert.ok(!(await detail.text()).includes('secret-download'));
  const safe=JSON.stringify(activitySafe({apiKey:'secret-key',nested:{cookie:'secret-cookie'},text:'{"password":"secret-password"}',url:'https://example.com/?rkey=secret-rkey',content:'data:image/png;base64,AAAA'}));
  for(const secret of ['secret-key','secret-cookie','secret-password','secret-rkey','base64,AAAA'])assert.ok(!safe.includes(secret));
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();f.cleanup();}
});
