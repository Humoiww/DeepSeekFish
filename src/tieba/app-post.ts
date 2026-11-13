/** Request field layout adapted from dsh-tieba-dive/lib/tieba.js,
 * commit 06e1657eb5262d3d2337466debf0a7ca1c165fbf, MIT.
 * Copyright (c) 2026 dsh-tieba-scroll contributors.
 * Full notice: third_party/dsh-tieba-dive.LICENSE.
 * No credentials, temporary payload files, retries or web-write fallback. */
import {FishError} from '../types.js';
import {pbNumber as pbInt,pbString as pbStr,pbBytes as pbMsg,parseFields,protoMultipart} from './protobuf.js';
import type {PostingRequest} from './posting.js';

export const APP_POST_URL='https://tiebac.baidu.com/c/c/post/add?cmd=309731&format=protobuf';
export const APP_POST_SOURCE='06e1657eb5262d3d2337466debf0a7ca1c165fbf';
interface AddFloor {tid:string;fid:string;kw:string;content:string;tbs:string;bduss:string;nameShow?:string}
interface AddPost extends AddFloor {quoteId:string;subPostId:string;replyUid:string}
export function encodeAddFloor({tid,fid,kw,content,tbs,bduss,nameShow}:AddFloor){
 const common=Buffer.concat([pbInt(1,2),pbStr(2,'22.12.1.0'),pbStr(10,bduss),pbStr(11,tbs)]);
 return pbMsg(1,Buffer.concat([pbMsg(1,common),pbStr(4,tbs),pbStr(19,content),pbStr(26,fid),pbStr(30,kw),pbStr(45,tid),pbStr(48,'0'),pbStr(6,'1'),pbStr(18,'1'),pbStr(16,'12'),pbStr(55,'13'),...(nameShow?[pbStr(58,nameShow)]:[])]));
}
export function encodeAddPost({tid,fid,kw,content,tbs,bduss,quoteId,subPostId,replyUid,nameShow}:AddPost){
 const common=Buffer.concat([pbInt(1,2),pbStr(2,'22.12.1.0'),pbStr(10,bduss),pbStr(11,tbs)]);
 return pbMsg(1,Buffer.concat([pbMsg(1,common),pbStr(4,tbs),pbStr(19,content),pbStr(26,fid),pbStr(30,kw),pbStr(45,tid),pbStr(46,quoteId),pbStr(49,quoteId),pbStr(50,subPostId),pbStr(20,replyUid),pbStr(48,'0'),pbStr(6,'1'),pbStr(18,'1'),pbStr(16,'12'),...(nameShow?[pbStr(58,nameShow)]:[])]));
}
export function parseAddPostResponse(body:Buffer){
 const top=parseFields(body,'TIEBA_PUBLICATION_UNCONFIRMED');
 const error=top.find(f=>f.n===1)?.b,data=top.find(f=>f.n===2)?.b;
 if(!error&&!data)throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');
 const e=error?parseFields(error,'TIEBA_PUBLICATION_UNCONFIRMED'):[],d=data?parseFields(data,'TIEBA_PUBLICATION_UNCONFIRMED'):[];
 const code=e.find(f=>f.n===1);if(code&&code.v===undefined)throw new FishError('TIEBA_PUBLICATION_UNCONFIRMED');
 const errno=Number(BigInt.asIntN(32,code?.v??0n)),errmsg=e.find(f=>f.n===2)?.b?.toString('utf8')??'';
 const pid=d.find(f=>f.n===3)?.b?.toString('utf8')??'';
 return {errno,errmsg,pid:/^[1-9]\d{0,19}$/.test(pid)?pid:''};
}
export class AppPostFailure extends FishError {
 constructor(code:string,readonly receipt:Record<string,unknown>){super(code);}
}
const challenge=(s:string)=>/验证码|安全验证|安全检测|captcha|vcode/i.test(s);
/** Only a bounded platform error field, never the response body or a
 * credential-bearing challenge URL. Scrub the actual injected credentials. */
