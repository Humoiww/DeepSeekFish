import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { personaSettings,savePersona,personalityPrompt,appearancePrompt } from '../src/character.js';
import { promptSystems } from '../src/prompts.js';
import { recordPrompt,promptSnapshots } from '../src/prompt-record.js';
import { createWebApp } from '../src/web/app.js';
import { webServer } from '../src/web/server.js';
import { BudgetedModel } from '../src/agent/model.js';
import { qqResources } from '../src/qq/resources.js';

test('persona edits persist by block, update all channel prompts, and reject stale saves',()=>{
  const f=fixture();try{
    const original=personaSettings(f.root);assert.equal(original.blocks.length,3);
    const saved=savePersona(f.root,{...original,blocks:[{title:'自定义',text:'测试人格甲'},{title:'语气',text:'测试人格乙'}],appearance:'测试外观'});
    assert.equal(personalityPrompt(f.root),'测试人格甲\n测试人格乙');assert.equal(appearancePrompt(f.root),'测试外观');
    for(const system of Object.values(promptSystems(f.root)))assert.ok(system.includes('测试人格甲\n测试人格乙'));
    assert.equal(fs.statSync(f.root+'/runtime/data/persona.json').mode&0o777,0o600);
    assert.throws(()=>savePersona(f.root,{...original,blocks:[]}),/PERSONA_INVALID/);
    assert.throws(()=>savePersona(f.root,original),/PERSONA_CHANGED_RELOAD/);
    assert.equal(personaSettings(f.root).revision,saved.revision);
  }finally{f.cleanup();}
});
test('actual request diagnostics retain tool definitions and messages without raw images or credentials',()=>{
  const f=fixture();try{
    recordPrompt(f.store,'qq',{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.org/private-token',detail:'high'}},{type:'text',text:'实际内容'}]}],tools:[{name:'get_quota'}]});
    const snapshot=promptSnapshots(f.store).qq;assert.equal(snapshot.request.tools[0].name,'get_quota');
    assert.ok(JSON.stringify(snapshot).includes('实际内容'));assert.ok(!JSON.stringify(snapshot).includes('private-token'));
  }finally{f.cleanup();}
});
test('a running model reads the edited QQ prompt on the next call and image allowance ignores Codex caps',async()=>{
  const f=fixture({codexDaily:0,codexDailyMs:0,imageDaily:2});try{
    const received:string[]=[];const model=new BudgetedModel({kind:'test',async complete(messages){received.push(String(messages[0].content));return {text:'ok',usage:{input:1,output:1}};}},f.ledger,f.cfg);
    await model.call('g','u',[{role:'system',content:promptSystems(f.root).qq}]);
    savePersona(f.root,{...personaSettings(f.root),blocks:[{title:'人格',text:'新人格即时生效'}]});
    await model.call('g','u',[{role:'system',content:promptSystems(f.root).qq}]);assert.ok(received[1].includes('新人格即时生效'));assert.ok(!received[0].includes('新人格即时生效'));
    const pair=f.ledger.reserveImageJob('g','u',100000);assert.equal(qqResources(f.cfg(),f.ledger,'g','u').images.remaining,1);
    assert.throws(()=>f.ledger.reserveImageJob('g','u',100000),/CODEX_BUSY/);
    f.ledger.settle(pair.codex,undefined,100);f.ledger.settle(pair.image);
    const pair2=f.ledger.reserveImageJob('g','u',100000);f.ledger.settle(pair2.codex,undefined,200);f.ledger.settle(pair2.image);
    assert.throws(()=>f.ledger.reserveImageJob('g','u',100000),/IMAGE_BUDGET_EXHAUSTED/);assert.equal(f.ledger.value('codex'),2);
    assert.throws(()=>f.ledger.reserve('codex','g','u'),/CODEX_BUDGET_EXHAUSTED/);
  }finally{f.cleanup();}
});
test('authenticated UI edits take effect without restarting the web app and full snapshot matches its model request',async()=>{
  const f=fixture(),app=createWebApp(f.root,true),port=44000+Math.floor(Math.random()*10000),{server}=webServer(app,port);
  try{
    server.listen(port,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+port+'/api/';
    const request=(route:string,body?:unknown,auth=true)=>fetch(base+route,{method:body?'POST':'GET',headers:{...(auth?{authorization:'Bearer '+app.token}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await request('prompts',undefined,false)).status,401);assert.equal((await request('persona',{},false)).status,401);
    const original=await (await request('persona')).json() as any,s=app.createSession();
    const changed={...original,blocks:[{title:'一',text:'人格热更新测试'}]};assert.equal((await request('persona',changed)).status,200);
    await app.chat(s.id,'你好','chat',new AbortController().signal,()=>{});
    const prompts=await (await request('prompts')).json() as any;
    assert.equal(prompts.latest.web.request.messages[0].content,prompts.systems.web);assert.ok(prompts.systems.web.includes('人格热更新测试'));
    assert.equal(prompts.latest.web.request.thinking.type,'disabled');assert.ok(!JSON.stringify(prompts).includes(app.token));
    assert.equal((await request('persona',original)).status,400);
  }finally{await app.close();server.close();await once(server,'close');f.cleanup();}
});
