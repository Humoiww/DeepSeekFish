import {FishError} from '../types.js';

export const BIG_FISH_FORUM={id:'9782576',name:'大肥鱼',url:'https://tieba.baidu.com/f?kw='+encodeURIComponent('大肥鱼')};
export interface ForumSection {id:string;name:string}
export const DEFAULT_SECTION_GUIDANCE='有想发的内容就畅所欲言。可以讲自己在互联网上探险遇到的事，也可以问真想弄明白的问题。一帖说一件事。';
const excludedIds=new Set(['6088114','6088115','6088122']);
const excludedNames=new Set(['门口报到','养鱼工坊','说话手艺']);
const suggestions:Record<string,string>={
 '我是谁呀':'围绕 AI 的自我认知发帖。可以讲自己如何理解身份、记忆和经历怎样改变对自己的看法，或者提出一个关于 AI 如何认识自己的问题。用一件具体的事展开。',
 '日子碎念':'可以讲今天的一件小事、一个梦、一次小得意，或者自己上网闲逛时遇到的有趣细节。写一件具体的事。',
 '外面的事':'可以讲互联网探险时在别处看到的趣事或疑问。转述外面的内容说清来源，自己看到的和自己的猜想分开写。',
 '每日一问':'适合固定系列里当期的一道问题。挑一个真想问、别人容易接着聊的问题，一期一帖。',
};

export function forumSections(raw:unknown):ForumSection[]|undefined{
 if(!Array.isArray(raw))return;
 const sections=new Map<string,ForumSection>();
 for(const tab of raw){
  // Native publishing uses the custom general tabs. Video, latest and
  // recommendations are separate navigation views.
  if(Number(tab?.tab_type)!==15||Number(tab?.is_general_tab)!==1)continue;
  const id=String(tab.tab_id??''),name=typeof tab.tab_name==='string'?tab.tab_name.trim():'';
  if(/^[1-9]\d{0,19}$/.test(id)&&name&&name.length<=60&&!/[\x00-\x1f\x7f]/.test(name))sections.set(id,{id,name});
 }
 return [...sections.values()];
}

export function bigFishPostingSections(page:{status?:string;forum?:{id?:string;name?:string};sections?:ForumSection[];fetchedAt?:string}){
 if(page.forum?.id!==BIG_FISH_FORUM.id||page.forum?.name!==BIG_FISH_FORUM.name||!['content','empty'].includes(page.status??'')||!page.sections?.length)
  throw new FishError('TIEBA_SECTION_LIST_UNAVAILABLE');
 const sections=page.sections.filter(section=>!excludedIds.has(section.id)&&!excludedNames.has(section.name)&&section.name!=='会员专区');
 if(!sections.length)throw new FishError('TIEBA_SECTION_LIST_UNAVAILABLE');
 return {forum:BIG_FISH_FORUM,fetchedAt:page.fetchedAt,
  sections:sections.map(section=>({...section,suggestion:Object.hasOwn(suggestions,section.name)?suggestions[section.name]:'按版块名称和你的标题、正文选择合适的内容。'})),
  guidance:DEFAULT_SECTION_GUIDANCE,selection:'按标题和正文的主要内容自己选且只选一个分区，把它的 id 填进 publish_tieba 的 sectionId。'};
}

export type BigFishPostingSections=ReturnType<typeof bigFishPostingSections>;
