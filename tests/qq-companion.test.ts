import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture,message } from './helpers.js';
import { BudgetedModel,DeepSeekModel } from '../src/agent/model.js';
import { Bot } from '../src/agent/bot.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';
import { MockTransport } from '../src/qq/adapter.js';
import { MockSearchProvider,SearchService } from '../src/search/provider.js';
import { MockImageProvider } from '../src/image/provider.js';
import { PersonMemory } from '../src/memory/people.js';
import { QzoneMemory } from '../src/memory/qzone.js';
import { QQImageClient } from '../src/qq/image-client.js';
import { startQQImageBroker } from '../src/qq/image-broker.js';
import { qqResources } from '../src/qq/resources.js';
import { CodexQuotaMonitor } from '../src/codex/quota.js';
import { personaSettings,savePersona } from '../src/character.js';
import { requestsImage } from '../src/web/images.js';
import { FishError,type Model,type ToolCall } from '../src/types.js';
import { hasToolMarkup } from '../src/agent/tool-protocol.js';

const call=(name:string,args:unknown):ToolCall=>({id:'tool-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}});
const plan={subject:'一条蓝色的小鱼',scene:'服务器旁边',style:'柔和插画',composition:'主体居中',lighting:'暖光',palette:'蓝白',details:'没有文字'};
const replyImage=(messages:any[])=>JSON.parse(messages[1].content).actions.lastImage;
function setup(provider:Model,people?:PersonMemory,client?:QQImageClient,qzone?:QzoneMemory){
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],admins:['20002'],images:true,bufferMs:10000});
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),transport=new MockTransport();
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,people,client,qzone);
  return {...f,bot,transport};
}
test('QQ sends the model-authored remark before fetching Space, then continues from actual media',async()=>{
  let turns=0,f:ReturnType<typeof setup>;
  const person={remembered:()=>({profile:{nickname:'友人'},avatar:'cached-avatar.png',posts:[]}),images:()=>{throw Error('Avatar must not be attached to Space');},close:async()=>{}} as unknown as PersonMemory;
  const qzone={remembered:()=>undefined,lastIndex:()=>1,read:async(_person:string,_conversation:string,selection:any)=>{assert.equal(f.transport.sent[0].text,'哟，你又整什么活了？');assert.equal(selection.index,3);return {};},context:()=>({source:'QQ空间本人说说列表',posts:[{id:'third-post',position:3,text:'海边散步'}]}),images:()=>[{type:'text',text:'说说 third-post 的附件'},{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}],close:async()=>{}} as unknown as QzoneMemory;
  const provider:Model={kind:'fixture',async complete(messages,_max,options){turns++;assert.ok(options?.tools?.some(t=>t.function.name==='get_qzone'));
    if(turns===1){assert.equal(options?.toolChoice,undefined);assert.ok(options?.tools?.some(t=>t.function.name==='get_person'));assert.ok(messages.every(m=>typeof m.content==='string'));assert.ok(!String(messages[0].content).includes('区分发布时间'));return {text:'',tool_calls:[call('get_qzone',{index:3,count:1,remark:'哟，你又整什么活了？'})],usage:{input:100,output:30}};}
    assert.equal(messages.filter(m=>m.role==='tool').length,1);assert.ok(Array.isArray(messages.at(-1)!.content));
    assert.equal(JSON.parse(String(messages.find(m=>m.role==='tool')!.content)).posts[0].id,'third-post');
    return {text:'你这海面拍得还挺会挑时候嘛。',usage:{input:300,output:30}};
  }};
  f=setup(provider,person,undefined,qzone);
  try{await f.bot.receive(message('来，再看看我上上条动态',{group:'private:20002',user:'20002'}));await f.bot.flush();
    assert.deepEqual(f.transport.sent.map(m=>m.text),['哟，你又整什么活了？','你这海面拍得还挺会挑时候嘛。']);
  }finally{await f.bot.stop();f.cleanup();}
});
test('energy and image allowance come from live counters; the model composes the wording',async()=>{
  let round=0,f:ReturnType<typeof setup>;
  const client={status:async()=>qqResources(f.cfg(),f.ledger,'private:20002','20002')} as unknown as QQImageClient;
  const provider:Model={kind:'fixture',async complete(messages){round++;if(round===1)return {text:'',tool_calls:[call('get_quota',{})],usage:{input:100,output:20}};
    const result=JSON.parse(String(messages.at(-1)!.content));assert.equal(result.images.remaining,17);assert.equal(result.energy.used,1354);
    return {text:'还活蹦乱跳呢，今天还能找 GPT小姐画 17 张。',usage:{input:100,output:30}};
  }};
  f=setup(provider,undefined,client);f.ledger.add('image',3);f.ledger.add('tokens',1234);
  try{await f.bot.receive(message('你累不累，还能画多少张？',{group:'private:20002',user:'20002'}));await f.bot.flush();assert.equal(f.transport.sent[0].text,'还活蹦乱跳呢，今天还能找 GPT小姐画 17 张。');}
  finally{await f.bot.stop();f.cleanup();}
});
test('QQ browses originals and passes model-selected image IDs through to GPT',async()=>{
  let round=0,f:ReturnType<typeof setup>;
  const client={
    list:async()=>({canAttachOriginals:true,images:[{id:'character',source:'character',label:'鲸酱原设定图'}]}),
    view:async(_m:any,ids:string[])=>{assert.deepEqual(ids,['character']);return {images:[{id:'character',label:'鲸酱原设定图',mime:'image/png',data:'AA=='}]};},
    generate:async(_m:any,_plan:any,_timeout:any,_signal:any,ids:string[])=>{assert.deepEqual(ids,['character']);return {imageId:'fixture',manifest:{},mock:true,references:[{id:'character'}]};},
    verifiedImage:()=>f.root+'/runtime/outputs/mock.png'
  } as unknown as QQImageClient;
  const provider:Model={kind:'fixture',async complete(messages,_max,options){
    round++;
    if(round===1){assert.equal(options?.toolChoice,undefined);return {text:'',tool_calls:[call('list_images',{source:'character'})],usage:{input:100,output:20}};}
    if(round===2)return {text:'',tool_calls:[call('view_images',{imageIds:['character']})],usage:{input:100,output:20}};
    if(round===3){
      assert.ok(Array.isArray(messages.at(-1)!.content));assert.ok((messages.at(-1)!.content as any[]).some(p=>p.type==='image_url'));
      return {text:'把这张设定图一起丢给她。',tool_calls:[call('generate_image',{remark:'把这张设定图一起丢给她。',referenceIds:['character'],...plan})],usage:{input:100,output:80}};
    }
    const result=replyImage(messages);assert.equal(result.referenceIds[0],'character');assert.equal(result.delivery,'sent');
    assert.ok(options?.tools?.some(t=>t.function.name==='generate_image'));assert.ok(messages.some(m=>m.role==='tool'));assert.equal(messages.at(-1)?.role,'tool');
    assert.equal(result.catalogId,'generated-fixture');assert.equal(JSON.parse(String(messages.at(-1)?.content)).delivered,true);
    return {text:'这次她照着原图画的。',usage:{input:100,output:20}};
  }};
  f=setup(provider,undefined,client);
  await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');
  try{await f.bot.receive(message('把你自己参考图丢给gpt',{group:'private:20002',user:'20002'}));await f.bot.flush();assert.equal(round,4);assert.equal(f.transport.files.length,1);assert.equal(f.transport.sent.at(-1)?.text,'这次她照着原图画的。');}
  finally{await f.bot.stop();f.cleanup();}
});
test('textual tool protocol is repaired through native JSON, kept out of chat/history, and optional remarks stay optional',async()=>{
  let turns=0,generated=0,f:ReturnType<typeof setup>;
  const leaked='<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="generate_image">untrusted textual arguments</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const client={
    list:async()=>({images:[]}),
    generate:async(_m:any,actual:any)=>{generated++;assert.deepEqual(actual,plan);return {imageId:'fixture',manifest:{},mock:true};},
    verifiedImage:()=>f.root+'/runtime/outputs/mock.png'
  } as unknown as QQImageClient;
  const provider:Model={kind:'fixture',async complete(messages,_max,options){
    turns++;assert.ok(messages.every(m=>m.role!=='assistant'||!hasToolMarkup(String(m.content))));
    assert.ok(!hasToolMarkup(String(messages[1].content)));assert.ok(String(messages[0].content).split('\n知识库（')[0].length<180);
    const required=options?.tools?.find(t=>t.function.name==='generate_image')?.function.parameters.required as string[]|undefined;
    assert.ok(!required?.includes('remark'));
    if(turns===1){assert.equal(options?.toolChoice,undefined);return {text:'',tool_calls:[call('list_images',{})],usage:{input:100,output:20}};}
    if(turns===2)return {text:leaked,usage:{input:100,output:30},finishReason:'stop'};
    if(turns===3){assert.equal(options?.toolChoice,'generate_image');assert.equal(options?.final,undefined);return {text:'',tool_calls:[call('generate_image',{...plan})],usage:{input:100,output:60},finishReason:'tool_calls'};}
    return {text:'喏，摸鱼证据又多一张。',usage:{input:100,output:20}};
  }};
  f=setup(provider,undefined,client);
  await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');
  f.store.observe(message(leaked,{group:'private:20002',user:'DeepSeekFish'}),24,20);
  f.bot.memory.record({id:'old-leak',conversation:'private:20002',actor:'DeepSeekFish',role:'assistant',text:leaked,at:Date.now()});
  try{
    await f.bot.receive(message('那，可以画吗？',{group:'private:20002',user:'20002'}));await f.bot.flush();
    assert.equal(generated,1);assert.equal(turns,4);assert.equal(f.transport.files.length,1);
    assert.deepEqual(f.transport.sent.map(m=>m.text),['喏，摸鱼证据又多一张。']);
    assert.ok(f.transport.sent.every(m=>!hasToolMarkup(m.text)));
    const records=fs.readdirSync(f.root+'/runtime/logs/qq').map(n=>JSON.parse(fs.readFileSync(f.root+'/runtime/logs/qq/'+n,'utf8')));
    assert.ok(records[0].trace.some((t:any)=>t.protocolRepair?.tool==='generate_image'));
    assert.ok(records[0].trace.some((t:any)=>t.assistant===leaked));assert.ok(records[0].system.split('\n知识库（')[0].length<180);
  }finally{await f.bot.stop();f.cleanup();}
});
test('unknown or repeated textual protocol never executes and never reaches QQ',async()=>{
  for(const text of ['你好','那，可以画吗？']){
    let calls=0,generated=0;
    const client={list:async()=>({images:[]}),generate:async()=>{generated++;}} as unknown as QQImageClient;
    const provider:Model={kind:'fixture',async complete(_messages,_max,options){
      calls++;if(options?.toolChoice==='list_images')return {text:'',tool_calls:[call('list_images',{})],usage:{input:100,output:20}};
      return {text:'<|DSML|invoke name="generate_image">not native JSON',usage:{input:100,output:20}};
    }};
    const f=setup(provider,undefined,client);
    try{await f.bot.receive(message(text,{group:'private:20002',user:'20002'}));await f.bot.flush();assert.equal(generated,0);assert.ok(calls<=3);assert.ok(f.transport.sent.length);assert.ok(f.transport.sent.every(m=>!hasToolMarkup(m.text)));}
    finally{await f.bot.stop();f.cleanup();}
  }
});
test('every QQ turn has the same tools; the model may draw directly or simply chat',async()=>{
  let turns=0,generated=0,f:ReturnType<typeof setup>;
  const client={generate:async()=>{generated++;return {imageId:'fixture',manifest:{},mock:true};},verifiedImage:()=>f.root+'/runtime/outputs/mock.png'} as unknown as QQImageClient;
  let toolNames:string[]=[];
  const provider:Model={kind:'fixture',async complete(messages,_max,options){
    turns++;assert.equal(options?.toolChoice,undefined);assert.equal(options?.requireTool,true);
    const names=options!.tools!.map(t=>t.function.name);if(!toolNames.length)toolNames=names;else assert.deepEqual(names,toolNames);
    assert.ok(names.includes('generate_image'));assert.ok(names.includes('get_quota'));
    if(turns===1)return {text:'',tool_calls:[call('generate_image',plan)],usage:{input:100,output:60}};
    if(turns===2){assert.equal(replyImage(messages).delivery,'sent');return {text:'',tool_calls:[call('reply',{text:'这个就是我的版本。'})],usage:{input:100,output:20}};}
    return {text:'',tool_calls:[call('reply',{text:'陪你发会儿呆。'})],usage:{input:100,output:20}};
  }};
  f=setup(provider,undefined,client);await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');
  try{
    await f.bot.receive(message('换成你肯定更有意思',{group:'private:20002',user:'20002'}));await f.bot.flush();
    await f.bot.receive(message('然后呢',{group:'private:20002',user:'20002'}));await f.bot.flush();
    assert.equal(generated,1);assert.equal(turns,3);assert.equal(f.transport.files.length,1);
    assert.deepEqual(f.transport.sent.map(m=>m.text),['这个就是我的版本。','陪你发会儿呆。']);
  }finally{await f.bot.stop();f.cleanup();}
});
test('image delivery failure preserves the generated artifact for the model and never regenerates',async()=>{
  let turns=0,generated=0,f:ReturnType<typeof setup>;
  const client={list:async()=>({images:[]}),generate:async()=>{generated++;return {imageId:'finished-artifact',manifest:{},mock:true};},verifiedImage:()=>f.root+'/runtime/outputs/mock.png'} as unknown as QQImageClient;
  const provider:Model={kind:'fixture',async complete(messages){
    turns++;
    if(turns===1)return {text:'',tool_calls:[call('list_images',{})],usage:{input:100,output:20}};
    if(turns===2)return {text:'',tool_calls:[call('generate_image',plan)],usage:{input:100,output:20}};
    const result=replyImage(messages);
    assert.equal(result.created,true);assert.equal(result.delivery,'unconfirmed');assert.equal(result.retryScheduled,false);
    assert.ok(!JSON.stringify(messages).includes('ONEBOT_ACTION_TIMEOUT'));assert.ok(messages.some(m=>m.role==='tool'));
    const toolResult=JSON.parse(String(messages.filter(m=>m.role==='tool').at(-1)!.content));
    assert.equal(toolResult.retryScheduled,false);assert.equal(toolResult.delivered,undefined);assert.match(toolResult.deliveryNote,/未安排重发/);
    return {text:'画好了，传图那边还没确认收到。',usage:{input:100,output:20}};
  }};
  f=setup(provider,undefined,client);await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');f.transport.file=async()=>{throw new FishError('ONEBOT_ACTION_TIMEOUT');};
  try{await f.bot.receive(message('可以画吗',{group:'private:20002',user:'20002'}));await f.bot.flush();assert.equal(generated,1);assert.equal(turns,3);assert.match(f.transport.sent[0].text,/画好了/);}
  finally{await f.bot.stop();f.cleanup();}
});
test('private image broker accepts model-selected drawings, shares quotas and deduplicates message IDs',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],admins:['20002'],images:true});
  fs.mkdirSync(f.root+'/config');
  fs.writeFileSync(f.root+'/config/local.json',JSON.stringify(f.cfg()));
  const quota=new CodexQuotaMonitor(f.store,true,{read:async()=>{},close:async()=>{}}),broker=await startQQImageBroker(f.root,f.store,quota,true),client=new QQImageClient(f.root);
  try{
    const m=message('总算能画了呀',{group:'private:20002',user:'20002'}),image=await client.generate(m,plan,1000);
    assert.equal(image.mock,true);assert.ok(fs.existsSync(f.root+'/runtime/outputs/'+image.imageId+'/image.png'));
    const same=await client.generate(m,plan,1000);assert.equal(same.alreadyRequested,true);assert.equal(same.state,'completed');assert.equal(same.imageId,image.imageId);
    const optional=await client.generate({...m,id:'ordinary',text:'这个样子好好笑'},plan,1000);assert.ok(optional.imageId);
    await assert.rejects(client.status({...m,group:'private:30003',user:'30003'}),/TARGET_DENIED/);
    const status=await client.status(m);assert.equal(status.images.used,2);assert.equal(status.images.remaining,18);assert.equal(status.gpt.remainingImages,null);
    assert.equal(f.ledger.value('codex'),2);assert.equal(f.ledger.value('image'),2);
    for(const text of ['想要张图','我想要张图，随便画','来随便画张图','今天可以，能画张么？','你现在能画张吗？'])assert.equal(requestsImage(text),true);
    for(const text of ['那，可以画吗？','今天还能画么？','可以画不？','总算能画了呀','那总算可以画了呢','现在能帮我画了吧','可以继续生图吗','能不能画呀','可不可以画呀']){assert.equal(requestsImage(text,true),true,text);assert.equal(requestsImage(text),false,text);}
    for(const text of ['现在能画多少张？','今天还能画几张？','现在不能画了吧','你不可以画图','他说现在可以画了吧','假如现在可以画了呢','解释“能画了吧”','先不用画'])assert.equal(requestsImage(text,true),false,text);
    for(const text of ['不要画图','还有多少张图','解释想要张图这句话','解释“今天可以，能画张么？”这句话'])assert.equal(requestsImage(text),false);
  }finally{await broker.close();await quota.close();f.cleanup();}
});
test('DeepSeek accepts native tool-call replies with null content and bounded tool definitions',async()=>{
  const f=fixture();try{
    const provider=new DeepSeekModel('fixture-key',f.cfg,(async(_url,init:any)=>{const body=JSON.parse(init.body);assert.equal(body.tools[0].function.name,'get_quota');assert.equal(body.tool_choice.function.name,'get_quota');return new Response(JSON.stringify({choices:[{message:{content:null,tool_calls:[call('get_quota',{})]}}],usage:{prompt_tokens:100,completion_tokens:20}}));}) as typeof fetch);
    const result=await provider.complete([{role:'user',content:'你累了吗'}],256,{toolChoice:'get_quota',tools:[{type:'function',function:{name:'get_quota',description:'读额度',parameters:{type:'object'}}}]});
    assert.equal(result.text,'');assert.equal(result.tool_calls?.[0].function.name,'get_quota');
  }finally{f.cleanup();}
});

