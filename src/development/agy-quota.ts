import {FishError} from '../types.js';
import type {AgyQuota,AgyQuotaWindow} from './agy-bridge-types.js';

export function parseAgyQuota(output:string,checkedAt=Date.now()):AgyQuota{
 const windows=new Map<string,AgyQuotaWindow>();
 const clean=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
 for(const line of clean.split(/\r?\n/)){
  const match=/^\s*Gemini Models\s+(Weekly|Five Hour) Limit Remaining\s+(\d+(?:\.\d+)?)%\s*(.*?)\s*$/.exec(line);
  if(!match)continue;
  const [,kind,percent,resetText]=match;
  const remainingPercent=Number(percent);
  if(remainingPercent>100||windows.has(kind))throw new FishError('DEV_AGY_QUOTA_FORMAT_CHANGED');
  const window:AgyQuotaWindow={remainingPercent};
  if(resetText){
   const display=/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC$/.exec(resetText);
   const utc=/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(resetText);
   if(display||utc){
    const iso=display?display[1]+'T'+display[2]+':00.000Z':utc![1]+'.'+(utc![2]??'').padEnd(3,'0')+'Z';
    const resetAt=Date.parse(iso);
    if(!Number.isFinite(resetAt)||new Date(resetAt).toISOString()!==iso)throw new FishError('DEV_AGY_QUOTA_FORMAT_CHANGED');
    window.resetAt=resetAt;
    window.resetText=resetText;
   }else if(!/^(?:-|—|N\/A|unknown)$/i.test(resetText))throw new FishError('DEV_AGY_QUOTA_FORMAT_CHANGED');
  }
  windows.set(kind,window);
 }
 const weekly=windows.get('Weekly'),fiveHour=windows.get('Five Hour');
 if(!weekly||!fiveHour)throw new FishError('DEV_AGY_QUOTA_FORMAT_CHANGED');
 return {source:'agy',checkedAt,weekly,fiveHour};
}
