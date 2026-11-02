import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,message} from './helpers.js';
import {normalizeOneBot} from '../src/qq/onebot.js';
import {ForwardRecords,forwardHandle} from '../src/qq/forward.js';
import {QQMedia} from '../src/qq/media.js';
import {MockImageProvider} from '../src/image/provider.js';
import {Bot} from '../src/agent/bot.js';
import {BudgetedModel} from '../src/agent/model.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {MockTransport} from '../src/qq/adapter.js';
import {MockSearchProvider,SearchService} from '../src/search/provider.js';
import type {Model} from '../src/types.js';
const text=(text:string)=>({type:'text',data:{text}});
const record=(name:string,segments:any[])=>({sender:{user_id:20002,nickname:name},time:100,message:segments});
const event=(segments:any[])=>({post_type:'message',message_type:'private',self_id:90009,user_id:20002,message_id:123,time:Math.floor(Date.now()/1000),message:segments});
test('native/card forward-only messages survive normalization; unrelated cards are not forwards',()=>{
  const raw={type:'forward',data:{id:'root',content:[record('原发言者',[text('hello')])]}};
  const m=normalizeOneBot(event([raw]),'90009')!;assert.match(m.text,/转发聊天记录/);assert.equal(m.forwards?.[0].id,'root');assert.equal(m.forwards?.[0].content?.length,1);
  assert.equal(forwardHandle({type:'json',data:{data:JSON.stringify({app:'com.tencent.multimsg',meta:{detail:{resid:'record-key'}}})}})?.id,'record-key');
  assert.equal(forwardHandle({type:'xml',data:{data:'<msg action="viewMultiMsg" m_resid="nested-key" />'}})?.id,'nested-key');
  assert.equal(forwardHandle({type:'json',data:{data:JSON.stringify({app:'link',meta:{detail:{resid:'not-forward'}}})}}),undefined);
});
test('reads quoted speakers, images and nested inline records; scoped refs survive restart without signed URLs',async()=>{
  const f=fixture({privateUsers:['20002','30003']});try{
    const generated=await new MockImageProvider().generate('',f.root+'/runtime/outputs');if(generated.status!=='ok')throw Error('fixture');const png=fs.readFileSync(generated.path);
    const nested=[{type:'node',data:{user_id:30003,nickname:'内层作者',content:[text('内层原话')]}}];
    const root=[record('外层作者',[text('外层原话'),{type:'image',data:{url:'https://gchat.qpic.cn/photo?secret-signature=private',sub_type:1}},{type:'forward',data:{id:'unfetchable-inner',content:nested}}])];
    let reads=0,downloads=0;
    const qq={async readForward(id:string){reads++;assert.equal(id,'root');return root;}};
    const media=new QQMedia(f.root,f.store,undefined,(async()=>{downloads++;return new Response(png);}) as typeof fetch);
    const forwards=new ForwardRecords(f.store,qq,()=>true,media),m=normalizeOneBot(event([{type:'forward',data:{id:'root',content:root}}]),'90009')!;
    const stored=forwards.observe(m),id=String(forwards.recent(m.group)[0].id);assert.ok(stored.includes(id));assert.equal(downloads,0);assert.equal(reads,0);
    const page=await forwards.read(m.group,{id});assert.equal(page.context.records[0].sender.name,'外层作者');assert.equal(page.mediaIds.length,1);assert.ok(page.parts.some(p=>p.type==='image_url'));
    const child=page.context.records[0].children[0].id;
    const inner=await forwards.read(m.group,{id:child});assert.equal(inner.context.records[0].sender.name,'内层作者');assert.equal(inner.context.records[0].text,'内层原话');assert.equal(reads,0);
    const restarted=new ForwardRecords(f.store,qq,()=>true,media);
    assert.equal((await restarted.read(m.group,{id:child})).context.records[0].text,'内层原话');assert.equal(reads,1);
    await assert.rejects(forwards.read('private:30003',{id}),/NOT_IN_CONVERSATION/);
    forwards.observe({...m,id:'new-share',user:'30003',at:m.at+1000});
    assert.equal(forwards.recent(m.group)[0].forwardedBy,'30003');
    assert.equal((await forwards.read(m.group,{id})).context.records[0].sender.name,'外层作者');
    assert.equal(forwards.recent(m.group,0,3,m.at+2000).length,0);
    assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM qq_forwards').all()).includes('secret-signature'));
  }finally{f.cleanup();}
});
test('id-only records fetch on demand; nested node format and paging retain all text',async()=>{
  const f=fixture();try{
    let reads=0;
    const root=[record('A',[{type:'node',data:{nickname:'B',user_id:20002,message:[text('deep')]}}]),record('C',[text('长'.repeat(2500))]),record('D',[text('last')])];
    const forwards=new ForwardRecords(f.store,{async readForward(){reads++;return root;}},()=>true);
    forwards.observe({...message('[转发聊天记录 1]'),forwards:[{id:'root'}]});const id=String(forwards.recent('g')[0].id);
    assert.equal(reads,0);const first=await forwards.read('g',{id,count:1});assert.equal(first.context.nextOffset,1);
    const child=first.context.records[0].children[0].id;assert.equal((await forwards.read('g',{id:child})).context.records[0].text,'deep');
    const long=await forwards.read('g',{id,offset:1,count:1});assert.equal(long.context.records[0].nextTextOffset,2000);
    assert.equal((await forwards.read('g',{id,offset:1,count:1,textOffset:2000})).context.records[0].text.length,500);
    assert.equal((await forwards.read('g',{id,offset:2,count:1})).context.nextOffset,null);
  }finally{f.cleanup();}
});
test('QQ lets the model read forwards as a general tool; ordinary groups do not fetch or call the model',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],bufferMs:10000});let calls=0,fetches=0;
  const forwards=new ForwardRecords(f.store,{async readForward(){fetches++;return [record('原发言者',[text('实际转发内容')])];}},()=>true);
  const transport=new MockTransport(),tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner());
  const provider:Model={kind:'fixture',async complete(messages,_max,options){calls++;assert.ok(options?.tools?.some(t=>t.function.name==='read_forward'));
    if(calls===1){const id=JSON.parse(String(messages[1].content)).forwardedChats[0].id;return {text:'',tool_calls:[{id:'r',type:'function',function:{name:'read_forward',arguments:JSON.stringify({id})}}],usage:{input:100,output:30}};}
    assert.match(String(messages.at(-1)?.content),/实际转发内容/);return {text:'懂了，这是转发里那个人说的。',usage:{input:100,output:30}};
  }};
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,undefined,undefined,undefined,forwards);
  try{
    await bot.receive({...message('[转发聊天记录 1]',{mentioned:false,event:'ordinary'}),forwards:[{id:'silent'}]});await bot.flush();assert.equal(calls,0);assert.equal(fetches,0);
    await bot.receive({...message('[转发聊天记录 1]',{id:'private-message',group:'private:20002',user:'20002'}),forwards:[{id:'read-me'}]});await bot.flush();assert.equal(calls,2);assert.equal(fetches,1);assert.equal(transport.sent.length,1);
    assert.match(f.store.history('private:20002',6)[0].text,/forward-/);
  }finally{await bot.stop();f.cleanup();}
});
