import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import {createWriteStream} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {publicUrl} from '../search/provider.js';
import {publicAddress} from '../search/public-web.js';
import {FishError,codeOf} from '../types.js';
import {ProviderError} from '../diagnostics.js';
import type {AttachmentSource} from './attachment-handle.js';

export function qqAttachmentCdn(raw:string):boolean{
 if(!publicUrl(raw))return false;
 const host=new URL(raw).hostname.toLowerCase().replace(/\.$/,'');
 return ['qq.com','qq.com.cn','qpic.cn','weiyun.com','gtimg.cn','idqqimg.com'].some(domain=>host===domain||host.endsWith('.'+domain));
}

async function responseFor(raw:string,limit:number,signal:AbortSignal){
 for(let hop=0;hop<5;hop++){
  signal.throwIfAborted();
  if(raw.length>8192||!publicUrl(raw))throw new FishError('QQ_ATTACHMENT_URL_DENIED');
  const url=new URL(raw);url.hash='';
  const addresses=await new Promise<{address:string;family:number}[]>((resolve,reject)=>{
   const abort=()=>reject(signal.reason);
   signal.addEventListener('abort',abort,{once:true});
   dns.lookup(url.hostname,{all:true}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
  signal.throwIfAborted();
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new FishError('QQ_ATTACHMENT_URL_DENIED');
  const address=addresses.find(item=>item.family===4)??addresses[0];
  const get=url.protocol==='https:'?https.get:http.get;
  const response=await new Promise<http.IncomingMessage>((resolve,reject)=>{
   const req=get(url,{agent:false,signal,headers:{Accept:'*/*','Accept-Encoding':'identity'},
    lookup:(_host,options,callback)=>{
     if(options.all)callback(null,[address]);
     else callback(null,address.address,address.family);
    }},resolve);
   req.on('error',reject);
  });
  const status=response.statusCode??0,location=response.headers.location;
  if([301,302,303,307,308].includes(status)&&location){
   response.destroy();
   let next:URL;
   try{next=new URL(location,url);}catch{throw new FishError('QQ_ATTACHMENT_URL_DENIED');}
   if(url.protocol==='https:'&&next.protocol!=='https:')throw new FishError('QQ_ATTACHMENT_URL_DENIED');
   raw=next.href;continue;
  }
  if(status!==200){response.destroy();throw new ProviderError('QQ_ATTACHMENT_HTTP_'+status,{httpStatus:status});}
  if(Number(response.headers['content-length'])>limit){response.destroy();throw new FishError('QQ_ATTACHMENT_TOO_LARGE');}
  if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){
   response.destroy();throw new FishError('QQ_ATTACHMENT_ENCODING_UNSUPPORTED');
  }
  return response;
 }
 throw new FishError('QQ_ATTACHMENT_REDIRECT_LIMIT');
}

/** Stream original bytes into a locally generated path. URL details are never returned in receipts. */
export async function copyQQAttachment(source:AttachmentSource,target:string,limit:number,signal:AbortSignal){
 const timeout=AbortSignal.timeout(90000),joined=AbortSignal.any([signal,timeout]);let bytes=0;
 try{
  joined.throwIfAborted();
  const response='url' in source?await responseFor(source.url,limit,joined):undefined;
  const mime=response?.headers['content-type']?.split(';')[0].trim().toLowerCase();
  const input=response??Readable.from(['bytes' in source?source.bytes:Buffer.alloc(0)]);
  const bound=new Transform({transform(chunk:Buffer,_encoding,done){
   bytes+=chunk.length;
   if(bytes>limit)done(new FishError('QQ_ATTACHMENT_TOO_LARGE'));
   else done(null,chunk);
  }});
  await pipeline(input,bound,createWriteStream(target,{mode:0o600,flags:'wx'}),{signal:joined});
  return {bytes,mime:mime&&/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)?mime:null};
 }catch(e){
  signal.throwIfAborted();
  if(timeout.aborted)throw new FishError('QQ_ATTACHMENT_DOWNLOAD_TIMEOUT');
  if(e instanceof FishError)throw e;
  // Exceptions from HTTP/URL code can carry a signed URL or request internals.
  const nativeCode=(e as NodeJS.ErrnoException)?.code;
  throw new ProviderError('QQ_ATTACHMENT_DOWNLOAD_FAILED',{reason:codeOf(e),...(/^[A-Z0-9_]{1,55}$/.test(nativeCode??'')?{nativeCode}:{})});
 }
}
