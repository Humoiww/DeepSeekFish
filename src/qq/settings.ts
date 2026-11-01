import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath,writePrivate } from '../paths.js';
import { validateConfig,loadConfig,triggerKeywords,type Config } from '../config.js';
import { FishError,codeOf } from '../types.js';
import { Store } from '../storage/db.js';
import { OneBotTransport,onebotCredential } from './onebot.js';

type QQSettings=Pick<Config,'qqTransport'|'groups'|'admins'|'privateUsers'|'model'|'names'> & {enabled:boolean};
export function readQQSettings(root:string):Partial<QQSettings>{
  const file=safePath(root,'runtime/data/qq-settings.json');
  if(!fs.existsSync(file))return {};
  if(fs.statSync(file).size>32768)throw new FishError('INVALID_QQ_SETTINGS');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['qqTransport','groups','admins','privateUsers','model','names','enabled'].includes(k)))throw new FishError('INVALID_QQ_SETTINGS');
  const config=validateConfig({...loadConfig(root),...value});return {...value,...(value.names!==undefined?{names:config.names}:{})};
}
function saveQQSettings(root:string,settings:Partial<QQSettings>){
  validateConfig({...loadConfig(root),...settings});
  const text=JSON.stringify(settings,null,2)+'\n';if(Buffer.byteLength(text)>32768)throw new FishError('INVALID_QQ_SETTINGS');
  const temporary='runtime/data/qq-settings-'+randomUUID()+'.json';
  try{writePrivate(root,temporary,text);fs.renameSync(safePath(root,temporary),safePath(root,'runtime/data/qq-settings.json'));}
  finally{fs.rmSync(safePath(root,temporary),{force:true});}
}
/** Local operator script: changes only keywords, never accounts/groups or login. */
export function configureGroupKeywords(root:string,keywords:unknown){
  const names=triggerKeywords(keywords);saveQQSettings(root,{...readQQSettings(root),names});
  return {saved:true,keywords:names,mode:'mention-or-keyword'};
}
/** Called only from the authenticated human settings API, never model tools. */
export function configureQQ(root:string,input:Record<string,unknown>,model:string){
  if(!input||Object.keys(input).some(k=>!['enabled','admins','groups','keywords'].includes(k))||typeof input.enabled!=='boolean')throw new FishError('INVALID_QQ_SETTINGS');
  function ids(value:unknown):string[]{
    if(!Array.isArray(value)||value.length>50||value.some(v=>typeof v!=='string'||!/^[1-9]\d{0,19}$/.test(v)))throw new FishError('INVALID_QQ_IDS');
    return [...new Set(value)];
  }
  const admins=ids(input.admins),groups=ids(input.groups);
  if(input.enabled&&!admins.length)throw new FishError('QQ_ADMIN_REQUIRED');
  if(input.enabled)onebotCredential(root);
  const names=triggerKeywords(input.keywords??readQQSettings(root).names??loadConfig(root).names);
  const settings:QQSettings={qqTransport:'onebot',model,names,admins,groups,privateUsers:admins,enabled:input.enabled};
  saveQQSettings(root,settings);
  const flag=safePath(root,'runtime/data/qq-enabled');
  if(input.enabled)writePrivate(root,'runtime/data/qq-enabled','enabled\n');else fs.rmSync(flag,{force:true});
  return {saved:true,enabled:settings.enabled,privateUsers:admins,groups,keywords:names};
}
export async function qqStatus(root:string,store:Store){
  const settings=readQQSettings(root);
  const configured={enabled:settings.enabled===true,admins:settings.admins??[],configuredGroups:settings.groups??[],keywords:settings.names??loadConfig(root).names,groupTrigger:'mention-or-keyword'};
  let transport:OneBotTransport|undefined;
  try{
    transport=new OneBotTransport(root,loadConfig(root).onebotUrl,onebotCredential(root),store,async()=>{},()=>false);
    return {connected:true,...await transport.inspect(),...configured};
  }catch(e){return {connected:false,error:codeOf(e),...configured};}
  finally{transport?.stop();}
}
