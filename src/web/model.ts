import type { Config } from '../config.js';
import { FishError } from '../types.js';
import { Ledger } from '../budget/ledger.js';
import { boundedJson } from '../agent/model.js';

export interface ToolCall {id:string;type:'function';function:{name:string;arguments:string}}
export interface WireMessage {role:'system'|'user'|'assistant'|'tool';content:string;tool_calls?:ToolCall[];tool_call_id?:string}
export interface WebTool {type:'function';function:{name:string;description:string;parameters:Record<string,unknown>}}
export interface WebCompletion {content:string;tool_calls?:ToolCall[]}
export class WebModel {
  constructor(private key:()=>string,private cfg:()=>Config,private ledger:Ledger,readonly mock:boolean,private http:typeof fetch=fetch){}
  async complete(group:string,messages:WireMessage[],tools:WebTool[],signal:AbortSignal,final=false):Promise<WebCompletion>{
    if(!this.mock&&!this.key())throw new FishError('DEEPSEEK_KEY_MISSING');
    signal.throwIfAborted();
    const cfg=this.cfg(),payload={model:cfg.model,messages,max_tokens:cfg.maxOutputTokens,stream:false,thinking:{type:'disabled'},
      ...(tools.length?{tools,tool_choice:final?'none':'auto'}:{})};
    const bound=Buffer.byteLength(JSON.stringify(payload))+4096;
    const reservation=this.ledger.reserve('model',group,'webui-local',bound,cfg.maxOutputTokens);
    try{
      if(this.mock){
        const last=messages.at(-1)!;let result:WebCompletion;
        const call=(name:string,args:unknown)=>({content:'',tool_calls:[{id:'mock-'+messages.length,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]});
        if(tools.some(t=>t.function.name==='generate_image')&&!final){
          result=call('generate_image',{subject:/自己|鲸酱|自拍|自画像/.test(last.content)?'鲸酱，保持设定图中的蓝发、鲸鳍耳、女仆裙和鲸尾':'用户指定的主体，保留原始要求',scene:'清晨窗边，轻松自然的动作，简洁环境',style:'细腻可爱的插画，柔和笔触',composition:'1:1 方形画面，主体居中，四周适当留白',lighting:'温暖的侧逆光，柔和阴影',palette:'浅蓝、奶白与少量暖金色',details:'表情生动，轮廓清晰；无文字、水印和多余肢体'});
        }else if(last.role==='tool'){
          const data=JSON.parse(last.content);
          result={content:data.error?'【离线演示】这项操作没有完成：'+data.error:
            data.name?'【离线演示】已保存 '+data.name+'。\n\n文件已放在本次会话的工作区，你可以在右侧下载，或继续让我调整内容。':
            data.approvalRequired?'【离线演示】已提交 Codex 待审任务，尚未执行。请先核对右侧任务说明，再在本机终端逐次授权。':
            Array.isArray(data)?'【离线演示】当前工作区有 '+data.length+' 个文件。'+(data.length?'\n\n'+data.map((f:any)=>'• '+f.name).join('\n'):'可以先让我创建一份 notes.md。'):
            '【离线演示】操作已完成，你可以在右侧查看文件与任务状态。'};
        }
        else if(tools.length&&!final&&/codex/i.test(last.content))result=call('queue_codex',{task:last.content.slice(0,1000)});
        else if(tools.length&&!final&&/创建|写入/.test(last.content))result=call('write_file',{path:last.content.match(/[a-zA-Z0-9_-]+\.(?:md|txt|json)/)?.[0]??'notes.md',content:'# 三步学习计划\n\n1. 明确目标：选择今天要解决的一个小问题。\n2. 动手练习：留出 25 分钟，完成一个最小示例。\n3. 回顾记录：写下收获、疑问和明天的下一步。\n\n---\n本文件由离线演示工具创建，未调用真实模型。\n'});
        else if(tools.length&&!final&&/文件|工作区/.test(last.content))result=call('list_files',{});
        else result={content:'【离线演示】收到：'+last.content+'\n\n这里是独立对话窗口。切换到「受限助手」，可以尝试让我创建 notes.md 或查看工作区文件。真实对话请在设置中保存 DeepSeek API Key，并使用正式模式启动。'};
        this.ledger.settle(reservation,{input:Math.min(bound,120),output:Math.min(cfg.maxOutputTokens,80)});return result;
      }
      const res=await this.http('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',
        headers:{authorization:'Bearer '+this.key(),'content-type':'application/json'},body:JSON.stringify(payload),
        signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
      if(!res.ok){await res.body?.cancel();throw new FishError('DEEPSEEK_HTTP_'+res.status);}
      const data=await boundedJson(res),m=data.choices?.[0]?.message,u=data.usage;
      if(!u||![u.prompt_tokens,u.completion_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)||!m||m.content!=null&&typeof m.content!=='string')throw new FishError('DEEPSEEK_INVALID_RESPONSE');
      this.ledger.settle(reservation,{input:u.prompt_tokens,output:u.completion_tokens});
      if(this.ledger.store.getMeta('budgetFault'))throw new FishError('BUDGET_USAGE_FAULT');
      const calls=m.tool_calls;
      if(calls!==undefined&&(!Array.isArray(calls)||calls.length>6||calls.some((c:any)=>c.type!=='function'||typeof c.id!=='string'||c.id.length>120||typeof c.function?.name!=='string'||typeof c.function?.arguments!=='string'||c.function.arguments.length>16000)))throw new FishError('INVALID_TOOL_CALL');
      if(!m.content&&!calls?.length)throw new FishError('DEEPSEEK_EMPTY_RESPONSE');
      return {content:m.content??'',...(calls?.length?{tool_calls:calls}: {})};
    }catch(e){this.ledger.settle(reservation);this.ledger.error();throw e;}
  }
}
