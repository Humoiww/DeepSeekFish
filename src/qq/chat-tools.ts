import type { ModelTool } from '../types.js';
import { imageFields } from '../web/images.js';
import { knowledgeUpdateParameters } from '../memory/knowledge.js';

const remark={type:'string',description:'想顺口对朋友说的话，可省略',maxLength:180};
export function qqChatTools(profile:boolean,image:boolean,qzone=false):ModelTool[]{
  return [
    {type:'function',function:{name:'reply',description:'发消息并结束这一轮。memory可同时后台保存你想长期记住的内容；其他操作先用对应工具。',parameters:{type:'object',properties:{text:{type:'string',description:'你想对朋友说的话'},memory:knowledgeUpdateParameters},required:['text'],additionalProperties:false}}},
    {type:'function',function:{name:'get_quota',description:'读取现在的精力值、每日限额和还能请 GPT小姐画多少张图。',parameters:{type:'object',properties:{},additionalProperties:false}}},
    ...(profile?[{type:'function' as const,function:{name:'get_person',description:'查看对方 QQ 头像和资料。',parameters:{type:'object',properties:{view:{type:'string',enum:['avatar','profile']},remark},required:['view'],additionalProperties:false}}}]:[]),
    ...(qzone?[{type:'function' as const,function:{name:'get_qzone',description:'看指定账号的QQ空间说说。target=self是你（肥鱼）自己的空间，speaker是当前说话人，其他人填QQ号；1最新、2上一条。结果和附件标明所属账号。',parameters:{type:'object',properties:{target:{type:'string',description:'self / speaker / 明确的QQ号'},index:{type:'integer',minimum:1,maximum:10000},count:{type:'integer',minimum:1,maximum:10},remark},required:['target','index','count'],additionalProperties:false}}}]:[]),
    ...(image?[{type:'function' as const,function:{name:'generate_image',description:'请GPT小姐画图，referenceIds会附上原图；画面和参考由你选；成图存入图库并返回catalogId，还没发送。随后用send_image先发图再回复。',parameters:{type:'object',
      properties:{remark,referenceIds:{type:'array',items:{type:'string'},maxItems:3,description:'图库或recentImages的ID，最多3张；本人设定图为character，可与收到的图片一起附上。'},...Object.fromEntries(Object.entries(imageFields).map(([key,label])=>[key,{type:'string',description:label,maxLength:300}]))},
      required:Object.keys(imageFields),additionalProperties:false}}}]:[])
  ];
}
export function imageLibraryTools():ModelTool[]{return [
  {type:'function',function:{name:'send_image',description:'将图库中已生成的成图发到当前对话，随后再reply。催图时使用已有ID，不需要重画；重复调用查询送达结果，未确认的发送不重复投递。',parameters:{type:'object',properties:{imageId:{type:'string',description:'generate_image返回的catalogId，或list_images中generated-开头的ID'}},required:['imageId'],additionalProperties:false}}},
  {type:'function',function:{name:'list_images',description:'图库：设定图、收到的图片/空间配图/头像、收藏表情、生成图、网页下载图。生成图按新到旧排列，position=1 是最新；可收藏或交给GPT。',parameters:{type:'object',properties:{source:{type:'string',enum:['all','character','qzone','avatar','generated','received','collected','web']},offset:{type:'integer',minimum:0,maximum:1000}},additionalProperties:false}}},
  {type:'function',function:{name:'view_images',description:'查看所选ID的原图，可作为GPT生图参考。',parameters:{type:'object',properties:{imageIds:{type:'array',items:{type:'string'},minItems:1,maxItems:3}},required:['imageIds'],additionalProperties:false}}}
];}
export function requestsReferences(text:string):boolean{return /参考图|设定图|设定集|参考原图|图片库/.test(text);}
