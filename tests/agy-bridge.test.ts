import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {createAgyBridge} from '../src/development/agy-bridge-server.js';
import {AgyClient,decodeAgyChanges} from '../src/development/agy-client.js';
import type {AgyTurnRequest} from '../src/development/agy-bridge-types.js';
import {files,revision} from '../src/development/workspace.js';

const tempRoot=os.tmpdir();
const session='11111111-1111-4111-8111-111111111111';
const expiredThread='22222222-2222-4222-8222-222222222222';
const agyScript=`
 const [events,scenario,...args]=process.argv.slice(2);
 const review=args.some(arg=>arg.endsWith('review.schema.json'));
 fs.appendFileSync(events,JSON.stringify({stage:review?'review':'triage',args})+'\\n');
 if(scenario==='auth-failure'){
  console.error('Error: authentication required. Run agy to log in, then retry.');
  console.error('error: authentication failed or timed out');
  process.exit(1);
 }
 const resumed=args.includes('--conversation')?args[args.indexOf('--conversation')+1]:undefined;
 const task=/DeepSeekFish bridge task ([a-f0-9-]{36})/.exec(args[1])[1];
 const conversation=resumed??(review&&scenario==='review-session-lost'?'replacement-review':task);
 if(resumed==='expired-conversation'||review&&scenario==='review-session-lost'&&resumed===task){
  console.log(JSON.stringify({status:'ERROR',error:{code:'CONVERSATION_NOT_FOUND',message:'conversation file not found'}}));
  process.exit(1);
 }
 if(scenario==='hold-triage')await new Promise(resolve=>setTimeout(resolve,250));
 if(review){
  const codexTurns=fs.readFileSync(events,'utf8').trim().split('\\n').filter(line=>JSON.parse(line).stage==='codex').length;
  const response=scenario==='review-retries'&&codexTurns<=2
   ? {verdict:'retry_codex',retryFeedback:'修正问题 '+codexTurns,replyToFeiyu:'已退回 Codex 修正。'}
   : {verdict:'approve',replyToFeiyu:'候选接口已验收。'};
  console.log(JSON.stringify({conversation_id:conversation,response}));
 }else if(scenario==='clarify'&&!resumed){
  console.log(JSON.stringify({session_id:conversation,response:JSON.stringify({
   decision:'need_clarification',replyToFeiyu:'要传什么参数？',
  })}));
 }else if(['reply','clarify','hold-triage'].includes(scenario)){
  console.log(JSON.stringify({status:'SUCCESS',conversation_id:conversation,response:'provider display text',
   structured_output:{decision:'reply_only',replyToFeiyu:'按原工具调用即可。'}}));
 }else{
  console.log(JSON.stringify({conversation_id:conversation,response:{
   decision:'delegate_codex',replyToFeiyu:'已收到。',codexSpec:{
    goal:'更新小工具'.repeat(250),scopeFiles:['src/index.ts'],requirements:['返回可读的结果'],invariants:[],
    verificationCommands:['npm run build','npm test'],
   },
  }}));
 }
`;
const fixtureImport="import fs from 'node:fs';\n";
const indexText='export const answer = 0;\n\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\n';

