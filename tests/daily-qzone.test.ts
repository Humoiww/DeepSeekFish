import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './helpers.js';
import {writePrivate,makeDir} from '../src/paths.js';
import {MemoryJournal} from '../src/memory/journal.js';
import {DailyQzone,dailySlot,dailyMemory,dailyStatus,dailyActions,authorizedDailyImage} from '../src/qq/daily-qzone.js';
import {QzonePublisher,QzoneRejected,qzoneResponse} from '../src/qq/qzone-publish.js';
import {MockImageProvider} from '../src/image/provider.js';
import {FishError,type ChatMessage} from '../src/types.js';
import type {BudgetedModel} from '../src/agent/model.js';
import {PROJECT_TIMEZONE,projectDay,projectDayStart} from '../src/time.js';

const before=Date.parse('2026-10-30T23:50:00+08:00'),midnight=Date.parse('2026-10-31T00:00:00+08:00');
const plan={subject:'鲸酱',scene:'机房聊天',style:'插画',composition:'半身',lighting:'暖光',palette:'蓝白',details:'配合日常'};
const imageId='00000000-0000-4000-8000-000000000001';
async function setup(){
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],images:true,maxOutputTokens:768}),memory=new MemoryJournal(f.root,f.store);
  writePrivate(f.root,'runtime/data/daily-qzone.json',JSON.stringify({enabled:true,owner:'20002',startsOn:'2026-10-31',timezone:PROJECT_TIMEZONE}));
  const dir=makeDir(f.root,'runtime/outputs/'+imageId);await new MockImageProvider().generate('fixture',dir);fs.renameSync(dir+'/mock.png',dir+'/image.png');
  let now=before,calls=0,generations=0,uploads=0,publishes=0,found=false,findFails=false,publishFails=false,brokerFails=false;
  const contexts:ChatMessage[][]=[],keys:string[]=[];
  const model:Pick<BudgetedModel,'complete'>={async complete(_g,_u,m){
    calls++;contexts.push(m);const refresh=JSON.parse(String(m[1].content)).image?.attached===true;
    return {text:'',tool_calls:[{id:'draft',type:'function',function:{name:'draft_daily_post',arguments:JSON.stringify({text:refresh?'深夜还笑出了声。':'又是热闹的一天。',...(!refresh?{imagePlan:plan}:{})})}}],usage:{input:100,output:100}};
  }};
  const images={async generate(m:any){keys.push(m.id);if(brokerFails){brokerFails=false;throw new FishError('QQ_IMAGE_BROKER_UNAVAILABLE');}generations++;return {imageId};}};
  const publisher={self:'10001',async upload(){uploads++;return {richval:'fixture',picBo:'fixture'};},async publish(_t:string,_p:any,onSubmit:()=>void){publishes++;onSubmit();if(publishFails)throw Error('network lost');return {id:'post-1',url:'https://user.qzone.qq.com/10001/mood/post-1'};},async find(){if(findFails)throw Error('read failed');return found?{id:'post-1',url:'https://user.qzone.qq.com/10001/mood/post-1'}:undefined;}};
  const daily=()=>new DailyQzone(f.root,f.store,f.cfg,model,publisher,images,()=>now);
  return {...f,memory,daily,contexts,keys,clock:(n:number)=>{now=n;},setPublishFail:()=>{publishFails=true;},setFindFail:(v:boolean)=>{findFails=v;},setFound:()=>{found=true;},setBrokerFail:()=>{brokerFails=true;},counts:()=>({calls,generations,uploads,publishes})};
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
    await f.daily().run();assert.deepEqual(f.counts(),{calls:1,generations:1,uploads:1,publishes:0});
    f.memory.record({id:'late',conversation:'private:20002',actor:'20002',role:'user',text:'最后五分钟还在笑',at:midnight-60000});
    f.clock(midnight);assert.equal((await f.daily().run()).state,'published');await f.daily().run();
    assert.deepEqual(f.counts(),{calls:2,generations:1,uploads:1,publishes:1});assert.match(String(f.contexts[1][1].content),/最后五分钟/);assert.equal(Array.isArray(f.contexts[1][2].content),true);
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
    f.setBrokerFail();await assert.rejects(f.daily().run());await f.daily().run();assert.equal(f.keys[0],f.keys[1]);
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
test('standing image consent requires an enabled, active daily job for this owner and date',async()=>{
  const f=await setup();try{
    f.daily();f.store.db.prepare("INSERT INTO daily_qzone(day,self,state,image_key,lease,updated) VALUES ('2026-10-31','10001','preparing','daily-image',?,?)").run(midnight+1000,before);
    const allowed=(group='private:20002',user='20002',key='daily-image',now=before)=>authorizedDailyImage(f.root,f.store,group,user,key,now);
    assert.equal(allowed(),true);assert.equal(allowed('private:30003','30003'),false);assert.equal(allowed('private:20002','20002','daily-qzone:fake'),false);assert.equal(allowed('private:20002','20002','daily-image',midnight+2000),false);
    f.store.db.prepare("UPDATE daily_qzone SET state='ready'").run();assert.equal(allowed(),false);
  }finally{f.cleanup();}
});
test('daily context uses corrected delivery receipts, excludes another contact and the scheduled image itself',async()=>{
  const f=await setup();try{
    f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,image_id TEXT,state TEXT)');
    fs.utimesSync(f.root+'/runtime/outputs/'+imageId+'/image.png',new Date(before),new Date(before));
    for(const [group,message] of [['private:20002','human'],['private:30003','other'],['private:20002','daily-qzone:test']])f.store.db.prepare('INSERT INTO qq_image_requests VALUES (?,?,?,?)').run(group,message,imageId,'completed');
    f.store.setMeta('qq-image-result:'+imageId,JSON.stringify({deliveryStatus:'confirmed',characterReference:true}));
    assert.deepEqual(dailyActions(f.root,f.store,f.cfg(),'2026-10-31').images,[{created:true,delivery:'confirmed',referenceUsed:true}]);
  }finally{f.cleanup();}
});
