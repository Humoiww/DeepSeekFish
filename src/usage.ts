import type {Usage} from './types.js';

const tokens=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
/** Optional cache telemetry must never change settlement or reject a valid completion. */
export function inputCache(input:number,hit:unknown,miss:unknown):Pick<Usage,'cachedInput'|'uncachedInput'>{
  if(!tokens(input)||hit==null&&miss==null)return {};
  if(hit!=null&&!tokens(hit)||miss!=null&&!tokens(miss))return {};
  const cachedInput=hit==null?input-(miss as number):hit as number;
  const uncachedInput=miss==null?input-cachedInput:miss as number;
  if(!tokens(cachedInput)||!tokens(uncachedInput)||cachedInput+uncachedInput!==input)return {};
  return {cachedInput,uncachedInput};
}
export function deepSeekUsage(raw:any):Usage|undefined{
  if(!tokens(raw?.prompt_tokens)||!tokens(raw?.completion_tokens))return;
  return {input:raw.prompt_tokens,output:raw.completion_tokens,...inputCache(raw.prompt_tokens,raw.prompt_cache_hit_tokens??raw.prompt_tokens_details?.cached_tokens,raw.prompt_cache_miss_tokens)};
}
