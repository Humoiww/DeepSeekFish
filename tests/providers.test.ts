import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { DeepSeekModel, BudgetedModel } from '../src/agent/model.js';
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
      return new Response(JSON.stringify({choices:[{message:{content:'回答'}}],usage:{prompt_tokens:12,completion_tokens:3}}));
    }) as typeof fetch;
    const model=new BudgetedModel(new DeepSeekModel('fixture-key',f.cfg,http),f.ledger,f.cfg);
    assert.equal(await model.call('g','u',[{role:'user',content:'hello'}]),'回答');assert.equal(f.ledger.value('tokens'),15);
    f.set({dailyTokens:15});await assert.rejects(model.call('g','u',[{role:'user',content:'hello'}]),/TOKEN_BUDGET/);assert.equal(calls,1);
  }finally{f.cleanup();}
});
test('official Search API sends bounded request; filters private sources; caches and prechecks quota',async()=>{
  const f=fixture({search:true,searchDaily:1});let calls=0;try{
    const http=(async(url:any,opts:any)=>{
      calls++;assert.equal(url,'https://api.deepseek.com/v1/tools/search');assert.deepEqual(JSON.parse(opts.body),{query:'test',count:3,need_content:false});
      return new Response(JSON.stringify({results:[{title:'safe',url:'https://example.com/a',snippet:'x'},{url:'http://127.0.0.1/a'},{url:'file:///etc/passwd'}]}));
    }) as typeof fetch;
    const s=new SearchService(new DeepSeekSearchProvider('fixture-key',f.cfg,http),f.ledger,f.cfg);
    assert.equal((await s.search('test','g','u')).length,1);await s.search('test','g','u');assert.equal(calls,1);
    await assert.rejects(s.search('next','g','u'),/SEARCH_BUDGET/);assert.equal(calls,1);
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
