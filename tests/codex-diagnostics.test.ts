import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { CodexDiagnostics,readCodexRecord } from '../src/codex/diagnostics.js';

test('Codex records persist streamed/final replies, RPC failures and image metadata without credentials or image data',()=>{
  const f=fixture();try{
    const log=new CodexDiagnostics(f.root,'record-check','draw; api_key=sk-secretvalue12345',true,'/task/reference.png');
    log.event('server-request',{method:'item/tool/call',decision:'unsupported'});
    log.event('rpc-error',{error:{code:123,message:'request rejected'}});
    log.stderr('WARN failed to execute bash: Permission denied; Bearer stderr-secret');
    log.notice('item/agentMessage/delta',{itemId:'reply',delta:'No image '});
    log.notice('item/agentMessage/delta',{itemId:'reply',delta:'returned.'});
    log.notice('item/completed',{item:{id:'reply',type:'agentMessage',phase:'final_answer',text:'No image returned. Bearer secret-token; "refresh_token":"private-refresh"'}});
    log.notice('item/completed',{item:{id:'image',type:'imageGeneration',status:'failed',result:'PRIVATE_IMAGE_BASE64',inputImages:[],failure:{message:'provider rejected'}}});
    log.finish('No image returned.');
    const record=readCodexRecord(f.root,'record-check')!;
    assert.equal(record.finalText,'No image returned.');assert.equal(record.messages.length,1);
    assert.equal(record.events.find(e=>e.method==='server-request')!==undefined,true);
    assert.equal(record.events.find(e=>e.method==='process-stderr')!==undefined,true);
    assert.equal((record.images[0] as any).status,'failed');
    const file=path.join(f.root,'runtime/logs/codex/record-check.json'),text=fs.readFileSync(file,'utf8');
    for(const secret of ['sk-secretvalue12345','secret-token','private-refresh','stderr-secret','PRIVATE_IMAGE_BASE64'])assert.equal(text.includes(secret),false,secret);
    assert.equal(fs.statSync(file).mode&0o777,0o600);
    assert.equal(readCodexRecord(f.root,'../auth'),undefined);
  }finally{f.cleanup();}
});
