import {externalPeopleTool,type ExternalPeople} from '../memory/external-people.js';
import {allowedTiebaTools,SharedTools,imageToolPlan,memeToolIds,validateToolArguments,readCuriosityTool,listConversationsTool} from '../agent/shared-tools.js';
import {sendFailure,toolFailure} from '../agent/tool-feedback.js';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {FishError,codeOf,type Message,type Transport,type ModelTool,type ChatPart} from '../types.js';
import type {Config} from '../config.js';
import type {Ledger} from '../budget/ledger.js';
import {Tasks} from '../codex/tasks.js';
import {MemoryJournal,recallTools} from '../memory/journal.js';
import {memoryIndexTools} from '../memory/index.js';
import {activityChainStatusReceipt,activityChainStatusTool} from '../qq/activity-chain.js';
import {knowledgeTools} from '../memory/knowledge.js';
import {contextTools,TurnContext} from '../agent/context.js';
import {hasToolMarkup} from '../agent/tool-protocol.js';
import type {PromptNumberGuard} from '../agent/prompt-numbers.js';
import {redact} from '../storage/db.js';
import type {TiebaAccountClient} from '../tieba/client.js';
import {webTools,browseTools} from '../search/tools.js';
import type {SearchService} from '../search/provider.js';
import type {browsePage,downloadWebImage,PublicPoster} from '../search/public-web.js';
import {reportTiebaConflictTool,TiebaConflictReports} from '../tieba/conflict-report.js';
import {BIG_FISH_FORUM} from '../tieba/sections.js';
import {QQMedia,mediaTools} from '../qq/media.js';
import {QQImageLibrary} from '../qq/image-library.js';
import {QQImageClient} from '../qq/image-client.js';
import {imageLibraryTools,qqChatTools,fileTools} from '../qq/chat-tools.js';
import {sendLibraryImage,sendCatalogFile} from '../qq/file-delivery.js';
import {QQFileLibrary} from '../qq/file-library.js';
import {qqResources} from '../qq/resources.js';
import type {QzoneMemory} from '../memory/qzone.js';
import type {PersonMemory} from '../memory/people.js';
import {forwardTools,type ForwardRecords} from '../qq/forward.js';
import type {QzonePublisher} from '../qq/qzone-publish.js';
import {ExplorationState,type ExplorationRun} from './state.js';
import {errorDiagnostic} from '../diagnostics.js';

