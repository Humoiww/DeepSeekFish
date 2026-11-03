import { createHash } from 'node:crypto';
import { Store,redact } from '../storage/db.js';
import { FishError,type Message,type ModelTool } from '../types.js';
import { QQMedia } from './media.js';

type Handle=NonNullable<Message['forwards']>[number];
type Ref={id:string;conversation:string;root:string;route:string;message_id:string;sender:string;observed:number;title:string};
const handleId=(x:unknown)=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\s\x00-\x1f]/.test(x)?x:undefined;
const account=(x:unknown)=>/^[1-9]\d{0,19}$/.test(String(x??''))?String(x):undefined;
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
  return {sender:{qq:account(n?.sender?.user_id??n?.user_id??n?.uin),name:clean(n?.sender?.card||n?.sender?.nickname||n?.nickname||n?.name,100)},
    at:Number.isFinite(Number(n?.time))?Number(n.time)*1000:null,originGroup:account(n?.group_id),segments};
}
export const forwardTools:ModelTool[]=[{type:'function',function:{name:'read_forward',description:'读取QQ转发聊天记录，与空间动态分开。省略id列出当前会话收到的记录；传id分页读取说话人、文字和图片，嵌套记录用返回的child id继续打开。offset翻页；长消息可count=1配textOffset续读。',parameters:{type:'object',properties:{id:{type:'string'},offset:{type:'integer',minimum:0},count:{type:'integer',minimum:1,maximum:10},textOffset:{type:'integer',minimum:0}},additionalProperties:false}}}];

