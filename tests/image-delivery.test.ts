import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture,message} from './helpers.js';
import {MockImageProvider} from '../src/image/provider.js';
import {sendGeneratedImage} from '../src/qq/image-delivery.js';
import {FishError} from '../src/types.js';
import {MockTransport} from '../src/qq/adapter.js';
const imageId='11111111-1111-4111-8111-111111111111';
test('generated sends are scoped, durable and reconcile late receipts without another send',async()=>{
 const f=fixture(),transport=new MockTransport();let sent=0,checks=0;
 fs.mkdirSync(f.root+'/runtime/outputs/'+imageId);
 const output=await new MockImageProvider().generate('fixture',f.root+'/runtime/outputs/'+imageId);assert.equal(output.status,'ok');
 fs.renameSync(f.root+'/runtime/outputs/'+imageId+'/mock.png',f.root+'/runtime/outputs/'+imageId+'/image.png');
 f.store.setMeta('qq-image-result:'+imageId,JSON.stringify({created:true,conversation:'g',deliveryStatus:'not_attempted',next:{tool:'send_image'}}));
 transport.file=async()=>{sent++;throw new FishError('ONEBOT_SEND_UNCONFIRMED');};
 const withReceipts=Object.assign(transport,{imageReceipt:async()=>{checks++;return checks===1?undefined:'111';}});
 try{
  await assert.rejects(sendGeneratedImage(f.root,f.store,withReceipts,message('',{group:'g2'}),'generated-'+imageId,10485760),/NOT_AVAILABLE/);
  const first=await sendGeneratedImage(f.root,f.store,withReceipts,message(),'generated-'+imageId,10485760);assert.equal(first.deliveryStatus,'unconfirmed');assert.equal(first.next,undefined);
  const again=await sendGeneratedImage(f.root,f.store,withReceipts,message(),'generated-'+imageId,10485760);assert.equal(again.reused,true);assert.equal(again.deliveryStatus,'unconfirmed');
  const late=await sendGeneratedImage(f.root,f.store,withReceipts,message(),'generated-'+imageId,10485760);assert.equal(late.delivered,true);assert.equal(late.qqMessageId,'111');
  await sendGeneratedImage(f.root,f.store,withReceipts,message(),'generated-'+imageId,10485760);assert.equal(sent,1);assert.equal(checks,2);
 }finally{f.cleanup();}
});
