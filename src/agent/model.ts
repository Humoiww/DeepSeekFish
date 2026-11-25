import type { ChatMessage, Model, ModelResult,CompletionOptions,ToolCall } from '../types.js';
import { FishError,type Usage } from '../types.js';
import { Ledger,BudgetError } from '../budget/ledger.js';
import {deepseekCredential,defaults,providerCredential,type Config} from '../config.js';
import {createHash,randomUUID} from 'node:crypto';
import {modelPricing} from '../budget/pricing.js';
import {OpenCodeCatalog,openCodeChatUrl,openCodeThinkingOverride,type OpenCodeModelInfo} from '../provider/opencode.js';
import {boundedJson} from '../provider/http.js';
import type {ModelRoute,ModelReservation} from '../types.js';

export {boundedJson} from '../provider/http.js';
import { redact } from '../storage/db.js';
import { recordPrompt } from '../prompt-record.js';
import { knowledgeTokens } from '../memory/knowledge.js';
import { deepSeekUsage } from '../usage.js';
import {ProviderError,diagnosticSafe} from '../diagnostics.js';
import {isPromptNumberBlocked,PromptNumberGuard,privateQQNumbers} from './prompt-numbers.js';
import {toolFailure} from './tool-feedback.js';
// DeepSeek's documented non-thinking default when max_tokens is absent.
const deepSeekDefaultOutputTokens=8192;
const reasoning=new WeakMap<ToolCall[],{connection:string;content:string}>();
const connectionIdentity=(cfg:Config)=>cfg.model+':'+(cfg.keySlot??cfg.provider);
export function modelPayload(cfg:Config,messages:ChatMessage[],maxTokens:number,options:CompletionOptions={}){
  const go=cfg.provider==='opencode_go';
  const override=go?openCodeThinkingOverride(cfg.model,cfg.disableThinking):{thinking:{type:'disabled'}};
  const input=go&&!override?messages.map(message=>{
    const prior=message.tool_calls&&reasoning.get(message.tool_calls);
    return prior?.connection===connectionIdentity(cfg)?{...message,reasoning_content:prior.content}:message;
  }):messages;
  return {model:cfg.model,messages:input,stream:false,...override,
    ...(options.maxOutputTokens===null&&!go?{}:{max_tokens:maxTokens}),
    ...(options.tools?.length?{tools:options.tools,tool_choice:options.final?'none':options.toolChoice?{type:'function',function:{name:options.toolChoice}}:options.requireTool?'required':'auto'}:{})};
}