/** Durable scoped references; signed CDN handles and raw inline nodes stay in RAM. */
export class ForwardRecords {
  private cache=new Map<string,unknown[]>();
  constructor(private store:Store,private qq:{readForward(id:string):Promise<unknown[]>},private allowed:(conversation:string)=>boolean,private media?:QQMedia){
    store.db.exec('CREATE TABLE IF NOT EXISTS qq_forwards(id TEXT PRIMARY KEY,conversation TEXT NOT NULL,root TEXT NOT NULL,route TEXT NOT NULL,message_id TEXT NOT NULL,sender TEXT NOT NULL,observed INTEGER NOT NULL,title TEXT NOT NULL);CREATE INDEX IF NOT EXISTS qq_forwards_scope ON qq_forwards(conversation,observed)');
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
      const root=handleId(h.id)??m.id,id=this.put({conversation:m.group,root,message_id:m.id,sender:m.user,observed:m.at,title:clean(h.title,120)},[]);
      if(h.content)this.cacheRoot(id,h.content);
      const marker='[转发聊天记录 '+id+']';text=text.includes('[转发聊天记录 '+(i+1)+']')?text.replace('[转发聊天记录 '+(i+1)+']',marker):text+' '+marker;
    }
    return text;
  }
  recent(conversation:string,offset=0,count=3,since=0,until=Number.MAX_SAFE_INTEGER){
    if(!this.allowed(conversation))throw new FishError('QQ_FORWARD_SCOPE_DENIED');
    return this.store.db.prepare("SELECT id,message_id AS messageId,sender AS forwardedBy,observed AS receivedAt,title FROM qq_forwards WHERE conversation=? AND route='[]' AND observed>=? AND observed<=? ORDER BY observed DESC,id LIMIT ? OFFSET ?").all(conversation,since,until,count,offset);
  }
  private async nodes(ref:Ref){
    const rootId=this.key(ref.conversation,ref.root,[]);let nodes=this.cache.get(rootId);
    if(!nodes){nodes=await this.qq.readForward(ref.root);this.cacheRoot(rootId,nodes);}
    const route=JSON.parse(ref.route) as number[];
    for(let p=0;p<route.length;p+=2){
      const h=forwardHandle(node(nodes[route[p]]).segments[route[p+1]]);if(!h)throw new FishError('QQ_FORWARD_NODE_MISSING');
      nodes=h.content??(h.id?await this.qq.readForward(h.id):undefined);if(!nodes)throw new FishError('QQ_FORWARD_UNAVAILABLE');
    }
    return nodes;
  }
  async read(conversation:string,args:any,signal?:AbortSignal){
    if(!this.allowed(conversation))throw new FishError('QQ_FORWARD_SCOPE_DENIED');
    if(!args||Array.isArray(args)||Object.keys(args).some(k=>!['id','offset','count','textOffset'].includes(k))||
      !Number.isSafeInteger(args.offset??0)||(args.offset??0)<0||!Number.isSafeInteger(args.count??6)||(args.count??6)<1||(args.count??6)>10||
      !Number.isSafeInteger(args.textOffset??0)||(args.textOffset??0)<0||args.textOffset!==undefined&&(args.count??6)!==1)throw new FishError('INVALID_TOOL_ARGS');
    const offset=args.offset??0,count=args.count??6;
    if(args.id===undefined){const records=this.recent(conversation,offset,count+1);return {context:{source:'QQ合并转发记录目录',records:records.slice(0,count),nextOffset:records.length>count?offset+count:null},parts:[],mediaIds:[]};}
    if(typeof args.id!=='string')throw new FishError('INVALID_TOOL_ARGS');
    const ref=this.store.db.prepare('SELECT * FROM qq_forwards WHERE id=? AND conversation=?').get(args.id,conversation) as Ref|undefined;
    if(!ref)throw new FishError('QQ_FORWARD_NOT_IN_CONVERSATION');
    const nodes=await this.nodes(ref),route=JSON.parse(ref.route) as number[],records:any[]=[],inputs:Message[]=[];
    let chars=0;
    for(let index=offset;index<Math.min(nodes.length,offset+count);index++){
      const n=node(nodes[index]),images:NonNullable<Message['images']>=[],children:any[]=[];let text='';
      for(const [si,s] of n.segments.entries()){
        const h=forwardHandle(s),image=imageHandle(s);
        if(h){
          if(route.length>=64){children.push({status:'nesting_limit'});text+='[嵌套记录：层级过深]';}
          else{const id=this.put({...ref,title:clean(h.title,120)},[...route,index,si]);children.push({id,status:'available'});text+='[嵌套转发 '+id+']';}
        }else if(s?.type==='text')text+=clean(s.data?.text);
        else if(image){images.push(image);text+='[图片 '+images.length+']';}
        else if(s?.type==='face')text+='[表情]';
        else if(s?.type==='at')text+='[@'+(account(s.data?.qq)??'全体成员')+']';
        else if(s?.type==='reply')text+='[引用消息]';
        else if(s?.type)text+='['+clean(s.type,30)+'：未解析附件]';
        if(text.length>16000){text=text.slice(0,16000);break;}
      }
      const textOffset=args.textOffset??0,excerpt=text.slice(textOffset,textOffset+2000);
      if(records.length&&chars+excerpt.length>6000)break;chars+=excerpt.length;
      const messageId=ref.id+':'+index;
      records.push({index,sender:n.sender,at:n.at,originGroup:n.originGroup,text:excerpt,textOffset,nextTextOffset:textOffset+excerpt.length<text.length?textOffset+excerpt.length:null,children,imageCount:images.length,messageId});
      if(images.length)inputs.push({id:messageId,group:conversation,user:n.sender.qq??'forwarded',at:Date.now(),text:'',mentioned:false,event:'ordinary',images:images.slice(0,4)});
    }
    const received=this.media?await this.media.ingest(inputs,signal):[];
    for(const record of records)record.images=received.filter(m=>m.messageId===record.messageId);
    const context={source:'QQ合并转发聊天记录',id:ref.id,forwardedBy:ref.sender,receivedAt:ref.observed,quoted:true,total:nodes.length,offset,nextOffset:offset+records.length<nodes.length?offset+records.length:null,records};
    const parts=this.media?this.media.parts(conversation,received):[];
    if(parts.length)parts.unshift({type:'text',text:JSON.stringify({source:'转发记录内的图片',forwardId:ref.id,owners:records.filter(r=>r.images.length).map(r=>({messageId:r.messageId,sender:r.sender,index:r.index}))})});
    return {context,parts,mediaIds:received.flatMap(m=>m.id?[m.id]:[])};
  }
}
