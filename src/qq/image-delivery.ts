import {sendFailure,toolFailure} from '../agent/tool-feedback.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Store } from '../storage/db.js';
import { safePath } from '../paths.js';
import {generatedImage,generatedInfo} from '../image/generated.js';
import { verifyArtifact } from '../codex/verify.js';
import { FishError,codeOf,type Message,type Transport } from '../types.js';

/** Sending is a model-selected action, separate from generation. Keep the
 * submitted state before I/O so a restart/repeated call cannot duplicate it. */
export async function sendGeneratedImage(root:string,store:Store,transport:Transport,message:Message,catalogId:string,maxBytes:number,onDispatch?:()=>void){
  if(!/^generated-[0-9a-f-]{36}$/.test(catalogId))throw new FishError('IMAGE_REFERENCE_NOT_AVAILABLE');
  const imageId=catalogId.slice(10),key='qq-image-result:'+imageId;
  const previous=JSON.parse(store.getMeta(key)??'{}');
  const scoped=previous.conversation===message.group||store.db.prepare("SELECT name FROM sqlite_master WHERE name='qq_image_requests'").get()&&store.db.prepare("SELECT 1 FROM qq_image_requests WHERE conversation=? AND image_id=? AND state='completed'").get(message.group,imageId);
  if(!scoped)throw new FishError('IMAGE_REFERENCE_NOT_AVAILABLE');
  const file=generatedImage(root,imageId,maxBytes,previous.manifest?.name);
  if(previous.manifest)verifyArtifact(file,previous.manifest,maxBytes);
  const receipt=(value:any)=>{const {manifest:_manifest,conversation:_conversation,resources:_resources,next:_next,...safe}=value;return safe;};
  const reused=(value:any)=>({...receipt(value),reused:true,submittedNow:false,deliveryNote:value.deliveryStatus==='confirmed'?'图片此前已确认送达；本次只查询已有回执，没有再次发送。':'QQ尚未确认送达；查询了发送记录，没有重复投递。'});
  if(previous.deliveryStatus==='confirmed')return reused(previous);
  if(previous.deliveryStatus==='unconfirmed'){
    const fingerprint=previous.deliveryFingerprint??createHash('md5').update(fs.readFileSync(file)).digest('hex');
    let found;
    try{found=await transport.imageReceipt?.(message,fingerprint,previous.submittedAt??fs.statSync(file).mtimeMs);}
    catch(e){return {...reused(previous),receiptCheck:toolFailure(e,'lookup_qq_image_receipt')};}
    if(found){const updated={...receipt(previous),conversation:previous.conversation,manifest:previous.manifest,error:undefined,submissionStatus:'accepted',delivered:true,deliveryStatus:'confirmed',qqMessageId:found,confirmedAt:Date.now()};store.setMeta(key,JSON.stringify(updated));return reused(updated);}
    return reused(previous);
  }
  const {error:_old,reason:_reason,retcode:_retcode,stage:_stage,requestSent:_sent,submissionStatus:_status,deliveryNote:_note,...fresh}=previous;
  let outcome={...fresh,...generatedInfo(file),created:true,imageId,catalogId,conversation:message.group,submittedAt:Date.now(),next:undefined,deliveryStatus:'unconfirmed',retryScheduled:false};
  store.setMeta(key,JSON.stringify(outcome));
  store.audit('qq-image-send',message.group,JSON.stringify({imageId,phase:'dispatch_started',messageId:message.id}));
  let dispatched=false;try{onDispatch?.();dispatched=true;await transport.file(message,file);outcome={...outcome,delivered:true,deliveryStatus:'confirmed',confirmedAt:Date.now()};}
  catch(e){
    outcome={...outcome,...sendFailure(e,'send_qq_image',dispatched?'dispatch':'before')};
  }
  // The trusted transport may have saved the actual delivery copy fingerprint.
  const transportReceipt=JSON.parse(store.getMeta(key)??'{}');
  outcome={...outcome,deliveryFingerprint:transportReceipt.deliveryFingerprint};store.setMeta(key,JSON.stringify(outcome));
  store.audit('qq-image-send',message.group,JSON.stringify({imageId,phase:outcome.deliveryStatus}));
  return {...receipt(outcome),submittedNow:outcome.requestSent??(outcome.deliveryStatus==='confirmed'?true:null)};
}
