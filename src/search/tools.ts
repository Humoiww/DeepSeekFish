import type { ModelTool } from '../types.js';
export const webTools:ModelTool[]=[
  {type:'function',function:{name:'search_web',description:'搜索公开网页，返回摘要、来源和时间。',parameters:{type:'object',properties:{query:{type:'string',maxLength:128,description:'支持 site:、after:、before: 查询语法'},fresh:{type:'boolean',description:'跳过本地十分钟缓存；不能保证搜索索引即时更新'}},required:['query'],additionalProperties:false}}},
  {type:'function',function:{name:'fetch_page',description:'付费 DeepSeek Fetch，仅在免费 browse_page 读取文本网页失败后，由你手动选择作为最后兜底；不能抓取图片，图片请用 download_image 或换来源。',parameters:{type:'object',properties:{url:{type:'string',maxLength:8192},offset:{type:'integer',minimum:0,maximum:200000},fresh:{type:'boolean'}},required:['url'],additionalProperties:false}}},
];
export const browseTools:ModelTool[]=[
  {type:'function',function:{name:'browse_page',description:'优先使用的免费直连读取，支持公开网页或社交平台内容，不会自动调用付费 Fetch；按回执中的分页链接或偏移继续读。',parameters:{type:'object',properties:{url:{type:'string'},offset:{type:'integer',minimum:0},query:{type:'string'},textOffset:{type:'integer',minimum:0}},required:['url'],additionalProperties:false}}},
  {type:'function',function:{name:'download_image',description:'下载网页原图到当前图库并预览，单次支持最多 12 个链接。',parameters:{type:'object',properties:{url:{type:'string'},urls:{type:'array',minItems:1,maxItems:12,items:{type:'string'}}},additionalProperties:false}}},
];
