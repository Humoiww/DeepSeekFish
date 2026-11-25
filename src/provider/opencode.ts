import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {validModel,validKeySlot,providerCredential} from '../config.js';
import {safePath,writePrivateAtomic} from '../paths.js';
import {FishError,codeOf} from '../types.js';
import {boundedJson} from './http.js';

export const openCodeChatUrl='https://opencode.ai/zen/go/v1/chat/completions';
export const openCodeModelsUrl='https://opencode.ai/zen/go/v1/models';
const currentModelsUrl='https://opencode.ai/inference/go/v1/models';
const metadataUrl='https://models.dev/api.json';
const ttl=30*60_000;
const refreshDelay=10_000;
const cacheVersion=2;

type DisableThinkingParam='reasoning_effort_none'|'enable_thinking_false'|'thinking_disabled';
type ThinkingCapability=
 |{disableThinkingSupport:'supported';disableThinkingParam:DisableThinkingParam;disableThinkingReason?:never}
 |{disableThinkingSupport:'unsupported'|'unknown';disableThinkingParam?:never;disableThinkingReason:string};
const verifiedThinkingParams=new Map<string,DisableThinkingParam>([
 ['glm-5.3','reasoning_effort_none'],['glm-5.3-flash','reasoning_effort_none'],['mimo-v2.6-flash','reasoning_effort_none'],
 ['qwen3.8-flash','enable_thinking_false'],['qwen4-max','enable_thinking_false'],
 ['qwen3.8-max','enable_thinking_false'],['qwen3.7-plus','enable_thinking_false'],
 ['minimax-m3','thinking_disabled'],['deepseek-v4-pro','thinking_disabled'],['deepseek-v4.1-flash','thinking_disabled'],
 ['kimi-k3','thinking_disabled'],['kimi-k3.1-pro','thinking_disabled'],['mimo-v2.6-pro','thinking_disabled'],
]);
const noThinkingOverride=new Map([
 ['minimax-m3.1-flash','无法关闭思考：实测关闭参数无效'],
 ['kimi-k2.7-code','无法关闭思考：上游强制开启，关闭会报 400'],
 // The live ID uses hyphens. Retain the dotted spelling for older custom configurations.
 ['claude-haiku-5-5','无法关闭思考：Chat Completions 路线拒绝关闭'],
 ['claude-haiku-5.5','无法关闭思考：Chat Completions 路线拒绝关闭'],
]);

export function openCodeThinkingCapability(model:string):ThinkingCapability {
 const id=model.toLowerCase();
 const param=verifiedThinkingParams.get(id);
 if(param)return {disableThinkingSupport:'supported',disableThinkingParam:param};
 const reason=noThinkingOverride.get(id);
 return reason?{disableThinkingSupport:'unsupported',disableThinkingReason:reason}:
  {disableThinkingSupport:'unknown',disableThinkingReason:'未实测关闭思考，暂按默认运行'};
}

const thinkingDisabledPayload={
 reasoning_effort_none:{reasoning_effort:'none'},
 enable_thinking_false:{enable_thinking:false},
 thinking_disabled:{thinking:{type:'disabled'}},
} as const;

export function openCodeThinkingOverride(model:string,disableThinking?:boolean){
 if(disableThinking===false)return undefined;
 const param=openCodeThinkingCapability(model).disableThinkingParam;
 return param===undefined?undefined:thinkingDisabledPayload[param];
}

// The Go gateway translates these native Messages models on the Chat Completions route.
const translatedChatModels=new Set(['minimax-m3','qwen3.8-flash','qwen4-max','qwen3.8-max','qwen3.7-plus','claude-haiku-5-5','claude-haiku-5.5']);
const selectableChat=(row:Record<string,any>)=>validModel(row.id)&&(!row.type||row.type==='chat')&&row.id.toLowerCase()!=='glm-5.2';

