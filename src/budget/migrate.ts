import {Ledger,dayKey} from './ledger.js';
import {modelPricing,modelReservation,modelCost,networkPricing,cnyUnits} from './pricing.js';
import {inputCache} from '../usage.js';
import {FishError,type Usage} from '../types.js';

export type LegacyEvidence={id:string;model:string;at:number;usage?:Usage};
/** Offline, idempotent migration. Exact trace IDs are evidence, textual guesses are not.
 * Unrecoverable usage/price and legacy web refunds keep an explicitly unknown reserve. */
export function migrateLegacyCosts(ledger:Ledger,evidence:LegacyEvidence[],fallbackModel:string,day=dayKey()){
 return ledger.store.transaction(()=>{
  const rows=ledger.store.db.prepare("SELECT * FROM reservations WHERE day=? AND kind IN ('model','search') AND cost_nano IS NULL").all(day) as any[];
  if(rows.some(r=>r.state==='held'))throw new FishError('COST_MIGRATION_BUSY');
  const byId=new Map<string,LegacyEvidence>();
  for(const e of evidence){if(byId.has(e.id)&&JSON.stringify(byId.get(e.id))!==JSON.stringify(e))throw new FishError('COST_MIGRATION_CONFLICT');byId.set(e.id,e);}
  let confirmed=0,estimated=0,unknown=0;
  for(const r of rows){
   const e=byId.get(r.id),valid=e&&Number.isFinite(e.at)&&dayKey(e.at)===day&&e.usage&&[e.usage.input,e.usage.output].every(n=>Number.isSafeInteger(n)&&n>=0);
   const usage=valid?e.usage!:undefined,price=r.kind==='search'?networkPricing():modelPricing(e?.model??fallbackModel,valid?e.at:Date.parse(day+'T04:00:00Z'));
   const cost=r.kind==='model'&&usage?modelCost(price as ReturnType<typeof modelPricing>,usage):{nano:r.kind==='search'?cnyUnits(networkPricing().cnyPerRequest):modelReservation(price as ReturnType<typeof modelPricing>,r.input,r.output),status:'unknown' as const};
   const cache=usage?inputCache(usage.input,usage.cachedInput,usage.uncachedInput):{};
   ledger.store.db.prepare('UPDATE reservations SET cost_nano=?,cost_status=?,price_snapshot=?,created_at=?,actual_input=?,actual_output=?,cached_input=?,uncached_input=? WHERE id=?').run(cost.nano,cost.status,JSON.stringify({...price,migration:usage?'matched_trace':'legacy_reservation_only'}),valid?e.at:null,usage?.input??null,usage?.output??null,cache.cachedInput??null,cache.uncachedInput??null,r.id);
   for(const scope of ['*','g:'+r.grp]){
    ledger.add('costNano',cost.nano,scope,day);
    if(usage){if(cache.cachedInput===undefined)ledger.add('cacheUnknownInput',usage.input,scope,day);else{ledger.add('cachedInput',cache.cachedInput,scope,day);ledger.add('uncachedInput',cache.uncachedInput!,scope,day);}}
   }
   if(cost.status==='confirmed')confirmed++;else if(cost.status==='estimated')estimated++;else unknown++;
  }
  const result={day,migrated:rows.length,confirmed,estimated,unknown};
  if(rows.length)ledger.store.audit('cny-migration','',JSON.stringify(result));return result;
 });
}
