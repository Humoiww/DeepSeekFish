import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {createWebApp} from '../src/web/app.js';
import {fixture} from './helpers.js';

test('QQ access filter uses fresh platform results from actual activity',async()=>{
 const f=fixture(),app=createWebApp(f.root,true);
 try{
  const dir=path.join(f.root,'runtime/logs/qq');fs.mkdirSync(dir,{recursive:true});
  const save=(name:string,trace:unknown[])=>fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify({at:Date.now(),trace}));
  const cached=[
   {tool:'read_qq_quote',result:{source:'archive',target:{text:'缓存'}}},
   {tool:'download_qq_attachment',result:{downloaded:true,reused:true}},
   {tool:'get_qzone',result:{error:'NETWORK_ERROR'}},
  ];
  save('cached',cached);
  save('actual',[
   ...cached,
   {tool:'get_qzone',result:{source:'QQ空间说说列表',status:'ok',posts:[{}],spaceOwner:{qq:'12345',relation:'self'}}},
   {tool:'get_person',result:{source:'qq_profile',profile:{nickname:'对方'}}},
  ]);
  const list=await app.activity(new URLSearchParams({kind:'qq_access'}));
  assert.deepEqual(list.items.map(item=>[item.id,item.qqAccess]),[['qq:actual',2]]);
  const record=await app.activityDetail('qq:actual');
  assert.deepEqual(record.events.flatMap(item=>item.qqAccess?[item.qqAccess.label]:[]),['访问 QQ 空间','读取 QQ 资料']);
 }finally{await app.close();f.cleanup();}
});
