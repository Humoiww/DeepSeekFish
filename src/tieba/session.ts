import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {TiebaPosting,type FollowedForum,type PostingPolicy,type PublishInput,type SystemDeletion,publishInput,postingTarget,postingRequest} from './posting.js';
import {FishError,codeOf} from '../types.js';
import type {TiebaReplyPage} from './replies.js';
import {tiebaPage} from '../search/tieba.js';
import {postPublic} from '../search/public-web.js';
import type {WebOutcome} from './web-post.js';

export interface TiebaIdentity {id:string;name:string}
export type AccountState='unconfigured'|'needs_check'|'waiting_login'|'logged_in'|'expired'|'check_failed';
interface PublicationWork {accountId:string;requestId:string;sourceId?:string;input:PublishInput;created:number;updatedAt?:number;stage:string;result?:any}
export interface SessionStatus {state:AccountState;browserRunning:boolean;profileSaved:boolean;verifiedAt:number|null;identity:TiebaIdentity|null;lastIdentity:TiebaIdentity|null;lastError:{code:string;stage:string;at:number}|null;waitingUntil:number|null;verificationRequired:boolean;publication?:{needsHuman:boolean;detectedAt:number|null;error:string|null};interaction?:'login'|'publication'|null;publicationWork?:PublicationWork;loginPage?:{title:string;origin:string;qrVisible:boolean;challenge:boolean;blocked:boolean;bodyCharacters?:number;inputCount?:number;frameCount?:number;blockedOrigins?:string[]}}
export interface LoginInput {kind:'click'|'drag'|'text'|'key'|'scroll';x?:number;y?:number;toX?:number;toY?:number;text?:string;key?:string;delta?:number}
export interface AccountBrowser {
 login():Promise<void>;loginInfo?():Promise<NonNullable<SessionStatus['loginPage']>>;identity():Promise<TiebaIdentity|null>;frame():Promise<Buffer>;input(value:LoginInput):Promise<void>;
 read(url:string):Promise<any>;deletion?(postId:string,threadId:string):Promise<SystemDeletion|null>;replies?(page:number):Promise<TiebaReplyPage>;followed?(userId:string):Promise<FollowedForum[]>;sendPost?(request:ReturnType<typeof postingRequest>):Promise<{id:string;url:string;receipt?:Record<string,unknown>}>;close():Promise<void>;
 prepareWebPost?(request:ReturnType<typeof postingRequest>):Promise<unknown>;submitWebPost?(beforeWrite:()=>void,onOutcome:(outcome:WebOutcome)=>void):Promise<{id:string;url:string;receipt:Record<string,unknown>}>;
 isWebPublishInput?(input:LoginInput):Promise<boolean>;
 holdForInteraction?():void;
}
export function loginInput(v:any):LoginInput{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new FishError('TIEBA_INPUT_INVALID');
 const keys:Record<string,string[]>={click:['kind','x','y'],drag:['kind','x','y','toX','toY'],text:['kind','text'],key:['kind','key'],scroll:['kind','delta']};
 if(!keys[v.kind]||Object.keys(v).some(k=>!keys[v.kind].includes(k)))throw new FishError('TIEBA_INPUT_INVALID');
 for(const [k,limit] of [['x',1000],['toX',1000],['y',800],['toY',800]] as const)if(keys[v.kind].includes(k)&&(!Number.isFinite(v[k])||v[k]<0||v[k]>=limit))throw new FishError('TIEBA_INPUT_INVALID');
 if(v.kind==='text'&&(typeof v.text!=='string'||!v.text.length||v.text.length>1000||/[\0\r\n]/.test(v.text)))throw new FishError('TIEBA_INPUT_INVALID');
 if(v.kind==='key'&&!['Enter','Tab','Backspace','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','SelectAll'].includes(v.key))throw new FishError('TIEBA_INPUT_INVALID');
 if(v.kind==='scroll'&&(!Number.isInteger(v.delta)||Math.abs(v.delta)>700))throw new FishError('TIEBA_INPUT_INVALID');return v;
}
/** Lifecycle/state only. All login material stays in the private driver/profile.
 * The reply watcher may read a saved session; challenges require a human. */
