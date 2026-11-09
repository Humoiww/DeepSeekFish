import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './helpers.js';
import {writePrivate,makeDir} from '../src/paths.js';
import {MemoryJournal} from '../src/memory/journal.js';
import {DailyQzone,dailySlot,dailyMemory,dailyStatus,dailyActions} from '../src/qq/daily-qzone.js';
import {QzonePublisher,QzoneRejected,qzoneResponse} from '../src/qq/qzone-publish.js';
import {MockImageProvider} from '../src/image/provider.js';
import {FishError,type ChatMessage} from '../src/types.js';
import type {BudgetedModel} from '../src/agent/model.js';
import {PROJECT_TIMEZONE,projectDay,projectDayStart} from '../src/time.js';
import sharp from 'sharp';
import {QQImageLibrary} from '../src/qq/image-library.js';
import {SearchService,MockSearchProvider} from '../src/search/provider.js';

const before=Date.parse('2026-10-30T23:50:00+08:00'),midnight=Date.parse('2026-10-31T00:00:00+08:00');
const plan={subject:'鲸酱',scene:'机房聊天',style:'插画',composition:'半身',lighting:'暖光',palette:'蓝白',details:'配合日常'};
const imageId='00000000-0000-4000-8000-000000000001';
async function setup(){
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],images:true,maxOutputTokens:768}),memory=new MemoryJournal(f.root,f.store);
  writePrivate(f.root,'runtime/data/daily-qzone.json',JSON.stringify({enabled:true,owner:'20002',startsOn:'2026-10-31',timezone:PROJECT_TIMEZONE}));
  const dir=makeDir(f.root,'runtime/outputs/'+imageId);await new MockImageProvider().generate('fixture',dir);fs.renameSync(dir+'/mock.png',dir+'/image.png');
  f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT,PRIMARY KEY(conversation,message_id))');
  let now=before,calls=0,generations=0,uploads=0,publishes=0,found=false,findFails=false,publishFails=false,brokerFails=false;
  const contexts:ChatMessage[][]=[],keys:string[]=[];
  const model:Pick<BudgetedModel,'complete'>={async complete(_g,_u,m,options){
    calls++;contexts.push(structuredClone(m));assert.equal(options?.toolChoice,undefined);assert.equal(options?.requireTool,undefined);
    const phase=JSON.parse(String(m[1].content)).phase,last=m.at(-1),previous=last?.role==='tool'?JSON.parse(typeof last.content==='string'?last.content:(last.content[0] as any).text):undefined;
    const name=phase==='prepare'?(previous?.created?'draft_daily_post':'generate_image'):(previous?.images?'publish_qzone':'view_images');
    const args=name==='generate_image'?plan:name==='view_images'?{imageIds:['generated-'+imageId]}:{text:phase==='prepare'?'又是热闹的一天。':'深夜还笑出了声。',imageId:'generated-'+imageId};
    return {text:'',tool_calls:[{id:'choice-'+calls,type:'function',function:{name,arguments:JSON.stringify(args)}}],usage:{input:100,output:100}};
  }};
  const images={async generate(m:any){keys.push(m.id);if(!f.store.db.prepare('SELECT 1 FROM qq_image_requests WHERE message_id=?').get(m.id)){generations++;f.store.db.prepare('INSERT INTO qq_image_requests VALUES (?,?,?,?,?)').run(m.group,m.id,'completed',imageId,'');}if(brokerFails){brokerFails=false;throw new FishError('QQ_IMAGE_BROKER_UNAVAILABLE');}return {imageId};}};
  const publisher={self:'10001',async upload(){uploads++;return {richval:'fixture',picBo:'fixture'};},async publish(_t:string,_p:any,onSubmit:()=>void){publishes++;onSubmit();if(publishFails)throw Error('network lost');return {id:'post-1',url:'https://user.qzone.qq.com/10001/mood/post-1'};},async find(){if(findFails)throw Error('read failed');return found?{id:'post-1',url:'https://user.qzone.qq.com/10001/mood/post-1'}:undefined;}};
  const daily=()=>new DailyQzone(f.root,f.store,f.cfg,model,publisher,images,()=>now);
  return {...f,memory,daily,contexts,keys,model,publisher,images,clock:(n:number)=>{now=n;},setPublishFail:()=>{publishFails=true;},setFindFail:(v:boolean)=>{findFails=v;},setFound:()=>{found=true;},setBrokerFail:()=>{brokerFails=true;},counts:()=>({calls,generations,uploads,publishes})};
}
test('Hong Kong midnight selects the previous day, with bounded preparation/catch-up windows',()=>{
  assert.equal(projectDay(midnight-1),'2026-10-30');assert.equal(projectDay(midnight),'2026-10-31');assert.equal(projectDayStart(midnight),midnight);
  assert.deepEqual(dailySlot(before),{phase:'prepare',day:'2026-10-31',inWindow:true});
  assert.deepEqual(dailySlot(midnight),{phase:'publish',day:'2026-10-31',inWindow:true});
  assert.equal(dailySlot(midnight+8*3600000).inWindow,false);
});
test('day memory covers morning and night, excludes other contacts and dates, and removes identifiers',async()=>{
  const f=await setup();try{
    for(const [id,group,at,text] of [['early','private:20002',midnight-23*3600000,'早上聊了 123456789'],['late','private:20002',midnight-60000,'晚上聊天'],['other','private:30003',midnight-1,'别人的隐私'],['future','private:20002',midnight,'第二天'],['old','private:20002',midnight-86400001,'前一天']] as const)f.memory.record({id,conversation:group,actor:'20002',role:'user',text,at});
    const m=dailyMemory(f.store,f.cfg(),'2026-10-31',midnight);assert.equal(m.total,2);assert.equal(m.events.length,2);assert.match(m.events[0].text,/\[号码\]/);assert.ok(!JSON.stringify(m).includes('20002'));assert.equal(m.events[1].text,'晚上聊天');
  }finally{f.cleanup();}
});
test('prepares one image, refreshes the last minutes at midnight, publishes once across restarts',async()=>{
  const f=await setup();try{
    assert.equal((await f.daily().run()).state,'ready');assert.equal(f.counts().publishes,0);
    await f.daily().run();assert.deepEqual(f.counts(),{calls:2,generations:1,uploads:0,publishes:0});
    f.memory.record({id:'late',conversation:'private:20002',actor:'20002',role:'user',text:'最后五分钟还在笑',at:midnight-60000});
    f.clock(midnight);assert.equal((await f.daily().run()).state,'published');await f.daily().run();
    assert.deepEqual(f.counts(),{calls:4,generations:1,uploads:1,publishes:1});assert.match(String(f.contexts[2][1].content),/最后五分钟/);assert.equal(Array.isArray(f.contexts[3].at(-1)?.content),true);
    assert.equal(f.contexts[3].filter(m=>m.role==='user').length,0,'viewed files stay attached to their native tool result');
    assert.equal(dailyStatus(f.root,f.store,midnight).last?.state,'published');
  }finally{f.cleanup();}
});
test('uncertain publication is only reconciled, never reposted even when read-back fails',async()=>{
  const f=await setup();try{
    await f.daily().run();f.clock(midnight);f.setPublishFail();await assert.rejects(f.daily().run());
    assert.equal(dailyStatus(f.root,f.store,midnight).last?.state,'unknown');
    f.setFindFail(true);await assert.rejects(f.daily().run());assert.equal(dailyStatus(f.root,f.store,midnight).last?.state,'unknown');
    f.setFindFail(false);f.setFound();assert.equal((await f.daily().run()).state,'published');assert.equal(f.counts().publishes,1);assert.equal(f.counts().generations,1);
  }finally{f.cleanup();}
});
test('lost broker replies resume the same request ID; configuration and active leases prevent extra work',async()=>{
  const f=await setup();try{
    f.setBrokerFail();await f.daily().run();assert.equal(f.keys[0],f.keys[1]);assert.equal(f.counts().generations,1);
    f.store.db.prepare("UPDATE daily_qzone SET lease=? WHERE day='2026-10-31'").run(midnight+60000);f.clock(midnight);await f.daily().run();assert.equal(f.counts().publishes,0);
    writePrivate(f.root,'runtime/data/daily-qzone.json',JSON.stringify({enabled:false,owner:'20002',startsOn:'2026-10-31',timezone:PROJECT_TIMEZONE}));
    await assert.rejects(f.daily().run(),/DISABLED/);
  }finally{f.cleanup();}
});
test('Qzone upload/publish binds the real bot, sends one image, parses callbacks and does not return cookies',async()=>{
  const f=fixture(),output=await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');assert.equal(output.status,'ok');
  const bytes=fs.readFileSync((output as {path:string}).path);let posted=0,submitted=0;
  const http=(async(url:any,init:any)=>{
    const data=new URLSearchParams(init.body);assert.equal(init.headers.cookie,'uin=o10001; p_uin=o10001; skey=secret; p_skey=private');
    if(String(url).includes('cgi_upload_image')){assert.deepEqual(Buffer.from(data.get('picfile')!,'base64'),bytes);return new Response('<html><body><script>callback({"ret":0,"data":{"albumid":"a","lloc":"l","sloc":"s","type":1,"height":2,"width":3,"url":"https://qpic.cn/pic?bo=b"}});</script></body></html>');}
    posted++;assert.equal(submitted,1);assert.equal(data.get('con'),'今天真好。');assert.equal(data.get('richval'),',a,l,s,1,2,3,,2,3');assert.equal(data.get('pic_bo'),'b');assert.equal(data.get('hostuin'),'10001');return new Response('{"code":0,"tid":"post-1"}');
  }) as typeof fetch;
  const qq={qzoneSession:async()=>({cookies:'uin=o10001; p_uin=o10001; skey=secret; p_skey=private',bkn:'123'})};
  try{
    const p=new QzonePublisher(qq,'10001',http),photo=await p.upload(bytes);assert.ok(!JSON.stringify(photo).includes('private'));
    const post=await p.publish('今天真好。',photo,()=>{submitted++;});assert.equal(post.id,'post-1');assert.equal(posted,1);
    await assert.rejects(new QzonePublisher(qq,'10002',http).upload(bytes),/LOGIN_REQUIRED/);
    assert.throws(()=>qzoneResponse('callback(not JSON)'),/RESPONSE_INVALID/);
  }finally{f.cleanup();}
});
test('Qzone refusal never becomes a successful post',async()=>{
  const q={qzoneSession:async()=>({cookies:'p_uin=o10001; p_skey=private',bkn:'123'})};
  const p=new QzonePublisher(q,'10001',(async()=>new Response('{"code":-3,"message":"private response"}')) as typeof fetch);
  await assert.rejects(p.publish('日常',{richval:'fixture',picBo:'fixture'},()=>{}),e=>e instanceof QzoneRejected&&e.providerCode===-3&&!e.message.includes('private'));
});
test('daily context uses corrected delivery receipts, excludes another contact and the scheduled image itself',async()=>{
  const f=await setup();try{
    f.store.db.exec('DELETE FROM qq_image_requests');
    fs.utimesSync(f.root+'/runtime/outputs/'+imageId+'/image.png',new Date(before),new Date(before));
    for(const [group,message] of [['private:20002','human'],['private:30003','other'],['private:20002','daily-qzone:test']])f.store.db.prepare('INSERT INTO qq_image_requests VALUES (?,?,?,?,?)').run(group,message,'completed',imageId,'');
    f.store.setMeta('qq-image-result:'+imageId,JSON.stringify({deliveryStatus:'confirmed',characterReference:true}));
    assert.deepEqual(dailyActions(f.root,f.store,f.cfg(),'2026-10-31').images,[{created:true,delivery:'confirmed',referenceUsed:true}]);
  }finally{f.cleanup();}
});
function chosen(name:string,args:any,id=String(Math.random())){return {text:'',tool_calls:[{id,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}],usage:{input:100,output:20}};}
function seedImage(f:Awaited<ReturnType<typeof setup>>,group='private:20002'){
 f.store.db.prepare('INSERT OR IGNORE INTO qq_image_requests VALUES (?,?,?,?,?)').run(group,'human-image','completed',imageId,'');
}
test('DeepSeek may pick an existing file and publish with image generation disabled, without a forced generation step',async()=>{
 const f=await setup();f.clock(midnight);f.set({images:false});seedImage(f);let n=0;
 f.model.complete=async(_g,_u,m,options)=>{
  assert.equal(options?.toolChoice,undefined);assert.ok(!options?.tools?.some(t=>t.function.name==='generate_image'));
  if(++n===1)return chosen('list_images',{source:'generated'});
  const files=JSON.parse(String(m.at(-1)?.content));assert.equal(files.images[0].id,'generated-'+imageId);return chosen('publish_qzone',{text:'这张旧图又翻出来了。',imageId:files.images[0].id});
 };
 try{assert.equal((await f.daily().run()).state,'published');assert.equal(n,2);assert.equal(f.counts().generations,0);assert.equal(f.counts().publishes,1);}
 finally{f.cleanup();}
});
test('Codex result stays in its output folder until DeepSeek chooses its catalog ID and explicitly publishes',async()=>{
 const f=await setup();f.clock(midnight);let n=0;
 f.model.complete=async(_g,_u,m)=>{
  n++;if(n===1)return chosen('generate_image',{...plan,referenceIds:[]});
  if(n===2){const generated=JSON.parse(String(m.at(-1)?.content));assert.equal(generated.saved,true);assert.ok(fs.existsSync(f.root+'/runtime/outputs/'+imageId+'/image.png'));assert.equal(f.counts().publishes,0);assert.equal(f.counts().uploads,0);return chosen('view_images',{imageIds:[generated.catalogId]});}
  assert.equal(m.at(-1)?.role,'tool');assert.ok(Array.isArray(m.at(-1)?.content));assert.equal(f.counts().publishes,0);return chosen('publish_qzone',{text:'这一张我自己挑的。',imageId:'generated-'+imageId});
 };
 try{
  assert.equal((await f.daily().run()).state,'published');assert.deepEqual(f.counts(),{calls:0,generations:1,uploads:1,publishes:1});
  const receipt=JSON.parse(f.store.getMeta('qq-image-result:'+imageId)!);assert.equal(receipt.deliveryStatus,'not_attempted');assert.equal(receipt.qzone.deliveryStatus,'confirmed');
  const files=fs.readdirSync(f.root+'/runtime/logs/daily-qzone').filter(n=>n.startsWith('decision-')),trace=JSON.parse(fs.readFileSync(f.root+'/runtime/logs/daily-qzone/'+files[0],'utf8')).trace;
  assert.deepEqual(trace.filter((e:any)=>e.tool).map((e:any)=>e.tool),['generate_image','view_images','publish_qzone']);assert.ok(trace.filter((e:any)=>e.kind==='model').every((e:any)=>e.request&&e.usage.input===100));
 }finally{f.cleanup();}
});
test('failed Codex login is a tool result: the model may download another original and publish it',async()=>{
 const f=await setup();f.clock(midnight);f.set({search:true});let n=0,generationAttempts=0,downloaded='';
 const jpg=await sharp({create:{width:30,height:30,channels:3,background:'#69a'}}).jpeg().toBuffer();
 f.images.generate=async()=>{generationAttempts++;throw new FishError('CODEX_CHATGPT_PROJECT_LOGIN_REQUIRED');};
 f.model.complete=async(_g,_u,m)=>{
  if(++n===1)return chosen('generate_image',plan);
  const result=m.at(-1)!;const data=JSON.parse(typeof result.content==='string'?result.content:(result.content[0] as any).text);
  if(n===2){assert.equal(data.error,'CODEX_CHATGPT_PROJECT_LOGIN_REQUIRED');return chosen('download_image',{url:'https://example.com/choice.jpg'});}
  if(n===3){downloaded=data.image.id;return chosen('publish_qzone',{text:'今天换这张。',imageId:downloaded});}
  throw Error('unexpected extra model request');
 };
 const daily=new DailyQzone(f.root,f.store,f.cfg,f.model,f.publisher,f.images,()=>midnight,{download:async()=>({bytes:jpg,url:'https://example.com/choice.jpg',type:'image/jpeg'})});
 try{assert.equal((await daily.run()).state,'published');assert.equal(generationAttempts,1);assert.equal(f.counts().publishes,1);const [file]=new QQImageLibrary(f.root,f.store).select('private:20002','20002',[downloaded]);assert.deepEqual(fs.readFileSync(file.path),jpg);}
 finally{f.cleanup();}
});
test('a previous failed day is not permanently blocked; a new model decision can select another existing file',async()=>{
 const f=await setup();f.clock(midnight);seedImage(f);f.daily();
 f.store.db.prepare("INSERT INTO daily_qzone(day,self,state,draft,image_key,error,updated,attempts) VALUES (?,?,'failed',?,?,?, ?,3)").run('2026-10-31','10001',JSON.stringify({text:'旧草稿',imagePlan:plan}),'daily-qzone:2026-10-31:1','CODEX_CHATGPT_PROJECT_LOGIN_REQUIRED',before);
 f.model.complete=async()=>chosen('publish_qzone',{text:'重新挑了一张。',imageId:'generated-'+imageId});
 try{assert.equal((await f.daily().run()).state,'published');assert.equal(f.counts().generations,0);assert.equal(f.counts().publishes,1);}
 finally{f.cleanup();}
});
test('cross-conversation file IDs are refused and the model can change its selection without publishing the wrong file',async()=>{
 const f=await setup();f.clock(midnight);let n=0;seedImage(f,'private:30003');
 f.model.complete=async(_g,_u,m)=>{
  if(++n===1)return chosen('publish_qzone',{text:'错图',imageId:'generated-'+imageId});
  assert.equal(JSON.parse(String(m.at(-1)?.content)).error,'IMAGE_REFERENCE_NOT_AVAILABLE');assert.equal(f.counts().publishes,0);seedImage(f);return chosen('publish_qzone',{text:'这张才是。',imageId:'generated-'+imageId});
 };
 try{assert.equal((await f.daily().run()).state,'published');assert.equal(f.counts().publishes,1);}
 finally{f.cleanup();}
});
test('two daily workers share the persistent lease and do not duplicate a model choice or a post',async()=>{
 const f=await setup();f.clock(midnight);seedImage(f);let release!:()=>void,n=0;
 const wait=new Promise<void>(r=>{release=r;});f.model.complete=async()=>{n++;await wait;return chosen('publish_qzone',{text:'一次就够。',imageId:'generated-'+imageId});};
 try{
  const first=f.daily().run();await new Promise<void>(r=>setImmediate(r));const other=await f.daily().run();assert.equal(other.state,'preparing');assert.equal(n,1);release();assert.equal((await first).state,'published');assert.equal(f.counts().publishes,1);
 }finally{release();f.cleanup();}
});
test('Qzone uploads selected JPEG/GIF originals with their actual filename extension and unmodified bytes',async()=>{
 const source=sharp({create:{width:20,height:20,channels:3,background:'#37a'}}),bytes=[await source.clone().jpeg().toBuffer(),await source.clone().gif().toBuffer()];let uploads=0;
 const qq={qzoneSession:async()=>({cookies:'p_uin=o10001; p_skey=private',bkn:'123'})};
 const publisher=new QzonePublisher(qq,'10001',(async(_url:any,init:any)=>{
  const data=new URLSearchParams(init.body);assert.equal(data.get('filename'),uploads===0?'image.jpg':'image.gif');assert.deepEqual(Buffer.from(data.get('picfile')!,'base64'),bytes[uploads++]);
  return new Response('{"ret":0,"data":{"albumid":"a","lloc":"l","sloc":"s","width":20,"height":20,"bo":"b"}}');
 }) as typeof fetch);
 for(const image of bytes)await publisher.upload(image);assert.equal(uploads,2);
});
test('daily model-selected Search/Fetch use the shared CNY ledger and retain each actual action charge',async()=>{
 const f=await setup();f.clock(midnight);f.set({search:true});seedImage(f);let n=0;
 f.model.complete=async(_g,_u,m)=>{
  if(++n===1)return chosen('search_web',{query:'model-selected image source'});
  const result=JSON.parse(String(m.at(-1)?.content));assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(result.billing.chargedCny,0.005);
  if(n===2)return chosen('fetch_page',{url:result.results[0].url});
  return chosen('publish_qzone',{text:'看了一会儿再挑图。',imageId:'generated-'+imageId});
 };
 const daily=new DailyQzone(f.root,f.store,f.cfg,f.model,f.publisher,f.images,()=>midnight,{search:new SearchService(new MockSearchProvider(),f.ledger,f.cfg)});
 try{
  assert.equal((await daily.run()).state,'published');assert.equal(f.ledger.costSummary().used,0.01);assert.equal(f.ledger.value('tokens'),0,'the fixture model itself is unmetered');
  const file=fs.readdirSync(f.root+'/runtime/logs/daily-qzone').find(n=>n.startsWith('decision-'))!,trace=JSON.parse(fs.readFileSync(f.root+'/runtime/logs/daily-qzone/'+file,'utf8')).trace;
  assert.deepEqual(trace.filter((e:any)=>['search_web','fetch_page'].includes(e.tool)).map((e:any)=>e.result.billing.chargedCny),[0.005,0.005]);
 }finally{f.cleanup();}
});
