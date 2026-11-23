import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {gzipSync,deflateSync,brotliCompressSync} from 'node:zlib';
import sharp from 'sharp';
import {fixture,message} from './helpers.js';
import {readPublic,publicAddress,pageAssets,browsePage,downloadWebImage,type PublicReader} from '../src/search/public-web.js';
import {QQMedia} from '../src/qq/media.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import fs from 'node:fs';
import {makeDir} from '../src/paths.js';
import {stageReferences} from '../src/image/references.js';
import {FishError} from '../src/types.js';
import {SharedTools} from '../src/agent/shared-tools.js';
import {TurnContext} from '../src/agent/context.js';
import {MemoryJournal} from '../src/memory/journal.js';
import {browseTools} from '../src/search/tools.js';
import {MAX_IMAGE_BYTES} from '../src/image/limits.js';

type WebReply={status?:number;headers?:Record<string,string>;chunks?:Buffer[]};
function mockPublicHttp(t:TestContext,reply:(url:URL,options:any)=>WebReply){
  const requests:string[]=[],lookups:string[]=[];
  t.mock.method(dns,'lookup',async(host:string)=>{lookups.push(host);return [{address:'1.1.1.1',family:4}];});
  t.mock.method(https,'get',(url:URL,options:any,cb:any)=>{
    requests.push(url.href);assert.equal(options.agent,false);
    assert.ok(!Object.keys(options.headers).some(key=>/^(authorization|proxy-authorization|cookie)$/i.test(key)));
    assert.match(options.headers['User-Agent'],/^Mozilla\/5\.0 .*Chrome\//);
    assert.match(options.headers.Accept,/text\/html/);assert.ok(options.headers['Accept-Language']);
    assert.equal(options.headers['Accept-Encoding'],'gzip, deflate, br');
    options.lookup(url.hostname,{all:true},(error:any,addresses:any)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'1.1.1.1',family:4}]);});
    const response=new PassThrough() as any,result=reply(url,options);
    response.statusCode=result.status??200;response.headers={'content-type':'text/html',...result.headers};
    queueMicrotask(()=>{cb(response);for(const chunk of result.chunks??[]){if(response.destroyed)break;response.write(chunk);}response.end();});
    return new EventEmitter();
  });
  return {requests,lookups};
}

