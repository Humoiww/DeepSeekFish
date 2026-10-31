import { networkPricing } from './pricing.js';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { Store } from '../storage/db.js';
import { FishError, type Usage } from '../types.js';

export const dayKey = (at = Date.now()): string => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
/** A direct QQ conversation shares the global daily budget; the per-group cap
 * belongs to groups, not an extra hidden allowance for the owner's private chat. */
export const conversationTokenLimit=(cfg:Config,conversation:string):number=>conversation.startsWith('private:')?cfg.dailyTokens:cfg.groupDailyTokens;
type Kind = 'model' | 'search' | 'codex' | 'image' | 'interjection';
interface Reservation { id:string; day:string; grp:string; usr:string; kind:Kind; input:number; output:number; ms:number; state:string }
/** Every allowance is charged before dispatch under one SQLite write transaction. */
export class Ledger {
  constructor(public store: Store, private config: () => Config) {}
  value(metric: string, scope = '*', day = dayKey()): number {
    return Number((this.store.db.prepare('SELECT value FROM counters WHERE day=? AND scope=? AND metric=?').get(day,scope,metric) as any)?.value ?? 0);
  }
  add(metric: string, value: number, scope='*', day=dayKey()): void {
    this.store.db.prepare('INSERT INTO counters VALUES (?,?,?,?) ON CONFLICT(day,scope,metric) DO UPDATE SET value=value+excluded.value').run(day,scope,metric,value);
  }
  reserve(kind: Kind, group: string, user: string, input=0, output=0, ms=0): string {
    return this.store.transaction(()=>this.charge(kind,group,user,input,output,ms));
  }
  /** An image uses only the daily image cap; Codex time/count are recorded atomically. Never charge a Codex task
   * when the shared image allowance has already been spent. */
  reserveImageJob(group:string,user:string,ms:number):{codex:string;image:string}{
    return this.store.transaction(()=>{
      const day=dayKey(),codex=this.charge('codex',group,user,0,0,ms,day,true),image=this.charge('image',group,user,0,0,0,day);
      this.store.db.prepare('INSERT INTO image_jobs VALUES (?,?,?,?,0)').run(codex,image,day,ms);return {codex,image};
    });
  }
  /** Human-only local reset. Reservations/audit and unrelated Codex/model usage stay intact. */
  resetImages(){return this.store.transaction(()=>{
    if(this.store.db.prepare("SELECT id FROM reservations WHERE kind IN ('codex','image') AND state IN ('held','unknown')").get())throw new FishError('IMAGE_RESET_BUSY_OR_UNCERTAIN');
    const day=dayKey(),images=this.value('image','*',day);
    const paired=this.store.db.prepare('SELECT count(*) AS count,coalesce(sum(spent_ms),0) AS ms FROM image_jobs WHERE day=? AND reset=0').get(day) as {count:number;ms:number};
    this.add('image',-images,'*',day);this.add('codex',-Math.min(this.value('codex','*',day),paired.count),'*',day);this.add('codexMs',-Math.min(this.value('codexMs','*',day),paired.ms),'*',day);
    this.store.db.prepare('UPDATE image_jobs SET reset=1 WHERE day=?').run(day);
    this.store.audit('local-reset','web',JSON.stringify({images,pairedCodex:paired.count,pairedMs:paired.ms}));return {images,pairedCodex:paired.count};
  });}
  private charge(kind:Kind,group:string,user:string,input:number,output:number,ms:number,day=dayKey(),imageJob=false):string{
    const cfg=this.config(); const id=randomUUID();
    if (![input,output,ms].every(n => Number.isSafeInteger(n) && n >= 0)) throw new FishError('INVALID_RESERVATION');
    if (this.store.getMeta('budgetFault')) throw new FishError('BUDGET_USAGE_FAULT');
    if(kind==='search')input=networkPricing(cfg.model).tokensPerRequest;
    const total=input+output;
    if (kind === 'model') {
      if (output > cfg.maxOutputTokens || this.value('tokens','*',day)+total > cfg.dailyTokens ||
        this.value('tokens','g:'+group,day)+total > conversationTokenLimit(cfg,group) ||
        this.value('requests','u:'+user,day) >= cfg.userDailyRequests) throw new FishError('TOKEN_BUDGET_EXHAUSTED');
      for (const scope of ['*','g:'+group]) this.add('tokens',total,scope,day);
      this.add('requests',1,'u:'+user,day);
    } else if(kind==='search'){
      if(this.value('tokens','*',day)+input>cfg.dailyTokens||this.value('tokens','g:'+group,day)+input>conversationTokenLimit(cfg,group))throw new FishError('TOKEN_BUDGET_EXHAUSTED');
      for(const scope of ['*','g:'+group]){this.add('tokens',input,scope,day);this.add('webTokens',input,scope,day);}
      this.add('search',1,'*',day);
    } else {
      const limits = { codex:cfg.codexDaily, image:cfg.imageDaily, interjection:cfg.dailyInterjections };
      const scope=kind==='interjection'?'g:'+group:'*';
      if (!(imageJob&&kind==='codex')&&this.value(kind,scope,day)>=limits[kind]) throw new FishError(kind.toUpperCase()+'_BUDGET_EXHAUSTED');
      if (kind==='codex') {
        if (!imageJob&&this.value('codexMs','*',day)+ms>cfg.codexDailyMs) throw new FishError('CODEX_TIME_BUDGET');
        if (this.store.db.prepare("SELECT id FROM reservations WHERE kind='codex' AND state='held'").get()) throw new FishError('CODEX_BUSY');
        this.add('codexMs',ms,'*',day);
      }
      this.add(kind,1,scope,day);
      if(kind==='image')this.add('imageAttempts',1,'*',day);
    }
    this.store.db.prepare('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?)').run(id,day,group,user,kind,input,output,ms,'held');
    return id;
  }
  settle(id: string, usage?: Usage, elapsedMs?: number): void {
    this.store.transaction(() => {
      const r=this.store.db.prepare('SELECT * FROM reservations WHERE id=?').get(id) as unknown as Reservation;
      if (!r || r.state !== 'held') return;
      if (r.kind==='model' && usage && [usage.input,usage.output].every(n=>Number.isSafeInteger(n)&&n>=0)) {
        if (usage.input>r.input || usage.output>r.output) {
          this.store.setMeta('budgetFault','Provider usage exceeded conservative reservation; review locally.');
          this.store.audit('error',r.grp,'USAGE_BOUND_EXCEEDED');
        }
        const diff=usage.input+usage.output-r.input-r.output;
        for (const scope of ['*','g:'+r.grp]) {
          this.add('tokens',diff,scope,r.day);this.add('input',usage.input,scope,r.day);this.add('output',usage.output,scope,r.day);
        }
      }
      if (r.kind==='codex' && elapsedMs !== undefined){
        const spent=Math.min(r.ms,Math.max(0,Math.ceil(elapsedMs)));this.add('codexMs',spent-r.ms,'*',r.day);
        this.store.db.prepare('UPDATE image_jobs SET spent_ms=? WHERE codex_id=?').run(spent,id);
      }
      // Unknown usage remains fully charged, including after network errors/restarts.
      this.store.db.prepare('UPDATE reservations SET state=? WHERE id=?').run(usage || r.kind!=='model' ? 'settled' : 'unknown',id);
    });
  }
  /** Refund only requests known not to be billed. Ambiguous transport failures stay charged. */
  settleSearch(id:string,billed:boolean|undefined):void{this.store.transaction(()=>{
    const r=this.store.db.prepare("SELECT * FROM reservations WHERE id=? AND kind='search'").get(id) as unknown as Reservation;
    if(!r||r.state!=='held')return;
    if(billed===false)for(const scope of ['*','g:'+r.grp]){this.add('tokens',-r.input,scope,r.day);this.add('webTokens',-r.input,scope,r.day);}
    this.store.db.prepare('UPDATE reservations SET state=? WHERE id=?').run(billed===undefined?'unknown':'settled',id);
  });}
  error(): void { this.add('apiErrors',1); }
  snapshot(): unknown { return this.store.db.prepare('SELECT scope,metric,value FROM counters WHERE day=? ORDER BY scope,metric').all(dayKey()); }
}
