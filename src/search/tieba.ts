import {projectTime} from '../time.js';
import { createHash } from 'node:crypto';
import type { PublicPoster } from './public-web.js';
import { FishError, codeOf } from '../types.js';
import { publicUrl } from './provider.js';
import {BIG_FISH_FORUM,bigFishPostingSections,forumSections} from '../tieba/sections.js';

const api='https://tiebac.baidu.com',web='https://tieba.baidu.com';
type Target={kind:'forum'|'thread'|'comments';page:number;forum?:string;tid?:string;pid?:string;postId?:string};
const array=(v:any):any[]=>Array.isArray(v)?v:[];
const str=(v:unknown)=>typeof v==='string'||typeof v==='number'?String(v):'';
const id=(v:unknown)=>typeof v==='number'&&!Number.isSafeInteger(v)?'':/^[1-9]\d{0,19}$/.test(str(v))?str(v):'';
const timestamp=(v:unknown)=>Number(v)>0&&Number(v)<1e11?projectTime(Number(v)*1000):null;
const author=(v:any)=>{const portrait=str(v?.portrait).split('?')[0];return {id:id(v?.id)||null,name:str(v?.name_show||v?.name).slice(0,100)||null,portrait:/^[a-zA-Z0-9_.-]{1,200}$/.test(portrait)?portrait:null};};
const safeUrl=(v:unknown)=>{try{const u=new URL(str(v),web);return v&&publicUrl(u.href)?u.href:null;}catch{return null;}};

export function tiebaTarget(u:URL):Target|undefined{
  if(!['tieba.baidu.com','www.tieba.baidu.com','m.tieba.baidu.com','c.tieba.baidu.com','tiebac.baidu.com','wapp.baidu.com','jump2.bdimg.com','jump.bdimg.com'].includes(u.hostname))return;
  const q=u.searchParams,path=u.pathname.replace(/\/$/,'')||'/',pn=q.get('pn')??'1';
  let result:Target|undefined;
  if(path==='/f'||path==='/c/f/frs/page'){
    const forum=(q.get('kw')??'').trim();
    if(!forum||forum.length>100)throw new FishError('TIEBA_FORUM_NAME_REQUIRED');
    const position=Number(q.get('pn')??(path==='/f'?'0':'1'));
    result={kind:'forum',forum,page:path==='/f'?Math.floor(position/50)+1:position};
    if(!Number.isSafeInteger(position)||position<0)throw new FishError('TIEBA_PAGE_INVALID');
  }else if(path==='/p/comment'||path==='/c/f/pb/floor'){
    result={kind:'comments',tid:id(q.get('tid')??q.get('kz')),pid:id(q.get('pid')),page:Number(pn)};
    if(!result.tid||!result.pid)throw new FishError('TIEBA_POST_ID_REQUIRED');
  }else{
    const match=/^\/p\/([1-9]\d{0,19})$/.exec(path);
    if(match||path==='/c/f/pb/page'||path==='/mo/q/m'&&q.has('kz')){
      result={kind:'thread',tid:id(match?.[1]??q.get('kz')),page:Number(pn)};
      if(!result.tid)throw new FishError('TIEBA_THREAD_ID_REQUIRED');
      if(q.has('pid')){result.postId=id(q.get('pid'));if(!result.postId)throw new FishError('TIEBA_POST_ID_REQUIRED');}
    }
  }
  if(result&&(!Number.isSafeInteger(result.page)||result.page<1||result.page>10000))throw new FishError('TIEBA_PAGE_INVALID');
  return result;
}
function pageUrl(t:Target,page=t.page){
  const u=new URL(t.kind==='forum'?'/f':t.kind==='thread'?'/p/'+t.tid:'/p/comment',web);
  if(t.kind==='forum'){u.searchParams.set('kw',t.forum!);u.searchParams.set('pn',String((page-1)*50));}
  else{u.searchParams.set('pn',String(page));if(t.kind==='comments'){u.searchParams.set('tid',t.tid!);u.searchParams.set('pid',t.pid!);}else if(t.postId)u.searchParams.set('pid',t.postId);}
  return u.href;
}
/** Public mobile read endpoints use signed form fields. No account credentials. */
function request(t:Target){
  const fields:Record<string,string>={_client_type:'2',_client_version:'12.64.1.1',pn:String(t.page),rn:'10'};
  if(t.kind==='forum')Object.assign(fields,{kw:t.forum,sort_type:'1'});
  // The legacy JSON page endpoint may return no list/forum when given a
  // reply pid. Locate it within a real returned page instead; never interpret
  // that malformed lookup response as evidence of deletion.
  else Object.assign(fields,{kz:t.tid,...(t.kind==='comments'?{pid:t.pid}:{with_floor:'1',floor_rn:'3',...(t.postId?{r:'1',rn:'30'}:{})})});
  const body=new URLSearchParams(fields);
  body.set('sign',createHash('md5').update(Object.keys(fields).sort().map(k=>k+'='+fields[k]).join('')+'tiebaclient!!!').digest('hex'));
  return {url:api+(t.kind==='forum'?'/c/f/frs/page':t.kind==='thread'?'/c/f/pb/page':'/c/f/pb/floor'),body};
}
function content(parts:any,label:string){
  const images:{url:string;label:string;kind:string}[]=[],links:{url:string;label:string}[]=[],texts:string[]=[];
  for(const part of array(parts)){
    const type=Number(part?.type),text=str(part?.text);
    if(type===3){
      const url=safeUrl(part.origin_src||part.big_cdn_src||part.cdn_src||part.src);
      if(url)images.push({url,label,kind:'post_image'});
      texts.push('[配图]');
    }else if(type===5){texts.push('[视频，未读取视频内容]');}
    else{
      texts.push(text);
      if(type===1){const url=safeUrl(part.link||part.url||text);if(url)links.push({url,label:text.slice(0,120)});}
    }
  }
  return {text:texts.join(''),images,links};
}