async function fixture(scenario:string,seed?:(stateDir:string,nativeAgy:string,nativeCodex:string)=>void,codexTimeout=8000,maxRetries=0){
 const base=fs.mkdtempSync(path.join(tempRoot,'neon-'));
 const source=path.join(base,'checkout'),installed=path.join(base,'app'),stateDir=path.join(base,'state'),socket=path.join(base,'bridge.sock');
 const codexSocket=path.join(base,'codex.sock');
 const events=path.join(base,'events.jsonl');
 fs.writeFileSync(events,'');
 fs.mkdirSync(path.join(source,'src/development'),{recursive:true});
 fs.writeFileSync(path.join(source,'src/development/worker.ts'),'protected');
 fs.writeFileSync(path.join(source,'src/index.ts'),indexText);
 fs.writeFileSync(path.join(source,'src/obsolete.ts'),'remove this');
 fs.writeFileSync(path.join(source,'package.json'),JSON.stringify({scripts:{
  build:scenario==='build-failure'?'node -e "process.exit(7)"':'node scripts/verify-build.mjs',
 }}));
 fs.mkdirSync(path.join(source,'scripts'));
 fs.writeFileSync(path.join(source,'scripts/verify-build.mjs'),
  "import fs from 'node:fs';fs.mkdirSync('dist/tests',{recursive:true});fs.writeFileSync('dist/tests/verify.test.js',"+
  JSON.stringify("import {test} from 'node:test';test('compiled',()=>{if("+String(scenario==='test-failure')+")throw new Error('test failed');});")+
  ");");
 fs.cpSync(source,installed,{recursive:true});
 fs.mkdirSync(path.join(installed,'node_modules'));
 const require=createRequire(import.meta.url);
 fs.symlinkSync(path.dirname(require.resolve('ws/package.json')),path.join(installed,'node_modules/ws'),'dir');
 for(const dir of ['.git','node_modules','runtime','dist']){
  fs.mkdirSync(path.join(source,dir));
  fs.writeFileSync(path.join(source,dir,'preserve'),'original');
 }
 fs.writeFileSync(path.join(source,'.gitignore'),'preexisting hidden file');
 if(scenario==='approve'){
  fs.appendFileSync(path.join(source,'src/index.ts'),"// local author's edit\n");
  fs.writeFileSync(path.join(source,'src/unrelated.ts'),'local untracked file');
 }
 const nativeAgy=path.join(base,'native-brain'),nativeCodex=path.join(base,'native-sessions');
 const agyBin=path.join(base,'agy.mjs');
 fs.writeFileSync(agyBin,fixtureImport+agyScript);
 seed?.(stateDir,nativeAgy,nativeCodex);
 const log=(entry:object)=>fs.appendFileSync(events,JSON.stringify(entry)+'\n');
 const nativeHttp=createServer();
 const {WebSocketServer}=require('ws');
 const nativeWs=new WebSocketServer({server:nativeHttp});
 let finishSteer:(()=>void)|undefined;
 let steeringTurn:string|undefined;
 nativeWs.on('connection',(ws:any)=>{
  ws.on('message',(wire:Buffer)=>{
   const {id,method,params}=JSON.parse(wire.toString());
   const send=(method:string,params:object)=>ws.send(JSON.stringify({method,params}));
   const reply=(result:object={})=>ws.send(JSON.stringify({id,result}));
   if(method==='initialize')return reply();
   if(method==='initialized')return;
   if(method==='account/read')return reply({account:{type:'chatgpt'}});
   if(method==='thread/start'||method==='thread/resume'){
    assert.equal(params.cwd,source);
    assert.equal(params.sandbox,'workspace-write');
    assert.equal(params.approvalPolicy,'on-request');
    assert.equal(params.approvalsReviewer,'auto_review');
    assert.equal(params.model,undefined);
    assert.equal(params.config,undefined);
    if(method==='thread/resume'){
     assert.equal(params.excludeTurns,true);
     log({stage:'native-resume',threadId:params.threadId});
     if(params.threadId===expiredThread)return ws.send(JSON.stringify({id,error:{code:-32602,message:'no rollout found for thread id '+expiredThread}}));
     assert.equal(params.threadId,session);
    }else{
     assert.equal(params.ephemeral,false);
     log({stage:'native-thread',params});
    }
    return reply({thread:{id:session,cwd:source},sandbox:{type:'workspaceWrite'},approvalPolicy:'on-request',approvalsReviewer:'auto_review'});
   }
   if(method==='turn/start'){
    assert.equal(params.threadId,session);
    assert.equal(params.cwd,source);
    const turnId=randomUUID();
    log({stage:'codex',threadId:params.threadId,turnId,stdin:params.input[0].text});
    send('item/autoApprovalReview/completed',{threadId:session,turnId,review:{status:'approved'}});
    send('item/started',{threadId:session,turnId,item:{type:'commandExecution',command:'read fixture'}});
    reply({turn:{id:turnId,status:'inProgress'}});
    if(scenario==='cancel')return;
    if(scenario==='steer'){
     steeringTurn=turnId;
     finishSteer=()=>send('turn/completed',{threadId:session,turn:{id:turnId,status:'completed'}});
     return;
    }
    if(scenario==='delayed'){
     const timer=setTimeout(()=>send('turn/completed',{threadId:session,turn:{id:turnId,status:'completed'}}),150);
     ws.once('close',()=>clearTimeout(timer));
     return;
    }
    if(scenario!=='no-change'){
     const index=path.join(source,'src/index.ts');
     fs.writeFileSync(index,fs.readFileSync(index,'utf8').replace('answer = 0','answer = 42'));
     fs.rmSync(path.join(source,'src/obsolete.ts'),{force:true});
     fs.writeFileSync(path.join(source,'src/new.ts'),'export const created = true;\n');
    }
    if(scenario==='forbidden'){
     fs.writeFileSync(path.join(source,'src/development/worker.ts'),'unsafe');
     const link=path.join(source,'src/linked.ts');
     if(!fs.existsSync(link))fs.symlinkSync('/etc/passwd',link);
    }
    return send('turn/completed',{threadId:session,turn:{id:turnId,status:'completed',
     items:[{type:'agentMessage',phase:'final_answer',text:'已修改。'}]}});
   }
   if(method==='turn/steer'){
    assert.equal(params.threadId,session);
    assert.equal(params.expectedTurnId,steeringTurn);
    log({stage:'steer',threadId:params.threadId,turnId:params.expectedTurnId,stdin:params.input[0].text,source:params.clientUserMessageId});
    return reply({turnId:steeringTurn});
   }
   if(method==='turn/interrupt'){
    assert.equal(params.threadId,session);
    log({stage:'interrupt',threadId:params.threadId,turnId:params.turnId});
    send('turn/completed',{threadId:session,turn:{id:params.turnId,status:'interrupted'}});
    return reply();
   }
   assert.fail('unexpected native RPC '+method);
  });
 });
 nativeHttp.listen(codexSocket);
 await once(nativeHttp,'listening');
 const server=createAgyBridge({appRoot:installed,sourceDir:source,stateDir,agyBin,codexSocket,nativeAgy,nativeCodex,effort:'high',maxRetries,
  stageTimeout:600000,codexTimeout},invocation=>{
  const {kind,command,args,env,cwd}=invocation;
  assert.equal(env.HOME,process.env.HOME);
  if(kind==='agy'){
   const schema=args[args.indexOf('--json-schema')+1];
   assert.equal(path.dirname(schema),path.join(stateDir,'schemas'));
   assert.ok(fs.statSync(schema).isFile());
   const settings=JSON.parse(args[args.indexOf('--settings')+1]);
   assert.equal(settings.agentMode,'plan');
   assert.equal(settings.permissions.deny,undefined);
   assert.deepEqual(settings.permissions,{ask:[],allow:['command(*)','unsandboxed(*)']});
   assert.equal(args[args.indexOf('--print-timeout')+1],'585s');
   assert.equal(cwd,source);
  }
  if(kind==='verify'){
   assert.equal(cwd,source);
   assert.equal(fs.lstatSync(path.join(cwd,'node_modules')).isSymbolicLink(),false);
   assert.equal(env.NODE_OPTIONS,'--max-old-space-size=384');
   fs.appendFileSync(events,JSON.stringify({stage:'verify',command,args})+'\n');
   return invocation;
  }
  return {...invocation,command:process.execPath,args:[command,events,scenario,...args]};
 });
 server.listen(socket);
 await once(server,'listening');
 const client=new AgyClient(socket);
 const request=(input:Partial<AgyTurnRequest>={}):AgyTurnRequest=>({
  taskId:randomUUID(),brief:'请查看当前接口。',ownerMessage:'请核对接口。',mode:'development',
  installedRevision:revision(files(installed)),...input,
 });
 const trace=()=>fs.readFileSync(events,'utf8').trim().split('\n').filter(Boolean)
  .map(line=>JSON.parse(line) as {stage:string;command?:string;args?:string[];stdin?:string;threadId?:string;turnId?:string;source?:string});
 return {client,request,trace,source,installed,stateDir,finishSteer:()=>finishSteer?.(),async cleanup(){
  server.close();
  await once(server,'close');
  nativeWs.close();
  nativeHttp.close();
  await once(nativeHttp,'close');
  fs.rmSync(base,{recursive:true,force:true});
 }};
}