const tool=(name:string,description:string,properties:Record<string,unknown>={},required:string[]=[]):ModelTool=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const string={type:'string'};
const extraTools=[
 readCuriosityTool,
 tool('write_curiosity','保存或修订自主探索的兴趣笔记。',{id:string,version:{type:'integer'},title:string,content:string,sources:{type:'array',items:string},remove:{type:'boolean'}}),
 tool('read_exploration','查过去的探索经历与真实来源：query检索，runId翻看那次的工具结果和投递回执，offset翻页。',{runId:string,query:string,offset:{type:'integer',minimum:0}}),
 listConversationsTool,
 tool('send_message','主动私聊主人；只发你此刻想说的话。发送不结束探索，也可以一直不发。',{text:string},['text']),
 tool('propose_project','把你想交给Codex的创意存成待审提案。仅排队，主人授权前不会执行。',{idea:string,why:string,brief:string},['idea','why','brief']),
 tool('finish_exploration','手上的事办完了，或这次只是闲逛，想休息就调用。可以传空对象，note是可选的小记，不会发QQ。',{note:string})
];
export interface ExplorationServices{
 root:string;state:ExplorationState;cfg:()=>Config;ledger:Ledger;search:Pick<SearchService,'search'|'fetch'>;transport:Transport;tasks:Tasks;
 media:QQMedia;library:QQImageLibrary;images?:QQImageClient;people?:PersonMemory;qzone?:QzoneMemory;forwards?:ForwardRecords;externalPeople?:ExternalPeople;
 publisher?:()=>Promise<QzonePublisher>;browse?:typeof browsePage;download?:typeof downloadWebImage;tieba?:TiebaAccountClient;poster?:PublicPoster;
 readRun:(id:string|undefined,offset:number,query?:string)=>unknown;
}
export type ExplorationToolRun=Pick<ExplorationRun,'id'|'owner'|'trigger'|'lock'>;
export class ExplorationTools{
 private memory:MemoryJournal;private seen=new Set<string>();
 private shared:SharedTools;
 private tiebaCapabilities:ModelTool[]=[];
 private identity:{speaker:string;self?:string};
 private toolsLoaded=false;
 private diagnostics:Record<string,any>[]=[];
 rememberInbox<T>(page:T){
  try{this.guard();return this.s.externalPeople?.incoming(this.run.owner,page)??page;}
  catch(error){this.diagnostics.push(errorDiagnostic(error));return page;}
 }
 takeDiagnostics(){return this.diagnostics.splice(0);}
 constructor(private s:ExplorationServices,private run:ExplorationToolRun,private context:TurnContext,private signal:AbortSignal,private runGuard:()=>void=()=>s.state.guard(run.id,run.lock!)){
  this.memory=new MemoryJournal(s.root,s.state.store);
  this.identity={speaker:run.owner};
  this.shared=new SharedTools({
   root:s.root,store:s.state.store,memory:this.memory,context,signal,account:s.tieba,cfg:s.cfg,
   search:s.search,searchEnabled:()=>s.cfg().search,searchActor:'exploration',browse:s.browse,download:s.download,
   externalPeople:s.externalPeople,media:s.media,library:s.library,people:s.people,forwards:s.forwards,qzone:s.qzone,identity:this.identity,
   memoryOrigin:(run.trigger==='activity_chain'?'chain:':'run:')+run.id,
   allowedRecall:conversation=>s.cfg().groups.includes(conversation),
   charge:usage=>s.state.store.db.prepare('UPDATE exploration_runs SET web_nano=web_nano+? WHERE id=?').run(Math.round(usage.chargedCny*1e9),run.id),
   guard:()=>this.guard(),onDiagnostic:error=>this.diagnostics.push(error),
   reservePublication:(input,callId)=>s.state.reservePublication(run,input,callId),
   view:(message,ids)=>s.library.view(message.group,message.user,ids),
   listImages:(message,source,offset)=>s.library.list(message.group,message.user,source,offset),
   listFiles:(message,offset)=>new QQFileLibrary(s.root,s.state.store,s.library).list(message.group,message.user,offset),
  });
 }
 async prepare(){
  if(this.toolsLoaded)return;
  this.identity.self=(await this.s.transport.identity?.().catch(()=>undefined))?.userId;
  if(this.s.cfg().search)this.tiebaCapabilities=await allowedTiebaTools(this.shared.account);
  this.toolsLoaded=true;
 }
 get self(){return this.identity.self;}
 private guard(){this.signal.throwIfAborted();this.runGuard();}
 publicationRequestId(args:any,callId:string){
  if(this.run.trigger!=='activity_chain')return 'explore:'+this.run.id+':'+callId;
  const content=args&&typeof args==='object'?JSON.stringify(args,Object.keys(args).sort()):JSON.stringify(args??null);
  return 'chain:'+this.run.id+':'+createHash('sha256').update(content).digest('hex');
 }
 private message(key=''):Message{return {id:'explore:'+this.run.id+':'+createHash('sha256').update(key).digest('hex').slice(0,20),group:'private:'+this.run.owner,user:this.run.owner,text:'自主探索',at:Date.now(),mentioned:false,event:'ordinary'};}
 available(){
  const s=this.s,settings=s.state.settings(),recall=structuredClone(recallTools[0]);
  if(s.cfg().groupChatSearch)(recall.function.parameters.properties as any).conversation={type:'string',description:'默认主人私聊；可填list_conversations列出的授权群ID'};
  const chat=qqChatTools(!!s.people,settings.allowImages&&!!s.images&&s.cfg().images,!!s.qzone,'background').filter(t=>t.function.name!=='reply').map(t=>{
    const copy=structuredClone(t);delete (copy.function.parameters.properties as any)?.remark;
    if(copy.function.name==='generate_image')copy.function.description='请GPT小姐画图，参考图与画面由你选择；返回图库ID，是否发送由你决定。';return copy;
  });
  return [...extraTools.filter(t=>t.function.name!=='read_curiosity'||s.cfg().curiosityPublicSearch).filter(t=>t.function.name!=='list_conversations'||s.cfg().groupChatSearch),recall,...(s.externalPeople?[externalPeopleTool]:[]),...contextTools,...knowledgeTools,...(s.cfg().search?[...this.tiebaCapabilities,...webTools,...browseTools,reportTiebaConflictTool]:[]),...chat,
    activityChainStatusTool,...memoryIndexTools,...imageLibraryTools(),...(s.transport.attachment?fileTools():[]),
    ...mediaTools([]),...(s.forwards?forwardTools:[]),...(settings.allowPublicPosts&&s.publisher?[tool('publish_qzone','在你自己的QQ空间公开发布图文；与私聊不同，内容会公开。',{text:string,imageId:string},['text','imageId'])]:[])];
 }
 /** Persist the uncertain state at dispatch. Local preparation has no external effect. */
 private async effect(kind:string,payload:unknown,operation:(dispatch:()=>void,received:(result:any)=>void)=>Promise<any>){
  this.guard();const db=this.s.state.store,fingerprint=createHash('sha256').update(JSON.stringify([kind,payload])).digest('hex'),key=this.run.id+':'+fingerprint;
  const prior=db.db.prepare("SELECT state,result FROM exploration_effects WHERE (id=? AND state='confirmed') OR (owner=? AND fingerprint=? AND state='unconfirmed') ORDER BY created DESC LIMIT 1").get(key,this.run.owner,fingerprint) as any;
  if(prior)return {...JSON.parse(prior.result??'{}'),deliveryStatus:prior.state,reused:true,retryScheduled:false};
  let dispatched=false,ack:any;
  const persist=(result:any)=>db.db.prepare("INSERT INTO exploration_effects VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,result=excluded.result").run(key,this.run.id,this.run.owner,kind,fingerprint,result.deliveryStatus,Date.now(),JSON.stringify(result));
  const dispatch=()=>{this.guard();persist({deliveryStatus:'unconfirmed',submissionStatus:'unknown',retryScheduled:false});dispatched=true;};
  const received=(result:any)=>{ack=result;db.transaction(()=>{persist(result);if(result.deliveryStatus==='confirmed')db.db.prepare('UPDATE exploration_runs SET shared=shared+1 WHERE id=?').run(this.run.id);});};
  try{
   const result=await operation(dispatch,received);
   if(!ack)received({...result,deliveryStatus:result.deliveryStatus??'confirmed'});
   return ack;
  }catch(e){
   this.diagnostics.push(errorDiagnostic(e));if(ack)return {...ack,recordError:toolFailure(e,'record_delivery')};
   const failure=sendFailure(e,kind,dispatched?'dispatch':'before');persist(failure);return failure;
  }
 }
 private recordSent(id:string,text:string){
  const m=this.message();this.memory.record({id,conversation:m.group,actor:'DeepSeekFish',replyTo:m.user,role:'assistant',text,at:Date.now(),source:'exploration'});
  this.s.state.store.db.prepare('INSERT OR IGNORE INTO messages(id,grp,usr,text,at,mentioned,event,reply_to) VALUES (?,?,?,?,?,?,?,?)').run(id,m.group,'DeepSeekFish',text,Date.now(),0,'ordinary',m.user);
 }
 async execute(name:string,args:any,callId:string,privacy?:PromptNumberGuard):Promise<{result:any;parts?:ChatPart[];finish?:boolean}>{
  this.guard();const s=this.s,m=this.message(callId),store=s.state.store;
  const offered=this.available().find(t=>t.function.name===name);if(!offered)throw new FishError('TOOL_NOT_ALLOWED');
  const out=(result:any,parts?:ChatPart[])=>({result,parts});
  const shared=await this.shared.execute(offered,args,m,callId,()=>name==='publish_tieba'
   ? this.publicationRequestId(args,callId):'explore:'+this.run.id+':'+callId);
  if(shared){
   for(const id of shared.viewedIds??[])this.seen.add(id);
   return shared;
  }
  validateToolArguments(offered,args);
  if(name==='report_tieba_conflict'){
   s.state.assertOwner(this.run.owner);
   const reports=new TiebaConflictReports(store,{poster:s.poster}),prepared=await reports.prepare(args,s.cfg().maxChars,this.signal);
   if(!prepared.ready)return out(prepared.result);
   this.guard();s.state.assertOwner(this.run.owner);
   if(!s.cfg().search)throw new FishError('TOOL_NOT_ALLOWED');
   const report=prepared.report;
   const reservation=reports.reserve(this.run.owner,report,()=>{
    privacy?.text(report.message);
    if(hasToolMarkup(report.message)||report.message.length>s.cfg().maxChars)throw new FishError('INVALID_MESSAGE');
   });
   if(reservation.duplicate)return out(reservation.result);
   const details={threadId:report.threadId,url:report.url,forum:BIG_FISH_FORUM,escalation:report.escalation};
   const result=await this.effect('tieba-conflict',{reportId:reservation.id,...details,text:report.message},async(dispatch,received)=>{
    s.state.assertOwner(this.run.owner);dispatch();await s.transport.send(m,report.message);
    const receipt={...details,reported:true,sent:true,text:report.message,deliveryStatus:'confirmed'};
    received(receipt);reports.record(reservation.id,receipt);this.recordSent('tieba-conflict:'+reservation.id,report.message);return receipt;
   });
   reports.record(reservation.id,result);
   return out({...details,reported:false,sent:false,...result});
  }
  if(name==='finish_exploration'){if(args.note!==undefined&&(typeof args.note!=='string'||args.note.length>4000))throw new FishError('INVALID_TOOL_ARGS');return {result:{finished:true,note:args.note??''},finish:true};}
  if(name==='write_curiosity')return out(s.state.writeJournal(this.run.id,args));
  if(name==='read_exploration')return out(s.readRun(args.runId,args.offset??0,args.query));
  if(name==='activity_chain_status')return out(activityChainStatusReceipt(store,this.run.owner,args));
  if(name==='collect_meme'){
   const collected=await this.shared.collectMemes(args,m,id=>this.seen.has(id));
   for(const id of collected.viewedIds??[])this.seen.add(id);
   return collected;
  }
  if(name==='send_meme'){
    const ids=memeToolIds(args),images=[];
    for(const id of new Set(ids))images.push(await this.effect('meme',id,async(dispatch,received)=>{if(!s.transport.meme)throw new FishError('QQ_MEME_TRANSPORT_UNAVAILABLE');const original=s.media.original(m.group,id);dispatch();await s.transport.meme(m,original);received({id,sent:true,deliveryStatus:'confirmed'});s.media.sent(m.group,id);this.recordSent('exploration-meme:'+this.run.id+':'+id,'[发送表情] '+s.media.describe(m.group,id).description);return {id,sent:true};}));
    return out(args.ids?{images}:images[0]);
  }
  if(name==='send_message'){
    if(typeof args.text!=='string'||!args.text.trim()||args.text.length>s.cfg().maxChars||hasToolMarkup(args.text))throw new FishError('INVALID_MESSAGE');
    const text=redact(args.text);return out(await this.effect('text',text,async(dispatch,received)=>{dispatch();await s.transport.send(m,text);received({sent:true,text,deliveryStatus:'confirmed'});this.recordSent('exploration-message:'+this.run.id+':'+createHash('sha256').update(text).digest('hex'),text);return {sent:true,text};}));
  }
  if(name==='send_image'||name==='send_file')return out(await this.effect(name==='send_image'?'image':'file',args.imageId??args.fileId,async(dispatch,received)=>{
    const resolver={resolveFile:async(_m:Message,id:string)=>new QQFileLibrary(s.root,store,s.library).resolve(m.group,m.user,id)},options={onDispatch:dispatch,signal:this.signal,guard:()=>this.guard(),checkFilename:(filename:string)=>privacy?.text(filename),diagnostic:(d:Record<string,any>)=>{this.diagnostics.push(d);}};
    const result=name==='send_image'?await sendLibraryImage(s.root,store,s.transport,resolver,m,args.imageId,s.cfg().maxArtifactBytes,options):await sendCatalogFile(s.root,store,s.transport,resolver,m,args.fileId,'file',options);
    received(result);if(result.deliveryStatus==='confirmed')this.recordSent('exploration-file:'+this.run.id+':'+(args.imageId??args.fileId),'[发送'+(name==='send_image'?'图片':'文件')+'] '+(args.imageId??args.fileId));return result;
  }));
  if(name==='get_quota')return out(s.images?await s.images.status(m,this.signal):qqResources(s.cfg(),s.ledger,m.group,m.user));
  if(name==='generate_image'){
    const {referenceIds,plan}=imageToolPlan(args);
    const result=await s.images!.generate(m,plan,s.cfg().codexTimeoutMs,this.signal,referenceIds);
    if(result.alreadyRequested)return out({...result,...JSON.parse(store.getMeta('qq-image-result:'+result.imageId)??'{}'),reused:true});
    s.images!.verifiedImage(result.imageId,result.manifest,s.cfg().maxArtifactBytes);
    const receipt={created:true,imageId:result.imageId,catalogId:'generated-'+result.imageId,format:result.format,animated:result.animated,frames:result.frames,conversation:m.group,manifest:result.manifest,references:result.references,deliveryStatus:'not_attempted'};
    store.setMeta('qq-image-result:'+result.imageId,JSON.stringify(receipt));return out(receipt);
  }
  if(name==='publish_qzone'){
    if(typeof args.text!=='string'||!args.text.trim()||args.text.length>1200||hasToolMarkup(args.text))throw new FishError('INVALID_MESSAGE');
    return out(await this.effect('public-post',args,async(dispatch)=>{const publisher=await s.publisher!(),[image]=s.library.select(m.group,m.user,[args.imageId]),photo=await publisher.upload(fs.readFileSync(image.path));this.guard();if(!s.state.settings().allowPublicPosts)throw new FishError('TOOL_NOT_ALLOWED');const r=await publisher.publish(redact(args.text),photo,dispatch);return {published:true,...r};}));
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