export class TiebaSessionManager {
 private browser?:AccountBrowser;private busy=false;private timer?:NodeJS.Timeout;private locked=false;
 private current:SessionStatus;private lock:string;
 private publicationOpen=false;private publicationWork?:PublicationWork;
 constructor(private dir:string,private open:(profile:string)=>Promise<AccountBrowser>,private now=Date.now,private idleMs=5*60000){
  this.lock=path.join(dir,'manager.lock');
  let saved:any={};try{saved=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8'));}catch{}
  const installed=fs.existsSync(path.join(dir,'installed.json'));
  const state:AccountState=!installed?'unconfigured':saved.state==='expired'?'expired':fs.existsSync(path.join(dir,'profile'))?'needs_check':'waiting_login';
  this.current={state,browserRunning:false,profileSaved:fs.existsSync(path.join(dir,'profile')),identity:null,lastIdentity:saved.lastIdentity??saved.identity??null,verifiedAt:saved.verifiedAt??null,lastError:saved.lastError??null,waitingUntil:null,verificationRequired:true};
  try{const work=JSON.parse(fs.readFileSync(path.join(dir,'publication-work.json'),'utf8'));publishInput(work.input);if(typeof work.requestId==='string'&&typeof work.accountId==='string')this.publicationWork=work;}catch{}
 }
 private publicationStatus(){
  const work=this.publicationWork,needsHuman=work?.stage==='challenge'&&work.result?.error==='TIEBA_PUBLICATION_CHALLENGE';
  return {needsHuman,detectedAt:needsHuman?work.updatedAt??null:null,error:needsHuman?work.result.error:null};
 }
 status():SessionStatus{return structuredClone({...this.current,browserRunning:!!this.browser,publication:this.publicationStatus(),interaction:this.publicationOpen&&this.browser?'publication':this.browser&&this.current.state==='waiting_login'?'login':null,...(this.publicationWork?{publicationWork:this.publicationWork}:{})});}
 private saveWork(){if(!this.publicationWork)return;const p=path.join(this.dir,'publication-work.json');fs.writeFileSync(p+'.tmp',JSON.stringify(this.publicationWork),{mode:0o600});fs.renameSync(p+'.tmp',p);}
 private save(){const p=path.join(this.dir,'status.json'),tmp=p+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.current),{mode:0o600});fs.renameSync(tmp,p);}
 private acquire(){
  if(this.current.state==='unconfigured')throw new FishError('TIEBA_NOT_CONFIGURED');
  if(this.locked)return;
  try{fs.mkdirSync(this.lock,{mode:0o700});}catch(e){
   if((e as any).code!=='EEXIST')throw e;
   let pid:number;try{pid=Number(fs.readFileSync(path.join(this.lock,'pid'),'utf8'));}catch{throw new FishError('TIEBA_PROFILE_BUSY');}
   if(!Number.isSafeInteger(pid)||pid<1)throw new FishError('TIEBA_PROFILE_BUSY');
   try{process.kill(pid,0);throw new FishError('TIEBA_PROFILE_BUSY');}catch(err){if((err as any).code!=='ESRCH')throw new FishError('TIEBA_PROFILE_BUSY');}
   fs.rmSync(this.lock,{recursive:true});fs.mkdirSync(this.lock,{mode:0o700});
  }
  fs.writeFileSync(path.join(this.lock,'pid'),String(process.pid),{mode:0o600});this.locked=true;
 }
 private release(){if(this.locked){fs.rmSync(this.lock,{recursive:true,force:true});this.locked=false;}}
 private async ensure(){this.acquire();if(!this.browser){this.browser=await this.open(path.join(this.dir,'profile'));this.current.profileSaved=true;}}
 private async stop(){clearTimeout(this.timer);this.timer=undefined;try{await this.browser?.close();}finally{this.browser=undefined;this.publicationOpen=false;this.current.browserRunning=false;this.current.waitingUntil=null;this.release();}}
 private touch(){clearTimeout(this.timer);if(this.publicationOpen){this.browser?.holdForInteraction?.();this.current.waitingUntil=null;return;}this.current.waitingUntil=this.now()+this.idleMs;this.timer=setTimeout(()=>{if(this.busy){this.touch();return;}void this.close().catch(()=>{});},this.idleMs);this.timer.unref();}
 private async operation<T>(stage:string,work:()=>Promise<T>):Promise<T>{
  if(this.current.state==='unconfigured')throw new FishError('TIEBA_NOT_CONFIGURED');
  if(this.busy)throw new FishError('TIEBA_BUSY');this.busy=true;
  try{return await work();}catch(e){
   const code=codeOf(e),safe=/^TIEBA_[A-Z_0-9]+$/.test(code)?code:'TIEBA_BROWSER_FAILED';
   this.current.lastError={code:safe,stage,at:this.now()};
   // Method/stack locations only: never login text, cookie values or CDP params.
   console.error(JSON.stringify({component:'tieba-account',stage,code:safe,name:e instanceof Error?e.name:'Error',protocol:(e as any)?.protocol,reason:e instanceof Error&&/^CAPTURE_[A-Z_]+$/.test(e.message)?e.message:undefined,frames:e instanceof Error?e.stack?.split('\n').slice(1,4):undefined}));
   if(!['TIEBA_NOT_CONFIGURED','TIEBA_INPUT_INVALID','TIEBA_LOGIN_NOT_OPEN','TIEBA_PROFILE_BUSY','TIEBA_LOGIN_IN_PROGRESS','TIEBA_LOGIN_REQUIRED'].includes(safe)){this.current.state='check_failed';this.current.identity=null;this.current.verificationRequired=true;await this.stop().catch(()=>{});}
   this.save();throw new FishError(safe);
  }finally{this.busy=false;}
 }
 async start(){return this.operation('login',async()=>{if(this.publicationOpen)throw new FishError('TIEBA_PUBLICATION_IN_PROGRESS');await this.ensure();await this.browser!.login();this.current.loginPage=await this.browser!.loginInfo?.();this.current.state='waiting_login';this.current.identity=null;this.current.verificationRequired=true;this.current.lastError=null;this.touch();this.save();return this.status();});}
 async frame(){return this.operation('frame',async()=>{if(!this.browser||this.current.state!=='waiting_login'&&!this.publicationOpen)throw new FishError('TIEBA_LOGIN_NOT_OPEN');this.touch();this.current.loginPage=await this.browser.loginInfo?.();this.save();return this.browser.frame();});}
 async publicationFrame(requestId:string){
  if(typeof requestId!=='string'||!requestId||requestId.length>240||requestId!==this.publicationWork?.requestId||!this.publicationOpen||!this.browser)throw new FishError('TIEBA_PUBLICATION_WINDOW_CHANGED');
  const bytes=await this.frame();
  if(requestId!==this.publicationWork?.requestId)throw new FishError('TIEBA_PUBLICATION_WINDOW_CHANGED');
  return {bytes,requestId,at:this.now(),live:true};
 }
 async input(value:unknown){const v=loginInput(value);return this.operation('input',async()=>{
  if(!this.browser||this.current.state!=='waiting_login'&&!this.publicationOpen)throw new FishError('TIEBA_LOGIN_NOT_OPEN');
  if(this.publicationOpen&&this.publicationWork?.stage==='prepared'&&await this.browser.isWebPublishInput?.(v))return this.submitPreparedPublication();
  await this.browser.input(v);this.touch();return this.status();
 });}
 async check(){return this.operation('verify',async()=>{
  if(this.publicationOpen)throw new FishError('TIEBA_USE_PUBLICATION_CHECK');
  const loginOpen=!!this.browser;await this.ensure();try{
   const who=await this.browser!.identity();this.current.verifiedAt=this.now();this.current.verificationRequired=false;this.current.lastError=null;
   if(who){const policy=path.join(this.dir,'publishing.json');if(!fs.existsSync(policy))fs.writeFileSync(policy,JSON.stringify({mode:'preview',accountId:who.id}),{mode:0o600,flag:'wx'});this.current.identity=who;this.current.lastIdentity=who;this.current.state='logged_in';}
   else{this.current.identity=null;this.current.state=loginOpen||!this.current.lastIdentity?'waiting_login':'expired';}
   if(who||!loginOpen)await this.stop();else this.touch();this.save();return this.status();
  }catch(e){throw e;}
 });}
 async read(url:string){return this.operation('read',async()=>{
  // A read never starts or redirects the user's interactive login window.
  if(this.browser&&!this.publicationOpen)throw new FishError('TIEBA_LOGIN_IN_PROGRESS');
  if(!this.current.profileSaved||this.current.state==='expired'||this.current.lastError?.code==='TIEBA_LOGIN_CHALLENGE_OR_PAGE_CHANGED')throw new FishError('TIEBA_LOGIN_REQUIRED');
  await this.ensure();try{
   const who=await this.browser!.identity();if(!who){this.current.state=this.current.lastIdentity?'expired':'waiting_login';this.current.identity=null;this.current.verifiedAt=this.now();this.current.verificationRequired=false;this.save();return {status:'login_required',access:{mode:'login_required'},posts:[],text:'',images:[],links:[]};}
   this.current.state='logged_in';this.current.identity=who;this.current.lastIdentity=who;this.current.verifiedAt=this.now();this.current.verificationRequired=false;this.current.lastError=null;
   const result=await this.browser!.read(url);this.save();return {...result,access:{mode:'authenticated',account:who}};
  }finally{if(!this.publicationOpen)await this.stop();}
 });}
 private policy():PostingPolicy{
  let p:any;try{p=JSON.parse(fs.readFileSync(path.join(this.dir,'publishing.json'),'utf8'));}catch{throw new FishError('TIEBA_PUBLISH_NOT_CONFIGURED');}
  if(!['preview','live'].includes(p.mode)||typeof p.accountId!=='string'||! /^[1-9]\d{0,19}$/.test(p.accountId))throw new FishError('TIEBA_PUBLISH_NOT_CONFIGURED');return {mode:p.mode,accountId:p.accountId};
 }
 private async usingAccount<T>(stage:string,work:(browser:AccountBrowser,who:TiebaIdentity)=>Promise<T>,requestId?:string){return this.operation(stage,async()=>{
  if(this.browser&&this.publicationOpen&&stage==='publish'&&this.publicationWork?.requestId!==requestId)await this.stop();
  if(this.browser&&!this.publicationOpen)throw new FishError('TIEBA_LOGIN_IN_PROGRESS');
  if(this.current.state==='expired')throw new FishError('TIEBA_LOGIN_REQUIRED');await this.ensure();
  try{const who=await this.browser!.identity();if(!who){this.current.state='expired';this.current.identity=null;this.current.verifiedAt=this.now();this.save();throw new FishError('TIEBA_LOGIN_REQUIRED');}
   this.current.state='logged_in';this.current.identity=who;this.current.lastIdentity=who;this.current.verifiedAt=this.now();this.current.verificationRequired=false;
   const result=await work(this.browser!,who);this.current.lastError=null;this.save();return result;
  }finally{if(!this.publicationOpen)await this.stop();}
 });}
 async account(){return this.usingAccount('account',async(browser,who)=>{
  if(!browser.followed)throw new FishError('TIEBA_FOLLOW_LIST_UNAVAILABLE');
  const following=await browser.followed(who.id);let mode='unconfigured';try{mode=this.policy().mode;}catch{}
  return {account:who,verifiedAt:this.current.verifiedAt,following,posting:{mode,scope:'followed_forums',otherForums:'read_only',replyTransport:this.webEnabled(who)?'official_web':'app_protobuf',...this.publicationStatus()}};
 });}
 async replies(page=1){
  if(!Number.isSafeInteger(page)||page<1||page>10000)throw new FishError('TIEBA_PAGE_INVALID');
  return this.usingAccount('replies',async(browser,who)=>{
   if(!browser.replies)throw new FishError('TIEBA_REPLIES_UNAVAILABLE');
   return {account:who,...await browser.replies(page)};
  });
 }
 async verifyPublication(requestId:string){
  const verify=async(browser:AccountBrowser,who:TiebaIdentity)=>{
   const posting=new TiebaPosting(this.dir);try{
    const result=await posting.verify(requestId,who,{followed:async()=>[],read:url=>browser.read(url),publicRead:url=>tiebaPage(url,postPublic),...(browser.deletion?{deletion:(id:string,tid:string)=>browser.deletion!(id,tid)}:{})});
    if(this.publicationWork?.requestId===requestId)await this.finishWeb(result);return result;
   }finally{posting.close();}
  };
  // HTTP readback does not navigate away from a pending human challenge.
  if(this.publicationOpen&&this.browser)return this.operation('verify_publication',async()=>{
   const who=await this.browser!.identity();if(!who||who.id!==this.publicationWork?.accountId)throw new FishError('TIEBA_ACCOUNT_CHANGED');return verify(this.browser!,who);
  });
  return this.usingAccount('verify_publication',verify);
 }
 private browserReads(browser:AccountBrowser){return {followed:(id:string)=>browser.followed!(id),read:(url:string)=>browser.read(url),publicRead:(url:string)=>tiebaPage(url,postPublic)};}
 private webEnabled(who:TiebaIdentity){try{const p=JSON.parse(fs.readFileSync(path.join(this.dir,'publishing-web.json'),'utf8'));return p.accountId===who.id&&p.enabled===true;}catch{return false;}}
 private webCallbacks(work:PublicationWork){return {
  before:()=>{const p=new TiebaPosting(this.dir);try{p.webAttempt(work.requestId);work.stage='started';this.saveWork();}finally{p.close();}},
  outcome:(outcome:WebOutcome)=>{const p=new TiebaPosting(this.dir);try{work.result=p.webOutcome(work.requestId,outcome);work.stage=outcome.id?'accepted':outcome.error==='TIEBA_PUBLICATION_CHALLENGE'?'challenge':outcome.error==='TIEBA_PUBLICATION_REJECTED'?'rejected':'unknown';work.updatedAt=this.now();this.saveWork();}finally{p.close();}}
 };}
 private async finishWeb(result:any){
  const work=this.publicationWork!;work.result=result;if(result.publicVerified&&result.deliveryStatus==='confirmed'){
   work.stage='confirmed';if(work.sourceId)fs.writeFileSync(path.join(this.dir,'publishing-web.json'),JSON.stringify({accountId:work.accountId,enabled:true,verifiedAt:this.now(),requestId:work.requestId}),{mode:0o600});
   this.saveWork();await this.stop();
  }else{work.stage=result.error==='TIEBA_PUBLICATION_CHALLENGE'?'challenge':result.deliveryStatus==='accepted'?'accepted':result.deliveryStatus==='failed'?'rejected':'unknown';this.saveWork();
   // Accepted/unknown sends can only be checked, never resubmitted. Keep an
   // interactive browser only when the platform actually requested a human.
   if(work.stage==='challenge'){this.publicationOpen=true;this.touch();}else await this.stop();
  }this.save();
 }
 /** Human-only recovery: prepare the exact rejected intent on the official
  * page, without submitting it. */
 async startPublication(){return this.operation('publication_prepare',async()=>{
  if(this.publicationOpen&&this.browser)return this.status();if(this.browser)throw new FishError('TIEBA_LOGIN_IN_PROGRESS');
  if(this.publicationWork&&['started','accepted','unknown'].includes(this.publicationWork.stage))throw new FishError('TIEBA_CHECK_PENDING_PUBLICATION_FIRST');
  await this.ensure();const who=await this.browser!.identity();if(!who)throw new FishError('TIEBA_LOGIN_REQUIRED');this.current.state='logged_in';this.current.identity=who;this.current.lastIdentity=who;this.current.verifiedAt=this.now();this.current.verificationRequired=false;this.current.lastError=null;
  const p=new TiebaPosting(this.dir);try{
   const source=p.recoverySource(who),input=publishInput(source.request),policy=this.policy();if(policy.mode!=='live')throw new FishError('TIEBA_PUBLISH_DISABLED');
   const target=await postingTarget(input,who,policy,this.browserReads(this.browser!));if(!this.browser!.prepareWebPost)throw new FishError('TIEBA_WEB_UNAVAILABLE');
   const request=postingRequest(input,target);await this.browser!.prepareWebPost({...request,fields:{...request.fields,content:input.content}});
   this.publicationWork={accountId:who.id,requestId:'human-web:'+randomUUID(),sourceId:source.id,input,created:this.now(),stage:'prepared'};this.publicationOpen=true;this.saveWork();this.touch();return this.status();
  }finally{p.close();}
 });}
 /** Authenticated human button. Not registered as a model tool. */
 async submitPublication(){return this.operation('publication_submit',()=>this.submitPreparedPublication());}
 private async submitPreparedPublication(){
  const work=this.publicationWork,browser=this.browser;if(!work||!browser||!this.publicationOpen||work.stage!=='prepared'||!browser.submitWebPost)throw new FishError('TIEBA_PUBLICATION_NOT_PREPARED');
  const who=await browser.identity();if(who?.id!==work.accountId)throw new FishError('TIEBA_ACCOUNT_CHANGED');const p=new TiebaPosting(this.dir),callbacks=this.webCallbacks(work);
  work.stage='started';this.saveWork();
  try{const result=await p.publish(work.input,work.requestId,who,this.policy(),this.browserReads(browser),()=>browser.submitWebPost!(callbacks.before,callbacks.outcome),work.sourceId);work.result=result;await this.finishWeb(result);return this.status();}finally{p.close();}
 }
 async checkPublication(){return this.operation('publication_check',async()=>{
  const work=this.publicationWork;if(!work)throw new FishError('TIEBA_PUBLICATION_NOT_FOUND');await this.ensure();const who=await this.browser!.identity();if(who?.id!==work.accountId)throw new FishError('TIEBA_ACCOUNT_CHANGED');
  const p=new TiebaPosting(this.dir);try{const result=await p.verify(work.requestId,who,this.browserReads(this.browser!));await this.finishWeb(result);return this.status();}finally{p.close();}
 });}
 async publish(raw:PublishInput,requestId:string){const input=publishInput(raw);return this.usingAccount('publish',async(browser,who)=>{
  if(!browser.followed||!browser.sendPost)throw new FishError('TIEBA_PUBLISH_UNAVAILABLE');
  if(this.publicationWork?.requestId!==requestId){this.publicationWork={accountId:who.id,requestId,input,created:this.now(),stage:'preparing'};this.saveWork();}
  const policy=this.policy();
  const useWeb=input.action!=='thread'&&this.webEnabled(who),reader={...this.browserReads(browser),...(!useWeb&&browser.deletion?{deletion:(id:string,tid:string)=>browser.deletion!(id,tid)}:{})},posting=new TiebaPosting(this.dir);
  try{
   const result=await posting.publish(input,requestId,who,policy,reader,async request=>{
    const current=await browser.identity();if(!current||current.id!==who.id)throw new FishError('TIEBA_ACCOUNT_CHANGED');
    // Re-check membership immediately before the write, after target reads.
    await postingTarget(input,current,policy,reader);
    if(useWeb){
     if(!browser.prepareWebPost||!browser.submitWebPost)throw new FishError('TIEBA_WEB_UNAVAILABLE');
     // Rich-text mention prefixes belong to App protobuf only. The official
     // composer binds the parent/child IDs itself through normal controls.
     await browser.prepareWebPost({...request,fields:{...request.fields,content:input.content}});this.publicationWork={accountId:who.id,requestId,input,created:this.now(),stage:'started'};this.saveWork();
     const callbacks=this.webCallbacks(this.publicationWork);return browser.submitWebPost(callbacks.before,callbacks.outcome);
    }
    return browser.sendPost!(request);
   });
   if(!useWeb){this.publicationWork={accountId:who.id,requestId,input,created:this.now(),updatedAt:this.now(),stage:result.error==='TIEBA_PUBLICATION_CHALLENGE'?'challenge':result.publicVerified?'confirmed':result.deliveryStatus==='accepted'?'accepted':result.deliveryStatus==='failed'?'rejected':'unknown',result};this.saveWork();}
   if(useWeb&&this.publicationWork?.requestId===requestId)await this.finishWeb(result);
   return result;
  }finally{posting.close();}
 },requestId);}
 postingHistory(){if(!fs.existsSync(path.join(this.dir,'actions.sqlite')))return [];const p=new TiebaPosting(this.dir);try{return p.history();}finally{p.close();}}
 async logout(){return this.operation('logout',async()=>{this.acquire();await this.stop();this.acquire();try{fs.rmSync(path.join(this.dir,'profile'),{recursive:true,force:true});this.current={state:'waiting_login',browserRunning:false,profileSaved:false,verifiedAt:null,identity:null,lastIdentity:null,lastError:null,waitingUntil:null,verificationRequired:true};this.save();return this.status();}finally{this.release();}});}
 async close(force=false){if(this.busy&&!force)throw new FishError('TIEBA_BUSY');await this.stop();if(this.current.state!=='unconfigured')this.save();}
}
