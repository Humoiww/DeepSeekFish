import { createHash } from 'node:crypto';
import { Store,redact } from '../storage/db.js';
import { FishError,codeOf,type Message,type ModelTool } from '../types.js';
import { ProviderError } from '../diagnostics.js';
import { QQMedia } from './media.js';
import { qqSpeakerLabel,type QQSpeakers } from './speaker.js';
import { hasToolMarkup } from '../agent/tool-protocol.js';

type Handle=NonNullable<Message['forwards']>[number];
type Ref={id:string;conversation:string;root:string;route:string;message_id:string;sender:string;observed:number;title:string};
type ForwardEntry={id:string;messageId:string;forwardedBy:string;receivedAt:number;title:string};
type ForwardReadOptions=QQSpeakers&{quotedMessageIds?:readonly string[]};
type ForwardTransport={readForward(id:string):Promise<unknown[]>;attachmentMessageById?(conversation:string,account:string,messageId:string):Promise<Message>};
const handleId=(x:unknown)=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\s\x00-\x1f]/.test(x)?x:undefined;
const numericId=(x:unknown,pattern:RegExp)=>(typeof x==='string'||typeof x==='number'&&Number.isSafeInteger(x))&&pattern.test(String(x))?String(x):undefined;
const account=(x:unknown)=>numericId(x,/^[1-9]\d{0,19}$/);
const nativeMessageId=(x:unknown)=>numericId(x,/^-?\d{1,20}$/);
const clean=(x:unknown,n=16000)=>redact(typeof x==='string'?x:'').slice(0,n);
/** Only actual merged-chat formats, not arbitrary card URLs or XML instructions. */
export function forwardHandle(segment:any):Handle|undefined{
  const d=segment?.data;
  if(segment?.type==='forward'){
    const id=handleId(d?.id),content=Array.isArray(d?.content)?d.content:Array.isArray(d?.message)?d.message:undefined;
    if(id||content)return {id,content};
  }
  if(segment?.type==='node'&&d&&(Array.isArray(d.content)||Array.isArray(d.message)))return {content:[segment]};
  if(segment?.type==='json'&&typeof d?.data==='string'&&d.data.length<=262144){
    try{const card=JSON.parse(d.data);if(card.app!=='com.tencent.multimsg')return;
      const detail=card.meta?.detail??card.meta?.news??{},id=handleId(detail.resid??detail.resId??detail.uniseq);
      if(id)return {id,title:clean(detail.summary??card.prompt,120)};
    }catch{}
  }
  if(segment?.type==='xml'&&typeof d?.data==='string'&&d.data.length<=262144&&/action=["']viewMultiMsg["']/.test(d.data)){
    const id=handleId(/\bm_resid=["']([^"']+)["']/.exec(d.data)?.[1]);if(id)return {id};
  }
}
export function imageHandle(segment:any):NonNullable<Message['images']>[number]|undefined{
  if(segment?.type!=='image')return;const d=segment.data??{};
  return {stickerHint:Number(d.sub_type)===1,...(typeof d.url==='string'&&d.url.length<=4096?{url:d.url}:{}),
    ...(typeof d.file==='string'&&/^[a-zA-Z0-9_-]{1,128}\.(?:gif|png|jpe?g|webp)$/i.test(d.file)?{file:d.file}:{})};
}
function node(raw:any){
  const n=raw?.type==='node'?raw.data:raw;
  const content=Array.isArray(n?.message)&&n.message.length?n.message:n?.content??n?.message;
  const segments=Array.isArray(content)?content:typeof content==='string'?[{type:'text',data:{text:content}}]:[];
  const actor=account(n?.sender?.user_id),outerActor=account(n?.user_id)??account(n?.uin);
  const qq=actor&&outerActor&&actor!==outerActor?undefined:actor??outerActor;
  const name=clean(n?.sender?.card||n?.sender?.nickname||n?.nickname||n?.name,100).replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  return {sender:{qq,name},nativeId:nativeMessageId(n?.message_id),
    at:Number.isFinite(Number(n?.time))?Number(n.time)*1000:null,originGroup:account(n?.group_id),segments};
}
export const forwardTools:ModelTool[]=[{type:'function',function:{name:'read_forward',description:'读取QQ转发聊天记录。无参数时优先找当前引用的原卡。用messageId指定旧引用的QQ消息，用id打开某张卡，二选一。逐条用speakerLabel标示原发言人，forwardedBy是转发者。offset翻页，长单条用count=1配textOffset续读。',parameters:{type:'object',properties:{id:{type:'string'},messageId:{type:'string',description:'包含转发卡的原QQ消息ID，可用引用对应的ID'},offset:{type:'integer',minimum:0},count:{type:'integer',minimum:1,maximum:10},textOffset:{type:'integer',minimum:0}},additionalProperties:false}}}];

export function requestsForwardAnnotation(text:string):boolean{
  return /^(?:请(?:帮我)?|帮我)?(?:逐条标注(?:说话人|发言人|作者)?|按(?:说话人|发言人|作者)逐条列(?:出来|出|一下))[。！!？?]*$/.test(text.trim());
}

export const readQQQuoteTool:ModelTool={type:'function',function:{
  name:'read_qq_quote',description:'沿当前 QQ 引用 ID 找原消息及它前后几条，回答「这句谁说的」「前后聊了什么」时用。多条引用时传对应 messageId。若原消息是合并转发，继续用 read_forward 打开它。',
  parameters:{type:'object',properties:{messageId:{type:'string'}},additionalProperties:false}
}};

export function requestsQuoteContext(text:string):boolean{
  return /^(?:请|帮我|例如)?(?:看这句和前后|(?:这|那)句(?:话)?(?:是)?谁说的)[。！!？?]*$/.test(text.trim());
}

function originalSpeaker(n:ReturnType<typeof node>,voices:QQSpeakers){
  return qqSpeakerLabel(n.sender.qq,hasToolMarkup(n.sender.name)?undefined:n.sender.name,voices);
}

function transcriptRow(n:ReturnType<typeof node>,voices:QQSpeakers,quotedSpeakers:ReadonlyMap<string,string>){
  const text=n.segments.map((segment:any)=>{
    if(segment?.type==='text')return clean(segment.data?.text);
    if(segment?.type==='reply'){
      const speaker=quotedSpeakers.get(nativeMessageId(segment.data?.id)??'');
      return speaker?'[引用 '+speaker+']':'[引用原话]';
    }
    if(forwardHandle(segment))return '[嵌套转发]';
    if(segment?.type==='image')return '[图片]';
    if(segment?.type==='at')return '[@]';
    if(segment?.type==='file')return '[文件]';
    if(segment?.type==='record')return '[语音]';
    if(segment?.type==='video')return '[视频]';
    return '[附件]';
  }).join('').slice(0,16000);
  const safe=hasToolMarkup(text)?'[工具协议文字已省略]':text||'[空消息]';
  const speaker=originalSpeaker(n,voices);
  return safe.split(/\r\n?|\n|\u2028|\u2029/).map(line=>speaker+'：'+line).join('\n');
}

/** Durable scoped references; signed CDN handles and raw inline nodes stay in RAM. */
export class ForwardRecords {
  private cache=new Map<string,unknown[]>();
  constructor(private store:Store,private qq:ForwardTransport,private allowed:(conversation:string)=>boolean,private media?:QQMedia){
    store.transaction(()=>{
      const backfill=!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='qq_forward_messages' AND type='table'").get();
      store.db.exec(`CREATE TABLE IF NOT EXISTS qq_forwards(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,root TEXT NOT NULL,route TEXT NOT NULL,message_id TEXT NOT NULL,sender TEXT NOT NULL,observed INTEGER NOT NULL,title TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS qq_forwards_scope ON qq_forwards(conversation,observed);
        CREATE TABLE IF NOT EXISTS qq_forward_messages(conversation TEXT NOT NULL,message_id TEXT NOT NULL,position INTEGER NOT NULL,forward_id TEXT NOT NULL,sender TEXT NOT NULL,observed INTEGER NOT NULL,title TEXT NOT NULL,PRIMARY KEY(conversation,message_id,position));`);
      if(backfill)store.db.exec(`INSERT INTO qq_forward_messages
        SELECT conversation,message_id,row_number() OVER (PARTITION BY conversation,message_id ORDER BY id)-1,
        id,sender,observed,title FROM qq_forwards WHERE route='[]'`);
    });
  }
  private key(conversation:string,root:string,route:number[]){return 'forward-'+createHash('sha256').update(JSON.stringify([conversation,root,route])).digest('hex').slice(0,24);}
  private put(ref:Omit<Ref,'id'|'route'>,route:number[]){
    const id=this.key(ref.conversation,ref.root,route);
    this.store.db.prepare('INSERT INTO qq_forwards VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET message_id=excluded.message_id,sender=excluded.sender,observed=excluded.observed,title=excluded.title WHERE excluded.observed>=qq_forwards.observed').run(id,ref.conversation,ref.root,JSON.stringify(route),ref.message_id,ref.sender,ref.observed,ref.title);return id;
  }
  private cacheRoot(id:string,nodes:unknown[]){this.cache.delete(id);this.cache.set(id,nodes);if(this.cache.size>32)this.cache.delete(this.cache.keys().next().value!);}
  /** No network/model/media work here: ordinary groups remain asleep. */
  observe(m:Message):string{
    if(!this.allowed(m.group))throw new FishError('QQ_FORWARD_SCOPE_DENIED');let text=m.text;
    for(const [i,h] of (m.forwards??[]).slice(0,16).entries()){
      const root=handleId(h.id)??'inline:'+m.id+':'+i,title=clean(h.title,120);
      const id=this.put({conversation:m.group,root,message_id:m.id,sender:m.user,observed:m.at,title},[]);
      this.store.db.prepare('INSERT OR IGNORE INTO qq_forward_messages VALUES (?,?,?,?,?,?,?)').run(m.group,m.id,i,id,m.user,m.at,title);
      if(h.content)this.cacheRoot(id,h.content);
      const marker='[转发聊天记录 '+id+']';text=text.includes('[转发聊天记录 '+(i+1)+']')?text.replace('[转发聊天记录 '+(i+1)+']',marker):text+' '+marker;
    }
    return text;
  }
  recent(conversation:string,offset=0,count=3,since=0,until=Number.MAX_SAFE_INTEGER){
    if(!this.allowed(conversation))throw new FishError('QQ_FORWARD_SCOPE_DENIED');
    return this.store.db.prepare("SELECT id,message_id AS messageId,sender AS forwardedBy,observed AS receivedAt,title FROM qq_forwards WHERE conversation=? AND route='[]' AND observed>=? AND observed<=? ORDER BY observed DESC,id LIMIT ? OFFSET ?").all(conversation,since,until,count,offset) as ForwardEntry[];
  }
  byMessage(conversation:string,messageId:string):ForwardEntry[]{
    if(!this.allowed(conversation))throw new FishError('QQ_FORWARD_SCOPE_DENIED');
    return this.store.db.prepare('SELECT forward_id AS id,message_id AS messageId,sender AS forwardedBy,observed AS receivedAt,title FROM qq_forward_messages WHERE conversation=? AND message_id=? ORDER BY position').all(conversation,messageId) as ForwardEntry[];
  }
  private async recover(conversation:string,messageId:string,self:string|undefined,signal?:AbortSignal){
    if(!self||!this.qq.attachmentMessageById)return;
    signal?.throwIfAborted();
    // Reuse the verified OneBot get_msg path. Index only the exact message
    // returned for this allowed conversation and authenticated QQ account.
    let message:Message;
    try{message=await this.qq.attachmentMessageById(conversation,self,messageId);}
    catch(error){throw new ProviderError(codeOf(error),{stage:'lookup_quoted_qq_message'},error);}
    signal?.throwIfAborted();
    if(message.group!==conversation||message.id!==messageId)throw new FishError('QQ_FORWARD_NOT_IN_CONVERSATION');
    if(message.forwards?.length)this.observe(message);
    return message;
  }
  private async quotedCards(conversation:string,messageId:string,self:string|undefined,signal?:AbortSignal){
    const entries=this.byMessage(conversation,messageId);
    if(entries.length)return entries;
    await this.recover(conversation,messageId,self,signal);
    return this.byMessage(conversation,messageId);
  }
  private ref(conversation:string,id:string){
    const ref=this.store.db.prepare('SELECT * FROM qq_forwards WHERE id=? AND conversation=?').get(id,conversation) as Ref|undefined;
    if(!ref)throw new FishError('QQ_FORWARD_NOT_IN_CONVERSATION');
    return ref;
  }
  private async nodes(ref:Ref,self?:string,signal?:AbortSignal){
    const rootId=this.key(ref.conversation,ref.root,[]);let nodes=this.cache.get(rootId);
    let remoteRoot=ref.root;
    if(!nodes&&ref.root.startsWith('inline:')){
      const recovered=await this.recover(ref.conversation,ref.message_id,self,signal);
      const position=Number(ref.root.split(':').at(-1));
      const card=recovered?.forwards?.[position];
      nodes=this.cache.get(rootId)??card?.content;
      const nativeRoot=handleId(card?.id);
      if(!nodes&&!nativeRoot)throw new FishError('QQ_FORWARD_UNAVAILABLE');
      if(nativeRoot)remoteRoot=nativeRoot;
    }
    if(!nodes){
      try{nodes=await this.qq.readForward(remoteRoot);}
      catch(error){throw new ProviderError(codeOf(error),{stage:'read_qq_forward_nodes'},error);}
      this.cacheRoot(rootId,nodes);
    }
    const route=JSON.parse(ref.route) as number[];
    for(let p=0;p<route.length;p+=2){
      const h=forwardHandle(node(nodes[route[p]]).segments[route[p+1]]);if(!h)throw new FishError('QQ_FORWARD_NODE_MISSING');
      nodes=h.content??(h.id?await this.qq.readForward(h.id):undefined);if(!nodes)throw new FishError('QQ_FORWARD_UNAVAILABLE');
    }
    return nodes;
  }
  async annotated(conversation:string,messageId:string,voices:QQSpeakers,signal?:AbortSignal){
    const cards=await this.quotedCards(conversation,messageId,voices.self,signal);
    if(!cards.length)throw new FishError('QQ_QUOTED_FORWARD_UNAVAILABLE');
    const transcripts:string[]=[];
    let entries=0,unknown=0;
    for(const [index,card] of cards.entries()){
      signal?.throwIfAborted();
      const nodes=(await this.nodes(this.ref(conversation,card.id),voices.self,signal)).map(node);
      const quotedSpeakers=new Map(nodes.flatMap(n=>n.nativeId?[[n.nativeId,originalSpeaker(n,voices)] as const]:[]));
      const rows=nodes.map(n=>transcriptRow(n,voices,quotedSpeakers));
      entries+=rows.length;
      unknown+=nodes.filter(n=>!n.sender.qq).length;
      transcripts.push((cards.length>1?'转发卡 '+(index+1)+'\n':'')+rows.join('\n'));
    }
    if(!entries)throw new FishError('QQ_QUOTED_FORWARD_UNAVAILABLE');
    return {text:transcripts.join('\n\n'),cards:cards.length,entries,unknown};
  }
  async read(conversation:string,args:any,signal?:AbortSignal,options:ForwardReadOptions={}){
    if(!this.allowed(conversation))throw new FishError('QQ_FORWARD_SCOPE_DENIED');
    if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['id','messageId','offset','count','textOffset'].includes(k))||
      args.messageId!==undefined&&(typeof args.messageId!=='string'||!nativeMessageId(args.messageId)||args.id!==undefined)||
      !Number.isSafeInteger(args.offset??0)||(args.offset??0)<0||!Number.isSafeInteger(args.count??6)||(args.count??6)<1||(args.count??6)>10||
      !Number.isSafeInteger(args.textOffset??0)||(args.textOffset??0)<0||args.textOffset!==undefined&&(args.count??6)!==1)throw new FishError('INVALID_TOOL_ARGS');
    const offset=args.offset??0,count=args.count??6;
    const quoteIds=args.messageId===undefined?options.quotedMessageIds:[args.messageId];
    const referenced=quoteIds?.length?[] as ForwardEntry[]:undefined;
    for(const messageId of quoteIds??[]){
      const records=args.id===undefined&&options.quotedMessageIds?.includes(messageId)
        ?await this.quotedCards(conversation,messageId,options.self,signal):this.byMessage(conversation,messageId);
      referenced!.push(...records);
    }
    const selectedId=args.id===undefined&&referenced?.length===1?referenced[0].id:args.id;
    if(selectedId===undefined){
      const records=referenced?referenced.slice(offset,offset+count+1):this.recent(conversation,offset,count+1);
      return {context:{source:referenced?'当前引用的QQ合并转发目录':'QQ合并转发记录目录',records:records.slice(0,count),nextOffset:records.length>count?offset+count:null,
        ...(referenced&&!referenced.length?{status:'quoted_forward_unavailable'}:{})},parts:[],mediaIds:[]};
    }
    if(typeof selectedId!=='string')throw new FishError('INVALID_TOOL_ARGS');
    const ref=this.ref(conversation,selectedId);
    const referencedCard=referenced?.find(card=>card.id===selectedId);
    const nodes=(await this.nodes(ref,options.self,signal)).map(node),route=JSON.parse(ref.route) as number[],records:any[]=[],inputs:Message[]=[];
    const speakers=nodes.map(n=>originalSpeaker(n,options));
    const byNativeId=new Map(nodes.flatMap((n,i)=>n.nativeId?[[n.nativeId,i] as const]:[]));
    let chars=0;
    for(let index=offset;index<Math.min(nodes.length,offset+count);index++){
      const n=nodes[index],images:NonNullable<Message['images']>=[],children:any[]=[];let text='',quotedMessageId:string|undefined;
      for(const [si,s] of n.segments.entries()){
        const h=forwardHandle(s),image=imageHandle(s);
        if(h){
          if(route.length>=64){children.push({status:'nesting_limit'});text+='[嵌套记录：层级过深]';}
          else{const id=this.put({...ref,title:clean(h.title,120)},[...route,index,si]);children.push({id,status:'available'});text+='[嵌套转发 '+id+']';}
        }else if(s?.type==='text')text+=clean(s.data?.text);
        else if(image){images.push(image);text+='[图片 '+images.length+']';}
        else if(s?.type==='face')text+='[表情]';
        else if(s?.type==='at')text+='[@'+(account(s.data?.qq)??'全体成员')+']';
        else if(s?.type==='reply'){quotedMessageId??=nativeMessageId(s.data?.id);text+='[引用消息]';}
        else if(s?.type)text+='['+clean(s.type,30)+'：未解析附件]';
        if(text.length>16000){text=text.slice(0,16000);break;}
      }
      const textOffset=args.textOffset??0,excerpt=text.slice(textOffset,textOffset+2000);
      if(records.length&&chars+excerpt.length>6000)break;chars+=excerpt.length;
      const messageId=ref.id+':'+index;
      const quotedIndex=quotedMessageId?byNativeId.get(quotedMessageId):undefined;
      records.push({index,sender:n.sender,speakerLabel:speakers[index],at:n.at,originGroup:n.originGroup,text:excerpt,textOffset,nextTextOffset:textOffset+excerpt.length<text.length?textOffset+excerpt.length:null,children,imageCount:images.length,messageId,
        ...(quotedMessageId?{quotedMessageId,quotedIndex,quotedSpeakerLabel:quotedIndex===undefined?'发言人未确认':speakers[quotedIndex]}:{})});
      if(images.length)inputs.push({id:messageId,group:conversation,user:n.sender.qq??'forwarded',at:Date.now(),text:'',mentioned:false,event:'ordinary',images:images.slice(0,4)});
    }
    const received=this.media?await this.media.ingest(inputs,signal):[];
    for(const record of records)record.images=received.filter(m=>m.messageId===record.messageId);
    const context={source:'QQ合并转发聊天记录',id:ref.id,forwardedBy:referencedCard?.forwardedBy??ref.sender,receivedAt:referencedCard?.receivedAt??ref.observed,quoted:true,total:nodes.length,offset,nextOffset:offset+records.length<nodes.length?offset+records.length:null,records};
    const parts=this.media?this.media.parts(conversation,received):[];
    if(parts.length)parts.unshift({type:'text',text:JSON.stringify({source:'转发记录内的图片',forwardId:ref.id,owners:records.filter(r=>r.images.length).map(r=>({messageId:r.messageId,sender:r.sender,index:r.index}))})});
    return {context,parts,mediaIds:received.flatMap(m=>m.id?[m.id]:[])};
  }
}
