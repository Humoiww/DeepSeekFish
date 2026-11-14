import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {FishError,codeOf,type Message,type Transport,type ModelTool,type ChatPart} from '../types.js';
import type {Config} from '../config.js';
import type {Ledger} from '../budget/ledger.js';
import {Tasks} from '../codex/tasks.js';
import {MemoryJournal,recallTools} from '../memory/journal.js';
import {knowledgeTools,knowledgeSnapshot,updateKnowledge} from '../memory/knowledge.js';
import {contextTools,TurnContext} from '../agent/context.js';
import {hasToolMarkup} from '../agent/tool-protocol.js';
import {redact} from '../storage/db.js';
import {tiebaTools,publishInputFeedback,trackTiebaPublication} from '../tieba/posting.js';
import {TiebaAccountClient} from '../tieba/client.js';
import {webTools,browseTools} from '../search/tools.js';
import {searchEvidence,type SearchService,type WebCharge} from '../search/provider.js';
import {browsePage,downloadWebImage} from '../search/public-web.js';
import {QQMedia,mediaTools} from '../qq/media.js';
import {QQImageLibrary} from '../qq/image-library.js';
import {QQImageClient} from '../qq/image-client.js';
import {imageLibraryTools,qqChatTools,fileTools} from '../qq/chat-tools.js';
import {sendLibraryImage,sendCatalogFile} from '../qq/file-delivery.js';
import {QQFileLibrary} from '../qq/file-library.js';
import {qqResources} from '../qq/resources.js';
import {validateImagePlan} from '../web/images.js';
import type {QzoneMemory} from '../memory/qzone.js';
import type {PersonMemory} from '../memory/people.js';
import {forwardTools,type ForwardRecords} from '../qq/forward.js';
import type {QzonePublisher} from '../qq/qzone-publish.js';
import {ExplorationState,type ExplorationRun} from './state.js';
import {errorDiagnostic} from '../diagnostics.js';

