import {clockPrompt,modelTimeJson} from '../time.js';
import {toolFailure,toolArgs,UnreadFeedback} from '../agent/tool-feedback.js';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import type {Config} from '../config.js';
import {Store,redact} from '../storage/db.js';
import {makeDir,writeActivityLogAtomic} from '../paths.js';
import {FishError,codeOf,type ChatMessage,type ChatPart,type ModelTool,type Message} from '../types.js';
import {BudgetedModel,modelPayload} from '../agent/model.js';
import {traceModel} from '../agent/model-trace.js';
import {contextTools,TurnContext} from '../agent/context.js';
import {hasToolMarkup} from '../agent/tool-protocol.js';
import {PromptNumberGuard,privateQQNumbers} from '../agent/prompt-numbers.js';
import {diagnosticSafe,errorDiagnostic} from '../diagnostics.js';
import {dailyContextPrompt} from '../prompts.js';
import {personalityPrompt} from '../character.js';
import {knowledgeTools,knowledgeSnapshot,updateKnowledge} from '../memory/knowledge.js';
import {MemoryJournal,recallTools} from '../memory/journal.js';
import {webTools,browseTools} from '../search/tools.js';
import {searchEvidence,type SearchService,type WebCharge} from '../search/provider.js';
import {browsePage,downloadWebImage} from '../search/public-web.js';
import {generatedImage,generatedInfo} from '../image/generated.js';
import {validateImagePlan} from '../web/images.js';
import {QQImageClient} from './image-client.js';
import {QQImageLibrary} from './image-library.js';
import {QQMedia} from './media.js';
import {qqChatTools,imageLibraryTools} from './chat-tools.js';

export interface DailySelection {text:string;imageId:string}
export interface DailyAgentServices {
 search?:Pick<SearchService,'search'|'fetch'>;library?:QQImageLibrary;media?:QQMedia;
 browse?:typeof browsePage;download?:typeof downloadWebImage;
}
interface Options<T> {
 root:string;store:Store;cfg:()=>Config;model:Pick<BudgetedModel,'complete'>;images:Pick<QQImageClient,'generate'>;
 owner:string;self:string;day:string;phase:'prepare'|'publish'|'preview';context:unknown;signal:AbortSignal;
 now?:()=>number;guard:()=>void;imageRequest:()=>string;finish:(selection:DailySelection)=>Promise<T>;
 services?:DailyAgentServices;
}
/** The model selects each action. Codex only creates catalog files; publication
 * is a separate model tool whose caller owns the durable daily delivery lease. */
