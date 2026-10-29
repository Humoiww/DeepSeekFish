import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {projectRoot} from '../src/config.js';
const {createLoginMemory}=await import(pathToFileURL(path.join(projectRoot(),'deploy/napcat-login-memory.mjs')).href);
const md5='a'.repeat(32),account='20002';
function fixture(){
  const root=fs.mkdtempSync(path.join(projectRoot(),'runtime/tmp/login-test-')),env:Record<string,string>={},auth=createLoginMemory(root,env);
  return {root,env,auth,close(){auth.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('verified native password/captcha login persists account and private fallback across process restarts',async()=>{
  const f=fixture();try{
    let chosen='';
    f.auth.attach({getQQLoginStatus:()=>true},async(uin:string)=>{chosen=uin;});
    const login=f.auth.wrap(async()=>({result:true}));
    await login(account,md5);assert.equal(chosen,account);
    const file=path.join(f.root,'login-secrets.json');assert.equal(fs.statSync(file).mode&0o777,0o600);
    assert.equal(f.env.NAPCAT_QUICK_ACCOUNT,account);assert.equal(f.env.NAPCAT_QUICK_PASSWORD_MD5,md5);
    const nextEnv:Record<string,string>={},next=createLoginMemory(f.root,nextEnv);
    try{assert.equal(next.status().saved,true);assert.equal(next.status().verified,true);assert.equal(nextEnv.NAPCAT_QUICK_PASSWORD_MD5,md5);assert.ok(!JSON.stringify(next.status()).includes(md5));}
    finally{next.close();}
  }finally{f.close();}
});
test('bad passwords are not saved; challenges pause retries and successful completion stores credentials',async()=>{
  const f=fixture();try{
    await f.auth.wrap(async()=>({result:false,message:'wrong'}))(account,md5);assert.equal(f.auth.status().saved,false);assert.equal(f.auth.status().paused,true);
    await f.auth.wrap(async()=>({result:false,needCaptcha:true}))(account,md5);assert.equal(f.auth.status().humanRequired,true);
    await f.auth.wrap(async()=>({result:true}))(account,md5);assert.equal(f.auth.status().saved,true);assert.equal(f.auth.status().humanRequired,false);assert.equal(f.auth.status().paused,false);
  }finally{f.close();}
});
test('native checkbox controls persistence and keeps the choice through a challenge',async()=>{
  const f=fixture();try{
    f.auth.choose(account,false);
    await f.auth.wrap(async()=>({result:false,needCaptcha:true}))(account,md5);
    await f.auth.wrap(async()=>({result:true}))(account,md5);
    assert.equal(f.auth.status().saved,false);
    assert.equal(f.auth.status().humanRequired,false);
    f.auth.choose(account,true);
    await f.auth.wrap(async()=>({result:true}))(account,md5);
    assert.equal(f.auth.status().saved,true);
    f.auth.choose(account,false);
    await f.auth.wrap(async()=>({result:true}))(account,md5);
    assert.equal(f.auth.status().saved,false);
  }finally{f.close();}
});
test('offline recovery uses native fallback once per backoff window and never logs out an online account',async()=>{
  const f=fixture();try{
    await f.auth.save(account,md5);let calls=0,online=true;
    const run=f.auth.guard(async()=>{calls++;});
    f.auth.attach({getQQLoginStatus:()=>online,getQQLoginPhase:()=>online?'ready':'waiting_qrcode',runWebUiConfigQuickFunction:run},async()=>{});
    await f.auth.recover(1000000);assert.equal(calls,0);
    online=false;await f.auth.recover(1000000);assert.equal(calls,1);
    await f.auth.recover(1001000);assert.equal(calls,1);
    await f.auth.recover(1300001);assert.equal(calls,2);
    f.auth.forget();assert.equal(f.auth.status().saved,false);assert.equal(f.env.NAPCAT_QUICK_PASSWORD_MD5,undefined);
    await f.auth.recover(1600002);assert.equal(calls,2);
  }finally{f.close();}
});
