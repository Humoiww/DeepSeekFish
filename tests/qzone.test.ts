import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fixture} from './helpers.js';
import {QzoneMemory,qzoneSelection} from '../src/memory/qzone.js';
import {requestsQzone} from '../src/memory/people.js';
import {MockImageProvider} from '../src/image/provider.js';
import {makeDir} from '../src/paths.js';
import {dayStart} from '../src/memory/journal.js';
import type {OneBotTransport} from '../src/qq/onebot.js';

test('Space ordinals resolve latest/previous/third and paginated requests without treating messages as posts',()=>{
  assert.deepEqual(qzoneSelection('来，再看看我上上条动态'),{index:3,count:1});
  assert.deepEqual(qzoneSelection('上一条呢'),{index:2,count:1});
  assert.deepEqual(qzoneSelection('再上一条',3),{index:4,count:1});
  assert.deepEqual(qzoneSelection('看第十二条说说'),{index:12,count:1});
  assert.deepEqual(qzoneSelection('最近五条动态每条都确认'),{index:1,count:5});
  assert.deepEqual(qzoneSelection('下一页',1,5),{index:5,count:10});
  assert.equal(requestsQzone('上上条动态'),true);
  assert.equal(requestsQzone('上一条消息是什么'),false);
});
test('each Space post keeps its own ID/text/media; third-post queries cannot fall back to an avatar',async()=>{
  const f=fixture({qqTransport:'onebot',privateUsers:['20002']});try{
    const out=makeDir(f.root,'runtime/outputs/picture');const generated=await new MockImageProvider().generate('',out);if(generated.status!=='ok')throw Error('fixture');
    const png=fs.readFileSync(generated.path),seenURLs:string[]=[],seenOffsets:number[]=[];
    const rows=[
      {tid:'first',uin:20002,content:'自热火锅',created_time:100,pic:[{url3:'https://qpic.cn/first.png?cdn_secret=do-not-store'}]},
      {tid:'second',uin:20002,content:'办公室的门锁',created_time:90},
      {tid:'third',uin:20002,content:'好玩嘿，海边',created_time:80,video:[{pic_url:'https://qpic.cn/third.png',url3:'https://photovideo.photo.qq.com/video.mp4',video_time:12}]},
      {tid:'fourth',uin:20002,content:'第四条',created_time:70,pic:[{url3:'https://qpic.cn/fourth.png'}]}
    ];
    const qq={qzoneSession:async()=>({cookies:'p_skey=do-not-store-cookie',bkn:'123'})} as unknown as OneBotTransport;
    const http=(async(input:any,init:any)=>{
      const url=new URL(String(input));assert.ok(!url.hostname.includes('qlogo'));
      if(url.pathname.includes('emotion_cgi_msglist_v6')){
        assert.ok(init.headers.cookie.includes('do-not-store-cookie'));const offset=Number(url.searchParams.get('pos'));seenOffsets.push(offset);
        return new Response(JSON.stringify({code:0,total:4,msglist:rows.slice(offset,offset+Number(url.searchParams.get('num')))}));
      }
      seenURLs.push(url.pathname);assert.equal(init.headers,undefined);return new Response(png);
    }) as typeof fetch;
    const capture=async(_person:string,_cookie:string,postId?:string)=>({png:png.toString('base64'),page:{title:'说说',text:rows.find(r=>r.tid===postId)!.content}});
    const space=new QzoneMemory(f.root,f.store,qq,f.cfg,http,capture);
    const third=await space.read('20002','private:20002',{index:3,count:1});
    assert.deepEqual(seenOffsets,[2]);assert.equal(third.posts[0].id,'third');assert.equal(third.posts[0].position,3);
    assert.equal(third.posts[0].media[0].kind,'video_cover');assert.ok(!seenURLs.includes('/first.png'));
    const parts=space.images(third);assert.equal(parts.filter(p=>p.type==='image_url').length,1);
    const label=JSON.parse((parts[0] as any).text);assert.equal(label.postId,'third');assert.equal(label.viewed,'cover_only');assert.equal(label.source,'QQ空间说说附件');
    assert.ok(!JSON.stringify(space.context(third)).includes('avatar'));assert.equal(space.lastIndex('20002','private:20002'),3);
    const page=await space.read('20002','private:20002',{index:1,count:3});
    assert.deepEqual(page.posts.map(p=>p.id),['first','second','third']);assert.equal(page.posts[1].media.length,0);assert.equal(page.nextIndex,4);
    const saved=JSON.stringify([...f.store.db.prepare('SELECT data FROM qzone_observations').all()]);
    assert.ok(!saved.includes('do-not-store-cookie'));assert.ok(!saved.includes('cdn_secret'));
    assert.equal(space.remembered('20002','g2',{mode:'recent',since:0}),undefined);
    f.store.db.prepare('UPDATE qzone_observations SET observed=?').run(dayStart()-3*86400000);
    assert.equal(space.remembered('20002','private:20002',{mode:'recent',since:dayStart()-86400000}),undefined);
    await assert.rejects(async()=>space.read('30003','private:20002',{index:1,count:1}),/PERSON_SCOPE/);
    await space.close();
  }finally{f.cleanup();}
});
