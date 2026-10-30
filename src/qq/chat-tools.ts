import type { ModelTool } from '../types.js';
import { imageFields } from '../web/images.js';

const remark={type:'string',description:'动手前想对对方说的话，会先发到聊天里',minLength:1,maxLength:180};
export function qqChatTools(profile:boolean,image:boolean,qzone=false):ModelTool[]{
  return [
    {type:'function',function:{name:'get_quota',description:'读取现在的精力值、每日限额和还能请 GPT小姐画多少张图。',parameters:{type:'object',properties:{},additionalProperties:false}}},
    ...(profile?[{type:'function' as const,function:{name:'get_person',description:'查看对方的 QQ 头像和个人资料。',parameters:{type:'object',properties:{view:{type:'string',enum:['avatar','profile']},remark},required:['view','remark'],additionalProperties:false}}}]:[]),
    ...(qzone?[{type:'function' as const,function:{name:'get_qzone',description:'读取对方 QQ空间本人说说，按新到旧：第1条最新、第2条上一条、第3条上上条。返回每条ID、时间、正文及对应附件；可分页。',parameters:{type:'object',properties:{index:{type:'integer',minimum:1,maximum:10000},count:{type:'integer',minimum:1,maximum:10},remark},required:['index','count','remark'],additionalProperties:false}}}]:[]),
    ...(image?[{type:'function' as const,function:{name:'generate_image',description:'请 GPT小姐按画面方案生图。referenceIds 中选中的原图会实际附给她，可自行选择合适的参考图，不是只传文字；完成后发进当前 QQ 对话。',parameters:{type:'object',
      properties:{remark,referenceIds:{type:'array',items:{type:'string'},maxItems:3,description:'list_images 返回的图片 ID；最多三张，可留空。鲸酱原设定图的 ID 是 character。'},...Object.fromEntries(Object.entries(imageFields).map(([key,label])=>[key,{type:'string',description:label,maxLength:300}]))},
      required:['remark',...Object.keys(imageFields)],additionalProperties:false}}}]:[])
  ];
}
export function imageLibraryTools():ModelTool[]{return [
  {type:'function',function:{name:'list_images',description:'浏览可用参考原图：鲸酱设定图、当前对话近两天看到的空间配图/头像、这段QQ对话生成过的图片。返回图片ID和来源，可分页；不触发生图。',parameters:{type:'object',properties:{source:{type:'string',enum:['all','character','qzone','avatar','generated']},offset:{type:'integer',minimum:0,maximum:1000}},additionalProperties:false}}},
  {type:'function',function:{name:'view_images',description:'查看 list_images 中所选图片的真实视觉内容，再决定哪些适合发给 GPT小姐作参考。',parameters:{type:'object',properties:{imageIds:{type:'array',items:{type:'string'},minItems:1,maxItems:3}},required:['imageIds'],additionalProperties:false}}}
];}
export function requestsReferences(text:string):boolean{return /参考图|设定图|设定集|参考原图|图片库/.test(text);}
