// Run with application workers stopped, after a private SQLite backup. No API calls.
import fs from 'node:fs';
import path from 'node:path';
import {Store} from '../dist/src/storage/db.js';
import {Ledger,dayKey} from '../dist/src/budget/ledger.js';
import {loadConfig} from '../dist/src/config.js';
import {migrateLegacyCosts} from '../dist/src/budget/migrate.js';

const root=path.resolve(process.argv[2]??process.cwd()),day=dayKey(),evidence=[];
function collect(trace){for(const e of trace??[])if(e.reservation?.id&&e.request?.model&&e.startedAt&&dayKey(e.startedAt)===day)evidence.push({id:e.reservation.id,model:e.request.model,at:e.startedAt,usage:e.usage});}
for(const folder of ['qq','exploration','daily-news','daily-qzone']){
 const dir=path.join(root,'runtime/logs',folder);if(!fs.existsSync(dir))continue;
 for(const name of fs.readdirSync(dir)){
  if(!name.endsWith('.json'))continue;
  const file=path.join(dir,name),stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>16*1024*1024||dayKey(stat.mtimeMs)<day)continue;
  const data=JSON.parse(fs.readFileSync(file,'utf8'));collect(data.trace);
 }
}
const store=new Store(root),cfg=()=>loadConfig(root),ledger=new Ledger(store,cfg),web=new Store(root,'webui.sqlite');
try{
 if(web.db.prepare("SELECT name FROM sqlite_master WHERE name='web_turns'").get())for(const r of web.db.prepare('SELECT trace FROM web_turns').all())collect(JSON.parse(r.trace??'[]'));
 const result=migrateLegacyCosts(ledger,evidence,cfg().model,day);
 for(const [db,key] of [[store,'settings'],[web,'web-settings']]){
  const settings=JSON.parse(db.getMeta(key)??'{}');delete settings.dailyTokens;delete settings.groupDailyTokens;
  settings.dailyCny=5;settings.groupDailyCny??=0;db.setMeta(key,JSON.stringify(settings));
 }
 console.log(JSON.stringify({migration:result,cost:ledger.costSummary()}));
}finally{web.close();store.close();}
