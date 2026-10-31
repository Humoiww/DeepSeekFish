import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture,message} from './helpers.js';
import {knowledgeTokens,knowledgeSnapshot,updateKnowledge} from '../src/memory/knowledge.js';
import {promptSystems} from '../src/prompts.js';
import {Bot} from '../src/agent/bot.js';
import {BudgetedModel} from '../src/agent/model.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {MockTransport} from '../src/qq/adapter.js';
import {SearchService,MockSearchProvider} from '../src/search/provider.js';
import {MockImageProvider} from '../src/image/provider.js';
import type {Model} from '../src/types.js';

test('official tokenizer: 5000 tokens accepted, 5001 rejected atomically; stale edits and restarts preserve content',()=>{
  const f=fixture();try{
    assert.ok(knowledgeTokens('香港时间凌晨更新知识库。🐟')<Buffer.byteLength('香港时间凌晨更新知识库。🐟'));
    let n=4990,text='';while(true){text=' x'.repeat(n);const count=knowledgeTokens('1. '+text);if(count===5000)break;n+=5000-count;}
    const saved=updateKnowledge(f.root,{version:0,changes:[{action:'add',text}]});assert.equal(saved.ok,true);assert.equal(saved.tokens,5000);
    const rejected=updateKnowledge(f.root,{version:1,changes:[{action:'replace',id:1,text:text+' x'}]});
    assert.equal(rejected.ok,false);assert.equal('attemptedTokens' in rejected&&rejected.attemptedTokens,5001);assert.equal(knowledgeSnapshot(f.root).content,saved.content);
    const stale=updateKnowledge(f.root,{version:0,changes:[{action:'delete',id:1}]});assert.equal('error' in stale&&stale.error,'KNOWLEDGE_CHANGED');
    const replaced=updateKnowledge(f.root,{version:1,changes:[{action:'delete',id:1},{action:'add',text:'鲸会轮流让半脑休息。'}]});
    assert.equal(replaced.ok,true);assert.equal(knowledgeSnapshot(f.root).content,replaced.content);
    for(const [name,system] of Object.entries(promptSystems(f.root)))assert.ok(system.includes(replaced.content),name);
    assert.throws(()=>updateKnowledge(f.root,{version:2,changes:[{action:'delete',id:999}]}),/LINE_MISSING/);
    assert.equal(knowledgeSnapshot(f.root).version,2);
  }finally{f.cleanup();}
});
test('an overlong first write leaves no partial rows and a later valid write succeeds',()=>{
  const f=fixture();try{
    const r=updateKnowledge(f.root,{version:0,changes:[{action:'add',text:' x'.repeat(6000)}]});assert.equal(r.ok,false);assert.equal(knowledgeSnapshot(f.root).tokens,0);
    assert.equal(updateKnowledge(f.root,{version:0,changes:[{action:'add',text:'自由笔记'}]}).ok,true);
  }finally{f.cleanup();}
});
test('QQ knowledge edits are background tools and refresh the next model request without a chat status message',async()=>{
  const f=fixture({dailyTokens:1000000,groupDailyTokens:1000000,bufferMs:10000});let round=0;
  const provider:Model={kind:'fixture',async complete(messages,_max,options){
    assert.ok(options?.tools?.some(t=>t.function.name==='update_knowledge'));assert.equal(options?.toolChoice,undefined);
    if(++round===1)return {text:'后台维护状态不能发送到QQ',tool_calls:[{id:'k1',type:'function',function:{name:'update_knowledge',arguments:JSON.stringify({version:0,changes:[{action:'add',text:'海豚用名字般的哨声交流。'}]})}}],usage:{input:100,output:50}};
    assert.ok(String(messages[0].content).includes('海豚用名字般的哨声交流。'));
    assert.ok(messages.some(m=>m.role==='tool'&&JSON.parse(String(m.content)).ok===true));
    return {text:'这声音有点意思。',usage:{input:100,output:10}};
  }};
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),transport=new MockTransport();
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
  try{await bot.receive(message('海豚的叫声'));await bot.flush();assert.equal(round,2);assert.equal(transport.sent.length,1);assert.ok(!JSON.stringify(transport.sent).includes('后台维护'));assert.ok(knowledgeSnapshot(f.root).tokens>0);}
  finally{await bot.stop();f.cleanup();}
});
