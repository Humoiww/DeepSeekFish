import {randomUUID} from 'node:crypto';
import type {ModelTool} from '../types.js';
import {redact,type Store} from '../storage/db.js';
import {tiebaPage,tiebaTarget} from '../search/tieba.js';
import {postPublic,type PublicPoster} from '../search/public-web.js';
import {BIG_FISH_FORUM} from './sections.js';

export const reportTiebaConflictTool:ModelTool={type:'function',function:{
 name:'report_tieba_conflict',
 description:'读帖后自行判断是否有冲突需要给主人提供情况参考；仅限经接口核实的大肥鱼吧（9782576），其他吧不用上报。只私聊主人，不执行任何吧务操作。',
 parameters:{type:'object',properties:{
  threadUrl:{type:'string',maxLength:2048},forumId:{type:'string',pattern:'^[0-9]+$'},forumName:{type:'string',maxLength:60},
  participants:{type:'array',maxItems:10,items:{type:'string',maxLength:100}},
  summary:{type:'string',minLength:1,maxLength:800,description:'根据已读内容简述事实和不确定之处。'},
  escalation:{type:'boolean',description:'补充已上报主题的新情况；普通上报去重 12 小时，补充上报每 2 小时最多一次。'},
 },required:['threadUrl','summary'],additionalProperties:false},
}};

type ConflictInput={threadUrl:string;forumId?:string;forumName?:string;participants?:string[];summary:string;escalation?:boolean};
export type VerifiedConflictReport={threadId:string;url:string;title:string;message:string;escalation:boolean};
type Receipt=Record<string,unknown>&{reported:false;sent:false};
type Preparation={ready:true;report:VerifiedConflictReport}|{ready:false;result:Receipt};
type Reservation={duplicate:false;id:string}|{duplicate:true;result:Receipt};
export type ConflictReportOptions={poster?:PublicPoster;now?:()=>number;cooldownMs?:number;escalationCooldownMs?:number};
const failure=(error:string,message:string,details:Record<string,unknown>={}):Preparation=>({ready:false,result:{reported:false,sent:false,error,message,...details}});
const clean=(text:string)=>redact(text).replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').trim();
const clip=(text:string,limit:number)=>text.length<=limit?text:text.slice(0,Math.max(0,limit-1))+'…';
const forumLabel=(forum:{name?:string;id?:string})=>(forum.name?clean(forum.name).replace(/吧$/u,'')+'吧':'其他吧')+(forum.id?'（'+forum.id+'）':'');
const notModerated=(forum:{name?:string;id?:string},actual=false)=>failure('TIEBA_CONFLICT_FORUM_NOT_MODERATED',
 '搞错啦！你只在大肥鱼吧（9782576）是小吧主，'+(actual?'该帖属于':'指定的是')+forumLabel(forum)+'，不用上报。',
 {allowedForum:BIG_FISH_FORUM,...(actual?{actualForum:forum}:{})});

function validInput(args:unknown):args is ConflictInput{
 if(!args||typeof args!=='object'||Array.isArray(args))return false;
 const a=args as Record<string,any>;
 return Object.keys(a).every(k=>Object.hasOwn(reportTiebaConflictTool.function.parameters.properties as object,k))&&
  typeof a.threadUrl==='string'&&a.threadUrl.length>0&&a.threadUrl.length<=2048&&
  typeof a.summary==='string'&&a.summary.trim().length>0&&a.summary.length<=800&&
  (a.forumId===undefined||typeof a.forumId==='string'&&/^[0-9]+$/.test(a.forumId))&&
  (a.forumName===undefined||typeof a.forumName==='string'&&a.forumName.length<=60)&&
  (a.participants===undefined||Array.isArray(a.participants)&&a.participants.length<=10&&a.participants.every((p:unknown)=>typeof p==='string'&&p.length<=100))&&
  (a.escalation===undefined||typeof a.escalation==='boolean');
}

/** Only public thread metadata can establish forum membership. Supplied names
 * and IDs are restrictions, never evidence or moderation permission. */