test('public egress checks actual DNS and redirects, pins the connection, never sends credentials',async t=>{
  const lookups:string[]=[];let requests=0;
  t.mock.method(dns,'lookup',async(host:string)=>{lookups.push(host);return [{address:host==='internal.example.com'?'100.64.0.1':'1.1.1.1',family:4}];});
  t.mock.method(https,'get',(url:URL,options:any,cb:any)=>{
    requests++;assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);assert.equal(options.agent,false);
    options.lookup(url.hostname,{all:true},(error:any,addresses:any)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'1.1.1.1',family:4}]);});
    const response=new EventEmitter() as any;response.statusCode=302;response.headers={location:'https://internal.example.com/secret'};response.destroy=()=>{};
    queueMicrotask(()=>cb(response));return new EventEmitter();
  });
  await assert.rejects(readPublic('https://example.com/a',100),/PRIVATE_ADDRESS/);assert.equal(requests,1);assert.deepEqual(lookups,['example.com','internal.example.com']);
  for(const ip of ['127.0.0.1','169.254.169.254','100.99.100.101','10.0.0.1','192.168.1.1','::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(ip),false,ip);
  assert.equal(publicAddress('1.1.1.1'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
  await assert.rejects(readPublic('file:///etc/passwd',100),/PUBLIC_URL/);
});
test('public browser headers use only clean site Referers and recompute them on redirects',async t=>{
  const referers=new Map([
    ['i.pximg.net','https://www.pixiv.net/'],['i0.hdslb.com','https://www.bilibili.com/'],
    ['wx1.sinaimg.cn','https://weibo.com/'],['tiebapic.baidu.com','https://tieba.baidu.com/'],
    ['imgsa.baidu.com','https://tieba.baidu.com/'],['imgsrc.baidu.com','https://tieba.baidu.com/'],
    ['i2.bahamut.com.tw','https://forum.gamer.com.tw/'],['img.nga.178.com','https://bbs.nga.cn/'],
    ['img.nga.cn','https://bbs.nga.cn/'],
  ]);
  mockPublicHttp(t,(url,options)=>{
    assert.equal(options.headers.Referer,referers.get(url.hostname));
    return url.pathname==='/redirect'?{status:302,headers:{location:'https://example.com/final','set-cookie':'ignored=1'}}:{chunks:[Buffer.from('ok')]};
  });
  for(const host of [...referers.keys(),'pximg.net.evil.example','evilpximg.net'])await readPublic('https://'+host+'/public?private_query=ignored',100);
  const result=await readPublic('https://i.pximg.net/redirect',100);assert.equal(result.url,'https://example.com/final');
});
test('gzip, x-gzip, deflate and br decode incrementally with limits on both wire and output bytes',async t=>{
  let reply:WebReply={};mockPublicHttp(t,()=>reply);
  const text=Buffer.from('公开网页和图片内容。'.repeat(100));
  for(const [encoding,compress] of [['gzip',gzipSync],['x-gzip',gzipSync],['deflate',deflateSync],['br',brotliCompressSync]] as const){
    const wire=compress(text),chunks=Array.from({length:Math.ceil(wire.length/7)},(_,i)=>wire.subarray(i*7,(i+1)*7));
    assert.ok(wire.length<text.length);
    reply={headers:{'content-encoding':encoding},chunks};
    assert.deepEqual((await readPublic('https://example.com/compressed',text.length)).bytes,text);
    await assert.rejects(readPublic('https://example.com/zip-bomb',wire.length+1),/WEB_BODY_TOO_LARGE/);
    // Here the decoded result fits, but even a tiny compressed response exceeds the wire budget.
    const small=Buffer.from('ok'),smallWire=compress(small);assert.ok(smallWire.length>small.length);
    reply={headers:{'content-encoding':encoding},chunks:[smallWire.subarray(0,1),smallWire.subarray(1)]};
    await assert.rejects(readPublic('https://example.com/wire-limit',small.length),/WEB_BODY_TOO_LARGE/);
    reply={headers:{'content-encoding':encoding,'content-length':String(smallWire.length)},chunks:[smallWire]};
    await assert.rejects(readPublic('https://example.com/declared-limit',small.length),/WEB_BODY_TOO_LARGE/);
  }
  reply={headers:{'content-encoding':'compress'},chunks:[Buffer.from('no')]};
  await assert.rejects(readPublic('https://example.com/unknown-encoding',100),/WEB_ENCODING_UNSUPPORTED/);
  reply={chunks:[Buffer.from('123'),Buffer.from('456')]};
  await assert.rejects(readPublic('https://example.com/identity-limit',5),/WEB_BODY_TOO_LARGE/);
  for(const encoding of ['','identity']){
    reply={headers:{'content-encoding':encoding},chunks:[Buffer.from('123'),Buffer.from('456')]};
    assert.deepEqual((await readPublic('https://example.com/identity',6)).bytes,Buffer.from('123456'));
    await assert.rejects(readPublic('https://example.com/identity-limit',5),/WEB_BODY_TOO_LARGE/);
  }
  reply={headers:{'content-encoding':'gzip'},chunks:[Buffer.from('invalid gzip')]};
  await assert.rejects(readPublic('https://example.com/broken-gzip',100));
});
test('additional lazy image attributes resolve public originals',()=>{
  const attrs=['data-actualsrc','data-url','data-img','data-echo','data-lazyload'];
  const page=pageAssets(attrs.map((attr,i)=>'<img '+attr+'="/lazy-'+i+'.gif" alt="原图">').join(''),'https://example.com/gallery');
  assert.deepEqual(page.images.map(image=>image.url),attrs.map((_,i)=>'https://example.com/lazy-'+i+'.gif'));
  assert.ok(page.images.every(image=>image.label==='原图'));
});
test('webpage image candidates preserve source and kind; pagination and GitHub raw image resolution work',async()=>{
  const html='<title>鲸鱼图库</title><script>secret()</script><img data-src="/a.gif" alt="大笑"><img srcset="/b.png 1x, /c.png 2x"><meta property="og:image" content="/cover.png"><video poster="/v.jpg"></video><a href="/gallery/2">下一页</a><img src="http://127.0.0.1/private">';
  const p=pageAssets(html,'https://example.com/gallery/');assert.equal(p.title,'鲸鱼图库');assert.equal(p.images.length,5);assert.ok(!p.text.includes('secret'));assert.equal(p.images.find(i=>i.url.endsWith('v.jpg'))?.kind,'video_cover');
  const page=await browsePage('https://example.com/gallery/',0,undefined,async url=>({url,type:'text/html',bytes:Buffer.from(html)}));assert.ok(page.links.some(l=>l.label==='下一页'));
  let requested='';await downloadWebImage('https://github.com/owner/repo/blob/main/memes/a.png',undefined,async url=>{requested=url;return {url,type:'image/png',bytes:Buffer.alloc(0)};});assert.equal(requested,'https://raw.githubusercontent.com/owner/repo/main/memes/a.png');
});
test('image download tries direct, Pixiv mirror, then animation-preserving wsrv with pinned public reads',async t=>{
  const original='https://i.pximg.net/img-original/public.gif?size=original&v=1',bytes=Buffer.from('GIF89a');
  const {requests,lookups}=mockPublicHttp(t,(url,options)=>{
    if(url.hostname==='i.pximg.net')return {status:403};
    if(url.hostname==='i.pixiv.re'){assert.equal(url.pathname,'/img-original/public.gif');assert.equal(url.search,new URL(original).search);return {status:429};}
    assert.equal(url.hostname,'wsrv.nl');assert.equal(url.searchParams.get('url'),original);assert.equal(url.searchParams.get('n'),'-1');
    assert.equal(options.headers.Referer,undefined);
    return {headers:{'content-type':'image/gif'},chunks:[bytes]};
  });
  const result=await downloadWebImage(original);
  assert.equal(result.url,original);assert.equal(result.via,'mirror');assert.deepEqual(result.bytes,bytes);
  assert.deepEqual(requests.map(url=>new URL(url).hostname),['i.pximg.net','i.pixiv.re','wsrv.nl']);
  assert.deepEqual(lookups,['i.pximg.net','i.pixiv.re','wsrv.nl']);
});
test('free image mirrors cover rate limits and transient failures; direct success never calls a mirror',async()=>{
  const original='https://i.imgur.com/a.gif',bytes=Buffer.from('GIF89a');
  for(const failure of [undefined,...[403,429,451,502,503,504].map(status=>new FishError('WEB_HTTP_'+status)),Object.assign(new Error('reset'),{code:'ECONNRESET'}),new DOMException('timeout','TimeoutError')]){
    const calls:string[]=[];
    const result=await downloadWebImage(original,undefined,async(url,limit)=>{
      calls.push(url);assert.equal(limit,MAX_IMAGE_BYTES);
      if(url===original&&failure)throw failure;
      if(url!==original){assert.equal(new URL(url).hostname,'wsrv.nl');assert.equal(new URL(url).searchParams.get('url'),original);assert.equal(new URL(url).searchParams.get('n'),'-1');}
      return {url,type:'image/gif',bytes};
    });
    assert.equal(calls[0],original);assert.equal(calls.length,failure?2:1);assert.equal(result.via,failure?'mirror':'direct');assert.equal(result.url,original);
  }
});
test('mirror fallback never retries private targets, size errors, ordinary HTTP errors, or caller cancellation',async()=>{
  for(const code of ['WEB_PRIVATE_ADDRESS','WEB_BODY_TOO_LARGE','WEB_ENCODING_UNSUPPORTED','WEB_HTTP_404','WEB_IMAGE_EXPECTED']){
    let calls=0;
    await assert.rejects(downloadWebImage('https://example.com/a.gif',undefined,async()=>{calls++;throw new FishError(code);}),error=>error instanceof FishError&&error.code===code);
    assert.equal(calls,1);
  }
  const controller=new AbortController();let calls=0;
  await assert.rejects(downloadWebImage('https://example.com/a.gif',controller.signal,async()=>{calls++;controller.abort();throw new FishError('WEB_HTTP_429');}),{name:'AbortError'});
  assert.equal(calls,1);
  await assert.rejects(downloadWebImage('http://127.0.0.1/a.gif',undefined,async()=>{throw Error('must not read');}),/WEB_PUBLIC_URL_REQUIRED/);
});
test('mirror redirects retain DNS checks and never request a private hop',async t=>{
  const {requests}=mockPublicHttp(t,url=>url.hostname==='i.imgur.com'?{status:429}:{status:302,headers:{location:'https://internal.example.com/a.gif'}});
  t.mock.method(dns,'lookup',async(host:string)=>[{address:host==='internal.example.com'?'100.64.0.1':'1.1.1.1',family:4}]);
  await assert.rejects(downloadWebImage('https://i.imgur.com/a.gif'),/WEB_PRIVATE_ADDRESS/);
  assert.deepEqual(requests.map(url=>new URL(url).hostname),['i.imgur.com','wsrv.nl']);
});
test('mirror downloads reject HTML, JSON and text errors including misleading image MIME types',async()=>{
  for(const [type,body] of [
    ['text/html','<html>blocked</html>'],['application/json','{"error":"blocked"}'],['text/plain','rate limited'],
    ['application/problem+json','{"error":"blocked"}'],['image/jpeg','<!doctype html><html>blocked</html>'],
    ['image/gif','{"error":"blocked"}'],['application/octet-stream','rate limited'],
  ]){
    let calls=0;
    await assert.rejects(downloadWebImage('https://i.imgur.com/error.gif',undefined,async url=>{
      calls++;if(calls===1)throw new FishError('WEB_HTTP_403');return {url,type,bytes:Buffer.from(body)};
    }),/WEB_IMAGE_EXPECTED/);
    assert.equal(calls,2);
  }
  let calls=0;
  await assert.rejects(downloadWebImage('https://i.pximg.net/error.gif',undefined,async url=>{
    calls++;if(calls===1)throw new FishError('WEB_HTTP_403');return {url,type:'text/html',bytes:Buffer.from('<html>blocked</html>')};
  }),/WEB_IMAGE_EXPECTED/);
  assert.equal(calls,3);
});
test('shared downloads report direct or mirror, retain animated provenance, and advise changing failed sources',async()=>{
  const f=fixture({search:true}),media=new QQMedia(f.root,f.store),library=new QQImageLibrary(f.root,f.store);
  f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT)');
  const gif=await sharp(Buffer.concat([Buffer.alloc(16*16*3,0),Buffer.alloc(16*16*3,255)]),{raw:{width:16,height:32,channels:3,pageHeight:16}}).gif({delay:[100,200]}).toBuffer();
  const png=await sharp({create:{width:16,height:16,channels:3,background:'blue'}}).png().toBuffer();
  const direct='https://example.com/direct.png',original='https://i.imgur.com/original.gif',failed='https://example.com/blocked.jpg',calls:string[]=[];
  const reader:PublicReader=async(url,limit)=>{
    calls.push(url);assert.equal(limit,MAX_IMAGE_BYTES);
    if(url===direct)return {url,type:'image/png',bytes:png};
    if(new URL(url).hostname!=='wsrv.nl')throw new FishError('WEB_HTTP_429');
    return new URL(url).searchParams.get('url')===original?{url,type:'application/octet-stream',bytes:gif}:{url,type:'text/html',bytes:Buffer.from('<html>denied</html>')};
  };
  try{
    const tools=new SharedTools({root:f.root,store:f.store,memory:new MemoryJournal(f.root,f.store),context:new TurnContext(),signal:new AbortController().signal,
      search:{async search(){throw Error('paid search must not run');},async fetch(){throw Error('paid fetch must not run');}},searchEnabled:()=>true,
      download:(url,signal)=>downloadWebImage(url,signal,reader),media,library,identity:{speaker:'admin'},memoryOrigin:'test',searchActor:'test',guard:()=>{},
      view:(m,ids)=>library.view(m.group,m.user,ids),listImages:()=>[],listFiles:()=>[]});
    const result=await tools.execute(browseTools.find(tool=>tool.function.name==='download_image')!,{urls:[direct,original,failed]},message(),'download',()=> 'unused');
    const images=result!.result.images;
    assert.equal(images[0].via,'direct');assert.equal(images[1].via,'mirror');assert.equal(images[1].image.animated,true);
    assert.equal(images[2].error,'WEB_IMAGE_EXPECTED');assert.match(images[2].hint,/换.*来源/);assert.match(images[2].hint,/不要重复/);
    assert.equal(calls.length,5);assert.deepEqual(fs.readFileSync(library.select('g','admin',[images[1].image.id])[0].path),gif);
    assert.equal(library.list('g','admin','web').images.find(image=>image.id===images[1].image.id)?.sourceUrl,original);
  }finally{f.cleanup();}
});
test('downloaded animations are visible, durable catalog references and collectable/sendable originals',async()=>{
  const f=fixture(),media=new QQMedia(f.root,f.store);f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT)');
  const bytes=await sharp(Buffer.concat([Buffer.alloc(16*16*3,0),Buffer.alloc(16*16*3,255)]),{raw:{width:16,height:32,channels:3,pageHeight:16}}).gif({delay:[100,200]}).toBuffer();
  try{
    const saved=await media.fromWeb('g',bytes,'https://example.com/meme.gif');assert.equal(saved.animated,true);assert.equal(saved.meme,false);assert.equal(saved.alreadyInLibrary,false);assert.equal((await media.fromWeb('g',bytes,'https://example.com/alias.gif')).alreadyInLibrary,true);
    assert.equal(media.parts('g',[{id:saved.id,messageId:'web',position:0}]).filter(p=>p.type==='image_url').length,2);
    const library=new QQImageLibrary(f.root,f.store);f.store.db.prepare('UPDATE qq_media SET observed=0').run();
    assert.equal(library.list('g','u','web').images[0].sourceUrl,'https://example.com/alias.gif');assert.deepEqual(Buffer.from(library.view('g','u',[saved.id]).images[0].data,'base64'),bytes);
    await media.collect('g',saved.id,bytes,'眨眼的鲸鱼',['得意']);assert.deepEqual(media.original('g',saved.id),bytes);assert.equal(media.find('g','得意').length,1);
    assert.throws(()=>library.select('g2','u',[saved.id]),/NOT_AVAILABLE/);await assert.rejects(media.fromWeb('g',Buffer.from('<html>no image</html>'),'https://example.com/fake.png'));
  }finally{f.cleanup();}
});
test('reference catalogs prefer original paths over previews and can filter by character',async()=>{
 const url='https://raw.githubusercontent.com/example/refs/main/catalog.json';
 const bytes=Buffer.from(JSON.stringify({assets:[{path:'characters/gpt/reference.jpg',preview:'previews/gpt.jpg',description:'GPT原图'},{path:'characters/deepseek/reference.png',preview:'previews/deepseek.png'}]}));
 const result=await browsePage(url,0,undefined,async()=>({url,type:'text/plain',bytes}),'gpt');
 assert.equal(result.images.length,1);assert.equal(result.images[0].url,'https://raw.githubusercontent.com/example/refs/main/characters/gpt/reference.jpg');
});