test('the provider lets QQ choose any capability including reply, without naming a forced action',async()=>{
  const f=fixture();try{
    const provider=new DeepSeekModel('fixture-key',f.cfg,(async(_url,init:any)=>{
      const body=JSON.parse(init.body);assert.equal(body.tool_choice,'required');assert.equal(body.thinking.type,'disabled');
      return new Response(JSON.stringify({choices:[{message:{content:null,tool_calls:[call('reply',{text:'嗯哼。'})]}}],usage:{prompt_tokens:100,completion_tokens:20}}));
    }) as typeof fetch);
    const result=await provider.complete([{role:'user',content:'在吗'}],256,{requireTool:true,tools:[{type:'function',function:{name:'reply',description:'回复',parameters:{type:'object'}}}]});
    assert.equal(result.tool_calls?.[0].function.name,'reply');
  }finally{f.cleanup();}
});

test('repeated image calls return confirmed success without generating or sending again',async()=>{
  let round=0,generated=0,f:ReturnType<typeof setup>;
  const client={generate:async()=>{generated++;return {imageId:'fixture',manifest:{},mock:true};},verifiedImage:()=>f.root+'/runtime/outputs/mock.png'} as unknown as QQImageClient;
  const provider:Model={kind:'fixture',async complete(messages){
    round++;
    if(round===1)return {text:'',tool_calls:[{...call('generate_image',plan),id:'first'}],usage:{input:100,output:50}};
    const result=JSON.parse(String(messages.at(-1)?.content));assert.equal(result.created,true);assert.equal(result.delivered,true);assert.equal(result.error,undefined);
    if(round===2)return {text:'',tool_calls:[{...call('generate_image',{...plan,remark:'不要重复发这句'}),id:'retry'}],usage:{input:100,output:50}};
    assert.equal(result.reused,true);return {text:'',tool_calls:[call('reply',{text:'笑得真欠。'})],usage:{input:100,output:20}};
  }};
  f=setup(provider,undefined,client);await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');
  try{await f.bot.receive(message('整一个你的版本',{group:'private:20002',user:'20002'}));await f.bot.flush();assert.equal(generated,1);assert.equal(f.transport.files.length,1);assert.deepEqual(f.transport.sent.map(m=>m.text),['笑得真欠。']);assert.equal(JSON.parse(f.store.getMeta('qq-image-result:fixture')!).delivered,true);}
  finally{await f.bot.stop();f.cleanup();}
});

