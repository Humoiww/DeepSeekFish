import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture} from './helpers.js';
import {Bot} from '../src/agent/bot.js';
import {TurnContext} from '../src/agent/context.js';
import {BudgetedModel} from '../src/agent/model.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {MockImageProvider} from '../src/image/provider.js';
import {normalizeOneBot,OneBotTransport} from '../src/qq/onebot.js';
import {ForwardRecords} from '../src/qq/forward.js';
import {SearchService,MockSearchProvider} from '../src/search/provider.js';
import type {Model,ToolCall,Transport} from '../src/types.js';

const owner='20002',self='20003',group='private:'+owner;
const voices={self,contact:owner};
const usage={input:100,output:20};
const text=(body:string)=>({type:'text',data:{text:body}});
const quote=(id:string)=>({type:'reply',data:{id}});
const card=(id:string)=>({type:'forward',data:{id}});
const node=(speaker:string,body:string,messageId?:string)=>
  ({user_id:speaker,sender:{user_id:speaker,nickname:'同名'},message_id:messageId,message:[text(body)]});
const call=(name:string,args:unknown):ToolCall=>({id:name,type:'function',function:{name,arguments:JSON.stringify(args)}});
function inbound(id:string,segments:unknown[]){
  const message=normalizeOneBot({post_type:'message',message_type:'private',self_id:self,user_id:owner,message_id:id,
    time:Math.floor(Date.now()/1000),message:segments},self);
  assert.ok(message);
  return message;
}

test('QQ reply reads the referenced forward and keeps outgoing quotes attributable',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:[owner],bufferMs:10000});
  const lookups:string[]=[],sent:string[]=[];
  const forwards=new ForwardRecords(f.store,{async readForward(id){
    lookups.push(id);
    return id==='original'?[node(owner,'我选了蓝色。'),node(self,'我选了白色。')]:[node(owner,'这是另一张卡。')];
  }},channel=>channel===group);
  forwards.observe(inbound('40',[card('original')]));
  forwards.observe(inbound('41',[card('newer')]));
  let rounds=0;
  const provider:Model={kind:'fixture',async complete(messages){
    const context=JSON.parse(String(messages[1].content));
    if(++rounds===1){
      assert.equal(context.quotedMessages[0].messageId,'40');
      assert.equal(context.quotedMessages[0].forwards[0].messageId,'40');
      assert.match(String(messages.find(m=>m.role==='user')?.content),/引用 QQ 消息 ID 40/);
      return {text:'',tool_calls:[call('read_forward',{})],usage};
    }
    if(rounds===2){
      const result=JSON.parse(String(messages.find(m=>m.role==='tool')?.content));
      assert.deepEqual(result.records.map((entry:any)=>[entry.speakerLabel,entry.text]),
        [['私聊对方（同名）','我选了蓝色。'],['肥鱼','我选了白色。']]);
      return {text:'',tool_calls:[call('reply',{text:'私聊对方：我选了蓝色。\n肥鱼：我选了白色。'})],usage};
    }
    assert.equal(rounds,3);
    assert.equal(context.quotedMessages[0].messageId,'80');
    assert.equal(context.quotedMessages[0].speakerLabel,'肥鱼');
    assert.equal(context.quotedMessages[0].text,sent[0]);
    return {text:'',tool_calls:[call('reply',{text:''})],usage};
  }};
  const transport:Transport={status:'mock',identity:async()=>({userId:self}),async send(_m,body){sent.push(body);return {messageId:'80'};},async file(){},stop(){}};
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner());
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,
    new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,undefined,undefined,undefined,forwards);
  try{
    await bot.receive(inbound('42',[quote('40'),text('这张里哪句话是谁说的？')]));
    await bot.flush();
    assert.deepEqual(lookups,['original']);
    assert.equal(f.store.history(group,20).find(m=>m.id==='42')?.quotedMessageId,'40');
    assert.equal(bot.memory.read(group,{messageId:'42'}).events[0].quotedMessageId,'40');
    await bot.receive(inbound('43',[quote('80'),text('那这句话是谁发的？')]));
    await bot.flush();
    assert.equal(rounds,3);
    assert.deepEqual(sent,['私聊对方：我选了蓝色。\n肥鱼：我选了白色。']);
  }finally{await bot.stop();f.cleanup();}
});

test('each inline QQ card remains separately addressable; native card occurrences survive re-forwarding',async()=>{
  const f=fixture();
  const local=new ForwardRecords(f.store,{readForward:async()=>[node(owner,'同一张平台卡。')]},()=>true);
  try{
    local.observe(inbound('50',[{type:'forward',data:{content:[node(owner,'第一张。')]}},
      {type:'forward',data:{content:[node(self,'第二张。')]}}]));
    const {context:directory}=await local.read(group,{},undefined,{...voices,quotedMessageIds:['50']});
    const ids=directory.records.map(entry=>entry.id);
    assert.equal(new Set(ids).size,2);
    for(const [index,expected] of [['私聊对方（同名）','第一张。'],['肥鱼','第二张。']].entries()){
      const {context}=await local.read(group,{id:ids[index]},undefined,voices);
      assert.deepEqual(context.records.map(entry=>[entry.speakerLabel,entry.text]),[expected]);
    }
    local.observe(inbound('51',[card('platform')]));
    local.observe(inbound('52',[card('platform')]));
    assert.equal(local.byMessage(group,'51')[0].id,local.byMessage(group,'52')[0].id);
    const {context:missing}=await local.read(group,{messageId:'499'});
    assert.deepEqual(missing.records,[]);
    assert.equal('status' in missing&&missing.status,'quoted_forward_unavailable');
    await assert.rejects(local.read('private:20004',{id:ids[0]}),/QQ_FORWARD_NOT_IN_CONVERSATION/);
  }finally{f.cleanup();}
});

