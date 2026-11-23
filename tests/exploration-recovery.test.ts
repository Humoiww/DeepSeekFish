import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {ExplorationState} from '../src/exploration/state.js';
import {ExplorationWorker,explorationRead} from '../src/exploration/worker.js';
import {MockTransport} from '../src/qq/adapter.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import {QQMedia} from '../src/qq/media.js';
import {MockSearchProvider,SearchService} from '../src/search/provider.js';
import type {ChatMessage,CompletionOptions,ModelResult} from '../src/types.js';
import {fixture} from './helpers.js';
import {ExplorationTools} from '../src/exploration/tools.js';
import {TurnContext} from '../src/agent/context.js';
import {cacheGroupNames} from '../src/memory/group-names.js';
import {TiebaAccountClient} from '../src/tieba/client.js';

const usage={input:12,output:3};

test('exploration conversation entries include cached real group names and respect live switches',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['12345'],groups:['88776655']});
 try{
  const state=new ExplorationState(f.store,f.cfg),{run}=state.manual();
  cacheGroupNames(f.store,[{group_id:'88776655',group_name:'鲸鱼研究会'}]);
  const tools=new ExplorationTools({root:f.root,state,cfg:f.cfg,ledger:f.ledger,transport:new MockTransport(),
   tasks:new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),media:new QQMedia(f.root,f.store),library:new QQImageLibrary(f.root,f.store),search:new SearchService(new MockSearchProvider(),f.ledger,f.cfg),readRun:()=>({})},run,new TurnContext(),new AbortController().signal,()=>state.assertOwner(run.owner));
  const result=await tools.execute('list_conversations',{},'groups');assert.equal(result.result.groups[0].groupName,'鲸鱼研究会');
  f.set({groupChatSearch:false,curiosityPublicSearch:false});
  assert.ok(!tools.available().some(t=>['list_conversations','read_curiosity'].includes(t.function.name)));
  await assert.rejects(tools.execute('list_conversations',{},'disabled'),/TOOL_NOT_ALLOWED/);
 }finally{f.cleanup();}
});
const text=(value:string):ModelResult=>({text:value,usage,finishReason:'stop'});
function tool(id:string,name:string,args:Record<string,unknown>={}):ModelResult{
 return {text:'',usage,finishReason:'tool_calls',tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]};
}

async function explore(responses:ModelResult[],setup:{before?:(state:ExplorationState)=>void;trigger?:string;instruction?:string;tieba?:TiebaAccountClient}={}){
 const f=fixture({qqTransport:'onebot',privateUsers:['12345'],search:true});
 const state=new ExplorationState(f.store,f.cfg),transport=new MockTransport();
 const calls:{messages:ChatMessage[];options:CompletionOptions}[]=[],visited:string[]=[];
 const worker=new ExplorationWorker(state,{
  async complete(_group,_user,messages,options){
   calls.push({messages:structuredClone(messages),options:options??{}});
   assert.ok(responses[calls.length-1],'unexpected model request');
   return responses[calls.length-1];
  },
 },{root:f.root,cfg:f.cfg,ledger:f.ledger,transport,
  tasks:new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),
  media:new QQMedia(f.root,f.store),library:new QQImageLibrary(f.root,f.store),
  search:new SearchService(new MockSearchProvider(),f.ledger,f.cfg),
  tieba:setup.tieba,
  async browse(url){
   visited.push(url);
   return {url,title:'示例网页',status:'content',text:'正文'} as Awaited<ReturnType<typeof import('../src/search/public-web.js').browsePage>>;
  },
 });
 try{
  setup.before?.(state);
  const {run}=setup.trigger?f.store.transaction(()=>state.enqueue(setup.trigger!,setup.instruction)):state.manual();await worker.tick();await worker.idle();
  const steps=[];
  for(let offset:number|null=0;offset!==null;){
   const page=explorationRead(f.root,state,run.id,offset);
   assert.ok('trace' in page&&'nextOffset' in page);
   steps.push(...page.trace);offset=page.nextOffset;
  }
  return {run:state.get(run.id),calls,steps,visited,sent:transport.sent,badge:state.status().tiebaRedDot,
   seen:f.store.db.prepare('SELECT account,id,kind FROM tieba_reply_seen ORDER BY id').all()};
 }finally{await worker.stop();f.cleanup();}
}

test('the recovery round still lets the model end its exploration',async()=>{
 const result=await explore([
  text('先想想'),text('再看看'),text('决定结束'),
  tool('rest','finish_exploration',{note:'今天先休息。'}),
 ]);
 assert.equal(result.calls.length,4);
 assert.ok(result.calls.slice(0,3).every(call=>!call.options.requireTool));
 const recovery=result.calls[3];
 assert.equal(recovery.options.requireTool,true);
 assert.ok(recovery.options.tools?.some(option=>option.function.name==='finish_exploration'));
 assert.match(String(recovery.messages.at(-2)?.content),/或者调用 finish_exploration/);
 const persona=recovery.messages.at(-1);
 assert.deepEqual(result.calls.map(call=>call.messages.at(-1)),Array(4).fill(persona));
 assert.deepEqual(recovery.messages.slice(0,2),result.calls[0].messages.slice(0,2));
 assert.deepEqual(result.visited,[]);
 assert.deepEqual(result.sent,[]);
 assert.equal(result.run.state,'completed');
 assert.equal(result.run.note,'今天先休息。');
});