const resumedId=(args:string[])=>args.includes('--conversation')?args[args.indexOf('--conversation')+1]:undefined;

test('Neon keeps native discussion across clarification, replies and old timestamps, with one delivery line',async()=>{
 const f=await fixture('clarify');
 try{
  const signal=new AbortController().signal,first=await f.client.turn(f.request(),signal);
  assert.equal(first.outcome,'need_clarification');
  assert.ok(first.conversationId);
  const mainFile=path.join(f.stateDir,'main-conversation.json');
  fs.writeFileSync(mainFile,JSON.stringify({conversationId:first.conversationId,updatedAt:1}));
  const lastDelivery={text:'调整按钮 · 已上线 deadbeef · 改动 src/web/index.ts',at:Date.now()-1};
  const second=await f.client.turn(f.request({lastDelivery,brief:'/compact should be plain input'}),signal);
  const third=await f.client.turn(f.request({lastDelivery}),signal);
  assert.equal(second.outcome,'reply_only');
  assert.deepEqual(third.changes,[]);
  assert.equal(second.conversationId,first.conversationId);
  assert.equal(third.conversationId,first.conversationId);
  const args=f.trace().map(event=>event.args!);
  assert.deepEqual(args.map(resumedId),[undefined,first.conversationId,first.conversationId]);
  assert.match(args[1][1],/^DeepSeekFish bridge task /);
  assert.ok(!args[1].includes('--disable-slash-commands'));
  assert.ok(!args[1].includes('--mode'));
  assert.match(args[1][1],/上次交付回执 调整按钮/);
  assert.doesNotMatch(args[2][1],/上次交付回执/);
  const chain=await f.client.turn(f.request({mode:'chain_discussion',lastDelivery}),signal);
  assert.equal(chain.conversationId,undefined);
  assert.equal((await f.client.status()).mainConversation?.conversationId,first.conversationId);
  assert.equal(resumedId(f.trace().at(-1)!.args!),undefined);
  assert.doesNotMatch(f.trace().at(-1)!.args![1],/上次交付回执/);
  assert.equal(fs.existsSync(path.join(f.stateDir,'clarifications.json')),false);
 }finally{await f.cleanup();}
});

