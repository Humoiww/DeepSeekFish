import {redact} from '../storage/db.js';
import type {QQAttachment} from '../types.js';

export const MAX_INLINE_ATTACHMENT_BYTES=8*1024*1024;
export const MAX_ATTACHMENT_BYTES=128*1024*1024;
export type AttachmentSource={url:string}|{bytes:Buffer};
export function attachmentSize(raw:unknown):number|undefined{
 const n=typeof raw==='string'&&/^\d{1,16}$/.test(raw)?Number(raw):raw;
 return typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:undefined;
}
export function attachmentFileId(value:unknown):string|undefined{
 if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)value=String(value);
 return typeof value==='string'&&/^[a-zA-Z0-9_+=-][a-zA-Z0-9/._+=-]{0,511}$/.test(value)&&!value.includes('..')?value:undefined;
}
function displayName(raw:unknown):string|undefined{
 if(typeof raw!=='string'||!raw.trim()||Buffer.byteLength(raw)>300||/[\\/\x00-\x1f\x7f]/.test(raw)||raw==='.'||raw==='..')return;
 return redact(raw.trim());
}
export function attachmentHandle(segment:any,position:number):QQAttachment|undefined{
 const kind=segment?.type==='record'?'audio':segment?.type;
 if(!['file','video','audio','image'].includes(kind))return;
 const data=segment.data??{};
 const uuid=typeof data.file==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(data.file)?data.file:undefined;
 const fileId=attachmentFileId(data.file_id??data.fileId)??attachmentFileId(data.file_uuid??data.uuid??data.id)??uuid;
 // Media segments may use a generated filename as their native get_file key.
 // An arbitrary user filename or path is never treated as such a key.
 const mediaKey=typeof data.file==='string'&&kind!=='file'&&
  (/^[a-f0-9]{32}(?:\.[a-z0-9]{1,8})?$/i.test(data.file)||/^[A-Za-z0-9_-]{22,510}={0,2}$/.test(data.file))?data.file:undefined;
 const candidate=displayName(data.file_name??data.fileName??data.name)??(mediaKey||uuid?undefined:displayName(data.file));
 const name=candidate===fileId||candidate===mediaKey?undefined:candidate;
 const size=attachmentSize(data.file_size??data.fileSize??data.size),busId=attachmentSize(data.busid??data.bus_id);
 const url=typeof data.url==='string'&&data.url.length<=8192&&/^https?:\/\//i.test(data.url)?data.url:undefined;
 return {kind,position,name,size,fileId,mediaKey,busId,url};
}

export function nativeAttachmentUrl(value:unknown):string|undefined{
 return typeof value==='string'&&value.length<=8192&&/^https?:\/\//i.test(value)?value:undefined;
}
export function inlineAttachment(value:unknown):Buffer|undefined{
 if(typeof value!=='string'||!value)return;
 const raw=value.startsWith('base64://')?value.slice(9):value;
 if(raw.length>Math.ceil(MAX_INLINE_ATTACHMENT_BYTES/3)*4)return;
 if(raw.length%4===1||!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))return;
 const bytes=Buffer.from(raw,'base64');
 if(bytes.length&&bytes.length<=MAX_INLINE_ATTACHMENT_BYTES)return bytes;
}
