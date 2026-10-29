import fs from 'node:fs';
import { safePath,writePrivate } from '../paths.js';
import { validateConfig,loadConfig,type Config } from '../config.js';
import { FishError,codeOf } from '../types.js';
import { Store } from '../storage/db.js';
import { OneBotTransport,onebotCredential } from './onebot.js';

type QQSettings=Pick<Config,'qqTransport'|'groups'|'admins'|'privateUsers'|'model'|'names'> & {enabled:boolean};
export function readQQSettings(root:string):Partial<QQSettings>{
  const file=safePath(root,'runtime/data/qq-settings.json');
  if(!fs.existsSync(file))return {};
  if(fs.statSync(file).size>8192)throw new FishError('INVALID_QQ_SETTINGS');
  const value=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['qqTransport','groups','admins','privateUsers','model','names','enabled'].includes(k)))throw new FishError('INVALID_QQ_SETTINGS');
  validateConfig({...loadConfig(root),...value});return value;
}
/** Called only from the authenticated human settings API, never model tools. */
export function configureQQ(root:string,input:Record<string,unknown>,model:string){
  if(!input||Object.keys(input).some(k=>!['enabled','admins','groups'].includes(k))||typeof input.enabled!=='boolean')throw new FishError('INVALID_QQ_SETTINGS');
  function ids(value:unknown):string[]{
    if(!Array.isArray(value)||value.length>50||value.some(v=>typeof v!=='string'||!/^[1-9]\d{0,19}$/.test(v)))throw new FishError('INVALID_QQ_IDS');
    return [...new Set(value)];
  }
  const admins=ids(input.admins),groups=ids(input.groups);
  if(input.enabled&&!admins.length)throw new FishError('QQ_ADMIN_REQUIRED');
  if(input.enabled)onebotCredential(root);
  const settings:QQSettings={qqTransport:'onebot',model,names:['鲸酱','小鱼','DeepSeekFish'],admins,groups,privateUsers:admins,enabled:input.enabled};
  validateConfig({...loadConfig(root),...settings});
  writePrivate(root,'runtime/data/qq-settings.json',JSON.stringify(settings,null,2)+'\n');
  const flag=safePath(root,'runtime/data/qq-enabled');
  if(input.enabled)writePrivate(root,'runtime/data/qq-enabled','enabled\n');else fs.rmSync(flag,{force:true});
  return {saved:true,enabled:settings.enabled,privateUsers:admins,groups};
}
export async function qqStatus(root:string,store:Store){
  const settings=readQQSettings(root);
  let transport:OneBotTransport|undefined;
  try{
    transport=new OneBotTransport(root,loadConfig(root).onebotUrl,onebotCredential(root),store,async()=>{},()=>false);
    return {connected:true,...await transport.inspect(),enabled:settings.enabled===true,admins:settings.admins??[],configuredGroups:settings.groups??[]};
  }catch(e){return {connected:false,error:codeOf(e),enabled:settings.enabled===true,admins:settings.admins??[],configuredGroups:settings.groups??[]};}
  finally{transport?.stop();}
}
