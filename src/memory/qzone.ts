import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeDir,safePath,writePrivate } from '../paths.js';
import { Store,redact } from '../storage/db.js';
import { FishError,codeOf,type ChatPart } from '../types.js';
import type { Config } from '../config.js';
import type { OneBotTransport } from '../qq/onebot.js';
import { memoryDay,dayStart,type RecallScope } from './journal.js';
import { parseQzone,responseBytes,imageMime,capturePage } from './people.js';

export interface QzoneSelection {index:number;count:number}
function integer(text:string):number{
  if(/^\d+$/.test(text))return Number(text);
  const digits:Record<string,number>={零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};let n=0,part=0;
  for(const c of text){if(c==='十'){n+=(part||1)*10;part=0;}else if(c==='百'){n+=(part||1)*100;part=0;}else part=digits[c]??0;}return n+part;
}
export function qzoneSelection(text:string,lastIndex=1,nextIndex?:number):QzoneSelection|undefined{
  if(/下一页|继续翻页/.test(text))return {index:nextIndex??lastIndex+10,count:10};
  const ordinal=/第([一二两三四五六七八九十百零\d]+)条/.exec(text);if(ordinal)return {index:integer(ordinal[1]),count:1};
  const repeated=/(上{2,})条/.exec(text);if(repeated)return {index:repeated[1].length+1,count:1};
  if(/再(?:往)?上(?:一)?条/.test(text))return {index:lastIndex+1,count:1};
  if(/上(?:一)?条|前一条/.test(text))return {index:2,count:1};
  const amount=/(?:最近|最新|前)([一二两三四五六七八九十\d]+)条/.exec(text);if(amount)return {index:1,count:Math.min(10,integer(amount[1]))};
  if(/每条|全部|所有|逐条|列表/.test(text))return {index:1,count:10};
  if(/最新|最近/.test(text))return {index:1,count:1};
  return undefined;
}
interface PostMedia {kind:'photo'|'animated_image'|'video_cover';path?:string;status:'downloaded'|'unavailable';mime?:string;videoSeconds?:number}
interface Post {id:string;position:number;owner:string;text:string;publishedAt:number;source:string;media:PostMedia[];imageCount:number;videoCount:number}
export interface QzoneSnapshot {id:string;person:string;conversation:string;observedAt:number;index:number;total:number;posts:Post[];nextIndex:number|null;screenshot?:string;errors:{stage:string;postId?:string;code:string}[]}
const safeImage=(raw:unknown)=>{if(typeof raw!=='string')throw new FishError('QZONE_MEDIA_URL_INVALID');const u=new URL(raw.replace(/^http:/,'https:'),'https://user.qzone.qq.com');if(u.protocol!=='https:'||!['qq.com','qpic.cn','qlogo.cn','gtimg.cn','gtimg.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))throw new FishError('QZONE_MEDIA_DOMAIN_INVALID');return u;};
export class QzoneMemory {
  private pending=new Set<Promise<QzoneSnapshot>>();
  constructor(private root:string,private store:Store,private qq:OneBotTransport,private cfg:()=>Config,private http:typeof fetch=fetch,private capture=capturePage){
    store.db.exec('CREATE TABLE IF NOT EXISTS qzone_observations(id TEXT PRIMARY KEY,conversation TEXT,person TEXT,observed INTEGER,data TEXT);CREATE INDEX IF NOT EXISTS qzone_scope ON qzone_observations(conversation,person,observed)');
  }
  lastIndex(person:string,conversation:string):number{
    const row=this.store.db.prepare('SELECT data FROM qzone_observations WHERE person=? AND conversation=? AND observed>=? ORDER BY observed DESC LIMIT 1').get(person,conversation,dayStart()-86400000) as any;
    return row?JSON.parse(row.data).index:1;
  }
  remembered(person:string,conversation:string,scope:RecallScope):QzoneSnapshot|undefined{
    let where='person=? AND conversation=? AND observed>=?';const params:any[]=[person,conversation,scope.since];
    if(scope.until!==undefined){where+=' AND observed<?';params.push(scope.until);}
    if(scope.term){where+=' AND instr(lower(data),lower(?))>0';params.push(scope.term);}
    const row=this.store.db.prepare('SELECT data FROM qzone_observations WHERE '+where+' ORDER BY observed DESC LIMIT 1').get(...params) as any;
    return row?JSON.parse(row.data):undefined;
  }
  read(person:string,conversation:string,selection:QzoneSelection):Promise<QzoneSnapshot>{
    if(!/^[1-9]\d{0,19}$/.test(person)||!Number.isInteger(selection.index)||selection.index<1||selection.index>10000||!Number.isInteger(selection.count)||selection.count<1||selection.count>10)throw new FishError('QZONE_SELECTION_INVALID');
    if(conversation.startsWith('private:')?(conversation!=='private:'+person||!this.cfg().privateUsers.includes(person)):!this.cfg().groups.includes(conversation))throw new FishError('PERSON_SCOPE_NOT_ALLOWED');
    const work=this.fetch(person,conversation,selection);this.pending.add(work);void work.finally(()=>this.pending.delete(work)).catch(()=>{});return work;
  }
  private async fetch(person:string,conversation:string,{index,count}:QzoneSelection):Promise<QzoneSnapshot>{
    const session=await this.qq.qzoneSession();if(typeof session.cookies!=='string'||!session.bkn)throw new FishError('QZONE_LOGIN_REQUIRED');
    const url=new URL('https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6');
    for(const [k,v] of Object.entries({uin:person,ftype:'0',sort:'0',pos:String(index-1),num:String(count),replynum:'0',g_tk:session.bkn,code_version:'1',format:'json',need_private_comment:'0'}))url.searchParams.set(k,v);
    const data=parseQzone((await responseBytes(await this.http(url,{redirect:'error',headers:{cookie:session.cookies,referer:'https://user.qzone.qq.com/'+person,'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)}),2097152)).toString());
    const id=randomUUID(),folder='runtime/memory/people/'+person+'/'+memoryDay()+'/'+id;makeDir(this.root,folder);
    const snapshot:QzoneSnapshot={id,person,conversation,observedAt:Date.now(),index,total:Math.max(0,Number(data.total)||0),posts:[],nextIndex:null,errors:[]};
    const rows=(data.msglist??[]).slice(0,count),seen=new Set<string>();let budget=12582912;
    for(const [offset,row] of rows.entries()){
      if(typeof row.tid!=='string'||!row.tid||row.tid.length>120||seen.has(row.tid)||(row.uin!==undefined&&String(row.uin)!==person))throw new FishError('QZONE_POST_IDENTITY_INVALID');seen.add(row.tid);
      const pics=Array.isArray(row.pic)?row.pic:[],videos=Array.isArray(row.video)?row.video:[];
      const post:Post={id:row.tid,position:index+offset,owner:person,text:redact(typeof row.content==='string'?row.content:'').slice(0,8000),publishedAt:Number(row.created_time)*1000||0,source:'https://user.qzone.qq.com/'+person+'/mood/'+encodeURIComponent(row.tid),media:[],imageCount:Number(row.pictotal)||pics.length,videoCount:Number(row.videototal)||videos.length};snapshot.posts.push(post);
      const selected=[...pics.map((p:any)=>({raw:p.url3||p.url2||p.url1||p.smallurl,kind:'photo' as const,seconds:0})),...videos.map((v:any)=>({raw:v.pic_url||v.url1,kind:'video_cover' as const,seconds:Number(v.video_time)||0}))].slice(0,count>1?1:9);
      for(const [i,entry] of selected.entries()){
        const media:PostMedia={kind:entry.kind,status:'unavailable',...(entry.seconds?{videoSeconds:entry.seconds}:{})};post.media.push(media);
        try{
          const bytes=await responseBytes(await this.http(safeImage(entry.raw),{redirect:'error',signal:AbortSignal.timeout(15000)})),mime=imageMime(bytes);
          if(bytes.length>budget)throw new FishError('QZONE_MEDIA_BUDGET');budget-=bytes.length;
          media.mime=mime;if(mime==='image/gif'&&media.kind==='photo')media.kind='animated_image';
          media.path=folder+'/post-'+post.position+'-'+i+'.'+mime.split('/')[1];fs.writeFileSync(safePath(this.root,media.path),bytes,{mode:0o600});media.status='downloaded';
        }catch(e){snapshot.errors.push({stage:'post-media',postId:post.id,code:codeOf(e)});}
      }
    }
    snapshot.nextIndex=rows.length&&index+rows.length<=snapshot.total?index+rows.length:null;
    if(snapshot.posts[0]){
      try{
        const page=await this.capture(person,session.cookies,snapshot.posts[0].id),png=Buffer.from(page.png,'base64');if(imageMime(png)!=='image/png')throw new FishError('QZONE_SCREENSHOT_INVALID');
        const expected=snapshot.posts[0].text.replace(/\s/g,'').slice(0,24);if(expected&&!page.page.text.replace(/\s/g,'').includes(expected))throw new FishError('QZONE_SCREENSHOT_POST_NOT_FOUND');
        snapshot.screenshot=folder+'/qzone.png';fs.writeFileSync(safePath(this.root,snapshot.screenshot),png,{mode:0o600});
      }catch(e){snapshot.errors.push({stage:'screenshot',code:codeOf(e)});}
    }
    writePrivate(this.root,folder+'/qzone.json',JSON.stringify(snapshot,null,2));
    this.store.db.prepare('INSERT INTO qzone_observations VALUES (?,?,?,?,?)').run(id,conversation,person,snapshot.observedAt,JSON.stringify(snapshot));return snapshot;
  }
  context(snapshot:QzoneSnapshot){
    return {source:'QQ空间本人说说列表',status:snapshot.posts.length?'ok':'empty',requestedIndex:snapshot.index,total:snapshot.total,nextIndex:snapshot.nextIndex,confirmedPosts:snapshot.posts.length,
      posts:snapshot.posts.map(p=>({id:p.id,position:p.position,owner:p.owner,text:p.text,published:memoryDay(p.publishedAt||snapshot.observedAt),source:p.source,
        imageCount:p.imageCount,videoCount:p.videoCount,media:p.media.map(({path,...m})=>m)})),errors:snapshot.errors.filter(e=>e.stage!=='screenshot')};
  }
  images(snapshot:QzoneSnapshot):ChatPart[]{
    const parts:ChatPart[]=[];let budget=12582912;
    for(const post of snapshot.posts)for(const media of post.media){
      if(!media.path||media.status!=='downloaded'||!media.path.startsWith('runtime/memory/people/'+snapshot.person+'/'))continue;
      const file=safePath(this.root,media.path),st=fs.statSync(file);if(st.size>4194304||st.size>budget)continue;budget-=st.size;
      const bytes=fs.readFileSync(file),mime=imageMime(bytes);
      parts.push({type:'text',text:JSON.stringify({source:'QQ空间说说附件',postId:post.id,position:post.position,kind:media.kind,...(media.kind==='video_cover'?{viewed:'cover_only'}:{})})},{type:'image_url',image_url:{url:'data:'+mime+';base64,'+bytes.toString('base64'),detail:'high'}});
    }return parts;
  }
  async close(){await Promise.allSettled(this.pending);}
}
