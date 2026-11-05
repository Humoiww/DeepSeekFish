import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';
import {modelPricing,modelCost,modelReservation,cnyUnits} from '../src/budget/pricing.js';
import {migrateLegacyCosts} from '../src/budget/migrate.js';
import {dayKey} from '../src/budget/ledger.js';

test('published CNY tariff includes cache splits, output, peak hours, weekends and holidays',()=>{
 const at=(time:string)=>Date.parse(time+'+08:00'),peak=modelPricing('deepseek-flash',at('2026-11-05T09:00:00'));
 assert.equal(modelCost(peak,{input:1000000,output:1000000,cachedInput:750000,uncachedInput:250000}).nano,cnyUnits(8.53));
 assert.equal(modelCost(peak,{input:1000000,output:0,cachedInput:1000000,uncachedInput:0}).nano,cnyUnits(0.04));
 for(const time of ['2026-11-05T08:59:59','2026-11-05T12:00:00','2026-11-05T18:00:00','2026-11-07T10:00:00','2026-10-01T10:00:00']){
  const p=modelPricing('deepseek-flash',at(time));assert.equal(p.period,'off_peak',time);assert.equal(modelCost(p,{input:0,output:1000000,cachedInput:0,uncachedInput:0}).nano,cnyUnits(4));assert.equal(modelReservation(p,1000000,1000000),cnyUnits(10));
 }
 const pro=modelPricing('deepseek-v4-pro',at('2026-11-05T14:00:00'));
 assert.equal(modelCost(pro,{input:1000000,output:1000000,cachedInput:500000,uncachedInput:500000}).nano,cnyUnits(31.65));
 assert.equal(modelCost(peak,{input:1000000,output:0}).status,'estimated');assert.equal(modelCost(peak,{input:1000000,output:0}).nano,cnyUnits(2));
 assert.equal(modelCost(modelPricing('deepseek-flash',at('2027-11-05T10:00:00')),{input:1,output:1,cachedInput:0,uncachedInput:1}).status,'estimated');
 assert.throws(()=>modelPricing('unknown-provider-model'),/MODEL_PRICE_UNKNOWN/);
});

test('settlement pins request model/prices across live settings changes and records unknown usage',()=>{
 const f=fixture();try{
  const id=f.ledger.reserve('model','g','u',1000,100);const initial=f.ledger.receipt(id)!;
  f.set({model:'deepseek-v4-pro',dailyCny:0});f.ledger.settle(id,{input:500,output:10,cachedInput:400,uncachedInput:100});
  const final=f.ledger.receipt(id)!;assert.deepEqual(final.pricing,initial.pricing);assert.equal(final.amountCny,modelCost(initial.pricing as any,final.usage!).nano/1e9);assert.equal(final.status,'confirmed');
  assert.equal(f.ledger.costSummary().tokens.cachedInput,400);
  f.set({dailyCny:5});const lost=f.ledger.reserve('model','g','u',100,10);f.ledger.settle(lost);assert.equal(f.ledger.receipt(lost)!.status,'unknown');
  assert.equal(f.ledger.costSummary().uncertain,f.ledger.receipt(lost)!.amountCny);
  f.set({dailyCny:0});const image=f.ledger.reserveImageJob('g','u',100);assert.ok(image.image); // Image cap stays independent.
 }finally{f.cleanup();}
});

test('legacy cost migration is atomic, exact-ID based and idempotent; no usage reset',()=>{
 const f=fixture();try{
  const day=dayKey(),at=Date.now();
  for(const [id,kind,state] of [['matched','model','settled'],['missing','model','unknown'],['web','search','settled']])f.store.db.prepare('INSERT INTO reservations(id,day,grp,usr,kind,input,output,ms,state) VALUES (?,?,?,?,?,1000,100,0,?)').run(id,day,'g','u',kind,state);
  f.ledger.add('tokens',1800);f.ledger.add('input',500);f.ledger.add('output',20);
  assert.throws(()=>f.ledger.reserve('model','g','u',1,1),/LEGACY_COST_MIGRATION_REQUIRED/);
  const evidence=[{id:'matched',model:'deepseek-flash',at,usage:{input:500,output:20,cachedInput:400,uncachedInput:100}}];
  assert.throws(()=>migrateLegacyCosts(f.ledger,[...evidence,{...evidence[0],model:'deepseek-v4-pro'}],f.cfg().model),/COST_MIGRATION_CONFLICT/);assert.equal(f.ledger.value('costNano'),0);
  assert.deepEqual(migrateLegacyCosts(f.ledger,evidence,f.cfg().model),{day,migrated:3,confirmed:1,estimated:0,unknown:2});
  assert.equal(f.ledger.receipt('missing')!.status,'unknown');assert.equal(f.ledger.value('tokens'),1800);assert.equal(f.ledger.value('input'),500);
  const before=f.ledger.costSummary();assert.equal(migrateLegacyCosts(f.ledger,evidence,f.cfg().model).migrated,0);assert.deepEqual(f.ledger.costSummary(),before);f.ledger.add('input',37);assert.equal(f.ledger.costSummary().tokens.cacheUnknownInput,37);
 }finally{f.cleanup();}
});