export type OpenCodeModelInfo=ThinkingCapability&{
 id:string;name:string;supportsTools:boolean;supportsVision:boolean;contextLimit?:number;outputLimit?:number;
 inputUsdPerMillion?:number;outputUsdPerMillion?:number;cacheReadUsdPerMillion?:number;maxPriceMultiplier?:number;
 pricingSource:'catalog'|'fallback';
};
type Catalog={updatedAt:number;source:'opencode_go'|'models.dev'|'mock';models:OpenCodeModelInfo[]};
type Cache={version:number;fingerprint:string;catalog:Catalog};
type Result=Catalog&{stale:boolean;error?:string};
const mockCatalog:OpenCodeModelInfo[]=[
 {id:'glm-5.3-flash',name:'GLM-5.3-Flash (Mock)',supportsTools:true,supportsVision:true,contextLimit:1000000,outputLimit:32768,
  inputUsdPerMillion:0.15,outputUsdPerMillion:0.5,cacheReadUsdPerMillion:0.03,pricingSource:'catalog',...openCodeThinkingCapability('glm-5.3-flash')},
 {id:'kimi-k2.6',name:'Kimi K2.6 (Mock)',supportsTools:true,supportsVision:false,contextLimit:262144,outputLimit:32768,
  inputUsdPerMillion:0.95,outputUsdPerMillion:4,cacheReadUsdPerMillion:0.16,pricingSource:'catalog',...openCodeThinkingCapability('kimi-k2.6')},
];
const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1000?value:undefined;
const limit=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:undefined;
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
export const mockProviderMode=()=>/^(1|true)$/i.test(process.env.DEEPSEEK_MOCK??'');

function details(row:Record<string,any>):OpenCodeModelInfo {
 const cost=object(row.cost),rates=object(cost.text),input=object(rates.input);
 const inputUsdPerMillion=numeric(input.price??cost.input),outputUsdPerMillion=numeric(rates.output?.price??cost.output);
 const multipliers=Array.isArray(cost.multipliers)?cost.multipliers.map(m=>numeric(m?.factor)??1):[];
 const maxPriceMultiplier=Math.max(1,...multipliers);
 const media=Array.isArray(row.modalities?.input)?row.modalities.input:[];
 return {id:row.id,name:typeof row.name==='string'?row.name.slice(0,120):row.id,...openCodeThinkingCapability(row.id),
  supportsTools:(row.capabilities?.tools?.supported??row.tool_call)===true,
  supportsVision:media.some((type:unknown)=>typeof type==='string'&&/^image(?:\/|$)/.test(type))||row.vision===true,
  contextLimit:limit(row.limit?.context),outputLimit:limit(row.limit?.output),
  inputUsdPerMillion,outputUsdPerMillion,cacheReadUsdPerMillion:numeric(input.cache?.read??cost.cache_read),
  maxPriceMultiplier:maxPriceMultiplier>1?maxPriceMultiplier:undefined,
  pricingSource:inputUsdPerMillion===undefined||outputUsdPerMillion===undefined?'fallback':'catalog'};
}

/** Only use Go metadata and an affirmative Chat Completions protocol match. */
export function modelsDevGo(value:unknown){
 const provider=object(object(value)['opencode-go']);
 return Object.values(object(provider.models)).flatMap(raw=>{
  const row=object(raw),adapter=row.provider?.npm??provider.npm,path=row.provider?.api??provider.api;
  const compatible=Object.hasOwn(object(row.api),'chat-completions')||
   !row.api&&adapter==='@ai-sdk/openai-compatible'&&
   typeof path==='string'&&/^https:\/\/opencode\.ai\/(?:zen\/go\/v1|inference\/go\/openai\/v1)\/?$/.test(path);
  return selectableChat(row)&&(compatible||translatedChatModels.has(row.id.toLowerCase()))?[details(row)]:[];
 });
}

export function openCodeModelList(value:unknown,metadata:OpenCodeModelInfo[]=[]){
 const data=object(value).data;
 if(!Array.isArray(data))return [];
 const known=new Map(metadata.map(info=>[info.id.toLowerCase(),info]));
 const result=new Map<string,OpenCodeModelInfo>();
 for(const raw of data){
  const row=object(raw);
  if(!selectableChat(row))continue;
  const id=row.id.toLowerCase(),backup=known.get(id);
  if(!row.api&&backup){
   result.set(id,{...backup,id:row.id});
   continue;
  }
  if(!Object.hasOwn(object(row.api),'chat-completions')&&!translatedChatModels.has(id))continue;
  const info=details(row);
  if(backup){
   info.inputUsdPerMillion??=backup.inputUsdPerMillion;
   info.outputUsdPerMillion??=backup.outputUsdPerMillion;
   info.cacheReadUsdPerMillion??=backup.cacheReadUsdPerMillion;
   info.contextLimit??=backup.contextLimit;
   info.outputLimit??=backup.outputLimit;
   info.pricingSource=info.inputUsdPerMillion===undefined||info.outputUsdPerMillion===undefined?'fallback':'catalog';
  }
  result.set(id,info);
 }
 return [...result.values()];
}

export class OpenCodeCatalog {
 private memory=new Map<string,Cache>();
 private flights=new Map<string,Promise<Result>>();
 private attempts=new Map<string,number>();
 constructor(private root:string,private mock:boolean,private http:typeof fetch=fetch,private now=Date.now){}

