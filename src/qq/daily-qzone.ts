import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath,makeDir,writePrivate } from '../paths.js';
import { Store,redact } from '../storage/db.js';
import { type Config,conversationAllowed } from '../config.js';
import { type BudgetedModel } from '../agent/model.js';
import { FishError,codeOf,type ChatMessage,type ModelTool,type Message } from '../types.js';
import { appearancePrompt } from '../character.js';
import { dailyPrompt } from '../prompts.js';
import { hasToolMarkup } from '../agent/tool-protocol.js';
import { imageFields,validateImagePlan,type ImagePlan } from '../web/images.js';
import { verifyPng } from '../image/provider.js';
import { QQImageClient } from './image-client.js';
import { QzonePublisher,QzoneRejected,type UploadedPhoto } from './qzone-publish.js';
import { PROJECT_TIMEZONE,projectDay,projectDayStart,DAY_MS } from '../time.js';

export interface DailySettings {enabled:boolean;owner:string;startsOn:string;timezone:typeof PROJECT_TIMEZONE}
interface DailyRow {day:string;self:string;state:string;draft:string|null;image_key:string|null;image_id:string|null;photo:string|null;post_id:string|null;url:string|null;error:string|null;updated:number;lease:number;lock:string|null;refreshed:number;attempts:number}
const safeRetry=new Set(['IMAGE_BUDGET_EXHAUSTED','CODEX_BUDGET_EXHAUSTED','CODEX_TIME_BUDGET','CODEX_BUSY','TOKEN_BUDGET_EXHAUSTED','QZONE_LOGIN_REQUIRED','CODEX_QUOTA_CONFIRM_REQUIRED']);
const imageLookup=new Set(['QQ_IMAGE_BROKER_UNAVAILABLE','DAILY_QZONE_IMAGE_UNCONFIRMED']);
export function dailySettings(root:string):DailySettings|undefined{
  const file=safePath(root,'runtime/data/daily-qzone.json');if(!fs.existsSync(file))return;
  const s=JSON.parse(fs.readFileSync(file,'utf8'));
  if(typeof s.enabled!=='boolean'||!/^[1-9]\d{0,19}$/.test(s.owner)||!/^20\d{2}-\d{2}-\d{2}$/.test(s.startsOn)||s.timezone!==PROJECT_TIMEZONE)throw new FishError('DAILY_QZONE_CONFIG_INVALID');return s;
}
export function dailySlot(at=Date.now()){
  const midnight=projectDayStart(at),preparing=at-midnight>=DAY_MS-10*60000;
  return {phase:preparing?'prepare':'publish',day:projectDay(preparing?midnight+DAY_MS:midnight),inWindow:preparing||at-midnight<6*3600000} as const;
}
export function dailyStatus(root:string,store:Store,now=Date.now()){
  const config=dailySettings(root),exists=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_qzone'").get();
  return {enabled:config?.enabled??false,timezone:PROJECT_TIMEZONE,publishAt:'00:00',prepareAt:'23:50',startsOn:config?.startsOn??null,nextPublishAt:projectDayStart(now)+DAY_MS,
    last:exists?store.db.prepare('SELECT day,state,image_id AS imageId,post_id AS postId,url,error,updated FROM daily_qzone ORDER BY day DESC LIMIT 1').get()??null:null};
}
/** A bounded, day-wide sample; no contact identities or other unapproved chats. */
export function dailyMemory(store:Store,cfg:Config,day:string,now=Date.now()){
  const until=Date.parse(day+'T00:00:00+08:00'),since=until-DAY_MS;
  if(!Number.isFinite(until)||projectDay(until)!==day)throw new FishError('DAILY_QZONE_DATE_INVALID');
  const groups=[...cfg.groups,...cfg.privateUsers.map(u=>'private:'+u)];
  if(!groups.length)throw new FishError('DAILY_QZONE_NO_MEMORY_SCOPE');
  const where='observed>=? AND observed<? AND conversation IN ('+groups.map(()=>'?').join(',')+") AND source!='qzone-daily'";
  const params=[since,Math.min(until,now),...groups];
  const total=(store.db.prepare('SELECT count(*) AS n FROM memory_events WHERE '+where).get(...params) as any).n;
  const events=store.db.prepare(`SELECT role,text,observed FROM (SELECT role,text,observed,seq,row_number() OVER (PARTITION BY cast((observed-?)/3600000 AS INTEGER) ORDER BY observed DESC,seq DESC) AS rank FROM memory_events WHERE ${where}) WHERE rank<=3 ORDER BY observed,seq`).all(since,...params) as any[];
  return {timezone:PROJECT_TIMEZONE,day:projectDay(since),since,until:Math.min(until,now),total,selected:events.length,
    events:events.filter(e=>!hasToolMarkup(e.text)).map(e=>({role:e.role,time:new Date(e.observed+8*3600000).toISOString().slice(11,16),text:redact(e.text).replace(/\b\d{5,20}\b/g,'[号码]').slice(0,500)}))};
}
export function dailyActions(root:string,store:Store,cfg:Config,day:string){
  const until=Date.parse(day+'T00:00:00+08:00'),since=until-DAY_MS,images:Record<string,unknown>[]=[];
  if(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_image_requests'").get()){
    const rows=store.db.prepare("SELECT conversation,message_id,image_id,state FROM qq_image_requests WHERE image_id!='' ORDER BY rowid DESC LIMIT 100").all() as any[];
    for(const r of rows){
      if(!conversationAllowed(cfg,r.conversation)||r.message_id.startsWith('daily-qzone:')||!/^[-a-f0-9]{36}$/.test(r.image_id))continue;
      try{
        const at=fs.statSync(safePath(root,'runtime/outputs/'+r.image_id+'/image.png')).mtimeMs;if(at<since||at>=until)continue;
        const receipt=JSON.parse(store.getMeta('qq-image-result:'+r.image_id)??'{}');
        images.push({created:r.state==='completed',delivery:receipt.deliveryStatus??'unconfirmed',referenceUsed:receipt.characterReference===true});
      }catch{}
    }
  }
  return {images,meaning:'图片实际完成记录；聊天里较早的发送失败描述可能已过时。'};
}
const draftTool=(image:boolean):ModelTool=>({type:'function',function:{name:'draft_daily_post',description:'保存一条鲸酱自己的QQ空间日常'+(image?'和单张配图方案':''),parameters:{type:'object',additionalProperties:false,
  properties:{text:{type:'string',maxLength:1200},...(image?{imagePlan:{type:'object',additionalProperties:false,properties:Object.fromEntries(Object.keys(imageFields).map(k=>[k,{type:'string',maxLength:300}])),required:Object.keys(imageFields)}}:{})},required:image?['text','imagePlan']:['text']}}});
