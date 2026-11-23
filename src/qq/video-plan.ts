import {ProviderError} from '../diagnostics.js';
import type {ModelTool} from '../types.js';

export const VIDEO_FPS=12;
const maxSeconds=30;
const shapes=['ellipse','rect','triangle','diamond','star','ring'] as const;
const color=/^#[0-9a-f]{6}$/i;
type Shape=typeof shapes[number];
type Layer={shape:Shape;x:number;y:number;width:number;height:number;color:string;dx:number;dy:number};
export type VideoScene={caption?:string;background:string;layers:Layer[]};
export type VideoPlan={durationSeconds:number;orientation:'landscape'|'portrait';scenes:VideoScene[];countdown?:number;endText?:string};

const artGuide='每行一个图形：形状 中心X 中心Y 宽 高 #RRGGBB [位移X 位移Y]。坐标和尺寸用0–100百分比，位移可负，按顺序叠画。形状：'+shapes.join('、')+'。最多10行。';
const text={type:'string',minLength:1,maxLength:64};
export const videoTool:ModelTool={type:'function',function:{
 name:'generate_video',
 description:'用户想要视频文件时，用这个工具把题材设计成无声的图形或字幕动画、倒计时，直接生成并作为MP4附件发给当前QQ对话。按用户指定的时长和内容设计画面，不把普通制作请求当作开发任务。简单画面用短参数；回执会说明生成和发送是否成功。',
 parameters:{
  type:'object',additionalProperties:false,required:['durationSeconds'],
  properties:{
   durationSeconds:{type:'integer',minimum:1,maximum:maxSeconds,description:'成品总秒数，含结尾'},
   orientation:{type:'string',enum:['landscape','portrait']},
   countdown:{type:'integer',minimum:1,maximum:30,description:'可选，从该数字倒数到1，在可用时间内均匀切换'},
   endText:{...text,description:'倒计时结束语，占最后1秒，计入总时长'},
   scenes:{type:'array',minItems:1,maxItems:3,description:'最多3幕，均分可用时长。按用户内容画主体、布置背景和设计动作；字幕可选。',
    items:{type:'object',additionalProperties:false,properties:{
     caption:text,background:{type:'string',description:'背景颜色 #RRGGBB'},art:{type:'string',maxLength:512,description:artGuide},
    }}},
  },
 },
}};

function invalid(field:string,reason:string):never{
 throw new ProviderError('QQ_VIDEO_PLAN_INVALID',{field,reason});
}
function object(value:unknown,keys:string[],field:string):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))invalid(field,'请用工具定义中的字段。');
 return value as Record<string,unknown>;
}
function caption(value:unknown,field:string):string|undefined{
 if(value===undefined)return;
 if(typeof value!=='string'||!value.trim()||Array.from(value).length>64||/[\p{Cc}\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value))invalid(field,'请用1到64字的单行文字。');
 return value.trim();
}
function layers(value:unknown):Layer[]{
 if(value===undefined)return [];
 if(typeof value!=='string'||value.length>512)invalid('art',artGuide);
 const lines=value.trim().split(/\r?\n/).filter(line=>line.trim());
 if(lines.length>10)invalid('art',artGuide);
 return lines.map(line=>{
  const [shape,x,y,width,height,fill,dx='0',dy='0',...extra]=line.trim().split(/\s+/);
  const values=[x,y,width,height,dx,dy];
  if(extra.length||!shapes.includes(shape as Shape)||!color.test(fill??'')||!values.every(v=>/^-?\d{1,3}(?:\.\d{1,2})?$/.test(v??'')))invalid('art',artGuide);
  const [cx,cy,w,h,tx,ty]=values.map(Number);
  if(cx<0||cx>100||cy<0||cy>100||w<1||w>100||h<1||h>100||Math.abs(tx)>100||Math.abs(ty)>100)invalid('art',artGuide);
  return {shape:shape as Shape,x:cx,y:cy,width:w,height:h,color:fill.toLowerCase(),dx:tx,dy:ty};
 });
}
export function videoPlan(value:unknown):VideoPlan{
 const args=object(value,['durationSeconds','orientation','scenes','countdown','endText'],'plan');
 const duration=args.durationSeconds;
 if(typeof duration!=='number'||!Number.isInteger(duration)||duration<1||duration>maxSeconds)invalid('durationSeconds','请输入1到30之间的整数秒数。');
 const orientation=args.orientation??'landscape';
 if(orientation!=='landscape'&&orientation!=='portrait')invalid('orientation','请选择landscape或portrait。');
 const endText=caption(args.endText,'endText'),countdown=args.countdown;
 if(countdown!==undefined&&(typeof countdown!=='number'||!Number.isInteger(countdown)||countdown<1||countdown>Math.min(30,(duration-Number(!!endText))*VIDEO_FPS)))invalid('countdown','倒数数字须能放入指定时长，结尾文字占最后1秒。');
 if(endText&&!countdown)invalid('endText','普通场景的文字请填caption。');
 const raw=args.scenes??(countdown?[{}]:undefined);
 if(!Array.isArray(raw)||raw.length<1||raw.length>3)invalid('scenes','请用1到3个简短画面，或指定倒计时。');
 const scenes=raw.map(scene=>{
  const item=object(scene,['caption','background','art'],'scenes');
  const background=item.background??'#12243d';
  if(typeof background!=='string'||!color.test(background))invalid('background','请选择 #RRGGBB 颜色。');
  const label=caption(item.caption,'caption'),elements=layers(item.art);
  if(!label&&!elements.length&&!countdown)invalid('scenes','请为场景填写图形或字幕。');
  return {caption:label,background:background.toLowerCase(),layers:elements};
 });
 return {durationSeconds:duration,orientation,scenes,countdown:countdown as number|undefined,endText};
}
