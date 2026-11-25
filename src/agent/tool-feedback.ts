import {randomUUID} from 'node:crypto';
import {diagnosticSafe, ProviderError} from '../diagnostics.js';
import {codeOf,FishError} from '../types.js';
import type {Store} from '../storage/db.js';

// Only explicitly public fields cross into a model request. ProviderError can
// also carry raw response bodies and private diagnostics; never copy it whole.
const publicFields=['stage','operation','field','requestId','resultId','section','availableSections','entryId','currentVersion','submittedVersion','elapsedMs','limitMs','timeoutMs','nativeImageCompletions','httpStatus','providerCode','providerMessage','httpAttempts','responseReceived','cleanupState','action','reason','retcode','nativeCode','submissionStatus','requestSent','deliveryStatus','postId','protocolIssues'] as const;
export function toolFailure(e:unknown,stage:string){
  const err=e as {diagnostic?:Record<string,unknown>;code?:string;cause?:{code?:string}};
  const details=err?.diagnostic??{};
  const out:Record<string,any>={error:codeOf(e),stage};
  for(const key of publicFields){
    const value=details[key];
    if(value===null||typeof value==='boolean'||typeof value==='number')out[key]=value;
    else if(typeof value==='string')out[key]=diagnosticSafe(value.slice(0,360));
    else if((key==='availableSections'||key==='protocolIssues')&&Array.isArray(value))out[key]=value.filter(v=>typeof v==='string').slice(0,16).map(v=>diagnosticSafe(v.slice(0,120)));
  }
  if(Array.isArray(details.issues))out.protocolIssues=details.issues.filter(v=>typeof v==='string').slice(0,8).map(v=>diagnosticSafe(v.slice(0,120)));
  const name=e instanceof Error?e.name:undefined;
  if(name==='TimeoutError'||name==='AbortError')out.reason=name==='TimeoutError'?'timeout':'aborted';
  if(e instanceof TypeError&&e.message==='fetch failed')out.reason='network_request_failed';
  const native=err?.cause?.code??err?.code;
  if(typeof native==='string'&&/^(?:E[A-Z0-9]+|UND_ERR_[A-Z_]+)$/.test(native))out.nativeCode=native;
  return out as Record<string,any>&{error:string;stage:string};
}

export function toolArgs(raw:string){
  try{return JSON.parse(raw);}
  catch{throw new ProviderError('INVALID_TOOL_JSON',{stage:'parse_tool_arguments'});}
}

export function actionState(value:any):string{
  if(value?.deliveryStatus==='queued'||value?.queued===true)return 'queued';
  if(value?.deliveryStatus==='running'&&value?.submissionStatus==='running')return 'running';
  if(value?.deliveryStatus==='cancelled'||value?.deliveryStatus==='skipped')return value.deliveryStatus;
  if(value?.visibility==='removed_by_system'||value?.deliveryStatus==='deleted')return 'deleted';
  if(value?.deliveryStatus==='accepted')return 'accepted';
  if(['unavailable','login_required','blocked','error'].includes(value?.status))return 'failed';
  if(value?.deliveryStatus==='unconfirmed'||value?.state==='unknown')return 'unconfirmed';
  if(value?.error||value?.deliveryStatus==='failed'||value?.ok===false||value?.success===false||value?.state==='failed'||value?.memory?.ok===false)return 'failed';
  if(Array.isArray(value?.images)&&value.images.length){
    const states=new Set(value.images.map(actionState));
    if(states.size===1)return String([...states][0]);
    if([...states].some(s=>s!=='completed'))return 'partial';
  }
  return 'completed';
}

export type DispatchPhase='before'|'dispatch'|'submitted';
export function sendFailure(e:unknown,stage:string,phase:DispatchPhase){
  const info=toolFailure(e,stage);
  if(info.submissionStatus&&info.deliveryStatus)return info;
  const rejected=info.error==='ONEBOT_ACTION_FAILED'||/^QZONE_PUBLISH_REJECTED_/.test(info.error);
  const before=info.requestSent===false||phase==='before'||['ONEBOT_NOT_CONNECTED','ONEBOT_BUSY','ONEBOT_CONNECT_FAILED','QQ_FILE_TOO_LARGE','ONEBOT_INVALID_TARGET','ONEBOT_GROUP_NOT_ALLOWED','QQ_GROUP_NOT_ALLOWED','QQ_DELIVERY_PAUSED','QQ_MEDIA_TOO_LARGE','QQ_MEDIA_NOT_AVAILABLE'].includes(info.error);
  const submitted=info.requestSent===true||phase==='submitted'||['ONEBOT_SEND_UNCONFIRMED','ONEBOT_ACTION_TIMEOUT','ONEBOT_DISCONNECTED'].includes(info.error);
  const submissionStatus=before?'not_submitted':rejected?'rejected':submitted?'submitted_unconfirmed':'unknown';
  return {...info,submissionStatus,requestSent:before?false:rejected||submitted?true:null,deliveryStatus:before||rejected?'failed':'unconfirmed',retryScheduled:false};
}

