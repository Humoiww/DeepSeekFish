import { dayKey,Ledger } from '../budget/ledger.js';
import type { Config } from '../config.js';

export function qqResources(cfg:Config,ledger:Ledger,conversation:string,user:string){
  const used=ledger.value('tokens'),conversationUsed=ledger.value('tokens','g:'+conversation),imagesUsed=ledger.value('image');
  const dailyRemaining=Math.max(0,cfg.imageDaily-imagesUsed),tasksRemaining=Math.max(0,cfg.codexDaily-ledger.value('codex'));
  const timeRemaining=Math.max(0,Math.floor((cfg.codexDailyMs-ledger.value('codexMs'))/cfg.codexTimeoutMs));
  return {day:dayKey(),timezone:'Asia/Shanghai',
    energy:{unit:'token',daily:cfg.dailyTokens,used,remaining:Math.max(0,cfg.dailyTokens-used),
      conversationDaily:cfg.groupDailyTokens,conversationRemaining:Math.max(0,cfg.groupDailyTokens-conversationUsed),
      requestsRemaining:Math.max(0,cfg.userDailyRequests-ledger.value('requests','u:'+user))},
    images:{collaborator:'GPT小姐',enabled:cfg.images,daily:cfg.imageDaily,used:imagesUsed,
      remaining:Math.min(dailyRemaining,tasksRemaining,timeRemaining),
      busy:!!ledger.store.db.prepare("SELECT id FROM reservations WHERE kind='codex' AND state='held'").get()}};
}
