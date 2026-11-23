import {FishError} from '../types.js';
import type {TiebaReply} from './replies.js';

export const MENTIONS_URL='https://tiebac.baidu.com/c/u/feed/atme';
export type TiebaMention=TiebaReply&{threadTitle:string;isThread:boolean};

const id=(v:unknown)=>typeof v==='number'&&!Number.isSafeInteger(v)?'':
 typeof v==='string'||typeof v==='number'?(/^[1-9]\d{0,19}$/.test(String(v))?String(v):''):'';
const text=(v:unknown,limit:number)=>typeof v==='string'?v.replace(/\0/g,'').trim().slice(0,limit):'';
const enabled=(v:unknown)=>v===1||v==='1'||v===true;

export function mentionPage(body:Buffer,page:number){
 if(body.length>2097152)throw new FishError('TIEBA_MENTIONS_LIMIT');
 let data:any;try{data=JSON.parse(body.toString('utf8'));}catch{throw new FishError('TIEBA_MENTIONS_FORMAT_CHANGED');}
 if(data?.error_code!==0&&data?.error_code!=='0')throw new FishError('TIEBA_MENTIONS_REJECTED');
 const current=Number(data.page?.current_page),more=data.page?.has_more;
 if(![0,1,'0','1',true,false].includes(more)||!Array.isArray(data.at_list))throw new FishError('TIEBA_MENTIONS_FORMAT_CHANGED');
 if(current&&current!==page)throw new FishError('TIEBA_MENTIONS_PAGE_MISMATCH');
 const mentions:TiebaMention[]=[];
 for(const row of data.at_list){
  const threadId=id(row?.thread_id),uid=id(row?.replyer?.id),isThread=enabled(row?.is_first_post),isFloor=enabled(row?.is_floor);
  const postId=id(row?.post_id),eventId=postId||(isThread?threadId:'');
  const time=Number(row?.time)*1000;
  if(!threadId||!eventId||!uid||!Number.isSafeInteger(time)||time<=0)continue;
  const threadUrl='https://tieba.baidu.com/p/'+threadId;
  const url=isThread||isFloor?threadUrl:threadUrl+'?pid='+postId+'#'+postId;
  mentions.push({id:eventId,threadId,threadTitle:text(row.title??row.thread_title,250),parentPostId:null,replyToPostId:id(row.quote_pid)||null,isThread,isFloor,time,
   forum:text(row.fname,100),author:{id:uid,name:text(row.replyer.name_show,100)||text(row.replyer.name,100)},text:text(row.content,1000),url,
   ...(isFloor?{targetStatus:'unresolved'}:{replyTarget:url})});
 }
 if(data.at_list.length&&!mentions.length)throw new FishError('TIEBA_MENTIONS_FORMAT_CHANGED');
 return {page,hasMore:enabled(more),mentions};
}
