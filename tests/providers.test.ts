import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { DeepSeekModel, BudgetedModel, ModelResponseError } from '../src/agent/model.js';
import { deepSeekUsage } from '../src/usage.js';
import { DeepSeekSearchProvider, SearchService, publicUrl } from '../src/search/provider.js';
import { normalize } from '../src/qq/adapter.js';
import fs from 'node:fs';
import { makeDir } from '../src/paths.js';
import { MockImageProvider,verifyPng } from '../src/image/provider.js';
test('real DeepSeek wire schema and usage settlement through fake HTTP, no paid calls',async()=>{
  const f=fixture();let calls=0;try{
    const http=(async(url:any,opts:any)=>{
      calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(opts.redirect,'error');
      const body=JSON.parse(opts.body);assert.equal(body.max_tokens,256);assert.equal(body.thinking.type,'disabled');
      return new Response(JSON.stringify({choices:[{message:{content:'回答'}}],usage:{prompt_tokens:12,completion_tokens:3,prompt_cache_hit_tokens:8,prompt_cache_miss_tokens:4}}));
    }) as typeof fetch;
    const model=new BudgetedModel(new DeepSeekModel('fixture-key',f.cfg,http),f.ledger,f.cfg);
    const result=await model.complete('g','u',[{role:'user',content:'hello'}]);assert.equal(result.text,'回答');assert.deepEqual(result.usage,{input:12,output:3,cachedInput:8,uncachedInput:4});assert.equal(f.ledger.value('tokens'),15);
    f.set({dailyCny:0});await assert.rejects(model.call('g','u',[{role:'user',content:'hello'}]),/CNY_BUDGET/);assert.equal(calls,1);
  }finally{f.cleanup();}
});
test('cache usage accepts documented fields, retains zero, and never invents missing or inconsistent splits',async()=>{
  const base={prompt_tokens:100,completion_tokens:20};
  assert.deepEqual(deepSeekUsage(base),{input:100,output:20});
  assert.deepEqual(deepSeekUsage({...base,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100}),{input:100,output:20,cachedInput:0,uncachedInput:100});
  assert.deepEqual(deepSeekUsage({...base,prompt_tokens_details:{cached_tokens:70}}),{input:100,output:20,cachedInput:70,uncachedInput:30});
  assert.deepEqual(deepSeekUsage({...base,prompt_cache_miss_tokens:25}),{input:100,output:20,cachedInput:75,uncachedInput:25});
  for(const details of [{prompt_cache_hit_tokens:90,prompt_cache_miss_tokens:20},{prompt_cache_hit_tokens:101},{prompt_cache_hit_tokens:-1},{prompt_cache_hit_tokens:'70'},{prompt_cache_hit_tokens:0.5}])assert.deepEqual(deepSeekUsage({...base,...details}),{input:100,output:20});
  const f=fixture();try{
    const provider=new DeepSeekModel('fixture-key',f.cfg,(async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'',tool_calls:[{id:'bad',type:'function',function:{name:'reply',arguments:'{'}}]}}],usage:{...base,prompt_cache_hit_tokens:80,prompt_cache_miss_tokens:20}}))) as typeof fetch);
    const model=new BudgetedModel(provider,f.ledger,f.cfg);
    await assert.rejects(model.complete('g','u',[{role:'user',content:'hello'}]),(error:any)=>error instanceof ModelResponseError&&error.usage?.cachedInput===80&&error.usage?.uncachedInput===20);
    assert.equal(f.ledger.value('tokens'),120);
  }finally{f.cleanup();}
});
test('official Search API sends bounded request; filters private sources; caches and prechecks quota',async()=>{
  const f=fixture({search:true,dailyCny:0.005});let calls=0;try{
    const http=(async(url:any,opts:any)=>{
      calls++;assert.equal(url,'https://api.deepseek.com/v1/tools/search');assert.deepEqual(JSON.parse(opts.body),{query:'test',count:3,need_content:false});
      return new Response(JSON.stringify({results:[{title:'safe',url:'https://example.com/a',snippet:'x'},{url:'http://127.0.0.1/a'},{url:'file:///etc/passwd'}]}));
    }) as typeof fetch;
    const s=new SearchService(new DeepSeekSearchProvider('fixture-key',f.cfg,http),f.ledger,f.cfg);
    assert.equal((await s.search('test','g','u')).length,1);await s.search('test','g','u');assert.equal(calls,1);
    await assert.rejects(s.search('next','g','u'),/CNY_BUDGET/);assert.equal(calls,1);
    await assert.rejects(s.search('a'.repeat(129),'g','u'),/SEARCH_QUERY/);
    for(const url of ['file:///x','http://localhost','http://0x7f000001','http://2130706433','http://[::1]','http://192.168.1.1','http://172.16.0.1','http://169.254.169.254','http://user:pass@example.com','http://foo.local'])assert.equal(publicUrl(url),false,url);
  }finally{f.cleanup();}
});
test('QQ capability depends on native event, mention markers and server mention metadata',()=>{
  const base:any={kind:'group',groupOpenid:'g',senderId:'u',messageId:'id',timestamp:new Date().toISOString(),content:'你好',rawEventType:'GROUP_AT_MESSAGE_CREATE'};
  assert.equal(normalize(base,'123')?.mentioned,true);
  assert.equal(normalize({...base,rawEventType:'GROUP_MESSAGE_CREATE'},'123')?.event,'ordinary');
  assert.equal(normalize({...base,rawEventType:'GROUP_MESSAGE_CREATE'},'123')?.mentioned,false);
  assert.equal(normalize({...base,rawEventType:'GROUP_MESSAGE_CREATE',mentions:[{is_you:true}]},'123')?.mentioned,true);
  assert.equal(normalize({...base,rawEventType:'GROUP_MESSAGE_CREATE',content:'<@!123> hello'},'123')?.text,'hello');
  assert.equal(normalize({...base,kind:'c2c'},'123'),undefined);
});
test('image fixture has valid PNG chunk checksums; corrupt image is rejected',async()=>{
  const f=fixture();try{
    const out=makeDir(f.root,'runtime/outputs/image');const r=await new MockImageProvider().generate('test',out);
    assert.equal(r.status,'ok');const p=verifyPng(out,'mock.png',1000);
    const bytes=fs.readFileSync(p);bytes[45]^=1;fs.writeFileSync(p,bytes);assert.throws(()=>verifyPng(out,'mock.png',1000),/INVALID_PNG/);
  }finally{f.cleanup();}
});

