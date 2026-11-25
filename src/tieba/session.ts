import {ProviderError} from '../diagnostics.js';
import {toolFailure} from '../agent/tool-feedback.js';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {TiebaPosting,type FollowedForum,type PostingPolicy,type PublishInput,type SystemDeletion,publishInput,postingTarget,postingRequest,tiebaHistoryPage,isPublicationLoadFailure} from './posting.js';
import {tiebaImagePaths} from './images.js';
import {FishError,codeOf} from '../types.js';
import type {TiebaReplyPage} from './replies.js';
import type {mentionPage} from './mentions.js';
import {tiebaPage} from '../search/tieba.js';
import {postPublic} from '../search/public-web.js';
import type {WebOutcome} from './web-post.js';
import {moderatorInput,ModeratorJournal,type ModeratorWork} from './moderator.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {replyScopeForTarget,TiebaReplyTargets} from './reply-target.js';
import {AppPostFailure} from './app-post.js';

export interface TiebaIdentity {id:string;name:string}
export type AccountState='unconfigured'|'needs_check'|'waiting_login'|'logged_in'|'expired'|'check_failed';
interface PublicationWork {accountId:string;requestId:string;sourceId?:string;input:PublishInput;created:number;updatedAt?:number;stage:string;result?:any;evidence?:{id:string;stage:string;at:number}[]}
export interface SessionStatus {browserScene?:string|null;workerBusy?:boolean;state:AccountState;browserRunning:boolean;profileSaved:boolean;verifiedAt:number|null;identity:TiebaIdentity|null;lastIdentity:TiebaIdentity|null;lastError:{code:string;stage:string;at:number}|null;waitingUntil:number|null;verificationRequired:boolean;moderatorAuthorized?:boolean;publication?:{needsHuman:boolean;detectedAt:number|null;error:string|null};interaction?:'login'|'publication'|'application'|null;publicationWork?:PublicationWork;moderatorWork?:ModeratorWork;loginPage?:{title:string;origin:string;qrVisible:boolean;challenge:boolean;blocked:boolean;bodyCharacters?:number;inputCount?:number;frameCount?:number;blockedOrigins?:string[];notice?:string;composer?:Record<string,unknown>}}
export interface LoginInput {kind:'click'|'drag'|'pointer_down'|'pointer_move'|'pointer_up'|'text'|'key'|'scroll';x?:number;y?:number;toX?:number;toY?:number;text?:string;key?:string;delta?:number}
export interface AccountBrowser {
 bindOperationSignal?(signal?:AbortSignal):void;cancel?(reason?:unknown):void;operationInfo?():Record<string,unknown>;
 login():Promise<void>;loginInfo?():Promise<NonNullable<SessionStatus['loginPage']>>;identity():Promise<TiebaIdentity|null>;frame(format?:'png'|'jpeg',quality?:number):Promise<Buffer>;input(value:LoginInput):Promise<void>;
 read(url:string):Promise<any>;deletion?(postId:string,threadId:string):Promise<SystemDeletion|null>;replies?(page:number):Promise<TiebaReplyPage>;mentions?(page:number):Promise<ReturnType<typeof mentionPage>>;followed?(userId:string):Promise<FollowedForum[]>;sendPost?(request:ReturnType<typeof postingRequest>):Promise<{id:string;url:string;receipt?:Record<string,unknown>}>;close():Promise<void>;
 prepareWebPost?(request:ReturnType<typeof postingRequest>):Promise<unknown>;submitWebPost?(beforeWrite:()=>void,onOutcome:(outcome:WebOutcome)=>void,onProgress?:(receipt:Record<string,unknown>)=>void):Promise<{id:string;url:string;receipt:Record<string,unknown>}>;
 isWebPublishInput?(input:LoginInput):Promise<boolean>;
 holdForInteraction?():void;
 moderatorApplication?(forum:FollowedForum,account:TiebaIdentity,declaration?:string,before?:()=>void,outcome?:(result:any)=>void):Promise<any>;
}
export function loginInput(v:any):LoginInput{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new FishError('TIEBA_INPUT_INVALID');
 const keys:Record<string,string[]>={click:['kind','x','y'],drag:['kind','x','y','toX','toY'],pointer_down:['kind','x','y','toX','toY'],pointer_move:['kind','x','y'],pointer_up:['kind','x','y'],text:['kind','text'],key:['kind','key'],scroll:['kind','delta']};
 if(!keys[v.kind]||Object.keys(v).some(k=>!keys[v.kind].includes(k)))throw new FishError('TIEBA_INPUT_INVALID');
 const requiredCoords=v.kind==='drag'?['x','y','toX','toY']:['click','pointer_down','pointer_move','pointer_up'].includes(v.kind)?['x','y']:[];
 if(v.kind==='pointer_down'&&(v.toX!==undefined)!==(v.toY!==undefined))throw new FishError('TIEBA_INPUT_INVALID');
 for(const [k,limit] of [['x',1000],['toX',1000],['y',800],['toY',800]] as const){
  if(requiredCoords.includes(k)||v[k]!==undefined){
   if(!Number.isFinite(v[k])||v[k]<0||v[k]>=limit)throw new FishError('TIEBA_INPUT_INVALID');
  }
 }
 if(v.kind==='text'&&(typeof v.text!=='string'||!v.text.length||v.text.length>1000||/[\0\r\n]/.test(v.text)))throw new FishError('TIEBA_INPUT_INVALID');
 if(v.kind==='key'&&!['Enter','Tab','Backspace','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','SelectAll'].includes(v.key))throw new FishError('TIEBA_INPUT_INVALID');
 if(v.kind==='scroll'&&(!Number.isInteger(v.delta)||Math.abs(v.delta)>700))throw new FishError('TIEBA_INPUT_INVALID');return v;
}
/** Lifecycle/state only. All login material stays in the private driver/profile.
 * The reply watcher may read a saved session; challenges require a human. */
