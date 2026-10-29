import { request } from 'node:http';
import { safePath } from '../paths.js';
import { FishError,type Message } from '../types.js';
import type { ImagePlan } from '../web/images.js';
import { verifyArtifact } from '../codex/verify.js';
import type { Artifact } from '../codex/artifacts.js';

export const qqBrokerSocket=(root:string)=>safePath(root,'runtime/broker/qq.sock');
export class QQImageClient {
  constructor(private root:string){}
  private call(body:unknown,timeout=20000,signal?:AbortSignal):Promise<any>{
    return new Promise((resolve,reject)=>{
      const data=JSON.stringify(body),req=request({socketPath:qqBrokerSocket(this.root),path:'/',method:'POST',signal,
        headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
        let text='';res.on('data',b=>{text+=b;if(text.length>65536)res.destroy();});
        res.on('error',()=>reject(new FishError('QQ_IMAGE_BROKER_UNAVAILABLE')));
        res.on('end',()=>{try{const value=JSON.parse(text);if(res.statusCode!==200)throw new FishError(value.error??'QQ_IMAGE_BROKER_FAILED');resolve(value);}catch(e){reject(e instanceof FishError?e:new FishError('QQ_IMAGE_BROKER_FAILED'));}});
      });
      req.setTimeout(timeout,()=>req.destroy());req.on('error',()=>reject(new FishError('QQ_IMAGE_BROKER_UNAVAILABLE')));req.end(data);
    });
  }
  status(message:Message,signal?:AbortSignal){return this.call({op:'status',conversation:message.group,user:message.user},20000,signal);}
  generate(message:Message,plan:ImagePlan,timeout:number,signal?:AbortSignal){
    return this.call({op:'image',conversation:message.group,user:message.user,messageId:message.id,request:message.text,plan},timeout+45000,signal);
  }
  verifiedImage(id:string,manifest:Artifact,maxBytes:number):string{
    if(!/^[0-9a-f-]{36}$/.test(id)||manifest?.name!=='image.png')throw new FishError('INVALID_IMAGE_MANIFEST');
    const file=safePath(this.root,'runtime/outputs/'+id+'/image.png');verifyArtifact(file,manifest,maxBytes);return file;
  }
}
