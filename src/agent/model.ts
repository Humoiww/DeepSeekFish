import type { ChatMessage, Model, ModelResult,CompletionOptions } from '../types.js';
import { FishError,type Usage } from '../types.js';
import { Ledger,BudgetError } from '../budget/ledger.js';
import type { Config } from '../config.js';
import { redact } from '../storage/db.js';
import { recordPrompt } from '../prompt-record.js';
import { knowledgeTokens } from '../memory/knowledge.js';
import { deepSeekUsage } from '../usage.js';
import {ProviderError,diagnosticSafe} from '../diagnostics.js';
export const modelPayload=(cfg:Config,messages:ChatMessage[],maxTokens:number,options:CompletionOptions={})=>({model:cfg.model,messages,max_tokens:maxTokens,stream:false,thinking:{type:'disabled'},
  ...(options.tools?.length?{tools:options.tools,tool_choice:options.final?'none':options.toolChoice?{type:'function',function:{name:options.toolChoice}}:options.requireTool?'required':'auto'}:{})});

export function messageText(message:ChatMessage):string{return typeof message.content==='string'?message.content:message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');}
export function inputBound(messages:ChatMessage[],tools:CompletionOptions['tools']=[]):number{
  let imageTokens=0;
  const text=messages.map(m=>({...m,content:typeof m.content==='string'?m.content:m.content.map(p=>{
    if(p.type==='text')return p;
    // DeepSeek documents a maximum of 1024 input tokens per image. Base64 is
    // transport encoding, not text tokens: counting it blocks ordinary vision.
    imageTokens+=1024;return {type:'image_url',image_url:{url:'[image]',detail:p.image_url.detail}};
  })}));
  // Use the pinned official tokenizer, plus framing/template margin. Counting
  // Chinese UTF-8 bytes as tokens caused otherwise affordable turns to fail.
  const encoded=JSON.stringify({messages:text,tools});
  let tokens:number;try{tokens=Math.ceil(knowledgeTokens(encoded)*1.25);}catch{tokens=Buffer.byteLength(encoded,'utf8');}
  return tokens+4096+messages.length*32+(tools?.length??0)*64+imageTokens;
}

/** Bounded JSON reader: limit applies during streaming, not only after allocation. */
export async function boundedJson(response: Response, limit=1048576): Promise<any> {
  if (!response.body) throw new FishError('EMPTY_RESPONSE');
  const reader=response.body.getReader(); const chunks: Uint8Array[]=[]; let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if (done) break;
      size+=value.byteLength; if(size>limit) throw new FishError('RESPONSE_TOO_LARGE'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(()=>{}); }
}
export class ModelResponseError extends FishError {
  constructor(code:string,public usage:Usage|undefined,public diagnostic:Record<string,unknown>){super(code);}
}
async function errorBody(response:Response){
  if(!response.body)return null;
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,truncated=false;
  try{for(;;){const part=await reader.read();if(part.done)break;const remaining=8192-size;chunks.push(part.value.subarray(0,remaining));size+=Math.min(part.value.length,remaining);if(part.value.length>remaining||size===8192){truncated=true;break;}}}
  finally{await reader.cancel().catch(()=>{});}
  const text=Buffer.concat(chunks).toString('utf8');if(truncated)return {text,truncated:true};try{return JSON.parse(text);}catch{return {text};}
}
/** Shared provider transport; HTTP errors, timeouts and network causes stay distinguishable. */
export async function deepSeekRequest(http:typeof fetch,key:string,payload:unknown,signal?:AbortSignal){
  const started=Date.now(),timeoutMs=30000,endpoint='https://api.deepseek.com/chat/completions';
  const timeout=AbortSignal.timeout(timeoutMs),joined=AbortSignal.any([timeout,...(signal?[signal]:[])]);
  let phase='request',status:number|undefined,requestId:string|undefined;
  try{
    const res=await http(endpoint,{method:'POST',redirect:'error',signal:joined,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(payload)});
    phase='response_body';status=res.status;requestId=res.headers.get('x-request-id')??res.headers.get('request-id')??undefined;
    if(!res.ok){
      let body:unknown;try{body=await errorBody(res);}catch(e){body={unavailable:true,reason:e instanceof Error?e.message:String(e)};}
      throw new ProviderError('DEEPSEEK_HTTP_'+res.status,diagnosticSafe({endpoint,httpStatus:status,requestId,elapsedMs:Date.now()-started,phase,provider:body}));
    }
    return await boundedJson(res);
  }catch(e){
    if(e instanceof ProviderError)throw e;
    const details={endpoint,httpStatus:status,requestId,phase,elapsedMs:Date.now()-started,timeoutMs};
    if(timeout.aborted||(e as any)?.name==='TimeoutError')throw new ProviderError('DEEPSEEK_TIMEOUT',details,e);
    if(signal?.aborted||(e as any)?.name==='AbortError')throw new ProviderError('DEEPSEEK_CANCELLED',details,e);
    if(e instanceof FishError)throw new ProviderError(e.code,details,e);
    throw new ProviderError(e instanceof SyntaxError?'DEEPSEEK_INVALID_JSON':'DEEPSEEK_NETWORK_ERROR',details,e);
  }
}
export class DeepSeekModel implements Model {
  readonly kind='deepseek';
  constructor(private key: string, private cfg: ()=>Config, private http: typeof fetch=fetch) {}
  async complete(messages: ChatMessage[], maxTokens: number,options:CompletionOptions={}): Promise<ModelResult> {
    if (!this.key) throw new FishError('DEEPSEEK_KEY_MISSING');
    const data=await deepSeekRequest(this.http,this.key,modelPayload(this.cfg(),messages,maxTokens,options),options.signal);
    const message=data.choices?.[0]?.message,text=message?.content??'',calls=message?.tool_calls;
    const usage=deepSeekUsage(data.usage);
    if(typeof text!=='string'||!usage) throw new FishError('DEEPSEEK_INVALID_RESPONSE');
    if(calls!==undefined){
      const issues:string[]=[];
      if(!Array.isArray(calls))issues.push('tool_calls is not an array');
      else for(const [i,c] of calls.entries()){
        if(typeof c?.id!=='string'||!c.id||c.id.length>200||c.type!=='function'||typeof c.function?.name!=='string'||typeof c.function?.arguments!=='string'||c.function.arguments.length>131072)issues.push('call '+i+': invalid fields');
        else {try{JSON.parse(c.function.arguments);}catch{issues.push('call '+i+': incomplete or invalid argument JSON');}}
      }
      if(issues.length)throw new ModelResponseError(data.choices?.[0]?.finish_reason==='length'?'DEEPSEEK_TOOL_OUTPUT_TRUNCATED':'DEEPSEEK_INVALID_TOOL_CALL',usage,
        {responseId:data.id,finishReason:data.choices?.[0]?.finish_reason,toolCount:Array.isArray(calls)?calls.length:null,issues,response:{content:text,tool_calls:calls}});
    }
    return {text,usage,...(calls?.length?{tool_calls:calls}:{}),...(typeof data.id==='string'?{responseId:data.id}:{}),...(typeof data.choices[0].finish_reason==='string'?{finishReason:data.choices[0].finish_reason}:{})};
  }
}
export class MockModel implements Model {
  readonly kind='mock'; calls=0;
  async complete(messages: ChatMessage[], maxTokens:number): Promise<ModelResult> {
    this.calls++;
    const planner=messageText(messages[0]).includes('TASK_PLANNER');
    let request:any;try{request=JSON.parse(messageText(messages.at(-1)!));}catch{request={messages:[{text:messageText(messages.at(-1)!)}]};}
    const text=planner ? JSON.stringify({useCodex:true,task:'在当前工作目录创建任务要求的文件：'+String(request.request).slice(0,160)}) :
      messageText(messages[0]).includes('TASK_RESULT') ? '【Mock】任务已完成，产物已通过独立校验。' : '【Mock 小鱼】收到啦。'+String(request.messages?.at(-1)?.text??request.result??'').slice(0,60);
    return {text,usage:{input:Math.ceil(Buffer.byteLength(JSON.stringify(messages))/4),output:Math.min(maxTokens,Math.ceil(Buffer.byteLength(text)/3))}};
  }
}
export class BudgetedModel {
  constructor(public provider:Model, private ledger:Ledger, private cfg:()=>Config) {}
  async call(group:string,user:string,messages:ChatMessage[]):Promise<string> {
    return (await this.complete(group,user,messages)).text;
  }
  async complete(group:string,user:string,messages:ChatMessage[],options:CompletionOptions={}):Promise<ModelResult> {
    const max=this.cfg().maxOutputTokens;
    const bound=inputBound(messages,options.tools);
    let id:string;
    try{id=this.ledger.reserve('model',group,user,bound,max);}
    catch(e){
      if(e instanceof BudgetError){
        this.ledger.store.audit('budget-denied',group,JSON.stringify({reason:e.reason,scope:e.scope,currency:'CNY',remainingCny:e.remaining,requiredCny:e.required,inputReservation:bound,outputReservation:max,budget:this.ledger.costSummary(group)}));
      }
      throw e;
    }
    try { options.onReservation?.({id,reservedTokens:bound+max,reservedCny:this.ledger.receipt(id)?.amountCny});recordPrompt(this.ledger.store,user==='exploration'?'exploration':user==='daily-qzone'?'daily':user==='daily-news'?'news':user==='memory-review'?'memory':'qq',modelPayload(this.cfg(),messages,max,options));const r=await this.provider.complete(messages,max,options);this.ledger.settle(id,r.usage);this.ledger.store.setMeta('modelStatus','last call succeeded');return {...r,billing:this.ledger.receipt(id)}; }
    catch(e) { this.ledger.settle(id,e instanceof ModelResponseError?e.usage:undefined);if(e instanceof Error)Object.assign(e,{billing:this.ledger.receipt(id)});if(e instanceof ModelResponseError){this.ledger.store.setMeta('model:last-invalid',redact(JSON.stringify({at:Date.now(),code:e.code,...e.diagnostic})));this.ledger.store.audit('model-invalid',group,JSON.stringify({code:e.code,issues:e.diagnostic.issues,finishReason:e.diagnostic.finishReason}));}this.ledger.error();this.ledger.store.setMeta('modelStatus','last call failed');throw e; }
  }
}
