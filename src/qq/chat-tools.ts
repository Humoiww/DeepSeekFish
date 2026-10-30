import type { ModelTool } from '../types.js';
import { imageFields } from '../web/images.js';

const remark={type:'string',description:'想顺口对朋友说的话，可省略',maxLength:180};
export function qqChatTools(profile:boolean,image:boolean,qzone=false):ModelTool[]{
  return [
    {type:'function',function:{name:'get_quota',description:'读取现在的精力值、每日限额和还能请 GPT小姐画多少张图。',parameters:{type:'object',properties:{},additionalProperties:false}}},
    ...(profile?[{type:'function' as const,function:{name:'get_person',description:'查看对方 QQ 头像和资料。',parameters:{type:'object',properties:{view:{type:'string',enum:['avatar','profile']},remark},required:['view'],additionalProperties:false}}}]:[]),
    ...(qzone?[{type:'function' as const,function:{name:'get_qzone',description:'看QQ空间说说：1最新、2上一条、3上上条。分页返回ID、时间、正文及对应附件。',parameters:{type:'object',properties:{index:{type:'integer',minimum:1,maximum:10000},count:{type:'integer',minimum:1,maximum:10},remark},required:['index','count'],additionalProperties:false}}}]:[]),
    ...(image?[{type:'function' as const,function:{name:'generate_image',description:'请GPT小姐画图，referenceIds会附上原图；画面和参考由你选，成图发进当前对话。',parameters:{type:'object',
      properties:{remark,referenceIds:{type:'array',items:{type:'string'},maxItems:3,description:'图库ID，最多3张；本人设定图为character。'},...Object.fromEntries(Object.entries(imageFields).map(([key,label])=>[key,{type:'string',description:label,maxLength:300}]))},
      required:Object.keys(imageFields),additionalProperties:false}}}]:[])
  ];
}
export function imageLibraryTools():ModelTool[]{return [
  {type:'function',function:{name:'list_images',description:'图库：设定图、当前对话近两天看过的空间配图/头像、当前QQ对话生成图。返回ID、来源、分页。',parameters:{type:'object',properties:{source:{type:'string',enum:['all','character','qzone','avatar','generated']},offset:{type:'integer',minimum:0,maximum:1000}},additionalProperties:false}}},
  {type:'function',function:{name:'view_images',description:'查看所选ID的原图，可作为GPT生图参考。',parameters:{type:'object',properties:{imageIds:{type:'array',items:{type:'string'},minItems:1,maxItems:3}},required:['imageIds'],additionalProperties:false}}}
];}
export function requestsReferences(text:string):boolean{return /参考图|设定图|设定集|参考原图|图片库/.test(text);}
