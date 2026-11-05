import {randomUUID} from 'node:crypto';
import {diagnosticSafe,errorDiagnostic} from '../diagnostics.js';
import {codeOf,type CompletionOptions,type Usage} from '../types.js';
import type {ChargeReceipt} from '../budget/pricing.js';

type Completion={text?:string;content?:string;tool_calls?:unknown[];usage?:Usage;finishReason?:string;responseId?:string;billing?:ChargeReceipt};
/** Persist the exact input before I/O. A failed call keeps its own place and accounting. */
export async function traceModel<T extends Completion>(trace:any[],save:()=>void,request:unknown,round:number,
 invoke:(onReservation:NonNullable<CompletionOptions['onReservation']>)=>Promise<T>,extra:Record<string,unknown>={}):Promise<T>{
 const event:any={...extra,kind:'model',modelCallId:randomUUID(),round,startedAt:Date.now(),state:'running',request:diagnosticSafe(request)};
 trace.push(event);save();
 try{
  const result=await invoke(reservation=>{event.reservation={...reservation,state:'held'};save();});
  Object.assign(event,{state:'completed',assistant:result.text??result.content??'',toolCalls:result.tool_calls??[],usage:result.usage,finishReason:result.finishReason,responseId:result.responseId,billing:result.billing});
  if(event.reservation)event.reservation.state=result.usage?'settled':'unknown';
  return result;
 }catch(e){
  const usage=(e as any)?.usage;Object.assign(event,{state:'failed',error:codeOf(e),diagnostic:errorDiagnostic(e),providerResponse:diagnosticSafe((e as any)?.diagnostic),billing:(e as any)?.billing,...(usage?{usage}:{usageUnreported:true})});
  if(event.reservation)event.reservation.state=usage?'settled':'unknown';
  if(['CNY_BUDGET_EXHAUSTED','DAILY_REQUEST_LIMIT','OUTPUT_LIMIT_EXCEEDED','MODEL_PRICE_UNKNOWN','LEGACY_COST_MIGRATION_REQUIRED'].includes(codeOf(e))&&!event.reservation){event.notRequested=true;event.usageUnreported=false;}
  throw e;
 }finally{event.finishedAt=Date.now();event.durationMs=event.finishedAt-event.startedAt;save();}
}
