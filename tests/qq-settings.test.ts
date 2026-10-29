import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { configureQQ } from '../src/qq/settings.js';
import { fixture } from './helpers.js';
import { writePrivate } from '../src/paths.js';
import { createApp } from '../src/app.js';
test('human QQ setup enables private chat without group IDs and live pause/resume preserves Codex lock',async()=>{
  const f=fixture(),old=process.env.FISH_CODEX_IMAGE_ONLY;let app:ReturnType<typeof createApp>|undefined;
  try{
    process.env.FISH_CODEX_IMAGE_ONLY='1';writePrivate(f.root,'runtime/data/onebot-credentials.json',JSON.stringify({accessToken:'private-fixture-token'}));
    assert.throws(()=>configureQQ(f.root,{enabled:true,admins:[],groups:[]},'deepseek-flash'),/QQ_ADMIN_REQUIRED/);
    assert.throws(()=>configureQQ(f.root,{enabled:true,admins:['20002'],groups:[],codex:true},'deepseek-flash'),/INVALID_QQ_SETTINGS/);
    configureQQ(f.root,{enabled:true,admins:['20002'],groups:[]},'deepseek-flash');
    assert.ok(fs.existsSync(f.root+'/runtime/data/qq-enabled'));
    app=createApp(f.root,true);assert.deepEqual(app.cfg().privateUsers,['20002']);assert.equal(app.cfg().codex,false);
    configureQQ(f.root,{enabled:false,admins:['20002'],groups:[]},'deepseek-flash');assert.equal(app.cfg().enabled,false);assert.equal(fs.existsSync(f.root+'/runtime/data/qq-enabled'),false);
    configureQQ(f.root,{enabled:true,admins:['20002'],groups:[]},'deepseek-flash');assert.equal(app.cfg().enabled,true);
  }finally{if(app){await app.bot.stop();app.store.close();}f.cleanup();if(old===undefined)delete process.env.FISH_CODEX_IMAGE_ONLY;else process.env.FISH_CODEX_IMAGE_ONLY=old;}
});
