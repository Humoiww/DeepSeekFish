import type { ModelTool } from '../types.js';
export const webTools:ModelTool[]=[
  {type:'function',function:{name:'search_web',description:'搜索公开网页，摘要含来源、发布日期和检索时间，排序不代表最新。是否查、查什么由你决定。',parameters:{type:'object',properties:{query:{type:'string',maxLength:128,description:'支持 site:、after:、before: 查询语法'},fresh:{type:'boolean',description:'跳过本地十分钟缓存；不能保证搜索索引即时更新'}},required:['query'],additionalProperties:false}}},
  {type:'function',function:{name:'fetch_page',description:'读取公开网页正文；offset续读，fresh刷新。返回页面状态与获取时间，验证码和登录页不代表读到了内容。',parameters:{type:'object',properties:{url:{type:'string',maxLength:8192},offset:{type:'integer',minimum:0,maximum:200000},fresh:{type:'boolean'}},required:['url'],additionalProperties:false}}},
];
export const browseTools:ModelTool[]=[
  {type:'function',function:{name:'browse_page',description:'实时读取公开网页/JSON正文、链接、原图；offset翻目录，query筛图名，textOffset续读。B站账号动态用 space.bilibili.com/数字UID/dynamic（先搜索UID），t.bilibili.com首页是关注流。覆盖范围及分页在回执中。',parameters:{type:'object',properties:{url:{type:'string'},offset:{type:'integer',minimum:0},query:{type:'string'},textOffset:{type:'integer',minimum:0}},required:['url'],additionalProperties:false}}},
  {type:'function',function:{name:'download_image',description:'url下载一张，urls批量下载最多12张原图并看图；各张独立返回结果，支持静图和动图抽帧；返回图库ID，可交给GPT生图或用collect_meme收藏表情。GitHub图片页面也可直接下载。',parameters:{type:'object',properties:{url:{type:'string'},urls:{type:'array',minItems:1,maxItems:12,items:{type:'string'}}},additionalProperties:false}}},
];
