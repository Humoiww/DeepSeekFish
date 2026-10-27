import fs from 'node:fs';
import path from 'node:path';
import { prepare, projectRoot, defaults, type Config } from '../src/config.js';
import { Store } from '../src/storage/db.js';
import { Ledger } from '../src/budget/ledger.js';
import { randomUUID } from 'node:crypto';
import type { Message } from '../src/types.js';
export function fixture(overrides:Partial<Config>={}){
  const base=path.join(projectRoot(),'runtime/tests');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'case-'));prepare(root);
  let cfg:Config={...defaults,groups:['g','g2'],admins:['admin'],quietHours:[0,0],...overrides};
  const store=new Store(root),ledger=new Ledger(store,()=>cfg);
  return {root,store,ledger,cfg:()=>cfg,set:(c:Partial<Config>)=>{cfg={...cfg,...c};},cleanup:()=>{store.close();fs.rmSync(root,{recursive:true,force:true});}};
}
export function message(text='你好',override:Partial<Message>={}):Message{
  return {id:randomUUID(),group:'g',user:'admin',at:Date.now(),mentioned:true,event:'mention',text,...override};
}
