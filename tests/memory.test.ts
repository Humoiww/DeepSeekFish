import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers.js';
import { MemoryJournal,memoryDay,recallScope } from '../src/memory/journal.js';
import { inputBound } from '../src/agent/model.js';
import { requestsQzone,parseQzone } from '../src/memory/people.js';

test('daily archive survives rolling-window pruning; default recall uses today/yesterday and scope isolation',()=>{
  const f=fixture(),journal=new MemoryJournal(f.root,f.store),now=Date.UTC(2026,9,29,4),day=86400000;
  try{
    for(const [id,at,text,conversation] of [['old',now-2*day,'旧项目海边露营','g'],['yesterday',now-day,'昨天的话题','g'],['today',now,'今天的话题','g'],['other',now,'其他群的秘密','g2']] as const)
      journal.record({id,conversation,actor:'u',role:'user',text,at});
    journal.record({id:'today',conversation:'g',actor:'u',role:'user',text:'duplicate',at:now});
    f.store.prune(1,1);
    assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM memory_events').get() as any).n,4);
    const recent=journal.recall('g','你好',[],now);assert.deepEqual(recent.events.map(e=>e.id),['yesterday','today']);
    assert.deepEqual(journal.recall('g','2026-10-27说过什么',[],now).events.map(e=>e.id),['old']);
    assert.deepEqual(journal.recall('g','回忆一下“海边露营”',[],now).events.map(e=>e.id),['old']);
    assert.equal(journal.recall('g','还记得上次那件事吗',[],now).needsReference,true);
    const folder=f.root+'/runtime/memory/days/'+memoryDay(now);assert.equal(fs.readdirSync(folder).length,2);
    const lines=fs.readdirSync(folder).flatMap(file=>fs.readFileSync(folder+'/'+file,'utf8').trim().split('\n'));assert.equal(lines.length,2);
    assert.equal(memoryDay(Date.UTC(2026,9,28,16)),'2026-10-29');
    assert.equal(recallScope('昨天说的',now).until,Date.UTC(2026,9,28,16));
  }finally{f.cleanup();}
});
test('image transport base64 does not become fake text-token cost; latest-post routing rejects programming topics',()=>{
  const a=inputBound([{role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(1000000)}}]}]);
  assert.ok(a>1024&&a<10000);
  assert.equal(requestsQzone('评判一下我最新动态'),true);assert.equal(requestsQzone('帮我看看这道动态规划题'),false);
  assert.equal(parseQzone('_preloadCallback({"code":0,"msglist":[]});').msglist.length,0);
  assert.throws(()=>parseQzone('{"code":-100,"message":"not visible"}'),/QZONE_ACCESS_UNAVAILABLE/);
});