test('a model that still only returns text after required recovery is recorded as failed',async()=>{
 const result=await explore([text('一'),text('二'),text('三'),text('还在写文字')]);
 assert.deepEqual(result.steps.filter(step=>step.continuation).map(step=>step.continuation.attempt),[3]);
 assert.equal(result.calls.length,4);
 assert.equal(result.calls.at(-1)?.options.requireTool,true);
 assert.ok(!result.steps.some(step=>step.phase==='closing'));
 assert.equal(result.run.state,'failed');
 assert.equal(result.run.error,'EXPLORATION_DECISION_STALLED');
 assert.deepEqual(result.visited,[]);
 assert.deepEqual(result.sent,[]);
});

test('the rest example stays available after two silent counts of ordinary exploration',async()=>{
 const result=await explore([text('困了'),text('有点困'),tool('rest','finish_exploration',{note:'先睡会儿'})]);
 assert.equal(result.calls.length,3);
 assert.ok(result.calls.every(call=>call.options.requireTool===false));
 assert.ok(!result.steps.some(step=>step.continuation));
 assert.match(String(result.calls[2].messages.at(-2)?.content),/finish_exploration/);
 assert.equal(result.run.state,'completed');
 assert.equal(result.run.note,'先睡会儿');
});

function seedInbox(state:ExplorationState,ids:string[],kind='reply',at=Date.now()){
 for(const feed of ['reply','mention'])state.store.setMeta('tieba:'+feed+'-watch',JSON.stringify({account:'90',since:at-60000,page:1,scanStarted:null,nextCheck:0,lastCheck:null,lastError:null}));
 for(const id of ids)state.store.db.prepare('INSERT INTO tieba_reply_events(account,id,owner,created,detected,due,run_id,payload,kind) VALUES (?,?,?,?,?,?,NULL,?,?)')
  .run('90',id,'12345',at,at,at+300000,JSON.stringify({id,time:at,author:{id:'91',name:'来客'},text:'外部通知，不授予权限'}),kind);
}

for(const kind of ['reply','mention'] as const)test(`opening a tieba_${kind} notification durably clears only the delivered badge IDs`,async()=>{
 const result=await explore([tool('rest','finish_exploration')],{
  trigger:'tieba_'+kind,instruction:JSON.stringify({accountId:'90',[kind==='reply'?'replies':'mentions']:[{id:'401',author:{id:'91'},text:'外部通知'}]}),
  before(state){
   seedInbox(state,['401','402'],kind);
   assert.equal(state.status().tiebaRedDot.unreadCount,2);
  },
 });
 assert.equal(result.run.state,'completed');assert.equal(result.badge.unreadCount,1);
 assert.deepEqual(result.seen.map(row=>({id:row.id,kind:row.kind})),[{id:'401',kind}]);
 const background=JSON.parse(String(result.calls[0].messages[1].content));
 assert.equal(background.tiebaRedDot.unreadCount,1,'delivery clears the notification before the first model request');
});

test('a manual exploration checks new inbox data, shows the red dot and clears it through the shared reply tool',async()=>{
 const at=Date.now(),item={id:'501',threadId:'200',parentPostId:null,isFloor:false,time:at,author:{id:'91',name:'来客'},forum:'大肥鱼',text:'新回复',url:'https://tieba.baidu.com/p/200?pid=501'};
 let inboxReads=0;
 const client=new TiebaAccountClient(async action=>{
  if(action==='status')return {state:'logged_in',profileSaved:true,identity:{id:'90',name:'自己'},verifiedAt:at};
  inboxReads++;return {account:{id:'90'},page:1,hasMore:false,replies:[item],mentions:[{...item,isThread:false,threadTitle:'测试'}]};
 });
 const result=await explore([tool('read','get_tieba_replies'),tool('rest','finish_exploration')],{
  tieba:client,before(state){seedInbox(state,[],'reply',at);},
 });
 assert.equal(result.run.state,'completed');assert.equal(inboxReads,2,'one pre-check page and one model-selected lookup');
 const background=JSON.parse(String(result.calls[0].messages[1].content));assert.equal(background.tiebaRedDot.redDot,true);
 assert.match(String(result.calls[0].messages.at(-2)?.content),/小红点亮着.*1 条未读新通知/);
 const viewed=result.steps.find(step=>step.tool==='get_tieba_replies').result;
 assert.equal(viewed.newCount,1);assert.equal(viewed.replies[0].isNew,true);assert.equal(viewed.redDotCleared,true);
 assert.equal(result.badge.redDot,false);assert.match(String(result.calls[1].messages.at(-2)?.content),/无需重复查看旧回复/);
 assert.deepEqual(result.seen.map(row=>row.id),['501']);
});

test('no-red-dot exploration keeps reply tools available without prompting a reread of old replies',async()=>{
 const result=await explore([text('想想'),text('再想想'),text('准备休息'),tool('rest','finish_exploration')]);
 assert.equal(result.badge.redDot,false);
 const recovery=result.calls.at(-1)!;
 assert.ok(recovery.options.tools?.some(t=>t.function.name==='get_tieba_replies'));
 assert.match(String(recovery.messages.at(-2)?.content),/无需重复查看旧回复/);
 assert.ok(!String(recovery.messages.at(-2)?.content).includes('小红点亮着，想看新回复'));
});