test('QQ picks up persona edits on the next message without rebuilding its Bot',async()=>{
  const seen:string[]=[];
  const f=setup({kind:'fixture',async complete(messages){seen.push(String(messages[0].content));return {text:'收到',usage:{input:20,output:5}};}});
  try{
    await f.bot.receive(message('第一句',{group:'private:20002',user:'20002'}));await f.bot.flush();
    savePersona(f.root,{...personaSettings(f.root),blocks:[{title:'新版',text:'已修改的人格内容'}]});
    await f.bot.receive(message('第二句',{group:'private:20002',user:'20002'}));await f.bot.flush();
    assert.equal(seen.length,2);assert.ok(!seen[0].includes('已修改的人格内容'));assert.ok(seen[1].includes('已修改的人格内容'));
  }finally{await f.bot.stop();f.cleanup();}
});

test('QQ chooses Search and Fetch on ordinary messages, retains source results, and can also simply reply',async()=>{
  let round=0;const f=setup({kind:'fixture',async complete(messages,_max,options){
    assert.ok(options?.tools?.some(t=>t.function.name==='search_web'));assert.ok(options?.tools?.some(t=>t.function.name==='fetch_page'));assert.equal(options?.toolChoice,undefined);
    round++;
    if(round===1)return {text:'',tool_calls:[call('search_web',{query:'鲸鱼睡觉'})],usage:{input:50,output:10}};
    if(round===2){const result=JSON.parse(String(messages.at(-1)!.content));assert.equal(result.source,'DeepSeek Search');assert.equal(result.results[0].url,'https://example.com/mock');return {text:'',tool_calls:[call('fetch_page',{url:result.results[0].url})],usage:{input:50,output:10}};}
    if(round===3){const result=JSON.parse(String(messages.at(-1)!.content));assert.equal(result.source,'DeepSeek Fetch');assert.equal(result.content,'这是离线网页正文。');assert.equal(messages.filter(m=>m.role==='tool').length,2);}
    return {text:'',tool_calls:[call('reply',{text:round===3?'看完了':'嗯哼'})],usage:{input:50,output:10}};
  }});
  try{
    f.set({search:true});await f.bot.receive(message('突然想到鲸鱼睡觉这件事',{group:'private:20002',user:'20002'}));await f.bot.flush();
    assert.equal(f.ledger.value('search'),2);assert.equal(f.transport.sent.at(-1)?.text,'看完了');
    await f.bot.receive(message('那就这样',{group:'private:20002',user:'20002'}));await f.bot.flush();assert.equal(f.ledger.value('search'),2);assert.equal(f.transport.sent.at(-1)?.text,'嗯哼');
  }finally{await f.bot.stop();f.cleanup();}
});