/** Carry an unread receipt into the next ordinary request in the same scope.
 * The full trace stays private. Reading the record never triggers an action.
 */
export class UnreadFeedback {
  private key:string;
  private delivered=new Set<string>();
  constructor(private store:Store,scope:string){this.key='unread-tool:'+scope;}
  private rows():{id:string;at:number;tool:string;receipt:Record<string,unknown>}[]{
    const rows=JSON.parse(this.store.getMeta(this.key)??'[]');
    const cutoff=Date.now()-15*60000;
    return rows.filter((row:{at:number})=>row.at>=cutoff).slice(-4);
  }
  previous(){
    const rows=this.store.transaction(()=>{
      const saved=this.store.getMeta(this.key);
      const current=this.rows();
      if(saved&&saved!==JSON.stringify(current))this.save(current);
      return current;
    });
    for(const row of rows)this.delivered.add(row.id);
    return rows.length?{previousToolErrors:rows.map(({at,tool,receipt})=>({at,tool,receipt}))}:{};
  }
  record(tool:string,value:any){
    if(!value||typeof value!=='object')return;
    const failure=value.memory?.ok===false?value.memory:value;
    const items=Array.isArray(value.images)?value.images.filter((x:any)=>x?.error||x?.deliveryStatus==='unconfirmed'):[];
    if(['completed','accepted','queued','running','cancelled','skipped'].includes(actionState(value)))return;
    const summary=(v:any)=>{
      const fields=['error',...publicFields,'step','accepted','notSubmitted','pageNotice','errorMessage','errorCode','visibility','state','submitted','published','url','attemptedTokens','limit','version','imageId','fileId','id','position','message','status','notice'];
      const compact:Record<string,any>={};
      for(const k of fields){
        const val=v[k];if(typeof val==='string')compact[k]=diagnosticSafe(val.slice(0,k==='url'?2048:360));
        else if(typeof val==='number'||typeof val==='boolean'||val===null)compact[k]=val;
        else if(['availableSections','protocolIssues'].includes(k)&&Array.isArray(val))compact[k]=val.filter(x=>typeof x==='string').slice(0,12).map(x=>diagnosticSafe(x.slice(0,120)));
      }
      if(Array.isArray(v.availableSources))compact.availableSources=v.availableSources.filter((x:any)=>typeof x==='string').slice(0,8).map((x:string)=>diagnosticSafe(x.slice(0,2048)));
      if(Array.isArray(v.invalidSources))compact.invalidSources=v.invalidSources.slice(0,4).map((x:any)=>({index:x?.index,reason:diagnosticSafe(String(x?.reason??'').slice(0,160)),value:diagnosticSafe(String(x?.value??'').slice(0,2048))}));
      if(v.issue)compact.issue={field:diagnosticSafe(String(v.issue.field??'').slice(0,80)),reason:diagnosticSafe(String(v.issue.reason??'').slice(0,250))};
      return compact;
    };
    const receipt=summary(failure);if(failure.receipt)receipt.receipt=summary(failure.receipt);
    if(items.length)receipt.items=items.slice(0,12).map(summary);
    const row={id:randomUUID(),at:Date.now(),tool,receipt};
    this.store.transaction(()=>this.save([...this.rows(),row].slice(-4)));
    this.delivered.add(row.id);
  }
  private save(rows:ReturnType<UnreadFeedback['rows']>){
    if(rows.length)this.store.setMeta(this.key,JSON.stringify(rows));
    else this.store.db.prepare('DELETE FROM meta WHERE key=?').run(this.key);
  }
  acknowledged(){
    if(!this.delivered.size)return;
    this.store.transaction(()=>{
      const keep=this.rows().filter(r=>!this.delivered.has(r.id));
      this.save(keep);
    });
    this.delivered.clear();
  }
}