test('Neon retries a missing provider conversation once and persists the replacement until manual reset',async()=>{
 const f=await fixture('reply',state=>{
  fs.mkdirSync(state,{mode:0o700});
  fs.writeFileSync(path.join(state,'main-conversation.json'),JSON.stringify({conversationId:'expired-conversation',updatedAt:1}));
  fs.writeFileSync(path.join(state,'clarifications.json'),'{}');
 });
 try{
  const signal=new AbortController().signal,request=f.request();
  const replacement=await f.client.turn(request,signal);
  assert.equal(replacement.conversationId,request.taskId);
  assert.deepEqual(f.trace().map(entry=>resumedId(entry.args!)),['expired-conversation',undefined]);
  assert.equal((await f.client.status()).mainConversation?.conversationId,request.taskId);
  assert.equal(fs.existsSync(path.join(f.stateDir,'clarifications.json')),false);
  await f.client.resetConversation();
  assert.equal((await f.client.status()).mainConversation,undefined);
  assert.equal(fs.existsSync(path.join(f.stateDir,'main-conversation.json')),false);
  const next=f.request();
  assert.equal((await f.client.turn(next,signal)).conversationId,next.taskId);
  assert.equal(resumedId(f.trace().at(-1)!.args!),undefined);
 }finally{await f.cleanup();}
});

test('Neon reset during triage does not restore the conversation when that turn finishes',async()=>{
 const f=await fixture('hold-triage');
 try{
  const turn=f.client.turn(f.request(),new AbortController().signal);
  while(!f.trace().length)await delay(10);
  await f.client.resetConversation();
  assert.equal((await turn).outcome,'reply_only');
  assert.equal((await f.client.status()).mainConversation,undefined);
 }finally{await f.cleanup();}
});

test('Neon reports a provider login failure and preserves its real diagnostic after the process exits',async()=>{
 const f=await fixture('auth-failure');
 try{
  const request=f.request();
  await assert.rejects(f.client.turn(request,new AbortController().signal),/DEV_AGY_LOGIN_REQUIRED/);
  const status=await f.client.status();
  assert.equal(status.busy,false);
  assert.ok(status.recentEvents?.some(event=>event.text?.includes('authentication required')));
  const persisted=JSON.parse(fs.readFileSync(path.join(f.stateDir,'last-run.json'),'utf8'));
  assert.equal(persisted.taskId,request.taskId);
  assert.ok(persisted.events.some((event:{text?:string})=>event.text==='DEV_AGY_LOGIN_REQUIRED'));
 }finally{await f.cleanup();}
});

