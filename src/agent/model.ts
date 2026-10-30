import type { ChatMessage, Model, ModelResult,CompletionOptions } from '../types.js';
import { FishError } from '../types.js';
import { Ledger,conversationTokenLimit } from '../budget/ledger.js';
import type { Config } from '../config.js';

export function messageText(message:ChatMessage):string{return typeof message.content==='string'?message.content:message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');}
export function inputBound(messages:ChatMessage[]):number{
  let imageTokens=0;
  const text=messages.map(m=>({...m,content:typeof m.content==='string'?m.content:m.content.map(p=>{
    if(p.type==='text')return p;
    // DeepSeek documents a maximum of 1024 input tokens per image. Base64 is
    // transport encoding, not text tokens: counting it blocks ordinary vision.
    imageTokens+=1024;return {type:'image_url',image_url:{url:'[image]',detail:p.image_url.detail}};
  })}));
  return Buffer.byteLength(JSON.stringify(text),'utf8')+4096+imageTokens;
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
export class DeepSeekModel implements Model {
  readonly kind='deepseek';
  constructor(private key: string, private cfg: ()=>Config, private http: typeof fetch=fetch) {}
  async complete(messages: ChatMessage[], maxTokens: number,options:CompletionOptions={}): Promise<ModelResult> {
    if (!this.key) throw new FishError('DEEPSEEK_KEY_MISSING');
    const res=await this.http('https://api.deepseek.com/chat/completions',{
      method:'POST', redirect:'error', signal:AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]),
      headers:{authorization:'Bearer '+this.key,'content-type':'application/json'},
      body:JSON.stringify({model:this.cfg().model,messages,max_tokens:maxTokens,stream:false,thinking:{type:'disabled'},
        ...(options.tools?.length?{tools:options.tools,tool_choice:options.final?'none':options.toolChoice?{type:'function',function:{name:options.toolChoice}}:options.requireTool?'required':'auto'}:{})}),
    });
    if(!res.ok) { await res.body?.cancel(); throw new FishError('DEEPSEEK_HTTP_'+res.status); }
    const data=await boundedJson(res);
    const message=data.choices?.[0]?.message,text=message?.content??'',calls=message?.tool_calls;
    const input=data.usage?.prompt_tokens,output=data.usage?.completion_tokens;
    if(typeof text!=='string' || !Number.isSafeInteger(input) || input<0 || !Number.isSafeInteger(output) || output<0) throw new FishError('DEEPSEEK_INVALID_RESPONSE');
    if(calls!==undefined&&(!Array.isArray(calls)||calls.length>4||calls.some(c=>typeof c?.id!=='string'||c.id.length>200||c.type!=='function'||typeof c.function?.name!=='string'||typeof c.function.arguments!=='string'||c.function.arguments.length>12000)))throw new FishError('DEEPSEEK_INVALID_TOOL_CALL');
    return {text,usage:{input,output},...(calls?.length?{tool_calls:calls}:{}),...(typeof data.choices[0].finish_reason==='string'?{finishReason:data.choices[0].finish_reason}:{})};
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
    // Byte-level BPE cannot emit more normal tokens than UTF-8 bytes. Include a
    // deliberately large allowance for fixed chat framing; no tools/hidden context.
    const bound=inputBound(messages)+Buffer.byteLength(JSON.stringify(options.tools??[]));
    let id:string;
    try{id=this.ledger.reserve('model',group,user,bound,max);}
    catch(e){
      if(e instanceof FishError&&e.code==='TOKEN_BUDGET_EXHAUSTED'){
        const cfg=this.cfg(),dailyUsed=this.ledger.value('tokens'),conversationUsed=this.ledger.value('tokens','g:'+group),requestsUsed=this.ledger.value('requests','u:'+user),conversationLimit=conversationTokenLimit(cfg,group);
        const reason=max>cfg.maxOutputTokens?'output':dailyUsed+bound+max>cfg.dailyTokens?'daily':conversationUsed+bound+max>conversationLimit?'conversation':'requests';
        this.ledger.store.audit('budget-denied',group,JSON.stringify({reason,inputReservation:bound,outputReservation:max,dailyUsed,dailyLimit:cfg.dailyTokens,conversationUsed,conversationLimit,requestsUsed,requestsLimit:cfg.userDailyRequests}));
      }
      throw e;
    }
    try { const r=await this.provider.complete(messages,max,options);this.ledger.settle(id,r.usage);this.ledger.store.setMeta('modelStatus','last call succeeded');return r; }
    catch(e) { this.ledger.settle(id);this.ledger.error();this.ledger.store.setMeta('modelStatus','last call failed');throw e; }
  }
}
