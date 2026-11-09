import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { safePath,makeDir,writePrivateAtomic } from '../paths.js';
import { Store,redact } from '../storage/db.js';
import { type Config,conversationAllowed } from '../config.js';
import { type BudgetedModel } from '../agent/model.js';
import { FishError,codeOf } from '../types.js';
import { hasToolMarkup } from '../agent/tool-protocol.js';
import {generatedImage} from '../image/generated.js';
import {errorDiagnostic,diagnosticSafe} from '../diagnostics.js';
import {dailyQzoneAgent,type DailySelection,type DailyAgentServices} from './daily-qzone-agent.js';
import {QQImageLibrary} from './image-library.js';
import { QQImageClient } from './image-client.js';
import { QzonePublisher,QzoneRejected,type UploadedPhoto } from './qzone-publish.js';
import { PROJECT_TIMEZONE,projectDay,projectDayStart,DAY_MS } from '../time.js';

export interface DailySettings {enabled:boolean;owner:string;startsOn:string;timezone:typeof PROJECT_TIMEZONE}
interface DailyRow {day:string;self:string;state:string;draft:string|null;image_key:string|null;image_id:string|null;catalog_id:string|null;photo:string|null;post_id:string|null;url:string|null;error:string|null;updated:number;lease:number;lock:string|null;refreshed:number;attempts:number}
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
        const at=fs.statSync(generatedImage(root,r.image_id,cfg.maxArtifactBytes)).mtimeMs;if(at<since||at>=until)continue;
        const receipt=JSON.parse(store.getMeta('qq-image-result:'+r.image_id)??'{}');
        images.push({created:r.state==='completed',delivery:receipt.deliveryStatus??'unconfirmed',referenceUsed:receipt.characterReference===true});
      }catch{}
    }
  }
  return {images,meaning:'图片实际完成记录；聊天里较早的发送失败描述可能已过时。'};
}
type Publisher=Pick<QzonePublisher,'self'|'upload'|'publish'|'find'>;
type Images=Pick<QQImageClient,'generate'>;
export class DailyQzone {
  private library:QQImageLibrary;
  constructor(private root:string,private store:Store,private cfg:()=>Config,private model:Pick<BudgetedModel,'complete'>,private publisher:Publisher,private images:Images=new QQImageClient(root),private now=Date.now,private services:DailyAgentServices={}){
    store.db.exec(`CREATE TABLE IF NOT EXISTS daily_qzone(day TEXT PRIMARY KEY,self TEXT NOT NULL,state TEXT NOT NULL,draft TEXT,image_key TEXT,image_id TEXT,photo TEXT,post_id TEXT,url TEXT,error TEXT,updated INTEGER NOT NULL,lease INTEGER NOT NULL DEFAULT 0,lock TEXT,refreshed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0)`);
    if(!store.db.prepare('PRAGMA table_info(daily_qzone)').all().some((c:any)=>c.name==='catalog_id'))store.db.exec('ALTER TABLE daily_qzone ADD COLUMN catalog_id TEXT');
    this.library=services.library??new QQImageLibrary(root,store);
  }
  private row(day:string){return this.store.db.prepare('SELECT * FROM daily_qzone WHERE day=?').get(day) as DailyRow|undefined;}
  private save(day:string,values:Record<string,unknown>){
    const pairs=Object.entries({...values,updated:this.now()});
    this.store.db.prepare('UPDATE daily_qzone SET '+pairs.map(([k])=>k+'=?').join(',')+' WHERE day=?').run(...pairs.map(([,v])=>v) as any[],day);
    const r=this.row(day)!;makeDir(this.root,'runtime/logs/daily-qzone');
    // Public Qzone delivery is separate from QQ private/group delivery.
    if(r.image_id){
      const key='qq-image-result:'+r.image_id,previous=JSON.parse(this.store.getMeta(key)??'{}');
      this.store.setMeta(key,JSON.stringify({...previous,created:true,imageId:r.image_id,catalogId:'generated-'+r.image_id,qzone:{scheduledFor:day+'T00:00:00+08:00',deliveryStatus:r.state==='published'?'confirmed':['publishing','unknown'].includes(r.state)?'unconfirmed':'scheduled',postId:r.post_id,url:r.url}}));
    }
    const {photo:_photo,lock:_lock,...record}=r;writePrivateAtomic(this.root,'runtime/logs/daily-qzone/'+day+'.json',JSON.stringify(record,null,2));
  }
  private config(){const s=dailySettings(this.root),c=this.cfg();if(!s?.enabled||!c.enabled||!conversationAllowed(c,'private:'+s.owner))throw new FishError('DAILY_QZONE_DISABLED');return s;}
  private context(day:string){
    const row=this.row(day),draft=row?.draft?JSON.parse(row.draft):undefined;
    return {memory:dailyMemory(this.store,this.cfg(),day,this.now()),actions:dailyActions(this.root,this.store,this.cfg(),day),prepared:draft?{text:draft.text,imageId:row?.catalog_id??(row?.image_id?'generated-'+row.image_id:null),previousError:row?.error}:null};
  }
  async preview(day=projectDay(projectDayStart(this.now())+DAY_MS)){
    const config=this.config();return dailyQzoneAgent({root:this.root,store:this.store,cfg:this.cfg,model:this.model,images:this.images,owner:config.owner,self:this.publisher.self,day,phase:'preview',context:this.context(day),signal:new AbortController().signal,guard:()=>{this.config();},imageRequest:()=>{throw new FishError('PREVIEW_ONLY');},finish:async selection=>selection,services:{...this.services,library:this.library}});
  }
  async run(prepareOnly=false){
    const config=this.config(),slot=prepareOnly?{phase:'prepare' as const,day:projectDay(projectDayStart(this.now())+DAY_MS),inWindow:true}:dailySlot(this.now()),{day}=slot;
    if(!slot.inWindow||day<config.startsOn)return {state:'not_due',day};
    const token=randomUUID();
    const claimed=this.store.transaction(()=>{
      this.store.db.prepare("INSERT OR IGNORE INTO daily_qzone(day,self,state,updated) VALUES (?,?,'new',?)").run(day,this.publisher.self,this.now());
      const row=this.row(day)!;if(row.self!==this.publisher.self)throw new FishError('DAILY_QZONE_ACCOUNT_CHANGED');
      if(row.state==='published'||row.lease>this.now()||slot.phase==='prepare'&&row.state==='ready')return false;
      this.store.db.prepare('UPDATE daily_qzone SET lock=?,lease=? WHERE day=?').run(token,this.now()+this.cfg().codexTimeoutMs+300000,day);return true;
    });
    if(!claimed)return {state:this.row(day)!.state,day};
    const controller=new AbortController();
    const guard=()=>{
      controller.signal.throwIfAborted();this.config();const row=this.row(day)!;
      if(row.lock!==token||row.lease<=this.now()||row.self!==this.publisher.self)throw new FishError('DAILY_QZONE_LEASE_LOST');
      if(['publishing','unknown','published'].includes(row.state))throw new FishError('DAILY_QZONE_PUBLISH_UNCONFIRMED');
    };
    const heartbeat=setInterval(()=>{
      const row=this.row(day);if(row?.lock!==token){controller.abort();return;}
      this.store.db.prepare('UPDATE daily_qzone SET lease=? WHERE day=? AND lock=?').run(this.now()+this.cfg().codexTimeoutMs+300000,day,token);
    },10000);heartbeat.unref();
    try{
      const row=this.row(day)!;
      if(['publishing','unknown'].includes(row.state)){
        const found=await this.publisher.find(JSON.parse(row.draft!).text,Date.parse(day+'T00:00:00+08:00'));
        if(found){this.save(day,{state:'published',post_id:found.id,url:found.url,error:null});return {state:'published',day,url:found.url};}
        this.save(day,{state:'unknown'});return {state:'unknown',day};
      }
      const context=this.context(day);this.save(day,{state:'preparing',attempts:row.attempts+1,error:null});
      return await dailyQzoneAgent({root:this.root,store:this.store,cfg:this.cfg,model:this.model,images:this.images,owner:config.owner,self:this.publisher.self,day,phase:slot.phase,context,signal:controller.signal,guard,
        imageRequest:()=>{const key=this.row(day)!.image_key??'daily-qzone:'+day+':1';this.save(day,{image_key:key});return key;},
        finish:async(selection:DailySelection)=>{
          guard();const [file]=this.library.select('private:'+config.owner,config.owner,[selection.imageId]),previous=this.row(day)!,same=(previous.catalog_id??(previous.image_id?'generated-'+previous.image_id:null))===selection.imageId;
          this.save(day,{draft:JSON.stringify(selection),catalog_id:selection.imageId,image_id:selection.imageId.startsWith('generated-')?selection.imageId.slice(10):null,...(!same?{photo:null}:{})});
          if(slot.phase==='prepare'){this.save(day,{state:'ready',error:null});return {state:'ready',day,catalogId:selection.imageId};}
          if(!this.row(day)!.photo){const photo=await this.publisher.upload(fs.readFileSync(file.path));guard();this.save(day,{photo:JSON.stringify(photo)});}
          guard();let post:{id:string;url:string};
          try{post=await this.publisher.publish(selection.text,JSON.parse(this.row(day)!.photo!) as UploadedPhoto,()=>{guard();this.save(day,{state:'publishing'});});}
          catch(e){this.save(day,{state:e instanceof QzoneRejected?'preparing':'unknown',error:codeOf(e)});throw e;}
          this.save(day,{state:'published',post_id:post.id,url:post.url,refreshed:1,error:null});this.store.audit('daily-qzone','',JSON.stringify({day,postId:post.id}));
          try{new (await import('../memory/journal.js')).MemoryJournal(this.root,this.store).record({id:'daily-qzone:'+day,conversation:'private:'+config.owner,actor:'DeepSeekFish',role:'assistant',text:'[自己的QQ空间动态] '+selection.text+' '+post.url,at:this.now(),source:'qzone-daily'});}catch(e){this.store.audit('daily-qzone-memory-error','',codeOf(e));}
          return {state:'published',day,url:post.url};
        },services:{...this.services,library:this.library}});
    }catch(e){
      const submitted=['publishing','unknown'].includes(this.row(day)?.state??'');
      this.save(day,{state:submitted&&!(e instanceof QzoneRejected)?'unknown':'failed',error:submitted?this.row(day)?.error??codeOf(e):codeOf(e)});
      this.store.audit('daily-qzone-error','',JSON.stringify({day,error:codeOf(e)}));
      writePrivateAtomic(this.root,'runtime/logs/daily-qzone/error-'+day+'-'+randomUUID()+'.json',JSON.stringify(diagnosticSafe({day,state:this.row(day)?.state,error:codeOf(e),diagnostic:errorDiagnostic(e),at:this.now()}),null,2));throw e;
    }finally{clearInterval(heartbeat);this.store.db.prepare('UPDATE daily_qzone SET lock=NULL,lease=0 WHERE day=? AND lock=?').run(day,token);}
  }
}
