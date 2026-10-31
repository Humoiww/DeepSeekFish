import { dayKey,Ledger,conversationTokenLimit } from '../budget/ledger.js';
import type { Config } from '../config.js';
import { PROJECT_TIMEZONE } from '../time.js';

export function qqResources(cfg:Config,ledger:Ledger,conversation:string,user:string){
  const used=ledger.value('tokens'),conversationUsed=ledger.value('tokens','g:'+conversation),imagesUsed=ledger.value('image');
  const conversationDaily=conversationTokenLimit(cfg,conversation);
  const dailyRemaining=Math.max(0,cfg.imageDaily-imagesUsed);
  return {day:dayKey(),timezone:PROJECT_TIMEZONE,
    energy:{unit:'token',daily:cfg.dailyTokens,used,remaining:Math.max(0,cfg.dailyTokens-used),
      conversationDaily,conversationRemaining:Math.max(0,Math.min(cfg.dailyTokens-used,conversationDaily-conversationUsed)),
      requestsRemaining:Math.max(0,cfg.userDailyRequests-ledger.value('requests','u:'+user))},
    web:{enabled:cfg.search,daily:cfg.searchDaily,used:ledger.value('search'),remaining:Math.max(0,cfg.searchDaily-ledger.value('search'))},
    images:{collaborator:'GPT小姐',enabled:cfg.images,daily:cfg.imageDaily,used:imagesUsed,
      remaining:dailyRemaining,
      busy:!!ledger.store.db.prepare("SELECT id FROM reservations WHERE kind='codex' AND state='held'").get()}};
}

/** Actual broker state, separate from promises in the dialogue. */
export function qqImageActivity(ledger:Ledger,conversation:string,messageId:string){
  if(!ledger.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qq_image_requests'").get())return {messageId,currentImage:null,recentImages:[]};
  const current=ledger.store.db.prepare('SELECT state,image_id AS imageId,error FROM qq_image_requests WHERE conversation=? AND message_id=?').get(conversation,messageId)??null;
  const recent=ledger.store.db.prepare('SELECT message_id AS messageId,state,image_id AS imageId,error FROM qq_image_requests WHERE conversation=? ORDER BY rowid DESC LIMIT 5').all(conversation);
  const receipt=(row:any)=>row?{...row,...JSON.parse(ledger.store.getMeta('qq-image-result:'+row.imageId)??'{}')}:null;
  return {messageId,currentImage:receipt(current),recentImages:recent.map(receipt)};
}
