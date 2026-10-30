import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateOneBotUrl } from '../config.js';
import { safePath } from '../paths.js';
import { Store } from '../storage/db.js';
import { FishError,codeOf,type Message,type Transport } from '../types.js';
import { echoKey } from './adapter.js';
import { verifyPng } from '../image/provider.js';
import { imageMime } from '../memory/people.js';

function id(value:unknown,signed=false):string|undefined{
  if(typeof value==='number'&&!Number.isSafeInteger(value))return;
  if(typeof value!=='number'&&typeof value!=='string')return;
  const s=String(value);return (signed?/^-?\d{1,20}$/:/^[1-9]\d{0,19}$/).test(s)?s:undefined;
}
/** Array messages only. Image handles stay transient until trusted ingestion. */
export function normalizeOneBot(event:any,self:string):Message|undefined{
  if(event?.post_type!=='message'||!['group','private'].includes(event.message_type)||id(event.self_id)!==self||!Array.isArray(event.message)||event.message.length>256)return;
  const user=id(event.user_id),group=event.message_type==='private'&&user?'private:'+user:id(event.group_id),messageId=id(event.message_id,true);
  if(!group||!user||!messageId||user===self||!Number.isSafeInteger(event.time))return;
  let mentioned=event.message_type==='private',text='';const images:NonNullable<Message['images']>=[];
  for(const segment of event.message){
    if(segment?.type==='text'&&typeof segment.data?.text==='string')text+=segment.data.text.slice(0,16000);
    else if(segment?.type==='at'){
      if(id(segment.data?.qq)===self)mentioned=true;
      else text+=' @'+(id(segment.data?.qq)??'全体成员')+' ';
    }else if(segment?.type==='image'){
      if(images.length<4){
        const d=segment.data??{};images.push({stickerHint:Number(d.sub_type)===1,
          ...(typeof d.url==='string'&&d.url.length<=4096?{url:d.url}:{}),
          ...(typeof d.file==='string'&&/^[a-zA-Z0-9_-]{1,128}\.(?:gif|png|jpe?g|webp)$/i.test(d.file)?{file:d.file}:{})});
        text+='[图片 '+images.length+']';
      }else text+='[图片：本条超过4张，未读取]';
    }
    else if(segment?.type==='record')text+='[语音：未转写]';
    else if(segment?.type==='face')text+='[表情]';
    else if(segment?.type==='file')text+='[文件：未读取内容]';
    if(text.length>=16000)break;
  }
  return {id:messageId,group,user,text:text.trim().slice(0,16000),at:event.time*1000,mentioned,event:mentioned?'mention':'ordinary',...(images.length?{images}:{})};
}
export function onebotCredential(root:string):string{
  const file=safePath(root,'runtime/data/onebot-credentials.json');
  const token=process.env.ONEBOT_ACCESS_TOKEN||(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).accessToken:'');
  if(typeof token!=='string'||!token||token.length>512||/[\r\n\0]/.test(token))throw new FishError('ONEBOT_TOKEN_MISSING');
  return token;
}
type Action='get_login_info'|'get_group_list'|'get_status'|'send_group_msg'|'send_private_msg'|'get_stranger_info'|'get_cookies'|'get_image';
type Pending={resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;action:Action;started:number;conversation:string};
const IMAGE_SEND_TIMEOUT_MS=60000;
const IMAGE_RESPONSE_TIMEOUT_MS=75000;
/** Keep provider details out of chat; only fixed diagnostic fields reach the audit. */
export class OneBotActionError extends FishError {
  constructor(public diagnostic:{action:Action;status:string;retcode:number|null;reason:'native_timeout'|'action_rejected';elapsedMs:number}){super(diagnostic.reason==='native_timeout'?'ONEBOT_SEND_UNCONFIRMED':'ONEBOT_ACTION_FAILED');}
}
export class OneBotTransport implements Transport {
  status='disconnected';private socket?:WebSocket;private self='';private stopped=false;
  private retry?:NodeJS.Timeout;private handshake?:NodeJS.Timeout;private heartbeat?:NodeJS.Timeout;private lastSeen=0;
  private pending=new Map<string,Pending>();private ready?:Promise<void>;
  private qzoneAuth?:{value:{cookies:string;bkn:string};expires:number};
  private qzonePending?:Promise<{cookies:string;bkn:string}>;
  constructor(private root:string,private url:string,private token:string,private store:Store,
    private inbound:(m:Message)=>Promise<void>,private allowed:(group:string)=>boolean,
    private connect:(url:string)=>WebSocket=url=>new WebSocket(url)) {validateOneBotUrl(url);}
  start():void{void this.open().catch(()=>{});}
  private open():Promise<void>{
    if(this.stopped)return Promise.reject(new FishError('ONEBOT_STOPPED'));
    if(this.ready)return this.ready;
    this.status='connecting';const url=validateOneBotUrl(this.url);url.searchParams.set('access_token',this.token);
    const ws=this.connect(url.toString());this.socket=ws;
    this.ready=new Promise<void>((resolve,reject)=>{
      let settled=false;
      const fail=()=>{if(!settled){settled=true;reject(new FishError('ONEBOT_CONNECT_FAILED'));}};
      this.handshake=setTimeout(()=>{fail();ws.close();},12000);this.handshake.unref();
      ws.addEventListener('open',()=>{void this.call('get_login_info',{}).then(data=>{
        const self=id(data?.user_id);if(!self)throw new FishError('ONEBOT_LOGIN_INVALID');
        this.self=self;this.lastSeen=Date.now();this.status='connected';clearTimeout(this.handshake);settled=true;
        this.store.audit('qq','','ONEBOT_CONNECTED');resolve();
        this.heartbeat=setInterval(()=>{if(Date.now()-this.lastSeen>90000)ws.close();},30000);this.heartbeat.unref();
      }).catch(()=>{fail();ws.close();});});
      ws.addEventListener('message',e=>{
        if(this.stopped)return;
        if(typeof e.data!=='string'||Buffer.byteLength(e.data)>1048576){ws.close(1009);return;}
        let event:any;try{event=JSON.parse(e.data);}catch{this.store.audit('qq-warning','','ONEBOT_INVALID_JSON');return;}
        this.lastSeen=Date.now();
        if(typeof event?.echo==='string'){
          const pending=this.pending.get(event.echo);if(!pending)return;
          clearTimeout(pending.timer);this.pending.delete(event.echo);
          const elapsedMs=Date.now()-pending.started;
          if(event.status==='ok'&&event.retcode===0){
            if(pending.action==='send_private_msg'||pending.action==='send_group_msg')this.store.audit('qq-send',pending.conversation,JSON.stringify({action:pending.action,status:'ok',retcode:0,elapsedMs,messageId:id(event.data?.message_id,true)??null}));
            pending.resolve(event.data);
          }else{
            // NapCat can reject its API wait after QQ has accepted the upload.
            // Never log the raw response: other actions can contain credentials.
            const diagnostic={action:pending.action,status:['failed','async','ok'].includes(event.status)?event.status:'unknown',retcode:Number.isSafeInteger(event.retcode)?event.retcode:null,
              reason:(/Timeout: NTEvent[^\n]*NodeIKernelMsgService\/sendMsg/i.test(String(event.message??'')+' '+String(event.wording??''))?'native_timeout':'action_rejected') as 'native_timeout'|'action_rejected',elapsedMs};
            this.store.audit('qq-action',pending.conversation,JSON.stringify(diagnostic));
            pending.reject(new OneBotActionError(diagnostic));
          }
          return;
        }
        if(!this.self)return;
        const message=normalizeOneBot(event,this.self);if(!message||!this.allowed(message.group))return;
        if(message.event==='ordinary')this.store.setMeta('qqOrdinary:'+message.group,String(Date.now()));
        this.store.setMeta('onebotLastMessageAt',String(Date.now()));
        void this.inbound(message).catch(e=>this.store.audit('error',message.group,codeOf(e)));
      });
      ws.addEventListener('error',()=>{fail();ws.close();});
      ws.addEventListener('close',()=>{
        fail();clearTimeout(this.handshake);clearInterval(this.heartbeat);this.ready=undefined;this.self='';this.qzoneAuth=undefined;
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new FishError('ONEBOT_DISCONNECTED'));}this.pending.clear();
        this.status=this.stopped?'stopped':'reconnecting';
        if(!this.stopped){this.store.audit('qq-warning','','ONEBOT_DISCONNECTED');this.retry=setTimeout(()=>this.start(),5000);this.retry.unref();}
      });
    });
    return this.ready;
  }
  private call(action:Action,params:Record<string,unknown>,timeoutMs=10000):Promise<any>{
    if(this.socket?.readyState!==1)return Promise.reject(new FishError('ONEBOT_NOT_CONNECTED'));
    if(this.pending.size>=32)return Promise.reject(new FishError('ONEBOT_BUSY'));
    const echo=randomUUID();return new Promise((resolve,reject)=>{
      const started=Date.now(),conversation=action==='send_private_msg'?'private:'+params.user_id:action==='send_group_msg'?String(params.group_id):'';
      const timer=setTimeout(()=>{this.pending.delete(echo);this.store.audit('qq-action',conversation,JSON.stringify({action,reason:'response_timeout',elapsedMs:Date.now()-started}));reject(new FishError('ONEBOT_ACTION_TIMEOUT'));},timeoutMs);timer.unref();
      this.pending.set(echo,{resolve,reject,timer,action,started,conversation});
      try{this.socket!.send(JSON.stringify({action,params,echo}));}catch{clearTimeout(timer);this.pending.delete(echo);reject(new FishError('ONEBOT_SEND_FAILED'));}
    });
  }
  async inspect():Promise<{self:string;groups:{id:string;name:string}[]}>{
    await this.open();const groups=await this.call('get_group_list',{});
    if(!Array.isArray(groups))throw new FishError('ONEBOT_INVALID_GROUP_LIST');
    return {self:this.self,groups:groups.slice(0,1000).filter(g=>id(g.group_id)).map(g=>({id:String(g.group_id),name:String(g.group_name??'').slice(0,128)}))};
  }
  async readPerson(user:string):Promise<any>{
    if(!id(user))throw new FishError('ONEBOT_INVALID_TARGET');await this.open();
    return this.call('get_stranger_info',{user_id:user,no_cache:true});
  }
  async imageUrl(file:string):Promise<string>{
    if(!/^[a-zA-Z0-9_-]{1,128}\.(?:gif|png|jpe?g|webp)$/i.test(file))throw new FishError('QQ_IMAGE_HANDLE_INVALID');
    await this.open();const result=await this.call('get_image',{file});
    if(typeof result?.url!=='string')throw new FishError('QQ_IMAGE_URL_MISSING');return result.url;
  }
  /** Trusted profile module only; never returned by a model-facing tool/API. */
  async qzoneSession():Promise<{cookies:string;bkn:string}>{
    if(this.qzoneAuth&&this.qzoneAuth.expires>Date.now())return this.qzoneAuth.value;
    if(this.qzonePending)return this.qzonePending;
    await this.open();
    if(this.qzonePending)return this.qzonePending;
    this.qzonePending=this.call('get_cookies',{domain:'qzone.qq.com'},45000).then(value=>{this.qzoneAuth={value,expires:Date.now()+300000};return value;}).finally(()=>{this.qzonePending=undefined;});
    return this.qzonePending;
  }
  async send(message:Message,text:string):Promise<void>{
    if(!this.allowed(message.group))throw new FishError('ONEBOT_GROUP_NOT_ALLOWED');
    const target=this.target(message.group);
    const result=await this.call(target.action,{...target.params,message:[{type:'text',data:{text:text.slice(0,4000)}}]});
    this.store.db.prepare('INSERT OR REPLACE INTO cache VALUES (?,?,?)').run(echoKey(message.group,text),Date.now()+120000,'true');
    if(id(result?.message_id,true))this.store.db.prepare('INSERT OR IGNORE INTO seen VALUES (?,?,?)').run(message.group,String(result.message_id),Date.now());
  }
  async file(message:Message,file:string):Promise<void>{
    if(!this.allowed(message.group))throw new FishError('ONEBOT_GROUP_NOT_ALLOWED');
    const base=safePath(this.root,'runtime/outputs'),relative=path.relative(base,file).split(path.sep).join('/');
    const png=verifyPng(base,relative,10485760);
    await this.sendImage(message,fs.readFileSync(png));
  }
  async meme(message:Message,original:Buffer):Promise<void>{
    if(!this.allowed(message.group))throw new FishError('ONEBOT_GROUP_NOT_ALLOWED');
    if(original.length>10485760)throw new FishError('QQ_MEDIA_TOO_LARGE');imageMime(original);
    await this.sendImage(message,original,true);
  }
  private async sendImage(message:Message,original:Buffer,sticker=false):Promise<void>{
    const target=this.target(message.group);
    // NapCat's native send wait defaults to ~10s + size/256KBps, independently
    // of our WebSocket deadline. Override it per image; allow reply overhead.
    const receipt=await this.call(target.action,{...target.params,timeout:IMAGE_SEND_TIMEOUT_MS,
      message:[{type:'image',data:{file:'base64://'+original.toString('base64'),...(sticker?{sub_type:1}:{})}}]},IMAGE_RESPONSE_TIMEOUT_MS);
    if(!id(receipt?.message_id,true))throw new FishError('ONEBOT_SEND_UNCONFIRMED');
  }
  private target(conversation:string):{action:'send_group_msg'|'send_private_msg';params:Record<string,string>}{
    if(conversation.startsWith('private:')){
      const user=id(conversation.slice(8));if(!user)throw new FishError('ONEBOT_INVALID_TARGET');
      return {action:'send_private_msg',params:{user_id:user}};
    }
    const group=id(conversation);if(!group)throw new FishError('ONEBOT_INVALID_TARGET');
    return {action:'send_group_msg',params:{group_id:group}};
  }
  stop():void{
    this.stopped=true;this.self='';this.qzoneAuth=undefined;clearTimeout(this.retry);clearTimeout(this.handshake);clearInterval(this.heartbeat);this.socket?.close();
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new FishError('ONEBOT_STOPPED'));}this.pending.clear();this.status='stopped';
  }
}
