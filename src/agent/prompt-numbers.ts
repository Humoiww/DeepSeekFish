import {ProviderError} from '../diagnostics.js';
import {FishError,type ChatMessage} from '../types.js';
import type {Config} from '../config.js';
import type {Store} from '../storage/db.js';

export const promptNumberError='PROMPT_NUMBER_BLOCKED';
const retry='本次未执行。内容含有会话中识别到的私密账号号码。请去掉该号码或改用称呼，再重新编辑并调用。';
const longDigits=/[0-9]{5,}/g;
const decode=(text:string)=>text.replace(/(?:%[0-9a-f]{2})+/gi,part=>{try{return decodeURIComponent(part);}catch{return part;}}).normalize('NFKC');
const numbers=(text:string)=>decode(text).matchAll(longDigits);
const webLink=/https?:\/\/[^\s<>"'\x60，。！；：、？（）【】]+/gi;

const identityText=/(?:\[(?:(?:回复|收件人)\s*)?QQ\s+|(?:^|[^a-z0-9_])(?:private:|(?:QQ\s*(?:账号|号码|号)?|群号|微信号|手机号)\s*[:：=]\s*)|"(?:(?:qq(?:Number|Id)?|peerQQ|speaker|owner|recipient|forwardedBy|sender|replyTo|userQQ|groupQQ))"\s*:\s*"?)\s*([0-9]{5,})(?!\d)/gimu;
const qqToolResults = new Set(['recall_chat','read_forward','get_qzone','get_person','list_conversations','search_memory','read_memory']);

export function privateQQNumbers(config:Pick<Config,'admins'|'privateUsers'|'groups'>,...accounts:(string|undefined)[]){
 return [...config.admins,...config.privateUsers,...config.groups,...accounts];
}

// Only text delivered to a person or posted to a platform belongs here.
// Planning, consultation, drafts and identifiers used for routing stay local
// to the tool's own validation.
const publicationFields:Record<string,readonly string[]>={
 reply:['text'],
 request_development:['reply'],
 activity_chain_start:['reply'],
 send_message:['text'],
 apply_tieba_moderator:['declaration'],
 publish_tieba:['title','content'],
 publish_qzone:['text'],
};

export function isPromptNumberBlocked(error:unknown){
 return error instanceof FishError&&error.code===promptNumberError;
}

export class PromptNumberGuard{
 private index?:Set<string>;
 private linkMatches=new Map<string,boolean>();
 constructor(
  private readonly messages:readonly ChatMessage[],
  private readonly store:Store,
  private readonly enabled=true,
  private readonly accounts:readonly (string|undefined)[]=[]
 ){}

 private has(number:string){
  if(!this.index){
   this.index=new Set();
   for(const account of this.accounts){
    const normalized=decode(account??'').replace(/^(?:private|group):/,'');
    if(/^[0-9]{5,}$/.test(normalized))this.index.add(normalized);
   }
   const tools=new Map<string,string>();
   for(const message of this.messages){
    for(const call of message.tool_calls??[])tools.set(call.id,call.function.name);
    if(message.role==='tool'&&!qqToolResults.has(tools.get(message.tool_call_id??'')??''))continue;
    const texts=typeof message.content==='string'?[message.content]:message.content.flatMap(part=>part.type==='text'?[part.text]:[]);
    for(const text of texts){
     const decoded=decode(text);
     for(const match of decoded.matchAll(identityText))this.index.add(match[1]);
     for(const match of decoded.matchAll(/(?:"(?:actor|conversation)"\s*:\s*"(?:private:)?|"(?:id|group)"\s*:\s*"group:)(\d{5,})/g))this.index.add(match[1]);
     for(const match of decoded.matchAll(/"qqIdentity"\s*:\s*(?:"(\d{5,})"|\{[^{}]*?"self"\s*:\s*"?(\d{5,}))/g)){
      this.index.add(match[1]??match[2]);
     }
    }
   }
  }
  return this.index.has(number);
 }
 private numberIn(text:string){
  for(const match of numbers(text))if(this.has(match[0]))return true;
  return false;
 }
 private knownLink(value:string){
  let url:URL;try{url=new URL(value);}catch{return false;}
  const key=url.href,cached=this.linkMatches.get(key);if(cached!==undefined)return cached;
  const known=!!this.store.db.prepare('SELECT 1 FROM exploration_public_links WHERE url=?').get(key);
  this.linkMatches.set(key,known);return known;
 }
 private matches(value:unknown):boolean{
  if(typeof value==='number')return this.numberIn(String(value));
  if(typeof value==='string'){
   if(!this.numberIn(value))return false;
   const text=value.replace(webLink,raw=>{
    if(!this.numberIn(raw))return raw;
    if(this.knownLink(raw))return ' ';
    const clean=raw.replace(/[)\].,!?;]+$/,'');
    return clean!==raw&&this.knownLink(clean)?' '+raw.slice(clean.length):raw;
   });
   return this.numberIn(text);
  }
  if(Array.isArray(value))return value.some(item=>this.matches(item));
  return value!==null&&typeof value==='object'&&Object.entries(value).some(([key,item])=>this.matches(key)||this.matches(item));
 }
 private block(field:string):never{
  throw new ProviderError(promptNumberError,{stage:'prompt_number_check',field,reason:retry,requestSent:false,submissionStatus:'not_submitted',deliveryStatus:'failed'});
 }
 text(output:string){
  if(this.enabled&&this.matches(output))this.block('text');
 }
 publication(name:string,args:unknown){
  if(!this.enabled||!Object.hasOwn(publicationFields,name)||!args||typeof args!=='object'||Array.isArray(args))return;
  const values=args as Record<string,unknown>;
  for(const field of publicationFields[name]){
   if(this.matches(values[field]))this.block(field);
  }
 }
}
