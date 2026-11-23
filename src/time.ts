// The project clock is Hong Kong time. Stored Unix timestamps remain UTC.
export const PROJECT_TIMEZONE='Asia/Hong_Kong';
export const DAY_MS=86400000;
export const projectDay=(at=Date.now())=>new Date(at+8*3600000).toISOString().slice(0,10);
export const projectDayStart=(at=Date.now())=>Math.floor((at+8*3600000)/DAY_MS)*DAY_MS-8*3600000;

const hkFormatter=new Intl.DateTimeFormat('en-GB',{
 timeZone:PROJECT_TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit',
 hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset',
});

/** ISO timestamp in the project zone. An explicit offset also disambiguates archived records. */
export function projectTime(at:number):string{
 const parts=Object.fromEntries(hkFormatter.formatToParts(at).map(p=>[p.type,p.value]));
 const ms=new Date(at).getUTCMilliseconds();
 return parts.year+'-'+parts.month+'-'+parts.day+'T'+parts.hour+':'+parts.minute+':'+parts.second+
  (ms?'.'+String(ms).padStart(3,'0'):'')+parts.timeZoneName.replace('GMT','');
}
export const clockPrompt=(at=Date.now())=>'当前香港时间 '+projectTime(Math.floor(at/1000)*1000)+'。';

// Only format structured record metadata in the model copy. Conversation text,
// notebook contents, IDs, durations and date-only source labels stay verbatim.
const instantFields=new Set([
 'at','now','time','created','updated','observed','started','finished','since','until','lastSent','lease',
 'createdAt','updatedAt','observedAt','receivedAt','fetchedAt','retrievedAt','downloadedAt',
 'startedAt','finishedAt','verifiedAt','submittedAt','confirmedAt','lastPubliclyVisibleAt',
 'lastAttemptAt','retryAt','resetsAt','deadlineAt','timedOutAt','detectedAt','dueAt',
 'nextRunAt','nextPublishAt','scheduledFor','publishedAt','lastReplyAt','date',
]);
export function modelTimeJson(data:unknown):string{
 return JSON.stringify(data,function(key,value){
  if(!instantFields.has(key))return value;
  if(typeof value==='number'&&Number.isFinite(value)&&value>0){
   // Codex quota windows use Unix seconds; project record times use milliseconds.
   const ms=key==='resetsAt'&&Object.hasOwn(this,'windowDurationMins')?value*1000:value;
   if(ms<=8640000000000000)return projectTime(ms);
  }
  if(typeof value==='string')return sourceTime(value);
  return value;
 });
}

/** Sources with an explicit zone identify an instant. A date or unzoned quote does not. */
export function sourceTime(value:string):string{
 if(!/[ T]\d{2}:\d{2}/.test(value)||!/(?:Z$|[+-]\d{2}:?\d{2}\b|\b(?:GMT|UTC)\b)/i.test(value))return value;
 const at=Date.parse(value);return Number.isFinite(at)?projectTime(at):value;
}
