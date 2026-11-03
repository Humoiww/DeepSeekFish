import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import sharp from 'sharp';
import {fixture,message} from './helpers.js';
import {DeepSeekModel,BudgetedModel,ModelResponseError} from '../src/agent/model.js';
import {Bot} from '../src/agent/bot.js';
import {Tasks} from '../src/codex/tasks.js';
import {MockTaskRunner} from '../src/codex/runner.js';
import {SearchService,MockSearchProvider} from '../src/search/provider.js';
import {MockImageProvider} from '../src/image/provider.js';
import {QQMedia} from '../src/qq/media.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import type {QQImageClient} from '../src/qq/image-client.js';
import {browsePage,pageAssets} from '../src/search/public-web.js';
import type {Model,ToolCall,Transport} from '../src/types.js';
const call=(name:string,args:unknown,id=name):ToolCall=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('provider accepts ten valid native calls; truncated output retains exact diagnostics and known billing',async()=>{
 const f=fixture({maxOutputTokens:768});try{
  let truncated=false;const http=(async()=>new Response(JSON.stringify({id:'synthetic',choices:[{finish_reason:truncated?'length':'tool_calls',message:{content:null,tool_calls:truncated?[{id:'cut',type:'function',function:{name:'download_image',arguments:'{"urls":['}}]:Array.from({length:10},(_,i)=>call('download_image',{url:'https://example.com/'+i+'.png'},'c'+i))}}],usage:{prompt_tokens:20,completion_tokens:100}}))) as typeof fetch;
  const model=new BudgetedModel(new DeepSeekModel('fixture',f.cfg,http),f.ledger,f.cfg);
  const r=await model.complete('g','u',[{role:'user',content:'synthetic batch'}]);assert.equal(r.tool_calls?.length,10);
  truncated=true;await assert.rejects(model.complete('g','u',[{role:'user',content:'synthetic batch'}]),e=>e instanceof ModelResponseError&&e.code==='DEEPSEEK_TOOL_OUTPUT_TRUNCATED');
  assert.equal(f.ledger.value('tokens'),240);const record=JSON.parse(f.store.getMeta('model:last-invalid')!);assert.equal(record.finishReason,'length');assert.equal(record.toolCount,1);assert.ok(record.issues[0].includes('JSON'));assert.equal(record.response.tool_calls[0].function.arguments,'{"urls":[');
 }finally{f.cleanup();}
});
test('HTML prioritizes content, deduplicates GitHub originals, and discovers queryable public JSON galleries',async()=>{
 const html='<title>gallery</title><nav><img src="/logo.png"><a href="/login">sign in</a></nav><article>Useful gallery<a href="https://github.com/o/r/blob/main/a.webp"><img src="https://github.com/o/r/raw/main/a.webp" alt="鲸鱼笑"></a><a href="/archive">图片目录</a></article><script>fetch("/gallery-index.json")</script>';
 const p=pageAssets(html,'https://example.com');assert.equal(p.images[0].label,'鲸鱼笑');assert.equal(p.images[0].url,'https://raw.githubusercontent.com/o/r/main/a.webp');assert.equal(p.images.length,2);assert.ok(!p.text.includes('sign in'));assert.ok(p.links.some(l=>l.url.endsWith('gallery-index.json')));
 const json={description:'#plain annotation, not a URL',group:{images:Array.from({length:60},(_,i)=>({name:'鲸鱼'+i,original:'https://cdn.example.com/'+i+'.webp',preview:'https://cdn.example.com/thumb/'+i+'.webp'}))}};
 const reader=async(url:string)=>({url,type:'application/json',bytes:Buffer.from(JSON.stringify(json))});
 const page=await browsePage('https://example.com/index.json',25,undefined,reader);assert.equal(page.totalImages,60);assert.equal(page.totalLinks,0);assert.equal(page.images[0].label,'鲸鱼25');assert.equal(page.nextOffset,50);
 const filtered=await browsePage('https://example.com/index.json',0,undefined,reader,'鲸鱼42');assert.equal(filtered.totalImages,1);
});
test('QQ completes ten new downloads, classifications and deliveries; one failed download does not discard successes',async t=>{
 const f=fixture({qqTransport:'onebot',privateUsers:['20002'],bufferMs:10000,search:true,dailyTokens:1000000,groupDailyTokens:1000000,maxOutputTokens:768});
 const bytes=await Promise.all(Array.from({length:10},(_,i)=>sharp({create:{width:20+i,height:20,channels:3,background:{r:20*i,g:30,b:50}}}).webp().toBuffer()));
 t.mock.method(dns,'lookup',async()=>[{address:'1.1.1.1',family:4}]);
 t.mock.method(https,'get',(url:URL,_opts:any,cb:any)=>{
  const index=Number(url.pathname.match(/\d+/)?.[0]??0),response=new EventEmitter() as any;response.statusCode=index===99?404:200;response.headers={'content-type':'image/webp'};response.destroy=()=>{};
  queueMicrotask(()=>{cb(response);if(index!==99){response.emit('data',bytes[index]);response.emit('end');}});return new EventEmitter();
 });
 f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT)');
 const media=new QQMedia(f.root,f.store),library=new QQImageLibrary(f.root,f.store),saved:string[]=[],sent:Buffer[]=[],spoken:string[]=[];let round=0;
 const transport:Transport={status:'fixture',send:async(_m,text)=>{spoken.push(text);},file:async()=>{},meme:async(_m,b)=>{sent.push(b);},stop(){}};
 const client={view:async(m:any,ids:string[])=>library.view(m.group,m.user,ids),list:async(m:any,s:any,o:any)=>library.list(m.group,m.user,s,o)} as QQImageClient;
 const provider:Model={kind:'fixture',async complete(messages){
  round++;
  if(round===1)return {text:'',tool_calls:[call('download_image',{urls:Array.from({length:11},(_,i)=>'https://example.com/'+(i===10?99:i)+'.webp')})],usage:{input:100,output:100}};
  if(round===2){
   const content=messages.find(m=>m.role==='tool')!.content;
   const results=JSON.parse(typeof content==='string'?content:content[0].type==='text'?content[0].text:'').images;assert.equal(results.filter((r:any)=>r.saved).length,10);assert.equal(results[10].error,'WEB_HTTP_404');saved.push(...results.filter((r:any)=>r.saved).map((r:any)=>r.image.id));
   assert.equal(messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(p=>p.type==='image_url').length,10);
   // Ten independent native calls reproduce the previous >4 / >8 failure, without synthetic truncation.
   return {text:'',tool_calls:saved.map((id,i)=>call('collect_meme',{imageId:id,description:'新图'+i,tags:['新图']},'collect'+i)),usage:{input:100,output:100}};
  }
  if(round===3){assert.equal(media.find('private:20002','新图').length,10);return {text:'',tool_calls:[call('send_meme',{ids:saved})],usage:{input:100,output:100}};}
  return {text:'这些都刚捞来的。',usage:{input:100,output:10}};
 }};
 const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport,undefined,client,undefined,media);
 try{await bot.receive(message('公开图批量验证',{group:'private:20002',user:'20002'}));await bot.flush();assert.equal(round,4);assert.equal(sent.length,10);assert.equal(new Set(sent.map(b=>b.toString('base64'))).size,10);assert.deepEqual(spoken,['这些都刚捞来的。']);}
 finally{await bot.stop();f.cleanup();}
});
test('truncated native JSON is recorded and retried in smaller batches without executing partial calls',async()=>{
 const f=fixture({dailyTokens:1000000,groupDailyTokens:1000000});let calls=0;const spoken:string[]=[];
 const provider:Model={kind:'fixture',async complete(messages){if(++calls===1)throw new ModelResponseError('DEEPSEEK_TOOL_OUTPUT_TRUNCATED',{input:20,output:20},{finishReason:'length',toolCount:1,issues:['incomplete JSON'],response:{tool_calls:[]}});assert.ok(messages.some(m=>m.role==='system'&&String(m.content).includes('尚未执行')));return {text:'继续聊。',usage:{input:20,output:10}};}};
 const tasks=new Tasks(f.root,f.store,f.ledger,f.cfg,new MockTaskRunner()),transport:Transport={status:'test',send:async(_m,t)=>{spoken.push(t);},file:async()=>{},stop(){}};
 const bot=new Bot(f.root,f.cfg,f.store,f.ledger,new BudgetedModel(provider,f.ledger,f.cfg),tasks,new SearchService(new MockSearchProvider(),f.ledger,f.cfg),new MockImageProvider(),transport);
 try{await bot.receive(message());await bot.flush();assert.equal(calls,2);assert.deepEqual(spoken,['继续聊。']);const traces=fs.readdirSync(f.root+'/runtime/logs/qq').map(n=>fs.readFileSync(f.root+'/runtime/logs/qq/'+n,'utf8'));assert.ok(traces.some(t=>t.includes('providerResponse')&&t.includes('length')));}
 finally{await bot.stop();f.cleanup();}
});
