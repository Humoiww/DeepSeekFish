import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configureQQ,configureGroupKeywords,readQQSettings } from '../src/qq/settings.js';
import { fixture } from './helpers.js';
import { writePrivate } from '../src/paths.js';
import { createApp } from '../src/app.js';
import { createWebApp } from '../src/web/app.js';
import { webServer } from '../src/web/server.js';
import { once } from 'node:events';
test('human QQ setup enables private chat without group IDs and live pause/resume preserves Codex lock',async()=>{
  const f=fixture(),old=process.env.FISH_CODEX_IMAGE_ONLY;let app:ReturnType<typeof createApp>|undefined;
  try{
    process.env.FISH_CODEX_IMAGE_ONLY='1';writePrivate(f.root,'runtime/data/onebot-credentials.json',JSON.stringify({accessToken:'private-fixture-token'}));
    assert.throws(()=>configureQQ(f.root,{enabled:true,admins:[],groups:[]},'deepseek-flash'),/QQ_ADMIN_REQUIRED/);
    assert.throws(()=>configureQQ(f.root,{enabled:true,admins:['20002'],groups:[],codex:true},'deepseek-flash'),/INVALID_QQ_SETTINGS/);
    configureQQ(f.root,{enabled:true,admins:['20002'],groups:[]},'deepseek-flash');
    assert.ok(fs.existsSync(f.root+'/runtime/data/qq-enabled'));
    app=createApp(f.root,true);assert.deepEqual(app.cfg().privateUsers,['20002']);assert.equal(app.cfg().codex,false);
    assert.deepEqual(app.cfg().names,['肥鱼','Deepseek']);
    configureGroupKeywords(f.root,['  鲸酱  ','DEEPSEEK','deepseek']);assert.deepEqual(app.cfg().names,['鲸酱','DEEPSEEK']);
    configureQQ(f.root,{enabled:false,admins:['20002'],groups:[]},'deepseek-flash');assert.equal(app.cfg().enabled,false);assert.equal(fs.existsSync(f.root+'/runtime/data/qq-enabled'),false);
    configureQQ(f.root,{enabled:true,admins:['20002'],groups:[]},'deepseek-flash');assert.equal(app.cfg().enabled,true);
    assert.deepEqual(app.cfg().names,['鲸酱','DEEPSEEK'],'saving other settings must retain custom keywords');
    configureQQ(f.root,{enabled:true,admins:['20002'],groups:['123456'],keywords:[]},'deepseek-flash');
    assert.deepEqual(app.cfg().names,[]);assert.equal(app.status().groupCount,1);assert.deepEqual(app.status().groupTrigger.keywords,[]);
    const before=readQQSettings(f.root);
    for(const keywords of [[' '],['x'.repeat(65)],Array(51).fill('x'),['valid',42]])assert.throws(()=>configureGroupKeywords(f.root,keywords));
    assert.deepEqual(readQQSettings(f.root),before);
  }finally{if(app){await app.bot.stop();app.store.close();}f.cleanup();if(old===undefined)delete process.env.FISH_CODEX_IMAGE_ONLY;else process.env.FISH_CODEX_IMAGE_ONLY=old;}
});
test('WebUI QQ API round-trips custom keywords, including mention-only, without enabling groups',async()=>{
  const f=fixture(),app=createWebApp(f.root,true),port=22000+Math.floor(Math.random()*20000),{server}=webServer(app,port);
  try{
    server.listen(port,'127.0.0.1');await once(server,'listening');
    const url='http://127.0.0.1:'+port+'/api/qq',headers={authorization:'Bearer '+app.token,'content-type':'application/json'};
    const post=(keywords:unknown)=>fetch(url,{method:'POST',headers,body:JSON.stringify({enabled:false,admins:[],groups:[],keywords})});
    assert.equal((await post(['  鲸酱  ','DEEPseek'])).status,200);
    let saved:any=await (await fetch(url,{headers})).json();assert.deepEqual(saved.keywords,['鲸酱','DEEPseek']);assert.deepEqual(saved.configuredGroups,[]);assert.equal(saved.groupTrigger,'mention-or-keyword');
    assert.equal((await post(['x'.repeat(65)])).status,400);
    assert.equal((await post([])).status,200);saved=await (await fetch(url,{headers})).json();assert.deepEqual(saved.keywords,[]);
  }finally{server.close();await once(server,'close');await app.close();f.cleanup();}
});
