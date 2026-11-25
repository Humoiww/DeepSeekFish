import {qqSpeakerLabel,type QQSpeakers} from '../qq/speaker.js';
import {maxVisionInputTokens} from './model.js';
import {modelTimeJson,projectTime} from '../time.js';
import { knowledgeTokens } from '../memory/knowledge.js';
import {ProviderError} from '../diagnostics.js';
import {tiebaTextPosts} from '../search/tieba.js';
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

export const dialogueTime=(at:number)=>projectTime(Math.floor(at/1000)*1000);
/** Preserve chronology/provenance instead of presenting yesterday as an undated pending request. */
export function dialogueMessages(dialogue:Message[],batch:Message[],voices?:QQSpeakers):ChatMessage[]{
  if(voices)return labelledDialogue(dialogue,batch,voices);
  const current=new Set(batch.map(m=>m.id));
  return dialogue.map(m=>({role:m.user==='DeepSeekFish'?'assistant':'user',content:
    '['+dialogueTime(m.at)+(current.has(m.id)?' · 本轮消息':m.id.startsWith('daily-news:')?' · 早间新闻':'')+'] '+
    (m.user==='DeepSeekFish'?(m.replyTo?'[回复 QQ '+m.replyTo+'] ':''):
      '[QQ '+m.user+(m.sender?' '+JSON.stringify(m.sender):'')+'] ')+m.text}));
}