function platformMessage(value:unknown,auth:{bduss:string;tbs:string}){
 let text=typeof value==='string'?value:'';
 for(const secret of [auth.bduss,auth.tbs])if(secret)text=text.split(secret).join('[凭据省略]');
 return text.replace(/https?:\/\/[^\s<>"']+/gi,'[验证链接省略]')
  .replace(/((?:bduss(?:_bfess)?|stoken|tbs|cookie|authorization|vcode_str|captcha_token)\s*["']?\s*[:=]\s*["']?)[^\s"'<>;,]+/gi,'$1[凭据省略]')
  .replace(/[A-Za-z0-9+/_=-]{32,}/g,'[凭据省略]').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,500);
}
/** One invocation makes exactly one write request. Parser failure, explicit
 * rejection, captcha and timeout never select another transport. */
export async function sendAppReply(plan:PostingRequest,auth:{bduss:string;tbs:string;nameShow?:string},request:(url:string,body:Buffer,type:string)=>Promise<{bytes:Buffer}>){
 if(plan.protocol!=='app_protobuf'||plan.url!==APP_POST_URL||!['reply','comment'].includes(plan.action))throw new FishError('TIEBA_POST_TRANSPORT_INVALID');
 const f=plan.fields,args={tid:f.tid,fid:f.fid,kw:f.kw,content:f.content,bduss:auth.bduss,tbs:auth.tbs,nameShow:auth.nameShow};
 const proto=plan.action==='reply'?encodeAddFloor(args):encodeAddPost({...args,quoteId:f.quote_id,subPostId:f.sub_post_id??'',replyUid:f.reply_uid});
 const multipart=protoMultipart(proto),response=await request(APP_POST_URL,multipart.body,multipart.type);
 const receipt:Record<string,unknown>={transport:'app_protobuf',protocolSource:APP_POST_SOURCE,responseKind:'protobuf'};
 let result:ReturnType<typeof parseAddPostResponse>;
 try{result=parseAddPostResponse(response.bytes);}catch{
  // A gateway may replace protobuf with JSON or an HTML verification page.
  // No raw body or credential-bearing payload is retained.
  const text=response.bytes.toString('utf8');let json:any;try{json=JSON.parse(text);}catch{}
  receipt.responseKind=json?'json':'unexpected';
  const code=json?.error_code??json?.errno??json?.no;
  if(typeof code==='number'||typeof code==='string'&&/^-?\d{1,9}$/.test(code))receipt.errorCode=Number(code);
  const message=platformMessage(json?.error_msg??json?.errmsg??json?.error,auth);if(message)receipt.errorMessage=message;
  if(Number(json?.need_vcode)>0||Number(json?.anti?.need_vcode)>0||challenge(String(json?.error_msg??json?.errmsg??json?.error??text))){receipt.challenge=true;throw new AppPostFailure('TIEBA_PUBLICATION_CHALLENGE',receipt);}
  if(receipt.errorCode!==undefined&&receipt.errorCode!==0)throw new AppPostFailure('TIEBA_PUBLICATION_REJECTED',receipt);
  if(receipt.errorCode===0)receipt.accepted=true;
  throw new AppPostFailure('TIEBA_PUBLICATION_UNCONFIRMED',receipt);
 }
 receipt.errorCode=result.errno;receipt.accepted=result.errno===0;receipt.idGenerated=!!result.pid;if(result.pid)receipt.id=result.pid;
 const message=platformMessage(result.errmsg,auth);if(message)receipt.errorMessage=message;
 if(challenge(result.errmsg)){receipt.challenge=true;throw new AppPostFailure('TIEBA_PUBLICATION_CHALLENGE',receipt);}
 if(result.errno!==0)throw new AppPostFailure('TIEBA_PUBLICATION_REJECTED',receipt);
 if(!result.pid)throw new AppPostFailure('TIEBA_PUBLICATION_UNCONFIRMED',receipt);
 return {id:result.pid,url:'https://tieba.baidu.com/p/'+f.tid+'?pid='+result.pid+'#'+result.pid,receipt};
}