export class TiebaConflictReports{
 private readonly poster:PublicPoster;
 private readonly now:()=>number;
 private readonly cooldownMs:number;
 private readonly escalationCooldownMs:number;
 constructor(private store:Store,options:ConflictReportOptions={}){
  this.poster=options.poster??postPublic;this.now=options.now??Date.now;
  this.cooldownMs=options.cooldownMs??12*3600000;this.escalationCooldownMs=options.escalationCooldownMs??2*3600000;
  if(![this.cooldownMs,this.escalationCooldownMs].every(ms=>Number.isFinite(ms)&&ms>0))throw new Error('INVALID_TIEBA_CONFLICT_COOLDOWN');
  store.db.exec(`CREATE TABLE IF NOT EXISTS tieba_conflict_reports(
   id TEXT PRIMARY KEY,owner TEXT NOT NULL,forum_id TEXT NOT NULL,thread_id TEXT NOT NULL,
   reported_at INTEGER NOT NULL,escalation INTEGER NOT NULL,message TEXT NOT NULL,delivery_status TEXT NOT NULL,result TEXT);
   CREATE INDEX IF NOT EXISTS tieba_conflict_report_lookup ON tieba_conflict_reports(owner,forum_id,thread_id,reported_at);`);
 }
 async prepare(args:unknown,maxChars:number,signal?:AbortSignal):Promise<Preparation>{
  if(!validInput(args))return failure('INVALID_TOOL_ARGS','请提供贴吧主题链接和 1–800 字的情况摘要。');
  let tid:string;
  try{
   const url=new URL(args.threadUrl),target=tiebaTarget(url);
   if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||
    !target||!['thread','comments'].includes(target.kind)||!target.tid||!/^[1-9]\d{0,19}$/.test(target.tid))throw Error();
   tid=target.tid;
  }catch{return failure('TIEBA_CONFLICT_INVALID_THREAD_URL','请传入有效的贴吧主题或楼中楼链接，吧列表不能上报。');}
  if(args.forumId!==undefined&&args.forumId!==BIG_FISH_FORUM.id)return notModerated({id:args.forumId,name:args.forumName});
  if(args.forumName!==undefined&&args.forumName.trim().replace(/吧$/u,'')!==BIG_FISH_FORUM.name)return notModerated({name:args.forumName});
  const url='https://tieba.baidu.com/p/'+tid,page=await tiebaPage(url,this.poster,signal);
  if(!page||page.status==='unavailable'||!('forum' in page)||!page.forum||!page.thread)
   return failure('TIEBA_THREAD_NOT_VERIFIED','暂时无法核实该帖所属贴吧，这次没有给主人发消息。');
  if(page.forum.id!==BIG_FISH_FORUM.id)return notModerated(page.forum,true);
  const title=clean(page.thread.title)||'（接口未提供标题）',summary=clean(args.summary),participants=(args.participants??[]).map(clean).filter(Boolean).join('、');
  const header='大肥鱼吧冲突线索'+(args.escalation?'（补充）':''),closing='仅提供情况参考，未执行任何吧务操作。';
  const fixed=header+'\n主题：\n'+url+(participants?'\n涉及用户（模型整理）：':'')+'\n摘要（模型整理）：\n'+closing;
  const budget=maxChars-fixed.length;
  if(!summary||!Number.isSafeInteger(maxChars)||budget<(participants?3:2))return failure('TIEBA_CONFLICT_MESSAGE_TOO_LONG','消息长度上限不足以容纳主题链接和情况摘要，这次没有发送。');
  const titleLimit=Math.min(title.length,100,Math.max(1,Math.floor(budget*.22))),peopleLimit=participants?Math.min(participants.length,150,Math.max(1,Math.floor(budget*.25))):0;
  const message=header+'\n主题：'+clip(title,titleLimit)+'\n'+url+
   (participants?'\n涉及用户（模型整理）：'+clip(participants,peopleLimit):'')+'\n摘要（模型整理）：'+clip(summary,budget-titleLimit-peopleLimit)+'\n'+closing;
  return {ready:true,report:{threadId:tid,url,title,message,escalation:args.escalation===true}};
 }
 /** Reserve synchronously before I/O, so concurrent calls and restarts also
  * see an uncertain report. Failed, definitely unsent attempts do not cool down. */
 reserve(owner:string,report:VerifiedConflictReport,checkMessage:()=>void=()=>{}):Reservation{
  return this.store.transaction<Reservation>(()=>{
   const now=this.now(),cooldown=report.escalation?this.escalationCooldownMs:this.cooldownMs;
   const recent=this.store.db.prepare(`SELECT id,reported_at,delivery_status FROM tieba_conflict_reports
    WHERE owner=? AND forum_id=? AND thread_id=? AND delivery_status IN ('confirmed','unconfirmed')
    AND reported_at>? AND (?=0 OR escalation=1) ORDER BY reported_at DESC LIMIT 1`)
    .get(owner,BIG_FISH_FORUM.id,report.threadId,now-cooldown,Number(report.escalation));
   // A timed-out send with identical content is never blindly repeated, even
   // after the cooldown. A separately edited escalation remains an independent call.
   const uncertain=recent??this.store.db.prepare(`SELECT id,reported_at,delivery_status FROM tieba_conflict_reports
    WHERE owner=? AND forum_id=? AND thread_id=? AND message=? AND escalation=? AND delivery_status='unconfirmed' LIMIT 1`)
    .get(owner,BIG_FISH_FORUM.id,report.threadId,report.message,Number(report.escalation));
   if(uncertain)return {duplicate:true,result:{reported:false,sent:false,duplicate:true,threadId:report.threadId,forum:BIG_FISH_FORUM,
    deliveryStatus:uncertain.delivery_status,lastReportedAt:uncertain.reported_at,retryAfter:Math.max(0,Number(uncertain.reported_at)+cooldown-now),retryScheduled:false,
    message:recent?'这个主题近期已上报，本次没有重复私聊主人。':'此前相同上报的投递结果尚未确认，本次不会重复发送。'}};
   checkMessage();
   const id=randomUUID();
   this.store.db.prepare(`INSERT INTO tieba_conflict_reports(id,owner,forum_id,thread_id,reported_at,escalation,message,delivery_status)
    VALUES (?,?,?,?,?,?,?,'unconfirmed')`).run(id,owner,BIG_FISH_FORUM.id,report.threadId,now,Number(report.escalation),report.message);
   return {duplicate:false,id};
  });
 }
 record(id:string,result:Record<string,unknown>){
  const status=result.deliveryStatus==='confirmed'?'confirmed':result.deliveryStatus==='failed'?'failed':'unconfirmed';
  this.store.db.prepare('UPDATE tieba_conflict_reports SET delivery_status=?,result=? WHERE id=?').run(status,JSON.stringify(result),id);
 }
}
