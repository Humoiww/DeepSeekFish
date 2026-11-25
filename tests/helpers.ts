import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { prepare, defaults, type Config } from '../src/config.js';
import { Store } from '../src/storage/db.js';
import { Ledger } from '../src/budget/ledger.js';
import { randomUUID } from 'node:crypto';
import {personaSettings,savePersona,staticPersonalityPrompt,voiceExamplesPrompt} from '../src/character.js';
import type { Message,ModelTool } from '../src/types.js';
const fixtureBase=os.tmpdir();
export function fixture(overrides:Partial<Config>={}){
  const root=fs.mkdtempSync(path.join(fixtureBase,'fish-case-'));
  prepare(root);
  let cfg:Config={...defaults,groups:['g','g2'],admins:['admin'],quietHours:[0,0],...overrides};
  const store=new Store(root),ledger=new Ledger(store,()=>cfg);
  return {root,store,ledger,cfg:()=>cfg,set:(c:Partial<Config>)=>{cfg={...cfg,...c};},cleanup:()=>{store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
export function message(text='你好',override:Partial<Message>={}):Message{
  return {id:randomUUID(),group:'g',user:'admin',at:Date.now(),mentioned:true,event:'mention',text,...override};
}

export function assertPersonaLayout(root:string,messages:readonly {role:string;content:unknown}[]){
  const opening=messages[0],ending=messages.at(-1);
  const personality=staticPersonalityPrompt(root),voice=voiceExamplesPrompt(root);
  const prefix=[personality,voice].filter(Boolean).join('\n');
  assert.equal(opening?.role,'system');
  assert.ok(String(opening.content).startsWith(prefix+'\n'));
  assert.doesNotMatch(String(opening.content),/颜文字范例（需要时参考）/);
  assert.equal(ending?.role,'system');
  assert.match(String(ending?.content),/颜文字范例（需要时参考）/);
  for(const line of personality.split('\n'))assert.ok(String(ending?.content).includes(line));
  if(voice)assert.ok(!String(ending?.content).includes(voice));
}

export function seedVoiceExamples(root:string){
  savePersona(root,{...personaSettings(root),voiceExamples:'本鱼先去看看喵。'});
}

export function assertVoiceHint(tools:readonly ModelTool[]|undefined,name:string,field:string,hint:string,schema?:Record<string,unknown>){
  const properties=tools?.find(tool=>tool.function.name===name)?.function.parameters.properties as Record<string,Record<string,unknown>>|undefined;
  assert.ok(properties?.[field],name+'.'+field);
  const {description,...rest}=properties[field];
  assert.ok(String(description).includes(hint),name+'.'+field);
  if(schema)assert.deepEqual(rest,schema);
}