test('legacy forward references still resolve by native quote after migration and restart',async()=>{
  const f=fixture();
  try{
    f.store.db.exec('CREATE TABLE qq_forwards(id TEXT PRIMARY KEY,conversation TEXT,root TEXT,route TEXT,message_id TEXT,sender TEXT,observed INTEGER,title TEXT)');
    const oldId='forward-'+createHash('sha256').update(JSON.stringify([group,'old-platform',[]])).digest('hex').slice(0,24);
    f.store.db.prepare('INSERT INTO qq_forwards VALUES (?,?,?,?,?,?,?,?)').run(oldId,group,'old-platform','[]','35',owner,Date.now(),'旧卡');
    const provider={readForward:async(id:string)=>{assert.equal(id,'old-platform');return [node(self,'旧卡里的原话。')];}};
    const forwards=new ForwardRecords(f.store,provider,()=>true);
    forwards.observe(inbound('36',[card('old-platform')]));
    const reopened=new ForwardRecords(f.store,provider,()=>true);
    assert.equal(reopened.byMessage(group,'35')[0].id,oldId);
    assert.equal(reopened.byMessage(group,'36')[0].id,oldId);
    const result=await reopened.read(group,{messageId:'35'},undefined,voices);
    assert.equal(result.context.records[0].speakerLabel,'肥鱼');
  }finally{f.cleanup();}
});

test('long forward and recall previews keep every author and exact quoted author links',async()=>{
  const f=fixture();
  const first='主人说的长段。'.repeat(180),second='肥鱼回应。';
  const source=new ForwardRecords(f.store,{readForward:async()=>[
    node(owner,first,'90'),{...node(self,second,'91'),message:[quote('90'),text(second)]},
    {...node(owner,'这里的作者字段冲突。'),user_id:self}
  ]},()=>true);
  try{
    source.observe(inbound('70',[card('long-card')]));
    const {context}=await source.read(group,{messageId:'70'},undefined,voices);
    assert.equal(context.records[1].quotedMessageId,'90');
    assert.equal(context.records[1].quotedSpeakerLabel,'私聊对方（同名）');
    assert.equal(context.records[2].speakerLabel,'同名（账号未确认）');
    const turn=new TurnContext();
    const result=turn.result('read_forward','forward',context,0);
    const recall=turn.result('recall_chat','history',{events:[
      {actor:owner,role:'user',speakerLabel:'私聊对方',text:first},
      {actor:'DeepSeekFish',role:'assistant',speakerLabel:'肥鱼',text:second},
    ]},0);
    turn.compact(2);
    const short=JSON.parse(String(result.content));
    assert.deepEqual(short.records.map((row:any)=>row.speakerLabel),['私聊对方（同名）','肥鱼','同名（账号未确认）']);
    assert.equal(short.records[0].textTruncated,true);
    assert.deepEqual(JSON.parse(String(recall.content)).events.map((row:any)=>row.speakerLabel),['私聊对方','肥鱼']);
    const full=turn.read({resultId:'forward',section:'records'});
    assert.equal(full.items?.[0].text,first);
    assert.equal(full.nextOffset,2);
    assert.equal(turn.read({resultId:'forward',offset:2}).items?.[0].speakerLabel,'同名（账号未确认）');
  }finally{f.cleanup();}
});

