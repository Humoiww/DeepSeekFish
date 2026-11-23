import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {Bot} from '../src/agent/bot.js';
import {BudgetedModel} from '../src/agent/model.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {developmentSource} from '../src/development/intake.js';
import {Jobs} from '../src/development/jobs.js';
import {MockImageProvider} from '../src/image/provider.js';
import {PersonMemory} from '../src/memory/people.js';
import {QzoneMemory} from '../src/memory/qzone.js';
import {MockTransport} from '../src/qq/adapter.js';
import {OneBotTransport,normalizeOneBot} from '../src/qq/onebot.js';
import {ForwardRecords} from '../src/qq/forward.js';
import {QQImageClient} from '../src/qq/image-client.js';
import {QQMedia} from '../src/qq/media.js';
import {QQAttachments} from '../src/qq/received-attachments.js';
import {ActivityChains,activityChainStatus} from '../src/qq/activity-chain.js';
import {MockSearchProvider,SearchService} from '../src/search/provider.js';
import {TiebaAccountClient} from '../src/tieba/client.js';
import type {Model} from '../src/types.js';
import {fixture} from './helpers.js';

const owner='20002',self='10001',group='123456',policy={groups:[group,'654321'],names:['肥鱼']};
const words={type:'text',data:{text:'问一下 GPT 小姐。'}};
const ping={type:'at',data:{qq:self}};
function event(extra:Record<string,unknown>={}){
 return {post_type:'message',message_type:'group',self_id:self,user_id:owner,group_id:group,
  message_id:'1',time:Math.floor(Date.now()/1000),message:[ping,words],...extra};
}

test('development intake merges ordinary owner requests in time order and records confirmed live follow-ups only once',()=>{
 const f=fixture(),jobs=new Jobs(f.root);
 const at=Date.now();
 const send=(source:string,time:number,brief=source,activityChainId?:string)=>{
  jobs.record({source,messageId:source,text:source,at:time,activityChainId});
  jobs.request(source,at,{action:'send',goal:source,brief,criteria:[source,'共同要求']});
 };
 try{
  send('补充二',at+2);
  send('任务链问题',at+1,'[activity-chain:chain-id]\n任务链问题','chain-id');
  send('原需求',at);
  send('补充一',at+1);
  const job=jobs.tx(()=>jobs.createPending(owner,jobs.pending()!,'agy'));
  assert.deepEqual(jobs.list().map(entry=>entry.id),[job.id]);
  assert.deepEqual(job.requests.map(entry=>entry.source),['原需求','补充一','补充二']);
  assert.equal(job.goal,'原需求');
  assert.deepEqual(job.criteria,['原需求','共同要求','补充一','补充二']);
  assert.equal(jobs.pending('send'),undefined);
  assert.equal(jobs.pending()?.source,'任务链问题');
  send('执行中追问',at+3);
  jobs.acceptSteer(job,'执行中追问','turn-1');
  jobs.acceptSteer(job,'执行中追问','turn-1');
  assert.equal(jobs.pending('send'),undefined);
  assert.equal(jobs.get(job.id)?.followUps?.length,1);
  assert.equal(jobs.get(job.id)?.requests.at(-1)?.source,'执行中追问');
  send('旧积压',at+4);
  send('打断后新需求',at+6);
  jobs.tx(()=>jobs.cancelMessages(at+5));
  assert.equal(jobs.pending('send')?.source,'打断后新需求');
  assert.equal(jobs.pending()?.source,'任务链问题');
 }finally{jobs.db.close();f.cleanup();}
});

