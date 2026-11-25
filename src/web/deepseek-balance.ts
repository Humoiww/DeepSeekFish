import {FishError,codeOf} from '../types.js';

type CurrencyBalance={currency:string;totalBalance:string;grantedBalance:string;toppedUpBalance:string};
type BalanceValue={isAvailable:boolean;balance:CurrencyBalance|null;balances:CurrencyBalance[]};
type BalanceStatus=Partial<BalanceValue>&{configured:boolean;checkedAt:number|null;error?:string;stale?:boolean;mock?:boolean};
const balanceUrl='https://api.deepseek.com/user/balance';
const decimal=(value:unknown):value is string=>typeof value==='string'&&/^-?\d{1,24}(?:\.\d{1,12})?$/.test(value);

export function parseDeepSeekBalance(data:any):BalanceValue{
 if(typeof data?.is_available!=='boolean'||!Array.isArray(data.balance_infos)||data.balance_infos.length>20){
  throw new FishError('DEEPSEEK_BALANCE_INVALID_RESPONSE');
 }
 const balances:CurrencyBalance[]=[];
 for(const row of data.balance_infos){
  if(typeof row?.currency!=='string'||! /^[A-Z]{3}$/.test(row.currency)||
   !decimal(row.total_balance)||!decimal(row.granted_balance)||!decimal(row.topped_up_balance))continue;
  balances.push({currency:row.currency,totalBalance:row.total_balance,grantedBalance:row.granted_balance,toppedUpBalance:row.topped_up_balance});
 }
 if(!balances.length&&(data.balance_infos.length||data.is_available))throw new FishError('DEEPSEEK_BALANCE_INVALID_RESPONSE');
 return {isAvailable:data.is_available,balance:balances.find(row=>row.currency==='CNY')??balances[0]??null,balances};
}

const mockBalance={currency:'CNY',totalBalance:'12.34',grantedBalance:'2.34',toppedUpBalance:'10.00'};

export class DeepSeekBalance{
 private key='';
 private snapshot:BalanceStatus={configured:false,checkedAt:null};
 private lastAttempt=-Infinity;
 private flight?:{controller:AbortController;result:Promise<BalanceStatus>};

 constructor(private credential:()=>string,private mock=false,private http:typeof fetch=fetch,private now=Date.now){
  if(mock)this.snapshot={configured:true,checkedAt:now(),mock:true,isAvailable:true,balance:mockBalance,balances:[mockBalance]};
 }

 status():BalanceStatus{
  if(this.mock)return this.snapshot;
  let key:string;
  try{key=this.credential();}catch{
   return {configured:false,checkedAt:null,error:'DEEPSEEK_BALANCE_CREDENTIAL_UNAVAILABLE'} satisfies BalanceStatus;
  }
  if(key!==this.key){
   this.flight?.controller.abort();
   this.flight=undefined;
   this.key=key;
   this.lastAttempt=-Infinity;
   this.snapshot={configured:!!key,checkedAt:null};
  }
  return this.snapshot;
 }

 async refresh(force=false):Promise<BalanceStatus>{
  const current=this.status();
  if(this.mock||!current.configured)return current;
  if(this.flight)return this.flight.result;
  if(this.now()-this.lastAttempt<(force?5000:5*60_000))return current;
  const key=this.key,controller=new AbortController();
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]);
  const result=(async()=>{
   let updated:BalanceStatus;
   try{
    const response=await this.http(balanceUrl,{method:'GET',headers:{Authorization:'Bearer '+key,Accept:'application/json'},redirect:'error',signal});
    if(!response.ok)throw new FishError('DEEPSEEK_BALANCE_HTTP_'+response.status);
    const value=parseDeepSeekBalance(await response.json());
    updated={configured:true,checkedAt:this.now(),...value};
   }catch(error){
    const code=codeOf(error);
    updated={...this.snapshot,stale:this.snapshot.checkedAt!==null,error:signal.aborted?'DEEPSEEK_BALANCE_TIMEOUT':
     /^DEEPSEEK_BALANCE_[A-Z0-9_]+$/.test(code)?code:error instanceof SyntaxError?'DEEPSEEK_BALANCE_INVALID_RESPONSE':'DEEPSEEK_BALANCE_UNAVAILABLE'};
   }
   if(controller.signal.aborted||this.status().configured===false||this.key!==key)return this.status();
   this.snapshot=updated;
   this.lastAttempt=this.now();
   return this.snapshot;
  })().finally(()=>{if(this.flight?.controller===controller)this.flight=undefined;});
  this.flight={controller,result};
  return result;
 }
}