export async function dailyQzoneAgent<T>(o:Options<T>):Promise<T>{
 const {root,store,cfg,model}=o,s=o.services??{},library=s.library??new QQImageLibrary(root,store),media=s.media??new QQMedia(root,store),memory=new MemoryJournal(root,store);
 const feedback=new UnreadFeedback(store,'daily-qzone:'+o.self+':'+o.owner+(o.phase==='preview'?':preview':''));
 const publishing=o.phase==='publish';
 const finalName=publishing?'publish_qzone':'draft_daily_post';
 const finalDescription=publishing?'把你选好的文案和配图公开发到自己的 QQ 空间。':
  o.phase==='preview'?'返回你选好的文案和配图供预览。':'保存你选好的文案和配图，留给零点发布。';
 const final:ModelTool={type:'function',function:{name:finalName,description:finalDescription,parameters:{type:'object',properties:{text:{type:'string',maxLength:1200},imageId:{type:'string',description:'填图库条目的 id，或 generate_image 返回的 catalogId。'}},required:['text','imageId'],additionalProperties:false}}};
 const generate=qqChatTools(false,cfg().images,false,'background').filter(t=>t.function.name==='generate_image').map(t=>({...t,function:{...t.function,description:'请GPT小姐生图。结果保存到目录并返回catalogId，发布另用publish_qzone；画面和参考图由你选。'}}));
 const gallery=imageLibraryTools().filter(tool=>tool.function.name!=='send_image').map(tool=>({
  ...tool,function:{...tool.function,description:tool.function.name==='list_images'
   ? '浏览图库目录。条目的 id 可直接用于配图；需要看图时可用 view_images。生成图按从新到旧排列。'
   : '查看选中的图库图片，帮助你判断是否适合这条动态。'},
 }));
 const tools=[...recallTools,...contextTools,...knowledgeTools,...gallery,
  ...(o.phase!=='preview'?generate:[]),...(cfg().search?[...(s.search?webTools:[]),...browseTools]:[]),final];
 // The saved persona is shared with live QQ chat. This run supplies its own scene.
 const personality=personalityPrompt(root).replace('，正用 QQ 跟熟人闲聊','');
 const scene=publishing?'你正在处理定时触发的 QQ 空间日常。':
  o.phase==='preview'?'你正在预览自己的 QQ 空间日常。':'你正在准备零点的 QQ 空间日常。';
 const taskPrompt=scene+'当前没有聊天对象。文案和配图由你决定，已有准备稿可沿用或重写。选好后可用 '+finalName+'。';
 const messages:ChatMessage[]=[{role:'system',content:dailyContextPrompt(root)},{role:'system',content:modelTimeJson({...feedback.previous(),phase:o.phase,day:o.day,qqIdentity:{self:o.self,speaker:o.owner},...o.context as Record<string,unknown>})}];
 const context=new TurnContext(),trace:any[]=[],startedAt=Date.now(),file='runtime/logs/daily-qzone/decision-'+o.day+'-'+randomUUID()+'.json';
 makeDir(root,'runtime/logs/daily-qzone');let state='running',finishedAt:number|undefined,textOnly=0,finished=false,outcome:T|undefined;
 const save=()=>writeActivityLogAtomic(root,file,JSON.stringify(diagnosticSafe({day:o.day,phase:o.phase,conversation:'private:'+o.owner,request:'每日空间动态',startedAt,finishedAt,state,toolPolicy:'model-choice',trace}),null,2));
 const message=():Message=>({id:o.imageRequest(),group:'private:'+o.owner,user:o.owner,text:'每日空间动态 '+o.day,at:Date.now(),mentioned:false,event:'ordinary'});
 save();
 try{
  for(let round=0;round<16;round++){
   o.guard();o.signal.throwIfAborted();context.compact(round,messages,tools);
   const options={tools,signal:o.signal};
   const guidance=[clockPrompt(o.now?.()),taskPrompt];
   if(textOnly)guidance.push('前面的纯文字可当作草稿沿用或重写。纯文字不会保存草稿或发布动态。');
   const input:ChatMessage[]=[...messages,{role:'system',content:guidance.join('\n')},{role:'system',content:personality}];
   const privacy=new PromptNumberGuard(input,store,true,privateQQNumbers(cfg(),o.self,o.owner));
   const completion=await traceModel(trace,save,modelPayload(cfg(),input,cfg().maxOutputTokens,options),round,onReservation=>model.complete('private:'+o.owner,'daily-qzone',input,{...options,onReservation}));
   feedback.acknowledged();if(hasToolMarkup(completion.text))throw new FishError('DEEPSEEK_TOOL_PROTOCOL_INVALID');
   if(!completion.tool_calls?.length){
    messages.push({role:'assistant',content:completion.text});
    if(++textOnly>=3)throw new FishError('DAILY_QZONE_DECISION_INCOMPLETE');
    continue;
   }
   textOnly=0;messages.push({role:'assistant',content:completion.text,tool_calls:completion.tool_calls});
   for(const call of completion.tool_calls){
    const started=Date.now();let result:any,parts:ChatPart[]=[],diagnostic:Record<string,any>|undefined,billing:WebCharge|undefined;
    try{
     if(finished){result={skipped:true,reason:'本次动态已完成。'};}
     else{
      o.guard();o.signal.throwIfAborted();const offered=tools.find(t=>t.function.name===call.function.name),args=toolArgs(call.function.arguments);
      if(!offered||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(offered.function.parameters.properties as any,k)))throw new FishError('INVALID_TOOL_ARGS');
      const name=call.function.name;
      privacy.publication(name,args);
      if(name==='list_images')result=library.list('private:'+o.owner,o.owner,args.source??'all',args.offset??0);
      else if(name==='view_images'){
       const viewed=library.view('private:'+o.owner,o.owner,args.imageIds);result={images:viewed.images.map(({data,...i}:any)=>i)};
       parts=viewed.images.flatMap(i=>[{type:'text' as const,text:JSON.stringify({imageId:i.id,label:i.label})},{type:'image_url' as const,image_url:{url:'data:'+i.mime+';base64,'+i.data,detail:'high' as const}}]);
      }else if(name==='generate_image'){
       const {referenceIds=[],remark:_remark,...fields}=args,plan=validateImagePlan(fields),m=message();
       const image=await o.images.generate(m,plan,cfg().codexTimeoutMs,o.signal,referenceIds);
       if(image.alreadyRequested&&image.state!=='completed')throw new FishError(image.error??'DAILY_QZONE_IMAGE_UNCONFIRMED');
       const original=generatedImage(root,image.imageId,cfg().maxArtifactBytes,image.manifest?.name);
       const receipt={created:true,imageId:image.imageId,catalogId:'generated-'+image.imageId,...generatedInfo(original),conversation:m.group,manifest:image.manifest,deliveryStatus:'not_attempted',references:image.references??[]};
       const previous=JSON.parse(store.getMeta('qq-image-result:'+image.imageId)??'{}');store.setMeta('qq-image-result:'+image.imageId,JSON.stringify({...receipt,...previous}));
       result={created:true,catalogId:receipt.catalogId,...generatedInfo(original),saved:true};
      }else if(name==='download_image'){
       const urls=args.urls??[args.url];if(args.urls&&args.url||!Array.isArray(urls)||!urls.length||urls.length>12||urls.some(u=>typeof u!=='string'))throw new FishError('INVALID_TOOL_ARGS');
       const images=[];for(const url of [...new Set<string>(urls)]){
        o.guard();try{const d=await(s.download??downloadWebImage)(url,o.signal);o.guard();const image=await media.fromWeb('private:'+o.owner,d.bytes,d.url);images.push({saved:true,image});parts.push(...media.parts('private:'+o.owner,[{id:image.id,messageId:'daily-qzone:'+o.day,position:0}]));}
        catch(e){images.push({url,...toolFailure(e,'download_image')});trace.push({tool:name,diagnostic:errorDiagnostic(e)});}
       }result=args.urls?{images}:images[0];
      }else if(name==='browse_page')result=await(s.browse??browsePage)(args.url,args.offset,o.signal,undefined,args.query,args.textOffset);
      else if(name==='search_web')result={...searchEvidence(await s.search!.search(args.query,'private:'+o.owner,'daily-qzone',args.fresh,charge=>{billing=charge;})),billing};
      else if(name==='fetch_page')result={...await s.search!.fetch(args.url,'private:'+o.owner,'daily-qzone',args.offset,args.fresh,charge=>{billing=charge;}),billing};
      else if(name==='recall_chat')result=memory.read('private:'+o.owner,args);
      else if(name==='read_tool_result')result=context.read(args);
      else if(name==='get_knowledge')result=knowledgeSnapshot(root);
      else if(name==='update_knowledge'){result=updateKnowledge(root,args);}
      else if(name===finalName){
       if(typeof args.text!=='string'||!args.text.trim()||args.text.length>1200||hasToolMarkup(args.text)||redact(args.text)!==args.text||typeof args.imageId!=='string')throw new FishError('DAILY_QZONE_DRAFT_INVALID');
       library.select('private:'+o.owner,o.owner,[args.imageId]);
       result=await o.finish({text:args.text.trim(),imageId:args.imageId});finished=true;outcome=result;
      }
     }
    }catch(e){result={...toolFailure(e,call.function.name),...(billing?{billing}:{})};diagnostic=errorDiagnostic(e);if(o.signal.aborted){feedback.record(call.function.name,result);throw e;}}
    feedback.record(call.function.name,result);trace.push({tool:call.function.name,callId:call.id,result,diagnostic,startedAt:started,finishedAt:Date.now()});save();messages.push(context.result(call.function.name,call.id,result,round,parts));
    // A publishing intent can become uncertain inside finish(). Its owner
    // fences further writes in guard(), even if the model wanted another call.
   }
   if(finished){state='completed';return outcome!;}
  }
  throw new FishError('DAILY_QZONE_DECISION_INCOMPLETE');
 }catch(e){state='failed';trace.push({error:codeOf(e),diagnostic:errorDiagnostic(e)});throw e;}
 finally{finishedAt=Date.now();save();}
}
