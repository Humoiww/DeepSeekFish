import fs from 'node:fs';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { makeDir,safePath,writePrivate } from '../paths.js';
import { Store,redact } from '../storage/db.js';
import { FishError,codeOf,type ChatPart } from '../types.js';
import type { Config } from '../config.js';
import { OneBotTransport } from '../qq/onebot.js';
import { memoryDay,type RecallScope } from './journal.js';

export interface QzonePost {id:string;text:string;publishedAt:number;source:string;imageCount:number}
export interface PersonSnapshot {id:string;person:string;conversation:string;observedAt:number;profile:Record<string,string>;posts:QzonePost[];avatar?:string;screenshot?:string;postImages:string[];errors:{stage:string;code:string}[]}
export function requestsQzone(text:string):boolean{return !/动态规划|动态链接|动态类型|动态库/.test(text)&&(/(?:动态|说说|空间|朋友圈).*(?:最新|最近|评|看|吐槽|确认|浏览)|(?:最新|最近|评判|点评|评论|评价|吐槽|看看|看下|确认|翻翻|浏览|每条|全部|所有).*(?:动态|说说|空间|朋友圈)/.test(text)||/(?:上+|上一|第[一二两三四五六七八九十\d]+)条(?:动态|说说)?(?=$|[呢啊吗？！。?！\s])|下一页|继续翻页/.test(text));}
export function requestsAvatar(text:string):boolean{return /头像|QQ资料|个人资料/.test(text);}
export function parseQzone(text:string):any{
  let value:any;try{value=JSON.parse(text);}catch{const a=text.indexOf('('),b=text.lastIndexOf(')');if(a<0||b<a)throw new FishError('QZONE_RESPONSE_INVALID');try{value=JSON.parse(text.slice(a+1,b));}catch{throw new FishError('QZONE_RESPONSE_INVALID');}}
  if(value.code!==0)throw new FishError('QZONE_ACCESS_UNAVAILABLE');
  if(value.msglist!==undefined&&!Array.isArray(value.msglist))throw new FishError('QZONE_RESPONSE_INVALID');return value;
}
export async function responseBytes(response:Response,max=4194304):Promise<Buffer>{
  if(!response.ok||!response.body)throw new FishError('PROFILE_DOWNLOAD_FAILED');
  const chunks:Buffer[]=[];let size=0;const reader=response.body.getReader();
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new FishError('PROFILE_IMAGE_LIMIT');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}
export function imageMime(data:Buffer):string{
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(data[0]===255&&data[1]===216&&data[2]===255)return 'image/jpeg';
  if(data.subarray(0,6).toString().startsWith('GIF8'))return 'image/gif';
  if(data.subarray(0,4).toString()==='RIFF'&&data.subarray(8,12).toString()==='WEBP')return 'image/webp';
  throw new FishError('PROFILE_IMAGE_INVALID');
}
export function capturePage(uin:string,cookie:string,postId?:string):Promise<{png:string;page:{title:string;text:string}}> {
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({uin,cookie,postId}),req=request({socketPath:'/run/deepseekfish-capture.sock',path:'/capture',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},res=>{
      let data='';res.on('data',b=>{data+=b;if(data.length>14000000)res.destroy(Error('limit'));});res.on('error',()=>reject(new FishError('PROFILE_CAPTURE_FAILED')));
      res.on('end',()=>{try{if(res.statusCode!==200)throw 0;resolve(JSON.parse(data));}catch{reject(new FishError('PROFILE_CAPTURE_FAILED'));}});
    });req.setTimeout(27000,()=>req.destroy());req.on('error',()=>reject(new FishError('PROFILE_CAPTURE_UNAVAILABLE')));req.end(body);
  });
}
export class PersonMemory {
  private pending=new Map<string,Promise<PersonSnapshot>>();
  constructor(private root:string,private store:Store,private qq:OneBotTransport,private cfg:()=>Config,private http:typeof fetch=fetch,private capture=capturePage){
    makeDir(root,'runtime/memory/people');store.db.exec('CREATE TABLE IF NOT EXISTS person_observations(id TEXT PRIMARY KEY,conversation TEXT,person TEXT,observed INTEGER,kind TEXT,data TEXT);CREATE INDEX IF NOT EXISTS person_scope_time ON person_observations(conversation,person,observed)');
  }
  remembered(person:string,conversation:string,scope:RecallScope):PersonSnapshot|undefined{
    const params:any[]=[conversation,person,scope.since];let where='conversation=? AND person=? AND observed>=?';
    if(scope.until!==undefined){where+=' AND observed<?';params.push(scope.until);}
    if(scope.term){where+=' AND instr(lower(data),lower(?))>0';params.push(scope.term);}
    const row=this.store.db.prepare(`SELECT data FROM person_observations WHERE ${where} ORDER BY observed DESC LIMIT 1`).get(...params) as any;
    return row?JSON.parse(row.data):undefined;
  }
  refresh(person:string,conversation:string,force=false):Promise<PersonSnapshot>{
    if(!/^[1-9]\d{0,19}$/.test(person))return Promise.reject(new FishError('PERSON_ID_INVALID'));
    if(conversation.startsWith('private:')?(conversation!=='private:'+person||!this.cfg().privateUsers.includes(person)):!this.cfg().groups.includes(conversation))return Promise.reject(new FishError('PERSON_SCOPE_NOT_ALLOWED'));
    const key=conversation+'\0'+person;
    const latest=this.remembered(person,conversation,{mode:'recent',since:0});
    if(!force&&latest&&memoryDay(latest.observedAt)===memoryDay())return Promise.resolve(latest);
    const existing=this.pending.get(key);if(existing)return existing;
    const task=this.read(person,conversation).finally(()=>this.pending.delete(key));this.pending.set(key,task);return task;
  }
  private async read(person:string,conversation:string):Promise<PersonSnapshot>{
    const id=randomUUID(),relative='runtime/memory/people/'+person+'/'+memoryDay()+'/'+id;
    makeDir(this.root,relative);
    const snapshot:PersonSnapshot={id,person,conversation,observedAt:Date.now(),profile:{},posts:[],postImages:[],errors:[]};
    const fail=(stage:string,error:unknown)=>snapshot.errors.push({stage,code:error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'PROFILE_FETCH_TIMEOUT':codeOf(error)});
    try{
      const info=await this.qq.readPerson(person);
      for(const [to,from] of [['nickname','nickname'],['signature','long_nick'],['province','province'],['city','city'],['interests','interest'],['level','qqLevel']]){
        const value=info[from];if(['string','number'].includes(typeof value))snapshot.profile[to]=redact(String(value)).slice(0,300);
      }
    }catch(e){fail('profile',e);}
    try{
      const response=await this.http('https://q1.qlogo.cn/g?b=qq&nk='+person+'&s=640',{redirect:'error',signal:AbortSignal.timeout(8000)}),data=await responseBytes(response,2097152),mime=imageMime(data);
      snapshot.avatar=relative+'/avatar.'+mime.split('/')[1];fs.writeFileSync(safePath(this.root,snapshot.avatar),data,{mode:0o600});
    }catch(e){fail('avatar',e);}
    writePrivate(this.root,relative+'/observation.json',JSON.stringify(snapshot,null,2)+'\n');
    this.store.db.prepare('INSERT INTO person_observations VALUES (?,?,?,?,?,?)').run(id,conversation,person,snapshot.observedAt,'qq-profile',JSON.stringify(snapshot));
    return snapshot;
  }
  images(snapshot:PersonSnapshot,posts=false):ChatPart[]{
    const files=[snapshot.avatar].filter((p):p is string=>!!p),parts:ChatPart[]=[];
    for(const file of files){
      if(!file.startsWith('runtime/memory/people/'+snapshot.person+'/'))continue;
      try{
        const absolute=safePath(this.root,file);if(fs.statSync(absolute).size>4194304)continue;
        const data=fs.readFileSync(absolute),mime=imageMime(data);parts.push({type:'text',text:JSON.stringify({source:'qq_avatar',person:snapshot.person})},{type:'image_url',image_url:{url:'data:'+mime+';base64,'+data.toString('base64'),detail:'low'}});
      }catch{}
    }
    return parts;
  }
  async close(){await Promise.allSettled(this.pending.values());}
}
