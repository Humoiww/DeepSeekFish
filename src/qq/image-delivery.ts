import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Store } from '../storage/db.js';
import { safePath } from '../paths.js';
import { verifyPng } from '../image/provider.js';
import { verifyArtifact } from '../codex/verify.js';
import { FishError,codeOf,type Message,type Transport } from '../types.js';

/** Sending is a model-selected action, separate from generation. Keep the
 * submitted state before I/O so a restart/repeated call cannot duplicate it. */
export async function sendGeneratedImage(root:string,store:Store,transport:Transport,message:Message,catalogId:string,maxBytes:number){
  if(!/^generated-[0-9a-f-]{36}$/.test(catalogId))throw new FishError('IMAGE_REFERENCE_NOT_AVAILABLE');
  const imageId=catalogId.slice(10),key='qq-image-result:'+imageId;
  const previous=JSON.parse(store.getMeta(key)??'{}');
  const scoped=previous.conversation===message.group||store.db.prepare("SELECT name FROM sqlite_master WHERE name='qq_image_requests'").get()&&store.db.prepare("SELECT 1 FROM qq_image_requests WHERE conversation=? AND image_id=? AND state='completed'").get(message.group,imageId);
  if(!scoped)throw new FishError('IMAGE_REFERENCE_NOT_AVAILABLE');
  const file=verifyPng(safePath(root,'runtime/outputs'),imageId+'/image.png',maxBytes);
  if(previous.manifest)verifyArtifact(file,previous.manifest,maxBytes);
  const receipt=(value:any)=>{const {manifest:_manifest,conversation:_conversation,resources:_resources,next:_next,...safe}=value;return safe;};
  if(previous.deliveryStatus==='confirmed')return {...receipt(previous),reused:true};
  if(previous.deliveryStatus==='unconfirmed'){
    const fingerprint=previous.deliveryFingerprint??createHash('md5').update(fs.readFileSync(file)).digest('hex');
    const found=await transport.imageReceipt?.(message,fingerprint,previous.submittedAt??fs.statSync(file).mtimeMs).catch(()=>undefined);
    if(found){const updated={...previous,delivered:true,deliveryStatus:'confirmed',qqMessageId:found};store.setMeta(key,JSON.stringify(updated));return {...receipt(updated),reused:true};}
    return {...receipt(previous),reused:true,deliveryNote:'QQ尚未确认送达；查询了发送记录，没有重复投递。'};
  }
  let outcome={...previous,created:true,imageId,catalogId,conversation:message.group,submittedAt:Date.now(),next:undefined,deliveryStatus:'unconfirmed',retryScheduled:false};
  store.setMeta(key,JSON.stringify(outcome));
  store.audit('qq-image-send',message.group,JSON.stringify({imageId,phase:'submitted',messageId:message.id}));
  try{await transport.file(message,file);outcome={...outcome,delivered:true,deliveryStatus:'confirmed'};}
  catch(e){
    const error=codeOf(e),unconfirmed=['ONEBOT_SEND_UNCONFIRMED','ONEBOT_ACTION_TIMEOUT','ONEBOT_DISCONNECTED','ONEBOT_STOPPED','ONEBOT_SEND_FAILED'].includes(error);
    outcome={...outcome,deliveryStatus:unconfirmed?'unconfirmed':'failed',deliveryNote:unconfirmed?'QQ发送确认尚未收到，没有安排重发。':'QQ发送未完成。',...(unconfirmed?{}:{error})};
  }
  // The trusted transport may have saved the actual delivery copy fingerprint.
  const transportReceipt=JSON.parse(store.getMeta(key)??'{}');
  outcome={...transportReceipt,...outcome};store.setMeta(key,JSON.stringify(outcome));
  store.audit('qq-image-send',message.group,JSON.stringify({imageId,phase:outcome.deliveryStatus}));
  return receipt(outcome);
}