export function messageText(message:ChatMessage):string{return typeof message.content==='string'?message.content:message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');}
export const maxVisionInputTokens=1024;

export function inputBound(messages:ChatMessage[],tools:CompletionOptions['tools']=[],visionTokens=maxVisionInputTokens):number{
  let imageTokens=0;
  const text=messages.map(m=>({...m,content:typeof m.content==='string'?m.content:m.content.map(p=>{
    if(p.type==='text')return p;
    // DeepSeek documents a maximum of 1024 input tokens per image. Base64 is
    // transport encoding, not text tokens: counting it blocks ordinary vision.
    imageTokens+=visionTokens;return {type:'image_url',image_url:{url:'[image]',detail:p.image_url.detail}};
  })}));
  // Use the pinned official tokenizer, plus framing/template margin. Counting
  // Chinese UTF-8 bytes as tokens caused otherwise affordable turns to fail.
  const encoded=JSON.stringify({messages:text,tools});
  let tokens:number;try{tokens=Math.ceil(knowledgeTokens(encoded)*1.25);}catch{tokens=Buffer.byteLength(encoded,'utf8');}
  return tokens+4096+messages.length*32+(tools?.length??0)*64+imageTokens;
}

export class ModelResponseError extends FishError {
  constructor(code:string,public usage:Usage|undefined,public diagnostic:Record<string,unknown>){super(code);}
}
export async function errorBody(response:Response){
  if(!response.body)return null;
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,truncated=false;
  try{for(;;){const part=await reader.read();if(part.done)break;const remaining=8192-size;chunks.push(part.value.subarray(0,remaining));size+=Math.min(part.value.length,remaining);if(part.value.length>remaining||size===8192){truncated=true;break;}}}
  finally{await reader.cancel().catch(()=>{});}
  const text=Buffer.concat(chunks).toString('utf8');if(truncated)return {text,truncated:true};try{return JSON.parse(text);}catch{return {text};}
}
/** Shared provider transport; HTTP errors, timeouts and network causes stay distinguishable. */
export async function deepSeekRequest(http:typeof fetch,key:string,payload:unknown,signal?:AbortSignal,providerOutputDefault=false){
  const started=Date.now(),timeoutMs=30000,endpoint='https://api.deepseek.com/chat/completions';
  const timeout=providerOutputDefault?undefined:AbortSignal.timeout(timeoutMs);
  const joined=timeout&&signal?AbortSignal.any([timeout,signal]):timeout??signal;
  let phase='request',status:number|undefined,requestId:string|undefined;
  try{
    const res=await http(endpoint,{method:'POST',redirect:'error',signal:joined,headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(payload)});
    phase='response_body';status=res.status;requestId=res.headers.get('x-request-id')??res.headers.get('request-id')??undefined;
    if(!res.ok){
      let body:unknown;try{body=await errorBody(res);}catch(e){body={unavailable:true,reason:e instanceof Error?e.message:String(e)};}
      throw new ProviderError('DEEPSEEK_HTTP_'+res.status,diagnosticSafe({endpoint,httpStatus:status,requestId,elapsedMs:Date.now()-started,phase,provider:body}));
    }
    return await (providerOutputDefault?res.json():boundedJson(res));
  }catch(e){
    if(e instanceof ProviderError)throw e;
    const details={endpoint,httpStatus:status,requestId,phase,elapsedMs:Date.now()-started,timeoutMs:timeout?timeoutMs:undefined};
    if(timeout?.aborted||(e as any)?.name==='TimeoutError')throw new ProviderError('DEEPSEEK_TIMEOUT',details,e);
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
    const providerOutputDefault=options.maxOutputTokens===null;
    const data=await deepSeekRequest(this.http,this.key,modelPayload(this.cfg(),messages,maxTokens,options),options.signal,providerOutputDefault);
    return parseCompletion(data,'DEEPSEEK',providerOutputDefault);
  }
}

function parseCompletion(data:any,prefix:string,providerOutputDefault=false,cfg?:Config):ModelResult {
    const message=data?.choices?.[0]?.message,text=message?.content??'',calls=message?.tool_calls;
    const usage=deepSeekUsage(data?.usage);
    if(!message||typeof text!=='string'||!usage) throw new FishError(prefix+'_INVALID_RESPONSE');
    if(calls!==undefined){
      const issues:string[]=[];
      if(!Array.isArray(calls))issues.push('tool_calls is not an array');
      else for(const [i,c] of calls.entries()){
        if(typeof c?.id!=='string'||!c.id||c.id.length>200||c.type!=='function'||typeof c.function?.name!=='string'||typeof c.function?.arguments!=='string'||!providerOutputDefault&&c.function.arguments.length>131072)issues.push('call '+i+': invalid fields');
        else {try{JSON.parse(c.function.arguments);}catch{issues.push('call '+i+': incomplete or invalid argument JSON');}}
      }
      if(issues.length)throw new ModelResponseError(prefix+(data.choices?.[0]?.finish_reason==='length'?'_TOOL_OUTPUT_TRUNCATED':'_INVALID_TOOL_CALL'),usage,
        {responseId:data.id,finishReason:data.choices?.[0]?.finish_reason,toolCount:Array.isArray(calls)?calls.length:null,issues,response:{content:text,tool_calls:calls}});
    }
    if(cfg&&!openCodeThinkingOverride(cfg.model,cfg.disableThinking)&&calls?.length&&
      typeof message.reasoning_content==='string'&&message.reasoning_content.length<=131072){
      reasoning.set(calls,{connection:connectionIdentity(cfg),content:message.reasoning_content});
    }
    return {text,usage,...(calls?.length?{tool_calls:calls}:{}),...(typeof data.id==='string'?{responseId:data.id}:{}),...(typeof data.choices[0].finish_reason==='string'?{finishReason:data.choices[0].finish_reason}:{})};
}

export type OpenCodeRateLimit={lastRateLimitedAt:number;retryAfterMs?:number;reason:string};
function retryAfter(value:string|null,now:number){
  if(!value)return undefined;
  const seconds=/^\d+(?:\.\d+)?$/.test(value)?Number(value)*1000:Date.parse(value)-now;
  return Number.isFinite(seconds)&&seconds>=0?Math.min(Math.ceil(seconds),30*86400000):undefined;
}
const rateLimitKey=(slot:string)=>'opencode-rate-limit:'+slot;

export class OpenCodeGoModel implements Model {
  readonly kind='opencode_go';
  constructor(private key:string,private cfg:()=>Config,private http:typeof fetch=fetch,
    private sessionId?:string,private onLimit?:(state:OpenCodeRateLimit)=>void){}
  async complete(messages:ChatMessage[],maxTokens:number,options:CompletionOptions={}):Promise<ModelResult>{
    if(!this.key)throw new FishError('OPENCODE_KEY_MISSING');
    const cfg=this.cfg(),payload=modelPayload({...cfg,provider:'opencode_go'},messages,maxTokens,options);
    const timeoutMs=90_000,timeout=AbortSignal.timeout(timeoutMs),started=Date.now();
    const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
    let status:number|undefined,requestId:string|undefined;
    const detail=()=>({endpoint:openCodeChatUrl,httpStatus:status,requestId,elapsedMs:Date.now()-started,timeoutMs});
    try{
      const response=await this.http(openCodeChatUrl,{method:'POST',redirect:'error',signal,
        headers:{authorization:'Bearer '+this.key,'content-type':'application/json','user-agent':'DeepSeekFish/0.1',
          ...(this.sessionId?{'x-opencode-session':this.sessionId}:{})},body:JSON.stringify(payload)});
      status=response.status;
      requestId=response.headers.get('x-request-id')??response.headers.get('request-id')??undefined;
      if(!response.ok){
        if(status===429){
          const now=Date.now();
          this.onLimit?.({lastRateLimitedAt:now,retryAfterMs:retryAfter(response.headers.get('retry-after'),now),reason:'OpenCode Go 返回 HTTP 429'});
        }
        const body=await errorBody(response).catch(()=>null);
        const clean=JSON.stringify(body).replaceAll(this.key,'[凭据省略]');
        throw new ProviderError('OPENCODE_HTTP_'+status,diagnosticSafe({...detail(),provider:clean}));
      }
      return parseCompletion(await boundedJson(response,4*1024*1024),'OPENCODE',false,cfg);
    }catch(e){
      if(e instanceof ProviderError||e instanceof ModelResponseError)throw e;
      if(options.signal?.aborted||(e as any)?.name==='AbortError')throw new ProviderError('OPENCODE_CANCELLED',detail(),e);
      if(timeout.aborted||(e as any)?.name==='TimeoutError')throw new ProviderError('OPENCODE_TIMEOUT',detail(),e);
      if(e instanceof FishError)throw new ProviderError(e.code,detail());
      throw new ProviderError(e instanceof SyntaxError?'OPENCODE_INVALID_JSON':'OPENCODE_NETWORK_ERROR',detail(),e);
    }
  }
}

export class RoutedChatModel implements Model {
  readonly kind='routed';
  constructor(private root:string,private cfg:()=>Config,private ledger:Ledger,
    private catalog:OpenCodeCatalog,private http:typeof fetch=fetch){}

  rateLimit(keySlot='opencode_go'){
    const data=this.ledger.store.getMeta(rateLimitKey(keySlot));
    return data?JSON.parse(data) as OpenCodeRateLimit:undefined;
  }

  private session(group:string){
    // Reuse an opaque session identifier across calls without sending raw QQ IDs.
    const seed=this.ledger.store.transaction(()=>{
      const existing=this.ledger.store.getMeta('opencode-session-seed');
      if(existing)return existing;
      const created=randomUUID();
      this.ledger.store.setMeta('opencode-session-seed',created);
      return created;
    });
    return createHash('sha256').update(seed).update('\0').update(group).digest('hex');
  }

  async prepare(messages:ChatMessage[],options:CompletionOptions,group:string){
    options.signal?.throwIfAborted();
    let cfg=this.cfg(),info:OpenCodeModelInfo|undefined,fallbackFrom:ModelRoute['fallbackFrom'];
    if(cfg.provider==='opencode_go'){
      const slot=cfg.keySlot??'opencode_go';
      const hasImages=messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url'));
      if(!hasImages&&!providerCredential(this.root,'opencode_go',slot))throw new FishError('OPENCODE_KEY_MISSING');
      // The local cache is shared between processes. Network refreshes only run
      // when Go is selected, and never block a request solely on missing prices.
      info=this.catalog.peek(slot).find(model=>model.id===cfg.model);
      try{info=(await this.catalog.get(slot)).models.find(model=>model.id===cfg.model)??info;}
      catch{/* Missing catalog data falls back to conservative estimates. */}
      options.signal?.throwIfAborted();
      if(info?.supportsVision!==true&&hasImages){
        if(!deepseekCredential(this.root))throw new FishError('OPENCODE_VISION_UNSUPPORTED');
        cfg={...cfg,provider:'deepseek',model:defaults.model,keySlot:'deepseek'};
        fallbackFrom='opencode_go';
      }else if(info?.supportsTools===false&&options.tools?.length){
        throw new FishError('OPENCODE_TOOLS_UNSUPPORTED');
      }
    }
    const keySlot=cfg.keySlot??cfg.provider,key=providerCredential(this.root,cfg.provider,keySlot);
    if(!key)throw new FishError(cfg.provider==='deepseek'?'DEEPSEEK_KEY_MISSING':'OPENCODE_KEY_MISSING');
    const providerOutputDefault=cfg.provider==='deepseek'&&options.maxOutputTokens===null;
    const output=providerOutputDefault?deepSeekDefaultOutputTokens:Math.min(
      options.maxOutputTokens??cfg.maxOutputTokens,cfg.provider==='opencode_go'?info?.outputLimit??Infinity:Infinity);
    const route:ModelRoute={provider:cfg.provider,model:cfg.model,...(fallbackFrom?{fallbackFrom}:{})};
    const model=cfg.provider==='deepseek'?new DeepSeekModel(key,()=>cfg,this.http):
      new OpenCodeGoModel(key,()=>cfg,this.http,this.session(group),state=>this.ledger.store.setMeta(rateLimitKey(keySlot),JSON.stringify(state)));
    const request=modelPayload(cfg,messages,output,options);
    const pricing=modelPricing(cfg.model,Date.now(),{provider:cfg.provider,usdToCny:cfg.usdToCny,info});
    return {request,route,pricing,output,providerOutputDefault,
      maxOutputTokens:cfg.maxOutputTokens,invoke:()=>model.complete(messages,output,options)};
  }

  async complete(messages:ChatMessage[],maxTokens:number,options:CompletionOptions={}){
    const plan=await this.prepare(messages,{...options,maxOutputTokens:options.maxOutputTokens===null?null:maxTokens},'direct');
    return {...await plan.invoke(),route:plan.route};
  }
}
export class MockModel implements Model {
  readonly kind='mock'; calls=0;
  private countdownCall(messages:ChatMessage[],userIndex:number,text:string,options:CompletionOptions):ToolCall|undefined {
    // The offline model can demonstrate the private attachment exchange without a real provider.
    if(userIndex<0||!/倒计时(?:小)?视频/.test(text)||!/发(?:送)?(?:给)?我/.test(text)||
      !['list_files','send_file','reply'].every(name=>options.tools?.some(tool=>tool.function.name===name)))return;
    const call=(name:string,args:Record<string,unknown>):ToolCall=>({
      id:'mock-'+this.calls,type:'function',function:{name,arguments:JSON.stringify(args)},
    });
    const turn=messages.slice(userIndex+1),result=turn.findLast(message=>message.role==='tool');
    if(!result)return call('list_files',{});
    const tool=turn.flatMap(message=>message.tool_calls??[]).find(item=>item.id===result.tool_call_id);
    let data:{files?:{id:string}[];deliveryStatus?:string}|undefined;
    try{data=JSON.parse(messageText(result));}catch{}
    if(tool?.function.name==='list_files'){
      const file=Array.isArray(data?.files)?data.files.find(item=>item?.id==='countdown-video'):undefined;
      if(file)return call('send_file',{fileId:file.id});
      return call('reply',{text:'【Mock】当前对话没有可发送的倒计时视频。'});
    }
    if(tool?.function.name==='send_file')return call('reply',{text:data?.deliveryStatus==='confirmed'
      ?'【Mock】视频已作为附件发送。':'【Mock】视频附件送达未获确认。'});
  }
  async complete(messages: ChatMessage[], maxTokens:number,options:CompletionOptions={}): Promise<ModelResult> {
    this.calls++;
    const userIndex=messages.findLastIndex(message=>message.role==='user');
    const input=messageText(messages[userIndex]??messages.at(-1)!);
    const inputTokens=Math.ceil(Buffer.byteLength(JSON.stringify(messages))/4);
    const tool=this.countdownCall(messages,userIndex,input,options);
    if(tool)return {text:'',usage:{input:inputTokens,output:Math.min(maxTokens,Math.ceil(Buffer.byteLength(JSON.stringify(tool))/3))},tool_calls:[tool]};
    const planner=messageText(messages[0]).includes('TASK_PLANNER');
    const body=input.replace(/^\[[^\]\n]+ · 本轮消息\] (?:\[说话人：[^\]\n]+\] )?\[QQ [^\]\n]+\] (?:\[引用 QQ 消息 ID [^\]\n]+\] )?/u,'');
    let request:any;try{request=JSON.parse(input);}catch{request={messages:[{text:body}]};}
    const text=planner ? JSON.stringify({useCodex:true,task:'在当前工作目录创建任务要求的文件：'+String(request.request).slice(0,160)}) :
      messageText(messages[0]).includes('TASK_RESULT') ? '【Mock】任务已完成，产物已通过独立校验。' : '【Mock 小鱼】收到啦。'+String(request.messages?.at(-1)?.text??request.result??'').slice(0,60);
    return {text,usage:{input:inputTokens,output:Math.min(maxTokens,Math.ceil(Buffer.byteLength(text)/3))}};
  }
}
export class BudgetedModel {
  constructor(public provider:Model, private ledger:Ledger, private cfg:()=>Config) {}
  async call(group:string,user:string,messages:ChatMessage[]):Promise<string> {
    let input=messages;
    for(let attempt=0;;attempt++){
      const {text}=await this.complete(group,user,input);
      const privacy=new PromptNumberGuard(input,this.ledger.store,true,privateQQNumbers(this.cfg(),group,user));
      try{
        privacy.text(text);
        // Check decoded JSON replies as well as their literal text.
        if(text.trimStart().startsWith('{')){
          let parsed:unknown;try{parsed=JSON.parse(text);}catch{}
          if(parsed!==undefined)privacy.text(JSON.stringify(parsed));
        }
        return text;
      }catch(e){
        if(!isPromptNumberBlocked(e)||attempt)throw e;
        input=[...messages,{role:'system',content:JSON.stringify(toolFailure(e,'reply'))}];
      }
    }
  }
  async complete(group:string,user:string,messages:ChatMessage[],options:CompletionOptions={}):Promise<ModelResult> {
    const plan=this.provider instanceof RoutedChatModel?await this.provider.prepare(messages,options,group):undefined;
    const providerOutputDefault=plan?.providerOutputDefault??options.maxOutputTokens===null;
    const max=plan?.output??(providerOutputDefault?deepSeekDefaultOutputTokens:options.maxOutputTokens??this.cfg().maxOutputTokens);
    const request=plan?.request??modelPayload(this.cfg(),messages,max,options);
    const bound=inputBound(request.messages,options.tools,plan?.route.provider==='opencode_go'?8192:maxVisionInputTokens);
    let id:string;
    try{id=this.ledger.reserveModel(group,user,bound,max,providerOutputDefault,plan?.pricing,plan?.maxOutputTokens);}
    catch(e){
      if(e instanceof BudgetError){
        this.ledger.store.audit('budget-denied',group,JSON.stringify({reason:e.reason,scope:e.scope,currency:'CNY',remainingCny:e.remaining,requiredCny:e.required,inputReservation:bound,outputReservation:max,budget:this.ledger.costSummary(group)}));
      }
      throw e;
    }
    try {
      const reservation:ModelReservation={id,reservedTokens:bound+max,reservedCny:this.ledger.receipt(id)?.amountCny,
        ...(plan?{request,route:plan.route}:{})};
      options.onReservation?.(reservation);
      const channel=options.promptChannel??(user==='webui-local'?'web':user==='exploration'?'exploration':user==='daily-qzone'?'daily':
        user==='daily-news'?'news':user==='memory-review'?'memory':user==='curiosity-summary'?'curiosity':
        user==='activity-chain'||user==='corpus-learning'||user==='development'?user:'qq');
      recordPrompt(this.ledger.store,channel,request);
      const result=await (plan?plan.invoke():this.provider.complete(messages,max,options));
      this.ledger.settle(id,result.usage);
      this.ledger.store.setMeta('modelStatus','last call succeeded');
      return {...result,billing:this.ledger.receipt(id),...(plan?{route:plan.route}:{})};
    }catch(e){
      this.ledger.settle(id,e instanceof ModelResponseError?e.usage:undefined);
      if(e instanceof Error)Object.assign(e,{billing:this.ledger.receipt(id),route:plan?.route});
      if(e instanceof ModelResponseError){
        this.ledger.store.setMeta('model:last-invalid',redact(JSON.stringify({at:Date.now(),code:e.code,...e.diagnostic})));
        this.ledger.store.audit('model-invalid',group,JSON.stringify({code:e.code,issues:e.diagnostic.issues,finishReason:e.diagnostic.finishReason}));
      }
      this.ledger.error();
      this.ledger.store.setMeta('modelStatus','last call failed');
      throw e;
    }
  }
}
