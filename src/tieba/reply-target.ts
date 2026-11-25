import {FishError} from '../types.js';
import {tiebaTarget} from '../search/tieba.js';

export type TiebaReplyScope='thread'|'floor'|'subreply';

export function publicationReplyTarget(link:unknown){
 if(typeof link!=='string'||link.length>4096)return;
 try{
  const url=new URL(link);
  if(url.protocol!=='https:'||url.username||url.password||url.port)return;
  const target=tiebaTarget(url),anchor=url.hash.slice(1);
  if(!target?.tid||anchor&&!/^[1-9]\d{0,19}$/.test(anchor))return;
  const postId=target.kind==='comments'?target.pid:target.postId||anchor;
  if(!postId){
   return {replyScope:'thread' as const,action:'reply' as const,threadId:target.tid,page:target.page};
  }
  const subPostId=anchor&&anchor!==postId?anchor:undefined;
  const replyScope:TiebaReplyScope=subPostId?'subreply':'floor';
  return {replyScope,action:'comment' as const,threadId:target.tid,postId,...(subPostId?{subPostId}:{}),
   ...(target.kind==='comments'?{commentPage:target.page}:{page:target.page})};
 }catch{return undefined;}
}

export const replyScopeForTarget=(link:unknown):TiebaReplyScope|null=>publicationReplyTarget(link)?.replyScope??null;

export interface ResolvedReplyTarget {threadId:string;parentPostId:string;subPostId?:string;commentPage:number;replyTarget:string;floor?:number;replyTo?:{id:string|null;name:string|null}|null}
/** Resolve message relationships from actual returned floors, with the bot's
 * own publication receipts as a lookup hint. A notification's referenced ID
 * is not necessarily the outer floor. No content or author-name guessing. */
export class TiebaReplyTargets {
 private pages=new Map<string,Promise<any>>();
 constructor(private read:(url:string)=>Promise<any>,private savedParent:(threadId:string,postId:string)=>string|undefined){}
 private page(url:string){let p=this.pages.get(url);if(!p){p=this.read(url);this.pages.set(url,p);}return p;}
 private valid(page:any,threadId:string){return ['content','empty','partial'].includes(page?.status)&&page.thread?.id===threadId;}
 private transient(page:any){const code=page?.unavailable?.[0]?.error;if(typeof code==='string'&&/^TIEBA_(READ_(TIMEOUT|NETWORK_FAILED|HTTP_5\d\d)|QUEUE_EXECUTION_TIMEOUT)$/.test(code))throw new FishError(code);}
 private rootHint(threadId:string,reference:string){
  const seen=new Set<string>();let current=reference;
  while(!seen.has(current)){seen.add(current);const parent=this.savedParent(threadId,current);if(!parent||parent===current)break;current=parent;}
  return current;
 }
 private async inFloor(threadId:string,parent:string,target:string):Promise<ResolvedReplyTarget|undefined>{
  let url='https://tieba.baidu.com/p/comment?tid='+threadId+'&pid='+parent+'&pn=1';const seen=new Set<string>();
  while(!seen.has(url)){
   seen.add(url);const page=await this.page(url);this.transient(page);
   if(!this.valid(page,threadId)||page.parentPost?.id!==parent||page.parentPost.parentPostId!==null)return;
   const child=(page.posts??[]).find((p:any)=>p.id===target&&p.parentPostId===parent);
   if(target===parent||child){
    const subPostId=target!==parent?target:undefined,commentPage=page.page??1;
    return {threadId,parentPostId:parent,...(subPostId?{subPostId,replyTo:child.replyTo}:{}),floor:page.parentPost.floor??undefined,
      commentPage,replyTarget:subPostId?'https://tieba.baidu.com/p/comment?tid='+threadId+'&pid='+parent+'&pn='+commentPage+'#'+subPostId:page.parentPost.replyTarget??page.parentPost.url};
   }
   if(!page.nextPage)return;url=page.nextPage;
  }
 }
 async resolve(threadId:string,reference:string,target=reference):Promise<ResolvedReplyTarget>{
  // An old tool action says which composer was requested, not whether the
  // official site ultimately created a floor or a child reply. Verify the
  // supplied object before following any relationship inferred from receipts.
  const direct=await this.inFloor(threadId,reference,target);if(direct)return direct;
  // A valid, verified root with no target means a missing/deleted child, not
  // permission to attach the reply to some other floor.
  const first=await this.page('https://tieba.baidu.com/p/comment?tid='+threadId+'&pid='+reference+'&pn=1');
  if(this.valid(first,threadId)&&first.parentPost?.id===reference&&first.parentPost.parentPostId===null)throw new FishError('TIEBA_REPLY_TARGET_UNAVAILABLE');
  const hint=this.rootHint(threadId,reference);
  if(hint!==reference){const hinted=await this.inFloor(threadId,hint,target);if(hinted)return hinted;}
  let url='https://tieba.baidu.com/p/'+threadId+'?pn=1';const seen=new Set<string>();
  while(!seen.has(url)){
   seen.add(url);const page=await this.page(url);this.transient(page);
   if(!this.valid(page,threadId))throw new FishError('TIEBA_REPLY_PARENT_UNRESOLVED');
   // This path is for posts predating local receipts, including manually
   // posted messages. Follow the actual platform pagination on demand.
   for(const floor of page.posts??[]){
    if(floor.parentPostId!==null)continue;
    if(floor.id===target){const found=await this.inFloor(threadId,floor.id,target);if(found)return found;}
    if(floor.commentCount>0){const found=await this.inFloor(threadId,floor.id,target);if(found)return found;}
   }
   if(!page.nextPage)break;url=page.nextPage;
  }
  throw new FishError('TIEBA_REPLY_PARENT_UNRESOLVED');
 }
}
