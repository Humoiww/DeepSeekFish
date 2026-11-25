import {boundedJson} from '../provider/http.js';
import {FishError} from '../types.js';

const usageUrl='https://opencode.ai/inference/go/v1/usage';
const windows=['rolling','weekly','monthly'] as const;
type UsageWindow={percent:number;status:'ok'|'rate-limited';resetsAt:number};
type Usage=Record<typeof windows[number],UsageWindow>;
type Snapshot={usage?:Usage;checkedAt?:number;error?:string};

function parseUsage(data:any):Usage {
  const usage={} as Usage;
  for(const name of windows){
    const row=data?.usage?.[name];
    const resetsAt=typeof row?.resetsAt==='string'?Date.parse(row.resetsAt):NaN;
    if(!row||!Number.isInteger(row.percent)||row.percent<0||row.percent>100||!Number.isFinite(resetsAt)||
      (row.status!=='ok'&&row.status!=='rate-limited'))throw new FishError('OPENCODE_USAGE_INVALID_RESPONSE');
    usage[name]={percent:row.percent,status:row.status,resetsAt};
  }
  return usage;
}

export class OpenCodeQuota {
  private key='';
  private snapshot:Snapshot={};
  private nextCheck=0;
  private request?:AbortController;

  constructor(private mock:boolean,private http:typeof fetch=fetch){}

  status(key:string){
    if(key!==this.key){
      this.close();
      this.key=key;
      this.snapshot={};
      this.nextCheck=0;
    }
    return {...this.snapshot,mock:this.mock};
  }

  async refresh(key:string){
    this.status(key);
    if(this.mock||!key||this.request||Date.now()<this.nextCheck)return;
    const request=new AbortController(),timeout=AbortSignal.timeout(8000);
    this.request=request;
    this.nextCheck=Date.now()+60_000;
    try{
      const response=await this.http(usageUrl,{headers:{Authorization:'Bearer '+key,Accept:'application/json'},
        redirect:'error',signal:AbortSignal.any([request.signal,timeout])});
      if(!response.ok){
        await response.body?.cancel().catch(()=>{});
        throw new FishError('OPENCODE_USAGE_HTTP_'+response.status);
      }
      const usage=parseUsage(await boundedJson(response,16*1024));
      if(this.request===request)this.snapshot={usage,checkedAt:Date.now()};
    }catch(error){
      if(this.request===request)this.snapshot={...this.snapshot,error:timeout.aborted?'OPENCODE_USAGE_TIMEOUT':
        error instanceof FishError&&error.code.startsWith('OPENCODE_USAGE_')?error.code:
        error instanceof SyntaxError||error instanceof FishError?'OPENCODE_USAGE_INVALID_RESPONSE':'OPENCODE_USAGE_UNAVAILABLE'};
    }finally{
      if(this.request===request)this.request=undefined;
    }
  }

  close(){
    this.request?.abort();
    this.request=undefined;
  }
}
