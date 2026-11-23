/** Normal official-PC-page receipts. No invented signing, captcha solver,
 * credentials, request replay, or alternative-channel retry. */
import {createHash} from 'node:crypto';
import {AppPostFailure,platformMessage} from './app-post.js';
import type {PostingRequest} from './posting.js';
export const WEB_POST_URL='https://tieba.baidu.com/c/c/post/add_pc';
export const WEB_THREAD_URL='https://tieba.baidu.com/c/c/thread/add_pc';
export interface WebOutcome {id?:string;url?:string;error?:string;receipt:Record<string,unknown>}
export function webPostResponse(body:Buffer,status:number,auth={bduss:'',tbs:''},action:PostingRequest['action']='reply'):WebOutcome{
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
 const rawId=action==='thread'?(json.tid??data.tid??data.thread_id??json.thread_id??''):(json.pid??data.pid??data.post_id??''),id=typeof rawId==='number'&&!Number.isSafeInteger(rawId)?'':String(rawId);receipt.idGenerated=/^[1-9]\d{0,19}$/.test(id);if(receipt.idGenerated)receipt.id=id;
 const pid=json.pid??data.pid;if(/^[1-9]\d{0,19}$/.test(String(pid??'')))receipt.postId=String(pid);
 if(Number((json.info??data.info)?.need_vcode??json.need_vcode)>0||errorCode===220901||/验证码|安全验证|安全检测|captcha|vcode/i.test(message)){receipt.challenge=true;return {error:'TIEBA_PUBLICATION_CHALLENGE',receipt};}
 if(status!==200)return {error:'TIEBA_PUBLICATION_UNCONFIRMED',receipt};
 if(errorCode!==0)return {error:'TIEBA_PUBLICATION_REJECTED',receipt};
 return receipt.idGenerated?{id,receipt}:{error:'TIEBA_PUBLICATION_UNCONFIRMED',receipt};
}
export function webPostResult(outcome:WebOutcome,tid:string,action:PostingRequest['action']='reply'){
 if(outcome.error||!outcome.id)throw new AppPostFailure(outcome.error??'TIEBA_PUBLICATION_UNCONFIRMED',outcome.receipt);
 return {id:outcome.id,url:'https://tieba.baidu.com/p/'+(action==='thread'?outcome.id:tid+'?pid='+outcome.id+'#'+outcome.id),receipt:outcome.receipt};
}
const plain=(s:string)=>s.replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&').replace(/\s+/g,'');
/** Native thread publishing uses FormData; replies also use JSON/form bodies.
 * Inspect scalar fields only, without persisting auth fields or file bytes. */
function requestFields(req:any):Record<string,unknown>{
 const body=String(req.postData??''),type=String(Object.entries(req.headers??{}).find(([k])=>k.toLowerCase()==='content-type')?.[1]??'');
 if(body.length>200000)throw Error('body_limit');
 if(/multipart\/form-data/i.test(type)){
  const boundary=/boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type),marker=boundary?.[1]??boundary?.[2];
  if(!marker||marker.length>200)throw Error('boundary');
  const fields:Record<string,string>={};
  for(const part of body.split('--'+marker).slice(1)){
   if(part.startsWith('--'))break;
   const split=part.indexOf('\r\n\r\n');if(split<0)continue;
   const header=part.slice(0,split),name=/\bname="([a-zA-Z_][a-zA-Z_0-9]*)"/.exec(header)?.[1];
   if(!name||/\bfilename=/i.test(header)||Object.hasOwn(fields,name))throw Error('field');
   fields[name]=part.slice(split+4).replace(/\r\n$/,'');
  }return fields;
 }
 try{const data=JSON.parse(body);if(data&&typeof data==='object'&&!Array.isArray(data))return data;}catch{}
 return Object.fromEntries(new URLSearchParams(body));
}
/** A page is allowed one initial submit. Only a new official proof following
 * a human interaction and an explicit rejection may permit its captcha resume.
 * Unknown/accepted outcomes and the site's retry-on-close cannot post again. */
export class WebPostGate {
 armed=false;humanAt=0;receivedAt=0;outcome?:WebOutcome;writes=0;private proofs=new Set<string>();
 blockedReason='';fieldNames:string[]=[];contentDifference?:Record<string,unknown>;
 constructor(readonly plan:PostingRequest,private beforeWrite:()=>void,public pictures:string[]=[]){}
 allow(params:any){
  const req=params.request,u=new URL(req.url),thread=this.plan.action==='thread';if(u.origin!=='https://tieba.baidu.com'||u.pathname!==new URL(thread?WEB_THREAD_URL:WEB_POST_URL).pathname||req.method!=='POST')return false;
  let fields:any;try{fields=requestFields(req);}catch{this.blockedReason='request_format';return false;}
  this.fieldNames=Object.keys(fields??{}).filter(k=>/^[a-zA-Z_]{1,40}$/.test(k)).slice(0,40);
  if(String(fields.fid)!==this.plan.fields.fid||(thread?String(fields.kw)!==this.plan.fields.kw:String(fields.tid)!==this.plan.fields.tid)){this.blockedReason='target_mismatch';return false;}
  if(thread&&this.plan.fields.tab_id&&['tab_id','tab_name','is_general_tab'].some(key=>String(fields[key]??'')!==this.plan.fields[key])){this.blockedReason='section_mismatch';return false;}
  if(thread&&plain(String(fields.title??''))!==plain(this.plan.fields.title)){this.blockedReason='title_mismatch';return false;}
  // The official child-reply editor appends a cache timestamp to the
  // recipient portrait. Compare the stable identity, while retaining the
  // exact recipient name and all user text. Do not normalize arbitrary URLs.
  const normalized=(text:string)=>{const value=plain(text);return this.plan.fields.sub_post_id?value.replace(/^回复#\(reply,([a-zA-Z0-9_.-]{1,200})\?t=\d{1,16},/,'回复#(reply,$1,'):value;};
  const actual=normalized(String(fields.content??'')),expected=normalized(this.plan.fields.content+this.pictures.join(''));
  if((this.plan.imagePaths?.length??0)!==this.pictures.length){this.blockedReason='attachment_count_mismatch';return false;}
  if(actual!==expected){let at=0;while(at<actual.length&&at<expected.length&&actual[at]===expected[at])at++;this.contentDifference={firstDifference:at,expected:expected.slice(Math.max(0,at-50),at+180),actual:actual.slice(Math.max(0,at-50),at+180),expectedLength:expected.length,actualLength:actual.length};this.blockedReason='content_mismatch';return false;}
  if(['quote_id','sub_post_id','repostid'].some(k=>String(fields[k]??'')!==String(this.plan.fields[k]??''))){this.blockedReason='parent_mismatch';return false;}
  const proof=String(Object.entries(req.headers??{}).find(([k])=>k.toLowerCase()==='svcp_stk')?.[1]??fields.svcp_stk??'');
  const digest=proof?createHash('sha256').update(proof).digest('hex'):'';
  if(!this.armed&&!(this.outcome?.receipt.challenge&&this.outcome.receipt.accepted===false&&!this.outcome.receipt.idGenerated&&this.humanAt>this.receivedAt&&digest&&!this.proofs.has(digest)))return false;
  this.beforeWrite();this.armed=false;if(digest)this.proofs.add(digest);this.writes++;this.outcome=undefined;return true;
 }
 received(outcome:WebOutcome){this.outcome={...outcome,receipt:{...outcome.receipt,httpAttempts:this.writes,...(this.pictures.length?{imageCount:this.pictures.length}:{})}};this.receivedAt=Date.now();return this.outcome;}
}
