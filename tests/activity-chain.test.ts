import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {ActivityChains,activityChainStatus,activityChainStatusReceipt} from '../src/qq/activity-chain.js';
import {actionState} from '../src/agent/tool-feedback.js';
import {ActivityHistory} from '../src/web/activity.js';
import {ExplorationState} from '../src/exploration/state.js';
import {ExplorationWorker} from '../src/exploration/worker.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {MockTransport} from '../src/qq/adapter.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import {QQMedia} from '../src/qq/media.js';
import {MockSearchProvider,SearchService} from '../src/search/provider.js';
import {TiebaAccountClient} from '../src/tieba/client.js';
import {MockImageProvider} from '../src/image/provider.js';
import {MemoryIndex} from '../src/memory/index.js';
import {Jobs} from '../src/development/jobs.js';
import {publishDevelopmentActivity} from '../src/development/activity.js';
import type {ModelResult} from '../src/types.js';
import {fixture} from './helpers.js';

const owner='12345',account='67890',origin='跟 GPT 小姐聊聊新手引导，聊完你看着办。';
const jobId='11111111-1111-4111-8111-111111111111';
const response=(name:string,args:unknown):ModelResult=>({text:'',usage:{input:1,output:1},tool_calls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});

function harness(){
 const f=fixture();let now=Date.now(),attempts=0,reads=0,ambiguous=false,modelCalls=0;
 const model={async complete(_group:string,_scope:string,messages:any[],options:any){
  modelCalls++;
  assert.equal(options.toolChoice,undefined);
  assert.deepEqual(options.tools.map((tool:{function:{name:string}})=>tool.function.name),['activity_chain_status','ask_development','draft_chain_qzone']);
  if(!messages.some(m=>m.role==='tool'))return response('activity_chain_status',{});
  const {chain:status}=JSON.parse(messages.find(m=>m.role==='tool').content);
  assert.equal(status.state,'drafting');assert.equal(status.discussionId,jobId);
  return response('draft_chain_qzone',{text:'讨论后我想先做一轮小测试。'});
 }} as ConstructorParameters<typeof ActivityChains>[2];
 const publisher={self:account,async upload(){return {richval:'mock-image',picBo:'mock-bo'};},
  async publish(_text:string,_photo:unknown,submit:()=>void){submit();attempts++;if(ambiguous)throw Error('response lost');return {id:'post',url:'https://example.com/post'};},
  async findUnique(){reads++;return {id:'post',url:'https://example.com/post'};},
 };
 const open=(provider=model)=>new ActivityChains(f.root,f.store,provider,id=>id===owner,async()=>publisher,()=>now);
 const chain=open(),{id,marker}=chain.prepare('a'.repeat(64),owner,account,origin);
 assert.equal(chain.prepare('a'.repeat(64),owner,account,origin).id,id);
 const folder=path.join(f.root,'runtime/data/development-activity');fs.mkdirSync(folder);
 const media=path.join(f.root,'assets/character');fs.mkdirSync(media,{recursive:true});fs.writeFileSync(path.join(media,'whalechan-reference.png'),'fixture');
 const stage=(phase:string,brief=marker+'\n只讨论')=>fs.writeFileSync(path.join(folder,jobId+'.json'),JSON.stringify({id:jobId,phase,requests:[{brief}],codex:{turn:'turn',response:'先做一轮小测试。'}}));
 const status=()=>{
  const result=activityChainStatus(f.store,owner,{chainId:id});
  assert.ok('state' in result);
  return result;
 };
 return {f,open,chain,id,stage,status,shift:(ms:number)=>{now+=ms;},lose:()=>{ambiguous=true;},counts:()=>({attempts,reads}),modelCalls:()=>modelCalls};
}

test('a chain can share the matched discussion once without a second authorization model call',async()=>{
 const h=harness();
 try{
  h.shift(6_000);await h.chain.tick();
  assert.equal(h.status().state,'waiting_discussion');
  assert.throws(()=>activityChainStatus(h.f.store,'99999',{chainId:h.id}),/NOT_FOUND/);
  h.stage('done');h.shift(11_000);await h.chain.tick();await h.chain.tick();
  assert.equal(h.status().state,'ready');
  await Promise.all([h.chain.tick(),h.chain.tick()]);
  assert.equal(h.status().state,'published');assert.deepEqual(h.counts(),{attempts:1,reads:0});
  const record=await new ActivityHistory(h.f.root,h.f.store,h.f.store).detail('chain:'+h.id);
  assert.equal(record.qqAccess,2);
  assert.ok(record.events.some(event=>event.result?.postId==='post'));
  assert.equal(h.modelCalls(),2);
  await h.open().tick();assert.equal(h.counts().attempts,1);
 }finally{h.f.cleanup();}
});

