import {networkPricing,modelPricing,modelReservation,modelCost,cnyUnits,toCny,type PriceSnapshot,type ChargeReceipt} from './pricing.js';
import {inputCache} from '../usage.js';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { Store } from '../storage/db.js';
import { FishError, type Usage } from '../types.js';

export const dayKey = (at = Date.now()): string => new Date(at + 8 * 3600000).toISOString().slice(0, 10);
/** A direct QQ conversation shares the global daily budget; the per-group cap
 * belongs to groups, not an extra hidden allowance for the owner's private chat. */
export const conversationCostLimit=(cfg:Config,conversation:string):number=>conversation.startsWith('private:')||conversation.startsWith('web:')||cfg.groupDailyCny===0?cfg.dailyCny:Math.min(cfg.dailyCny,cfg.groupDailyCny);
type Kind = 'model' | 'search' | 'codex' | 'image' | 'interjection';
interface Reservation { id:string; day:string; grp:string; usr:string; kind:Kind; input:number; output:number; ms:number; state:string;cost_nano:number;cost_status:ChargeReceipt['status'];price_snapshot:string;actual_input:number|null;actual_output:number|null;cached_input:number|null;uncached_input:number|null }
export class BudgetError extends FishError {
  constructor(public reason:'cost'|'requests'|'output',public remaining:number,public required:number,public scope:'daily'|'conversation'='daily'){super(reason==='cost'?'CNY_BUDGET_EXHAUSTED':reason==='requests'?'DAILY_REQUEST_LIMIT':'OUTPUT_LIMIT_EXCEEDED');}
  get notice(){return this.reason==='requests'?'今日请求次数已用完，香港时间 00:00 恢复。':this.reason==='output'?'本次输出设置超过允许上限。':`${this.scope==='conversation'?'本群今日':'今日总额度'}还剩 ¥${this.remaining.toFixed(6)}，本轮需要预留 ¥${this.required.toFixed(6)}，暂时不够。香港时间 00:00 更新额度。`;}
}
/** Every allowance is charged before dispatch under one SQLite write transaction. */
export class Ledger {
  constructor(public store: Store, private config: () => Config) {
    store.transaction(()=>{
      const columns=store.db.prepare('PRAGMA table_info(reservations)').all() as any[];
      for(const [name,type] of Object.entries({cost_nano:'INTEGER',cost_status:'TEXT',price_snapshot:'TEXT',created_at:'INTEGER',actual_input:'INTEGER',actual_output:'INTEGER',cached_input:'INTEGER',uncached_input:'INTEGER',allowance_reset:'INTEGER NOT NULL DEFAULT 0'}))
        if(!columns.some(c=>c.name===name))store.db.exec('ALTER TABLE reservations ADD COLUMN '+name+' '+type);
    });
  }
  value(metric: string, scope = '*', day = dayKey()): number {
    return Number((this.store.db.prepare('SELECT value FROM counters WHERE day=? AND scope=? AND metric=?').get(day,scope,metric) as any)?.value ?? 0);
  }
  add(metric: string, value: number, scope='*', day=dayKey()): void {
    this.store.db.prepare('INSERT INTO counters VALUES (?,?,?,?) ON CONFLICT(day,scope,metric) DO UPDATE SET value=value+excluded.value').run(day,scope,metric,value);
  }
  reserve(kind: Kind, group: string, user: string, input=0, output=0, ms=0): string {
    return this.store.transaction(()=>this.charge(kind,group,user,input,output,ms));
  }
  receipt(id:string):ChargeReceipt|undefined{
    const r=this.store.db.prepare('SELECT * FROM reservations WHERE id=?').get(id) as unknown as Reservation;
    if(!r?.price_snapshot||r.cost_nano===null)return;
    return {reservationId:id,currency:'CNY',amountCny:toCny(r.cost_nano),status:r.cost_status,pricing:JSON.parse(r.price_snapshot),
      ...(r.actual_input!==null?{usage:{input:r.actual_input,output:r.actual_output!,...inputCache(r.actual_input,r.cached_input,r.uncached_input)}}:{})};
  }
  costSummary(conversation?:string){
    const cfg=this.config(),day=dayKey(),scope=conversation?'g:'+conversation:'*',used=this.value('costNano',scope,day);
    const rows=this.store.db.prepare("SELECT cost_status AS status,coalesce(sum(cost_nano),0) AS amount FROM reservations WHERE day=? AND kind IN ('model','search') AND allowance_reset=0 AND (?='' OR grp=?) GROUP BY cost_status").all(day,conversation??'',conversation??'') as {status:string;amount:number}[];
    const amount=(status:string)=>toCny(rows.find(r=>r.status===status)?.amount??0),daily=conversation?conversationCostLimit(cfg,conversation):cfg.dailyCny;
    return {currency:'CNY',day,daily,used:toCny(used),remaining:toCny(Math.max(0,Math.min(cnyUnits(cfg.dailyCny)-this.value('costNano'),cnyUnits(daily)-used))),
      confirmed:amount('confirmed'),estimated:amount('estimated'),pending:amount('held'),uncertain:amount('unknown'),reset:toCny(Number((this.store.db.prepare("SELECT coalesce(sum(cost_nano),0) AS n FROM reservations WHERE day=? AND allowance_reset=1 AND (?='' OR grp=?)").get(day,conversation??'',conversation??'') as any).n)),
      tokens:{input:this.value('input',scope),output:this.value('output',scope),cachedInput:this.value('cachedInput',scope),uncachedInput:this.value('uncachedInput',scope),cacheUnknownInput:Math.max(0,this.value('input',scope)-this.value('cachedInput',scope)-this.value('uncachedInput',scope))}};
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
  /** Reset only the local spending allowance; invoices, usage and pending charges remain. */
  resetCosts(){return this.store.transaction(()=>{
    const day=dayKey(),before=this.value('costNano'),rows=this.store.db.prepare("SELECT grp,cost_nano,cost_status FROM reservations WHERE day=? AND kind IN ('model','search') AND allowance_reset=0").all(day) as any[];
    let pending=0,uncertain=0,cleared=0;
    for(const r of rows){if(r.cost_status==='held')pending+=r.cost_nano;else if(r.cost_status==='unknown')uncertain+=r.cost_nano;else{cleared+=r.cost_nano;for(const scope of ['*','g:'+r.grp])this.add('costNano',-r.cost_nano,scope,day);}}
    this.store.db.prepare("UPDATE reservations SET allowance_reset=1 WHERE day=? AND kind IN ('model','search') AND cost_status IN ('confirmed','estimated','refunded')").run(day);
    const result={currency:'CNY',day,clearedCny:toCny(cleared),pendingCny:toCny(pending),uncertainCny:toCny(uncertain),retainedCny:toCny(before-cleared)};
    this.store.audit('local-cost-reset','web',JSON.stringify(result));return result;
  });}
  private charge(kind:Kind,group:string,user:string,input:number,output:number,ms:number,day=dayKey(),imageJob=false):string{
    const cfg=this.config(); const id=randomUUID();
    if (![input,output,ms].every(n => Number.isSafeInteger(n) && n >= 0)) throw new FishError('INVALID_RESERVATION');
    if (this.store.getMeta('budgetFault')) throw new FishError('BUDGET_USAGE_FAULT');
    if(kind==='search'){input=0;output=0;}
    const total=input+output,priced=kind==='model'||kind==='search',at=Date.now();
    const price=kind==='model'?modelPricing(cfg.model,at):kind==='search'?networkPricing():undefined;
    const cost=kind==='model'?modelReservation(price as PriceSnapshot,input,output):kind==='search'?cnyUnits(networkPricing().cnyPerRequest):0;
    if(priced&&this.store.db.prepare("SELECT id FROM reservations WHERE day=? AND kind IN ('model','search') AND cost_nano IS NULL LIMIT 1").get(day))throw new FishError('LEGACY_COST_MIGRATION_REQUIRED');
    const globalRemaining=cnyUnits(cfg.dailyCny)-this.value('costNano','*',day),groupRemaining=cnyUnits(conversationCostLimit(cfg,group))-this.value('costNano','g:'+group,day);
    const scope=globalRemaining<=groupRemaining?'daily':'conversation',remaining=Math.max(0,Math.min(globalRemaining,groupRemaining));
    if (kind === 'model') {
      if(output>cfg.maxOutputTokens)throw new BudgetError('output',toCny(remaining),toCny(cost));
      if(cost>remaining)throw new BudgetError('cost',toCny(remaining),toCny(cost),scope);
      if(this.value('requests','u:'+user,day)>=cfg.userDailyRequests)throw new BudgetError('requests',toCny(remaining),toCny(cost));
      for (const scope of ['*','g:'+group]){this.add('tokens',total,scope,day);this.add('costNano',cost,scope,day);}
      this.add('requests',1,'u:'+user,day);
    } else if(kind==='search'){
      if(cost>remaining)throw new BudgetError('cost',toCny(remaining),toCny(cost),scope);
      for(const scope of ['*','g:'+group])this.add('costNano',cost,scope,day);
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
    this.store.db.prepare('INSERT INTO reservations(id,day,grp,usr,kind,input,output,ms,state,cost_nano,cost_status,price_snapshot,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,day,group,user,kind,input,output,ms,'held',cost,priced?'held':null,price?JSON.stringify(price):null,at);
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
          const cache=inputCache(usage.input,usage.cachedInput,usage.uncachedInput);if(cache.cachedInput===undefined)this.add('cacheUnknownInput',usage.input,scope,r.day);else{this.add('cachedInput',cache.cachedInput,scope,r.day);this.add('uncachedInput',cache.uncachedInput!,scope,r.day);}
        }
      }
      if(r.kind==='model'){
        const measured=usage&&Number.isSafeInteger(usage.input)&&Number.isSafeInteger(usage.output)&&usage.input>=0&&usage.output>=0;
        const cost=measured?modelCost(JSON.parse(r.price_snapshot),usage):{nano:r.cost_nano,status:'unknown'};
        for(const scope of ['*','g:'+r.grp])this.add('costNano',cost.nano-r.cost_nano,scope,r.day);
        const cache=measured?inputCache(usage.input,usage.cachedInput,usage.uncachedInput):{};
        this.store.db.prepare('UPDATE reservations SET cost_nano=?,cost_status=?,actual_input=?,actual_output=?,cached_input=?,uncached_input=? WHERE id=?').run(cost.nano,cost.status,measured?usage.input:null,measured?usage.output:null,cache.cachedInput??null,cache.uncachedInput??null,id);
      }
      if (r.kind==='codex' && elapsedMs !== undefined){
        const spent=Math.min(r.ms,Math.max(0,Math.ceil(elapsedMs)));this.add('codexMs',spent-r.ms,'*',r.day);
        this.store.db.prepare('UPDATE image_jobs SET spent_ms=? WHERE codex_id=?').run(spent,id);
      }
      // Unknown usage remains fully charged, including after network errors/restarts.
      this.store.db.prepare('UPDATE reservations SET state=? WHERE id=?').run(r.kind!=='model'||usage&&[usage.input,usage.output].every(n=>Number.isSafeInteger(n)&&n>=0) ? 'settled' : 'unknown',id);
    });
  }
  /** Refund only requests known not to be billed. Ambiguous transport failures stay charged. */
  settleSearch(id:string,billed:boolean|undefined):void{this.store.transaction(()=>{
    const r=this.store.db.prepare("SELECT * FROM reservations WHERE id=? AND kind='search'").get(id) as unknown as Reservation;
    if(!r||r.state!=='held')return;
    if(billed===false)for(const scope of ['*','g:'+r.grp])this.add('costNano',-r.cost_nano,scope,r.day);
    this.store.db.prepare('UPDATE reservations SET state=?,cost_nano=?,cost_status=? WHERE id=?').run(billed===undefined?'unknown':'settled',billed===false?0:r.cost_nano,billed===undefined?'unknown':billed?'confirmed':'refunded',id);
  });}
  error(): void { this.add('apiErrors',1); }
  snapshot(): unknown { return this.store.db.prepare('SELECT scope,metric,value FROM counters WHERE day=? ORDER BY scope,metric').all(dayKey()); }
}
