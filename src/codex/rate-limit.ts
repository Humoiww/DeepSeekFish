import { FishError } from '../types.js';

export class CodexRateLimitError extends FishError{
  constructor(public retryAt?:number){super('CODEX_RATE_LIMITED');}
}
/** Use structured server fields only. Never persist raw provider messages. */
export function rateLimitFailure(value:unknown,now=Date.now()):CodexRateLimitError|undefined{
  let limited=false,retryAt:number|undefined;
  function walk(v:any,depth:number){
    if(!v||typeof v!=='object'||depth>4)return;
    for(const [key,item] of Object.entries(v)){
      if(['httpStatusCode','statusCode','status'].includes(key)&&item===429||key==='codexErrorInfo'&&['rateLimitExceeded','usageLimitExceeded'].includes(String(item)))limited=true;
      if(typeof item==='number'&&Number.isFinite(item)&&item>=0){
        const at=key==='retryAfterSeconds'?now+item*1000:key==='retryAfterMs'?now+item:key==='retryAt'?item*1000:0;
        if(at>=now&&at<=now+31*86400000)retryAt=Math.max(retryAt??0,at);
      }
      if(item&&typeof item==='object')walk(item,depth+1);
    }
  }
  walk(value,0);return limited?new CodexRateLimitError(retryAt):undefined;
}