test('calling GPT in a chain suspends the current step and brings back its answer without a QQ send',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:[owner]}),jobs=new Jobs(f.root),transport=new MockTransport();
 let now=Date.now(),round=0;
 const question='请判断刚查到的这两条证据能支持什么结论。',answer='其中第二条只是猜测，可以用第一条。';
 try{
  const model:ConstructorParameters<typeof ActivityChains>[2]={async complete(_group,_scope,messages,options){
   assert.deepEqual(options?.tools?.find(t=>t.function.name==='ask_development')?.function.parameters.required,['brief']);
   const data=JSON.parse(String(messages.find(message=>message.role==='user')!.content));
   if(round++===0)return response('recall_chat',{date:'2026-02-31'});
   if(round===2){
    const result=JSON.parse(String(messages.find(message=>message.role==='tool')?.content));
    assert.equal(result.error,'INVALID_TOOL_ARGS');assert.equal(result.field,'date');
    return response('activity_chain_step_result',{status:'completed',result:'已找到两条证据。'});
   }
   assert.equal(data.stepNumber,2);
   if(!data.discussionForStep){
    const call=response('ask_development',{brief:question});
    call.tool_calls!.unshift(...response('send_message',{text:question}).tool_calls!);
    return call;
   }
   assert.equal(data.discussionForStep.reply,answer);
   assert.equal(data.previousSteps[0].text,'已找到两条证据。');
   return response('activity_chain_step_result',{status:'completed',result:'已经收到 GPT 小姐的结论。'});
  }};
  const worker=new ExplorationWorker(new ExplorationState(f.store,f.cfg),model,{root:f.root,cfg:f.cfg,ledger:f.ledger,transport,
   tasks:new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),media:new QQMedia(f.root,f.store),
   library:new QQImageLibrary(f.root,f.store),search:new SearchService(new MockSearchProvider(),f.ledger,f.cfg)});
  const open=()=>new ActivityChains(f.root,f.store,model,id=>id===owner,async()=>{throw Error('unexpected publication');},()=>now,
   (run,context,signal,guard)=>worker.toolsFor(run,context,signal,guard));
  const chain=open(),steps=['先查资料','找 GPT 小姐分析证据'];
  const {id}=chain.prepare('a'.repeat(64),owner,account,'查完再讨论。','tools',steps[0],{steps,needsDiscussion:false});
  now+=6_000;await chain.tick();await chain.tick();
  const status=()=>activityChainStatus(f.store,owner,{chainId:id}) as {state:string;completedSteps:number;discussion?:string};
  assert.equal(status().state,'waiting_discussion');assert.equal(status().completedSteps,1);assert.equal(transport.sent.length,0);
  jobs.queueChainDiscussions(f.store,'another-owner');assert.equal(jobs.pending(),undefined);
  jobs.queueChainDiscussions(f.store,owner);jobs.queueChainDiscussions(f.store,owner);
  assert.equal(jobs.pending('send'),undefined);
  const request=jobs.pending();assert.ok(request?.intent?.action==='send');assert.equal(request.activityChainId,id);
  assert.match(request.intent.brief,/请判断刚查到的这两条证据/);
  const job=jobs.create(owner,request,request.intent.goal,[]);
  jobs.handled(request);
  const lease={id:job.id,grant:job.grant,version:job.version};
  jobs.update(lease,{turn:'consultation-turn',codexText:answer});
  jobs.finish(lease,'done','','已答复。');
  jobs.queueChainDiscussions(f.store,owner);
  assert.equal(jobs.pending(),undefined);
  assert.equal(jobs.db.prepare('SELECT count(*) AS count FROM notices').get()?.count,0);
  publishDevelopmentActivity(f.root,jobs);
  const restarted=open();
  await restarted.tick();await restarted.tick();
  assert.equal(status().state,'completed');assert.equal(status().discussion,answer);assert.equal(status().completedSteps,2);
  const record=await new ActivityHistory(f.root,f.store,f.store).detail('chain:'+id);
  const invalid=record.events.find(event=>event.name==='recall_chat'&&event.state==='failed');
  assert.equal(invalid?.result.field,'date');assert.equal(invalid?.result.reason,'invalid_calendar_date');
  assert.equal(transport.sent.length,0);
 }finally{jobs.db.close();f.cleanup();}
});

