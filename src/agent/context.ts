import { knowledgeTokens } from '../memory/knowledge.js';
import { FishError,type ChatMessage,type ChatPart,type Message,type ModelTool } from '../types.js';

export const RECENT_MESSAGES=6;
/** Keep this question intact; spend at most 1500 tokens on preceding dialogue. */
export function recentDialogue(history:Message[],batch:Message[]):Message[]{
  const ids=new Set(batch.map(m=>m.id)),last=batch.at(-1)!;
  const previous=history.filter(m=>!ids.has(m.id)&&m.at<=last.at),selected:Message[]=[];
  let tokens=0;
  for(const m of previous.reverse()){
    const cost=knowledgeTokens(m.text)+knowledgeTokens(JSON.stringify(m.sender??{})+(m.replyTo??''))+16;
    if(selected.length+batch.length>=RECENT_MESSAGES||tokens+cost>1500)break;
    selected.unshift(m);tokens+=cost;
  }
  // A news delivery/previous answer may land between two buffered user messages.
  // Keep its real position instead of moving all history ahead of the batch.
  return [...selected,...batch].sort((a,b)=>a.at-b.at);
}

export const dialogueTime=(at:number)=>new Date(at+8*3600000).toISOString().slice(0,19)+'+08:00';
/** Preserve chronology/provenance instead of presenting yesterday as an undated pending request. */
export function dialogueMessages(dialogue:Message[],batch:Message[]):ChatMessage[]{
  const current=new Set(batch.map(m=>m.id));
  return dialogue.map(m=>({role:m.user==='DeepSeekFish'?'assistant':'user',content:
    '['+dialogueTime(m.at)+(current.has(m.id)?' · 本轮消息':m.id.startsWith('daily-news:')?' · 早间新闻':'')+'] '+
    (m.user==='DeepSeekFish'?(m.replyTo?'[回复 QQ '+m.replyTo+'] ':''):
      '[QQ '+m.user+(m.sender?' '+JSON.stringify(m.sender):'')+'] ')+m.text}));
}

