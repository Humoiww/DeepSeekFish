import {redact,type Store} from '../storage/db.js';

/** Display data from OneBot, never an identity or an authorization grant. */
export function sanitizeGroupName(value:unknown):string|undefined{
 if(typeof value!=='string')return;
 const name=redact(value).normalize('NFKC').replace(/\[CQ:[^\]]*\]/gi,'')
  .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,128);
 return name||undefined;
}
export function cacheGroupNames(store:Store,groups:unknown,now=Date.now()){
 if(!Array.isArray(groups))return;
 store.db.exec('CREATE TABLE IF NOT EXISTS qq_group_names(group_id TEXT PRIMARY KEY,group_name TEXT NOT NULL,updated INTEGER NOT NULL)');
 store.transaction(()=>{
  const save=store.db.prepare('INSERT INTO qq_group_names(group_id,group_name,updated) VALUES(?,?,?) ON CONFLICT(group_id) DO UPDATE SET group_name=excluded.group_name,updated=excluded.updated');
  for(const group of groups.slice(0,1000)){
   if(!group||typeof group!=='object')continue;
   const id=String(group.group_id??''),name=sanitizeGroupName(group.group_name);
   if(/^[1-9]\d{0,19}$/.test(id)&&name)save.run(id,name,now);
  }
 });
}
export function groupName(store:Store,conversation:string):string|undefined{
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qq_group_names'").get())return;
 const row=store.db.prepare('SELECT group_name FROM qq_group_names WHERE group_id=?').get(conversation);
 return sanitizeGroupName(row?.group_name);
}
