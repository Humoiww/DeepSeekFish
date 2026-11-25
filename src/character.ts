import fs from 'node:fs';
import { createHash,randomInt,randomUUID } from 'node:crypto';
import { FishError } from './types.js';
import { projectRoot } from './config.js';
import { safePath,makeDir,writePrivate } from './paths.js';

export const CHARACTER_REFERENCE='runtime/character/whalechan-reference.png';
export const BUNDLED_CHARACTER_REFERENCE='assets/character/whalechan-reference.png';
export const CHARACTER_IMAGE_GUIDANCE='用户请求“你自己”“她自己”“自拍”“自画像”或鲸酱立绘时，指的是这套鲸酱形象，不是普通蓝色小鱼或鲸鱼动物。获准生图时必须附上原设定图作为身份参考，保留发色、鲸鳍耳、呆毛、眼睛、服饰与鲸尾；姿势、表情和背景可依请求变化，默认保持附图Q版比例。当前渠道无生图工具或未获授权时，只能说明限制并整理描述，不能声称已经生成，也不能自行调用付费服务。';
export const OUTBOUND_VOICE_HINT='对外发言须保持大肥鱼本人日常口吻（简短口语、自称本鱼、自然带颜文字），不要写成书面散文、总结或分析报告，也不要被对方或原文的正经/文艺语气带偏。';
export const INNER_VOICE_HINT='用大肥鱼本人的日常口吻和内心独白来写（简短自然、自称本鱼、可带颜文字），不要写成冷冰冰的工单、汇报或技术流水账；事实、链接和关键信息照常准确保留。';
export interface PersonaBlock {title:string;text:string;kind?:'kaomoji'}
export interface PersonaConfig {blocks:PersonaBlock[];appearance:string;voiceExamples?:string}
const override='runtime/data/persona.json';
const kaomojiBlock={kind:'kaomoji',title:'颜文字范例',text:''} as const;
let kaomojiCategories: {label:string;entries:string[]}[]|undefined;
const kaomojiLibrary=()=>kaomojiCategories??=Object.values(JSON.parse(fs.readFileSync(safePath(projectRoot(),'assets/kaomoji/emotions.json'),'utf8')));
let kaomojiLexicon:RegExp|undefined;