test('development sources accept the bound owner in enabled groups with ordinary group wake rules',()=>{
 const get=(values:Record<string,unknown>={})=>developmentSource(normalizeOneBot(event(values),self)!,owner,policy);
 assert.equal(get()?.text,words.data.text);
 assert.ok(get({message:[{type:'text',data:{text:'肥鱼，找 GPT 小姐聊聊。'}}]}));
 assert.notEqual(get()?.source,get({group_id:'654321'})?.source);
 assert.equal(get({group_id:'555555'}),undefined);
 assert.equal(get({user_id:'30003',sender:{nickname:'老大',role:'owner'}}),undefined);
 assert.equal(get({sender:{user_id:'30003'}}),undefined);
 assert.equal(get({message:[words]}),undefined);
 assert.equal(get({message:[ping,{type:'reply',data:{id:'999'}},words]}),undefined);
 assert.equal(get({message:[ping,{type:'forward',data:{id:'forwarded'}},words]}),undefined);
 assert.ok(get({message_type:'private',message:[words]}));
});

test('an owner group turn offers development handoff and acknowledges it in the originating group',async()=>{
 const f=fixture({qqTransport:'onebot',groups:[group],names:policy.names,privateUsers:[owner]});
 const transport=new MockTransport();let turns=0;
 const provider:Model={kind:'fixture',async complete(_messages,_max,options){
  turns++;
  assert.ok(options?.tools?.some(t=>t.function.name==='request_development'));
  assert.ok(!options?.tools?.some(t=>t.function.name==='development_status'));
  return {text:'',usage:{input:5,output:3},tool_calls:[{id:'handoff',type:'function',function:{name:'request_development',
   arguments:JSON.stringify({messageNumber:1,brief:'聊聊这个问题。',reply:'我去问 GPT 小姐。'})}}]};
 }};
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),
  new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
 try{
  fs.mkdirSync(path.join(f.root,'config'),{recursive:true});
  fs.writeFileSync(path.join(f.root,'config/development-owner'),owner);
  const inbound=normalizeOneBot(event(),self)!,source=developmentSource(inbound,owner,f.cfg());assert.ok(source);
  const inbox=path.join(f.root,'runtime/data/development-inbox');fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox,source.source),'recorded');
  await bot.receive(inbound);await bot.flush();
  assert.equal(turns,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inbox,source.source+'.request'),'utf8')).brief,'聊聊这个问题。');
  assert.equal(transport.sent[0]?.group,group);
 }finally{await bot.stop();f.cleanup();}
});

for(const needsDiscussion of [true,false])test(needsDiscussion?
 'the start tool saves the chain before handing over the discussion':'the start tool queues an owner plan without a development inbox',async()=>{
 const f=fixture({qqTransport:'onebot',groups:[group],names:policy.names,privateUsers:[owner]});
 const transport=new MockTransport();
 const nextStep='用结论补充测试帖的 16 楼。';
 const provider:Model={kind:'fixture',async complete(_messages,_max,options){
  const offered=options?.tools??[];
  const plain=offered.find(tool=>tool.function.name==='request_development');
  assert.ok(plain);assert.ok(!Object.hasOwn(plain.function.parameters.properties as object,'followUp'));
  assert.ok(offered.some(tool=>tool.function.name==='activity_chain_start'));
  return {text:'',usage:{input:5,output:3},tool_calls:[{id:'start',type:'function',function:{name:'activity_chain_start',
   arguments:JSON.stringify({messageNumber:1,reply:'我开一条任务链。',...(needsDiscussion?
    {discussion:'问怎么检索记忆。',nextStep}:{steps:[nextStep,'画一张图。']})})}}]};
 }};
 const model=new BudgetedModel(provider,f.ledger,f.cfg);
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,model,new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),
  new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
 bot.activityChains=new ActivityChains(f.root,f.store,model,id=>id===owner,async()=>{throw Error('unexpected publication');});
 let chainId='';
 const send=transport.send.bind(transport);
 transport.send=async(message,text)=>{
  const result=activityChainStatus(f.store,owner,{});
  assert.ok('chains' in result);assert.equal(result.chains.length,1);
  assert.equal(result.chains[0].nextStep,nextStep);assert.equal(result.chains[0].followUp,'tools');
  assert.equal(result.chains[0].state,needsDiscussion?'waiting_discussion':'queued');
  chainId=result.chains[0].chainId;
  await send(message,text);
 };
 try{
  fs.mkdirSync(path.join(f.root,'config'),{recursive:true});fs.writeFileSync(path.join(f.root,'config/development-owner'),owner);
  const inbound=normalizeOneBot(event(),self)!,source=developmentSource(inbound,owner,f.cfg());assert.ok(source);
  const inbox=path.join(f.root,'runtime/data/development-inbox');
  if(needsDiscussion){
   fs.mkdirSync(inbox);
   fs.writeFileSync(path.join(inbox,source.source),'recorded');
  }
  await bot.receive(inbound);await bot.flush();
  assert.ok(chainId);assert.equal(transport.sent.length,1);
  const detail=await new (await import('../src/web/activity.js')).ActivityHistory(f.root,f.store,f.store).detail('chain:'+chainId);
  if(needsDiscussion){
   const plan=JSON.parse(fs.readFileSync(path.join(inbox,source.source+'.request'),'utf8'));
   assert.match(plan.brief,/^\[activity-chain:[a-f0-9-]+\]/);assert.match(plan.brief,/问怎么检索记忆/);
   assert.ok(detail.events.some(step=>step.name==='已将讨论交给 Neon小猫'));
  }else{
   assert.equal(fs.existsSync(inbox),false);
   assert.equal(detail.events.find(step=>step.name==='已排好任务步骤')?.result.text,`1. ${nextStep}\n2. 画一张图。`);
  }
 }finally{await bot.stop();f.cleanup();}
});


