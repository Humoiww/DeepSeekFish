import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fixture,message } from './helpers.js';
import type { QQImageClient } from '../src/qq/image-client.js';
import { QQImageLibrary } from '../src/qq/image-library.js';
import { QQMedia,decodeMedia,qqImageUrl } from '../src/qq/media.js';
import { OneBotTransport } from '../src/qq/onebot.js';
import { Bot } from '../src/agent/bot.js';
import { BudgetedModel } from '../src/agent/model.js';
import { Tasks } from '../src/codex/tasks.js';
import { MockTaskRunner } from '../src/codex/runner.js';
import { MockTransport } from '../src/qq/adapter.js';
import { MockSearchProvider,SearchService } from '../src/search/provider.js';
import { MockImageProvider } from '../src/image/provider.js';
import type { Model,ToolCall } from '../src/types.js';

async function animation(format:'gif'|'webp'='gif'){
  const raw=Buffer.concat([Buffer.alloc(16*16*3,0),Buffer.alloc(16*16*3,180),Buffer.alloc(16*16*3,255)]);
  return sharp(raw,{raw:{width:16,height:48,channels:3,pageHeight:16}}).toFormat(format,{delay:[100,200,300],loop:0}).toBuffer();
}
const http=(data:Buffer)=> (async()=>new Response(new Uint8Array(data))) as typeof fetch;
const incoming=(id='image-one',group='private:20002')=>message('[图片 1]',{id,group,user:group.slice(8),images:[{url:'https://multimedia.nt.qq.com.cn/image?rkey=transient-handle',file:'fixture.png',stickerHint:true}]});
const call=(name:string,args:any,id=name):ToolCall=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('real GIF and animated WebP frames are read in order; static formats remain one picture',async()=>{
  for(const format of ['gif','webp'] as const){
    const decoded=await decodeMedia(await animation(format));assert.equal(decoded.pages,3);assert.equal(decoded.frames.length,3);
    const first=await sharp(decoded.frames[0].png).raw().toBuffer(),last=await sharp(decoded.frames[2].png).raw().toBuffer();
    assert.equal(first[0],0);assert.equal(last[0],255);assert.equal(decoded.frames[2].atMs,300);
  }
  for(const format of ['png','jpeg','webp'] as const){
    const data=await sharp({create:{width:12,height:8,channels:3,background:'red'}}).toFormat(format).toBuffer();
    const d=await decodeMedia(data);assert.equal(d.pages,1);assert.equal(d.frames.length,1);
  }
  await assert.rejects(decodeMedia(Buffer.from('<svg></svg>')));
  await assert.rejects(decodeMedia(Buffer.alloc(10485761)),/TOO_LARGE/);
});
test('incoming originals are deduplicated, scoped, durable and never retain download credentials',async()=>{
  const f=fixture(),bytes=await animation();let fetches=0;
  const media=new QQMedia(f.root,f.store,undefined,(async()=>{fetches++;return new Response(new Uint8Array(bytes));}) as typeof fetch);
  try{
    const m=incoming(),items=await media.ingest([m]);assert.ok(items[0].id);const id=items[0].id!;
    assert.deepEqual(await media.ingest([m]),items);assert.equal(fetches,1);
    assert.equal(media.describe(m.group,id).animated,true);assert.throws(()=>media.original(m.group,id),/NOT_AVAILABLE/);
    assert.equal(media.parts(m.group,items).filter(p=>p.type==='image_url').length,3);
    media.remember(m.group,[{id,description:'从黑色变成白色，表达惊讶',meme:true,tags:['惊讶','变化']}],[id]);
    assert.deepEqual(media.original(m.group,id),bytes);assert.equal(media.find(m.group,'惊讶')[0].id,id);
    assert.deepEqual(new QQMedia(f.root,f.store).original(m.group,id),bytes);
    assert.throws(()=>media.original('private:30003',id),/NOT_AVAILABLE/);
    assert.throws(()=>media.remember(m.group,[{id:'other',description:'fake',meme:true,tags:[]}],[id]),/INVALID/);
    const again=await media.ingest([incoming('another')]);assert.equal(again[0].id,id);assert.equal(media.find(m.group,'').length,1);
    const stored=JSON.stringify(f.store.db.prepare('SELECT * FROM qq_media').all());assert.ok(!stored.includes('transient-handle'));assert.ok(!stored.includes('rkey'));
    assert.throws(()=>qqImageUrl('http://127.0.0.1/admin'),/DENIED/);assert.throws(()=>qqImageUrl('file:///etc/passwd'),/DENIED/);
    assert.throws(()=>qqImageUrl('https://multimedia.nt.qq.com.cn.evil.invalid/image'),/DENIED/);
    assert.equal(qqImageUrl('http://multimedia.nt.qq.com.cn/image').protocol,'https:');
    const unavailable=await media.ingest([message('[图片]',{images:[{url:'https://untrusted.invalid/image',stickerHint:false}]})]);assert.equal(unavailable[0].error,'QQ_MEDIA_URL_DENIED');
  }finally{f.cleanup();}
});
test('multiple animations give every received image visible frames within the turn budget',async()=>{
  const f=fixture(),media=new QQMedia(f.root,f.store,undefined,http(await animation()));
  try{
    // Separate conversations create distinct opaque IDs; store four different originals in one conversation.
    const items=[];
    for(let i=0;i<4;i++){
      const bytes=await sharp({create:{width:12+i,height:24+2*i,pageHeight:12+i,channels:3,background:'red'}}).gif({delay:[100,200]}).toBuffer();
      const reader=new QQMedia(f.root,f.store,undefined,http(bytes));items.push(...await reader.ingest([incoming('m'+i)]));
    }
    const parts=media.parts('private:20002',items);assert.ok(parts.filter(p=>p.type==='image_url').length<=8);
    for(const item of items)assert.ok(parts.some(p=>p.type==='text'&&p.text.includes(item.id!)));
  }finally{f.cleanup();}
});
test('bot sees actual images, classifies memes automatically, and later chooses an original without generating images',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],bufferMs:10000}),bytes=await animation(),media=new QQMedia(f.root,f.store,undefined,http(bytes));
  const transport=new MockTransport() as MockTransport&{meme:(m:any,b:Buffer)=>Promise<void>};const sent:Buffer[]=[];transport.meme=async(_m,b)=>{sent.push(b);};
  let round=0,storedId='';
  const provider:Model={kind:'fixture',async complete(messages,_max,options){
    round++;
    if(round===1){
      assert.equal(options?.toolChoice,undefined);const visible=messages.flatMap(m=>Array.isArray(m.content)?m.content:[]);
      assert.equal(visible.filter(p=>p.type==='image_url').length,3);assert.ok(!JSON.stringify(messages).includes('transient-handle'));
      storedId=(options!.tools!.find(t=>t.function.name==='remember_images')!.function.parameters.properties as any).images.items.properties.id.enum[0];
      return {text:'',tool_calls:[call('remember_images',{images:[{id:storedId,description:'黑色逐渐变白的惊讶表情',tags:['惊讶'],meme:true}]})],usage:{input:200,output:70}};
    }
    if(round===2){assert.ok(messages.every(m=>m.role!=='tool'&&!m.tool_calls));assert.ok(JSON.stringify(messages).includes('黑色逐渐变白'));return {text:'这反应也太真实了。',usage:{input:200,output:20}};}
    if(round===3){assert.equal(options?.toolChoice,undefined);return {text:'',tool_calls:[call('send_meme',{id:storedId})],usage:{input:100,output:20}};}
    return {text:'',usage:{input:100,output:1}};
  }};
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner());
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,undefined,undefined,media);
  try{
    await bot.receive(incoming());await bot.flush();assert.equal(media.find('private:20002','').length,1);assert.equal(sent.length,0);
    await bot.receive(message('刚才差点吓掉我的手机',{group:'private:20002',user:'20002'}));await bot.flush();
    assert.equal(sent.length,1);assert.deepEqual(sent[0],bytes);assert.equal(transport.sent.length,1);assert.equal(f.ledger.value('image'),0);
    assert.ok(bot.memory.recall('private:20002','',[]).events.some(e=>e.source==='qq-image-observation'));
    const logs=fs.readdirSync(f.root+'/runtime/logs/qq').map(n=>fs.readFileSync(f.root+'/runtime/logs/qq/'+n,'utf8')).join('');assert.ok(!logs.includes('transient-handle'));assert.ok(logs.includes('send_meme'));
  }finally{await bot.stop();f.cleanup();}
});
test('OneBot sends the saved GIF bytes as an image sticker without flattening animation',async()=>{
  const {WebSocketServer}=createRequire(import.meta.url)('ws'),server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');
  const f=fixture(),gif=await animation();let sent=false;
  server.on('connection',(socket:any)=>socket.on('message',(raw:Buffer)=>{
    const r=JSON.parse(raw.toString());let data:any={};
    if(r.action==='get_login_info')data={user_id:10001};else if(r.action==='get_group_list')data=[];
    else {assert.equal(r.action,'send_private_msg');const image=r.params.message[0];assert.equal(image.data.sub_type,1);assert.deepEqual(Buffer.from(image.data.file.slice(9),'base64'),gif);sent=true;data={message_id:5};}
    socket.send(JSON.stringify({echo:r.echo,status:'ok',retcode:0,data}));
  }));
  const transport=new OneBotTransport(f.root,`ws://127.0.0.1:${server.address().port}`,'fixture',f.store,async()=>{},g=>g==='private:20002');
  try{await transport.inspect();await transport.meme(incoming(),gif);assert.ok(sent);await assert.rejects(transport.meme(incoming('x','private:30003'),gif),/NOT_ALLOWED/);}
  finally{transport.stop();for(const client of server.clients)client.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));f.cleanup();}
});