test('an uncertain publication is reconciled after restart without resending',async()=>{
 const h=harness();
 try{
  h.lose();h.stage('done');h.shift(6_000);
  await h.chain.tick();await h.chain.tick();await h.chain.tick();
  assert.equal(h.status().state,'unconfirmed');h.shift(61_000);
  await h.open().tick();
  assert.equal(h.status().state,'published');assert.deepEqual(h.counts(),{attempts:1,reads:1});
 }finally{h.f.cleanup();}
});

test('each planned step gets its own round budget, reserves checkpoint calls and can save a sourced note',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:[owner]});
 const rounds=[0,0],checkpoints:number[]=[];
 let now=Date.now(),chainId='';
 try{
  const model:ConstructorParameters<typeof ActivityChains>[2]={async complete(_group,_scope,messages,options){
   const {stepNumber}=JSON.parse(String(messages.find(message=>message.role==='user')!.content));
   const round=++rounds[stepNumber-1];
   let answer:ModelResult;
   if(round===1&&stepNumber===1){
    answer=response('remember_memory',{title:'回顾验收',text:'任务链中的记忆小记。'});
   }else if(options?.toolChoice==='activity_chain_step_result'){
    assert.deepEqual(options.tools?.map(tool=>tool.function.name),['activity_chain_step_result']);
    assert.equal(round,23);checkpoints.push(stepNumber);
    answer=response('activity_chain_step_result',{status:'completed',result:'已有可核对结果。'});
   }else{
    if(stepNumber===1&&round===2){
     const saved=JSON.parse(String(messages.find(m=>m.role==='tool')?.content));
     assert.equal(saved.ok,true);assert.deepEqual(saved.references,['chain:'+chainId]);
    }
    answer=response('activity_chain_status',{});
   }
   answer.tool_calls![0].id+=':'+round;
   return answer;
  }};
  const worker=new ExplorationWorker(new ExplorationState(f.store,f.cfg),model,{root:f.root,cfg:f.cfg,ledger:f.ledger,
   transport:new MockTransport(),tasks:new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),
   media:new QQMedia(f.root,f.store),library:new QQImageLibrary(f.root,f.store),search:new SearchService(new MockSearchProvider(),f.ledger,f.cfg)});
  const open=()=>new ActivityChains(f.root,f.store,model,id=>id===owner,async()=>{throw Error('unexpected publication');},()=>now,
   (run,context,signal,guard)=>worker.toolsFor(run,context,signal,guard));
  const chain=open(),steps=['保存回顾','核对回顾'];
  chainId=chain.prepare('a'.repeat(64),owner,account,'请完成回顾验收。','tools',steps[0],{steps,needsDiscussion:false}).id;
  now+=6_000;await chain.tick();
  const first=activityChainStatusReceipt(f.store,owner,{chainId}).chain!;
  assert.equal(first.state,'queued');assert.equal(first.completedSteps,1);assert.equal(first.stepRounds,0);
  await open().tick();
  const second=activityChainStatusReceipt(f.store,owner,{chainId}).chain!;
  assert.equal(second.state,'completed');assert.equal(second.completedSteps,2);
  assert.deepEqual(second.stepResults?.map(step=>step.rounds),[23,23]);
  assert.deepEqual(rounds,[23,23]);assert.deepEqual(checkpoints,[1,2]);
  const memory=new MemoryIndex(f.store);
  assert.equal(memory.search(owner,{kind:'activity',query:'回顾验收'}).items[0].id,'chain:'+chainId);
  assert.equal(memory.read(owner,{id:'chain:'+chainId}).text,'请完成回顾验收。');
  assert.throws(()=>memory.read('other',{id:'chain:'+chainId}),/MEMORY_REFERENCE_NOT_FOUND/);
 }finally{f.cleanup();}
});