// A nested reply starts with a platform mention ("回复 ", type 4 user, ":…").
// Mentions elsewhere in the author's own text do not identify the addressee.
function commentRecipient(parts:any,parent:ReturnType<typeof author>){
  const [prefix,mention,suffix]=array(parts);
  if(Number(prefix?.type)===0&&str(prefix.text).trim()==='回复'&&Number(mention?.type)===4&&/^\s*[:：]/u.test(str(suffix?.text))){
    return {id:id(mention.uid)||null,name:str(mention.text).slice(0,100)||null};
  }
  if(!prefix||/^\s*回复(?:\s|[:：]|$)/u.test(str(prefix.text)))return null;
  return {id:parent.id,name:parent.name};
}

/** Project a slice of the canonical text back onto its posts, including
 * continuations beyond the short content previews in the raw index. */
export function tiebaTextPosts(page:any,text:string,offset=0){
  if(!page?.forum||!Array.isArray(page.posts))return;
  const rows:any[]=page.parentPost?[page.parentPost,...page.posts]:page.posts;
  if(!rows.length||!rows.every(p=>p?.textRange))return;
  const start=(page.textOffset??0)+offset,end=start+text.length;
  return rows.filter(p=>text.length&&p.textRange.start<end&&p.textRange.end>start).map(p=>{
    const range=p.textRange,contentOffset=Math.max(0,start-range.contentStart);
    const content=text.slice(Math.max(0,range.contentStart-start),Math.min(text.length,range.end-start));
    return {id:p.id,kind:p.bodyKind==='preview'?'thread_preview':p.parentPostId?'subreply':'floor',
      floor:p.floor??null,author:{id:p.author.id,name:p.author.name},replyTo:p.replyTo,parentPostId:p.parentPostId,
      title:p.title,pinned:p.pinned,section:p.section,publishedAt:p.publishedAt,replyTarget:p.replyTarget,
      url:p.url!==p.replyTarget?p.url:undefined,replyCount:p.replyCount,commentCount:p.commentCount,commentsUrl:p.commentsUrl??undefined,content,
      ...(contentOffset?{contentOffset}:{}),...(end<range.end?{contentTruncated:true}:{})};
  });
}

/** URL-specific transport, not a conversational intent gate. Any public bar
 * can be chosen by the model through the existing browse_page tool. */
