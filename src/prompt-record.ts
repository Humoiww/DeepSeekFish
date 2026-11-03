import { Store } from './storage/db.js';
import {diagnosticSafe} from './diagnostics.js';
const channels=['qq','web','image','daily','news','memory','exploration'] as const;
export type PromptChannel=typeof channels[number];
/** Store the actual request body, never Authorization headers or image data/URLs. */
export function recordPrompt(store:Store,channel:PromptChannel,request:unknown){
  const json=JSON.stringify(diagnosticSafe({at:Date.now(),request}));
  store.setMeta('prompt:last:'+channel,json);
}
export function promptSnapshots(store:Store){
  return Object.fromEntries(channels.map(channel=>[channel,JSON.parse(store.getMeta('prompt:last:'+channel)??'null')]));
}
