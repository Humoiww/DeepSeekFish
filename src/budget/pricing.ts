import {FishError,type Usage} from '../types.js';
import {inputCache} from '../usage.js';

// CNY tariff checked 2026-11-05. Store this snapshot with each reservation.
export const PRICE_SOURCE='https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
export const PRICE_VERSION='deepseek-cny-2026-11-05';
export const CNY_SCALE=1_000_000_000; // Integer nanoyuan; even one cache-hit token is exact.
export const toCny=(nano:number)=>nano/CNY_SCALE;
export function cnyUnits(cny:number){const n=Math.round(cny*CNY_SCALE);if(!Number.isFinite(cny)||cny<0||!Number.isSafeInteger(n))throw new FishError('INVALID_CNY_AMOUNT');return n;}
export const networkPricing=(_model?:string)=>({currency:'CNY' as const,cnyPerRequest:0.005,source:PRICE_SOURCE});
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
// Weekends stay off-peak even on make-up workdays, per DeepSeek's tariff.
const holidays:Record<string,[string,string][]>= {'2026':[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],['06-19','06-21'],['09-25','09-27'],['10-01','10-07']]};
export interface PriceSnapshot {currency:'CNY';version:string;source:string;model:string;at:number;period:'peak'|'off_peak';calendarKnown:boolean;cachedNano:number;uncachedNano:number;outputNano:number}
export interface ChargeReceipt {reservationId:string;currency:'CNY';amountCny:number;status:'held'|'confirmed'|'estimated'|'unknown'|'refunded';pricing:PriceSnapshot|{currency:'CNY';cnyPerRequest:number;source:string};usage?:Usage}
export function modelPricing(model:string,at=Date.now()):PriceSnapshot{
 const pro=model==='deepseek-v4-pro';
 if(!pro&&!['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model))throw new FishError('MODEL_PRICE_UNKNOWN');
 const d=new Date(at+8*3600000),day=d.toISOString().slice(0,10),calendar=holidays[day.slice(0,4)],hour=d.getUTCHours();
 const holiday=calendar?.some(([a,b])=>day.slice(5)>=a&&day.slice(5)<=b)??false;
 const peak=d.getUTCDay()>=1&&d.getUTCDay()<=5&&!holiday&&(hour>=9&&hour<12||hour>=14&&hour<18);
 const factor=peak?1:0.5;
 return {currency:'CNY',version:PRICE_VERSION,source:PRICE_SOURCE,model,at,period:peak?'peak':'off_peak',calendarKnown:!!calendar||!peak,
  cachedNano:(pro?300:40)*factor,uncachedNano:(pro?9000:2000)*factor,outputNano:(pro?27000:8000)*factor};
}
/** Reserve the maximum tariff, including a call crossing a price boundary. */
export function modelReservation(price:PriceSnapshot,input:number,output:number){const factor=price.period==='peak'?1:2;return checked((input*price.uncachedNano+output*price.outputNano)*factor);}
export function modelCost(price:PriceSnapshot,usage:Usage){
 const cache=inputCache(usage.input,usage.cachedInput,usage.uncachedInput),known=cache.cachedInput!==undefined;
 const amount=checked((cache.cachedInput??0)*price.cachedNano+(cache.uncachedInput??usage.input)*price.uncachedNano+usage.output*price.outputNano);
 return {nano:amount,status:known&&price.calendarKnown?'confirmed' as const:'estimated' as const};
}
function checked(n:number){if(!Number.isSafeInteger(n)||n<0)throw new FishError('COST_OVERFLOW');return n;}