test('large web originals survive download, catalog viewing and GPT reference staging',async()=>{
 const f=fixture(),media=new QQMedia(f.root,f.store);
 f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT)');
 // Exercise the encoded-file limit without allocating a huge decoded raster.
 const jpeg=await sharp({create:{width:32,height:32,channels:3,background:'blue'}}).jpeg().toBuffer();
 const bytes=Buffer.concat([jpeg,Buffer.alloc(11*1024*1024)]);
 try{
  const downloaded=await downloadWebImage('https://example.com/large.jpg',undefined,async(url,limit)=>{assert.ok(limit>=bytes.length);return {url,type:'image/jpeg',bytes};});
  const saved=await media.fromWeb('g',downloaded.bytes,downloaded.url),library=new QQImageLibrary(f.root,f.store);
  assert.equal(library.list('g','u','web').images[0].id,saved.id);
  const viewed=library.view('g','u',[saved.id]).images[0];assert.equal(viewed.preview,true);assert.equal(viewed.originalBytes,bytes.length);assert.equal(viewed.originalRetained,true);
  assert.ok(Buffer.from(viewed.data,'base64').length<1024*1024);
  const selected=library.select('g','u',[saved.id]),cwd=makeDir(f.root,'runtime/workspace/large-reference');
  const staged=stageReferences(f.root,cwd,[...selected,{...selected[0],id:'another-reference'}]);
  assert.equal(staged.length,2);for(const ref of staged)assert.deepEqual(fs.readFileSync(ref.path),bytes);
 }finally{f.cleanup();}
});