test('background drafting leaves status and cancellation responsive and the fish can decline to publish',async()=>{
 const h=harness();
 try{
  h.stage('done');h.shift(6_000);await h.chain.tick();
  let release!:(reply:ModelResult)=>void;
  const model={complete:async(_group:string,_scope:string,messages:any[])=>messages.some(m=>m.role==='tool')?
   response('draft_chain_qzone',{reason:'暂时没有适合公开的内容。'}):new Promise<ModelResult>(resolve=>{release=resolve;})};
  const pending=h.open(model).tick();
  assert.equal(h.status().state,'drafting');
  const other=h.chain.prepare('b'.repeat(64),owner,account,origin);
  assert.equal((h.chain.cancel(owner,{chainId:other.id}) as {state:string}).state,'cancelled');
  release(response('activity_chain_status',{}));await pending;
  assert.equal(h.status().state,'failed');assert.deepEqual(h.counts(),{attempts:0,reads:0});
  const record=await new ActivityHistory(h.f.root,h.f.store,h.f.store).detail('chain:'+h.id);
  const declined=record.events.find(event=>event.name==='墨鲤决定暂不发布');
  assert.equal(declined?.result.error,'暂时没有适合公开的内容。');
 }finally{h.f.cleanup();}
});

test('a historical authorization failure remains visible and does not submit after restart',async()=>{
 const h=harness(),error='ACTIVITY_CHAIN_PUBLICATION_NOT_AUTHORIZED';
 try{
  h.f.store.db.prepare("UPDATE activity_chains SET state='failed',error=? WHERE id=?").run(error,h.id);
  h.shift(6_000);await h.open().tick();
  assert.equal(h.status().error,error);assert.deepEqual(h.counts(),{attempts:0,reads:0});
  const receipt=activityChainStatusReceipt(h.f.store,owner,{chainId:h.id});
  assert.equal(actionState(receipt),'completed');assert.equal(receipt.ok,true);
  assert.equal(receipt.chain?.state,'failed');assert.equal(receipt.chain?.error,error);
  const history=new ActivityHistory(h.f.root,h.f.store,h.f.store);
  const record=await history.detail('chain:'+h.id);
  assert.equal(record.events.find(event=>event.name==='检查主人发布授权')?.result.error,error);
 }finally{h.f.cleanup();}
});

test('new chain discussions queue separately from ordinary steering messages',()=>{
 const f=fixture(),jobs=new Jobs(f.root);
 try{
  const add=(source:string,brief:string)=>{
   jobs.record({source,messageId:source,text:'讨论',at:1});
   jobs.request(source,1,{action:'send',brief,goal:'讨论',criteria:[]});
  };
  add('fresh-chain','[activity-chain:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa]\n新的讨论');
  add('clarification','补充当前讨论的问题');
  assert.equal(jobs.pending('send')?.source,'clarification');
  assert.equal(jobs.pending('all')?.source,'fresh-chain');
 }finally{jobs.db.close();f.cleanup();}
});

