import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { QQBot, type QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { startQrConnect } from '@tencent-connect/qqbot-connector';
import type { Message, Transport } from '../types.js';
import { FishError, codeOf } from '../types.js';
import { Store } from '../storage/db.js';
import { safePath, writePrivate } from '../paths.js';

export function normalize(msg:QQBotInboundMessage,appId:string):Message|undefined{
  if(msg.kind!=='group'||!msg.groupOpenid||!msg.messageId||!msg.senderId)return;
  if(!['GROUP_AT_MESSAGE_CREATE','GROUP_MESSAGE_CREATE'].includes(msg.rawEventType))return;
  const marker=new RegExp(`<@!?${appId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}>`,'g');
  const mentioned=msg.rawEventType==='GROUP_AT_MESSAGE_CREATE'||msg.mentions?.some(m=>m.is_you===true)||marker.test(msg.content);
  const at=Date.parse(msg.timestamp);if(!Number.isFinite(at))return;
  return {id:msg.messageId,group:msg.groupOpenid,user:msg.senderId,text:msg.content.replace(marker,'').trim().slice(0,2000),at,
    mentioned:!!mentioned,bot:!!msg.senderIsBot||msg.senderId===appId,event:msg.rawEventType==='GROUP_MESSAGE_CREATE'?'ordinary':'mention'};
}
export class QQTransport implements Transport {
  status='disconnected';private bot:QQBot;private stopped=false;
  constructor(appId:string,secret:string,private store:Store,private inbound:(m:Message)=>Promise<void>,private allowed:(group:string)=>boolean=()=>false){
    this.bot=new QQBot({appId,appSecret:secret,transport:'websocket',markdownSupport:false,
      logger:{debug:()=>{},info:()=>{},warn:()=>this.store.audit('qq-warning','','QQ_SDK_WARNING'),error:()=>this.store.audit('error','','QQ_SDK_ERROR')},
      reconnect:{maxAttempts:8},intents:1<<25});
    this.bot.on('ready',()=>{this.status='connected';this.store.audit('qq','','CONNECTED');});
    this.bot.on('resumed',()=>{this.status='connected';});
    this.bot.on('disconnected',e=>{this.status=e.willReconnect?'reconnecting':'failed';});
    this.bot.on('error',()=>{this.store.audit('error','','QQ_SDK_ERROR');});
    this.bot.on('message',async(_ctx,msg)=>{
      const m=normalize(msg,appId);if(!m||!this.allowed(m.group))return;
      // A received ordinary event is observed capability for THIS group only.
      if(m.event==='ordinary')this.store.setMeta('qqOrdinary:'+m.group,String(Date.now()));
      try{await this.inbound(m);}catch(e){this.store.audit('error',m.group,codeOf(e));}
    });
  }
  start():void{this.status='connecting';void this.bot.start().catch(()=>{if(!this.stopped)this.status='failed';this.store.audit('error','','QQ_CONNECT_FAILED');});}
  private target(m:Message):{scope:'group';targetId:string;msgId:string}{
    // Conservative passive-only window. No silent proactive-send fallback.
    if(Date.now()-m.at>240000||m.at>Date.now()+30000)throw new FishError('QQ_REPLY_WINDOW_EXPIRED');
    this.store.transaction(()=>{
      const count=Number((this.store.db.prepare('SELECT count FROM replies WHERE grp=? AND id=?').get(m.group,m.id) as any)?.count??0);
      if(count>=4)throw new FishError('QQ_REPLY_LIMIT');
      this.store.db.prepare('INSERT INTO replies VALUES (?,?,1,?) ON CONFLICT(grp,id) DO UPDATE SET count=count+1').run(m.group,m.id,m.at);
    });
    return {scope:'group',targetId:m.group,msgId:m.id};
  }
  async send(m:Message,text:string):Promise<void>{
    const receipt=await this.bot.sendText(this.target(m),text);
    this.store.db.prepare('INSERT OR REPLACE INTO cache VALUES (?,?,?)').run(echoKey(m.group,text),Date.now()+120000,'true');
    if(receipt.id)this.store.db.prepare('INSERT OR IGNORE INTO seen VALUES (?,?,?)').run(m.group,receipt.id,Date.now());
  }
  async file(m:Message,p:string):Promise<void>{
    if(p.toLowerCase().endsWith('.png'))await this.bot.sendImage(this.target(m),{localPath:p});
    else await this.bot.sendFile(this.target(m),{localPath:p},{fileName:p.split(/[\\/]/).at(-1)});
  }
  stop():void{this.stopped=true;this.bot.stop();this.status='stopped';}
}
export function echoKey(group:string,text:string):string{return 'echo:'+createHash('sha256').update(group+'\0'+text).digest('hex');}
export class MockTransport implements Transport {
  status='mock';sent:{group:string;text:string}[]=[];files:string[]=[];
  async send(m:Message,text:string):Promise<void>{this.sent.push({group:m.group,text});}
  async file(_m:Message,p:string):Promise<void>{if(!fs.existsSync(p))throw new FishError('FILE_MISSING');this.files.push(p);}
  stop():void{this.status='stopped';}
}
export function credentials(root:string):{appId:string;appSecret:string}|undefined{
  if(process.env.QQBOT_APPID&&process.env.QQBOT_SECRET)return {appId:process.env.QQBOT_APPID,appSecret:process.env.QQBOT_SECRET};
  const p=safePath(root,'runtime/data/qq-credentials.json');
  if(!fs.existsSync(p))return;
  const c=JSON.parse(fs.readFileSync(p,'utf8'));if(typeof c.appId==='string'&&typeof c.appSecret==='string')return c;
}
export async function bind(root:string):Promise<void>{
  const abort=new AbortController();const interrupted=()=>abort.abort();process.once('SIGINT',interrupted);
  try{
    await new Promise<void>((resolve,reject)=>{
      startQrConnect({onSuccess:cs=>{
        if(cs.length!==1){reject(new FishError('QQ_BIND_SELECT_SINGLE_BOT'));return;}
        writePrivate(root,'runtime/data/qq-credentials.json',JSON.stringify({appId:cs[0].appId,appSecret:cs[0].appSecret}));
        console.log('绑定完成，凭据仅保存在 runtime/data/qq-credentials.json');resolve();
      },onFailure:()=>reject(new FishError('QQ_BIND_FAILED'))},{source:'deepseekfish',signal:abort.signal});
    });
  }finally{process.removeListener('SIGINT',interrupted);}
}
