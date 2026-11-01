// Run with the project's Node. The existing QQ service owns the WebSocket
// listener and reads these settings live; this script never starts a second bot.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../dist/src/config.js';
import { configureGroupKeywords,readQQSettings } from '../dist/src/qq/settings.js';
import { SocialGate } from '../dist/src/social/gate.js';

const {values}=parseArgs({options:{root:{type:'string'},keywords:{type:'string'},check:{type:'boolean'}}});
const root=path.resolve(values.root??path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
if(values.keywords!==undefined){
  const keywords=values.keywords.split(/[,，\r\n]+/).map(s=>s.trim()).filter(Boolean);
  configureGroupKeywords(root,keywords);
}
const config={...loadConfig(root),...readQQSettings(root)};
// Deliberately enable legacy switches in the dry run: neither may wake groups.
const gate=new SocialGate(()=>({...config,enabled:true,autoReply:true,autonomous:true}),undefined,()=>{throw Error('Unexpected random trigger');});
const ordinary={id:'check',group:'local-check-group',user:'local-check-user',text:'普通聊天，不需要回答',at:Date.now(),mentioned:false,event:'ordinary'};
const idleText=Array.from({length:128},(_,i)=>String.fromCodePoint(0xe000+i)).find(text=>!config.names.some(k=>text.toLowerCase().includes(k.toLowerCase())))??'local check';
const checks=[{kind:'ordinary',active:!!gate.decide([{...ordinary,text:idleText}])},{kind:'mention',active:!!gate.decide([{...ordinary,text:'[@你]',mentioned:true}])},
  ...config.names.map(word=>({kind:'keyword',keyword:word,active:!!gate.decide([{...ordinary,text:word.toUpperCase()}])}))];
const ok=checks[0].active===false&&checks.slice(1).every(c=>c.active);
console.log(JSON.stringify({saved:values.keywords!==undefined,mode:'mention-or-keyword',keywords:config.names,enabled:config.enabled,configuredGroupCount:config.groups.length,listener:'existing deepseekfish-qq.service',checks,ok,modelCalls:0,qqMessages:0},null,2));
if(!ok)process.exitCode=1;
