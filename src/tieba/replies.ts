import {FishError} from '../types.js';

export interface TiebaReply {
 id:string;threadId:string;parentPostId:string|null;isFloor:boolean;time:number;
 forum:string;author:{id:string;name:string};text:string;url:string;
}
export interface TiebaReplyPage {page:number;hasMore:boolean;replies:TiebaReply[]}
// Only the small read-only ReplyMe schema is decoded here. IDs stay bigint /
// strings; unknown protobuf fields are skipped, never executed or logged.
type Field={n:number;v?:bigint;b?:Buffer};
function integer(v:bigint){const b:number[]=[];do{b.push(Number(v&127n)|(v>127n?128:0));v>>=7n;}while(v);return Buffer.from(b);}
const number=(n:number,v:number)=>Buffer.concat([integer(BigInt(n*8)),integer(BigInt(v))]);
const bytes=(n:number,b:Buffer)=>Buffer.concat([integer(BigInt(n*8+2)),integer(BigInt(b.length)),b]);
const string=(n:number,s:string)=>bytes(n,Buffer.from(s));
export function replyRequest(bduss:string,page:number){
 const common=Buffer.concat([number(1,2),string(2,'12.64.1.1'),string(10,bduss)]);
 const data=bytes(1,Buffer.concat([number(1,page),bytes(3,common)])),boundary='fish-tieba-reply-read';
 return {type:'multipart/form-data; boundary='+boundary,body:Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="data"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n'),data,Buffer.from('\r\n--'+boundary+'--\r\n')])};
}
function fields(b:Buffer):Field[]{
 let p=0;const out:Field[]=[];
 const read=()=>{let v=0n;for(let i=0;i<10;i++){if(p>=b.length)throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');const c=b[p++];v|=BigInt(c&127)<<BigInt(i*7);if(!(c&128))return v;}throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');};
 while(p<b.length){
  if(out.length>=5000)throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');
  const tag=Number(read()),n=tag>>>3,w=tag&7;if(!n)throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');
  if(w===0)out.push({n,v:read()});
  else if(w===2){const len=Number(read());if(!Number.isSafeInteger(len)||len<0||p+len>b.length)throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');out.push({n,b:b.subarray(p,p+len)});p+=len;}
  else if(w===1||w===5){p+=w===1?8:4;if(p>b.length)throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');}
  else throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');
 }return out;
}
const sub=(f:Field[],n:number)=>fields(f.find(x=>x.n===n)?.b??Buffer.alloc(0));
const value=(f:Field[],n:number)=>f.find(x=>x.n===n)?.v??0n;
const text=(f:Field[],n:number)=>f.find(x=>x.n===n)?.b?.toString('utf8')??'';
const validId=(v:bigint)=>v>0n&&v<100000000000000000000n?v.toString():'';
export function replyPage(body:Buffer,page:number):TiebaReplyPage{
 if(body.length>2097152)throw new FishError('TIEBA_REPLIES_LIMIT');
 const top=fields(body),error=sub(top,1);if(value(error,1)!==0n)throw new FishError('TIEBA_REPLIES_REJECTED');
 if(!top.some(f=>f.n===2&&f.b))throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');
 const data=sub(top,2),paging=sub(data,1),current=Number(value(paging,3));
 if(current&&current!==page)throw new FishError('TIEBA_REPLIES_PAGE_MISMATCH');
 const replies:TiebaReply[]=[];
 for(const row of data.filter(f=>f.n===2&&f.b)){
  const f=fields(row.b!),user=sub(f,9),id=validId(value(f,2)),threadId=validId(value(f,1)),uid=validId(value(user,2)),time=Number(value(f,3))*1000;
  if(!id||!threadId||!uid||!Number.isSafeInteger(time)||time<=0)throw new FishError('TIEBA_REPLIES_FORMAT_CHANGED');
  const latest=f.filter(x=>x.n===28&&x.b).at(-1),fragments=latest?fields(latest.b!).filter(x=>x.n===1&&x.b).map(x=>text(fields(x.b!),2)).join(''):text(f,6);
  replies.push({id,threadId,parentPostId:validId(value(f,14))||null,isFloor:value(f,7)>0n,time,forum:text(f,5).slice(0,100),author:{id:uid,name:(text(user,4)||text(user,3)).slice(0,100)},text:fragments.slice(0,1000),url:'https://tieba.baidu.com/p/'+threadId+'?pid='+id+'#'+id});
 }
 return {page,hasMore:value(paging,6)>0n,replies};
}
