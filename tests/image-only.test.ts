import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.js';
import { createWebApp } from '../src/web/app.js';
import { AppServerRunner } from '../src/codex/runner.js';
import { makeDir } from '../src/paths.js';

test('image-only deployment cannot enable or execute ordinary Codex tasks',async()=>{
  const old=process.env.FISH_CODEX_IMAGE_ONLY,f=fixture();let app:ReturnType<typeof createWebApp>|undefined;
  try{
    process.env.FISH_CODEX_IMAGE_ONLY='1';app=createWebApp(f.root,true);
    assert.equal(app.status().codexImageOnly,true);assert.equal(app.status().settings.codexQueue,false);
    assert.throws(()=>app!.configure({codexQueue:true}),/CODEX_IMAGE_ONLY/);
    const runner=new AppServerRunner(f.root),cwd=makeDir(f.root,'runtime/workspace/image-check'),signal=new AbortController().signal;
    await assert.rejects(runner.run(cwd,'ordinary task',signal),/CODEX_IMAGE_ONLY/);
    await assert.rejects(runner.generateImage(cwd,'image task',signal),/CODEX_PROJECT_LOGIN_REQUIRED/);
  }finally{if(app)await app.close();f.cleanup();if(old===undefined)delete process.env.FISH_CODEX_IMAGE_ONLY;else process.env.FISH_CODEX_IMAGE_ONLY=old;}
});
