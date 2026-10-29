import type { ModelTool } from '../types.js';
import { imageFields } from '../web/images.js';

const remark={type:'string',description:'动手前想对对方说的话，会先发到聊天里',minLength:1,maxLength:180};
export function qqChatTools(profile:boolean,image:boolean,qzone=false):ModelTool[]{
  return [
    {type:'function',function:{name:'get_quota',description:'读取现在的精力值、每日限额和还能请 GPT小姐画多少张图。',parameters:{type:'object',properties:{},additionalProperties:false}}},
    ...(profile?[{type:'function' as const,function:{name:'get_person',description:'查看对方的 QQ 头像和个人资料。',parameters:{type:'object',properties:{view:{type:'string',enum:['avatar','profile']},remark},required:['view','remark'],additionalProperties:false}}}]:[]),
    ...(qzone?[{type:'function' as const,function:{name:'get_qzone',description:'读取对方 QQ空间本人说说，按新到旧：第1条最新、第2条上一条、第3条上上条。返回每条ID、时间、正文及对应附件；可分页。',parameters:{type:'object',properties:{index:{type:'integer',minimum:1,maximum:10000},count:{type:'integer',minimum:1,maximum:10},remark},required:['index','count','remark'],additionalProperties:false}}}]:[]),
    ...(image?[{type:'function' as const,function:{name:'generate_image',description:'请 GPT小姐按你的画面设想画一张图，未指定的画面细节由你决定，完成后直接发进当前 QQ 对话。',parameters:{type:'object',
      properties:{remark,...Object.fromEntries(Object.entries(imageFields).map(([key,label])=>[key,{type:'string',description:label,maxLength:300}]))},
      required:['remark',...Object.keys(imageFields)],additionalProperties:false}}}]:[])
  ];
}