class QuoteWire extends EventTarget {
  readyState=0;
  constructor(private reply:(action:string,params:any)=>unknown){
    super();
    queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});
  }
  send(raw:string){
    const {action,params,echo}=JSON.parse(raw);
    const data=action==='get_login_info'?{user_id:self}:this.reply(action,params);
    queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({status:'ok',retcode:0,data,echo})})));
  }
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  receive(event:unknown){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(event)}));}
}
test('OneBot sends the original author and the context of a quoted old outgoing message',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:[owner],bufferMs:10000});
  const now=Math.floor(Date.now()/1000),sent:string[]=[];
  const row=(id:string,actor:string,at:number,body:string,target:string=actor===self?owner:self)=>
    ({self_id:self,user_id:actor,target_id:target,message_type:'private',message_id:id,time:at,message:[text(body)]});
  const anchor=row('78',self,now-30,'第一次喵');
  let bot:Bot;
  const wire=new QuoteWire((action,params)=>{
    if(action==='get_friend_msg_history'){
      assert.equal(params.user_id,owner);
      assert.equal(params.message_seq,'78');
      return {messages:params.reverseOrder?[row('77',owner,now-31,'说个开场白。'),anchor]:
        [anchor,row('79',owner,now-29,'收到。'),row('81',self,now-28,'另一个私聊', '20004')]};
    }
    assert.equal(action,'send_private_msg');
    assert.equal(params.user_id,owner);
    sent.push(params.message[0].data.text);return {message_id:'120'};
  });
  const transport=new OneBotTransport(f.root,'ws://127.0.0.1:3001','fixture',f.store,m=>bot.receive(m),channel=>channel===group,()=>wire as unknown as WebSocket);
  const forwards=new ForwardRecords(f.store,transport,channel=>channel===group);
  let allowModel=false,modelCalls=0;
  const model:Model={kind:'fixture',async complete(messages,_max,options){
    assert.ok(allowModel,'explicit annotation goes directly through OneBot');
    assert.ok(options?.tools?.some(tool=>tool.function.name==='read_qq_quote'));
    if(++modelCalls===1)return {text:'',tool_calls:[call('read_qq_quote',{})],usage};
    const result=JSON.parse(String(messages.find(message=>message.role==='tool')?.content));
    assert.equal(result.target.speakerLabel,'肥鱼');
    assert.equal(result.target.text,'第一次喵');
    assert.deepEqual(result.before.map((row:any)=>row.text),['说个开场白。']);
    assert.deepEqual(result.after.map((row:any)=>row.text),['收到。']);
    return {text:'',tool_calls:[call('reply',{text:''})],usage};
  }};
  bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(model,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),
    new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,undefined,undefined,undefined,forwards);
  try{
    await transport.identity();
    wire.receive({...row('100',owner,now,'unused'),post_type:'message',message:[quote('78'),text('例如这句谁说的？')]});
    await bot.flush();
    assert.deepEqual(sent,['私聊对方：说个开场白。\n【引用目标】\n肥鱼：第一次喵\n私聊对方：收到。']);
    allowModel=true;
    wire.receive({...row('101',owner,now,'unused'),post_type:'message',message:[quote('78'),text('我想知道原话相邻的记录。')]});
    await bot.flush();
    assert.equal(modelCalls,2);
  }finally{await bot.stop();f.cleanup();}
});

test('an unindexed QQ forward is recovered by the exact scoped message and labeled on the wire',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:[owner],bufferMs:10000});
  const now=Math.floor(Date.now()/1000),actions:string[]=[],sent:string[]=[],attachments:string[]=[];
  const answer='这句我看到了，我是看完了前面的消息才回你的喵。';
  let bot:Bot;
  const wire=new QuoteWire((action,params)=>{
    actions.push(action);
    if(action==='get_group_list')return [];
    if(action==='get_friend_msg_history')return {messages:[]};
    if(action==='get_msg'){
      assert.equal(params.message_id,'71');
      return {message_id:71,self_id:self,user_id:owner,message_type:'private',time:now-1,message:[card('remote-card')]};
    }
    if(action==='get_forward_msg'){
      assert.equal(params.message_id,'remote-card');
      return {messages:[node(self,'第一次喵'),node(owner,answer)]};
    }
    assert.equal(action,'send_private_msg');
    assert.equal(params.user_id,owner);
    const segment=params.message[0];
    if(segment.type==='file'){
      assert.equal(segment.data.name,'聊天记录-说话人标注.txt');
      attachments.push(Buffer.from(segment.data.file.slice('base64://'.length),'base64').toString());
    }else sent.push(segment.data.text);
    return {message_id:String(120+sent.length+attachments.length)};
  });
  const transport=new OneBotTransport(f.root,'ws://127.0.0.1:3001','fixture',f.store,m=>bot.receive(m),channel=>channel===group,()=>wire as unknown as WebSocket);
  const forwards=new ForwardRecords(f.store,transport,channel=>channel===group);
  const model:Model={kind:'fixture',async complete(){throw new Error('annotation uses the received QQ records directly');}};
  bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(model,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),
    new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,undefined,undefined,undefined,forwards);
  try{
    await transport.identity();
    assert.deepEqual(forwards.byMessage(group,'71'),[]);
    wire.receive({post_type:'message',message_type:'private',self_id:self,user_id:owner,message_id:'121',time:now,
      message:[quote('71'),text('逐条标注')]});
    await bot.flush();
    assert.ok(forwards.byMessage(group,'71').length);
    assert.deepEqual(actions.filter(a=>a!=='get_friend_msg_history'),['get_group_list','get_msg','get_forward_msg','send_private_msg']);
    assert.deepEqual(sent,['肥鱼：第一次喵\n私聊对方（同名）：'+answer]);
    f.set({maxChars:32});
    wire.receive({post_type:'message',message_type:'private',self_id:self,user_id:owner,message_id:'130',time:now,
      message:[quote('71'),text('逐条标注')]});
    await bot.flush();
    assert.deepEqual(attachments,sent);
    assert.equal(actions.filter(a=>a==='get_forward_msg').length,1);
  }finally{await bot.stop();f.cleanup();}
});