test('Neon reviews task-only changes and preserves unrelated checkout edits and directories',async()=>{
 const f=await fixture('approve');
 try{
  const request=f.request(),result=await f.client.turn(request,new AbortController().signal);
  assert.equal(result.outcome,'approved');
  assert.equal(result.codexSessionId,session);
  assert.equal(result.summary.buildPassed,true);
  assert.equal(result.summary.testPassed,true);
  const changes=decodeAgyChanges(result,request.taskId);
  assert.deepEqual(changes.map(change=>[change.name,change.bytes?.toString()??null]),[
   ['src/index.ts',indexText.replace('answer = 0','answer = 42')],['src/new.ts','export const created = true;\n'],['src/obsolete.ts',null],
  ]);
  const trace=f.trace();
  assert.deepEqual(trace.map(event=>event.stage),['triage','native-thread','codex','verify','verify','review']);
  assert.deepEqual(trace.slice(3,5).map(event=>[event.command,...event.args!]),[
   ['npm','run','build'],['node','--test','--test-isolation=none','--test-concurrency=1','dist/tests/*.test.js'],
  ]);
  assert.match(trace[2].stdin!,/更新小工具/);
  const review=trace[5].args![1];
  assert.match(review,/\+export const answer = 42/);
  assert.doesNotMatch(review,/src\/unrelated.ts|\+\/\/ local author's edit/);
  assert.equal(resumedId(trace[5].args!),request.taskId);
  assert.equal(result.conversationId,request.taskId);
  assert.equal((await f.client.status()).mainConversation?.conversationId,request.taskId);
  assert.match(fs.readFileSync(path.join(f.source,'src/index.ts'),'utf8'),/local author's edit/);
  assert.equal(fs.readFileSync(path.join(f.installed,'src/index.ts'),'utf8'),indexText);
  assert.equal(fs.existsSync(path.join(f.source,'src/obsolete.ts')),false);
  assert.ok(fs.existsSync(path.join(f.source,'src/new.ts')));
  const patch=fs.readFileSync(path.join(f.stateDir,'patches',request.taskId+'.patch'),'utf8');
  assert.match(patch,/diff --git a\/src\/new.ts b\/src\/new.ts/);
  assert.doesNotMatch(patch,/^\+\/\/ local author's edit/m);
  for(const dir of ['.git','node_modules','runtime','dist']){
   assert.equal(fs.readFileSync(path.join(f.source,dir,'preserve'),'utf8'),'original');
  }
  assert.equal(fs.lstatSync(path.join(f.source,'node_modules')).isSymbolicLink(),false);
  assert.equal(fs.existsSync(path.join(f.stateDir,'workspaces')),false);
 }finally{await f.cleanup();}
});

test('Neon can request two revisions on the same Codex thread and approve the final candidate with no configured limit',async()=>{
 const f=await fixture('review-retries');
 try{
  const request=f.request(),result=await f.client.turn(request,new AbortController().signal);
  assert.equal(result.outcome,'approved');
  assert.equal(result.codexRetries,2);
  assert.ok(decodeAgyChanges(result,request.taskId).some(change=>change.name==='src/index.ts'));
  assert.throws(()=>decodeAgyChanges({...result,codexRetries:Number.MAX_SAFE_INTEGER+1},request.taskId),/DEV_AGY_INVALID_RESPONSE/);
  const trace=f.trace();
  const executions=trace.filter(event=>event.stage==='codex');
  assert.equal(trace.filter(event=>event.stage==='native-thread').length,1);
  assert.deepEqual(executions.map(event=>event.threadId),[session,session,session]);
  assert.equal(new Set(executions.map(event=>event.turnId)).size,3);
  assert.match(executions[1].stdin!,/修正问题 1/);
  assert.match(executions[2].stdin!,/修正问题 2/);
  const reviews=trace.filter(event=>event.stage==='review').map(event=>{
   assert.equal(resumedId(event.args!),request.taskId);
   const prompt=event.args![1];
   return JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n')+2)).codexRetries;
  });
  assert.deepEqual(reviews,[0,1,2]);
  assert.equal(trace.filter(event=>event.stage==='verify').length,6);
 }finally{await f.cleanup();}
});

test('Neon Review replaces a lost native conversation and the next triage resumes it',async()=>{
 const f=await fixture('review-session-lost');
 try{
  const signal=new AbortController().signal,request=f.request();
  const result=await f.client.turn(request,signal);
  assert.equal(result.outcome,'approved');
  assert.equal(result.conversationId,'replacement-review');
  const reviews=f.trace().filter(event=>event.stage==='review');
  assert.deepEqual(reviews.map(event=>resumedId(event.args!)),[request.taskId,undefined]);
  const firstTrace=f.trace().length;
  await f.client.turn(f.request(),signal);
  assert.equal(resumedId(f.trace()[firstTrace].args!),'replacement-review');
 }finally{await f.cleanup();}
});

test('Codex resumes one persisted native thread across tasks and resets together with Neon',async()=>{
 const f=await fixture('no-change',state=>{
  fs.mkdirSync(state,{mode:0o700});
  fs.writeFileSync(path.join(state,'main-codex-thread.json'),JSON.stringify({threadId:expiredThread,updatedAt:1}));
 });
 try{
  const signal=new AbortController().signal,first=f.request();
  assert.equal((await f.client.turn(first,signal)).codexSessionId,session);
  const state=path.join(f.stateDir,'main-codex-thread.json');
  assert.equal(JSON.parse(fs.readFileSync(state,'utf8')).threadId,session);
  const second=await f.client.turn(f.request(),signal);
  assert.equal(second.codexSessionId,session);
  assert.equal(second.conversationId,first.taskId);
  const threadEvents=()=>f.trace().filter(event=>['native-thread','native-resume'].includes(event.stage));
  assert.deepEqual(threadEvents().map(event=>[event.stage,event.threadId]),[
   ['native-resume',expiredThread],['native-thread',undefined],['native-resume',session],
  ]);
  await f.client.resetConversation();
  assert.equal(fs.existsSync(state),false);
  assert.equal((await f.client.status()).mainConversation,undefined);
  const third=f.request();
  assert.equal((await f.client.turn(third,signal)).conversationId,third.taskId);
  assert.equal(threadEvents().at(-1)?.stage,'native-thread');
 }finally{await f.cleanup();}
});

test('socket steer sends a follow-up to the current native turn once and includes it in Neon Review',async()=>{
 const f=await fixture('steer'),controller=new AbortController();
 const request=f.request({supplements:[{brief:'原有排队补充',ownerMessage:'先合并这句',at:1000}]});
 const input={taskId:request.taskId,source:'d'.repeat(64),brief:'只补这个角落',ownerMessage:'增加新的验收条件',at:2000};
 const run=f.client.turn(request,controller.signal);
 void run.catch(()=>{});
 try{
  assert.deepEqual(await f.client.steer({...input,taskId:randomUUID()},controller.signal),{ok:true,accepted:false});
  let receipt=await f.client.steer(input,controller.signal);
  const deadline=Date.now()+5000;
  while(!receipt.accepted&&Date.now()<deadline){
   await delay(20);
   receipt=await f.client.steer(input,controller.signal);
  }
  assert.equal(receipt.accepted,true);
  assert.equal(receipt.turnId,f.trace().find(event=>event.stage==='codex')?.turnId);
  assert.deepEqual(await f.client.steer(input,controller.signal),receipt);
  const steers=f.trace().filter(event=>event.stage==='steer');
  assert.equal(steers.length,1);
  assert.equal(steers[0].source,input.source);
  assert.match(steers[0].stdin!,/增加新的验收条件/);
  f.finishSteer();
  const result=await run;
  assert.equal(result.outcome,'approved');
  assert.deepEqual(result.steered,[{source:input.source,turnId:receipt.turnId}]);
  const trace=f.trace();
  assert.match(trace.find(event=>event.stage==='triage')!.args![1],/先合并这句/);
  assert.match(trace.find(event=>event.stage==='codex')!.stdin!,/先合并这句/);
  assert.match(trace.find(event=>event.stage==='review')!.args![1],/增加新的验收条件/);
  assert.deepEqual(await f.client.steer(input,controller.signal),{ok:true,accepted:false});
 }finally{controller.abort();await run.catch(()=>{});await f.cleanup();}
});

test('an explicit positive revision limit escalates without reporting a retry that never ran',async()=>{
 const f=await fixture('review-retries',undefined,8000,1);
 try{
  const request=f.request(),result=await f.client.turn(request,new AbortController().signal);
  assert.equal(result.outcome,'escalated');
  assert.equal(result.codexRetries,1);
  assert.equal(result.summary.verdict,'escalate_to_owner');
  assert.deepEqual(decodeAgyChanges(result,request.taskId),[]);
  assert.match(result.replyToFeiyu,/返工上限（1 次）/);
  assert.doesNotMatch(result.replyToFeiyu,/已退回 Codex/);
  assert.equal(f.trace().filter(event=>event.stage==='codex').length,2);
 }finally{await f.cleanup();}
});

for(const scenario of ['build-failure','test-failure','forbidden'])test('independent verification vetoes Neon approval for '+scenario,async()=>{
 const f=await fixture(scenario);
 try{
  const result=await f.client.turn(f.request(),new AbortController().signal);
  assert.equal(result.outcome,'escalated');
  assert.equal(result.codexRetries,0);
  assert.deepEqual(result.changes,[]);
  assert.equal(result.summary.verdict,'escalate_to_owner');
  const executions=f.trace().filter(event=>event.stage==='codex');
  assert.equal(executions.length,1);
  assert.equal(f.trace().filter(event=>event.stage==='native-thread').length,1);
  assert.match(result.replyToFeiyu,scenario==='forbidden'?/src\/development\/worker.ts/:scenario==='build-failure'?/独立构建失败/:/独立测试失败/);
  assert.equal(f.trace().filter(event=>event.stage==='review').length,1);
  assert.equal(f.trace().filter(event=>event.stage==='verify').length,scenario==='forbidden'?0:scenario==='build-failure'?1:2);
  assert.equal(fs.readFileSync(path.join(f.installed,'src/development/worker.ts'),'utf8'),'protected');
 }finally{await f.cleanup();}
});

test('chain discussion cannot delegate even when the provider returns a valid code specification',async()=>{
 const f=await fixture('approve');
 try{
  const result=await f.client.turn(f.request({mode:'chain_discussion'}),new AbortController().signal);
  assert.equal(result.outcome,'escalated');
  assert.deepEqual(result.changes,[]);
  assert.deepEqual(f.trace().map(event=>event.stage),['triage']);
  assert.match(f.trace()[0].args![1],/只读/);
  assert.equal(fs.existsSync(path.join(f.stateDir,'workspaces')),false);
  assert.equal(fs.existsSync(path.join(f.stateDir,'scratch')),false);
 }finally{await f.cleanup();}
});

test('a Codex turn with no file changes still builds, tests and goes through Neon Review',async()=>{
 const f=await fixture('no-change');
 try{
  const result=await f.client.turn(f.request(),new AbortController().signal);
  assert.equal(result.outcome,'approved');
  assert.deepEqual(result.changes,[]);
  assert.deepEqual(result.summary.changedFiles,[]);
  assert.equal(f.trace().filter(event=>event.stage==='review').length,1);
 }finally{await f.cleanup();}
});

test('native Codex turns wait without a local deadline at zero and forward an explicit timeout through the bridge',async()=>{
 const unlimited=await fixture('delayed',undefined,0);
 try{
  const result=await unlimited.client.turn(unlimited.request(),new AbortController().signal);
  assert.equal(result.outcome,'approved');
  assert.equal(unlimited.trace().some(event=>event.stage==='interrupt'),false);
 }finally{await unlimited.cleanup();}

 const limited=await fixture('delayed',undefined,50);
 try{
  await assert.rejects(limited.client.turn(limited.request(),new AbortController().signal),
   {message:'DEV_CODEX_TURN_TIMEOUT'});
  assert.equal(limited.trace().some(event=>event.stage==='interrupt'),true);
 }finally{await limited.cleanup();}
});

test('socket cancellation and AbortSignal interrupt the active native turn and keep the daemon alive',async()=>{
 const f=await fixture('cancel');
 try{
  for(const explicit of [true,false]){
   const signal=new AbortController(),request=f.request(),previous=f.trace().length;
   const call=f.client.turn(request,signal.signal);
   const rejection=assert.rejects(call,explicit?/DEV_AGY_CANCELLED/:/owner cancelled/);
   void rejection.catch(()=>{});
   try{
    const deadline=Date.now()+5000;
    let turn=f.trace().slice(previous).find(event=>event.stage==='codex');
    while(!turn&&Date.now()<deadline){
     await delay(15);
     turn=f.trace().slice(previous).find(event=>event.stage==='codex');
    }
    assert.ok(turn?.turnId);
    const status=await f.client.status();
    assert.equal(status.stage,'codex');
    const threadEvent=explicit?'Codex 原生会话已打开':'Codex 主线程已续接';
    assert.ok(status.recentEvents?.some(event=>event.title===threadEvent));
    await assert.rejects(f.client.turn(f.request(),new AbortController().signal),/DEV_AGY_BUSY/);
    assert.equal((await f.client.cancel(randomUUID())).cancelled,false);
    if(explicit)assert.equal((await f.client.cancel(request.taskId)).cancelled,true);
    else signal.abort(new Error('owner cancelled'));
    await rejection;
    assert.equal((await f.client.status()).busy,false);
    const interrupt=f.trace().slice(previous).find(event=>event.stage==='interrupt');
    assert.deepEqual(interrupt,{stage:'interrupt',threadId:session,turnId:turn.turnId});
    assert.equal(f.trace().slice(previous).some(event=>event.stage==='verify'),false);
    assert.equal(fs.readFileSync(path.join(f.source,'runtime/preserve'),'utf8'),'original');
   }finally{signal.abort();await call.catch(()=>{});}
  }
 }finally{await f.cleanup();}
});

test('the bridge prunes stale task directories and returns bounded, credential-safe native records',async()=>{
 const taskId=randomUUID(),agyId=randomUUID(),old=randomUUID(),fresh=randomUUID(),stamp='2026-11-22T07:00:00Z';
 const nativeAgyId=randomUUID(),nativeCodexId=randomUUID(),personalAgyId=randomUUID(),personalCodexId=randomUUID();
 const f=await fixture('reply',(state,nativeAgy,nativeCodex)=>{
  fs.mkdirSync(state,{mode:0o700});
  for(const folder of ['workspaces','scratch']){
   for(const id of [old,fresh])fs.mkdirSync(path.join(state,folder,id),{recursive:true,mode:0o700});
   const past=new Date(Date.now()-48*3600_000);
   fs.utimesSync(path.join(state,folder,old),past,past);
  }
  const seed=(file:string,rows:object[])=>{
   const location=path.join(state,file);
   fs.mkdirSync(path.dirname(location),{recursive:true,mode:0o700});
   fs.writeFileSync(location,rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
  };
  seed('agy-sessions/brain/'+agyId+'/.system_generated/logs/transcript.jsonl',[
   {type:'USER_INPUT',timestamp:stamp,content:'核对接口，access_token=secret-neon-token '+JSON.stringify({taskId})},
   {type:'PLANNER_RESPONSE',timestamp:stamp,thinking:'private-reasoning',summary:'需要核对工具',
    tool_calls:[{name:'finish',args:{decision:'reply_only',replyToFeiyu:'按原工具调用。',cookie:'secret-neon-cookie'}}]},
  ]);
  seed('codex-sessions/sessions/2026/11/22/rollout-2026-11-22T07-00-00-'+session+'.jsonl',[
   {type:'session_meta',payload:{cwd:'/workspaces/'+taskId,token:'secret-session'}},
   {type:'event_msg',timestamp:stamp,payload:{item:{type:'CommandExecution',command:'npm run build',aggregated_output:'构建完成',exit_code:0}}},
   {type:'event_msg',timestamp:stamp,payload:{item:{type:'FileChange',changes:[{path:'docs/readme.md',kind:'update'}]}}},
   {type:'event_msg',timestamp:stamp,payload:{item:{type:'Reasoning',summary_text:['验证通过'],raw_content:'private-reasoning'}}},
   {type:'event_msg',timestamp:stamp,payload:{type:'task_complete',last_agent_message:'已更新文档'}},
  ]);
  const transcript=(id:string)=>id+'/.system_generated/logs/transcript.jsonl';
  seed('verification/agy-'+nativeAgyId+'.json',[{taskId,steps:[
   {role:'assistant',title:'Neon 结论 · reply_only',text:'检查完成'},
  ]}]);
  const nativeRows=[
   {type:'USER_INPUT',content:'<user_request>\nDeepSeekFish bridge task '+taskId+'\n\n检查内存\n</user_request>'},
   {type:'PLANNER_RESPONSE',tool_calls:[{name:'run_command',args:{command:'free -h'}}]},
  ];
  const rollout=(id:string)=>'2026/11/22/rollout-2026-11-22T09-00-00-'+id+'.jsonl';
  const seedNative=(file:string,rows:object[])=>{
   fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
   fs.writeFileSync(file,rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
  };
  seedNative(path.join(nativeAgy,transcript(nativeAgyId)),nativeRows);
  seedNative(path.join(nativeAgy,transcript(personalAgyId)),[{type:'USER_INPUT',content:'宿主私用会话'}]);
  seed('verification/'+nativeCodexId+'.json',[{taskId,steps:[]}]);
  seedNative(path.join(nativeCodex,rollout(nativeCodexId)),[
   {type:'session_meta',payload:{cwd:'/home/fishops/DeepSeekFish'}},
   {type:'event_msg',payload:{type:'task_complete',last_agent_message:'记录来自真实会话路径'}},
  ]);
  seedNative(path.join(nativeCodex,rollout(personalCodexId)),[
   {type:'session_meta',payload:{cwd:'/home/fishops/DeepSeekFish'}},
  ]);
  fs.mkdirSync(path.join(state,'patches'),{mode:0o700});
  fs.writeFileSync(path.join(state,'patches',taskId+'.patch'),'+更新文档\n+authorization: Bearer secret-patch-auth\n');
  fs.symlinkSync('/etc/passwd',path.join(state,'patches',fresh+'.patch'));
 });
 try{
  for(const folder of ['workspaces','scratch'])assert.deepEqual(fs.readdirSync(path.join(f.stateDir,folder)),[fresh]);
  const records=(await f.client.records()).records;
  assert.deepEqual(new Set(records.map(({id})=>id)),new Set([agyId,session,taskId,nativeAgyId,nativeCodexId]));
  const native=await f.client.record('agy',nativeAgyId);
  assert.equal(native.record.taskId,taskId);
  assert.ok(native.steps.some(step=>step.text==='检查完成'));
  assert.equal((await f.client.record('codex',nativeCodexId)).record.taskId,taskId);
  await assert.rejects(f.client.record('agy',personalAgyId),/DEV_AGY_RECORD_NOT_FOUND/);
  await assert.rejects(f.client.record('codex',personalCodexId),/DEV_AGY_RECORD_NOT_FOUND/);
  const agy=await f.client.record('agy',agyId),codex=await f.client.record('codex',session),patch=await f.client.record('patch',taskId);
  assert.equal(agy.record.taskId,taskId);
  assert.equal(codex.record.taskId,taskId);
  assert.ok(agy.steps.some(step=>step.title==='结构化决策'&&step.text?.includes('按原工具调用')));
  assert.ok(codex.steps.some(step=>step.exitCode===0&&step.text?.includes('npm run build')));
  assert.ok(codex.steps.some(step=>step.title==='文件改动'&&step.text?.includes('docs/readme.md')));
  assert.match(patch.patch!,/更新文档/);
  assert.doesNotMatch(JSON.stringify({agy,codex,patch}),/secret-neon|secret-session|private-reasoning|secret-patch/);
  await assert.rejects(f.client.record('agy','../transcript.jsonl'),/DEV_AGY_INVALID_REQUEST/);
  await assert.rejects(f.client.record('patch',fresh),/DEV_AGY_RECORD_NOT_FOUND/);
 }finally{await f.cleanup();}
});
