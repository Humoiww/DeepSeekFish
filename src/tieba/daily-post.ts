import {projectTime} from '../time.js';
import type {Store} from '../storage/db.js';
import {FishError} from '../types.js';

const KEY='tieba:daily-thread-attempt';
/** Hong Kong 09:00 is UTC 01:00. No timer or offline catch-up is needed. */
export function postingDay(now=Date.now()){
 const day=new Date(now-3600000).toISOString().slice(0,10),startsAt=Date.parse(day+'T09:00:00+08:00');
 return {day,startsAt,resetsAt:startsAt+86400000};
}
/** Use the note's own instant, including across 09:00 or midnight. */
export const noteTime=(at:number)=>({recordedAt:projectTime(at),postingDay:postingDay(at).day});

export function dailyPostHint(store:Store,now=Date.now()){
 const period=postingDay(now);let saved:any;
 try{saved=JSON.parse(store.getMeta(KEY)??'null');}catch{}
 const current=saved?.day===period.day&&typeof saved.at==='number'&&saved.at>=period.startsAt&&saved.at<period.resetsAt;
 const attemptedToday=!!current&&saved.attempted!==false,manual=!!current&&saved.source==='manual';
 return {...period,attemptedToday,manual,lastAttemptAt:attemptedToday&&!manual?saved.at:null,
  message:'当前发帖日 '+period.day+'（香港时间每天 09:00 换日）。'+
   (attemptedToday?(manual?'主人已将本发帖日标记为发过新帖。':'本发帖日已经调用过发新主题工具。')+'是否公开以实际回执为准。':
    (manual?'主人已将本发帖日标记为还没发新帖。':'本发帖日还没发过新帖。')+'有感兴趣的东西可以发。')+
   '发过也可以再发，没有每日一帖的限制。发不发由你决定。'};
}
/** Human-only reminder override, not a change to any platform receipt. */
export function setDailyPostHint(store:Store,input:any,now=Date.now()){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>k!=='attemptedToday')||typeof input.attemptedToday!=='boolean')throw new FishError('INVALID_DAILY_POST_HINT');
 store.transaction(()=>{
  const value={day:postingDay(now).day,at:now,attempted:input.attemptedToday,source:'manual'};
  store.setMeta(KEY,JSON.stringify(value));store.audit('tieba-daily-post-hint','web',JSON.stringify(value));
 });
 return dailyPostHint(store,now);
}
/** This is an advisory attempt marker, never a publishing quota or permission. */
export function markDailyPostAttempt(store:Store,requestId:string,now=Date.now()){
 store.transaction(()=>{
  let prior:any;try{prior=JSON.parse(store.getMeta(KEY)??'null');}catch{}
  if(typeof prior?.at==='number'&&prior.at>now)return;
  store.setMeta(KEY,JSON.stringify({day:postingDay(now).day,at:now,requestId:requestId.slice(0,240)}));
 });
}
