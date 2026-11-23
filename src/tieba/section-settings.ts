import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {makeDir,safePath,writePrivateAtomic} from '../paths.js';
import {postPublic} from '../search/public-web.js';
import {readBigFishSections} from '../search/tieba.js';
import {DEFAULT_SECTION_GUIDANCE} from './sections.js';
import {FishError} from '../types.js';

const settingsPath='runtime/data/tieba-sections.json';
interface Settings {guidance:string;suggestions:Record<string,string>}

function validate(raw:any):Settings{
 const validText=(text:unknown,max:number):text is string=>typeof text==='string'&&text.length<=max;
 if(!validText(raw?.guidance,800)||!raw.suggestions||typeof raw.suggestions!=='object'||Array.isArray(raw.suggestions))throw new FishError('TIEBA_SECTION_SETTINGS_INVALID');
 const entries=Object.entries(raw.suggestions);
 if(entries.length>24||entries.some(([id,text])=>!(/^[1-9]\d{0,19}$/.test(id)&&validText(text,400)))||Buffer.byteLength(JSON.stringify(entries))>12000)throw new FishError('TIEBA_SECTION_SETTINGS_INVALID');
 return {guidance:raw.guidance.trim(),suggestions:Object.fromEntries(entries.map(([id,text])=>[id,(text as string).trim()]))};
}

function settings(root:string){
 const file=safePath(root,settingsPath);
 const value:Settings=fs.existsSync(file)?validate(JSON.parse(fs.readFileSync(file,'utf8'))):{guidance:DEFAULT_SECTION_GUIDANCE,suggestions:{}};
 return {...value,revision:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}

export async function tiebaSectionSettings(root:string,signal?:AbortSignal){
 const available=await readBigFishSections(postPublic,signal),saved=settings(root);
 return {...available,revision:saved.revision,guidance:saved.guidance,
  sections:available.sections.map(section=>({...section,suggestion:saved.suggestions[section.id]??section.suggestion}))};
}

export function saveTiebaSectionSettings(root:string,input:unknown){
 const value=validate(input),current=settings(root);
 if((input as {revision?:string}).revision!==current.revision)throw new FishError('TIEBA_SECTION_SETTINGS_CHANGED');
 makeDir(root,'runtime/data');
 const saved={guidance:value.guidance,suggestions:{...current.suggestions,...value.suggestions}};
 validate(saved);
 writePrivateAtomic(root,settingsPath,JSON.stringify(saved,null,2)+'\n');
 return {revision:settings(root).revision};
}
