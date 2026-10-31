import {test} from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import sharp from 'sharp';
import {fixture} from './helpers.js';
import {readPublic,publicAddress,pageAssets,browsePage,downloadWebImage} from '../src/search/public-web.js';
import {QQMedia} from '../src/qq/media.js';
import {QQImageLibrary} from '../src/qq/image-library.js';

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
test('webpage image candidates preserve source and kind; pagination and GitHub raw image resolution work',async()=>{
  const html='<title>鲸鱼图库</title><script>secret()</script><img data-src="/a.gif" alt="大笑"><img srcset="/b.png 1x, /c.png 2x"><meta property="og:image" content="/cover.png"><video poster="/v.jpg"></video><a href="/gallery/2">下一页</a><img src="http://127.0.0.1/private">';
  const p=pageAssets(html,'https://example.com/gallery/');assert.equal(p.title,'鲸鱼图库');assert.equal(p.images.length,5);assert.ok(!p.text.includes('secret'));assert.equal(p.images.find(i=>i.url.endsWith('v.jpg'))?.kind,'video_cover');
  const page=await browsePage('https://example.com/gallery/',0,undefined,async url=>({url,type:'text/html',bytes:Buffer.from(html)}));assert.ok(page.links.some(l=>l.label==='下一页'));
  let requested='';await downloadWebImage('https://github.com/owner/repo/blob/main/memes/a.png',undefined,async url=>{requested=url;return {url,type:'image/png',bytes:Buffer.alloc(0)};});assert.equal(requested,'https://raw.githubusercontent.com/owner/repo/main/memes/a.png');
});
test('downloaded animations are visible, durable catalog references and collectable/sendable originals',async()=>{
  const f=fixture(),media=new QQMedia(f.root,f.store);f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT)');
  const bytes=await sharp(Buffer.concat([Buffer.alloc(16*16*3,0),Buffer.alloc(16*16*3,255)]),{raw:{width:16,height:32,channels:3,pageHeight:16}}).gif({delay:[100,200]}).toBuffer();
  try{
    const saved=await media.fromWeb('g',bytes,'https://example.com/meme.gif');assert.equal(saved.animated,true);assert.equal(saved.meme,false);
    assert.equal(media.parts('g',[{id:saved.id,messageId:'web',position:0}]).filter(p=>p.type==='image_url').length,2);
    const library=new QQImageLibrary(f.root,f.store);f.store.db.prepare('UPDATE qq_media SET observed=0').run();
    assert.equal(library.list('g','u','web').images[0].sourceUrl,'https://example.com/meme.gif');assert.deepEqual(Buffer.from(library.view('g','u',[saved.id]).images[0].data,'base64'),bytes);
    await media.collect('g',saved.id,bytes,'眨眼的鲸鱼',['得意']);assert.deepEqual(media.original('g',saved.id),bytes);assert.equal(media.find('g','得意').length,1);
    assert.throws(()=>library.select('g2','u',[saved.id]),/NOT_AVAILABLE/);await assert.rejects(media.fromWeb('g',Buffer.from('<html>no image</html>'),'https://example.com/fake.png'));
  }finally{f.cleanup();}
});
