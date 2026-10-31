import type { ModelTool } from '../types.js';
export const webTools:ModelTool[]=[
  {type:'function',function:{name:'search_web',description:'联网搜索公开网页，返回摘要、来源链接和日期；是否搜索、关键词由你决定。',parameters:{type:'object',properties:{query:{type:'string',maxLength:128,description:'搜索词，支持 site:、after:、before: 等查询语法'}},required:['query'],additionalProperties:false}}},
  {type:'function',function:{name:'fetch_page',description:'读取公开网页正文，可直接打开URL或继续看搜索结果；offset用于继续读长文。',parameters:{type:'object',properties:{url:{type:'string',maxLength:8192},offset:{type:'integer',minimum:0,maximum:200000}},required:['url'],additionalProperties:false}}},
];
