import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { prepare, defaults, type Config } from '../src/config.js';
import { Store } from '../src/storage/db.js';
import { Ledger } from '../src/budget/ledger.js';
import { randomUUID } from 'node:crypto';
import type { Message } from '../src/types.js';
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
