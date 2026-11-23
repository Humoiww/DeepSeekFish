import fs from 'node:fs';
import { createHash,randomInt,randomUUID } from 'node:crypto';
import { FishError } from './types.js';
import { projectRoot } from './config.js';
import { safePath,makeDir,writePrivate } from './paths.js';

export const CHARACTER_REFERENCE='runtime/character/whalechan-reference.png';
export const BUNDLED_CHARACTER_REFERENCE='assets/character/whalechan-reference.png';
export const CHARACTER_IMAGE_GUIDANCE='用户请求“你自己”“她自己”“自拍”“自画像”或鲸酱立绘时，指的是这套鲸酱形象，不是普通蓝色小鱼或鲸鱼动物。获准生图时必须附上原设定图作为身份参考，保留发色、鲸鳍耳、呆毛、眼睛、服饰与鲸尾；姿势、表情和背景可依请求变化，默认保持附图Q版比例。当前渠道无生图工具或未获授权时，只能说明限制并整理描述，不能声称已经生成，也不能自行调用付费服务。';
export interface PersonaBlock {title:string;text:string;kind?:'kaomoji'}
export interface PersonaConfig {blocks:PersonaBlock[];appearance:string}
const override='runtime/data/persona.json';
const kaomojiBlock={kind:'kaomoji',title:'颜文字范例',text:''} as const;
let kaomojiCategories: {label:string;entries:string[]}[]|undefined;

function withKaomojiBlock(blocks:PersonaBlock[]):PersonaBlock[]{
  if(blocks.some(block=>block.kind==='kaomoji'))return blocks;
  const after=blocks.findIndex(block=>block.title==='相处方式');
  return blocks.toSpliced(after<0?blocks.length:after+1,0,{...kaomojiBlock});
}

function kaomojiPrompt():string{
  kaomojiCategories??=Object.values(JSON.parse(fs.readFileSync(safePath(projectRoot(),'assets/kaomoji/emotions.json'),'utf8')));
  const examples=kaomojiCategories.map(({label,entries})=>{
    const first=randomInt(entries.length);
    const other=randomInt(entries.length-1);
    const second=other>=first?other+1:other;
    return `${label}：${entries[first]}　｜　${entries[second]}`;
  });
  return ['颜文字范例（需要时参考）：',...examples].join('\n');
}

function bundled(root:string){
  const base=fs.existsSync(safePath(root,'personas/active.json'))?root:projectRoot();
  const active=JSON.parse(fs.readFileSync(safePath(base,'personas/active.json'),'utf8'));
  if(typeof active.id!=='string'||!/^[a-z0-9-]{1,40}$/.test(active.id))throw new FishError('PERSONA_INVALID');
  const dir='personas/'+active.id+'/';
  const text=fs.readFileSync(safePath(base,dir+'prompt.md'),'utf8').trim();
  const sentences=text.match(/[^。]+。?/g)??[text];
  const blocks=sentences.length===3?sentences.map((text,i)=>({title:['身份','性格','相处方式'][i],text})):[{title:'人格',text}];
  return {blocks:withKaomojiBlock(blocks),appearance:fs.readFileSync(safePath(base,dir+'appearance.txt'),'utf8').trim()};
}
function validate(value:any):PersonaConfig{
  if(!value||!Array.isArray(value.blocks)||value.blocks.length<1||value.blocks.length>21||
    value.blocks.some((b:any)=>!b||(b.kind!==undefined&&b.kind!=='kaomoji')||typeof b.title!=='string'||!b.title.trim()||b.title.length>60||typeof b.text!=='string'||b.text.length>8000)||
    typeof value.appearance!=='string'||value.appearance.length>4000)
    throw new FishError('PERSONA_INVALID');
  const blocks:PersonaBlock[]=value.blocks.map((b:PersonaBlock)=>b.kind==='kaomoji'?{...kaomojiBlock}:{title:b.title.trim(),text:b.text});
  const editable=blocks.filter(block=>!block.kind);
  if(editable.length>20||blocks.length-editable.length>1||Buffer.byteLength(JSON.stringify({blocks:editable,appearance:value.appearance}))>24576)
    throw new FishError('PERSONA_INVALID');
  if(!editable.some(block=>block.text.trim()))throw new FishError('PERSONA_EMPTY');
  return {blocks:withKaomojiBlock(blocks),appearance:value.appearance};
}
export function personaSettings(root=projectRoot()){
  const file=safePath(root,override),custom=fs.existsSync(file);
  const config=custom?validate(JSON.parse(fs.readFileSync(file,'utf8'))):bundled(root);
  return {...config,custom,revision:createHash('sha256').update(JSON.stringify(config)).digest('hex')};
}
export function savePersona(root:string,input:unknown){
  const value=input as any,config=validate(value),current=personaSettings(root);
  if(value.revision!==current.revision)throw new FishError('PERSONA_CHANGED_RELOAD');
  makeDir(root,'runtime/data');const tmp=override+'.'+randomUUID()+'.tmp';
  try{writePrivate(root,tmp,JSON.stringify(config,null,2)+'\n');fs.renameSync(safePath(root,tmp),safePath(root,override));}
  finally{fs.rmSync(safePath(root,tmp),{force:true});}
  return personaSettings(root);
}
export const personalityPrompt=(root=projectRoot()):string=>personaSettings(root).blocks
  .map(block=>block.kind==='kaomoji'?kaomojiPrompt():block.text.trim()).filter(Boolean).join('\n');
export const appearancePrompt=(root=projectRoot()):string=>personaSettings(root).appearance.trim();
// Compatibility export for callers that only need the bundled default.
export const CHARACTER_APPEARANCE=bundled(projectRoot()).appearance;
export const characterPrompt=(root=projectRoot(),personality=personalityPrompt(root)):string=>[personality,appearancePrompt(root),CHARACTER_IMAGE_GUIDANCE].join('\n');
