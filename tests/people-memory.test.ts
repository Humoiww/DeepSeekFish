import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture } from './helpers.js';
import { PersonMemory } from '../src/memory/people.js';
import { dayStart } from '../src/memory/journal.js';
import { MockImageProvider } from '../src/image/provider.js';
import { makeDir } from '../src/paths.js';
import { DeepSeekModel,inputBound } from '../src/agent/model.js';
import type { OneBotTransport } from '../src/qq/onebot.js';

test('profile observations retain verified media, keep cookies transient and isolate conversation/time windows',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:['20002']}),out=makeDir(f.root,'runtime/outputs/fixture');
  try{
    const image=await new MockImageProvider().generate('offline only',out);assert.equal(image.status,'ok');
    if(image.status!=='ok')return;const png=fs.readFileSync(image.path);let reads=0;
    const qq={readPerson:async()=>({nickname:'测试用户',long_nick:'兴趣是摄影',phoneNum:'not-retained'}),qzoneSession:async()=>({cookies:'p_skey=never-store-this-secret; uin=o10001',bkn:'123'})} as unknown as OneBotTransport;
    const http=(async(input:any,init:any)=>{
      if(String(input).includes('emotion_cgi_msglist_v6')){reads++;assert.ok(init.headers.cookie.includes('never-store-this-secret'));return new Response(JSON.stringify({code:0,msglist:[{tid:'post-one',content:'今天去海边摄影',created_time:Math.floor(Date.now()/1000),pic:[{url3:'https://qpic.cn/example.png'}]}]}));}
      assert.equal(init?.headers?.cookie,undefined);return new Response(png,{headers:{'content-type':'image/png'}});
    }) as typeof fetch;
    const capture=async(_uin:string,cookie:string)=>{assert.ok(cookie.includes('never-store-this-secret'));return {png:png.toString('base64'),page:{title:'测试空间',text:'今天去海边摄影'}};};
    const people=new PersonMemory(f.root,f.store,qq,f.cfg,http,capture),snapshot=await people.refresh('20002','private:20002');
    assert.ok(snapshot.avatar&&snapshot.screenshot);assert.equal(snapshot.posts[0].id,'post-one');assert.equal(people.images(snapshot,true).length,2);
    const file=f.root+'/'+snapshot.screenshot!.replace(/qzone\.png$/,'observation.json'),saved=fs.readFileSync(file,'utf8');
    assert.ok(!saved.includes('never-store-this-secret'));assert.ok(!saved.includes('not-retained'));
    assert.equal((await people.refresh('20002','private:20002')).id,snapshot.id);assert.equal(reads,1);
    assert.equal(people.remembered('20002','g2',{mode:'recent',since:0}),undefined);
    f.store.db.prepare('UPDATE person_observations SET observed=?').run(dayStart()-3*86400000);
    assert.equal(people.remembered('20002','private:20002',{mode:'recent',since:dayStart()-86400000}),undefined);
    assert.ok(people.remembered('20002','private:20002',{mode:'date',since:dayStart()-4*86400000,until:dayStart()-2*86400000}));
    await assert.rejects(people.refresh('30003','private:20002'),/PERSON_SCOPE_NOT_ALLOWED/);await people.close();
  }finally{f.cleanup();}
});
test('DeepSeek vision sends actual image blocks with a bounded image-token reservation',async()=>{
  const f=fixture({model:'deepseek-flash'});try{
    const messages:any=[{role:'user',content:[{type:'text',text:'评判最新动态'},{type:'image_url',image_url:{url:'data:image/png;base64,AA==',detail:'high'}}]}];
    const provider=new DeepSeekModel('fixture-key',f.cfg,(async(_url:any,init:any)=>{const body=JSON.parse(init.body);assert.equal(body.messages[0].content[1].type,'image_url');assert.equal(body.messages[0].content[1].image_url.url,'data:image/png;base64,AA==');return new Response(JSON.stringify({choices:[{message:{content:'画面清楚'}}],usage:{prompt_tokens:100,completion_tokens:10}}));}) as typeof fetch);
    assert.equal((await provider.complete(messages,256)).text,'画面清楚');assert.ok(inputBound(messages)<7000);
  }finally{f.cleanup();}
});
