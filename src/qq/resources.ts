import { networkPricing } from '../budget/pricing.js';
import { dayKey,Ledger } from '../budget/ledger.js';
import type { Config } from '../config.js';
import { PROJECT_TIMEZONE } from '../time.js';

export function qqResources(cfg:Config,ledger:Ledger,conversation:string,user:string){
  const energy=ledger.costSummary(),conversationBudget=ledger.costSummary(conversation),imagesUsed=ledger.value('image');
  const dailyRemaining=Math.max(0,cfg.imageDaily-imagesUsed);
  return {day:dayKey(),timezone:PROJECT_TIMEZONE,
    energy:{unit:'CNY',...energy,conversationDaily:conversationBudget.daily,conversationRemaining:conversationBudget.remaining,
      requestsRemaining:Math.max(0,cfg.userDailyRequests-ledger.value('requests','u:'+user))},
    web:{enabled:cfg.search,requests:ledger.value('search'),budget:'energy',...networkPricing(cfg.model)},
    images:{collaborator:'GPT小姐',enabled:cfg.images,daily:cfg.imageDaily,used:imagesUsed,
      remaining:dailyRemaining,
      busy:!!ledger.store.db.prepare("SELECT id FROM reservations WHERE kind='codex' AND state='held'").get()}};
}

/** Actual broker state, separate from promises in the dialogue. */
export function qqImageActivity(ledger:Ledger,conversation:string,messageId:string,contextIds?:string[]){
  if(!ledger.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_image_requests'").get())return {messageId,currentImage:null,recentImages:[]};
  const current=ledger.store.db.prepare('SELECT state,image_id AS imageId,error FROM qq_image_requests WHERE conversation=? AND message_id=?').get(conversation,messageId)??null;
  const scoped=contextIds?.length?' AND message_id IN ('+contextIds.map(()=>'?').join(',')+')':'';
  const recent=contextIds&&!contextIds.length?[]:ledger.store.db.prepare('SELECT message_id AS messageId,state,image_id AS imageId,error FROM qq_image_requests WHERE conversation=?'+scoped+' ORDER BY rowid DESC LIMIT 2').all(conversation,...(contextIds??[]));
  const receipt=(row:any)=>row?{...row,...JSON.parse(ledger.store.getMeta('qq-image-result:'+row.imageId)??'{}')}:null;
  return {messageId,currentImage:receipt(current),recentImages:recent.map((row:any)=>{
    const r=receipt(row);return {imageId:r.imageId,catalogId:'generated-'+r.imageId,state:r.state,created:r.created,delivered:r.delivered,deliveryStatus:r.deliveryStatus,retryScheduled:r.retryScheduled,error:r.error};
  })};
}
