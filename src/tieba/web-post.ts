/** Normal official-PC-page receipts. No invented signing, captcha solver,
 * credentials, request replay, or alternative-channel retry. */
import {createHash} from 'node:crypto';
import {AppPostFailure,platformMessage} from './app-post.js';
import type {PostingRequest} from './posting.js';
export const WEB_POST_URL='https://tieba.baidu.com/c/c/post/add_pc';
export interface WebOutcome {id?:string;url?:string;error?:string;receipt:Record<string,unknown>}
export function webPostResponse(body:Buffer,status:number,auth={bduss:'',tbs:''}):WebOutcome{
 const receipt:Record<string,unknown>={transport:'official_web',responseKind:'json',httpStatus:status};
 let json:any;try{json=JSON.parse(body.toString('utf8'));}catch{return {error:'TIEBA_PUBLICATION_UNCONFIRMED',receipt:{...receipt,responseKind:'unexpected'}};}
 const data=json?.data??{},raw=json?.error_code??json?.no;
 const names=(v:any)=>v&&typeof v==='object'?Object.keys(v).filter(k=>/^[a-zA-Z_]{1,40}$/.test(k)).slice(0,40):[];
 receipt.responseFields={root:names(json),data:names(data)};
 if(!['number','string'].includes(typeof raw)||! /^-?\d{1,9}$/.test(String(raw)))return {error:'TIEBA_PUBLICATION_UNCONFIRMED',receipt};
 const code=Number(raw),nested=Number(data.error_code??0),errorCode=code||nested;
 receipt.errorCode=errorCode;receipt.accepted=status===200&&errorCode===0;
 const message=platformMessage(json.error_msg??json.error??json.errmsg??data.error_msg??data.errmsg,auth);if(message)receipt.errorMessage=message;
 // The current official add_pc page returns pid/info at the root, as
 // observed in its native response and the site's own t.pid consumer.
 const rawId=json.pid??data.pid??data.post_id??'',id=typeof rawId==='number'&&!Number.isSafeInteger(rawId)?'':String(rawId);receipt.idGenerated=/^[1-9]\d{0,19}$/.test(id);if(receipt.idGenerated)receipt.id=id;
 if(Number((json.info??data.info)?.need_vcode??json.need_vcode)>0||errorCode===220901||/验证码|安全验证|安全检测|captcha|vcode/i.test(message)){receipt.challenge=true;return {error:'TIEBA_PUBLICATION_CHALLENGE',receipt};}
 if(status!==200)return {error:'TIEBA_PUBLICATION_UNCONFIRMED',receipt};
 if(errorCode!==0)return {error:'TIEBA_PUBLICATION_REJECTED',receipt};
 return receipt.idGenerated?{id,receipt}:{error:'TIEBA_PUBLICATION_UNCONFIRMED',receipt};
}
export function webPostResult(outcome:WebOutcome,tid:string){
 if(outcome.error||!outcome.id)throw new AppPostFailure(outcome.error??'TIEBA_PUBLICATION_UNCONFIRMED',outcome.receipt);
 return {id:outcome.id,url:'https://tieba.baidu.com/p/'+tid+'?pid='+outcome.id+'#'+outcome.id,receipt:outcome.receipt};
}
const plain=(s:string)=>s.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,'');
/** A page is allowed one initial submit. Only a new official proof following
 * a human interaction and an explicit rejection may permit its captcha resume.
 * Unknown/accepted outcomes and the site's retry-on-close cannot post again. */
export class WebPostGate {
 armed=false;humanAt=0;receivedAt=0;outcome?:WebOutcome;writes=0;private proofs=new Set<string>();
 blockedReason='';fieldNames:string[]=[];
 constructor(readonly plan:PostingRequest,private beforeWrite:()=>void){}
 allow(params:any){
  const req=params.request,u=new URL(req.url);if(u.origin!=='https://tieba.baidu.com'||u.pathname!=='/c/c/post/add_pc'||req.method!=='POST')return false;
  let fields:any;try{fields=JSON.parse(req.postData??'');}catch{fields=Object.fromEntries(new URLSearchParams(req.postData??''));}
  this.fieldNames=Object.keys(fields??{}).filter(k=>/^[a-zA-Z_]{1,40}$/.test(k)).slice(0,40);
  if(String(fields.tid)!==this.plan.fields.tid||String(fields.fid)!==this.plan.fields.fid){this.blockedReason='target_mismatch';return false;}
  if(plain(String(fields.content??''))!==plain(this.plan.fields.content)){this.blockedReason='content_mismatch';return false;}
  if(['quote_id','sub_post_id','repostid'].some(k=>String(fields[k]??'')!==String(this.plan.fields[k]??''))){this.blockedReason='parent_mismatch';return false;}
  const proof=String(Object.entries(req.headers??{}).find(([k])=>k.toLowerCase()==='svcp_stk')?.[1]??fields.svcp_stk??'');
  const digest=proof?createHash('sha256').update(proof).digest('hex'):'';
  if(!this.armed&&!(this.outcome?.receipt.challenge&&this.outcome.receipt.accepted===false&&!this.outcome.receipt.idGenerated&&this.humanAt>this.receivedAt&&digest&&!this.proofs.has(digest)))return false;
  this.beforeWrite();this.armed=false;if(digest)this.proofs.add(digest);this.writes++;this.outcome=undefined;return true;
 }
 received(outcome:WebOutcome){this.outcome={...outcome,receipt:{...outcome.receipt,httpAttempts:this.writes}};this.receivedAt=Date.now();return this.outcome;}
}
