#!/usr/bin/env node
// Offline smoke only: the send callback is an in-memory fake, never HTTP.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {TiebaPosting,tiebaTools} from '../dist/src/tieba/posting.js';
const base=path.resolve('runtime/tmp');fs.mkdirSync(base,{recursive:true});const dir=fs.mkdtempSync(path.join(base,'tieba-posting-smoke-'));
const actor={id:'101',name:'smoke'},policy={mode:'preview',accountId:'101'},following=[{id:'11',name:'followed-one'},{id:'22',name:'followed-two'}];
let sends=0;const reads=[];
const reader={async followed(){return following;},async read(url){reads.push(url);const tid=new URL(url).pathname.includes('/comment')?new URL(url).searchParams.get('tid'):new URL(url).pathname.split('/').at(-1);return {status:'content',forum:{id:tid==='999'?'33':'11'},thread:{id:tid},posts:new URL(url).pathname.includes('/comment')?[{id:'77',parentPostId:'55',author:{id:'202'}}]:[{id:'55'}]};}};
const send=async()=>{sends++;throw Error('No network writer exists in this smoke test');},db=new TiebaPosting(dir),results=[];
try{
 for(const [n,input] of [
  ['thread',{action:'thread',forumId:'11',title:'not published',content:'preview'}],
  ['reply',{action:'reply',forumId:'11',threadId:'444',content:'preview'}],
  ['comment',{action:'comment',forumId:'11',threadId:'444',postId:'55',subPostId:'77',content:'preview'}],
 ]){const r=await db.publish(input,n,actor,policy,reader,send);assert.equal(r.published,false);assert.equal(r.mode,'preview');results.push(n);}
 assert.ok(reads.some(u=>u.includes('/p/comment?tid=444&pid=55')));
 await assert.rejects(db.publish({action:'thread',forumId:'33',title:'blocked',content:'x'},'other-bar',actor,policy,reader,send),/READ_ONLY/);
 await assert.rejects(db.publish({action:'reply',forumId:'11',threadId:'999',content:'x'},'spoofed-bar',actor,policy,reader,send),/FORUM_MISMATCH/);
 await assert.rejects(db.publish({action:'comment',forumId:'11',threadId:'444',postId:'99',content:'x'},'spoofed-floor',actor,policy,reader,send),/FLOOR_NOT_VERIFIED/);
 await assert.rejects(db.publish({action:'thread',forumId:'11',title:'x',content:'x',mode:'live'},'escalate',actor,policy,reader,send),/INPUT_INVALID/);
 const original={action:'thread',forumId:'11',title:'not published',content:'preview'};
 assert.equal((await db.publish(original,'thread',actor,policy,reader,send)).reused,true);
 await assert.rejects(db.publish(original,'thread',{id:'303',name:'another'},policy,reader,send),/ACCOUNT_NOT_AUTHORIZED/);
 assert.equal(sends,0);assert.ok(db.history().every(r=>r.state==='preview'));
 assert.deepEqual(tiebaTools.map(t=>t.function.name),['get_tieba_account','publish_tieba']);
 console.log(JSON.stringify({ok:true,mode:'preview',actions:results,realPublicationRequests:0,denied:['unfollowed forum','spoofed forum/thread','spoofed floor','model mode override','another account'],deduplication:true,nestedReplyVerified:true}));
}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