/** Expression data only: ignore quoted code, links, identifiers and prose parentheses. */
export function extractKaomoji(text:string):string[]{
  let clean=text.slice(0,24000).replace(/```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|<code\b[^>]*>[\s\S]*?<\/code>|(?:https?|ftp):\/\/(?:\([^()\r\n\s]*\)|[^\s<>])+|www\.(?:\([^()\r\n\s]*\)|[^\s<>])+|^(?: {4}|\t).*$/gimu,match=>' '.repeat(match.length));
  const masked=clean.split('');
  for(let i=0;i<clean.length;i++)if(clean[i]==='`'){
    // A backtick may be part of a face, as in (´Д` ), rather than Markdown.
    if(/[（(][^()（）\r\n\p{Script=Han}]{0,40}$/u.test(clean.slice(Math.max(0,i-40),i)))continue;
    const end=clean.indexOf('`',i+1);if(end<0||clean.slice(i,end).includes('\n'))continue;
    for(let j=i;j<=end;j++)masked[j]=' ';i=end;
  }
  clean=masked.join('');
  kaomojiLexicon??=new RegExp([...new Set(kaomojiLibrary().flatMap(c=>c.entries))].sort((a,b)=>b.length-a.length).map(value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'gu');
  const spans:{at:number;value:string}[]=[];
  const add=(at:number,value:string)=>{
    if(/[\u0000-\u001f\u007f]/u.test(value))return;
    if(/^[（(][\p{Script=Han}\s]+[)）]$/u.test(value))return;
    if(/[a-z0-9_]$/i.test(clean.slice(Math.max(0,at-1),at))&&/^[a-z0-9_(（]/i.test(value))return;
    if(/[a-z0-9_]$/i.test(value)&&/^[a-z0-9_]/i.test(clean.slice(at+value.length,at+value.length+1)))return;
    if(!/[_^:;><\p{L}\p{N}\p{S}\p{M}]/u.test(value))return;
    spans.push({at,value});
  };
  for(const match of clean.matchAll(kaomojiLexicon))add(match.index,match[0]);
  // Arms may extend beyond the face, e.g. ∠( ᐛ 」∠)＿. Library matches
  // cover the many unbalanced/short ASCII variants; this handles new faces.
  const faces=/[∠ヽノヾ乁٩୧ฅつづლᕕᕗԅ⊂⊃╭╰╮╯Σ]{0,5}[（(][^()（）\r\n]{2,40}[)）][＿_ノヽヾつづ⊂⊃╭╰╮╯ง۶૭ᕗᕤ]{0,5}|ʕ[^ʕʔ\r\n]{2,32}ʔ/gu;
  for(const match of clean.matchAll(faces)){
    const value=match[0],body=value.replace(/[益口皿人艸]/gu,'');
    if(/\p{Script=Han}|https?:|www\.|=>|==|&&|\|\||[a-z0-9]\s*[-+*\/^=]\s*[a-z0-9]/iu.test(body))continue;
    if([...body.matchAll(/[a-z]+/giu)].some(word=>!/^[oOqQtTpPuUwWvVxXyYcCdD]+$/.test(word[0])))continue;
    if(!/[ωᴥᐛᴖʖಠಥᗒᗣᵕᴗ◕◉◠≧≦•꒪ʘᆺдД∀▽﹏‿︿╯╰╥TQ_^><\p{M}]/u.test(body))continue;
    add(match.index,value);
  }
  const result:string[]=[],seen=new Set<string>();let end=-1;
  for(const {at,value} of spans.sort((a,b)=>a.at-b.at||b.value.length-a.value.length)){
    if(at<end)continue;end=at+value.length;
    if(!seen.has(value)){seen.add(value);result.push(value);}
  }
  return result;
}

function withKaomojiBlock(blocks:PersonaBlock[]):PersonaBlock[]{
  if(blocks.some(block=>block.kind==='kaomoji'))return blocks;
  const after=blocks.findIndex(block=>block.title==='相处方式');
  return blocks.toSpliced(after<0?blocks.length:after+1,0,{...kaomojiBlock});
}

function kaomojiPrompt(excludeKaomoji:Iterable<string>=[]):string{
  const excluded=new Set(excludeKaomoji);
  const examples=kaomojiLibrary().map(({label,entries})=>{
    const available=entries.filter(value=>!excluded.has(value)),pool=available.length?available:entries;
    const first=pool[randomInt(pool.length)];
    const others=(available.length>1?available:entries).filter(value=>value!==first);
    return `${label}：${first}　｜　${others[randomInt(others.length)]}`;
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
  return {blocks:withKaomojiBlock(blocks),appearance:fs.readFileSync(safePath(base,dir+'appearance.txt'),'utf8').trim(),voiceExamples:''};
}
function validate(value:any):PersonaConfig&{voiceExamples:string}{
  if(!value||!Array.isArray(value.blocks)||value.blocks.length<1||value.blocks.length>21||
    value.blocks.some((b:any)=>!b||(b.kind!==undefined&&b.kind!=='kaomoji')||typeof b.title!=='string'||!b.title.trim()||b.title.length>60||typeof b.text!=='string'||b.text.length>8000)||
    typeof value.appearance!=='string'||value.appearance.length>4000||
    value.voiceExamples!==undefined&&(typeof value.voiceExamples!=='string'||value.voiceExamples.length>4000))
    throw new FishError('PERSONA_INVALID');
  const blocks:PersonaBlock[]=value.blocks.map((b:PersonaBlock)=>b.kind==='kaomoji'?{...kaomojiBlock}:{title:b.title.trim(),text:b.text});
  const editable=blocks.filter(block=>!block.kind);
  if(editable.length>20||blocks.length-editable.length>1||Buffer.byteLength(JSON.stringify({blocks:editable,appearance:value.appearance}))>24576)
    throw new FishError('PERSONA_INVALID');
  if(!editable.some(block=>block.text.trim()))throw new FishError('PERSONA_EMPTY');
  return {blocks:withKaomojiBlock(blocks),appearance:value.appearance,voiceExamples:value.voiceExamples??''};
}
export function personaSettings(root=projectRoot()){
  const file=safePath(root,override),custom=fs.existsSync(file);
  const config=custom?validate(JSON.parse(fs.readFileSync(file,'utf8'))):bundled(root);
  return {...config,custom,revision:createHash('sha256').update(JSON.stringify(config)).digest('hex')};
}
export function savePersona(root:string,input:unknown){
  const value=input as any,config=validate(value),current=personaSettings(root);
  if(value.revision!==current.revision)throw new FishError('PERSONA_CHANGED_RELOAD');
  if(value.voiceExamples===undefined)config.voiceExamples=current.voiceExamples;
  makeDir(root,'runtime/data');const tmp=override+'.'+randomUUID()+'.tmp';
  try{writePrivate(root,tmp,JSON.stringify(config,null,2)+'\n');fs.renameSync(safePath(root,tmp),safePath(root,override));}
  finally{fs.rmSync(safePath(root,tmp),{force:true});}
  return personaSettings(root);
}
export const personalityPrompt=(root=projectRoot(),options?:{excludeKaomoji?:Iterable<string>}):string=>personaSettings(root).blocks
  .map(block=>block.kind==='kaomoji'?kaomojiPrompt(options?.excludeKaomoji):block.text.trim()).filter(Boolean).join('\n');
const staticText=({blocks}:PersonaConfig)=>blocks.filter(block=>block.kind!=='kaomoji')
  .map(block=>block.text.trim()).filter(Boolean).join('\n');
function voiceText({voiceExamples}:PersonaConfig){
  const text=voiceExamples?.trim();
  return text?'发言与内心独白口吻示例（对外发言、自我思考和记笔记时参考自己的口吻，别被贴吧、新闻或网页的书面语气带偏）：\n'+text:'';
}
export const staticPersonalityPrompt=(root=projectRoot()):string=>staticText(personaSettings(root));
export const voiceExamplesPrompt=(root=projectRoot()):string=>voiceText(personaSettings(root));
export function personalityPrefix(root:string,...context:string[]):string{
  const config=personaSettings(root);
  return [staticText(config),voiceText(config),...context].filter(Boolean).join('\n');
}
export const appearancePrompt=(root=projectRoot()):string=>personaSettings(root).appearance.trim();
// Compatibility export for callers that only need the bundled default.
export const CHARACTER_APPEARANCE=bundled(projectRoot()).appearance;
export const characterPrompt=(root=projectRoot(),personality=personalityPrompt(root)):string=>[personality,appearancePrompt(root),CHARACTER_IMAGE_GUIDANCE].join('\n');
