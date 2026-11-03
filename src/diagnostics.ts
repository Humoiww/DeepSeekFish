import {FishError,codeOf} from './types.js';
import {redact} from './storage/db.js';

const secret=/^(?:authorization|cookie|set-cookie|password|api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|token|skey|p_skey|rkey)$/i;
/** Private diagnostics retain causes and messages, never credential headers or image bytes. */
export function diagnosticSafe(value:any,depth=0):any{
 if(depth>24)return '[层级过深，已省略]';
 if(typeof value==='string')return redact(value)
  .replace(/data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g,'[图片数据省略]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[凭据省略]')
  .replace(/((?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,'$1[凭据省略]')
  .replace(/([?&](?:rkey|skey|p_skey|access_token|token|signature|sig)=)[^&\s"<>]+/gi,'$1[凭据省略]')
  .replace(/((?:skey|p_skey|rkey|refresh_token|id_token)\s*[=:]\s*)[^\s"'<>;,]+/gi,'$1[凭据省略]')
  .replace(/("(?:api[_-]?key|app[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|password|authorization|cookie)"\s*:\s*")[^"]*/gi,'$1[凭据省略]');
 if(Array.isArray(value))return value.map(v=>diagnosticSafe(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,secret.test(k)?'[凭据省略]':k==='image_url'?{url:'[原图附件，按图库 ID 重新查看]'}:diagnosticSafe(v,depth+1)]));
 return value;
}
export function errorDiagnostic(error:unknown,depth=0,seen=new Set<unknown>()):Record<string,any>{
 if(depth>4||seen.has(error))return {message:'[嵌套异常已省略]'};seen.add(error);
 const e=error as any,out:Record<string,any>={code:codeOf(error),name:typeof e?.name==='string'?e.name:typeof error,message:typeof e?.message==='string'?e.message:String(error)};
 for(const key of ['stack','code','errno','syscall','address','port'])if(['string','number'].includes(typeof e?.[key]))out[key==='code'?'nativeCode':key]=String(e[key]).slice(0,key==='stack'?8000:2000);
 if(e?.diagnostic)out.details=diagnosticSafe(e.diagnostic);
 if(e?.cause)out.cause=errorDiagnostic(e.cause,depth+1,seen);
 if(Array.isArray(e?.errors))out.causes=e.errors.slice(0,5).map((c:any)=>errorDiagnostic(c,depth+1,seen));
 out.message=out.message.slice(0,4000);return diagnosticSafe(out);
}
export class ProviderError extends FishError{
 constructor(code:string,public diagnostic:Record<string,unknown>,cause?:unknown){super(code);if(cause!==undefined)this.cause=cause;}
}
