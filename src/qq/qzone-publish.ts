import { FishError } from '../types.js';
import { imageMime,responseBytes } from '../memory/people.js';
import type { OneBotTransport } from './onebot.js';

const UPLOAD='https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image';
const PUBLISH='https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6';
const LIST='https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6';
export interface UploadedPhoto {richval:string;picBo:string}
export class QzoneRejected extends FishError {
  constructor(public stage:string,public providerCode:number){super('QZONE_'+stage.toUpperCase()+'_REJECTED_'+providerCode);}
}
/** JSON / JSONP / upload callback wrapper, never evaluated as JavaScript. */
export function qzoneResponse(text:string):any{
  const start=text.indexOf('{'),end=text.lastIndexOf('}');let data:any;
  try{data=JSON.parse(text.slice(start,end+1));}catch{throw new FishError('QZONE_RESPONSE_INVALID');}
  // The photo endpoint uses ret, while the emotion endpoints use code.
  if(!data||typeof data!=='object')throw new FishError('QZONE_RESPONSE_INVALID');
  const code=data.code??data.ret;if(!Number.isSafeInteger(code))throw new FishError('QZONE_RESPONSE_INVALID');return {...data,code};
}
function checked(data:any,stage:string):any{if(data.code!==0)throw new QzoneRejected(stage,data.code);return data;}
function field(v:unknown):string{if(typeof v!=='string'||!v||v.length>4000||/[\r\n\t,]/.test(v))throw new FishError('QZONE_UPLOAD_RECEIPT_INVALID');return v;}
/** Trusted publishing adapter. Cookies never leave this class or enter drafts. */
export class QzonePublisher {
  constructor(private qq:Pick<OneBotTransport,'qzoneSession'>,public self:string,private http:typeof fetch=fetch){
    if(!/^[1-9]\d{0,19}$/.test(self))throw new FishError('QZONE_ACCOUNT_INVALID');
  }
  private async auth(){
    const {cookies,bkn}=await this.qq.qzoneSession();
    const parts=Object.fromEntries(cookies.split(';').map(v=>{const i=v.indexOf('=');return [v.slice(0,i).trim(),v.slice(i+1).trim()];}));
    const account=String(parts.p_uin??parts.uin??'').replace(/^o0*/,'');
    if(account!==this.self||!parts.p_skey||!/^\d+$/.test(bkn))throw new FishError('QZONE_LOGIN_REQUIRED');
    return {cookies,bkn,parts};
  }
  private headers(cookie:string){return {cookie,referer:'https://user.qzone.qq.com/'+this.self,origin:'https://user.qzone.qq.com','user-agent':'Mozilla/5.0','content-type':'application/x-www-form-urlencoded;charset=UTF-8'};}
  async upload(bytes:Buffer):Promise<UploadedPhoto>{
    if(bytes.length>10485760||imageMime(bytes)!=='image/png')throw new FishError('QZONE_IMAGE_INVALID');
    const a=await this.auth(),url=UPLOAD+'?g_tk='+a.bkn;
    const body=new URLSearchParams({filename:'image.png',uin:this.self,skey:a.parts.skey??'',zzpaneluin:this.self,zzpanelkey:'',p_uin:this.self,p_skey:a.parts.p_skey,
      qzonetoken:'',uploadtype:'1',albumtype:'7',exttype:'0',refer:'shuoshuo',output_type:'jsonhtml',charset:'utf-8',output_charset:'utf-8',
      upload_hd:'1',hd_width:'2048',hd_height:'10000',hd_quality:'96',base64:'1',jsonhtml_callback:'callback',picfile:bytes.toString('base64'),url,qzreferrer:'https://user.qzone.qq.com/'+this.self});
    const response=await this.http(url,{method:'POST',redirect:'error',headers:this.headers(a.cookies),body,signal:AbortSignal.timeout(60000)});
    const data=checked(qzoneResponse((await responseBytes(response,1048576)).toString()),'upload').data;
    if(!data)throw new FishError('QZONE_UPLOAD_RECEIPT_INVALID');
    const lloc=field(data.lloc),sloc=field(data.sloc||data.lloc),album=field(data.albumid||data.lloc);
    const width=Number(data.width),height=Number(data.height),type=Number(data.type??data.picType??1);
    if(![width,height,type].every(Number.isSafeInteger)||width<1||height<1)throw new FishError('QZONE_UPLOAD_RECEIPT_INVALID');
    let bo=data.bo??data.pic_bo;
    if(!bo&&typeof data.url==='string')try{bo=new URL(data.url).searchParams.get('bo');}catch{}
    return {richval:["",album,lloc,sloc,type,height,width,"",height,width].join(','),picBo:field(bo)};
  }
  async publish(text:string,photo:UploadedPhoto,onSubmit:()=>void):Promise<{id:string;url:string}>{
    if(!text.trim()||text.length>1200||!photo.richval||!photo.picBo)throw new FishError('QZONE_DRAFT_INVALID');
    const a=await this.auth();
    const body=new URLSearchParams({syn_tweet_verson:'1',paramstr:'1',pic_template:'',richtype:'1',subrichtype:'1',richval:photo.richval,pic_bo:photo.picBo,
      who:'1',con:text,feedversion:'1',ver:'1',ugc_right:'1',to_sign:'0',hostuin:this.self,code_version:'1',format:'json',qzreferrer:'https://user.qzone.qq.com/'+this.self});
    onSubmit(); // Persist before the one external write; an uncertain response is never retried blindly.
    const response=await this.http(PUBLISH+'?g_tk='+a.bkn,{method:'POST',redirect:'error',headers:this.headers(a.cookies),body,signal:AbortSignal.timeout(30000)});
    const data=checked(qzoneResponse((await responseBytes(response,1048576)).toString()),'publish');
    const id=data.tid??data.t1_tid??data.data?.tid;
    if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(id))throw new FishError('QZONE_PUBLISH_UNCONFIRMED');
    return {id,url:'https://user.qzone.qq.com/'+this.self+'/mood/'+id};
  }
  async find(text:string,since:number):Promise<{id:string;url:string}|undefined>{
    const a=await this.auth(),url=new URL(LIST);
    for(const [k,v] of Object.entries({uin:this.self,ftype:'0',sort:'0',pos:'0',num:'20',replynum:'0',g_tk:a.bkn,code_version:'1',format:'json'}))url.searchParams.set(k,v);
    const data=checked(qzoneResponse((await responseBytes(await this.http(url,{redirect:'error',headers:this.headers(a.cookies),signal:AbortSignal.timeout(20000)}),2097152)).toString()),'read');
    if(!Array.isArray(data.msglist))throw new FishError('QZONE_RESPONSE_INVALID');
    const match=data.msglist.find((p:any)=>String(p.uin??this.self)===this.self&&p.content===text&&Number(p.created_time)*1000>=since&&Number(p.pictotal)>0&&typeof p.tid==='string'&&/^[a-zA-Z0-9_-]{1,120}$/.test(p.tid));
    return match?{id:match.tid,url:'https://user.qzone.qq.com/'+this.self+'/mood/'+match.tid}:undefined;
  }
}
