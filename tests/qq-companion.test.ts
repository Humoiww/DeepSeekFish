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
import { QQImageClient } from '../src/qq/image-client.js';
import { startQQImageBroker } from '../src/qq/image-broker.js';
import { qqResources } from '../src/qq/resources.js';
import { CodexQuotaMonitor } from '../src/codex/quota.js';
import { requestsImage } from '../src/web/images.js';
import type { Model,ToolCall } from '../src/types.js';

const call=(name:string,args:unknown):ToolCall=>({id:'tool-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}});
const plan={subject:'一条蓝色的小鱼',scene:'服务器旁边',style:'柔和插画',composition:'主体居中',lighting:'暖光',palette:'蓝白',details:'没有文字'};
function setup(provider:Model,people?:PersonMemory,client?:QQImageClient){
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],admins:['20002'],images:true,bufferMs:10000});
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),transport=new MockTransport();
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,people,client);
  return {...f,bot,transport};
}
test('QQ sends the model-authored remark before fetching Space, then continues from actual media',async()=>{
  let turns=0,f:ReturnType<typeof setup>;
  const people={remembered:()=>undefined,refresh:async()=>{assert.equal(f.transport.sent[0].text,'哟，你又整什么活了？');return {profile:{nickname:'测试朋友'},posts:[{text:'自热锅太大了',publishedAt:Date.now()}],observedAt:Date.now(),errors:[]};},images:()=>[{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}],close:async()=>{}} as unknown as PersonMemory;
  const provider:Model={kind:'fixture',async complete(messages,_max,options){turns++;assert.ok(options?.tools?.some(t=>t.function.name==='get_person'));
    if(turns===1){assert.equal(options?.toolChoice,'get_person');assert.ok(!String(messages[0].content).includes('区分发布时间'));return {text:'',tool_calls:[call('get_person',{view:'latest',remark:'哟，你又整什么活了？'})],usage:{input:100,output:30}};}
    assert.equal(messages.filter(m=>m.role==='tool').length,1);assert.ok(Array.isArray(messages.at(-1)!.content));
    return {text:'这么大一口锅，你是准备把桌子也煮了嘛。',usage:{input:300,output:30}};
  }};
  f=setup(provider,people);
  try{await f.bot.receive(message('评判一下我最新动态',{group:'private:20002',user:'20002'}));await f.bot.flush();
    assert.deepEqual(f.transport.sent.map(m=>m.text),['哟，你又整什么活了？','这么大一口锅，你是准备把桌子也煮了嘛。']);
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
