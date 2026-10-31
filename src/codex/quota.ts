import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeDir,safePath } from '../paths.js';
import { Store } from '../storage/db.js';
import { FishError,codeOf } from '../types.js';
import { RpcProcess } from './process.js';
import { appServerSpec } from './platform.js';
import { initialize } from './probe.js';
import { CodexRateLimitError } from './rate-limit.js';

export interface QuotaWindow {kind:'primary'|'secondary';usedPercent:number;remainingPercent:number;windowDurationMins:number|null;resetsAt:number|null}
export interface QuotaPool {id:string;name:string;windows:QuotaWindow[];reached:boolean;credits:{unlimited:boolean;hasCredits:boolean;balance:string|null}|null}
export interface QuotaSnapshot {pools:QuotaPool[];ordinaryUsageAllowed:boolean|null;updatedAt:number}
export interface QuotaReader {read(signal:AbortSignal,update:(value:unknown)=>void):Promise<unknown>;close():Promise<void>}
const label=(v:unknown,fallback:string)=>typeof v==='string'&&/^[a-zA-Z0-9 ._-]{1,100}$/.test(v)?v:fallback;
export function normalizeQuota(value:any,now=Date.now()):QuotaSnapshot{
  const map=value?.rateLimitsByLimitId;
  const entries:[string,any][]=map&&typeof map==='object'&&!Array.isArray(map)&&Object.keys(map).length?Object.entries(map):value?.rateLimits?[['codex',value.rateLimits]]:[];
  const pools:QuotaPool[]=entries.slice(0,20).map(([id,p]:[string,any])=>{
    const windows:QuotaWindow[]=[];
    for(const kind of ['primary','secondary'] as const){
      const w=p?.[kind];if(!w||typeof w.usedPercent!=='number'||!Number.isFinite(w.usedPercent)||w.usedPercent<0)continue;
      windows.push({kind,usedPercent:w.usedPercent,remainingPercent:Math.max(0,Math.min(100,100-w.usedPercent)),
        windowDurationMins:Number.isInteger(w.windowDurationMins)&&w.windowDurationMins>0?w.windowDurationMins:null,
        resetsAt:Number.isSafeInteger(w.resetsAt)&&w.resetsAt>0?w.resetsAt:null});
    }
    const c=p?.credits;
    return {id:label(p?.limitId,label(id,'unknown')),name:label(p?.limitName,label(id,'Codex')),windows,
      reached:!!p?.rateLimitReachedType||p?.spendControlReached===true,
      credits:c&&typeof c.unlimited==='boolean'&&typeof c.hasCredits==='boolean'?{unlimited:c.unlimited,hasCredits:c.hasCredits,balance:typeof c.balance==='string'&&c.balance.length<=40&&/^\d+(?:\.\d+)?$/.test(c.balance)?c.balance:null}:null};
  });
  return {pools,ordinaryUsageAllowed:typeof value?.ordinaryUsageAllowed==='boolean'?value.ordinaryUsageAllowed:null,updatedAt:now};
}
export function quotaPolicy(snapshot:QuotaSnapshot|null,now=Date.now()){
  const windows=snapshot?.pools.flatMap(p=>p.windows)??[];
  const stale=!snapshot||now-snapshot.updatedAt>330000;
  const remaining=windows.length?Math.min(...windows.map(w=>w.remainingPercent)):null;
  const reason=stale||!windows.length?'CODEX_QUOTA_UNKNOWN':snapshot?.ordinaryUsageAllowed===false||snapshot?.pools.some(p=>p.reached)||(remaining??0)<10?'CODEX_QUOTA_LOW':'';
  return {decision:'observe' as const,blocksImages:false,reason,remaining,stale};
}
/** Account-only connection: no thread/start, turn/start, command/exec or token reads. */
export class AppServerQuotaReader implements QuotaReader{
  private rpc?:RpcProcess;private controller?:AbortController;private cwd?:string;
  constructor(private root:string){}
  async read(signal:AbortSignal,update:(value:unknown)=>void):Promise<unknown>{
    signal.throwIfAborted();
    if(!fs.existsSync(safePath(this.root,'runtime/codex-home/auth.json')))throw new FishError('CODEX_PROJECT_LOGIN_REQUIRED');
    const aborted=()=>this.controller?.abort();signal.addEventListener('abort',aborted,{once:true});
    try{
      if(!this.rpc){
        this.cwd=makeDir(this.root,'runtime/workspace/quota-'+randomUUID());this.controller=new AbortController();
        const rpc=new RpcProcess(appServerSpec(this.root,this.cwd),this.controller.signal);this.rpc=rpc;
        // Rolling notifications are sparse: request a complete snapshot before trusting them.
        rpc.on('notice',(method:string)=>{if(method==='account/rateLimits/updated')update(null);});
        await initialize(rpc,this.cwd);
      }
      return await this.rpc.call('account/rateLimits/read',{excludeResetCreditDetails:true});
    }catch(e){await this.close();throw e;}finally{signal.removeEventListener('abort',aborted);}
  }
  async close(){
    const rpc=this.rpc;this.rpc=undefined;
    await rpc?.stop();this.controller=undefined;
    if(this.cwd){fs.rmSync(this.cwd,{recursive:true,force:true});fs.rmSync(safePath(this.root,'runtime/tmp/codex-'+path.basename(this.cwd)),{recursive:true,force:true});this.cwd=undefined;}
  }
}
export const mockQuota=()=>({ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent:25,windowDurationMins:300,resetsAt:Math.floor(Date.now()/1000)+3600},secondary:{usedPercent:60,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+3*86400}}});
export class CodexQuotaMonitor{
  private snapshot:QuotaSnapshot|null=null;private error='';private pending?:Promise<void>;private timer?:ReturnType<typeof setInterval>;private stopped=false;
  private controller=new AbortController();private retryAt=0;private recoveryRequired=false;private lastRead=0;
  constructor(private store:Store,private mock:boolean,private reader:QuotaReader){
    const held=JSON.parse(store.getMeta('codex-quota-backoff')??'{}');this.retryAt=Number(held.retryAt)||0;this.recoveryRequired=held.recoveryRequired===true;
    store.db.exec('CREATE TABLE IF NOT EXISTS image_quota_usage(id TEXT PRIMARY KEY,at INTEGER,changes TEXT)');
  }
  status(){const policy=quotaPolicy(this.snapshot);return {...this.snapshot,pools:this.snapshot?.pools??[],updatedAt:this.snapshot?.updatedAt??null,mock:this.mock,loading:!!this.pending,error:this.error,...policy,
    ...(this.retryAt>Date.now()||this.recoveryRequired?{reason:'CODEX_RATE_LIMITED'}:{}),retryAt:this.retryAt||null,
    recentUsage:(this.store.db.prepare('SELECT id,at,changes FROM image_quota_usage ORDER BY at DESC LIMIT 5').all() as {id:string;at:number;changes:string}[]).map(r=>({...r,changes:JSON.parse(r.changes)}))};}
  start(){if(this.timer||this.stopped)return;void this.refresh();this.timer=setInterval(()=>void this.refresh(),300000);this.timer.unref();}
  refresh(manual=false):Promise<void>{
    if(this.stopped)return Promise.resolve();if(this.pending)return this.pending;
    if(manual&&Date.now()-this.lastRead<5000)return Promise.resolve();this.lastRead=Date.now();
    this.pending=(async()=>{
      try{
        const timeout=AbortSignal.timeout(15000),signal=AbortSignal.any([this.controller.signal,timeout]);
        const value=this.mock?mockQuota():await this.reader.read(signal,()=>{if(!this.pending)void this.refresh(true);});
        signal.throwIfAborted();this.snapshot=normalizeQuota(value);this.error='';
        if(this.recoveryRequired&&this.retryAt<=Date.now()&&this.snapshot.ordinaryUsageAllowed===true&&!this.snapshot.pools.some(p=>p.reached)){
          this.recoveryRequired=false;this.retryAt=0;this.persistBackoff();
        }
      }catch(e){if(e instanceof CodexRateLimitError)this.limited(e);this.error=codeOf(e);this.snapshot=null;}
    })().finally(()=>{this.pending=undefined;});return this.pending;
  }
  async beforeImage(){await this.refresh();return this.snapshot;}
  limited(error:CodexRateLimitError){this.retryAt=error.retryAt??Date.now()+60000;this.recoveryRequired=true;this.persistBackoff();this.store.audit('error','web','CODEX_RATE_LIMITED');}
  private persistBackoff(){this.store.setMeta('codex-quota-backoff',JSON.stringify({retryAt:this.retryAt,recoveryRequired:this.recoveryRequired}));}
  async afterImage(id:string,before:QuotaSnapshot|null){
    await this.refresh();const after=this.snapshot,changes:{pool:string;window:string;percentagePoints:number}[]=[];
    if(after)for(const pool of before?.pools??[])for(const window of pool.windows){
      const next=after.pools.find(p=>p.id===pool.id)?.windows.find(w=>w.kind===window.kind&&w.windowDurationMins===window.windowDurationMins&&w.resetsAt!==null&&w.resetsAt===window.resetsAt);
      if(next&&next.usedPercent>=window.usedPercent)changes.push({pool:pool.id,window:window.windowDurationMins===10080?'weekly':window.kind,percentagePoints:Math.round((next.usedPercent-window.usedPercent)*100)/100});
    }
    this.store.db.prepare('INSERT OR REPLACE INTO image_quota_usage VALUES (?,?,?)').run(id,Date.now(),JSON.stringify(changes));
    this.store.db.exec('DELETE FROM image_quota_usage WHERE id NOT IN (SELECT id FROM image_quota_usage ORDER BY at DESC LIMIT 100)');
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.controller.abort();await this.pending;await this.reader.close();}
}
