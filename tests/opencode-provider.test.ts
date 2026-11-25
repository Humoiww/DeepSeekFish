import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './helpers.js';
import {defaults,providerCredential,saveProviderCredential,validateConfig} from '../src/config.js';
import {ConnectionProfiles,liveModelConfig} from '../src/provider/connections.js';
import {OpenCodeCatalog,modelsDevGo,openCodeModelList,openCodeChatUrl,openCodeModelsUrl} from '../src/provider/opencode.js';
import {BudgetedModel,modelPayload,OpenCodeGoModel,RoutedChatModel} from '../src/agent/model.js';
import {traceModel} from '../src/agent/model-trace.js';
import {modelPricing} from '../src/budget/pricing.js';
import {DeepSeekSearchProvider} from '../src/search/provider.js';
import type {ChatMessage} from '../src/types.js';

const row=(id:string,protocol:string,vision=false)=>({
 id,name:id,type:'chat',api:{[protocol]:{}},modalities:{input:vision?['text','image/png']:['text']},
 capabilities:{tools:{supported:true}},limit:{context:32000,output:4096},
 cost:{text:{input:{price:0.15,cache:{read:0.03}},output:{price:0.5}}},
});
const catalogRows={data:[row('glm-5.3-flash','chat-completions'),row('vision-model','chat-completions',true),
 row('claude','messages'),row('gemini','generate-content'),row('gpt','responses')]};