export const contextTools:ModelTool[]=[{type:'function',function:{name:'read_tool_result',description:'取回本轮工具资料；网页默认只读正文。section可选text/images/links/posts/replies/raw，offset按回执续读；数组按条、文字按字符。不重新联网。',parameters:{type:'object',properties:{resultId:{type:'string'},section:{type:'string',enum:['text','images','links','posts','replies','records','events','raw']},offset:{type:'integer',minimum:0}},required:['resultId'],additionalProperties:false}}}];
const RECEIPTS=new Set(['generate_image','generate_video','send_image','send_file','send_meme','collect_meme','remember_images','reply','publish_qzone','publish_tieba','apply_tieba_moderator','check_tieba_publication','draft_daily_post']);
const WEB_TEXT_TOKENS=4000;
const CONTEXT_HIGH_WATER=48000;
type Result={message:ChatMessage;name:string;raw:string;data:any;round:number;body?:string};
function chatSection(result:Result){
  if(result.name==='read_forward'&&Array.isArray(result.data?.records))return 'records';
  if(result.name==='recall_chat'&&Array.isArray(result.data?.events))return 'events';
}
function previewChatEntry(entry:any,length:number){
  const {text,images:_images,...metadata}=entry;
  return typeof text==='string'?{...metadata,text:text.slice(0,length),...(text.length>length?{textTruncated:true}:{})}:metadata;
}
function resultText(result:Result,text:string){
  // A tool may carry original images. Updating its text must keep those images
  // attached to the same tool_call_id, never turn them into a new user turn.
  const content=result.message.content;
  result.message.content=Array.isArray(content)?[{type:'text',text},...content.slice(1)]:text;
}
// Tieba repeats its canonical text in the per-floor posts. Those duplicate
// fields must not hide the readable body. Structured social feeds without a
// forum keep their posts view because their top-level text is only a notice.
function webBody(name:string,data:any):string|undefined{
  if(!['browse_page','fetch_page'].includes(name)||!data||typeof data!=='object')return;
  if(!data.forum&&Array.isArray(data.posts)&&data.posts.some((p:any)=>typeof p?.content==='string'||typeof p?.text==='string'))return;
  const text=data.text??data.content;return typeof text==='string'?text:undefined;
}
function clipTokens(text:string,limit:number,cost=knowledgeTokens){
  if(limit<=0)return '';if(cost(text)<=limit)return text;
  let low=0,high=text.length;
  while(low<high){const mid=Math.ceil((low+high)/2);if(cost(text.slice(0,mid))<=limit)low=mid;else high=mid-1;}
  return text.slice(0,low).replace(/[\uD800-\uDBFF]$/,'');
}
function webView(id:string,r:Result,body:string,older=false){
  const d=r.data,out:Record<string,unknown>={resultId:id};
  for(const key of ['error','stage','providerCode','providerMessage','httpStatus','url','source','sourceUrl','provider','cached','billing','access','commentsUrl','totalPosts','postsTruncated','imagesTruncated','title','status','coverage','forum','thread','parentPost','target','platformNotice','page','totalPages','totalReported','returned','fetchedAt','latestVerified','notice','unavailable','nextPage','textOffset','nextTextOffset','offset','nextOffset','totalCharacters','truncated','totalImages','totalLinks'])if(d[key]!==undefined)out[key]=d[key];
  const posts=tiebaTextPosts(d,body);
  if(posts){
    out.posts=posts;
    if(d.parentPost)out.parentPost={id:d.parentPost.id,floor:d.parentPost.floor,author:d.parentPost.author,replyTarget:d.parentPost.replyTarget};
  }else out[typeof d.text==='string'?'text':'content']=body;
  if(body.length<r.body!.length)out.retainedText={characters:body.length,totalCharacters:r.body!.length,readWith:'read_tool_result',section:'text',offset:body.length};
  // Do not pay for all signed image URLs and repeated per-floor metadata on
  // every model request. They remain addressable without refetching the page.
  out.details=Object.fromEntries(['images','links','posts'].filter(k=>Array.isArray(d[k])).map(k=>[k,{count:d[k].length,section:k}]));
  if(!older){
    if(r.name==='browse_page'&&d.externalPeople)out.externalPeople=d.externalPeople;
    if(!posts&&d.forum&&d.posts?.some((p:any)=>typeof p.replyTarget==='string'))out.replyTargets=Object.fromEntries(d.posts.filter((p:any)=>typeof p.replyTarget==='string').map((p:any)=>[p.id,p.replyTarget]));
    if(d.images?.length)out.images=d.images.slice(0,2);
    if(d.links?.length)out.links=d.links.slice(0,6);
  }
  out.readWith='read_tool_result';return out;
}
/** The full results stay in the private trace. This turn's references never cross conversations. */
export class TurnContext {
  private results=new Map<string,Result>();
  private retired=new WeakSet<ChatMessage>();
  private media:{message:ChatMessage;round:number}[]=[];
  result(name:string,id:string,result:unknown,round:number,parts:ChatPart[]=[]):ChatMessage{
    const raw=modelTimeJson(result)??'null',message:ChatMessage={role:'tool',tool_call_id:id,content:raw};
    const saved:Result={message,name,raw,data:result,round,body:webBody(name,result)};
    this.results.set(id,saved);
    if(saved.body!==undefined){
      const cost=(text:string)=>{
        const posts=tiebaTextPosts(saved.data,text);
        return knowledgeTokens(posts?.length?modelTimeJson(posts):text);
      };
      message.content=modelTimeJson(webView(id,saved,clipTokens(saved.body,WEB_TEXT_TOKENS,cost)));
    }else if(raw.length>1200&&(chatSection(saved)||name==='read_qq_quote')){
      message.content=this.transcriptPreview(id,saved);
    }else if(!RECEIPTS.has(name)&&name!=='read_tool_result'&&knowledgeTokens(raw)>WEB_TEXT_TOKENS){
      if(name==='get_tieba_replies'&&Array.isArray(saved.data?.replies)){
        const {replies,...page}=saved.data;
        message.content=modelTimeJson({...page,replies:replies.slice(0,4),totalItems:replies.length,
          resultId:id,section:'replies',nextOffset:replies.length>4?4:null,readWith:'read_tool_result'});
      }else{
        message.content=this.excerpt(id,saved,WEB_TEXT_TOKENS-140);
      }
    }
    if(parts.length){message.content=[{type:'text',text:String(message.content)},...parts];this.images(message,round);}
    return message;
  }
  images(message:ChatMessage,round:number):ChatMessage{this.media.push({message,round});return message;}
  read(args:any){
    if(!args||typeof args.resultId!=='string'||Object.keys(args).some(k=>!['resultId','offset','section'].includes(k))||!Number.isSafeInteger(args.offset??0)||(args.offset??0)<0||args.section!==undefined&&!['text','images','links','posts','replies','records','events','raw'].includes(args.section))throw new FishError('INVALID_TOOL_ARGS');
    const result=this.results.get(args.resultId);if(!result)throw new ProviderError('TOOL_RESULT_NOT_FOUND',{stage:'lookup_tool_result',resultId:args.resultId});
    const section=args.section??(chatSection(result)??(result.body!==undefined?'text':'raw')),offset=args.offset??0;
    const body=result.body??result.data?.text??result.data?.content;
    const availableSections=['raw',...(typeof body==='string'?['text']:[]),...['images','links','posts','replies','records','events'].filter(k=>Array.isArray(result.data?.[k]))];
    if(!availableSections.includes(section))throw new ProviderError('TOOL_RESULT_SECTION_NOT_FOUND',{stage:'read_result_section',resultId:args.resultId,operation:result.name,section,availableSections});
    if(['images','links','posts','replies','records','events'].includes(section)){
      const all=result.data[section];
      const items=all.slice(offset,offset+(section==='records'||section==='events'?2:10));
      return {resultId:args.resultId,tool:result.name,section,items,offset,nextOffset:offset+items.length<all.length?offset+items.length:null,totalItems:all.length};
    }
    const all:string=section==='raw'?result.raw:body;
    const content=all.slice(offset,offset+4000);
    const posts=section==='text'?tiebaTextPosts(result.data,content,offset):undefined;
    return {resultId:args.resultId,tool:result.name,section,posts,content:posts?undefined:content,offset,nextOffset:offset+content.length<all.length?offset+content.length:null,totalCharacters:all.length};
  }
  private transcriptPreview(id:string,result:Result){
    const transcript=chatSection(result);
    if(transcript){
      const {[transcript]:entries,...receipt}=result.data;
      const length=Math.min(160,Math.floor(1000/Math.max(entries.length,1)));
      return modelTimeJson({...receipt,[transcript]:entries.map((entry:any)=>previewChatEntry(entry,length)),
        abridged:true,resultId:id,section:transcript,readWith:'read_tool_result'});
    }
    const {target,before,after,...receipt}=result.data;
    return modelTimeJson({...receipt,target:target?previewChatEntry(target,300):undefined,
      before:before?.map((entry:any)=>previewChatEntry(entry,100)),after:after?.map((entry:any)=>previewChatEntry(entry,100)),
      abridged:true,resultId:id,readWith:'read_tool_result'});
  }
  private excerpt(id:string,result:Result,limit:number){
    return JSON.stringify({resultId:id,abridged:true,tool:result.name,preview:clipTokens(result.raw,limit),
      totalCharacters:result.raw.length,readWith:'read_tool_result'});
  }
  compact(round:number,messages:ChatMessage[]=[],tools:ModelTool[]=[]){
    let abridgedResults=0,retiredImages=0;
    const included=new Set(messages);
    const metrics=contextMetrics(messages,tools);
    if(metrics.totalTextTokens+metrics.images*maxVisionInputTokens<=CONTEXT_HIGH_WATER){
      return {abridgedResults,retiredImages};
    }
    for(const [id,result] of this.results){
      if(round-result.round<=4||!included.has(result.message)||this.retired.has(result.message)||RECEIPTS.has(result.name))continue;
      const content=result.message.content;
      const text=typeof content==='string'?content:content[0]?.type==='text'?content[0].text:'';
      if(knowledgeTokens(text)<=650)continue;
      if(result.body!==undefined){
        resultText(result,modelTimeJson(webView(id,result,clipTokens(result.body,500),true)));
      }else if(chatSection(result)||result.name==='read_qq_quote'){
        resultText(result,this.transcriptPreview(id,result));
      }else if(result.name==='read_tool_result'){
        const {resultId,tool,section,offset,nextOffset}=result.data;
        resultText(result,JSON.stringify({resultId,tool,section,offset,nextOffset,previouslyRead:true,readWith:'read_tool_result'}));
      }else{
        resultText(result,this.excerpt(id,result,500));
      }
      this.retired.add(result.message);
      abridgedResults++;
    }
    for(const item of this.media){
      if(round-item.round<=4||!included.has(item.message)||typeof item.message.content==='string')continue;
      const images=item.message.content.filter(part=>part.type==='image_url').length;
      if(!images)continue;
      retiredImages+=images;
      item.message.content=[...item.message.content.filter(part=>part.type==='text'),
        {type:'text',text:'已看过的原图已收起；需要重看可通过图库工具按图片ID取回。'}];
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

function labelledDialogue(dialogue:Message[],batch:Message[],voices:QQSpeakers={}):ChatMessage[]{
  const current=new Set(batch.map(m=>m.id));
  return dialogue.map(m=>({role:m.user==='DeepSeekFish'?'assistant':'user',content:
    '['+dialogueTime(m.at)+(current.has(m.id)?' · 本轮消息':m.id.startsWith('daily-news:')?' · 早间新闻':'')+'] '+
    '[说话人：'+qqSpeakerLabel(m.user,m.sender?.card??m.sender?.nickname,voices)+'] '+
    (m.user==='DeepSeekFish'?(m.replyTo?'[收件人 QQ '+m.replyTo+'] ':''):
      '[QQ '+m.user+(m.sender?' '+JSON.stringify(m.sender):'')+'] ')+
    (m.quotedMessageId?'[引用 QQ 消息 ID '+m.quotedMessageId+'] ':'')+m.text}));
}