export class TiebaSessionManager {
 private operationSignal=new AsyncLocalStorage<AbortSignal>();private operationStage='';
 withOperationSignal<T>(signal:AbortSignal,work:()=>Promise<T>){return this.operationSignal.run(signal,work);}
 timeoutInfo(){return {operation:this.operationStage,...(['publish','publication_submit','publication_prepare','publication_check','verify_publication'].includes(this.operationStage)?this.browser?.operationInfo?.():{})};}
 async cancelTimedOutOperation(){this.browser?.cancel?.(new FishError('TIEBA_QUEUE_EXECUTION_TIMEOUT'));await this.stop();}
 private checkActive(){this.operationSignal.getStore()?.throwIfAborted();}
 private sceneId:string|null=null;private browser?:AccountBrowser;private busy=false;private timer?:NodeJS.Timeout;private locked=false;
 private current:SessionStatus;private lock:string;
 private publicationOpen=false;private publicationWork?:PublicationWork;
 private applicationOpen=false;private moderatorWork?:ModeratorWork;
 private idleClose?:()=>Promise<void>;
 private publicationChallenge?:(requestId:string)=>void;
 private publicationAccepted?:(requestId:string,input:PublishInput,sourceId?:string)=>void;
 private publicationReadback?:(requestId:string)=>void;
 setIdleClose(close:()=>Promise<void>){this.idleClose=close;}
 setPublicationChallenge(observer:(requestId:string)=>void){this.publicationChallenge=observer;}
 setPublicationAccepted(observer:(requestId:string,input:PublishInput,sourceId?:string)=>void){this.publicationAccepted=observer;}
 setPublicationReadback(observer:(requestId:string)=>void){this.publicationReadback=observer;}
 postingAccountId(){try{return this.policy().accountId;}catch{return undefined;}}
 publicationResponsePending(requestId:string){
  const work=this.publicationWork;
  if(!this.publicationOpen||work?.stage!=='started'||requestId!==work.requestId&&requestId!==work.sourceId)return false;
  const phase=this.browser?.operationInfo?.();
  return phase?.monitoredRequestId===work.requestId&&phase.stage==='await_publication_response';
 }
 constructor(private dir:string,private open:(profile:string,signal?:AbortSignal)=>Promise<AccountBrowser>,private now=Date.now,private idleMs=5*60000){
  this.lock=path.join(dir,'manager.lock');
  let saved:any={};try{saved=JSON.parse(fs.readFileSync(path.join(dir,'status.json'),'utf8'));}catch{}
  const installed=fs.existsSync(path.join(dir,'installed.json'));
  const state:AccountState=!installed?'unconfigured':saved.state==='expired'?'expired':fs.existsSync(path.join(dir,'profile'))?'needs_check':'waiting_login';
  this.current={state,browserRunning:false,profileSaved:fs.existsSync(path.join(dir,'profile')),identity:null,lastIdentity:saved.lastIdentity??saved.identity??null,verifiedAt:saved.verifiedAt??null,lastError:saved.lastError??null,waitingUntil:null,verificationRequired:true};
  try{const work=JSON.parse(fs.readFileSync(path.join(dir,'publication-work.json'),'utf8'));publishInput(work.input);if(typeof work.requestId==='string'&&typeof work.accountId==='string')this.publicationWork=work;}catch{}
  try{const work=JSON.parse(fs.readFileSync(path.join(dir,'moderator-work.json'),'utf8'));if(typeof work.requestId==='string'&&typeof work.accountId==='string')this.moderatorWork=work;}catch{}
 }
 private publicationStatus(){
  const work=this.publicationWork,needsHuman=work?.stage==='challenge'&&work.result?.error==='TIEBA_PUBLICATION_CHALLENGE';
  return {needsHuman,detectedAt:needsHuman?work.updatedAt??null:null,error:needsHuman?work.result.error:null};
 }
 private interactiveOpen(){return this.publicationOpen||this.applicationOpen;}
 status():SessionStatus{if(this.publicationWork)this.publicationWork.evidence=this.evidenceIndex(this.publicationWork.requestId);return structuredClone({...this.current,browserScene:this.sceneId,browserRunning:!!this.browser,workerBusy:this.busy,moderatorAuthorized:this.moderatorAuthorized(),publication:this.publicationStatus(),interaction:this.applicationOpen&&this.browser?'application':this.publicationOpen&&this.browser?'publication':this.browser&&this.current.state==='waiting_login'?'login':null,...(this.publicationWork?{publicationWork:this.publicationWork}:{}),...(this.moderatorWork?{moderatorWork:this.moderatorWork}:{})});}
 private evidenceIndex(requestId:string){try{const dir=path.join(this.dir,'evidence',createHash('sha256').update(requestId).digest('hex')),v=JSON.parse(fs.readFileSync(path.join(dir,'index.json'),'utf8'));return v.requestId===requestId&&Array.isArray(v.images)?v.images:[];}catch{return [];}}
 publicationEvidence(requestId:string,id:string){
  if(typeof requestId!=='string'||requestId.length>240||typeof id!=='string'||!/^[a-z_]{1,40}$/.test(id)||!this.evidenceIndex(requestId).some((s:any)=>s.id===id))throw new FishError('TIEBA_EVIDENCE_NOT_FOUND');
  const file=path.join(this.dir,'evidence',createHash('sha256').update(requestId).digest('hex'),id+'.png'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>8*1024*1024)throw new FishError('TIEBA_EVIDENCE_NOT_FOUND');return fs.readFileSync(file);
 }
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
 private async ensure(){this.checkActive();this.acquire();if(!this.browser){this.browser=await this.open(path.join(this.dir,'profile'),this.operationSignal.getStore());this.sceneId=randomUUID();this.current.profileSaved=true;}this.browser.bindOperationSignal?.(this.operationSignal.getStore());this.checkActive();}
 private async stop(){clearTimeout(this.timer);this.timer=undefined;try{await this.browser?.close();}finally{this.browser=undefined;this.sceneId=null;this.publicationOpen=false;this.applicationOpen=false;this.current.browserRunning=false;this.current.waitingUntil=null;this.release();}}
 private touch(){clearTimeout(this.timer);if(this.interactiveOpen()){this.browser?.holdForInteraction?.();this.current.waitingUntil=null;return;}this.current.waitingUntil=this.now()+this.idleMs;this.timer=setTimeout(()=>{if(this.busy){this.touch();return;}void (this.idleClose?this.idleClose():this.close()).catch(()=>{});},this.idleMs);this.timer.unref();}
 private async operation<T>(stage:string,work:()=>Promise<T>):Promise<T>{
  if(this.current.state==='unconfigured')throw new FishError('TIEBA_NOT_CONFIGURED');
  if(this.busy)throw new FishError('TIEBA_BUSY');this.busy=true;this.operationStage=stage;
  try{this.checkActive();const value=await work();this.checkActive();return value;}catch(e){
   if(this.operationSignal.getStore()?.aborted){this.current.lastError={code:'TIEBA_QUEUE_EXECUTION_TIMEOUT',stage,at:this.now()};this.save();throw this.operationSignal.getStore()!.reason;}
   const code=e instanceof Error&&e.message==='CAPTURE_PROTOCOL_TIMEOUT'?'TIEBA_BROWSER_COMMAND_TIMEOUT':codeOf(e),safe=/^TIEBA_[A-Z_0-9]+$/.test(code)?code:'TIEBA_BROWSER_FAILED';
   this.current.lastError={code:safe,stage,at:this.now()};
   // Method/stack locations only: never login text, cookie values or CDP params.
   console.error(JSON.stringify({component:'tieba-account',stage,code:safe,name:e instanceof Error?e.name:'Error',protocol:(e as any)?.protocol,reason:e instanceof Error&&/^CAPTURE_[A-Z_]+$/.test(e.message)?e.message:undefined,frames:e instanceof Error?e.stack?.split('\n').slice(1,4):undefined}));
   const timeoutPhase=this.timeoutInfo(),feedback=toolFailure(e,stage);
   const keepPublication=this.publicationOpen&&!!this.browser&&['publication_prepare','publication_submit','publication_check','input','frame'].includes(stage)&&!['TIEBA_BROWSER_FAILED','TIEBA_ACCOUNT_CHANGED','TIEBA_LOGIN_REQUIRED'].includes(safe);
   if(keepPublication)this.touch();
   else if(!/^TIEBA_MENTIONS_/.test(safe)&&!['TIEBA_NOT_CONFIGURED','TIEBA_INPUT_INVALID','TIEBA_LOGIN_NOT_OPEN','TIEBA_PROFILE_BUSY','TIEBA_LOGIN_IN_PROGRESS','TIEBA_LOGIN_REQUIRED'].includes(safe)){this.current.state='check_failed';this.current.identity=null;this.current.verificationRequired=true;await this.stop().catch(()=>{});}
   this.save();throw Object.assign(new ProviderError(safe,feedback),{timeoutPhase});
  }finally{this.busy=false;this.operationStage='';}
 }
 async start(){return this.operation('login',async()=>{if(this.publicationOpen)throw new FishError('TIEBA_PUBLICATION_IN_PROGRESS');await this.ensure();await this.browser!.login();this.current.loginPage=await this.browser!.loginInfo?.();this.current.state='waiting_login';this.current.identity=null;this.current.verificationRequired=true;this.current.lastError=null;this.touch();this.save();return this.status();});}
 async frame(){return this.operation('frame',async()=>{if(!this.browser||this.current.state!=='waiting_login'&&!this.interactiveOpen())throw new FishError('TIEBA_LOGIN_NOT_OPEN');this.touch();this.current.loginPage=await this.browser.loginInfo?.();this.save();return this.browser.frame();});}
 async publicationFrame(requestId:string){
  const active=()=>this.applicationOpen?this.moderatorWork?.requestId:this.publicationOpen?this.publicationWork?.requestId:undefined;
  if(typeof requestId!=='string'||!requestId||requestId.length>240||requestId!==active()||!this.browser)throw new FishError('TIEBA_PUBLICATION_WINDOW_CHANGED');
  const bytes=await this.frame();
  if(requestId!==active())throw new FishError('TIEBA_PUBLICATION_WINDOW_CHANGED');
  return {bytes,requestId,at:this.now(),live:true};
 }
 async input(value:unknown){const v=loginInput(value);return this.operation('input',async()=>{
  if(!this.browser||this.current.state!=='waiting_login'&&!this.interactiveOpen())throw new FishError('TIEBA_LOGIN_NOT_OPEN');
  if(this.publicationOpen&&this.publicationWork?.stage==='prepared'&&await this.browser.isWebPublishInput?.(v))return this.submitPreparedPublication();
  await this.browser.input(v);
  this.touch();
  if(v.kind==='pointer_down'||v.kind==='pointer_move'){
   const bytes=await this.browser.frame('jpeg',55);
   return {...this.status(),frameImage:bytes.toString('base64'),frameMime:'image/jpeg'};
  }
  if(v.kind==='pointer_up'){
   this.current.loginPage=await this.browser.loginInfo?.();
   const bytes=await this.browser.frame('jpeg',75);
   return {...this.status(),frameImage:bytes.toString('base64'),frameMime:'image/jpeg'};
  }
  return this.status();
 });}
 async check(){return this.operation('verify',async()=>{
  if(this.interactiveOpen())throw new FishError('TIEBA_USE_PUBLICATION_CHECK');
  const loginOpen=!!this.browser;await this.ensure();try{
   const who=await this.browser!.identity();this.current.verifiedAt=this.now();this.current.verificationRequired=false;this.current.lastError=null;
   if(who){const policy=path.join(this.dir,'publishing.json');if(!fs.existsSync(policy))fs.writeFileSync(policy,JSON.stringify({mode:'preview',accountId:who.id}),{mode:0o600,flag:'wx'});this.current.identity=who;this.current.lastIdentity=who;this.current.state='logged_in';}
   else{this.current.identity=null;this.current.state=loginOpen||!this.current.lastIdentity?'waiting_login':'expired';}
   if(who||!loginOpen)await this.stop();else this.touch();this.save();return this.status();
  }catch(e){throw e;}
 });}
 async read(url:string){return this.operation('read',async()=>{
  // A read never starts or redirects the user's interactive login window.
  if(this.browser&&!this.interactiveOpen())throw new FishError('TIEBA_LOGIN_IN_PROGRESS');
  if(!this.current.profileSaved||this.current.state==='expired'||this.current.lastError?.code==='TIEBA_LOGIN_CHALLENGE_OR_PAGE_CHANGED')throw new FishError('TIEBA_LOGIN_REQUIRED');
  await this.ensure();try{
   const who=await this.browser!.identity();if(!who){this.current.state=this.current.lastIdentity?'expired':'waiting_login';this.current.identity=null;this.current.verifiedAt=this.now();this.current.verificationRequired=false;this.save();return {status:'login_required',access:{mode:'login_required'},posts:[],text:'',images:[],links:[]};}
   this.current.state='logged_in';this.current.identity=who;this.current.lastIdentity=who;this.current.verifiedAt=this.now();this.current.verificationRequired=false;this.current.lastError=null;
   const result=await this.browser!.read(url);this.save();return {...result,access:{mode:'authenticated',account:who}};
  }finally{if(!this.interactiveOpen())await this.stop();}
 });}
 private policy():PostingPolicy{
  let p:any;try{p=JSON.parse(fs.readFileSync(path.join(this.dir,'publishing.json'),'utf8'));}catch{throw new FishError('TIEBA_PUBLISH_NOT_CONFIGURED');}
  if(!['preview','live'].includes(p.mode)||typeof p.accountId!=='string'||! /^[1-9]\d{0,19}$/.test(p.accountId))throw new FishError('TIEBA_PUBLISH_NOT_CONFIGURED');return {mode:p.mode,accountId:p.accountId};
 }
 private async usingAccount<T>(stage:string,work:(browser:AccountBrowser,who:TiebaIdentity)=>Promise<T>,requestId?:string){return this.operation(stage,async()=>{
  if(this.browser&&this.interactiveOpen()&&(stage==='publish'&&this.publicationWork?.requestId!==requestId||stage==='moderator_application'))await this.stop();
  if(this.browser&&!this.interactiveOpen())throw new FishError('TIEBA_LOGIN_IN_PROGRESS');
  if(this.current.state==='expired')throw new FishError('TIEBA_LOGIN_REQUIRED');await this.ensure();
  try{const who=await this.browser!.identity();if(!who){this.current.state='expired';this.current.identity=null;this.current.verifiedAt=this.now();this.save();throw new FishError('TIEBA_LOGIN_REQUIRED');}
   this.current.state='logged_in';this.current.identity=who;this.current.lastIdentity=who;this.current.verifiedAt=this.now();this.current.verificationRequired=false;
   const result=await work(this.browser!,who);this.current.lastError=null;this.save();return result;
  }finally{if(!this.interactiveOpen())await this.stop();}
 });}
 async account(){return this.usingAccount('account',async(browser,who)=>{
  if(!browser.followed)throw new FishError('TIEBA_FOLLOW_LIST_UNAVAILABLE');
  const following=await browser.followed(who.id);let mode='unconfigured';try{mode=this.policy().mode;}catch{}
  return {account:who,verifiedAt:this.current.verifiedAt,following,capabilities:{replyNotifications:true,privateMessages:{read:false,send:false,reason:'not_integrated'},smallModeratorApplication:{authorizedForums:this.moderatorForums(who.id)}},posting:{mode,scope:'followed_forums',otherForums:'read_only',threadTransport:'official_web',replyTransport:this.webEnabled(who)?'official_web':'app_protobuf',...this.publicationStatus()}};
 });}
 private moderatorAuthorized(){
  const id=this.current.identity?.id??this.current.lastIdentity?.id;
  if(!id || this.current.state==='expired' || this.current.state==='waiting_login')return false;
  try{
   const policy=this.policy();
   return policy.accountId===id && policy.mode==='live' && this.moderatorForums(id).length>0;
  }catch{return false;}
 }
 private moderatorForums(accountId:string):string[]{try{const p=JSON.parse(fs.readFileSync(path.join(this.dir,'moderator-permission.json'),'utf8'));return p.accountId===accountId&&Array.isArray(p.forumIds)?p.forumIds.filter((v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v)):[];}catch{return [];}}
 private saveModerator(){if(!this.moderatorWork)return;const file=path.join(this.dir,'moderator-work.json');fs.writeFileSync(file+'.tmp',JSON.stringify(this.moderatorWork),{mode:0o600});fs.renameSync(file+'.tmp',file);}
 async moderator(raw:unknown,requestId:string){
  const input=moderatorInput(raw);if(typeof requestId!=='string'||!requestId||requestId.length>240)throw new FishError('TIEBA_REQUEST_ID_INVALID');
  return this.usingAccount('moderator_application',async(browser,who)=>{
   if(!browser.followed||!browser.moderatorApplication)throw new FishError('TIEBA_MODERATOR_UNAVAILABLE');
   const forum=(await browser.followed(who.id)).find(f=>f.id===input.forumId);if(!forum)throw new FishError('TIEBA_FORUM_READ_ONLY');
   if(input.declaration!==undefined&&(this.policy().accountId!==who.id||this.policy().mode!=='live'||!this.moderatorForums(who.id).includes(forum.id)))throw new FishError('TIEBA_MODERATOR_NOT_AUTHORIZED');
   const journal=new ModeratorJournal(this.dir);let started=false;
   try{
    const prior=journal.get(requestId);if(prior){if(prior.account!==who.id||prior.forum!==input.forumId||prior.declaration!==input.declaration)throw new FishError('TIEBA_REQUEST_ID_REUSED');return {...prior.result,requestId,reused:true};}
    const work:ModeratorWork={requestId,accountId:who.id,forumId:forum.id,declaration:input.declaration??'',created:this.now(),updatedAt:this.now(),result:{stage:'preparing'}};
    const received=(result:any)=>{work.result={...result,requestId,account:who,forum};work.updatedAt=this.now();if(started){const saved=new ModeratorJournal(this.dir);try{saved.finish(requestId,work.result);}finally{saved.close();}}if(!this.moderatorWork||this.moderatorWork.created<=work.created){this.moderatorWork=work;this.saveModerator();}};
    let result:any;
    try{result=await browser.moderatorApplication(forum,who,input.declaration,()=>{journal.begin(work);started=true;received({submitted:null,requestSent:true,applicationStatus:'unknown',deliveryStatus:'unconfirmed',retryScheduled:false});},received);}
    catch(e){result={submitted:started?null:false,requestSent:started,applicationStatus:started?'unknown':'unavailable',deliveryStatus:started?'unconfirmed':'failed',error:codeOf(e),stage:started?'submit':'preparation',retryScheduled:false};}
    received(result);
    if(result.applicationStatus==='requires_human'){this.applicationOpen=true;this.current.loginPage=await browser.loginInfo?.();this.touch();}
    return work.result;
   }finally{journal.close();}
  },requestId);
 }
 async replies(page=1){
  if(!Number.isSafeInteger(page)||page<1||page>10000)throw new FishError('TIEBA_PAGE_INVALID');
  return this.usingAccount('replies',async(browser,who)=>{
   if(!browser.replies)throw new FishError('TIEBA_REPLIES_UNAVAILABLE');
   const result=await browser.replies(page),posting=new TiebaPosting(this.dir);
   try{
    const targets=new TiebaReplyTargets(url=>browser.read(url),(thread,id)=>posting.savedParent(who.id,thread,id));
    for(const reply of result.replies){
     if(!reply.isFloor)continue;
     const reference=reply.replyToPostId??reply.parentPostId;
     try{
      if(!reference)throw new FishError('TIEBA_REPLY_PARENT_UNRESOLVED');
      const target=await targets.resolve(reply.threadId,reference,reply.id);
      reply.floor=target.floor??null;reply.replyTo=target.replyTo??null;
      reply.parentPostId=target.parentPostId;reply.replyTarget=target.replyTarget;reply.targetStatus='verified';delete reply.targetError;
     }catch(e){this.checkActive();reply.parentPostId=null;reply.targetStatus='unresolved';reply.targetError=codeOf(e);delete reply.replyTarget;}
    }
    const replies=result.replies.map(reply=>({...reply,replyScope:replyScopeForTarget(reply.replyTarget)}));
    return {account:who,source:'reply_notifications',privateMessages:{read:false,send:false,reason:'not_integrated'},...result,replies};
   }finally{posting.close();}
  });
 }
 async mentions(page=1){
  if(!Number.isSafeInteger(page)||page<1||page>10000)throw new FishError('TIEBA_PAGE_INVALID');
  return this.usingAccount('mentions',async(browser,who)=>{
   if(!browser.mentions)throw new FishError('TIEBA_MENTIONS_UNAVAILABLE');
   const result=await browser.mentions(page);
   const mentions=result.mentions.map(mention=>({...mention,replyScope:replyScopeForTarget(mention.replyTarget)}));
   return {account:who,source:'mention_notifications',returned:mentions.length,...result,mentions};
  });
 }
 async verifyPublication(requestId:string,automaticLoadFailure=false){
  const verify=async(browser:AccountBrowser,who:TiebaIdentity)=>{
   const posting=new TiebaPosting(this.dir);try{
    const result=await posting.verify(requestId,who,{followed:async()=>[],read:url=>browser.read(url),publicRead:url=>tiebaPage(url,postPublic,this.operationSignal.getStore()),...(browser.deletion?{deletion:(id:string,tid:string)=>browser.deletion!(id,tid)}:{})},automaticLoadFailure);
    if(this.publicationWork?.requestId===requestId)await this.finishWeb(result);return result;
   }finally{posting.close();}
  };
  // HTTP readback does not navigate away from a pending human challenge.
  if(this.publicationOpen&&this.browser)return this.operation('verify_publication',async()=>{
   const who=await this.browser!.identity();if(!who||who.id!==this.publicationWork?.accountId)throw new FishError('TIEBA_ACCOUNT_CHANGED');return verify(this.browser!,who);
  });
  return this.usingAccount('verify_publication',verify);
 }
 private browserReads(browser:AccountBrowser){return {followed:(id:string)=>browser.followed!(id),read:(url:string)=>browser.read(url),publicRead:(url:string)=>tiebaPage(url,postPublic,this.operationSignal.getStore())};}
 private webEnabled(who:TiebaIdentity){try{const p=JSON.parse(fs.readFileSync(path.join(this.dir,'publishing-web.json'),'utf8'));return p.accountId===who.id&&p.enabled===true;}catch{return false;}}
 private webCallbacks(work:PublicationWork){
  const signal=this.operationSignal.getStore();
  let submissionEnded=false;
  const progress=(receipt:Record<string,unknown>={})=>{const p=new TiebaPosting(this.dir);try{p.webProgress(work.requestId,receipt);}finally{p.close();}};
  const before=()=>{signal?.throwIfAborted();const p=new TiebaPosting(this.dir);try{p.webAttempt(work.requestId);work.stage='started';this.saveWork();}finally{p.close();}};
  const receive=(outcome:WebOutcome)=>{
   const p=new TiebaPosting(this.dir);
   try{
    const previous=work.stage;
    work.result=p.webOutcome(work.requestId,outcome);
    work.stage=work.result.id?'accepted':work.result.error==='TIEBA_PUBLICATION_CHALLENGE'?'challenge':work.result.error==='TIEBA_PUBLICATION_REJECTED'?'rejected':'unknown';
    work.updatedAt=this.now();
    if(outcome.error==='TIEBA_PUBLICATION_CHALLENGE'&&work.result.error===outcome.error)this.publicationChallenge?.(work.sourceId??work.requestId);
    if(outcome.id)this.reportAcceptedPublication(work,previous);
    this.saveWork();
    // A response after the original call returned can arrive while the owner
    // completes the native slider. Queue the read so it shares the browser safely.
    if(submissionEnded&&!work.result.id&&isPublicationLoadFailure(work.result.receipt))this.publicationReadback?.(work.requestId);
   }finally{p.close();}
  };
  return {progress,async submit(browser:AccountBrowser){
   try{return await browser.submitWebPost!(before,receive,progress);}finally{submissionEnded=true;}
  }};
 }
 private async finishWeb(result:any){
  const keepOpen=this.publicationOpen&&!!this.browser,work=this.publicationWork!,previous=work.stage;work.result=result;if(result.deliveryStatus==='confirmed'){
   work.stage='confirmed';if(result.publicVerified&&work.sourceId)fs.writeFileSync(path.join(this.dir,'publishing-web.json'),JSON.stringify({accountId:work.accountId,enabled:true,verifiedAt:this.now(),requestId:work.requestId}),{mode:0o600});
  }else work.stage=result.error==='TIEBA_PUBLICATION_CHALLENGE'?'challenge':result.deliveryStatus==='accepted'?'accepted':result.deliveryStatus==='failed'?'rejected':'unknown';
  this.reportAcceptedPublication(work,previous);
  this.saveWork();
  // A human-opened page remains visible after every receipt, including a local
  // preparation error. Background calls still release their ordinary browser.
  // Keeping a page visible does not arm another submit or change its receipt.
  if(keepOpen||work.stage==='challenge'){this.publicationOpen=true;this.touch();}else await this.stop();
  this.save();
 }
 private reportAcceptedPublication(work:PublicationWork,previous:string){
  if(work.result?.reused||['accepted','confirmed'].includes(previous)||!['accepted','confirmed'].includes(work.stage))return;
  if(!work.result?.id&&work.result?.publicVerified!==true&&work.result?.submitted!==true)return;
  this.publicationAccepted?.(work.requestId,work.input,work.sourceId);
 }
 /** Human-only recovery: prepare the exact rejected intent on the official
  * page, without submitting it. */
 async startPublication(requestId?:string){return this.operation('publication_prepare',async()=>{
  const prior=this.publicationWork;
  const matches=!!prior&&(!requestId||requestId===prior.requestId||requestId===prior.sourceId);
  if(this.publicationOpen&&this.browser&&matches&&prior!.stage!=='prepare_failed')return this.status();
  if(this.browser&&!this.publicationOpen)throw new FishError('TIEBA_LOGIN_IN_PROGRESS');
  if(matches&&['started','accepted','unknown','confirmed'].includes(prior!.stage))throw new FishError('TIEBA_CHECK_PENDING_PUBLICATION_FIRST');
  await this.ensure();const who=await this.browser!.identity();if(!who)throw new FishError('TIEBA_LOGIN_REQUIRED');
  this.current.state='logged_in';this.current.identity=who;this.current.lastIdentity=who;this.current.verifiedAt=this.now();this.current.verificationRequired=false;this.current.lastError=null;
  const p=new TiebaPosting(this.dir);try{
   const resumeDraft=matches&&!!prior?.sourceId&&['preparing','prepared','prepare_failed'].includes(prior.stage);
   const source=p.recoverySource(who,resumeDraft?prior!.sourceId:requestId??prior?.requestId);
   const input=publishInput(source.request),policy=this.policy();if(policy.mode!=='live')throw new FishError('TIEBA_PUBLISH_DISABLED');
   if(this.publicationOpen){await this.stop();await this.ensure();const actual=await this.browser!.identity();if(actual?.id!==who.id)throw new FishError('TIEBA_ACCOUNT_CHANGED');}
   this.publicationWork={accountId:who.id,requestId:resumeDraft?prior!.requestId:'human-web:'+randomUUID(),sourceId:source.id,input,created:resumeDraft?prior!.created:this.now(),stage:'preparing'};
   this.publicationOpen=true;this.saveWork();this.touch();
   try{
    const target=await postingTarget(input,who,policy,this.browserReads(this.browser!));if(!this.browser!.prepareWebPost)throw new FishError('TIEBA_WEB_UNAVAILABLE');
    const imagePaths=tiebaImagePaths(this.dir,source.id,input.imageIds??[]);
    await this.browser!.prepareWebPost({...postingRequest(input,target,'official_web'),traceId:this.publicationWork.requestId,imagePaths});this.publicationWork.stage='prepared';
   }catch(e){
    this.publicationWork.stage='prepare_failed';this.publicationWork.updatedAt=this.now();
    this.publicationWork.result={submitted:false,published:false,error:codeOf(e),stage:'preparation',deliveryStatus:'failed',receipt:{...((e as any)?.receipt??{}),transport:'official_web',notSubmitted:true,httpAttempts:0},retryScheduled:false};
    this.current.lastError={code:codeOf(e),stage:'publication_prepare',at:this.now()};
   }
   this.current.loginPage=await this.browser!.loginInfo?.();this.saveWork();this.touch();this.save();return this.status();
  }finally{p.close();}
 });}
 /** Authenticated human button. Not registered as a model tool. */
 async submitPublication(){return this.operation('publication_submit',()=>this.submitPreparedPublication());}
 private async submitPreparedPublication(){
  const work=this.publicationWork,browser=this.browser;if(!work||!browser||!this.publicationOpen||work.stage!=='prepared'||!browser.submitWebPost)throw new FishError('TIEBA_PUBLICATION_NOT_PREPARED');
  const who=await browser.identity();if(who?.id!==work.accountId)throw new FishError('TIEBA_ACCOUNT_CHANGED');const p=new TiebaPosting(this.dir),callbacks=this.webCallbacks(work);
  try{
   if(work.sourceId)p.recoverySource(who,work.sourceId);
   work.stage='started';this.saveWork();
   const result=await p.publish(work.input,work.requestId,who,this.policy(),this.browserReads(browser),()=>{callbacks.progress();return callbacks.submit(browser);},work.sourceId);work.result=result;await this.finishWeb(result);return this.status();}finally{p.close();}
 }
 async checkPublication(){return this.operation('publication_check',async()=>{
  const work=this.publicationWork;if(!work)throw new FishError('TIEBA_PUBLICATION_NOT_FOUND');await this.ensure();const who=await this.browser!.identity();if(who?.id!==work.accountId)throw new FishError('TIEBA_ACCOUNT_CHANGED');
  const p=new TiebaPosting(this.dir);try{const result=await p.verify(work.requestId,who,this.browserReads(this.browser!));await this.finishWeb(result);return this.status();}finally{p.close();}
 });}
 async publish(raw:PublishInput,requestId:string,authorizedRetryOf?:string){let input=publishInput(raw);if(authorizedRetryOf!==undefined&&(typeof authorizedRetryOf!=='string'||!authorizedRetryOf||authorizedRetryOf.length>240))throw new FishError('TIEBA_REQUEST_ID_INVALID');return this.usingAccount('publish',async(browser,who)=>{
  if(!browser.followed||!browser.sendPost)throw new FishError('TIEBA_PUBLISH_UNAVAILABLE');
  const policy=this.policy();
  const useWeb=input.action==='thread'||!!input.imageIds?.length||this.webEnabled(who),reader={...this.browserReads(browser),...(!useWeb&&browser.deletion?{deletion:(id:string,tid:string)=>browser.deletion!(id,tid)}:{})},posting=new TiebaPosting(this.dir);
  try{
   if(policy.accountId!==who.id)throw new FishError('TIEBA_ACCOUNT_NOT_AUTHORIZED');
   const known=posting.knownIntent(input,requestId,who.id,authorizedRetryOf);
   if(known){this.publicationWork={accountId:who.id,requestId:known.id,input:known.input,created:known.created,stage:'started'};await this.finishWeb(known.result);return known.result;}
   if(this.publicationWork?.requestId!==requestId){this.publicationWork={accountId:who.id,requestId,input,created:this.now(),stage:'preparing'};this.saveWork();}
   let resolvedTarget:any;
   if(input.action==='comment'){
    let target;
    try{target=await new TiebaReplyTargets(reader.read,(thread,id)=>posting.savedParent(who.id,thread,id)).resolve(input.threadId!,input.postId!,input.subPostId??input.postId!);}
    catch(e){this.publicationWork!.stage='rejected';const info={...toolFailure(e,'target_resolution'),requestId,local:true,submitted:false,published:false,requestSent:false,submissionStatus:'not_submitted',deliveryStatus:'failed'};this.publicationWork!.result=info;this.saveWork();throw new ProviderError(info.error,info,e);}
    if(input.postId!==target.parentPostId||input.subPostId!==target.subPostId)resolvedTarget={...target,previousParentPostId:input.postId};
    const {page:_page,commentPage:_commentPage,subPostId:_subPostId,...original}=input;
    input={...original,postId:target.parentPostId,...(target.subPostId?{subPostId:target.subPostId}:{}),commentPage:target.commentPage};
   }
   this.publicationWork!.input=input;this.saveWork();
   let result=await posting.publish(input,requestId,who,policy,reader,async request=>{
    const current=await browser.identity();if(!current||current.id!==who.id)throw new FishError('TIEBA_ACCOUNT_CHANGED');
    // Re-check membership immediately before the write, after target reads.
    const target=await postingTarget(input,current,policy,reader);
    if(useWeb){
     if(!browser.prepareWebPost||!browser.submitWebPost)throw new FishError('TIEBA_WEB_UNAVAILABLE');
     // The editor takes plain text; the site's own sub-reply handler adds
     // the verified recipient prefix to the outgoing request.
     this.publicationWork={accountId:who.id,requestId,input,created:this.now(),stage:'preparing'};this.saveWork();const callbacks=this.webCallbacks(this.publicationWork);callbacks.progress();
     let imagePaths:string[];
     try{imagePaths=tiebaImagePaths(this.dir,requestId,input.imageIds??[]);}catch(e){throw new AppPostFailure(codeOf(e),{transport:'official_web',stage:'preparation',notSubmitted:true,httpAttempts:0});}
     await browser.prepareWebPost({...postingRequest(input,target,'official_web'),traceId:requestId,imagePaths});this.publicationWork.stage='started';this.saveWork();
     return callbacks.submit(browser);
    }
    return browser.sendPost!(request);
   },authorizedRetryOf);
   if(resolvedTarget)result={...result,resolvedTarget};
   if(!useWeb){
    this.publicationWork={accountId:who.id,requestId,input,created:this.now(),updatedAt:this.now(),stage:result.error==='TIEBA_PUBLICATION_CHALLENGE'?'challenge':result.publicVerified?'confirmed':result.deliveryStatus==='accepted'?'accepted':result.deliveryStatus==='failed'?'rejected':'unknown',result};
    this.saveWork();
    if(result.error==='TIEBA_PUBLICATION_CHALLENGE'&&!result.reused)this.publicationChallenge?.(requestId);
   }
   if(useWeb&&this.publicationWork?.requestId===requestId)await this.finishWeb(result);
   return result;
  }finally{posting.close();}
 },requestId);}
 postingHistory(offset=0){return tiebaHistoryPage(this.dir,offset);}
 async logout(){return this.operation('logout',async()=>{this.acquire();await this.stop();this.acquire();try{fs.rmSync(path.join(this.dir,'profile'),{recursive:true,force:true});this.current={state:'waiting_login',browserRunning:false,profileSaved:false,verifiedAt:null,identity:null,lastIdentity:null,lastError:null,waitingUntil:null,verificationRequired:true};this.save();return this.status();}finally{this.release();}});}
 async close(force=false){if(this.busy&&!force)throw new FishError('TIEBA_BUSY');await this.stop();if(this.current.state!=='unconfigured')this.save();}
}