for(const route of ['legacy','direct','discussion'] as const)test({
 legacy:'a follow-up uses the shared search, image and Tieba tools while an exploration remains queued',
 direct:'a direct plan resumes after worker restart with evidence from its previous step',
 discussion:'a plan receives the bound discussion before running its first tool step',
}[route],async()=>{
 const planned=route!=='legacy',needsDiscussion=route!=='direct';
 const f=fixture({qqTransport:'onebot',privateUsers:[owner],search:true});
 try{
  f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT)');
  const asset=path.join(f.root,'assets/character');fs.mkdirSync(asset,{recursive:true});
  const image=await new MockImageProvider().generate('fixture',asset);assert.equal(image.status,'ok');
  fs.renameSync(image.path,path.join(asset,'whalechan-reference.png'));
  const state=new ExplorationState(f.store,f.cfg),{run}=state.manual('活动测试');
  const requests=new Map<string,{action:string;url:string}>();
  const tieba=new TiebaAccountClient(async(action,input:any)=>{
   if(action==='account')return {followed:[{id:'321',name:'测试吧'}],posting:{mode:'live'}};
   assert.equal(action,'publish');
   const {requestId,input:post}=input;assert.match(requestId,/^chain:/);
   const prior=requests.get(requestId);
   if(prior)return {...prior,id:'654',published:true,publicVerified:true,reused:true};
   const record={action:post.action,url:'https://tieba.baidu.com/p/543'};
   requests.set(requestId,record);
   return {...record,id:'654',published:true,publicVerified:true,deliveryStatus:'confirmed'};
  });
  const send=(id:string,name:string,args:unknown)=>{
   const result=response(name,args);result.tool_calls![0].id=id;return result;
  };
  const post={action:'thread',forumId:'321',title:'讨论心得',content:'记录一次讨论的结论。'};
  const replies=[send('s','search_web',{query:'游戏新手引导'}),send('i','view_images',{imageIds:['character']}),
   send('a','get_tieba_account',{}),send('p','publish_tieba',post),send('p-again','publish_tieba',post),
   send('r','publish_tieba',{action:'reply',forumId:'321',target:'https://tieba.baidu.com/p/543?pid=654#654',replyScope:'floor',content:'补一条讨论结果。'}),
   send('done',planned?'activity_chain_step_result':'finish_exploration',
    planned?{status:'completed',result:'确认了帖子和回帖。'}:{note:'确认了帖子和回帖。'})];
  let turn=0,sawImage=false;
  const steps=['搜资料、看图。','把结论写进测试帖。'];
  if(planned)replies.splice(2,0,send('done','activity_chain_step_result',{status:'completed',result:'试过三份旧存档，已查看 character。'}));
  const nextStep=planned?steps[0]:'搜资料、看图，再把结论写进测试帖。',answer=needsDiscussion?'试过三份旧存档。':null;
  const model:ConstructorParameters<typeof ActivityChains>[2]={async complete(_group,_scope,messages,options){
   const offered=options?.tools?.map(tool=>tool.function.name)??[];
   for(const name of ['search_web','view_images','publish_tieba','get_tieba_account','recall_chat',
    planned?'activity_chain_step_result':'finish_exploration'])assert.ok(offered.includes(name));
   if(turn===0){const input=JSON.parse(String(messages.find(message=>message.role==='user')!.content));assert.equal(input.discussion,answer);assert.equal(input.nextStep,nextStep);}
   if(planned&&turn===3){
    const {nextStep,previousSteps,lastActions}=JSON.parse(String(messages.find(message=>message.role==='user')!.content));
    assert.equal(nextStep,steps[1]);
    assert.match(previousSteps[0].text,/三份旧存档/);
    assert.ok(lastActions.some((action:{tool:string})=>action.tool==='view_images'));
   }
   sawImage ||= messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'));
   return replies[turn++];
  }};
  const worker=new ExplorationWorker(state,model,{root:f.root,cfg:f.cfg,ledger:f.ledger,transport:new MockTransport(),
   tasks:new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),media:new QQMedia(f.root,f.store),
   library:new QQImageLibrary(f.root,f.store),search:new SearchService(new MockSearchProvider(),f.ledger,f.cfg),tieba});
  let now=Date.now();
  const open=()=>new ActivityChains(f.root,f.store,model,id=>id===owner,async()=>{throw Error('unexpected Qzone publisher');},()=>now,
   (toolRun,context,signal,guard)=>worker.toolsFor(toolRun,context,signal,guard));
  const chain=open(),{id,marker}=chain.prepare('a'.repeat(64),owner,account,origin,'tools',nextStep,
   planned?{steps,needsDiscussion}:undefined);
  const folder=path.join(f.root,'runtime/data/development-activity');fs.mkdirSync(folder);
  if(needsDiscussion)
   fs.writeFileSync(path.join(folder,jobId+'.json'),JSON.stringify({id:jobId,phase:'done',requests:[{brief:marker+'\n只讨论'},{brief:'补充一下验证结果。'}],codex:{turn:'turn',response:answer}}));
  now+=6_000;await chain.tick();
  if(planned&&needsDiscussion)await chain.tick();
  if(planned){
   const queued=activityChainStatus(f.store,owner,{chainId:id});
   assert.ok('state' in queued);assert.equal(queued.state,'queued');assert.equal(queued.nextStep,steps[1]);
   assert.equal(queued.completedSteps,1);assert.equal(requests.size,0);
  }
  await open().tick();
  const status=activityChainStatus(f.store,owner,{chainId:id});
  assert.ok('state' in status);assert.equal(status.state,'completed');assert.equal(status.followUp,'tools');
  assert.equal(status.discussion,answer??undefined);
  if(planned)assert.equal(status.completedSteps,2);
  assert.equal(state.get(run.id).state,'queued');assert.ok(sawImage);
  assert.deepEqual([...requests.values()].map(result=>result.action),['thread','comment']);
  const record=await new ActivityHistory(f.root,f.store,f.store).detail('chain:'+id);
  assert.equal(record.events.find(event=>event.name==='收到讨论结论')?.result?.text,answer??undefined);
  if(planned)assert.equal(record.events.filter(event=>/^第 \d 步$/.test(event.name)).length,2);
  assert.equal(record.events.filter(event=>event.type==='tool'&&event.name==='publish_tieba').length,3);
  assert.ok(record.events.some(event=>event.result?.publicVerified===true&&event.result.url==='https://tieba.baidu.com/p/543'));
 }finally{f.cleanup();}
});