test('received media are real GPT references, scoped by conversation and time, with saved memes retained',async()=>{
  const f=fixture(),bytes=await animation(),media=new QQMedia(f.root,f.store,undefined,http(bytes));
  f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT)');
  const library=new QQImageLibrary(f.root,f.store);
  try{
    const [received]=await media.ingest([incoming()]),id=received.id!;
    assert.equal(library.list('private:20002','20002','received').images[0].id,id);
    assert.deepEqual(Buffer.from(library.view('private:20002','20002',[id]).images[0].data,'base64'),bytes);
    assert.throws(()=>library.select('private:30003','30003',[id]),/NOT_AVAILABLE/);
    f.store.db.prepare('UPDATE qq_media SET observed=0').run();
    assert.throws(()=>library.select('private:20002','20002',[id]),/NOT_AVAILABLE/);
    media.remember('private:20002',[{id,description:'惊讶的动画',tags:['惊讶'],meme:true}],[id]);
    assert.equal(library.select('private:20002','20002',[id])[0].id,id);
    f.store.db.prepare("UPDATE qq_media SET path='runtime/codex-home/auth.json'").run();
    assert.throws(()=>library.select('private:20002','20002',[id]),/NOT_AVAILABLE/);
  }finally{f.cleanup();}
});

test('the model can collect its generated pictures, then send several originals and deduplicate repeats',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],bufferMs:10000}),media=new QQMedia(f.root,f.store);
  f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT)');
  const sourceIds=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'],originals:Buffer[]=[];
  for(const [i,id] of sourceIds.entries()){
    const bytes=await sharp({create:{width:16,height:16,channels:3,background:i?'red':'blue'}}).png().toBuffer();originals.push(bytes);
    fs.mkdirSync(f.root+'/runtime/outputs/'+id);fs.writeFileSync(f.root+'/runtime/outputs/'+id+'/image.png',bytes);
    f.store.db.prepare('INSERT INTO qq_image_requests VALUES (?,?,?,?,?)').run('private:20002','m'+i,'completed',id,'');
  }
  const library=new QQImageLibrary(f.root,f.store),catalog=library.list('private:20002','20002','generated');
  assert.equal(catalog.images[0].position,1);assert.equal(catalog.images[0].messageId,'m1');assert.match(catalog.images[0].label,/最新/);
  const client={view:async(m:any,ids:string[])=>library.view(m.group,m.user,ids)} as QQImageClient;
  const transport=new MockTransport() as MockTransport&{meme:(m:any,b:Buffer)=>Promise<void>},sent:Buffer[]=[];transport.meme=async(_m,b)=>{sent.push(b);};
  let round=0,ids:string[]=[];
  const provider:Model={kind:'fixture',async complete(messages,_max,options){
    round++;assert.ok(options?.tools?.some(t=>t.function.name==='collect_meme'));
    const collection=(i:number)=>call('collect_meme',{imageId:'generated-'+sourceIds[i],description:'自己画的反应表情'+i,tags:['得意']},'collect'+round+'-'+i);
    if(round===1)return {text:'',tool_calls:[collection(0)],usage:{input:100,output:50}};
    if(round===2){assert.equal(media.find('private:20002','').length,0);assert.ok(messages.some(m=>m.role==='tool'&&String(m.content).includes('preview')));return {text:'',tool_calls:[call('view_images',{imageIds:sourceIds.map(id=>'generated-'+id)})],usage:{input:100,output:20}};}
    if(round===3)return {text:'',tool_calls:[collection(0),collection(1)],usage:{input:100,output:80}};
    if(round===4){ids=messages.slice(-2).map(m=>JSON.parse(String(m.content)).meme.id);return {text:'',tool_calls:[call('send_meme',{ids})],usage:{input:100,output:30}};}
    if(round===5){const result=JSON.parse(String(messages.at(-1)?.content));assert.ok(result.images.every((m:any)=>m.sent));return {text:'',tool_calls:ids.map((id,i)=>call('send_meme',{id},'retry'+i)),usage:{input:100,output:30}};}
    for(const m of messages.slice(-2)){const result=JSON.parse(String(m.content));assert.equal(result.sent,true);assert.equal(result.reused,true);}
    return {text:'',tool_calls:[call('reply',{text:''})],usage:{input:100,output:10}};
  }};
  const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner());
  const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,client,undefined,media);
  try{
    await bot.receive(message('把你自己的表情收藏起来，发给我看看',{group:'private:20002',user:'20002'}));await bot.flush();
    assert.equal(round,6);assert.equal(sent.length,2);assert.ok(sent.every(b=>originals.some(o=>o.equals(b))));assert.equal(f.ledger.value('image'),0);
    assert.equal(new QQMedia(f.root,f.store).find('private:20002','得意').length,2);assert.equal(media.find('private:30003','').length,0);
    assert.equal(library.list('private:20002','20002','collected').total,2);
    await assert.rejects(client.view({group:'private:30003',user:'30003'} as any,['generated-'+sourceIds[0]]),/NOT_AVAILABLE/);
    const first=media.find('private:20002','')[0];await media.collect('private:20002',first.sourceImageId,media.original('private:20002',first.id),first.description,first.tags);assert.equal(media.find('private:20002','').length,2);
  }finally{await bot.stop();f.cleanup();}
});
