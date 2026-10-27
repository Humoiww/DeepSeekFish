import type { ChatMessage, Model, ModelResult } from '../types.js';
import { FishError } from '../types.js';
import { Ledger } from '../budget/ledger.js';
import type { Config } from '../config.js';

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
  async complete(messages: ChatMessage[], maxTokens: number): Promise<ModelResult> {
    if (!this.key) throw new FishError('DEEPSEEK_KEY_MISSING');
    const res=await this.http('https://api.deepseek.com/chat/completions',{
      method:'POST', redirect:'error', signal:AbortSignal.timeout(30000),
      headers:{authorization:'Bearer '+this.key,'content-type':'application/json'},
      body:JSON.stringify({model:this.cfg().model,messages,max_tokens:maxTokens,stream:false,thinking:{type:'disabled'}}),
    });
    if(!res.ok) { await res.body?.cancel(); throw new FishError('DEEPSEEK_HTTP_'+res.status); }
    const data=await boundedJson(res);
    const text=data.choices?.[0]?.message?.content;
    const input=data.usage?.prompt_tokens,output=data.usage?.completion_tokens;
    if(typeof text!=='string' || !Number.isSafeInteger(input) || input<0 || !Number.isSafeInteger(output) || output<0) throw new FishError('DEEPSEEK_INVALID_RESPONSE');
    return {text,usage:{input,output}};
  }
}
export class MockModel implements Model {
  readonly kind='mock'; calls=0;
  async complete(messages: ChatMessage[], maxTokens:number): Promise<ModelResult> {
    this.calls++;
    const planner=messages[0]?.content.includes('TASK_PLANNER');
    const request=JSON.parse(messages.at(-1)!.content);
    const text=planner ? JSON.stringify({useCodex:true,task:'在当前工作目录创建任务要求的文件：'+String(request.request).slice(0,160)}) :
      messages[0]?.content.includes('TASK_RESULT') ? '【Mock】任务已完成，产物已通过独立校验。' : '【Mock 小鱼】收到啦。'+String(request.messages?.at(-1)?.text??request.result??'').slice(0,60);
    return {text,usage:{input:Math.ceil(Buffer.byteLength(JSON.stringify(messages))/4),output:Math.min(maxTokens,Math.ceil(Buffer.byteLength(text)/3))}};
  }
}
export class BudgetedModel {
  constructor(public provider:Model, private ledger:Ledger, private cfg:()=>Config) {}
  async call(group:string,user:string,messages:ChatMessage[]):Promise<string> {
    const max=this.cfg().maxOutputTokens;
    // Byte-level BPE cannot emit more normal tokens than UTF-8 bytes. Include a
    // deliberately large allowance for fixed chat framing; no tools/hidden context.
    const bound=Buffer.byteLength(JSON.stringify(messages),'utf8')+4096;
    const id=this.ledger.reserve('model',group,user,bound,max);
    try { const r=await this.provider.complete(messages,max);this.ledger.settle(id,r.usage);this.ledger.store.setMeta('modelStatus','last call succeeded');return r.text; }
    catch(e) { this.ledger.settle(id);this.ledger.error();this.ledger.store.setMeta('modelStatus','last call failed');throw e; }
  }
}