 private file(scope:string){return 'runtime/cache/opencode-models-'+scope+'.json';}
 private read(scope:string,fingerprint:string){
  let value=this.memory.get(scope);
  try{
   const file=safePath(this.root,this.file(scope));
   const stat=fs.statSync(file,{throwIfNoEntry:false});
   if(stat&&stat.size<256*1024&&(!value||value.fingerprint!==fingerprint||stat.mtimeMs>=value.catalog.updatedAt)){
    const disk=JSON.parse(fs.readFileSync(file,'utf8')) as Cache;
    if(disk.version===cacheVersion&&disk.fingerprint===fingerprint&&Array.isArray(disk.catalog?.models)&&Number.isFinite(disk.catalog.updatedAt)){
     value=disk;
     this.memory.set(scope,disk);
    }
   }
  }catch{/* A missing or unreadable cache can be refreshed. */}
  return value?.fingerprint===fingerprint?value.catalog:undefined;
 }

 private locate(keySlot?:string){
  if(keySlot!==undefined&&!validKeySlot('opencode_go',keySlot))throw new FishError('INVALID_KEY_SLOT');
  const key=keySlot===undefined?'':providerCredential(this.root,'opencode_go',keySlot);
  return {key,scope:key?'slot-'+keySlot:'public',fingerprint:key?createHash('sha256').update(key).digest('hex'):'public'};
 }

 peek(keySlot?:string){
  if(this.mock||mockProviderMode())return mockCatalog;
  const {scope,fingerprint}=this.locate(keySlot);
  return this.read(scope,fingerprint)?.models??[];
 }

 async get(keySlot?:string,force=false):Promise<Result> {
  if(this.mock||mockProviderMode())return {models:mockCatalog,updatedAt:this.now(),source:'mock',stale:false};
  const {key,scope,fingerprint}=this.locate(keySlot);
  const cached=this.read(scope,fingerprint),now=this.now();
  const flightKey=scope+':'+fingerprint;
  const flight=this.flights.get(flightKey);
  if(flight)return flight;
  if(cached&&!force&&now-cached.updatedAt<ttl)return {...cached,stale:false};
  if(now-(this.attempts.get(scope)??-Infinity)<refreshDelay){
   if(cached)return {...cached,stale:now-cached.updatedAt>=ttl};
   throw new FishError('OPENCODE_MODELS_REFRESH_WAIT');
  }
  this.attempts.set(scope,now);
  const request=this.refresh(key).then(catalog=>{
   const entry={version:cacheVersion,fingerprint,catalog};
   this.memory.set(scope,entry);
   try{writePrivateAtomic(this.root,this.file(scope),JSON.stringify(entry));}catch{/* Memory cache stays usable. */}
   return {...catalog,stale:false};
  }).catch(error=>{
   if(cached)return {...cached,stale:true,error:codeOf(error)};
   throw error;
  }).finally(()=>this.flights.delete(flightKey));
  this.flights.set(flightKey,request);
  return request;
 }

 private async refresh(key:string):Promise<Catalog>{
  let raw:unknown,models:OpenCodeModelInfo[]=[],source:Catalog['source']='opencode_go';
  let lastError='OPENCODE_MODELS_UNAVAILABLE';
  for(const endpoint of [openCodeModelsUrl,currentModelsUrl]){
   try{
    const response=await this.http(endpoint,{headers:{'user-agent':'DeepSeekFish/0.1',...(key?{authorization:'Bearer '+key}:{})},
     redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok){
     await response.body?.cancel().catch(()=>{});
     lastError='OPENCODE_HTTP_'+response.status;
     if(response.status===401||response.status===403||response.status===429)throw new FishError(lastError);
     continue;
    }
    raw=await boundedJson(response,2*1024*1024);
    models=openCodeModelList(raw);
    break;
   }catch(error){
    if(error instanceof FishError&&/^OPENCODE_HTTP_(401|403|429)$/.test(error.code))throw error;
   }
  }
  const rows=object(raw).data;
  const incomplete=Array.isArray(rows)&&rows.some(row=>!object(row).api);
  if(!models.length||incomplete||models.some(model=>model.pricingSource==='fallback')){
   try{
    const response=await this.http(metadataUrl,{redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw new FishError('OPENCODE_MODELS_UNAVAILABLE');}
    const metadata=modelsDevGo(await boundedJson(response,12*1024*1024));
    if(Array.isArray(rows))models=openCodeModelList(raw,metadata);
    else {models=metadata;source='models.dev';}
   }catch{/* The live Go models can be used with estimated prices. */}
  }
  if(!models.length)throw new FishError(lastError);
  return {updatedAt:this.now(),source,models:models.slice(0,250)};
 }
}