test('official Fetch uses the fixed API, caches long pages and reports real failures',async()=>{
  const f=fixture({search:true,dailyCny:0.01});let calls=0;
  try{
    const http=(async(url:any,options:any)=>{
      calls++;assert.equal(url,'https://api.deepseek.com/v1/tools/fetch');assert.equal(options.redirect,'error');
      const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['url']);
      if(body.url.endsWith('/missing'))return new Response('{}',{status:404});
      return new Response(JSON.stringify({title:'长文',content:'a'.repeat(6100)}));
    }) as typeof fetch;
    const s=new SearchService(new DeepSeekSearchProvider('fixture-key',f.cfg,http),f.ledger,f.cfg);
    await assert.rejects(s.fetch('http://100.64.0.1/','g','u'),/FETCH_PUBLIC_URL_REQUIRED/);assert.equal(calls,0);
    const page=await s.fetch('https://example.com/article','g','u');assert.equal(page.content.length,6000);assert.equal(page.nextOffset,6000);
    const rest=await s.fetch(page.url+'#anchor','g','u',page.nextOffset!);assert.equal(rest.content.length,100);assert.equal(rest.nextOffset,null);assert.equal(rest.truncated,false);assert.equal(calls,1);
    await assert.rejects(s.fetch('https://example.com/missing','g','u'),/FETCH_HTTP_404/);assert.equal(f.ledger.value('search'),2);
    assert.equal(f.ledger.costSummary().used,0.005);f.set({dailyCny:0.005});await assert.rejects(s.search('later','g','u'),/CNY_BUDGET_EXHAUSTED/);
    f.set({search:false});await assert.rejects(s.fetch(page.url,'g','u'),/SEARCH_DISABLED/);
  }finally{f.cleanup();}
});
