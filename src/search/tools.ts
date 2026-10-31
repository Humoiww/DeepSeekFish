import type { ModelTool } from '../types.js';
export const webTools:ModelTool[]=[
  {type:'function',function:{name:'search_web',description:'联网搜索公开网页，返回摘要、来源链接和日期；是否搜索、关键词由你决定。',parameters:{type:'object',properties:{query:{type:'string',maxLength:128,description:'搜索词，支持 site:、after:、before: 等查询语法'}},required:['query'],additionalProperties:false}}},
  {type:'function',function:{name:'fetch_page',description:'读取公开网页正文，可直接打开URL或继续看搜索结果；offset用于继续读长文。',parameters:{type:'object',properties:{url:{type:'string',maxLength:8192},offset:{type:'integer',minimum:0,maximum:200000}},required:['url'],additionalProperties:false}}},
];
export const browseTools:ModelTool[]=[
  {type:'function',function:{name:'browse_page',description:'自主浏览公开网页，提取正文、链接和原图候选地址；可跟随链接继续找图，offset翻页。动态页面可能需要fetch_page辅助。',parameters:{type:'object',properties:{url:{type:'string'},offset:{type:'integer',minimum:0}},required:['url'],additionalProperties:false}}},
  {type:'function',function:{name:'download_image',description:'从公开地址下载图片原文件并看图，支持静图和动图抽帧；返回图库ID，可交给GPT生图或用collect_meme收藏表情。GitHub图片页面也可直接下载。',parameters:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false}}},
];
