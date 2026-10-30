import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {fixture,message} from './helpers.js';
import {makeDir} from '../src/paths.js';
import {MockImageProvider} from '../src/image/provider.js';
import {QQImageLibrary} from '../src/qq/image-library.js';
import {QQImageClient} from '../src/qq/image-client.js';
import {startQQImageBroker} from '../src/qq/image-broker.js';
import {CodexQuotaMonitor} from '../src/codex/quota.js';
import {runCodexImage,type ImageRunner} from '../src/image/codex-smoke.js';
import {stageReferences} from '../src/image/references.js';
import {dayStart} from '../src/memory/journal.js';
import {requestsImage} from '../src/web/images.js';

const plan={subject:'一只小鱼',scene:'海边',style:'插画',composition:'居中',lighting:'阳光',palette:'蓝色',details:'保持参考特征'};
test('catalog separates profiles and posts, scopes conversation/time and resolves opaque IDs only',async()=>{
  const f=fixture();try{
    const folder=makeDir(f.root,'runtime/memory/people/20002/today/item');await new MockImageProvider().generate('',folder);
    const relative=path.relative(f.root,path.join(folder,'mock.png')).split(path.sep).join('/');
    const chars=makeDir(f.root,'assets/character');fs.copyFileSync(path.join(folder,'mock.png'),path.join(chars,'whalechan-reference.png'));
    f.store.db.exec('CREATE TABLE qq_image_requests(conversation TEXT,message_id TEXT,state TEXT,image_id TEXT,error TEXT);CREATE TABLE qzone_observations(id TEXT,conversation TEXT,person TEXT,observed INTEGER,data TEXT);CREATE TABLE person_observations(id TEXT,conversation TEXT,person TEXT,observed INTEGER,data TEXT)');
    for(const [id,conversation,at] of [['fresh','private:20002',Date.now()],['other','g2',Date.now()],['old','private:20002',dayStart()-3*86400000]] as const){
      f.store.db.prepare('INSERT INTO qzone_observations VALUES(?,?,?,?,?)').run(id,conversation,'20002',at,JSON.stringify({posts:[{id,position:3,text:'测试说说',media:[{status:'downloaded',kind:'photo',path:relative}]}]}));
    }
    f.store.db.prepare('INSERT INTO person_observations VALUES(?,?,?,?,?)').run('avatar','private:20002','20002',Date.now(),JSON.stringify({avatar:relative}));
    const library=new QQImageLibrary(f.root,f.store),page=library.list('private:20002','20002');
    assert.equal(page.canAttachOriginals,true);assert.deepEqual(page.images.map(i=>i.source),['character','qzone','avatar']);
    assert.ok(!JSON.stringify(page).includes('runtime/'));assert.ok(!JSON.stringify(page).includes('qzone-other'));assert.ok(!JSON.stringify(page).includes('qzone-old'));
    const viewed=library.view('private:20002','20002',['qzone-fresh-0']);assert.equal(viewed.images[0].mime,'image/png');assert.ok(viewed.images[0].data);
    assert.throws(()=>library.select('g2','20002',['qzone-fresh-0']),/NOT_AVAILABLE/);
    assert.throws(()=>library.select('private:20002','20002',['runtime/codex-home/auth.json']),/NOT_AVAILABLE/);
    assert.throws(()=>library.select('private:20002','20002',['character','character']),/IDS_INVALID/);
    const cwd=makeDir(f.root,'runtime/workspace/partial');
    assert.throws(()=>stageReferences(f.root,cwd,[{id:'one',label:'first',path:path.join(folder,'mock.png')},{id:'missing',label:'missing',path:path.join(folder,'missing.png')}]));
    assert.deepEqual(fs.readdirSync(cwd),[]);
  }finally{f.cleanup();}
});
test('selected originals reach the native runner, require actual usage and are removed before publishing',async()=>{
  const f=fixture();try{
    const input=makeDir(f.root,'assets/character');await new MockImageProvider().generate('',input);
    fs.writeFileSync(path.join(f.root,'runtime/codex-home/auth.json'),'{}');
    let omit=false,seen:string[]=[];
    const runner:ImageRunner={async generateImage(cwd,prompt,_signal,primary,extras=[]){
      assert.equal(primary,undefined);seen=extras;assert.equal(extras.length,2);assert.ok(prompt.includes('referenced_image_paths'));
      const inputImages=extras.map(file=>({path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
      const generated=makeDir(f.root,'runtime/codex-home/generated_images/'+path.basename(cwd));await new MockImageProvider().generate('',generated);
      return {text:'',images:[{id:'image',type:'imageGeneration',status:'completed',savedPath:path.join(generated,'mock.png'),inputImages:omit?[]:inputImages}]};
    }};
    const references=[{id:'a',label:'第一张',path:path.join(input,'mock.png')},{id:'b',label:'第二张',path:path.join(input,'mock.png')}];
    const run=()=>runCodexImage(f.root,'两张参考图合成一张插画',{cfg:f.cfg(),ledger:f.ledger,group:'g',signal:new AbortController().signal,references,runner});
    const good=await run();assert.equal(good.ok,true);assert.equal(good.manifest?.length,1);assert.equal(good.manifest?.[0].name,'image.png');assert.ok(seen.every(p=>!fs.existsSync(p)));
    omit=true;const bad=await run();assert.equal(bad.ok,false);assert.equal(bad.error,'IMAGE_REFERENCES_NOT_USED');assert.ok(!fs.existsSync(f.root+'/runtime/outputs/'+bad.id));assert.ok(seen.every(p=>!fs.existsSync(p)));
  }finally{f.cleanup();}
});
test('broker lists and views references without charging and rejects unavailable files before generation',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:['20002'],images:true});fs.mkdirSync(f.root+'/config');fs.writeFileSync(f.root+'/config/local.json',JSON.stringify(f.cfg()));
  const chars=makeDir(f.root,'assets/character');await new MockImageProvider().generate('',chars);fs.renameSync(path.join(chars,'mock.png'),path.join(chars,'whalechan-reference.png'));
  const quota=new CodexQuotaMonitor(f.store,true,{read:async()=>{},close:async()=>{}}),broker=await startQQImageBroker(f.root,f.store,quota,true),client=new QQImageClient(f.root),m=message('把你自己参考图丢给gpt',{group:'private:20002',user:'20002'});
  try{
    for(const text of [m.text,'既然是肥鲸，那不妨把你自己参考图丢给gpt'])assert.equal(requestsImage(text),true);
    for(const text of ['看看你有哪些参考图','不要把参考图发给gpt画图','不要把参考图发给GPT','你为什么不能把参考图发给GPT'])assert.equal(requestsImage(text),false);
    assert.equal((await client.list(m)).images[0].id,'character');assert.ok((await client.view(m,['character'])).images[0].data);assert.equal(f.ledger.value('image'),0);
    await assert.rejects(client.generate(m,plan,1000,undefined,['../auth.json']),/NOT_AVAILABLE/);assert.equal(f.ledger.value('image'),0);
    const result=await client.generate(m,plan,1000,undefined,['character']);assert.equal(result.characterReference,true);assert.equal(result.references[0].id,'character');assert.equal(f.ledger.value('image'),1);
    assert.ok((await client.list(m,'generated')).images[0].id.startsWith('generated-'));
  }finally{await broker.close();await quota.close();f.cleanup();}
});
