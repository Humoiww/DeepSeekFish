import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDir, noLinks, safePath, writePrivateAtomic } from './paths.js';
import { FishError } from './types.js';

export type ApiProvider='deepseek'|'opencode_go';
export type ConnectionPreset={id:string;name:string;provider:ApiProvider;model:string;maxOutputTokens:number;keySlot:string;disableThinking?:boolean};
export const providerIds=['deepseek','opencode_go'] as const;
export function isProvider(value:unknown):value is ApiProvider {
  return value==='deepseek'||value==='opencode_go';
}
export function validModel(value:unknown):value is string {
  return typeof value==='string'&&/^[a-zA-Z0-9._-]{1,80}$/.test(value);
}
export function validKeySlot(provider:ApiProvider,value:unknown):value is string {
  return typeof value==='string'&&/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value)&&(!isProvider(value)||value===provider);
}
export interface Config {
  enabled: boolean; groups: string[]; admins: string[]; names: string[];
  autonomous: boolean; autoReply: boolean; probability: number; activity: number;
  cooldownMs: number; dailyInterjections: number; windowSize: number; maxChars: number;
  quietHours: number[]; interests: string[]; bufferMs: number; historyHours: number;
  dailyCny: number; groupDailyCny: number; maxOutputTokens: number;
  provider:ApiProvider; usdToCny:number; connectionPresets?:ConnectionPreset[]; activePresetId?:string; keySlot?:string;
  disableThinking?:boolean;
  search: boolean; searchCount: number; searchTimeoutMs: number;
  groupChatSearch:boolean; curiosityPublicSearch:boolean; curiosityAutoSummary:boolean;
  codex: boolean; codexTimeoutMs: number;
  maxFiles: number; maxArtifactBytes: number; images: boolean; imageDaily: number;
  port: number; model: string; qqTransport:'official'|'onebot'; onebotUrl:string; privateUsers:string[];
}
export const defaults: Config = {
  enabled: true, groups: [], admins: [], names: ['肥鱼', 'Deepseek'],
  autonomous: false, autoReply: false, probability: 0.02, activity: 0.5,
  cooldownMs: 480000, dailyInterjections: 12, windowSize: 20, maxChars: 600,
  quietHours: [0, 7], interests: ['AI', '编程', '游戏'], bufferMs: 1200, historyHours: 24,
  dailyCny: 5, groupDailyCny: 0, maxOutputTokens: 256,
  provider:'deepseek',usdToCny:7.2,connectionPresets:[],activePresetId:undefined,keySlot:undefined,disableThinking:true,
  search: false, searchCount: 3, searchTimeoutMs: 10000,
  groupChatSearch:true, curiosityPublicSearch:true, curiosityAutoSummary:true,
  codex: false, codexTimeoutMs: 300000,
  maxFiles: 20, maxArtifactBytes: 10485760, images: false, imageDaily: 20,
  port: 17861, model: 'deepseek-v4-flash', qqTransport:'official', onebotUrl:'ws://127.0.0.1:3001', privateUsers:[],
};
export function validateConfig(input: Record<string, unknown>): Config {
  // Keep existing configuration files readable after removing legacy limits.
  const {searchDaily:_obsolete,dailyTokens:_oldTokens,groupDailyTokens:_oldGroupTokens,
    codexDaily:_oldCodexCount,codexDailyMs:_oldCodexTime,userDailyRequests:_oldRequestLimit,...current}=input;
  input=current;
  const c = { ...defaults, ...input } as Config;
  for (const [k, v] of Object.entries(input)) {
    const optional=k==='activePresetId'||k==='keySlot';
    if (!Object.hasOwn(defaults,k) || (optional?v!==undefined&&typeof v!=='string':typeof v !== typeof defaults[k as keyof Config])) {
      throw new FishError('INVALID_CONFIG_' + k);
    }
  }
  for (const [k, v] of Object.entries(c)) {
    if (typeof v === 'number' && (!Number.isFinite(v) || v < 0 ||
      (!['probability', 'activity','dailyCny','groupDailyCny','usdToCny'].includes(k) && !Number.isInteger(v)))) throw new FishError('INVALID_CONFIG_' + k);
  }
  for (const key of ['groups', 'admins', 'names', 'interests', 'privateUsers'] as const) {
    if (!Array.isArray(c[key]) || !c[key].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) throw new FishError('INVALID_CONFIG_' + key);
  }
  c.names=triggerKeywords(c.names);
  if (!Array.isArray(c.quietHours) || c.quietHours.length !== 2 || !c.quietHours.every(v => Number.isInteger(v) && v >= 0 && v < 24) ||
    c.probability > 1 || c.activity > 1 || c.maxOutputTokens < 1 || c.maxOutputTokens > 4096 ||
    ![c.dailyCny,c.groupDailyCny].every(n=>Number.isSafeInteger(Math.round(n*1e9))) || c.windowSize < 1 || c.windowSize > 100 || c.maxChars < 32 || c.maxChars > 4000 ||
    c.searchCount < 1 || c.searchCount > 5 || c.codexTimeoutMs < 10 || c.codexTimeoutMs > 1800000 ||
    c.port < 1024 || c.port > 65535 || c.historyHours < 1 || c.historyHours > 168 || c.bufferMs > 10000 ||
    !validModel(c.model)||!isProvider(c.provider)||c.usdToCny<=0||c.usdToCny>100||
    c.keySlot!==undefined&&!validKeySlot(c.provider,c.keySlot)) throw new FishError('INVALID_CONFIG');
  const presets=c.connectionPresets;
  if(!Array.isArray(presets)||presets.length>40||presets.some(preset=>!validConnectionPreset(preset))||
    new Set(presets.map(preset=>preset.id)).size!==presets.length||
    c.activePresetId!==undefined&&!presets.some(preset=>preset.id===c.activePresetId))throw new FishError('INVALID_CONNECTION_PRESET');
  if(!['official','onebot'].includes(c.qqTransport))throw new FishError('INVALID_QQ_TRANSPORT');
  if(c.privateUsers.length>50||c.privateUsers.some(id=>!/^[1-9]\d{0,19}$/.test(id)))throw new FishError('INVALID_PRIVATE_USERS');
  validateOneBotUrl(c.onebotUrl);
  return c;
}
export function validConnectionPreset(value:unknown):value is ConnectionPreset {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as ConnectionPreset;
  return Object.keys(v).every(key=>['id','name','provider','model','maxOutputTokens','keySlot','disableThinking'].includes(key))&&
    (v.disableThinking===undefined||typeof v.disableThinking==='boolean')&&
    typeof v.id==='string'&&/^[a-z0-9][a-z0-9_-]{0,47}$/.test(v.id)&&typeof v.name==='string'&&
    v.name.trim().length>0&&v.name.length<=64&&!/[\u0000-\u001f]/.test(v.name)&&isProvider(v.provider)&&
    validModel(v.model)&&Number.isInteger(v.maxOutputTokens)&&v.maxOutputTokens>=1&&v.maxOutputTokens<=4096&&validKeySlot(v.provider,v.keySlot);
}
export function triggerKeywords(value:unknown):string[]{
  if(!Array.isArray(value)||value.length>50||value.some(v=>typeof v!=='string'||!v.trim()||v.trim().length>64||/[\r\n\0]/.test(v)))throw new FishError('INVALID_GROUP_KEYWORDS');
  const seen=new Set<string>();return value.map(v=>v.trim()).filter(v=>{const key=v.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});
}
export function validateOneBotUrl(value:string):URL{
  let url:URL;try{url=new URL(value);}catch{throw new FishError('INVALID_ONEBOT_URL');}
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const tailnet=/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const privateHost=['localhost','127.0.0.1','::1'].includes(host)||!!(tailnet&&Number(tailnet[1])>=64&&Number(tailnet[1])<=127&&Number(tailnet[2])<=255&&Number(tailnet[3])<=255);
  if(value.length>512||!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.protocol==='ws:'&&!privateHost)throw new FishError('INVALID_ONEBOT_URL');
  return url;
}
export function conversationAllowed(config:Config,conversation:string):boolean{
  return config.groups.includes(conversation)||config.qqTransport==='onebot'&&conversation.startsWith('private:')&&config.privateUsers.includes(conversation.slice(8));
}
const providerSecretsFile='runtime/data/webui-secrets.json';
type ProviderSecrets={deepseekKey?:string;opencodeGoKey?:string;namedKeys?:Record<string,string>};
function providerSecrets(root:string):ProviderSecrets {
  const file=safePath(root,providerSecretsFile);
  return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
}
const defaultKeyField={deepseek:'deepseekKey',opencode_go:'opencodeGoKey'} as const;
export function providerCredential(root:string,provider:ApiProvider,keySlot=provider as string):string{
  if(!validKeySlot(provider,keySlot))throw new FishError('INVALID_KEY_SLOT');
  const secrets=providerSecrets(root);
  if(keySlot!==provider){
    const key=secrets.namedKeys?.[provider+':'+keySlot];
    return typeof key==='string'?key:'';
  }
  const key=secrets[defaultKeyField[provider]];
  return typeof key==='string'&&key?key:process.env[provider==='deepseek'?'DEEPSEEK_API_KEY':'OPENCODE_API_KEY']??'';
}
export function providerKeySlots(root:string,provider:ApiProvider){
  const prefix=provider+':';
  return Object.keys(providerSecrets(root).namedKeys??{}).flatMap(name=>{
    const slot=name.startsWith(prefix)?name.slice(prefix.length):undefined;
    return validKeySlot(provider,slot)?[slot]:[];
  });
}
export function saveProviderCredential(root:string,provider:ApiProvider,keySlot:string,key:unknown){
  if(!validKeySlot(provider,keySlot))throw new FishError('INVALID_KEY_SLOT');
  if(typeof key!=='string'||key!==''&&!/^[a-zA-Z0-9_.-]{8,512}$/.test(key))throw new FishError('INVALID_API_KEY');
  if(!key)return;
  const secrets=providerSecrets(root);
  if(keySlot===provider)secrets[defaultKeyField[provider]]=key;
  else {
    const name=provider+':'+keySlot,namedKeys=secrets.namedKeys??{};
    if(!Object.hasOwn(namedKeys,name)&&Object.keys(namedKeys).length>=80)throw new FishError('KEY_SLOT_LIMIT');
    secrets.namedKeys={...namedKeys,[name]:key};
  }
  writePrivateAtomic(root,providerSecretsFile,JSON.stringify(secrets)+'\n');
}
/** Search, Fetch and default vision fallback always use the default DeepSeek key. */
export const deepseekCredential=(root:string)=>providerCredential(root,'deepseek');
export function projectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (path.dirname(dir) !== dir) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p) && JSON.parse(fs.readFileSync(p, 'utf8')).name === 'deepseekfish') return dir;
    dir = path.dirname(dir);
  }
  throw new FishError('PROJECT_ROOT_MISSING');
}
export function prepare(root: string): void {
  noLinks(root);
  if(process.platform!=='win32')process.umask(0o077);
  for (const p of ['runtime/data', 'runtime/logs', 'runtime/cache', 'runtime/tmp', 'runtime/workspace', 'runtime/outputs', 'runtime/codex-home','runtime/memory','runtime/broker']) makeDir(root, p);
  // All application caches/temp are project-owned; never redirect or copy existing credentials.
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = safePath(root, 'runtime/tmp');
  process.env.XDG_CACHE_HOME = safePath(root, 'runtime/cache');
}
export function loadConfig(root: string): Config {
  const p = safePath(root, 'config/local.json');
  return validateConfig(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {});
}
export function loadSecrets(root: string): void {
  const p = safePath(root, '.env');
  if (fs.existsSync(p)) process.loadEnvFile(p);
}