export const contextTools:ModelTool[]=[{type:'function',function:{name:'read_tool_result',description:'取回本轮工具资料；网页默认只读正文。section可选text/images/links/posts/raw，offset按回执续读；数组按条、文字按字符。不重新联网。',parameters:{type:'object',properties:{resultId:{type:'string'},section:{type:'string',enum:['text','images','links','posts','raw']},offset:{type:'integer',minimum:0}},required:['resultId'],additionalProperties:false}}}];
const RECEIPTS=new Set(['generate_image','send_image','send_file','send_meme','collect_meme','remember_images','reply','publish_qzone','draft_daily_post']);
const WEB_TEXT_TOKENS=4000;
type Result={message:ChatMessage;name:string;raw:string;data:any;round:number;body?:string};
function resultText(result:Result,text:string){
  // A tool may carry original images. Updating its text must keep those images
  // attached to the same tool_call_id, never turn them into a new user turn.
  const content=result.message.content;
  result.message.content=Array.isArray(content)?[{type:'text',text},...content.slice(1)]:text;
}
// These pages put the actual body in text/content. Bilibili and similar
// structured feeds put their bodies inside posts and keep their original view.
function webBody(name:string,data:any):string|undefined{
  if(!['browse_page','fetch_page'].includes(name)||!data||typeof data!=='object')return;
  if(Array.isArray(data.posts)&&data.posts.some((p:any)=>typeof p?.content==='string'||typeof p?.text==='string'))return;
  const text=data.text??data.content;return typeof text==='string'?text:undefined;
}
function clipTokens(text:string,limit:number){
  if(limit<=0)return '';if(knowledgeTokens(text)<=limit)return text;
  let low=0,high=text.length;
  while(low<high){const mid=Math.ceil((low+high)/2);if(knowledgeTokens(text.slice(0,mid))<=limit)low=mid;else high=mid-1;}
  return text.slice(0,low).replace(/[\uD800-\uDBFF]$/,'');
}
function webView(id:string,r:Result,body:string,older=false){
  const d=r.data,out:Record<string,unknown>={resultId:id};
  for(const key of ['url','source','sourceUrl','provider','cached','billing','commentsUrl','totalPosts','postsTruncated','imagesTruncated','title','status','coverage','forum','thread','page','totalPages','totalReported','returned','fetchedAt','latestVerified','notice','unavailable','nextPage','textOffset','nextTextOffset','offset','nextOffset','totalCharacters','truncated','totalImages','totalLinks'])if(d[key]!==undefined)out[key]=d[key];
  out[typeof d.text==='string'?'text':'content']=body;
  if(body.length<r.body!.length)out.retainedText={characters:body.length,totalCharacters:r.body!.length,readWith:'read_tool_result',section:'text',offset:body.length};
  // Do not pay for all signed image URLs and repeated per-floor metadata on
  // every model request. They remain addressable without refetching the page.
  out.details=Object.fromEntries(['images','links','posts'].filter(k=>Array.isArray(d[k])).map(k=>[k,{count:d[k].length,section:k}]));
  if(!older){
    if(d.images?.length)out.images=d.images.slice(0,2);
    if(d.links?.length)out.links=d.links.slice(0,6);
  }
  out.readWith='read_tool_result';return out;
}
/** The full results stay in the private trace. This turn's references never cross conversations. */
export class TurnContext {
  private results=new Map<string,Result>();
  private media:{message:ChatMessage;round:number}[]=[];
  result(name:string,id:string,result:unknown,round:number,parts:ChatPart[]=[]):ChatMessage{
    const raw=JSON.stringify(result)??'null',message:ChatMessage={role:'tool',tool_call_id:id,content:raw};
    const saved={message,name,raw,data:result,round,body:webBody(name,result)};
    this.results.set(id,saved);
    if(saved.body!==undefined)message.content=JSON.stringify(webView(id,saved,saved.body));
    if(parts.length){message.content=[{type:'text',text:String(message.content)},...parts];this.images(message,round);}
    return message;
  }
  images(message:ChatMessage,round:number):ChatMessage{this.media.push({message,round});return message;}
  read(args:any){
    if(!args||typeof args.resultId!=='string'||Object.keys(args).some(k=>!['resultId','offset','section'].includes(k))||!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0||args.section!==undefined&&!['text','images','links','posts','raw'].includes(args.section))throw new FishError('INVALID_TOOL_ARGS');
    const result=this.results.get(args.resultId);if(!result)throw new FishError('TOOL_RESULT_NOT_FOUND');
    const section=args.section??(result.body!==undefined?'text':'raw'),offset=args.offset??0;
    if(['images','links','posts'].includes(section)){
      const all=result.data?.[section];if(!Array.isArray(all))throw new FishError('TOOL_RESULT_SECTION_NOT_FOUND');
      const items=all.slice(offset,offset+10);
      return {resultId:args.resultId,tool:result.name,section,items,offset,nextOffset:offset+items.length<all.length?offset+items.length:null,totalItems:all.length};
    }
    const all=section==='raw'?result.raw:result.body;if(all===undefined)throw new FishError('TOOL_RESULT_SECTION_NOT_FOUND');
    const content=all.slice(offset,offset+4000);
    return {resultId:args.resultId,tool:result.name,section,content,offset,nextOffset:offset+content.length<all.length?offset+content.length:null,totalCharacters:all.length};
  }
  compact(round:number){
    let abridgedResults=0,retiredImages=0,remaining=WEB_TEXT_TOKENS;
    for(const [id,r] of [...this.results].reverse()){
      if(r.body!==undefined){
        // Preserve exact readable text across tool rounds instead of replacing
        // it with the beginning of a JSON envelope (which often has no body).
        const body=clipTokens(r.body,remaining);remaining-=knowledgeTokens(body);
        resultText(r,JSON.stringify(webView(id,r,body,round-r.round>=2)));abridgedResults++;continue;
      }
      // Keep native call/result pairs and delivery receipts; older long reads
      // become explicitly labelled excerpts, not fabricated summaries.
      if(round-r.round<2||RECEIPTS.has(r.name)||r.raw.length<=1200)continue;
      if(r.name==='read_tool_result'){
        // Recovered slices are not new documents. Keep their original handle,
        // not another 1000-character copy of an escaped JSON chunk.
        const {resultId,tool,section,offset,nextOffset}=r.data;
        resultText(r,JSON.stringify({resultId,tool,section,offset,nextOffset,previouslyRead:true,readWith:'read_tool_result'}));abridgedResults++;continue;
      }
      resultText(r,JSON.stringify({resultId:id,abridged:true,tool:r.name,preview:r.raw.slice(0,1000),totalCharacters:r.raw.length,readWith:'read_tool_result'}));abridgedResults++;
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
