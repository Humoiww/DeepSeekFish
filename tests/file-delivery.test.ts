import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {fixture,message} from './helpers.js';
import {Store} from '../src/storage/db.js';
import {FishError,type Model} from '../src/types.js';
import {QQMedia} from '../src/qq/media.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import {QQFileLibrary,catalogPath} from '../src/qq/file-library.js';
import {sendCatalogFile,sendLibraryImage} from '../src/qq/file-delivery.js';
import {QQImageClient} from '../src/qq/image-client.js';
import {startQQImageBroker} from '../src/qq/image-broker.js';
import {CodexQuotaMonitor} from '../src/codex/quota.js';
import {MockTransport} from '../src/qq/adapter.js';
import {OneBotTransport} from '../src/qq/onebot.js';
import {MockImageProvider} from '../src/image/provider.js';
import {Bot} from '../src/agent/bot.js';
import {BudgetedModel} from '../src/agent/model.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {SearchService,MockSearchProvider} from '../src/search/provider.js';
import {ActivityHistory} from '../src/web/activity.js';
import {ExplorationState} from '../src/exploration/state.js';
import {ExplorationTools} from '../src/exploration/tools.js';
import {TurnContext} from '../src/agent/context.js';
import sharp from 'sharp';

const conversation='private:20002',m=()=>message('发给我',{group:conversation,user:'20002'});
async function originals(f:ReturnType<typeof fixture>){
 f.store.db.exec('CREATE TABLE IF NOT EXISTS qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT,PRIMARY KEY(conversation,message_id))');
 const media=new QQMedia(f.root,f.store);await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs');
 const png=fs.readFileSync(f.root+'/runtime/outputs/mock.png'),web=await media.fromWeb(conversation,png,'https://example.com/GPT原图.png');
 const id=randomUUID(),pdf=Buffer.from('%PDF-1.7\nreference document\n%%EOF'),folder=f.root+'/runtime/outputs/'+id;
 fs.mkdirSync(folder);fs.writeFileSync(folder+'/参考资料.pdf',pdf);
 const manifest=[{name:'参考资料.pdf',bytes:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex')}];
 f.store.db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,conversation,'20002','','','succeeded',Date.now(),Date.now(),'done',JSON.stringify(manifest),null,'{}');
 const library=new QQFileLibrary(f.root,f.store,new QQImageLibrary(f.root,f.store));
 return {media,png,pdf,web: web.id,library,resolver:{resolveFile:async(message:any,id:string)=>library.resolve(message.group,message.user,id)}};
}
test('ordinary originals and PDF outputs share a scoped file catalog without meme classification or host paths',async()=>{
 const f=fixture();try{
  const o=await originals(f),list=o.library.list(conversation,'20002');
  assert.ok(list.files.some(i=>i.id===o.web&&i.name==='GPT原图.png'));
  const pdf=list.files.find(i=>i.name==='参考资料.pdf')!;assert.equal(pdf.kind,'artifact');
  assert.ok(!JSON.stringify(list).includes(f.root));assert.ok(!JSON.stringify(list).includes('relative'));
  assert.equal(o.media.browse(conversation,'').total,0,'file sending never requires classifying an image as a meme');
  for(const id of [pdf.id,o.web,'../../data/auth.json','runtime/data/onebot-credentials.json'])assert.throws(()=>o.library.resolve('private:30003','30003',id),/FILE_NOT_AVAILABLE/);
  const transport=new MockTransport(),trigger=m();
  const picture=await sendLibraryImage(f.root,f.store,transport,o.resolver,trigger,o.web,10485760);
  assert.equal(picture.deliveryStatus,'confirmed');assert.deepEqual(transport.pictures[0].bytes,o.png);
  await sendCatalogFile(f.root,f.store,transport,o.resolver,trigger,o.web,'file');
  await sendCatalogFile(f.root,f.store,transport,o.resolver,trigger,pdf.id,'file');
  assert.deepEqual(transport.attachments.map(i=>i.name),['GPT原图.png','参考资料.pdf']);assert.deepEqual(transport.attachments[1].bytes,o.pdf);
  await assert.rejects(sendLibraryImage(f.root,f.store,transport,o.resolver,trigger,pdf.id,10485760),/FILE_IS_NOT_IMAGE/);
  const scoped=o.library.resolve(conversation,'20002',pdf.id),p=catalogPath(f.root,scoped);fs.unlinkSync(p);fs.symlinkSync(f.root+'/runtime/data/fish.sqlite',p);
  assert.throws(()=>o.library.resolve(conversation,'20002',pdf.id),/FILE_NOT_AVAILABLE/);
 }finally{f.cleanup();}
});
test('file send intent survives restart and concurrent retries, uncertain delivery never blindly reuploads',async()=>{
 const f=fixture();try{
  const o=await originals(f),transport=new MockTransport(),trigger=m();let uploads=0;
  transport.attachment=async()=>{uploads++;throw new FishError('ONEBOT_ACTION_TIMEOUT');};
  const outcomes=await Promise.all([sendCatalogFile(f.root,f.store,transport,o.resolver,trigger,o.web,'file'),sendCatalogFile(f.root,f.store,transport,o.resolver,trigger,o.web,'file')]);
  assert.equal(uploads,1);assert.ok(outcomes.every(r=>r.deliveryStatus==='unconfirmed'));
  const reopened=new Store(f.root);try{
   const afterRestart=await sendCatalogFile(f.root,reopened,transport,o.resolver,m(),o.web,'file');assert.equal(afterRestart.reused,true);assert.equal(afterRestart.deliveryStatus,'unconfirmed');assert.equal(uploads,1);
   const diagnostic=JSON.parse((reopened.db.prepare('SELECT diagnostic FROM qq_file_deliveries').get() as any).diagnostic);assert.equal(diagnostic.code,'ONEBOT_ACTION_TIMEOUT');assert.ok(diagnostic.stack);
  }finally{reopened.close();}
 }finally{f.cleanup();}
});
test('animated originals remain intact as images and files, and sending a generated GIF as a file records its delivery',async()=>{
 const f=fixture();try{
  const o=await originals(f),transport=new MockTransport();
  // Synthetic transport fixture only, never a replacement for native generation.
  const bytes=await sharp(Buffer.concat([Buffer.alloc(16*16*3,0),Buffer.alloc(16*16*3,255)]),{raw:{width:16,height:32,channels:3,pageHeight:16}}).gif({delay:[200,300],loop:0}).toBuffer();
  const downloaded=await o.media.fromWeb(conversation,bytes,'https://example.com/动画.gif');
  await sendLibraryImage(f.root,f.store,transport,o.resolver,m(),downloaded.id,10485760);await sendCatalogFile(f.root,f.store,transport,o.resolver,m(),downloaded.id,'file');
  assert.deepEqual(transport.pictures[0].bytes,bytes);assert.deepEqual(transport.attachments[0].bytes,bytes);assert.equal(transport.attachments[0].name,'动画.gif');
  const id=randomUUID(),name='generated-'+id;fs.mkdirSync(f.root+'/runtime/outputs/'+id);fs.writeFileSync(f.root+'/runtime/outputs/'+id+'/image.gif',bytes);
  f.store.db.prepare('INSERT INTO qq_image_requests VALUES (?,?,?,?,?)').run(conversation,'gif','completed',id,'');
  f.store.setMeta('qq-image-result:'+id,JSON.stringify({created:true,conversation,deliveryStatus:'not_attempted'}));
  await sendCatalogFile(f.root,f.store,transport,o.resolver,m(),name,'file');
  assert.equal(JSON.parse(f.store.getMeta('qq-image-result:'+id)!).deliveryMode,'file');
  const later=await sendLibraryImage(f.root,f.store,transport,o.resolver,m(),name,10485760);assert.equal(later.deliveryStatus,'confirmed');assert.equal(later.reused,true);assert.equal(transport.files.length,0);
 }finally{f.cleanup();}
});
test('confirmed retries reuse the receipt, explicit rejection stays failed, later intentional sends are allowed',async()=>{
 const f=fixture();try{
  const o=await originals(f),transport=new MockTransport(),trigger=m();
  await sendCatalogFile(f.root,f.store,transport,o.resolver,trigger,o.web,'file');
  assert.equal((await sendCatalogFile(f.root,f.store,transport,o.resolver,trigger,o.web,'file')).reused,true);assert.equal(transport.attachments.length,1);
  await sendCatalogFile(f.root,f.store,transport,o.resolver,m(),o.web,'file');assert.equal(transport.attachments.length,2);
  const rejected=m();transport.attachment=async()=>{throw new FishError('ONEBOT_ACTION_FAILED');};
  assert.equal((await sendCatalogFile(f.root,f.store,transport,o.resolver,rejected,o.web,'file')).deliveryStatus,'failed');
  transport.attachment=async()=>{throw Error('must not retry rejected call in the same turn');};
  assert.equal((await sendCatalogFile(f.root,f.store,transport,o.resolver,rejected,o.web,'file')).reused,true);
 }finally{f.cleanup();}
});
test('real OneBot WebSocket sends ordinary file segments to private/group targets with original bytes and filenames',async()=>{
 const {WebSocketServer}=createRequire(import.meta.url)('ws'),server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
 const f=fixture(),sent:any[]=[];let mode='ok';
 server.on('connection',(s:any)=>s.on('message',(raw:Buffer)=>{
  const r=JSON.parse(raw.toString());if(r.action==='get_login_info'){s.send(JSON.stringify({echo:r.echo,status:'ok',retcode:0,data:{user_id:10001}}));return;}
  sent.push(r);s.send(JSON.stringify({echo:r.echo,...(mode==='reject'?{status:'failed',retcode:1200,message:'rejected'}:{status:'ok',retcode:0,data:mode==='missing'?{}:{message_id:91}})}));
 }));
 const transport=new OneBotTransport(f.root,`ws://127.0.0.1:${server.address().port}`,'fixture',f.store,async()=>{},g=>['123456',conversation].includes(g));
 try{
  const bytes=Buffer.from('%PDF\noriginal file\n');
  await transport.attachment(m(),bytes,'资料.pdf');await transport.attachment({...m(),group:'123456'},bytes,'资料.pdf');
  assert.deepEqual(sent.map(r=>r.action),['send_private_msg','send_group_msg']);assert.equal(sent[0].params.user_id,'20002');assert.equal(sent[1].params.group_id,'123456');
  for(const r of sent){assert.equal(r.params.timeout,240000);const segment=r.params.message[0];assert.equal(segment.type,'file');assert.equal(segment.data.name,'资料.pdf');assert.deepEqual(Buffer.from(segment.data.file.slice(9),'base64'),bytes);assert.equal(segment.data.sub_type,undefined);}
  await assert.rejects(transport.attachment({...m(),group:'99999'},bytes,'资料.pdf'),/NOT_ALLOWED/);await assert.rejects(transport.attachment(m(),bytes,'../auth.json'),/NAME_INVALID/);
  mode='missing';await assert.rejects(transport.attachment(m(),bytes,'资料.pdf'),/SEND_UNCONFIRMED/);
  mode='reject';await assert.rejects(transport.attachment(m(),bytes,'资料.pdf'),/ACTION_FAILED/);
  assert.equal(sent.length,4);
 }finally{transport.stop();for(const c of server.clients)c.terminate();await new Promise<void>(r=>server.close(()=>r()));f.cleanup();}
});
test('QQ model chooses both image and general file tools through the live broker, even with generation disabled',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['20002'],admins:['20002'],images:false,bufferMs:10000});
 fs.mkdirSync(f.root+'/config');fs.writeFileSync(f.root+'/config/local.json',JSON.stringify(f.cfg()));
 const quota=new CodexQuotaMonitor(f.store,true,{read:async()=>{},close:async()=>{}}),broker=await startQQImageBroker(f.root,f.store,quota,true),client=new QQImageClient(f.root);
 const o=await originals(f),transport=new MockTransport();let round=0,pdf='';
 const provider:Model={kind:'fixture',async complete(messages,_max,options){
  round++;const names=options!.tools!.map(t=>t.function.name);assert.ok(names.includes('send_file')&&names.includes('send_image'));assert.ok(!names.includes('generate_image'));assert.equal(options?.toolChoice,undefined);
  const choose=(name:string,args:any)=>({text:'',tool_calls:[{id:'call-'+round,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}],usage:{input:100,output:20}});
  if(round===1)return choose('list_files',{});
  if(round===2){const result=JSON.parse(String(messages.at(-1)?.content));pdf=result.files.find((i:any)=>i.name==='参考资料.pdf').id;assert.ok(!JSON.stringify(result).includes(f.root));return choose('send_image',{imageId:o.web});}
  if(round===3){assert.equal(transport.pictures.length,1);assert.equal(JSON.parse(String(messages.at(-1)?.content)).delivered,true);return choose('send_file',{fileId:pdf});}
  assert.deepEqual(transport.attachments[0].bytes,o.pdf);return choose('reply',{text:'喏，原图和资料都在这儿。'});
 }};
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,client,undefined,o.media);
 try{
  await bot.receive(m());await bot.flush();assert.equal(round,4);assert.equal(transport.sent[0].text,'喏，原图和资料都在这儿。');
  const logs=fs.readdirSync(f.root+'/runtime/logs/qq').map(n=>JSON.parse(fs.readFileSync(f.root+'/runtime/logs/qq/'+n,'utf8')));const log=logs[0];assert.equal(log.state,'completed');assert.deepEqual(log.trace.filter((e:any)=>e.tool).map((e:any)=>e.tool),['list_files','send_image','send_file','reply']);
  assert.equal(f.ledger.value('image'),0);assert.equal(f.ledger.value('tokens'),480);
  const detail=await new ActivityHistory(f.root,f.store,f.store).detail('qq:'+fs.readdirSync(f.root+'/runtime/logs/qq')[0].slice(0,-5));assert.equal(detail.counts.sends,2);
  const sentHistory=bot.memory.read(conversation,{query:'发送文件'});assert.match(JSON.stringify(sentHistory),/参考资料.pdf/);
  await assert.rejects(client.resolveFile({...m(),group:'private:30003',user:'30003'},pdf),/TARGET_DENIED/);
 }finally{await bot.stop();await broker.close();await quota.close();f.cleanup();}
});
test('autonomous exploration can select an ordinary file attachment without an image-generation permission',async()=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['20002'],admins:['20002'],images:false});try{
  const o=await originals(f),state=new ExplorationState(f.store,f.cfg),transport=new MockTransport();state.manual();const run=state.claim()!;
  const tools=new ExplorationTools({root:f.root,state,cfg:f.cfg,ledger:f.ledger,transport,tasks:new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),media:o.media,library:new QQImageLibrary(f.root,f.store),search:new SearchService(new MockSearchProvider(),f.ledger,f.cfg),readRun:()=>({})},run,new TurnContext(),new AbortController().signal);
  const names=tools.available().map(t=>t.function.name);assert.ok(names.includes('send_file'));assert.ok(!names.includes('generate_image'));
  const catalog=await tools.execute('list_files',{},'list'),pdf=catalog.result.files.find((i:any)=>i.name==='参考资料.pdf');
  const sent=await tools.execute('send_file',{fileId:pdf.id},'send');assert.equal(sent.result.deliveryStatus,'confirmed');assert.deepEqual(transport.attachments[0].bytes,o.pdf);assert.equal(transport.attachments[0].group,conversation);
  await tools.execute('send_file',{fileId:pdf.id},'repeat');assert.equal(transport.attachments.length,1);assert.equal(f.ledger.value('image'),0);assert.equal(state.get(run.id).shared,1);
 }finally{f.cleanup();}
});
