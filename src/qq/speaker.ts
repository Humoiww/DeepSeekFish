import {createHash} from 'node:crypto';

export type QQSpeakers={self?:string;contact?:string};

export function qqSpeakerLabel(account:string|undefined,name:string|undefined,voices:QQSpeakers={}):string{
  if(account==='DeepSeekFish'||account&&account===voices.self)return '肥鱼';
  if(account&&account===voices.contact)return name?'私聊对方（'+name+'）':'私聊对方';
  if(!account)return name?name+'（账号未确认）':'发言人未确认';
  return name||'QQ 发言人 '+createHash('sha256').update(account).digest('hex').slice(0,6);
}
