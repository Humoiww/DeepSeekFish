import fs from 'node:fs';
import {safePath,writePrivateAtomic} from '../paths.js';
import type {AgyClient} from './agy-client.js';
import {bridgeViewDir,processAgyQuotaRefresh,readDevelopmentJson,syncAgyQuota,type BridgeView} from './bridge-view.js';
import {isBridgeRecordKind,maxRecordBytes,taskIdPattern,type BridgeRecordSummary} from './agy-bridge-types.js';

export class BridgeSync{
 status:BridgeView|undefined;
 private syncing=false;
 private syncingQuota=false;
 private nextQuotaPoll=0;

 constructor(private root:string,private client:AgyClient){
  fs.mkdirSync(safePath(root,bridgeViewDir),{recursive:true,mode:0o700});
 }

 async refreshStatus(){
  const {busy,activeTaskId,stage,startedAt,recentEvents,mainConversation}=await this.client.status();
  const view:BridgeView={ok:true,busy,activeTaskId,stage,startedAt,recentEvents,mainConversation,updatedAt:Date.now()};
  writePrivateAtomic(this.root,bridgeViewDir+'/status.json',JSON.stringify(view));
  this.status=view;
 }

 async refreshQuota(signal:AbortSignal){
  if(this.syncingQuota||signal.aborted)return;
  this.syncingQuota=true;
  try{
   if(!await processAgyQuotaRefresh(this.root,()=>this.client.refreshQuota(signal))){
    if(Date.now()<this.nextQuotaPoll)return;
    await syncAgyQuota(this.root,()=>this.client.quota(signal));
   }
   this.nextQuotaPoll=Date.now()+15_000;
  }finally{this.syncingQuota=false;}
 }

 async refreshRecords(signal:AbortSignal){
  if(this.syncing)return;
  this.syncing=true;
  try{
   const indexPath=bridgeViewDir+'/index.json';
   const previous=readDevelopmentJson<BridgeRecordSummary[]>(this.root,indexPath)??[];
   const key=(entry:BridgeRecordSummary)=>entry.kind+'-'+entry.id;
   const known=new Map(previous.map(entry=>[key(entry),entry]));
   const summaries=(await this.client.records(AbortSignal.any([signal,AbortSignal.timeout(5000)]))).records;
   const next:BridgeRecordSummary[]=[];
   for(const entry of summaries){
    signal.throwIfAborted();
    if(!isBridgeRecordKind(entry.kind)||!taskIdPattern.test(entry.id)||next.filter(record=>record.kind===entry.kind).length>=20)continue;
    const file=bridgeViewDir+'/'+key(entry)+'.json',old=known.get(key(entry));
    if(old?.updatedAt===entry.updatedAt&&old.bytes===entry.bytes&&fs.existsSync(safePath(this.root,file))){
     next.push(old);
     continue;
    }
    try{
     const detail=await this.client.record(entry.kind,entry.id,AbortSignal.any([signal,AbortSignal.timeout(5000)]));
     const json=JSON.stringify(detail);
     if(detail.record.kind!==entry.kind||detail.record.id!==entry.id||Buffer.byteLength(json)>maxRecordBytes)continue;
     writePrivateAtomic(this.root,file,json);
     next.push(detail.record);
    }catch{
     signal.throwIfAborted();
     if(old&&fs.existsSync(safePath(this.root,file)))next.push(old);
    }
   }
   const json=JSON.stringify(next);
   if(json!==JSON.stringify(previous)||!fs.existsSync(safePath(this.root,indexPath)))writePrivateAtomic(this.root,indexPath,json);
   const keep=new Set(next.map(entry=>key(entry)+'.json'));
   const directory=safePath(this.root,bridgeViewDir);
   for(const file of fs.readdirSync(directory)){
    if(!keep.has(file)&&/^(agy|codex|patch)-[a-f0-9-]{36}\.json$/.test(file))fs.rmSync(safePath(directory,file),{force:true});
   }
  }finally{this.syncing=false;}
 }
}