export async function tiebaPage(raw:string,poster:PublicPoster,signal?:AbortSignal){
  const t=tiebaTarget(new URL(raw));if(!t)return;
  const r=request(t),base={url:pageUrl(t),sourceUrl:r.url,title:'百度贴吧',fetchedAt:new Date().toISOString(),latestVerified:false,access:{mode:'public'}};
  try{
    const resource=await poster(r.url,r.body,signal);
    let data:any;try{data=JSON.parse(resource.bytes.toString('utf8'));}catch{throw new FishError('TIEBA_RESPONSE_NOT_JSON');}
    if(!data||!['0',0].includes(data.error_code))throw new FishError('TIEBA_API_'+str(data?.error_code||'INVALID').replace(/[^\w-]/g,'').slice(0,40));
    const forum={id:id(data.forum?.id),name:str(data.forum?.name)};
    if(!forum.id||!forum.name)throw new FishError('TIEBA_FORUM_UNAVAILABLE');
    if(t.kind==='forum'&&forum.name.toLowerCase()!==t.forum!.toLowerCase())throw new FishError('TIEBA_FORUM_MISMATCH');
    if(t.kind!=='forum'&&id(data.thread?.id)!==t.tid)throw new FishError('TIEBA_THREAD_MISMATCH');
    if(t.kind==='comments'&&id(data.post?.id)!==t.pid)throw new FishError('TIEBA_PARENT_POST_MISMATCH');
    const source=t.kind==='forum'?data.thread_list:t.kind==='thread'?data.post_list:data.subpost_list;
    if(source!=null&&!Array.isArray(source))throw new FishError('TIEBA_LIST_INVALID');
    // Empty lists are valid, but a missing list without an explicit empty page is not.
    const missingComments=t.kind==='comments'&&source==null&&Number(data.subpost_num??data.page?.total_count??-1)>0;
    if(source==null&&t.kind!=='comments'&&Number(data.page?.total_count??data.page?.total_num??-1)!==0)throw new FishError('TIEBA_LIST_MISSING');
    if(source==null&&t.kind==='comments'&&data.subpost_num==null&&data.page?.total_count==null)throw new FishError('TIEBA_LIST_MISSING');
    const users=new Map(array(data.user_list).map(u=>[id(u.id),u]));
    const rowAuthor=(row:any)=>{
      const uid=id(row.author?.id)||id(row.author_id);
      return author({...(uid?users.get(uid):undefined),...row.author,id:uid});
    };
    const images:{url:string;label:string;kind:string}[]=[],links:{url:string;label:string}[]=[],text:string[]=[],posts:any[]=[];
    const section=(v:any)=>id(v.tab_id)&&typeof v.tab_name==='string'?{id:id(v.tab_id),name:v.tab_name.slice(0,60)}:undefined;
    const thread=t.kind==='forum'?null:{id:t.tid!,title:str(data.thread.title).slice(0,300),author:rowAuthor(data.thread),replyCount:Number(data.thread.reply_num)||0,replyTarget:web+'/p/'+t.tid,section:section(data.thread)};
    text.push(forum.name+'吧'+(thread?' / '+thread.title:''));
    let textEnd=text[0].length;
    // Keep offsets into the exact paged body. A slice starting mid-sentence
    // must carry the same author and reply target as the start of the post.
    function appendPost(item:any,header:string,separator:string,body:string){
      const start=textEnd+2,contentStart=start+header.length+separator.length;
      textEnd=contentStart+body.length;
      item.textRange={start,contentStart,end:textEnd};
      text.push(header+separator+body);
    }
    let parentPost:any;
    if(t.kind==='comments'){
      const parent=content(data.post.content,'父楼 '+t.pid);
      parentPost={id:t.pid,url:web+'/p/'+t.tid+'?pid='+t.pid+'#'+t.pid,author:rowAuthor(data.post),floor:Number(data.post.floor)||null,publishedAt:timestamp(data.post.time),content:parent.text.slice(0,1000),contentTruncated:parent.text.length>1000,parentPostId:null};
      parentPost.replyTarget=parentPost.floor===1?thread!.replyTarget:parentPost.url;
      appendPost(parentPost,'父楼 '+t.pid+'（'+str(data.post.floor)+'楼），'+(parentPost.author.name??'未知作者'),'：',parent.text);
      images.push(...parent.images);links.push(...parent.links);
    }
    for(const row of array(source).slice(0,100)){
      const rowId=id(row.id);if(!rowId)continue;
      const isForum=t.kind==='forum',url=isForum?web+'/p/'+rowId:pageUrl(t.kind==='thread'?{...t,postId:rowId}:t)+'#'+rowId;
      const who=rowAuthor(row),publishedAt=timestamp(isForum?row.create_time:row.time);
      const body=content(isForum?(row.first_post_content??row.abstract):row.content,(isForum?'帖子 ':'楼层 ')+rowId);
      const comments=Number(row.sub_post_number)||0;
      const commentsUrl=!isForum&&t.kind==='thread'&&comments>0?pageUrl({kind:'comments',tid:t.tid,pid:rowId,page:1}):null;
      const item:any={id:rowId,url,author:who,publishedAt,content:body.text.slice(0,isForum?400:1000),contentTruncated:body.text.length>(isForum?400:1000),...(isForum?{title:str(row.title).slice(0,300),pinned:Number(row.is_top)>0,replyCount:Number(row.reply_num)||0,bodyKind:'preview'}:{floor:Number(row.floor)||null,parentPostId:t.kind==='comments'?t.pid:null,commentCount:comments,commentsUrl})};
      item.replyTarget=!isForum&&t.kind==='thread'&&item.floor===1?thread!.replyTarget:url;
      if(t.kind==='comments'){
        item.floor=parentPost.floor;
        item.replyTo=commentRecipient(row.content,parentPost.author);
      }
      if(isForum){const tab=section(row);if(tab)item.section=tab;}
      posts.push(item);images.push(...body.images);links.push(...body.links);
      if(isForum)links.push({url,label:(item.pinned?'[置顶] ':'')+item.title});
      if(commentsUrl)links.push({url:commentsUrl,label:row.floor+'楼的楼中楼（'+comments+'条）'});
      const header=(isForum?(item.pinned?'[置顶] ':'')+item.title:'['+(t.kind==='comments'?'楼中楼':row.floor+'楼')+']')+' id='+rowId+' | '+(who.name??'未知作者')+' | '+(publishedAt??'时间未提供');
      appendPost(item,header,'\n',isForum?body.text.slice(0,400):body.text);
    }
    const p=data.page??{},current=Number(p.current_page)||t.page;
    if(current!==t.page&&!t.postId)throw new FishError('TIEBA_PAGE_MISMATCH');
    const totalPages=Number(p.total_page)||null,hasMore=p.has_more==null?!!totalPages&&current<totalPages:Number(p.has_more)>0;
    const nextPage=hasMore?pageUrl(t,current+1):null;
    if(nextPage)links.push({url:nextPage,label:'下一页'});
    return {...base,title:forum.name+'吧'+(thread?' · '+thread.title:''),status:missingComments?'partial':posts.length?'content':'empty',
      coverage:t.kind==='forum'?'forum_thread_previews':t.kind==='thread'?'thread_floors':'floor_comments',
      forum,thread,...(t.kind==='forum'?{sections:forumSections(data.frs_main_tab_list)}:{}),...(parentPost?{parentPost}:{}),page:current,totalPages,totalReported:Number(t.kind==='comments'?data.subpost_num??p.total_count:p.total_count??p.total_num)||0,returned:posts.length,
      platformNotice:str(data.partial_visible_toast).slice(0,300)||null,
      ...(t.postId?{target:{postId:t.postId,found:posts.some(p=>p.id===t.postId),coverage:'returned_page',order:'reverse_time'}}:{}),
      notice:t.kind==='forum'?'按发帖时间请求，置顶单独标记。列表是摘要，点帖子读取正文；仅当前页，nextPage 继续。':'posts 按发言列出。textOffset 续读正文，nextPage 翻页，commentsUrl 读楼中楼。仅接口公开返回的内容，删除或隐藏回复可能缺失。',
      unavailable:missingComments?[{url:r.url,error:'TIEBA_COMMENTS_NOT_RETURNED'}]:[] as {url:string;error:string}[],posts,text:text.join('\n\n').slice(0,200000),images,links,nextPage};
  }catch(e){
    if(signal?.aborted)throw e;
    return {...base,status:'unavailable',coverage:'none',notice:'贴吧未返回可读内容；错误见 unavailable，不能当成已读帖子。',
      unavailable:[{url:r.url,error:codeOf(e)}],posts:[] as any[],text:'',images:[] as {url:string;label:string;kind:string}[],links:[] as {url:string;label:string}[],nextPage:null};
  }
}

export async function readBigFishSections(poster:PublicPoster,signal?:AbortSignal){
  const page=await tiebaPage(BIG_FISH_FORUM.url,poster,signal);
  return bigFishPostingSections(page??{});
}