test('a chain counts its initial discussion and returns the second answer instead of queuing a third',async()=>{
 const f=fixture(),jobs=new Jobs(f.root);
 let now=Date.now(),asked=0;
 const initial='第一次答复。',second='第二次答复。';
 const capabilities={async prepare(){},available:()=>[]} as unknown as ReturnType<NonNullable<ConstructorParameters<typeof ActivityChains>[6]>>;
 const open=()=>new ActivityChains(f.root,f.store,{async complete(_group,_who,messages){
  const priorTool=messages.findLast(message=>message.role==='tool');
  if(priorTool){
   assert.deepEqual(JSON.parse(String(priorTool.content)),{
    limitReached:true,maxDiscussions:2,lastDiscussion:{discussionId:secondId,reply:second},
    next:'根据已有讨论结论继续当前步骤或收尾。',
   });
   return response('activity_chain_step_result',{status:'completed',result:'采用已有结论。'});
  }
  const prompt=JSON.parse(String(messages.find(message=>message.role==='user')!.content));
  assert.equal(prompt.discussionForStep.reply,asked===0?initial:second);
  return response('ask_development',{brief:'第 '+(++asked)+' 次追问',followUpTo:prompt.discussionForStep.id});
 }},id=>id===owner,async()=>{throw Error('unexpected publication');},()=>now,()=>capabilities);
 let secondId='';
 try{
  const chain=open(),{id,marker}=chain.prepare('d'.repeat(64),owner,account,'请先讨论后处理。','tools','使用已核实的结论。',{
   steps:['使用已核实的结论。'],needsDiscussion:true,
  });
  const folder=path.join(f.root,'runtime/data/development-activity');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder,jobId+'.json'),JSON.stringify({id:jobId,phase:'done',
   requests:[{brief:marker+'\n只讨论'}],codex:{turn:'initial-turn',response:initial}}));
  now+=6000;
  await chain.tick();
  await chain.tick();
  jobs.queueChainDiscussions(f.store,owner);
  const request=jobs.pending();
  assert.ok(request?.intent?.action==='send');
  assert.equal(request.activityChainId,id);
  const job=jobs.create(owner,request,request.intent.goal,[],'agy');
  secondId=job.id;
  jobs.handled(request);
  const lease={id:job.id,grant:job.grant,version:job.version};
  jobs.update(lease,{turn:'agy:'+secondId,codexText:second});
  jobs.finish(lease,'done','','已答复。');
  publishDevelopmentActivity(f.root,jobs);
  const restarted=open();
  await restarted.tick();
  await restarted.tick();
  assert.equal(asked,2);
  jobs.queueChainDiscussions(f.store,owner);
  assert.equal(jobs.pending(),undefined);
  assert.equal(f.store.db.prepare('SELECT discussion_count FROM activity_chains WHERE id=?').get(id)?.discussion_count,2);
  const status=activityChainStatus(f.store,owner,{chainId:id});
  assert.ok('state' in status);
  assert.equal(status.state,'completed');
  const independent=restarted.prepare('e'.repeat(64),owner,account,'另一条任务，请先讨论。');
  assert.equal(f.store.db.prepare('SELECT discussion_count FROM activity_chains WHERE id=?').get(independent.id)?.discussion_count,1);
 }finally{jobs.db.close();f.cleanup();}
});
