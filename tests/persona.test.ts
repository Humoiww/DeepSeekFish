import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { fixture,assertPersonaLayout } from './helpers.js';
import { personaSettings,savePersona,personalityPrompt,appearancePrompt,staticPersonalityPrompt,voiceExamplesPrompt } from '../src/character.js';
import { promptSystems } from '../src/prompts.js';
import { recordPrompt,promptSnapshots } from '../src/prompt-record.js';
import { createWebApp } from '../src/web/app.js';
import { webServer } from '../src/web/server.js';
import { BudgetedModel } from '../src/agent/model.js';
import { qqResources } from '../src/qq/resources.js';
import {extractKaomoji} from '../src/character.js';
import {projectRoot} from '../src/config.js';

test('persona edits persist by block, update all channel prompts, and reject stale saves',()=>{
  const f=fixture();try{
    const original=personaSettings(f.root);assert.equal(original.blocks.length,4);
    assert.equal(original.voiceExamples,'');assert.equal(voiceExamplesPrompt(f.root),'');
    const saved=savePersona(f.root,{...original,blocks:[{title:'自定义',text:'测试人格甲'},{title:'语气',text:'测试人格乙'}],appearance:'测试外观'});
    const first=staticPersonalityPrompt(f.root);
    assert.equal(first,'测试人格甲\n测试人格乙');
    const sampled=new Set<string>();
    for(let i=0;i<8;i++){
      assert.equal(staticPersonalityPrompt(f.root),first);
      const full=personalityPrompt(f.root);
      assert.ok(full.startsWith(first+'\n颜文字范例'));sampled.add(full);
    }
    assert.ok(sampled.size>1);assert.equal(appearancePrompt(f.root),'测试外观');
    for(const system of Object.values(promptSystems(f.root)))assert.ok(system.includes('测试人格甲\n测试人格乙'));
    assert.equal(fs.statSync(f.root+'/runtime/data/persona.json').mode&0o777,0o600);
    assert.throws(()=>savePersona(f.root,{...original,blocks:[]}),/PERSONA_INVALID/);
    assert.throws(()=>savePersona(f.root,original),/PERSONA_CHANGED_RELOAD/);
    assert.equal(personaSettings(f.root).revision,saved.revision);
    fs.writeFileSync(f.root+'/runtime/data/persona.json',JSON.stringify({blocks:saved.blocks,appearance:saved.appearance}));
    const legacy=personaSettings(f.root);
    assert.equal(legacy.voiceExamples,'');assert.equal(legacy.revision,saved.revision);
    assert.throws(()=>savePersona(f.root,{...legacy,voiceExamples:'鱼'.repeat(4001)}),/PERSONA_INVALID/);
  }finally{f.cleanup();}
});
test('actual request diagnostics retain tool definitions and messages without raw images or credentials',()=>{
  const f=fixture();try{
    recordPrompt(f.store,'qq',{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.org/private-token',detail:'high'}},{type:'text',text:'实际内容'}]}],tools:[{name:'get_quota'}]});
    const snapshot=promptSnapshots(f.store).qq;assert.equal(snapshot.request.tools[0].name,'get_quota');
    assert.ok(JSON.stringify(snapshot).includes('实际内容'));assert.ok(!JSON.stringify(snapshot).includes('private-token'));
  }finally{f.cleanup();}
});

test('kaomoji extraction recognizes library and new faces without collecting prose, links or code',()=>{
 const faces=['(/ω＼)','(>_<)','( ͡ᴖ ͜ʖ ͡ᴖ)','∠( ᐛ 」∠)＿'];
 assert.deepEqual(extractKaomoji('今天 '+faces.join(' 然后 ')+' '+faces[0]),faces);
 assert.deepEqual(extractKaomoji('普通标点，……！？（这里是补充说明）(hello) (a+b) (x^2) foo(^_^)'),[]);
 assert.deepEqual(extractKaomoji('https://example.com/(^_^) ftp://example.com/(>_<) `(+_+)`\n```js\nconst face="(T_T)";\n```\n<code>(o_o)</code>'),[]);
 assert.deepEqual(extractKaomoji('```js\nconst face="(^_^)";'),[]);
 assert.deepEqual(extractKaomoji('(´Д` ) (´Д` ) `(^_^)`'),['(´Д` )']);
});

test('persona exclusion samples two per emotion, prefers unexcluded entries and falls back without changing its structure',()=>{
 const f=fixture();
 try{
  const categories=Object.values(JSON.parse(fs.readFileSync(projectRoot()+'/assets/kaomoji/emotions.json','utf8'))) as {label:string;entries:string[]}[];
  const heading='颜文字范例（需要时参考）：',excluded=categories.flatMap(c=>c.entries.slice(0,-2));
  const normal=personalityPrompt(f.root),filtered=personalityPrompt(f.root,{excludeKaomoji:new Set(excluded)});
  assert.equal(filtered.split(heading).length,2);assert.equal(filtered.split(heading)[0],normal.split(heading)[0]);
  const lines=filtered.split(heading+'\n')[1].split('\n').slice(0,categories.length);assert.equal(lines.length,14);
  for(const [index,category] of categories.entries()){
   assert.ok(lines[index].startsWith(category.label+'：'));
   assert.deepEqual(new Set(lines[index].slice(category.label.length+1).split('　｜　')),new Set(category.entries.slice(-2)));
  }
  const all=categories.flatMap(c=>c.entries),only=categories[0].entries[0];
  for(const excludeKaomoji of [all,all.filter(v=>v!==only)]){
   const prompt=personalityPrompt(f.root,{excludeKaomoji});
   const sampled=prompt.split(heading+'\n')[1].split('\n').slice(0,categories.length);
   for(const [i,category] of categories.entries()){
    const pair=sampled[i].slice(category.label.length+1).split('　｜　');assert.equal(new Set(pair).size,2);assert.ok(pair.every(v=>category.entries.includes(v)));
    if(i===0&&excludeKaomoji.length<all.length)assert.ok(pair.includes(only));
   }
  }
 }finally{f.cleanup();}
});

test('a running model reads the edited QQ prompt on the next call and image allowance is tracked independently of Codex usage',async()=>{
  const f=fixture({imageDaily:2});try{
    const received:string[]=[];const model=new BudgetedModel({kind:'test',async complete(messages){received.push(String(messages[0].content));return {text:'ok',usage:{input:1,output:1}};}},f.ledger,f.cfg);
    await model.call('g','u',[{role:'system',content:promptSystems(f.root).qq}]);
    savePersona(f.root,{...personaSettings(f.root),blocks:[{title:'人格',text:'新人格即时生效'}]});
    await model.call('g','u',[{role:'system',content:promptSystems(f.root).qq}]);assert.ok(received[1].includes('新人格即时生效'));assert.ok(!received[0].includes('新人格即时生效'));
    const pair=f.ledger.reserveImageJob('g','u',100000);assert.equal(qqResources(f.cfg(),f.ledger,'g','u').images.remaining,1);
    assert.throws(()=>f.ledger.reserveImageJob('g','u',100000),/CODEX_BUSY/);
    f.ledger.settle(pair.codex,undefined,100);f.ledger.settle(pair.image);
    const pair2=f.ledger.reserveImageJob('g','u',100000);f.ledger.settle(pair2.codex,undefined,200);f.ledger.settle(pair2.image);
    assert.throws(()=>f.ledger.reserveImageJob('g','u',100000),/IMAGE_BUDGET_EXHAUSTED/);assert.equal(f.ledger.value('codex'),2);
    f.ledger.settle(f.ledger.reserve('codex','g','u'));
    assert.equal(f.ledger.value('image'),2);
  }finally{f.cleanup();}
});
test('authenticated UI edits take effect without restarting the web app and appear in its model request',async()=>{
  const f=fixture(),app=createWebApp(f.root,true),port=44000+Math.floor(Math.random()*10000),{server}=webServer(app,port);
  try{
    server.listen(port,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+port+'/api/';
    const request=(route:string,body?:unknown,auth=true)=>fetch(base+route,{method:body?'POST':'GET',headers:{...(auth?{authorization:'Bearer '+app.token}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await request('prompts',undefined,false)).status,401);assert.equal((await request('persona',{},false)).status,401);
    const original=await (await request('persona')).json() as any,s=app.createSession();
    const changed={...original,blocks:[{title:'一',text:'人格热更新测试'}],voiceExamples:'本鱼先去看看喵。'};
    const saved=await request('persona',changed);assert.equal(saved.status,200);
    const current=await saved.json() as any;
    assert.equal((await (await request('persona')).json() as any).voiceExamples,changed.voiceExamples);
    await app.chat(s.id,'你好','chat',new AbortController().signal,()=>{});
    const prompts=await (await request('prompts')).json() as any;
    const messages=prompts.latest.web.request.messages;
    assertPersonaLayout(f.root,messages);
    for(const system of Object.values(prompts.systems) as string[]){
      assert.ok(system.startsWith('人格热更新测试\n'+voiceExamplesPrompt(f.root)));
      assert.equal(system.match(/颜文字范例（需要时参考）/g)?.length,1);
    }
    assert.ok(prompts.systems.web.startsWith(messages[0].content+'\n\n'));
    assert.equal(prompts.latest.web.request.thinking.type,'disabled');assert.ok(!JSON.stringify(prompts).includes(app.token));
    assert.equal((await request('persona',original)).status,400);
    const {voiceExamples:_omitted,...oldClient}=current;
    assert.equal((await (await request('persona',oldClient)).json() as any).voiceExamples,changed.voiceExamples);
    const cleared=await request('persona',{...current,voiceExamples:''});assert.equal(cleared.status,200);
    assert.equal(voiceExamplesPrompt(f.root),'');
    const large={...(await cleared.json() as object),blocks:[{title:'人格',text:'鱼'.repeat(5500)}],
      appearance:'蓝'.repeat(2000),voiceExamples:'喵'.repeat(4000)};
    assert.ok(Buffer.byteLength(JSON.stringify(large))>32768);
    assert.equal((await request('persona',large)).status,200);
  }finally{await app.close();server.close();await once(server,'close');f.cleanup();}
});