test('owner QQ turn offers unique tool names with attachments and all optional tool groups enabled',async t=>{
 const f=fixture({qqTransport:'onebot',privateUsers:[owner],search:true,images:true});
 t.mock.method(TiebaAccountClient.prototype,'moderatorAuthorized',async()=>true);
 const transport=Object.assign(new MockTransport(),{
  identity:async()=>({userId:self}),
  async meme(){throw Error('unexpected meme send');},
 });
 const wire=new OneBotTransport(f.root,'ws://127.0.0.1:1','fixture-token',f.store,async()=>{},()=>true,
  ()=>{throw Error('unexpected OneBot connection');});
 const media=new QQMedia(f.root,f.store);
 const requests:string[][]=[];
 const provider:Model={kind:'fixture',async complete(_messages,_max,options){
  requests.push((options?.tools??[]).map(tool=>tool.function.name));
  return {text:'收到。',usage:{input:5,output:3}};
 }};
 const model=new BudgetedModel(provider,f.ledger,f.cfg);
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,model,new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),
  new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,
  new PersonMemory(f.root,f.store,wire,f.cfg),new QQImageClient(f.root),new QzoneMemory(f.root,f.store,wire,f.cfg),
  media,new ForwardRecords(f.store,wire,()=>true,media),new QQAttachments(f.root,f.store,wire,()=>true));
 bot.activityChains=new ActivityChains(f.root,f.store,model,id=>id===owner,async()=>{throw Error('unexpected publication');});
 try{
  fs.mkdirSync(path.join(f.root,'config'),{recursive:true});
  fs.writeFileSync(path.join(f.root,'config/development-owner'),owner);
  const inbound=normalizeOneBot(event({message_type:'private',message:[words]}),self);
  assert.ok(inbound);
  await bot.receive(inbound);
  await bot.flush();
  assert.equal(requests.length,1);
  const [names]=requests,unique=new Set(names);
  for(const name of ['list_qq_attachments','download_qq_attachment','view_qq_attachment','read_forward',
   'search_web','fetch_page','browse_page','download_image','publish_tieba','apply_tieba_moderator',
   'get_person','get_qzone','generate_image','send_image','collect_meme','list_files','send_file','generate_video',
   'activity_chain_start','activity_chain_status','activity_chain_cancel','request_development','development_status']){
   assert.ok(unique.has(name),'missing enabled tool '+name);
  }
  assert.equal(unique.size,names.length,'duplicate tools: '+names.filter((name,index)=>names.indexOf(name)!==index).join(', '));
  assert.equal(transport.sent[0]?.text,'收到。');
 }finally{
  await bot.stop();
  wire.stop();
  f.cleanup();
 }
});