const chat=()=>Response.json({choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{
 prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:60},
}});
const messages:ChatMessage[]=[{role:'user',content:'你好'}];
const images:ChatMessage[]=[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,abc='}}]}];

test('connection config preserves legacy defaults, validates presets and shares selected profiles without exposing keys',()=>{
 const f=fixture();
 try{
  const cfg=()=>liveModelConfig(f.cfg(),f.store),connections=new ConnectionProfiles(f.root,f.store,cfg);
  assert.equal(validateConfig({model:'deepseek-v4-pro'}).provider,'deepseek');
  assert.equal(validateConfig({}).usdToCny,7.2);
  assert.equal(validateConfig({provider:'opencode_go'}).disableThinking,true);
  for(const input of [{provider:'unknown'},{usdToCny:0},{usdToCny:Infinity},{connectionPresets:null},
    {activePresetId:'missing'},{keySlot:'opencode_go'},{disableThinking:'false'},{connectionPresets:[{id:'invalid'}]}]){
   assert.throws(()=>validateConfig(input));
  }
  const legacy=path.join(f.root,'runtime/data/webui-secrets.json');
  fs.writeFileSync(legacy,JSON.stringify({deepseekKey:'legacy-deepseek-key'}),{mode:0o600});
  connections.save({name:'日常编程',provider:'opencode_go',model:'glm-5.3-flash',maxOutputTokens:512,keySlot:'work',apiKey:'opencode-private-key'});
  const id=cfg().activePresetId!;
  assert.equal(cfg().provider,'opencode_go');
  assert.equal(cfg().maxOutputTokens,512);
  assert.equal(cfg().disableThinking,true);
  assert.equal(providerCredential(f.root,'deepseek'),'legacy-deepseek-key');
  assert.equal(providerCredential(f.root,'opencode_go','work'),'opencode-private-key');
  assert.equal(providerCredential(f.root,'deepseek','work'),'');
  connections.configure({apiKey:'',usdToCny:7.3});
  assert.equal(providerCredential(f.root,'opencode_go','work'),'opencode-private-key');
  assert.equal(cfg().usdToCny,7.3);
  assert.equal(connections.status().opencode_go.keys.work.configured,true);
  assert.doesNotMatch(JSON.stringify(connections.status()),/legacy-deepseek-key|opencode-private-key/);
  if(process.platform!=='win32')assert.equal(fs.statSync(legacy).mode&0o777,0o600);
  connections.save({id,name:'更新的名称',provider:'opencode_go',model:'vision-model',maxOutputTokens:1024,keySlot:'work',disableThinking:false});
  connections.save({id,name:'旧页面编辑',provider:'opencode_go',model:'vision-model',maxOutputTokens:1024,keySlot:'work'});
  assert.equal(cfg().connectionPresets?.length,1);
  assert.equal(cfg().model,'vision-model');
  assert.equal(cfg().connectionPresets?.[0].disableThinking,false);
  connections.configure({provider:'deepseek'});
  assert.equal(cfg().model,defaults.model);
  assert.equal(connections.status().opencode_go.disableThinking,false);
  connections.configure({provider:'opencode_go',disableThinking:true});
  assert.equal(cfg().disableThinking,true);
  connections.configure({activePresetId:id});
  assert.equal(cfg().provider,'opencode_go');
  assert.equal(cfg().disableThinking,false);
  connections.delete({id});
  assert.equal(cfg().activePresetId,undefined);
  assert.deepEqual(cfg().connectionPresets,[]);
  assert.equal(providerCredential(f.root,'opencode_go','work'),'opencode-private-key');
 }finally{f.cleanup();}
});

test('Go model catalog honors protocol, capabilities, prices, scoped credentials, single flight, debounce and offline cache',async()=>{
 const f=fixture();
 try{
  const parsed=openCodeModelList(catalogRows);
  assert.deepEqual(parsed.map(model=>[model.id,model.supportsTools,model.supportsVision]),[
   ['glm-5.3-flash',true,false],['vision-model',true,true],
  ]);
  assert.equal(parsed[0].cacheReadUsdPerMillion,0.03);
  const translated=openCodeModelList({data:[row('MINIMAX-M3','messages'),row('qwen3.8-flash','messages'),
   row('claude-haiku-5-5','messages'),row('glm-5.2','chat-completions'),row('kimi-k2.7-code','chat-completions')]});
  assert.deepEqual(translated.map(model=>[model.id,model.disableThinkingSupport]),[
   ['MINIMAX-M3','supported'],['qwen3.8-flash','supported'],['claude-haiku-5-5','unsupported'],['kimi-k2.7-code','unsupported'],
  ]);
  assert.match(translated[2].disableThinkingReason??'',/Chat Completions 路线拒绝关闭/);
  const metadata=modelsDevGo({'opencode-go':{npm:'@ai-sdk/openai-compatible',api:'https://opencode.ai/inference/go/openai/v1',models:{
   compatible:{id:'legacy',tool_call:true,cost:{input:0.4,output:1}},
   messages:{id:'anthropic',provider:{npm:'@ai-sdk/anthropic',api:'https://opencode.ai/inference/go/anthropic/v1'}},
   translated:{id:'minimax-m3',provider:{npm:'@ai-sdk/anthropic'}},
  }}});
  assert.deepEqual(metadata.map(model=>model.id),['legacy','minimax-m3']);
  assert.deepEqual(openCodeModelList({data:[{id:'legacy'},{id:'anthropic'}]},metadata).map(model=>model.id),['legacy']);
  assert.deepEqual(openCodeModelList({data:[{id:'legacy',api:{responses:{}}}]},metadata),[]);
  saveProviderCredential(f.root,'opencode_go','work','private-catalog-key');
  let calls=0,now=Date.now();
  const http=(async(url,options)=>{
   calls++;
   assert.equal(url,openCodeModelsUrl);
   assert.equal(new Headers(options?.headers).get('authorization'),'Bearer private-catalog-key');
   return Response.json(catalogRows);
  }) as typeof fetch;
  const directory=new OpenCodeCatalog(f.root,false,http,()=>now);
  const [first,second]=await Promise.all([directory.get('work'),directory.get('work',true)]);
  assert.deepEqual(first,second);
  assert.equal(calls,1);
  await directory.get('work',true);
  assert.equal(calls,1);
  const cold=new OpenCodeCatalog(f.root,false,http,()=>now);
  assert.deepEqual(cold.peek('work'),JSON.parse(JSON.stringify(first.models)));
  assert.deepEqual(await cold.get('work'),JSON.parse(JSON.stringify(first)));
  now+=30*60_000+1;
  await directory.get('work');
  assert.equal(calls,2);
  assert.equal((await new OpenCodeCatalog(f.root,true,http).get()).source,'mock');
 }finally{f.cleanup();}
});

test('Go sends only the verified non-thinking parameter for each model and retains reasoning for thinking tool rounds',async()=>{
 let cfg=validateConfig({provider:'opencode_go'});
 const sent:Record<string,any>[]=[];
 const calls=[{id:'call-1',type:'function',function:{name:'fixture_tool',arguments:'{}'}}];
 const http=(async(_url,options)=>{
  sent.push(JSON.parse(String(options?.body)));
  return Response.json({choices:[{message:{content:null,tool_calls:calls,reasoning_content:'fixture reasoning'},finish_reason:'tool_calls'}],
   usage:{prompt_tokens:20,completion_tokens:10}});
 }) as typeof fetch;
 const provider=new OpenCodeGoModel('fixture',()=>cfg,http);
 const cases=[
  [['glm-5.3','GLM-5.3-FLASH','mimo-v2.6-flash'],{reasoning_effort:'none'}],
  [['qwen3.8-flash','qwen4-max','qwen3.8-max','qwen3.7-plus'],{enable_thinking:false}],
  [['minimax-m3','deepseek-v4-pro','deepseek-v4.1-flash','kimi-k3','kimi-k3.1-pro','mimo-v2.6-pro'],{thinking:{type:'disabled'}}],
  [['minimax-m3.1-flash','kimi-k2.7-code','claude-haiku-5-5','claude-haiku-5.5','unknown-model'],{}],
 ] as const;
 for(const [models,parameters] of cases){
  for(const model of models){
   cfg={...cfg,model,disableThinking:true};
   await provider.complete(messages,64);
   assert.deepEqual(sent.at(-1),{model,messages,stream:false,max_tokens:64,...parameters},model);
   cfg={...cfg,disableThinking:false};
   await provider.complete(messages,64);
   assert.deepEqual(sent.at(-1),{model,messages,stream:false,max_tokens:64},model);
  }
 }
 for(const model of ['glm-5.3-flash','kimi-k2.7-code']){
  cfg={...cfg,model,disableThinking:false};
  const first=await provider.complete(messages,64);
  const continued:ChatMessage[]=[...messages,{role:'assistant',content:'',tool_calls:first.tool_calls},
   {role:'tool',content:'fixture result',tool_call_id:'call-1'}];
  await provider.complete(continued,64);
  assert.equal(sent.at(-1)?.messages[1].reasoning_content,'fixture reasoning');
  cfg={...cfg,disableThinking:true};
  await provider.complete(continued,64);
  assert.equal(sent.at(-1)?.messages[1].reasoning_content,model==='kimi-k2.7-code'?'fixture reasoning':undefined);
 }
 assert.deepEqual(modelPayload(validateConfig({disableThinking:false}),messages,64),
  {model:defaults.model,messages,stream:false,max_tokens:64,thinking:{type:'disabled'}});
});

test('Go sends standard payload with stable opaque session, parses cache usage, records 429 and preserves fixed DeepSeek search',async()=>{
 const f=fixture({provider:'opencode_go',model:'glm-5.3-flash'});
 try{
  saveProviderCredential(f.root,'opencode_go','opencode_go','go-provider-key');
  saveProviderCredential(f.root,'deepseek','deepseek','deepseek-provider-key');
  let limited=false;const sent:{url:string;body:any;headers:Headers}[]=[];
  const http=(async(url,options)=>{
   if(url===openCodeModelsUrl)return Response.json(catalogRows);
   sent.push({url:String(url),body:JSON.parse(String(options?.body)),headers:new Headers(options?.headers)});
   if(String(url).endsWith('/v1/tools/search'))return Response.json({results:[{url:'https://example.com/a',title:'A'}]});
   if(limited)return Response.json({error:{message:'go-provider-key throttled'}},{status:429,headers:{'retry-after':'15'}});
   return chat();
  }) as typeof fetch;
  const provider=new RoutedChatModel(f.root,f.cfg,f.ledger,new OpenCodeCatalog(f.root,false,http),http);
  const model=new BudgetedModel(provider,f.ledger,f.cfg);
  const tool={type:'function' as const,function:{name:'fixture_tool',description:'mock',parameters:{type:'object'}}};
  const result=await model.complete('private:987654','u',messages,{tools:[tool]});
  assert.deepEqual(result.usage,{input:100,output:20,cachedInput:60,uncachedInput:40});
  assert.equal(result.route?.provider,'opencode_go');
  assert.equal('thinking' in sent[0].body,false);
  assert.equal(sent[0].body.reasoning_effort,'none');
  assert.equal(sent[0].body.max_tokens,256);
  assert.equal(sent[0].body.tool_choice,'auto');
  assert.equal(sent[0].url,openCodeChatUrl);
  const session=sent[0].headers.get('x-opencode-session');
  assert.match(session??'',/^[a-f0-9]{64}$/);
  assert.equal(sent[0].headers.get('authorization'),'Bearer go-provider-key');
  limited=true;
  await assert.rejects(model.complete('private:987654','u',messages),error=>{
   assert.equal((error as any).code,'OPENCODE_HTTP_429');
   assert.doesNotMatch(JSON.stringify(error),/go-provider-key/);
   return true;
  });
  assert.equal(sent[1].headers.get('x-opencode-session'),session);
  assert.equal(provider.rateLimit()?.retryAfterMs,15000);
  const search=new DeepSeekSearchProvider(()=>providerCredential(f.root,'deepseek'),f.cfg,http);
  await search.search('query');
  assert.equal(sent[2].url,'https://api.deepseek.com/v1/tools/search');
  assert.equal(sent[2].headers.get('authorization'),'Bearer deepseek-provider-key');
  const noNetwork=new OpenCodeGoModel('go-provider-key',f.cfg,(async()=>{throw new Error('offline');}) as typeof fetch);
  await assert.rejects(noNetwork.complete(messages,256),/OPENCODE_NETWORK_ERROR/);
 }finally{f.cleanup();}
});

test('vision fallback chooses DeepSeek before reservation, logs actual request, and leaves the Go selection intact',async()=>{
 const f=fixture({provider:'opencode_go',model:'glm-5.3-flash'});
 try{
  saveProviderCredential(f.root,'opencode_go','opencode_go','go-fixture-key');
  saveProviderCredential(f.root,'deepseek','deepseek','deepseek-fixture-key');
  const sent:{url:string;body:any;auth:string|null}[]=[];
  const http=(async(url,options)=>{
   if(url===openCodeModelsUrl)return Response.json(catalogRows);
   sent.push({url:String(url),body:JSON.parse(String(options?.body)),auth:new Headers(options?.headers).get('authorization')});
   return chat();
  }) as typeof fetch;
  const model=new BudgetedModel(new RoutedChatModel(f.root,f.cfg,f.ledger,new OpenCodeCatalog(f.root,false,http),http),f.ledger,f.cfg);
  const trace:any[]=[];
  const result=await traceModel(trace,()=>{},null,0,onReservation=>model.complete('g','u',images,{onReservation}));
  assert.equal(trace[0].fallbackFrom,'opencode_go');
  assert.equal(trace[0].request.model,defaults.model);
  assert.equal(sent[0].url,'https://api.deepseek.com/chat/completions');
  assert.deepEqual(sent[0].body.thinking,{type:'disabled'});
  assert.equal(sent[0].auth,'Bearer deepseek-fixture-key');
  assert.equal((result.billing!.pricing as any).provider,'deepseek');
  assert.equal(f.ledger.providerWindowUsage('opencode_go').today.requests,0);
  assert.equal(f.cfg().provider,'opencode_go');
  f.set({model:'vision-model'});
  await model.complete('g','u',images);
  assert.equal(sent[1].url,openCodeChatUrl);
  assert.equal(f.ledger.providerWindowUsage('opencode_go').today.requests,1);
 }finally{f.cleanup();}
});

test('Go prices settle in CNY, retain three time windows through budget reset and enforce the same daily cap',()=>{
 const f=fixture({provider:'opencode_go',model:'glm-5.3-flash',dailyCny:0.05});
 try{
  const info=openCodeModelList(catalogRows)[0],now=Date.parse('2026-11-25T02:00:00+08:00');
  const price=(at:number)=>modelPricing(info.id,at,{provider:'opencode_go',usdToCny:7.2,info});
  assert.equal(price(now).uncachedNano,1080);
  assert.equal(price(now).cachedNano,216);
  assert.equal(price(now).outputNano,3600);
  const estimate=modelPricing('unknown-go-model',now,{provider:'opencode_go',usdToCny:7.2});
  assert.equal(estimate.calendarKnown,false);
  assert.equal(estimate.outputNano,28800);
  for(const age of [1,3,6,192]){
   const id=f.ledger.reserveModel('g','u',1000,200,false,price(now-age*3600000));
   const snapshot=f.ledger.receipt(id)!.pricing;
   assert.equal('provider' in snapshot&&snapshot.provider,'opencode_go');
   f.ledger.settle(id,{input:1000,output:100,cachedInput:200,uncachedInput:800});
  }
  const usage=f.ledger.providerWindowUsage('opencode_go',now);
  assert.equal(usage.fiveHours.requests,2);
  assert.equal(usage.today.requests,1);
  assert.equal(usage.sevenDays.requests,3);
  assert.equal(usage.today.input,1000);
  assert.equal(usage.today.output,100);
  assert.equal(usage.today.cny,0.0012672);
  f.set({dailyCny:0.001});
  const date=Date.now();
  assert.throws(()=>f.ledger.reserveModel('g','u',1000,200,false,price(date)),/CNY_BUDGET_EXHAUSTED/);
  f.set({dailyCny:0.05});
  const current=f.ledger.reserveModel('g','u',1000,200,false,price(date));
  f.ledger.settle(current,{input:1000,output:100,cachedInput:200});
  const total=f.ledger.providerWindowUsage('opencode_go').today;
  f.ledger.resetCosts();
  const reset=f.ledger.providerWindowUsage('opencode_go').today;
  assert.equal(reset.requests,total.requests);
  assert.equal(reset.cny,total.cny);
  assert.equal(reset.budgetCny,0);
 }finally{f.cleanup();}
});
