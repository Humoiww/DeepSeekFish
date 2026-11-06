import fs from 'node:fs';
import {createHash} from 'node:crypto';
import type {Store} from '../storage/db.js';
import {FishError,codeOf,type Message,type Transport} from '../types.js';
import {errorDiagnostic} from '../diagnostics.js';
import {imageMime} from '../memory/people.js';
import {catalogPath,type FileResolver} from './file-library.js';
import {sendGeneratedImage} from './image-delivery.js';

type Options={signal?:AbortSignal;guard?:()=>void;diagnostic?:(value:Record<string,any>)=>void};
/** Images and ordinary attachments share scope and durable submission handling.
 * Repeated calls in one turn read receipts; an uncertain send blocks reupload
 * across turns and process restarts. No network action is guessed successful. */
export async function sendCatalogFile(root:string,store:Store,transport:Transport,resolver:FileResolver,message:Message,fileId:string,mode:'image'|'file',options:Options={}){
 const file=await resolver.resolveFile(message,fileId,options.signal);
 if(mode==='image'&&file.kind!=='image')throw new FishError('FILE_IS_NOT_IMAGE');
 const send=mode==='image'?transport.image:transport.attachment;
 if(!send)throw new FishError(mode==='image'?'QQ_IMAGE_TRANSPORT_UNAVAILABLE':'QQ_FILE_TRANSPORT_UNAVAILABLE');
 const original=fs.readFileSync(catalogPath(root,file));if(mode==='image')imageMime(original);
 store.db.exec(`CREATE TABLE IF NOT EXISTS qq_file_deliveries(id TEXT PRIMARY KEY,conversation TEXT,file_id TEXT,mode TEXT,message_id TEXT,state TEXT,result TEXT,diagnostic TEXT,created INTEGER);
 CREATE INDEX IF NOT EXISTS qq_file_pending ON qq_file_deliveries(conversation,file_id,mode,state);`);
 const key=createHash('sha256').update(JSON.stringify([message.group,message.id,mode,fileId])).digest('hex');
 const prior=store.db.prepare("SELECT result,diagnostic FROM qq_file_deliveries WHERE id=? OR (conversation=? AND file_id=? AND mode=? AND state='unconfirmed') ORDER BY created DESC LIMIT 1").get(key,message.group,fileId,mode) as any;
 if(prior){if(prior.diagnostic)options.diagnostic?.(JSON.parse(prior.diagnostic));return {...JSON.parse(prior.result),reused:true};}
 options.signal?.throwIfAborted();options.guard?.();
 let result:Record<string,any>={fileId,name:file.name,bytes:original.length,mode,deliveryStatus:'unconfirmed',retryScheduled:false};
 store.db.prepare("INSERT INTO qq_file_deliveries VALUES (?,?,?,?,?,'unconfirmed',?,NULL,?)").run(key,message.group,fileId,mode,message.id,JSON.stringify(result),Date.now());
 store.audit('qq-file-send',message.group,JSON.stringify({...result,phase:'submitted',messageId:message.id}));
 let diagnostic:Record<string,any>|undefined;
 try{
  const receipt=mode==='image'?await transport.image!(message,original):await transport.attachment!(message,original,file.name);
  result={...result,delivered:true,deliveryStatus:'confirmed',...(receipt?.messageId?{qqMessageId:receipt.messageId}:{})};
 }catch(e){
  diagnostic=errorDiagnostic(e);options.diagnostic?.(diagnostic);
  const error=codeOf(e),uncertain=['ONEBOT_SEND_UNCONFIRMED','ONEBOT_ACTION_TIMEOUT','ONEBOT_DISCONNECTED','ONEBOT_STOPPED','ONEBOT_SEND_FAILED'].includes(error);
  result={...result,error,deliveryStatus:uncertain?'unconfirmed':'failed'};
 }
 store.db.prepare('UPDATE qq_file_deliveries SET state=?,result=?,diagnostic=? WHERE id=?').run(result.deliveryStatus,JSON.stringify(result),diagnostic?JSON.stringify(diagnostic):null,key);
 if(mode==='file'&&/^generated-[0-9a-f-]{36}$/.test(fileId)){
  const imageKey='qq-image-result:'+fileId.slice(10),previous=JSON.parse(store.getMeta(imageKey)??'{}');
  if(previous.conversation===message.group&&previous.deliveryStatus!=='confirmed'&&result.deliveryStatus!=='failed')store.setMeta(imageKey,JSON.stringify({...previous,...result,deliveryMode:'file',next:undefined}));
 }
 // Keep uncertain receipts; bound completed delivery metadata without payloads.
 store.db.exec("DELETE FROM qq_file_deliveries WHERE state!='unconfirmed' AND id NOT IN (SELECT id FROM qq_file_deliveries WHERE state!='unconfirmed' ORDER BY created DESC LIMIT 5000)");
 store.audit('qq-file-send',message.group,JSON.stringify(result));return result;
}
export async function sendLibraryImage(root:string,store:Store,transport:Transport,resolver:FileResolver,message:Message,imageId:string,maxBytes:number,options:Options={}){
 if(/^generated-[0-9a-f-]{36}$/.test(imageId))return sendGeneratedImage(root,store,transport,message,imageId,maxBytes);
 return sendCatalogFile(root,store,transport,resolver,message,imageId,'image',options);
}