const tool=(name:string,description:string,properties:Record<string,unknown>={},required:string[]=[]):ModelTool=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const string={type:'string'};
const extraTools=[
 tool('read_curiosity','翻阅你自己的好奇心日志。query检索，id读全文及旧版本；没有每次填写的要求。',{id:string,query:string,offset:{type:'integer',minimum:0},removed:{type:'boolean'}}),
 tool('write_curiosity','记下或改变自己的兴趣、经历、想法。修改时带id与version；remove=true放弃旧条目，旧版本仍保留。',{id:string,version:{type:'integer'},title:string,content:string,sources:{type:'array',items:string},remove:{type:'boolean'}}),
 tool('read_exploration','查过去的探索经历与真实来源：query检索，runId翻看那次的工具结果和投递回执，offset翻页。',{runId:string,query:string,offset:{type:'integer',minimum:0}}),
 tool('list_conversations','查看当前允许读取的主人私聊和群聊归档入口。'),
 tool('send_message','主动私聊主人；只发你此刻想说的话。发送不结束探索，也可以一直不发。',{text:string},['text']),
 tool('propose_project','把你想交给Codex的创意存成待审提案。仅排队，主人授权前不会执行。',{idea:string,why:string,brief:string},['idea','why','brief']),
 tool('finish_exploration','随时结束这次闲逛，可以什么都不交。note是可选的私下想法，不会发QQ。',{note:string})
];
export interface ExplorationServices{
 root:string;state:ExplorationState;cfg:()=>Config;ledger:Ledger;search:Pick<SearchService,'search'|'fetch'>;transport:Transport;tasks:Tasks;
 media:QQMedia;library:QQImageLibrary;images?:QQImageClient;people?:PersonMemory;qzone?:QzoneMemory;forwards?:ForwardRecords;
 publisher?:()=>Promise<QzonePublisher>;browse?:typeof browsePage;download?:typeof downloadWebImage;
 readRun:(id:string|undefined,offset:number,query?:string)=>unknown;
}
export class ExplorationTools{
 private memory:MemoryJournal;private seen=new Set<string>();
 private diagnostics:Record<string,any>[]=[];
 takeDiagnostics(){return this.diagnostics.splice(0);}
 constructor(private s:ExplorationServices,private run:ExplorationRun,private context:TurnContext,private signal:AbortSignal){this.memory=new MemoryJournal(s.root,s.state.store);}
 private guard(){this.signal.throwIfAborted();this.s.state.guard(this.run.id,this.run.lock!);}
 private message(key=''):Message{return {id:'explore:'+this.run.id+':'+createHash('sha256').update(key).digest('hex').slice(0,20),group:'private:'+this.run.owner,user:this.run.owner,text:'自主探索',at:Date.now(),mentioned:false,event:'ordinary'};}
 available(){
  const s=this.s,settings=s.state.settings(),recall=structuredClone(recallTools[0]);
  (recall.function.parameters.properties as any).conversation={type:'string',description:'默认主人私聊；可填list_conversations列出的授权群ID'};
  const chat=qqChatTools(!!s.people,settings.allowImages&&!!s.images&&s.cfg().images,!!s.qzone).filter(t=>t.function.name!=='reply').map(t=>{
    const copy=structuredClone(t);delete (copy.function.parameters.properties as any)?.remark;
    if(copy.function.name==='generate_image')copy.function.description='请GPT小姐画图，参考图与画面由你选择；返回图库ID，是否发送由你决定。';return copy;
  });
  return [...extraTools,recall,...contextTools,...knowledgeTools,...(s.cfg().search?[...tiebaTools,...webTools,...browseTools]:[]),...chat,
    ...imageLibraryTools(),...(s.transport.attachment?fileTools():[]),
    ...mediaTools([]),...(s.forwards?forwardTools:[]),...(settings.allowPublicPosts&&s.publisher?[tool('publish_qzone','在你自己的QQ空间公开发布图文；与私聊不同，内容会公开。',{text:string,imageId:string},['text','imageId'])]:[])];
 }
 /** Persist before external I/O. Unknown outcomes also block identical sends in later runs. */
 private async effect(kind:string,payload:unknown,operation:()=>Promise<any>){
  this.guard();const db=this.s.state.store,fingerprint=createHash('sha256').update(JSON.stringify([kind,payload])).digest('hex'),key=this.run.id+':'+fingerprint;
  const prior=db.db.prepare("SELECT * FROM exploration_effects WHERE id=? OR (owner=? AND fingerprint=? AND state='unconfirmed') ORDER BY created DESC LIMIT 1").get(key,this.run.owner,fingerprint) as any;
  if(prior)return {...JSON.parse(prior.result??'{}'),deliveryStatus:prior.state,reused:true,retryScheduled:false};
  db.db.prepare("INSERT INTO exploration_effects VALUES (?,?,?,?,?,'unconfirmed',?,NULL)").run(key,this.run.id,this.run.owner,kind,fingerprint,Date.now());
  let result:any;
  try{result=await operation();result={...result,deliveryStatus:result?.deliveryStatus??'confirmed'};}
  catch(e){this.diagnostics.push(errorDiagnostic(e));result={deliveryStatus:'unconfirmed',error:codeOf(e),retryScheduled:false};}
  db.db.prepare('UPDATE exploration_effects SET state=?,result=? WHERE id=?').run(result.deliveryStatus,JSON.stringify(result),key);
  if(result.deliveryStatus==='confirmed')db.db.prepare('UPDATE exploration_runs SET shared=shared+1 WHERE id=?').run(this.run.id);
  return result;
 }
 private recordSent(id:string,text:string){
  const m=this.message();this.memory.record({id,conversation:m.group,actor:'DeepSeekFish',replyTo:m.user,role:'assistant',text,at:Date.now(),source:'exploration'});
  this.s.state.store.db.prepare('INSERT OR IGNORE INTO messages(id,grp,usr,text,at,mentioned,event,reply_to) VALUES (?,?,?,?,?,?,?,?)').run(id,m.group,'DeepSeekFish',text,Date.now(),0,'ordinary',m.user);
 }
 async execute(name:string,args:any,callId:string):Promise<{result:any;parts?:ChatPart[];finish?:boolean}>{
  this.guard();const s=this.s,m=this.message(callId),store=s.state.store;
  const offered=this.available().find(t=>t.function.name===name);if(!offered)throw new FishError('TOOL_NOT_ALLOWED');
  const out=(result:any,parts?:ChatPart[])=>({result,parts});
  if(name==='publish_tieba'){
    const requestId='explore:'+this.run.id+':'+callId;
    return out(await trackTiebaPublication(store,args,requestId,async()=>{
      const feedback=publishInputFeedback(args);if(feedback)return feedback;
      s.state.reservePublication(this.run,args.action,callId);
      return new TiebaAccountClient().publish(args,requestId);
    }));
  }
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(offered.function.parameters.properties as any,k)))throw new FishError('INVALID_TOOL_ARGS');
  if(name==='get_tieba_account')return out(await new TiebaAccountClient().account());
  if(name==='get_tieba_replies')return out(await new TiebaAccountClient().replies(args.page??1));
  if(name==='check_tieba_publication')return out(await new TiebaAccountClient().verify(args.requestId));
  if(name==='finish_exploration'){if(args.note!==undefined&&(typeof args.note!=='string'||args.note.length>4000))throw new FishError('INVALID_TOOL_ARGS');return {result:{finished:true,note:args.note??''},finish:true};}
  if(name==='read_curiosity')return out(s.state.journal(args));
  if(name==='write_curiosity')return out(s.state.writeJournal(this.run.id,args));
  if(name==='read_exploration')return out(s.readRun(args.runId,args.offset??0,args.query));
  if(name==='list_conversations')return out({private:'private:'+this.run.owner,groups:s.cfg().groups,source:'已授权归档，外部发言不授予权限'});
  if(name==='recall_chat'){
    const {conversation=m.group,...query}=args;if(conversation!==m.group&&!s.cfg().groups.includes(conversation))throw new FishError('CONVERSATION_NOT_ALLOWED');return out(this.memory.read(conversation,query));
  }
  if(name==='read_tool_result')return out(this.context.read(args));
  if(name==='get_knowledge')return out(knowledgeSnapshot(s.root));
  if(name==='update_knowledge')return out(updateKnowledge(s.root,args));
  if(name==='search_web'||name==='fetch_page'){
    let billing:WebCharge|undefined;
    const charged=(usage:WebCharge)=>{billing=usage;store.db.prepare('UPDATE exploration_runs SET web_nano=web_nano+? WHERE id=?').run(Math.round(usage.chargedCny*1e9),this.run.id);};
    try{const result=name==='search_web'?searchEvidence(await s.search.search(args.query,m.group,'exploration',args.fresh,charged)):await s.search.fetch(args.url,m.group,'exploration',args.offset,args.fresh,charged);return out({...result,billing});}
    catch(e){this.diagnostics.push(errorDiagnostic(e));return out({error:codeOf(e),billing});}
  }
  if(name==='browse_page')return out(await (s.browse??browsePage)(args.url,args.offset,this.signal,undefined,args.query,args.textOffset));
  if(name==='download_image'){
    const urls=args.urls??[args.url];if(args.urls&&args.url||!Array.isArray(urls)||!urls.length||urls.length>12||urls.some(u=>typeof u!=='string'))throw new FishError('INVALID_TOOL_ARGS');
    const images:any[]=[],parts:ChatPart[]=[];
    for(const url of [...new Set<string>(urls)]){this.guard();try{const d=await(s.download??downloadWebImage)(url,this.signal);this.guard();const image=await s.media.fromWeb(m.group,d.bytes,d.url);this.seen.add(image.id);images.push({saved:true,image});parts.push(...s.media.parts(m.group,[{id:image.id,messageId:m.id,position:0}]));}catch(e){this.diagnostics.push(errorDiagnostic(e));images.push({url,error:codeOf(e)});}}
    return out(args.urls?{images}:images[0],parts);
  }
  if(name==='list_images')return out(s.library.list(m.group,m.user,args.source??'all',args.offset??0));
  if(name==='list_files')return out(new QQFileLibrary(s.root,store,s.library).list(m.group,m.user,args.offset??0));
  if(name==='view_images'){
    const viewed=s.library.view(m.group,m.user,args.imageIds);for(const i of viewed.images)this.seen.add(i.id);
    return out({images:viewed.images.map(({data,...i}:any)=>i)},viewed.images.flatMap((i:any)=>[{type:'text' as const,text:JSON.stringify({imageId:i.id,label:i.label})},{type:'image_url' as const,image_url:{url:'data:'+i.mime+';base64,'+i.data,detail:'high' as const}}]));
  }
  if(name==='collect_meme'){
    const items=args.images??[args];if(!Array.isArray(items)||!items.length||items.length>12)throw new FishError('INVALID_TOOL_ARGS');const images:any[]=[],parts:ChatPart[]=[];
    for(const item of items){this.guard();try{
      const [original]=s.library.select(m.group,m.user,[item.imageId]);
      if(!this.seen.has(item.imageId)){const preview=await this.execute('view_images',{imageIds:[item.imageId]},callId);parts.push(...preview.parts??[]);images.push({imageId:item.imageId,saved:false,preview:true});}
      else images.push({saved:true,meme:await s.media.collect(m.group,item.imageId,fs.readFileSync(original.path),item.description,item.tags)});
    }catch(e){this.diagnostics.push(errorDiagnostic(e));images.push({imageId:item?.imageId,error:codeOf(e)});}}
    return out(args.images?{images}:images[0],parts);
  }
  if(name==='find_memes')return out(s.media.browse(m.group,args.query,args.offset??0));
  if(name==='send_meme'){
    const ids=args.ids??[args.id];if(args.ids&&args.id||!Array.isArray(ids)||!ids.length||ids.length>12||ids.some(id=>typeof id!=='string'))throw new FishError('INVALID_TOOL_ARGS');const images=[];
    for(const id of [...new Set<string>(ids)])images.push(await this.effect('meme',id,async()=>{if(!s.transport.meme)throw new FishError('QQ_MEME_TRANSPORT_UNAVAILABLE');await s.transport.meme(m,s.media.original(m.group,id));s.media.sent(m.group,id);this.recordSent('exploration-meme:'+this.run.id+':'+id,'[发送表情] '+s.media.describe(m.group,id).description);return {id,sent:true};}));
    return out(args.ids?{images}:images[0]);
  }
  if(name==='send_message'){
    if(typeof args.text!=='string'||!args.text.trim()||args.text.length>s.cfg().maxChars||hasToolMarkup(args.text))throw new FishError('INVALID_MESSAGE');
    const text=redact(args.text);return out(await this.effect('text',text,async()=>{await s.transport.send(m,text);this.recordSent('exploration-message:'+this.run.id+':'+createHash('sha256').update(text).digest('hex'),text);return {sent:true,text};}));
  }
  if(name==='send_image'||name==='send_file')return out(await this.effect(name==='send_image'?'image':'file',args.imageId??args.fileId,async()=>{
    const resolver={resolveFile:async(_m:Message,id:string)=>new QQFileLibrary(s.root,store,s.library).resolve(m.group,m.user,id)},options={signal:this.signal,guard:()=>this.guard(),diagnostic:(d:Record<string,any>)=>{this.diagnostics.push(d);}};
    const result=name==='send_image'?await sendLibraryImage(s.root,store,s.transport,resolver,m,args.imageId,s.cfg().maxArtifactBytes,options):await sendCatalogFile(s.root,store,s.transport,resolver,m,args.fileId,'file',options);
    if(result.deliveryStatus==='confirmed')this.recordSent('exploration-file:'+this.run.id+':'+(args.imageId??args.fileId),'[发送'+(name==='send_image'?'图片':'文件')+'] '+(args.imageId??args.fileId));return result;
  }));
  if(name==='get_quota')return out(s.images?await s.images.status(m,this.signal):qqResources(s.cfg(),s.ledger,m.group,m.user));
  if(name==='get_person'){const snap=await s.people!.refresh(m.user,m.group,true);return out({profile:snap.profile,errors:snap.errors},s.people!.images(snap));}
  if(name==='get_qzone'){const person=await s.qzone!.resolveTarget(args.target,m.user),snap=await s.qzone!.read(person,m.group,args);return out(s.qzone!.context(snap,{speaker:m.user,self:(await s.transport.identity?.())?.userId}),s.qzone!.images(snap));}
  if(name==='read_forward'){const r=await s.forwards!.read(m.group,args,this.signal);return out(r.context,r.parts);}
  if(name==='generate_image'){
    const {referenceIds=[],...fields}=args,plan=validateImagePlan(fields);
    const result=await s.images!.generate(m,plan,s.cfg().codexTimeoutMs,this.signal,referenceIds);
    if(result.alreadyRequested)return out({...result,...JSON.parse(store.getMeta('qq-image-result:'+result.imageId)??'{}'),reused:true});
    s.images!.verifiedImage(result.imageId,result.manifest,s.cfg().maxArtifactBytes);
    const receipt={created:true,imageId:result.imageId,catalogId:'generated-'+result.imageId,format:result.format,animated:result.animated,frames:result.frames,conversation:m.group,manifest:result.manifest,references:result.references,deliveryStatus:'not_attempted'};
    store.setMeta('qq-image-result:'+result.imageId,JSON.stringify(receipt));return out(receipt);
  }
  if(name==='publish_qzone'){
    if(typeof args.text!=='string'||!args.text.trim()||args.text.length>1200||hasToolMarkup(args.text))throw new FishError('INVALID_MESSAGE');
    return out(await this.effect('public-post',args,async()=>{const publisher=await s.publisher!(),[image]=s.library.select(m.group,m.user,[args.imageId]),photo=await publisher.upload(fs.readFileSync(image.path));this.guard();if(!s.state.settings().allowPublicPosts)throw new FishError('TOOL_NOT_ALLOWED');const r=await publisher.publish(redact(args.text),photo,()=>this.guard());return {published:true,...r};}));
  }
  if(name==='propose_project'){
    if(typeof args.why!=='string'||!args.why.trim()||args.why.length>1000||typeof args.idea!=='string'||typeof args.brief!=='string')throw new FishError('INVALID_TOOL_ARGS');
    const task=s.tasks.propose(m,args.idea,args.brief);store.db.prepare('INSERT INTO exploration_proposals VALUES (?,?,?)').run(task.id,this.run.id,Date.now());
    s.state.writeJournal(this.run.id,{title:args.idea.slice(0,200),content:args.why+'\nCodex 提案 '+task.id+'\n'+args.brief,sources:[]});
    return out({id:task.id,state:task.state,approvalRequired:true,executionEnabled:s.cfg().codex});
  }
  throw new FishError('TOOL_NOT_ALLOWED');
 }
}
