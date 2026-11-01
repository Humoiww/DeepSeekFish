import { knowledgeTokens } from '../memory/knowledge.js';
import { FishError,type ChatMessage,type Message,type ModelTool } from '../types.js';

export const RECENT_MESSAGES=6;
/** Keep this question intact; spend at most 1500 tokens on preceding dialogue. */
export function recentDialogue(history:Message[],batch:Message[]):Message[]{
  const ids=new Set(batch.map(m=>m.id)),last=batch.at(-1)!;
  const previous=history.filter(m=>!ids.has(m.id)&&m.at<=last.at),selected:Message[]=[];
  let tokens=0;
  for(const m of previous.reverse()){
    const cost=knowledgeTokens(m.text)+16;
    if(selected.length+batch.length>=RECENT_MESSAGES||tokens+cost>1500)break;
    selected.unshift(m);tokens+=cost;
  }
  return [...selected,...batch];
}

export const contextTools:ModelTool[]=[{type:'function',function:{name:'read_tool_result',description:'按 resultId 续读本轮已收起的工具原文，offset 翻页；不重新请求网站或执行动作。',parameters:{type:'object',properties:{resultId:{type:'string'},offset:{type:'integer',minimum:0}},required:['resultId'],additionalProperties:false}}}];
const RECEIPTS=new Set(['generate_image','send_meme','collect_meme','remember_images','reply']);
/** The full results stay in the private trace. This turn's references never cross conversations. */
export class TurnContext {
  private results=new Map<string,{message:ChatMessage;name:string;raw:string;round:number}>();
  private media:{message:ChatMessage;round:number}[]=[];
  result(name:string,id:string,result:unknown,round:number):ChatMessage{
    const raw=JSON.stringify(result)??'null',message:ChatMessage={role:'tool',tool_call_id:id,content:raw};
    this.results.set(id,{message,name,raw,round});return message;
  }
  images(message:ChatMessage,round:number):ChatMessage{this.media.push({message,round});return message;}
  read(args:any){
    if(!args||typeof args.resultId!=='string'||Object.keys(args).some(k=>!['resultId','offset'].includes(k))||!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0)throw new FishError('INVALID_TOOL_ARGS');
    const result=this.results.get(args.resultId);if(!result)throw new FishError('TOOL_RESULT_NOT_FOUND');
    const offset=args.offset??0,content=result.raw.slice(offset,offset+4000);
    return {resultId:args.resultId,tool:result.name,content,offset,nextOffset:offset+content.length<result.raw.length?offset+content.length:null,totalCharacters:result.raw.length};
  }
  compact(round:number){
    let abridgedResults=0,retiredImages=0;
    for(const [id,r] of this.results){
      // Keep native call/result pairs and delivery receipts; older long reads
      // become explicitly labelled excerpts, not fabricated summaries.
      if(round-r.round<2||RECEIPTS.has(r.name)||r.raw.length<=1200)continue;
      r.message.content=JSON.stringify({resultId:id,abridged:true,tool:r.name,preview:r.raw.slice(0,1000),totalCharacters:r.raw.length,readWith:'read_tool_result'});abridgedResults++;
    }
    for(const item of this.media){
      if(round-item.round<3||typeof item.message.content==='string')continue;
      const images=item.message.content.filter(p=>p.type==='image_url').length;if(!images)continue;
      retiredImages+=images;
      item.message.content=[...item.message.content.filter(p=>p.type==='text'),{type:'text',text:'已看过的原图已收起；需要重看可通过图库工具按图片ID取回。'}];
    }
    return {abridgedResults,retiredImages};
  }
}

/** Diagnostics only: exact local tokenizer text counts, vision counted separately. */
export function contextMetrics(messages:ChatMessage[],tools:ModelTool[]){
  let images=0;
  const parts=messages.map(m=>({...m,content:typeof m.content==='string'?m.content:m.content.map(p=>{
    if(p.type==='text')return p;images++;return {type:'image_url',image_url:{url:'[image]'}};
  })}));
  const textTokens=knowledgeTokens(JSON.stringify(parts)),toolTokens=knowledgeTokens(JSON.stringify(tools));
  return {messages:messages.length,images,textTokens,toolTokens,totalTextTokens:textTokens+toolTokens};
}
