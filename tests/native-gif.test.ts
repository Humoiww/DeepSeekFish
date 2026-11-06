import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {fixture,message} from './helpers.js';
import {makeDir} from '../src/paths.js';
import {gifInfo,verifyGeneratedImage} from '../src/image/generated.js';
import {captureCodexImage,publishCodexImage} from '../src/image/codex-smoke.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import {QQImageClient} from '../src/qq/image-client.js';
import {sendGeneratedImage} from '../src/qq/image-delivery.js';
import {MockTransport} from '../src/qq/adapter.js';
import {OneBotTransport,deliveryImage} from '../src/qq/onebot.js';
import {FishError} from '../src/types.js';
const id='11111111-1111-4111-8111-111111111111';
// Synthetic fixture only; never substitutes for a provider's generated artifact.
const gif=()=>sharp(Buffer.concat([Buffer.alloc(16*16*3,0),Buffer.alloc(16*16*3,255)]),{raw:{width:16,height:32,channels:3,pageHeight:16}}).gif({delay:[200,300],loop:0}).toBuffer();
test('native GIF attachment is preserved byte for byte through capture, publication, catalog and delivery',async()=>{
 const f=fixture(),bytes=await gif(),transport=new MockTransport();let calls=0;
 try{
  const cwd=makeDir(f.root,'runtime/workspace/'+id),source=makeDir(f.root,'runtime/codex-home/generated_images');fs.writeFileSync(source+'/native.gif',bytes);
  const captured=captureCodexImage(f.root,cwd,[{id:'native',type:'imageGeneration',status:'completed',savedPath:source+'/native.gif'}],10485760);assert.equal(path.basename(captured),'image.gif');assert.deepEqual(fs.readFileSync(captured),bytes);
  const [manifest]=publishCodexImage(f.root,id,10485760);assert.equal(manifest.name,'image.gif');assert.deepEqual(gifInfo(bytes).delay,[200,300]);
  const client=new QQImageClient(f.root);assert.equal(path.basename(client.verifiedImage(id,manifest,10485760)),'image.gif');
  f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT)');f.store.db.prepare('INSERT INTO qq_image_requests VALUES (?,?,?,?,?)').run('g','m','completed',id,'');
  const library=new QQImageLibrary(f.root,f.store),listed=library.list('g','u','generated').images[0];assert.equal(listed.animated,true);assert.equal(listed.frames,2);const viewed=library.view('g','u',[listed.id]).images[0];assert.equal(viewed.mime,'image/gif');assert.deepEqual(Buffer.from(viewed.data,'base64'),bytes);
  f.store.setMeta('qq-image-result:'+id,JSON.stringify({created:true,conversation:'g',manifest,deliveryStatus:'not_attempted'}));
  transport.file=async(_m,file)=>{calls++;assert.deepEqual(fs.readFileSync(file),bytes);};
  const sent=await sendGeneratedImage(f.root,f.store,transport,message(),'generated-'+id,10485760);assert.equal(sent.deliveryStatus,'confirmed');assert.equal(sent.animated,true);await sendGeneratedImage(f.root,f.store,transport,message(),'generated-'+id,10485760);assert.equal(calls,1);
  const out=new OneBotTransport(f.root,'ws://127.0.0.1:3001','',f.store,async()=>{},()=>true);let upload:Buffer|undefined;
  (out as any).sendImage=async(_m:any,original:Buffer)=>{upload=original;};await out.file(message(),client.verifiedImage(id,manifest,10485760));assert.deepEqual(upload,bytes);assert.deepEqual(await deliveryImage(bytes),bytes);
 }finally{f.cleanup();}
});
test('inline GIF uses its real format; malformed, excessive, linked or mismatched files fail closed',async()=>{
 const f=fixture(),bytes=await gif();try{
  const cwd=makeDir(f.root,'runtime/workspace/inline');const captured=captureCodexImage(f.root,cwd,[{id:'x',type:'imageGeneration',status:'completed',result:'data:image/gif;base64,'+bytes.toString('base64')}],10485760);assert.equal(path.basename(captured),'image.gif');assert.equal(gifInfo(fs.readFileSync(captured)).frames,2);
  for(const broken of [bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.from('junk')]),Buffer.from('GIF89a invalid')])assert.throws(()=>gifInfo(broken),/INVALID_GIF/);
  const unsafe=Buffer.from(bytes);unsafe.writeUInt16LE(65535,6);unsafe.writeUInt16LE(65535,8);assert.throws(()=>gifInfo(unsafe),/INVALID_GIF/);
  fs.symlinkSync(captured,cwd+'/link.gif');assert.throws(()=>verifyGeneratedImage(cwd,'link.gif',10485760),/PATH_LINK/);assert.throws(()=>verifyGeneratedImage(cwd,'image.gif',1),/INVALID_GIF/);
 }finally{f.cleanup();}
});
test('uncertain GIF delivery preserves its receipt and never blindly uploads twice',async()=>{
 const f=fixture(),bytes=await gif(),transport=new MockTransport();let sent=0;try{
  const out=makeDir(f.root,'runtime/outputs/'+id);fs.writeFileSync(out+'/image.gif',bytes);f.store.setMeta('qq-image-result:'+id,JSON.stringify({conversation:'g',deliveryStatus:'not_attempted'}));
  transport.file=async()=>{sent++;throw new FishError('ONEBOT_ACTION_TIMEOUT');};
  const a=await sendGeneratedImage(f.root,f.store,transport,message(),'generated-'+id,10485760),b=await sendGeneratedImage(f.root,f.store,transport,message(),'generated-'+id,10485760);assert.equal(a.deliveryStatus,'unconfirmed');assert.equal(b.reused,true);assert.equal(sent,1);
 }finally{f.cleanup();}
});
