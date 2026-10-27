import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.js';
import { makeDir } from '../src/paths.js';
import { MockImageProvider } from '../src/image/provider.js';
import { captureCodexImage,codexImageSmoke,publishCodexImage } from '../src/image/codex-smoke.js';
import { executionFeatures } from '../src/codex/platform.js';

test('image smoke requires native completion and valid PNG, never an assistant claim or fileId alone',async()=>{
  const f=fixture();try{
    const generated=makeDir(f.root,'runtime/codex-home/generated_images');
    await new MockImageProvider().generate('fixture only',generated);
    const source=path.join(generated,'mock.png'),bytes=fs.readFileSync(source);
    const cwd=makeDir(f.root,'runtime/workspace/image-test');
    assert.throws(()=>captureCodexImage(f.root,cwd,[],10000),/UNSUPPORTED_OR_MISSING/);
    assert.throws(()=>captureCodexImage(f.root,cwd,[{id:'x',type:'imageGeneration',status:'completed',fileId:'unknown'}],10000),/ATTACHMENT_UNAVAILABLE/);
    assert.throws(()=>captureCodexImage(f.root,cwd,[{id:'x',type:'imageGeneration',status:'failed',savedPath:source}],10000),/GENERATION_FAILED/);
    const result=captureCodexImage(f.root,cwd,[{id:'x',type:'imageGeneration',status:'completed',result:bytes.toString('base64')}],10000);
    assert.deepEqual(fs.readFileSync(result),bytes);
    // A native tool that already saved the correct destination needs no self-copy.
    assert.equal(captureCodexImage(f.root,cwd,[{id:'x',type:'imageGeneration',status:'completed',savedPath:result}],10000),result);
  }finally{f.cleanup();}
});
test('image collection refuses private/outside paths, symlinks, bad CRC and oversized data',async()=>{
  const f=fixture();try{
    const cwd=makeDir(f.root,'runtime/workspace/image-bad');
    const generated=makeDir(f.root,'runtime/codex-home/generated_images');
    await new MockImageProvider().generate('fixture only',generated);
    const source=path.join(generated,'mock.png');
    const item={id:'x',type:'imageGeneration' as const,status:'completed'};
    assert.throws(()=>captureCodexImage(f.root,cwd,[{...item,savedPath:path.join(f.root,'runtime/codex-home/auth.json')}],10000),/PATH_TRAVERSAL/);
    const linked=path.join(generated,'linked.png');fs.symlinkSync(source,linked);
    assert.throws(()=>captureCodexImage(f.root,cwd,[{...item,savedPath:linked}],10000),/PATH_LINK/);
    assert.throws(()=>captureCodexImage(f.root,cwd,[{...item,result:'!@#$'}],10000),/INVALID_DATA/);
    assert.throws(()=>captureCodexImage(f.root,cwd,[{...item,savedPath:source}],1),/INVALID_PNG/);
    const corrupted=fs.readFileSync(source);corrupted[corrupted.length-1]^=1;
    assert.throws(()=>captureCodexImage(f.root,cwd,[{...item,result:corrupted.toString('base64')}],10000),/INVALID_PNG/);
    assert.ok(!fs.existsSync(path.join(cwd,'image.png')));
  }finally{f.cleanup();}
});
test('real image command requires local review and project login before charging or starting a model',async()=>{
  const f=fixture();try{
    await assert.rejects(codexImageSmoke(f.root,'one fish',false),/LOCAL_REVIEW_REQUIRED/);
    const result=await codexImageSmoke(f.root,'one fish',true);
    assert.equal(result.ok,false);assert.equal(result.error,'CODEX_PROJECT_LOGIN_REQUIRED');
    assert.deepEqual(f.ledger.snapshot(),[]);
    assert.ok(!fs.existsSync(path.join(f.root,'runtime/outputs',result.id)));
    assert.equal(executionFeatures().image_generation,false);
    const enabled=executionFeatures(true);assert.equal(enabled.image_generation,true);assert.equal(enabled.shell_tool,false);
    assert.equal(enabled.apps,false);assert.equal(enabled.multi_agent,false);assert.equal(enabled.plugins,false);
  }finally{f.cleanup();}
});
test('native empty protection directories allow one PNG; any additional file blocks publication',async()=>{
  const f=fixture();try{
    for(const id of ['native-empty','native-extra']){
      const cwd=makeDir(f.root,'runtime/workspace/'+id);
      await new MockImageProvider().generate('fixture only',cwd);
      fs.renameSync(path.join(cwd,'mock.png'),path.join(cwd,'image.png'));
      for(const dir of ['.git','.codex','.agents','.aws'])fs.mkdirSync(path.join(cwd,dir));
    }
    const manifest=publishCodexImage(f.root,'native-empty',10000);assert.equal(manifest.length,1);assert.equal(manifest[0].name,'image.png');
    fs.writeFileSync(path.join(f.root,'runtime/workspace/native-extra/extra.txt'),'unexpected');
    assert.throws(()=>publishCodexImage(f.root,'native-extra',10000),/ARTIFACT_LIMIT/);
    assert.ok(!fs.existsSync(path.join(f.root,'runtime/outputs/native-extra')));
  }finally{f.cleanup();}
});