type Draft={text:string;imagePlan:ImagePlan};
type Publisher=Pick<QzonePublisher,'self'|'upload'|'publish'|'find'>;
type Images=Pick<QQImageClient,'generate'>;
export class DailyQzone {
  constructor(private root:string,private store:Store,private cfg:()=>Config,private model:Pick<BudgetedModel,'complete'>,private publisher:Publisher,private images:Images=new QQImageClient(root),private now=Date.now){
    store.db.exec(`CREATE TABLE IF NOT EXISTS daily_qzone(day TEXT PRIMARY KEY,self TEXT NOT NULL,state TEXT NOT NULL,draft TEXT,image_key TEXT,image_id TEXT,photo TEXT,post_id TEXT,url TEXT,error TEXT,updated INTEGER NOT NULL,lease INTEGER NOT NULL DEFAULT 0,lock TEXT,refreshed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0)`);
  }
  private row(day:string){return this.store.db.prepare('SELECT * FROM daily_qzone WHERE day=?').get(day) as DailyRow|undefined;}
  private save(day:string,values:Record<string,unknown>){
    const pairs=Object.entries({...values,updated:this.now()});
    this.store.db.prepare('UPDATE daily_qzone SET '+pairs.map(([k])=>k+'=?').join(',')+' WHERE day=?').run(...pairs.map(([,v])=>v) as any[],day);
    const r=this.row(day);makeDir(this.root,'runtime/logs/daily-qzone');
    if(r?.image_id)this.store.setMeta('qq-image-result:'+r.image_id,JSON.stringify({created:true,imageId:r.image_id,catalogId:'generated-'+r.image_id,destination:'qzone',scheduledFor:day+'T00:00:00+08:00',deliveryStatus:r.state==='published'?'confirmed':['publishing','unknown'].includes(r.state)?'unconfirmed':'scheduled',postId:r.post_id,url:r.url}));
    // Upload capabilities stay in the private DB, not logs/model context.
    const {photo:_photo,lock:_lock,...record}=r!;writePrivate(this.root,'runtime/logs/daily-qzone/'+day+'.json',JSON.stringify(record,null,2));
  }
  private config(){const s=dailySettings(this.root),c=this.cfg();if(!s?.enabled||!c.enabled||!c.images||!conversationAllowed(c,'private:'+s.owner))throw new FishError('DAILY_QZONE_DISABLED');return s;}
  private async compose(day:string,previous?:Draft,imagePath?:string):Promise<Draft>{
    const s=this.config(),memory=dailyMemory(this.store,this.cfg(),day,this.now());
    const messages:ChatMessage[]=[{role:'system',content:dailyPrompt(this.root)},
      {role:'user',content:JSON.stringify({memory,actions:dailyActions(this.root,this.store,this.cfg(),day),...(previous?{image:{attached:true},task:'回顾这一天，写一条你自己的空间日常。'}:{character:appearancePrompt(this.root),task:'回顾刚过去的一天，自主写一条动态，并设计一张你自己的配图。'})})}];
    if(imagePath)messages.push({role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+fs.readFileSync(imagePath).toString('base64'),detail:'high'}}]});
    const result=await this.model.complete('private:'+s.owner,'daily-qzone',messages,{tools:[draftTool(!previous)],toolChoice:'draft_daily_post'});
    if(result.tool_calls?.length!==1||result.tool_calls[0].function.name!=='draft_daily_post'||result.finishReason==='length')throw new FishError('DAILY_QZONE_DRAFT_INVALID');
    let value:any;try{value=JSON.parse(result.tool_calls[0].function.arguments);}catch{throw new FishError('DAILY_QZONE_DRAFT_INVALID');}
    if(Object.keys(value).some(k=>!['text',...(!previous?['imagePlan']:[])].includes(k))||typeof value.text!=='string'||!value.text.trim()||value.text.length>1200||hasToolMarkup(value.text)||redact(value.text)!==value.text)throw new FishError('DAILY_QZONE_DRAFT_INVALID');
    return {text:value.text.trim(),imagePlan:previous?.imagePlan??validateImagePlan(value.imagePlan)};
  }
  async preview(day=projectDay(projectDayStart(this.now())+DAY_MS)){
    const row=this.row(day);return row?.draft&&row.image_id?this.compose(day,JSON.parse(row.draft),verifyPng(this.root,'runtime/outputs/'+row.image_id+'/image.png',this.cfg().maxArtifactBytes)):this.compose(day);
  }
  async run(prepareOnly=false){
    const config=this.config(),slot=prepareOnly?{phase:'prepare',day:projectDay(projectDayStart(this.now())+DAY_MS),inWindow:true}:dailySlot(this.now()),{day}=slot;
    if(!slot.inWindow||day<config.startsOn)return {state:'not_due',day};
    const token=randomUUID();
    const claimed=this.store.transaction(()=>{
      this.store.db.prepare("INSERT OR IGNORE INTO daily_qzone(day,self,state,updated) VALUES (?,?,'new',?)").run(day,this.publisher.self,this.now());
      const row=this.row(day)!;if(row.self!==this.publisher.self)throw new FishError('DAILY_QZONE_ACCOUNT_CHANGED');
      if(row.state==='published'||row.lease>this.now())return false;
      this.store.db.prepare('UPDATE daily_qzone SET lock=?,lease=? WHERE day=?').run(token,this.now()+this.cfg().codexTimeoutMs+300000,day);return true;
    });
    if(!claimed)return {state:this.row(day)!.state,day};
    try{
      let row=this.row(day)!;
      if(['publishing','unknown'].includes(row.state)){
        const found=await this.publisher.find(JSON.parse(row.draft!).text,Date.parse(day+'T00:00:00+08:00'));
        if(found){this.save(day,{state:'published',post_id:found.id,url:found.url,error:null});return {state:'published',day,url:found.url};}
        this.save(day,{state:'unknown'});return {state:'unknown',day};
      }
      if(row.state==='failed'&&(!row.image_id&&!safeRetry.has(row.error??'')&&!(row.image_key&&imageLookup.has(row.error??''))||row.attempts>=3))return {state:'failed',day,error:row.error};
      if(row.state!=='ready'){
        this.save(day,{state:'preparing',attempts:row.attempts+1,error:null});
        let draft:Draft=row.draft?JSON.parse(row.draft):await this.compose(day);this.save(day,{draft:JSON.stringify(draft)});
        if(!row.image_id){
          const key=row.image_key&&(row.state!=='failed'||imageLookup.has(row.error??''))?row.image_key:'daily-qzone:'+day+':'+(row.attempts+1);this.save(day,{image_key:key});
          const m:Message={id:key,group:'private:'+config.owner,user:config.owner,text:'鲸酱的每日空间日常配图：'+draft.text.slice(0,1000),at:this.now(),mentioned:false,event:'ordinary'};
          // The existing broker records this stable request ID before charging.
          const image=await this.images.generate(m,draft.imagePlan,this.cfg().codexTimeoutMs,undefined,['character']);
          if(image.alreadyRequested&&image.state!=='completed')throw new FishError(image.error||'DAILY_QZONE_IMAGE_UNCONFIRMED');
          if(typeof image.imageId!=='string'||!/^[0-9a-f-]{36}$/.test(image.imageId))throw new FishError('INVALID_IMAGE_ID');
          this.save(day,{image_id:image.imageId});
        }
        row=this.row(day)!;
        const file=verifyPng(this.root,'runtime/outputs/'+row.image_id+'/image.png',this.cfg().maxArtifactBytes);
        if(!row.photo)this.save(day,{photo:JSON.stringify(await this.publisher.upload(fs.readFileSync(file)))});
        this.save(day,{state:'ready',error:null});
      }
      if(slot.phase==='prepare')return {state:'ready',day};
      row=this.row(day)!;
      if(!row.refreshed){
        const file=verifyPng(this.root,'runtime/outputs/'+row.image_id+'/image.png',this.cfg().maxArtifactBytes);
        // Include the last minutes of the day without generating a second image.
        const draft=await this.compose(day,JSON.parse(row.draft!),file);this.save(day,{draft:JSON.stringify(draft),refreshed:1});row=this.row(day)!;
      }
      this.config();
      const post=await this.publisher.publish(JSON.parse(row.draft!).text,JSON.parse(row.photo!) as UploadedPhoto,()=>this.save(day,{state:'publishing'}));
      this.save(day,{state:'published',post_id:post.id,url:post.url,error:null});this.store.audit('daily-qzone','',JSON.stringify({day,postId:post.id}));
      return {state:'published',day,url:post.url};
    }catch(e){
      const submitted=['publishing','unknown'].includes(this.row(day)?.state??'');
      this.save(day,{state:submitted&&!(e instanceof QzoneRejected)?'unknown':'failed',error:codeOf(e)});
      this.store.audit('daily-qzone-error','',JSON.stringify({day,error:codeOf(e)}));throw e;
    }finally{this.store.db.prepare('UPDATE daily_qzone SET lock=NULL,lease=0 WHERE day=? AND lock=?').run(day,token);}
  }
}
