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
import { requestsImage } from '../src/web/images.js';
import type { Model,ToolCall } from '../src/types.js';

const call=(name:string,args:unknown):ToolCall=>({id:'tool-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}});
const plan={subject:'一条蓝色的小鱼',scene:'服务器旁边',style:'柔和插画',composition:'主体居中',lighting:'暖光',palette:'蓝白',details:'没有文字'};
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
    if(turns===1){assert.equal(options?.toolChoice,'get_qzone');assert.ok(!options?.tools?.some(t=>t.function.name==='get_person'));assert.ok(messages.every(m=>typeof m.content==='string'));assert.ok(!String(messages[0].content).includes('区分发布时间'));return {text:'',tool_calls:[call('get_qzone',{index:1,count:1,remark:'哟，你又整什么活了？'})],usage:{input:100,output:30}};}
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
    if(round===1){assert.equal(options?.toolChoice,'list_images');return {text:'',tool_calls:[call('list_images',{source:'character'})],usage:{input:100,output:20}};}
    if(round===2)return {text:'',tool_calls:[call('view_images',{imageIds:['character']})],usage:{input:100,output:20}};
    if(round===3){
      assert.ok(Array.isArray(messages.at(-1)!.content));assert.ok((messages.at(-1)!.content as any[]).some(p=>p.type==='image_url'));
      return {text:'把这张设定图一起丢给她。',tool_calls:[call('generate_image',{remark:'把这张设定图一起丢给她。',referenceIds:['character'],...plan})],usage:{input:100,output:80}};
    }
    const result=JSON.parse(String(messages.at(-1)!.content));assert.equal(result.references[0].id,'character');
    return {text:'这次她照着原图画的。',usage:{input:100,output:20}};
  }};
  f=setup(provider,undefined,client);
  await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');
  try{await f.bot.receive(message('把你自己参考图丢给gpt',{group:'private:20002',user:'20002'}));await f.bot.flush();assert.equal(round,4);assert.equal(f.transport.files.length,1);assert.equal(f.transport.sent.at(-1)?.text,'这次她照着原图画的。');}
  finally{await f.bot.stop();f.cleanup();}
});
test('private image broker shares quotas, requires a current image request and deduplicates message IDs',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],admins:['20002'],images:true});
  fs.mkdirSync(f.root+'/config');
  fs.writeFileSync(f.root+'/config/local.json',JSON.stringify(f.cfg()));
  const quota=new CodexQuotaMonitor(f.store,true,{read:async()=>{},close:async()=>{}}),broker=await startQQImageBroker(f.root,f.store,quota,true),client=new QQImageClient(f.root);
  try{
    const m=message('想要张图',{group:'private:20002',user:'20002'}),image=await client.generate(m,plan,1000);
    assert.equal(image.mock,true);assert.ok(fs.existsSync(f.root+'/runtime/outputs/'+image.imageId+'/image.png'));
    await assert.rejects(client.generate(m,plan,1000),/QQ_IMAGE_ALREADY_REQUESTED/);
    await assert.rejects(client.generate({...m,id:'question',text:'你还能画多少图？'},plan,1000),/QQ_IMAGE_REQUEST_REQUIRED/);
    await assert.rejects(client.status({...m,group:'private:30003',user:'30003'}),/TARGET_DENIED/);
    const status=await client.status(m);assert.equal(status.images.used,1);assert.equal(status.images.remaining,19);assert.equal(status.gpt.remainingImages,null);
    assert.equal(f.ledger.value('codex'),1);assert.equal(f.ledger.value('image'),1);
    for(const text of ['想要张图','我想要张图，随便画','来随便画张图'])assert.equal(requestsImage(text),true);
    for(const text of ['不要画图','还有多少张图','解释想要张图这句话'])assert.equal(requestsImage(text),false);
  }finally{await broker.close();await quota.close();f.cleanup();}
});
test('DeepSeek accepts native tool-call replies with null content and bounded tool definitions',async()=>{
  const f=fixture();try{
    const provider=new DeepSeekModel('fixture-key',f.cfg,(async(_url,init:any)=>{const body=JSON.parse(init.body);assert.equal(body.tools[0].function.name,'get_quota');assert.equal(body.tool_choice.function.name,'get_quota');return new Response(JSON.stringify({choices:[{message:{content:null,tool_calls:[call('get_quota',{})]}}],usage:{prompt_tokens:100,completion_tokens:20}}));}) as typeof fetch);
    const result=await provider.complete([{role:'user',content:'你累了吗'}],256,{toolChoice:'get_quota',tools:[{type:'function',function:{name:'get_quota',description:'读额度',parameters:{type:'object'}}}]});
    assert.equal(result.text,'');assert.equal(result.tool_calls?.[0].function.name,'get_quota');
  }finally{f.cleanup();}
});
