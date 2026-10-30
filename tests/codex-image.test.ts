import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from '../src/config.js';
import { fixture } from './helpers.js';
import { makeDir } from '../src/paths.js';
import { MockImageProvider } from '../src/image/provider.js';
import { captureCodexImage,codexImageSmoke,publishCodexImage } from '../src/image/codex-smoke.js';
import { executionFeatures } from '../src/codex/platform.js';
import { CHARACTER_REFERENCE,BUNDLED_CHARACTER_REFERENCE,characterPrompt } from '../src/character.js';
import { isCharacterPortrait,prepareCharacterPortrait,verifyCharacterReference,resolveCharacterReference } from '../src/image/character-reference.js';

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
test('self portraits stage the fixed character PNG, ordinary images do not read it, and missing references fail closed',async()=>{
  const f=fixture();try{
    const cwd=makeDir(f.root,'runtime/workspace/portrait');
    assert.equal(isCharacterPortrait('生成一张你自己的图'),true);assert.equal(isCharacterPortrait('鲸酱喝茶的立绘'),true);
    assert.equal(isCharacterPortrait('画一只猫'),false);
    assert.deepEqual(prepareCharacterPortrait(f.root,cwd,'画一只猫'),{prompt:'画一只猫'});
    assert.throws(()=>prepareCharacterPortrait(f.root,cwd,'生成你的自画像'),/CHARACTER_REFERENCE_MISSING/);
    const dir=makeDir(f.root,'runtime/character');await new MockImageProvider().generate('fixture only',dir);
    fs.renameSync(path.join(dir,'mock.png'),path.join(f.root,CHARACTER_REFERENCE));
    const prepared=prepareCharacterPortrait(f.root,cwd,'生成一张你自己的图');
    assert.ok(prepared.reference?.path.startsWith(cwd+path.sep));assert.match(prepared.prompt,/鲸鳍耳/);assert.match(prepared.prompt,/referenced_image_paths/);
    verifyCharacterReference([{inputImages:[prepared.reference!]}],prepared.reference!);
    assert.throws(()=>verifyCharacterReference([{}],prepared.reference!),/CHARACTER_REFERENCE_NOT_USED/);
    assert.throws(()=>verifyCharacterReference([{inputImages:[{...prepared.reference!,sha256:'wrong'}]}],prepared.reference!),/CHARACTER_REFERENCE_NOT_USED/);
  }finally{f.cleanup();}
});
test('shared character prompt preserves the current appearance and reference guidance',()=>{
  const prompt=characterPrompt();
  for(const part of ['鲸酱','Q版','鲸鳍耳','女仆裙','鲸尾','设定图','不能声称已经生成'])assert.ok(prompt.includes(part));
});
test('bundled original reference works and is staged without private runtime data',()=>{
  const f=fixture();try{
    makeDir(f.root,'assets/character');
    fs.copyFileSync(path.join(projectRoot(),BUNDLED_CHARACTER_REFERENCE),path.join(f.root,BUNDLED_CHARACTER_REFERENCE));
    assert.equal(fs.existsSync(path.join(f.root,CHARACTER_REFERENCE)),false);
    assert.equal(resolveCharacterReference(f.root),path.join(f.root,BUNDLED_CHARACTER_REFERENCE));
    const prepared=prepareCharacterPortrait(f.root,makeDir(f.root,'runtime/workspace/bundled-portrait'),'给个自拍');
    assert.ok(prepared.reference?.path.startsWith(path.join(f.root,'runtime/workspace/bundled-portrait')+path.sep));
    assert.ok(fs.existsSync(prepared.reference!.path));
  }finally{f.cleanup();}
});
test('local reference overrides the bundled default, and an invalid override never silently falls back',async()=>{
  const f=fixture();try{
    makeDir(f.root,'assets/character');fs.copyFileSync(path.join(projectRoot(),BUNDLED_CHARACTER_REFERENCE),path.join(f.root,BUNDLED_CHARACTER_REFERENCE));
    const dir=makeDir(f.root,'runtime/character');await new MockImageProvider().generate('fixture',dir);
    fs.renameSync(path.join(dir,'mock.png'),path.join(f.root,CHARACTER_REFERENCE));
    assert.equal(resolveCharacterReference(f.root),path.join(f.root,CHARACTER_REFERENCE));
    fs.writeFileSync(path.join(f.root,CHARACTER_REFERENCE),'invalid override');
    assert.throws(()=>resolveCharacterReference(f.root),/INVALID_PNG/);
  }finally{f.cleanup();}
});
