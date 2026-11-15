import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {FishError,type ModelTool} from '../types.js';

// Observed official manager_apply_post_b4c6ff0.js: use the site's dialog,
// textarea, preSubmit and submit handlers, not a reconstructed private API.
export const MODERATOR_PRE='/managerapply/assist/preSubmit';
export const MODERATOR_SUBMIT='/managerapply/assist/submit';
export interface ModeratorInput {forumId:string;declaration?:string}
export interface ModeratorReceipt {phase:'eligibility'|'submit';httpStatus:number;errorCode?:number;errorMessage?:string;accepted:boolean;responseKind:'json'|'unexpected'|'network_error'}
export interface ModeratorWork {requestId:string;accountId:string;forumId:string;declaration:string;created:number;updatedAt:number;result:any}
export function moderatorInput(v:any):ModeratorInput{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['forumId','declaration'].includes(k))||typeof v.forumId!=='string'||! /^[1-9]\d{0,19}$/.test(v.forumId))throw new FishError('TIEBA_MODERATOR_INPUT_INVALID');
 if(v.declaration!==undefined&&(typeof v.declaration!=='string'||!v.declaration.trim()||v.declaration.length>400||v.declaration.includes('\0')))throw new FishError('TIEBA_MODERATOR_DECLARATION_INVALID');
 return {forumId:v.forumId,...(v.declaration!==undefined?{declaration:v.declaration.trim()}:{})};
}
export function moderatorReceipt(bytes:Buffer,httpStatus:number,phase:ModeratorReceipt['phase']):ModeratorReceipt{
 let d:any;try{d=JSON.parse(bytes.toString('utf8'));}catch{return {phase,httpStatus,accepted:false,responseKind:'unexpected'};}
 const raw=d?.errno;
 if(!['number','string'].includes(typeof raw)||! /^-?\d{1,9}$/.test(String(raw)))return {phase,httpStatus,accepted:false,responseKind:'unexpected'};
 const errorCode=Number(raw);
 // Do not return arbitrary JSON/URLs: they may contain session parameters.
 const rawMessage=d.errmsg??d.error_msg??d.msg;
 const errorMessage=typeof rawMessage==='string'&&!/(?:https?:|BDUSS|tbs|token|cookie|passport)/i.test(rawMessage)?rawMessage.replace(/[\r\n\0]/g,' ').slice(0,300):undefined;
 return {phase,httpStatus,errorCode,...(errorMessage?{errorMessage}:{}),accepted:httpStatus===200&&errorCode===0,responseKind:'json'};
}
export function moderatorResult(receipt:ModeratorReceipt,requestSent:boolean){
 const pending=receipt.errorCode===170012,already=receipt.errorCode===170025;
 const challenge=/验证码|安全验证|安全检测|captcha|vcode/i.test(receipt.errorMessage??'');
 return {submitted:requestSent?receipt.accepted?true:receipt.responseKind==='json'?false:null:false,requestSent,
  applicationStatus:pending?'pending_approval':already?'already_moderator':requestSent&&receipt.accepted?'pending_approval':challenge?'requires_human':receipt.responseKind==='json'?'rejected':'unknown',
  deliveryStatus:pending||already||requestSent&&receipt.accepted?'accepted':receipt.responseKind==='json'?'failed':'unconfirmed',
  ...(!pending&&!already&&!(requestSent&&receipt.accepted)?{error:challenge?'TIEBA_MODERATOR_VERIFICATION_REQUIRED':receipt.responseKind==='json'?'TIEBA_MODERATOR_REJECTED':'TIEBA_MODERATOR_UNCONFIRMED'}:{}),
  receipt,retryScheduled:false,notice:'申请提交与吧主任命是不同状态；本工具不执行删帖、封禁或任命。'};
}
export class ModeratorJournal {
 private db:DatabaseSync;
 constructor(dir:string){this.db=new DatabaseSync(path.join(dir,'actions.sqlite'));fs.chmodSync(path.join(dir,'actions.sqlite'),0o600);this.db.exec('PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS tieba_moderator_applications(id TEXT PRIMARY KEY,account TEXT NOT NULL,forum TEXT NOT NULL,declaration TEXT NOT NULL,created INTEGER NOT NULL,result TEXT NOT NULL)');}
 get(id:string){const row=this.db.prepare('SELECT * FROM tieba_moderator_applications WHERE id=?').get(id) as any;return row?{...row,result:JSON.parse(row.result)}:undefined;}
 begin(work:ModeratorWork){this.db.prepare('INSERT INTO tieba_moderator_applications VALUES (?,?,?,?,?,?)').run(work.requestId,work.accountId,work.forumId,work.declaration,work.created,JSON.stringify({submitted:null,requestSent:null,applicationStatus:'unknown',deliveryStatus:'unconfirmed',retryScheduled:false}));}
 finish(id:string,result:any){this.db.prepare('UPDATE tieba_moderator_applications SET result=? WHERE id=?').run(JSON.stringify(result),id);}
 close(){this.db.close();}
}
export const moderatorTools:ModelTool[]=[{type:'function',function:{name:'apply_tieba_moderator',description:'办理自己账号的小吧主申请。不传declaration时，读取官网资格、申请要求和本人候选状态；传declaration时，通过官网表单正式提交该申请感言（官网上限400字符），内容由你决定。仅管理员授权的贴吧可提交。平台待审批不等于已经成为小吧主；这不是普通回帖，也不提供删帖封号能力。',parameters:{type:'object',properties:{forumId:{type:'string',pattern:'^[1-9][0-9]{0,19}$'},declaration:{type:'string',minLength:1,maxLength:400}},required:['forumId'],additionalProperties:false}}}];
