import { Store,redact } from './storage/db.js';
const channels=['qq','web','image','daily'] as const;
export type PromptChannel=typeof channels[number];
/** Store the actual request body, never Authorization headers or image data/URLs. */
export function recordPrompt(store:Store,channel:PromptChannel,request:unknown){
  const json=JSON.stringify({at:Date.now(),request},(key,value)=>key==='image_url'?{url:'[图片附件：原始数据和临时链接不展示]',detail:value?.detail}:value);
  store.setMeta('prompt:last:'+channel,redact(json));
}
export function promptSnapshots(store:Store){
  return Object.fromEntries(channels.map(channel=>[channel,JSON.parse(store.getMeta('prompt:last:'+channel)??'null')]));
}
