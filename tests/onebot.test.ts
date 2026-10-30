import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { OneBotTransport,OneBotActionError,normalizeOneBot } from '../src/qq/onebot.js';
import { validateConfig,deepseekCredential } from '../src/config.js';
import { fixture } from './helpers.js';
import { createApp } from '../src/app.js';
import { writePrivate } from '../src/paths.js';
import { MockModel,BudgetedModel } from '../src/agent/model.js';
import { Bot } from '../src/agent/bot.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';
import { SearchService,MockSearchProvider } from '../src/search/provider.js';
import { MockImageProvider } from '../src/image/provider.js';

const event=(text:string,extra:Record<string,unknown>={})=>({post_type:'message',message_type:'group',self_id:10001,group_id:123456,user_id:20002,message_id:1,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}],...extra});
test('OneBot normalizes ordinary/mention messages and rejects self, string CQ and malformed identities',()=>{
  assert.equal(normalizeOneBot(event('普通群消息'),'10001')?.event,'ordinary');
  const mention=normalizeOneBot(event('',{message:[{type:'at',data:{qq:'10001'}},{type:'text',data:{text:'你好'}}]}),'10001');
  assert.equal(mention?.mentioned,true);assert.equal(mention?.text,'你好');
  for(const extra of [{user_id:10001},{self_id:999},{message:'[CQ:at,qq=10001]hello'},{group_id:{}},{post_type:'message_sent'}])assert.equal(normalizeOneBot(event('bad',extra),'10001'),undefined);
  const picture=normalizeOneBot(event('',{message:[{type:'image',data:{url:'https://multimedia.nt.qq.com.cn/test',file:'fixture.gif',sub_type:1}}]}),'10001')!;
  assert.equal(picture.text,'[图片 1]');assert.equal(picture.images?.[0].stickerHint,true);assert.equal(picture.images?.[0].file,'fixture.gif');
});
test('OneBot URLs keep tokens separate and WebUI key reuse does not copy credentials into config',()=>{
  for(const onebotUrl of ['https://example.com','ws://8.8.8.8:3001','ws://127.0.0.1:3001?access_token=secret','wss://user:pass@example.com'])assert.throws(()=>validateConfig({onebotUrl}));
  assert.equal(validateConfig({qqTransport:'onebot',onebotUrl:'ws://100.100.100.100:3001'}).qqTransport,'onebot');
  const f=fixture();try{writePrivate(f.root,'runtime/data/webui-secrets.json',JSON.stringify({deepseekKey:'fixture-private-value'}));assert.equal(deepseekCredential(f.root),'fixture-private-value');}finally{f.cleanup();}
});
test('real local WebSocket carries ordinary context into an @ reply using existing bot and budget flow',async()=>{
  // Already present in the locked QQ SDK dependency tree; no test framework installed.
  const {WebSocketServer}=createRequire(import.meta.url)('ws');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const f=fixture({qqTransport:'onebot',groups:['123456'],admins:['20002'],privateUsers:['20002'],bufferMs:10000}),provider=new MockModel();
  let peer:any,bot:Bot,handled:(()=>void)|undefined;const sent:any[]=[];
  server.on('connection',(socket:any,request:any)=>{
    assert.equal(new URL(request.url,'http://localhost').searchParams.get('access_token'),'fixture-onebot-token');peer=socket;
    socket.on('message',(raw:Buffer)=>{
      const r=JSON.parse(raw.toString());let data:any;
      if(r.action==='get_login_info')data={user_id:10001,nickname:'鲸酱'};
      else if(r.action==='get_group_list')data=[{group_id:123456,group_name:'授权测试群'}];
      else if(r.action==='send_group_msg'||r.action==='send_private_msg'){sent.push({...r.params,action:r.action});data={message_id:88};}
      else throw Error('Unexpected action: '+r.action);
      socket.send(JSON.stringify({echo:r.echo,status:'ok',retcode:0,data}));
    });
  });
  const transport=new OneBotTransport(f.root,`ws://127.0.0.1:${server.address().port}`,'fixture-onebot-token',f.store,async m=>{await bot.receive(m);await bot.flush();handled?.();},g=>['123456','private:20002'].includes(g));
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner());
  bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
  try{
    assert.deepEqual(await transport.inspect(),{self:'10001',groups:[{id:'123456',name:'授权测试群'}]});
    const deliver=(e:unknown)=>new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('inbound timeout')),2000);handled=()=>{clearTimeout(timer);resolve();};peer.send(JSON.stringify(e));});
    await deliver(event('群成员正在聊 AI'));assert.equal(provider.calls,0);assert.equal(f.store.history('123456',20).length,1);
    await deliver(event('',{message_id:2,message:[{type:'at',data:{qq:10001}},{type:'text',data:{text:'接着聊'}}]}));
    assert.equal(provider.calls,1);assert.equal(sent.length,1);assert.equal(sent[0].group_id,'123456');assert.equal(sent[0].message[0].type,'text');
    assert.equal(f.store.history('123456',20).length,2);assert.ok(f.store.getMeta('qqOrdinary:123456'));
    await deliver(event('私聊不需要at',{message_type:'private',message_id:3}));
    assert.equal(provider.calls,2);assert.equal(sent[1].action,'send_private_msg');assert.equal(sent[1].user_id,'20002');
    assert.equal(f.store.history('private:20002',20).length,2);assert.equal(f.store.history('private:20002',20)[1].user,'DeepSeekFish');assert.equal(f.store.history('123456',20).length,2);
    await deliver(event('接着聊上一句',{message_type:'private',message_id:4}));
    assert.equal(provider.calls,3);assert.match(sent[2].message[0].data.text,/接着聊上一句/);
    assert.deepEqual(f.store.history('private:20002',20).map(m=>m.user),['20002','DeepSeekFish','20002','DeepSeekFish']);
    await assert.rejects(transport.send({id:'3',group:'999',user:'20002',text:'',at:Date.now(),mentioned:true,event:'mention'},'blocked'),/ONEBOT_GROUP_NOT_ALLOWED/);
  }finally{await bot.stop();for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));f.cleanup();}
});
test('QQ social chat cannot turn on ordinary Codex in image-only deployment',async()=>{
  const old=process.env.FISH_CODEX_IMAGE_ONLY,f=fixture();let app:ReturnType<typeof createApp>|undefined;
  try{process.env.FISH_CODEX_IMAGE_ONLY='1';app=createApp(f.root,true,{codex:true});assert.equal(app.cfg().codex,false);assert.throws(()=>app!.set('codex',true),/CODEX_IMAGE_ONLY/);}
  finally{if(app)await app.bot.stop();if(app)app.store.close();f.cleanup();if(old===undefined)delete process.env.FISH_CODEX_IMAGE_ONLY;else process.env.FISH_CODEX_IMAGE_ONLY=old;}
});
test('image upload acknowledgement can arrive after the ordinary action deadline',async(t)=>{
  const {WebSocketServer}=createRequire(import.meta.url)('ws');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const f=fixture(),out=await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');
  assert.equal(out.status,'ok');
  let acknowledge:()=>void=()=>{},received!:()=>void;
  const uploading=new Promise<void>(resolve=>{received=resolve;});
  server.on('connection',(socket:any)=>socket.on('message',(raw:Buffer)=>{
    const r=JSON.parse(raw.toString()),reply=(data:unknown)=>socket.send(JSON.stringify({echo:r.echo,status:'ok',retcode:0,data}));
    if(r.action==='get_login_info')reply({user_id:10001});
    else if(r.action==='get_group_list')reply([]);
    else {assert.equal(r.params.message[0].type,'image');assert.equal(r.params.timeout,60000);acknowledge=()=>reply({message_id:123});received();}
  }));
  const transport=new OneBotTransport(f.root,`ws://127.0.0.1:${server.address().port}`,'fixture-token',f.store,async()=>{},()=>true);
  try{
    await transport.inspect();t.mock.timers.enable({apis:['setTimeout']});
    const sent=transport.file({id:'1',group:'private:20002',user:'20002',text:'画张图',at:Date.now(),mentioned:true,event:'mention'},(out as {path:string}).path);
    let failed=false;void sent.catch(()=>{failed=true;});await uploading;
    t.mock.timers.tick(65000);await Promise.resolve();assert.equal(failed,false);
    acknowledge();await sent;
  }finally{t.mock.timers.reset();transport.stop();for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));f.cleanup();}
});
test('native send timeout stays unconfirmed, real rejection stays failed, and raw errors never enter logs',async()=>{
  const {WebSocketServer}=createRequire(import.meta.url)('ws');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const f=fixture(),out=await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');
  assert.equal(out.status,'ok');let sends=0;
  server.on('connection',(socket:any)=>socket.on('message',(raw:Buffer)=>{
    const r=JSON.parse(raw.toString());
    if(r.action==='get_login_info'||r.action==='get_group_list')socket.send(JSON.stringify({echo:r.echo,status:'ok',retcode:0,data:r.action==='get_login_info'?{user_id:10001}:[]}));
    else {
      sends++;
      const response=sends===1?{status:'failed',retcode:1200,wording:'Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet: secret-sentinel'}:
        sends===2?{status:'failed',retcode:1200,message:'explicit rejection secret-sentinel'}:{status:'ok',retcode:0,data:{}};
      socket.send(JSON.stringify({echo:r.echo,...response}));
    }
  }));
  const transport=new OneBotTransport(f.root,`ws://127.0.0.1:${server.address().port}`,'fixture-token',f.store,async()=>{},()=>true);
  const message={id:'1',group:'private:20002',user:'20002',text:'画张图',at:Date.now(),mentioned:true,event:'mention' as const};
  try{
    await transport.inspect();
    await assert.rejects(transport.file(message,(out as {path:string}).path),e=>e instanceof OneBotActionError&&e.code==='ONEBOT_SEND_UNCONFIRMED'&&e.diagnostic.reason==='native_timeout'&&e.diagnostic.retcode===1200);
    await assert.rejects(transport.file(message,(out as {path:string}).path),e=>e instanceof OneBotActionError&&e.code==='ONEBOT_ACTION_FAILED'&&e.diagnostic.reason==='action_rejected');
    await assert.rejects(transport.file(message,(out as {path:string}).path),/ONEBOT_SEND_UNCONFIRMED/);
    assert.equal(sends,3); // No automatic retry of any failed/uncertain send.
    const audit=JSON.stringify(f.store.db.prepare('SELECT detail FROM audit').all());
    assert.match(audit,/native_timeout/);assert.match(audit,/action_rejected/);assert.ok(!audit.includes('secret-sentinel'));
  }finally{transport.stop();for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));f.cleanup();}
});
