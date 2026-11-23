import {FishError} from '../types.js';

export const clarificationMethod='item/tool/requestUserInput';
export type Question={
 id:string;header:string;question:string;isSecret:boolean;isOther:boolean;
 options:{label:string;description:string}[];
};
export type Answers=Record<string,{answers:string[]}>;
export type Clarify=(questions:Question[],signal:AbortSignal)=>Promise<Answers>;

export function clarificationRequest(value:unknown){
 const p=value as {threadId?:unknown;turnId?:unknown;itemId?:unknown;questions?:unknown};
 if(typeof p?.threadId!=='string'||typeof p.turnId!=='string'||typeof p.itemId!=='string'||!p.itemId||
    !Array.isArray(p.questions)||!p.questions.length)throw new FishError('DEV_CODEX_QUESTION_INVALID');
 const ids=new Set<string>();
 const questions:Question[]=p.questions.map(q=>{
  if(typeof q?.id!=='string'||!q.id||ids.has(q.id)||typeof q.header!=='string'||typeof q.question!=='string'||
     q.options!=null&&(!Array.isArray(q.options)||q.options.some((option:any)=>typeof option?.label!=='string'||typeof option?.description!=='string')))throw new FishError('DEV_CODEX_QUESTION_INVALID');
  ids.add(q.id);
  return {id:q.id,header:q.header,question:q.question,isSecret:q.isSecret===true,isOther:q.isOther===true,options:q.options??[]};
 });
 return {threadId:p.threadId,turnId:p.turnId,itemId:p.itemId,questions};
}

/** Human-facing tools use small positional indexes. Send the exact native
 * question ID and option label back to App Server. */
export function codexAnswers(questions:Question[],choices:unknown):Answers{
 if(!Array.isArray(choices))throw new FishError('DEV_CODEX_ANSWER_INVALID');
 const items=new Map<string,{answers:string[]}>(),seen=new Set<string>();
 for(const choice of choices){
  if(!choice||!Number.isSafeInteger(choice.number)||Object.keys(choice).some(key=>!['number','option','text'].includes(key)))throw new FishError('DEV_CODEX_ANSWER_INVALID');
  const q=questions[choice.number-1];
  if(!q||q.isSecret||seen.has(q.id))throw new FishError('DEV_CODEX_ANSWER_INVALID');
  seen.add(q.id);
  if(choice.option===undefined&&choice.text===undefined)continue;
  let response:string|undefined;
  if(Number.isSafeInteger(choice.option)&&choice.text===undefined)response=q.options[choice.option-1]?.label;
  else if(choice.option===undefined&&typeof choice.text==='string'&&(q.isOther||!q.options.length))response=choice.text.trim();
  if(!response)throw new FishError('DEV_CODEX_ANSWER_INVALID');
  items.set(q.id,{answers:[response]});
 }
 return Object.fromEntries(items);
}
