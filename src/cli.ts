import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createApp } from './app.js';
import { projectRoot, prepare, loadConfig, loadSecrets } from './config.js';
import { safePath, writePrivate } from './paths.js';
import { FishError, codeOf } from './types.js';
import { adminServer } from './admin/server.js';
import { bind } from './qq/adapter.js';
import { codexEntry, childEnvironment } from './codex/runner.js';
import { boundaryStatus } from './codex/platform.js';
import { checkSandbox } from './codex/probe.js';
import { codexImageSmoke } from './image/codex-smoke.js';

const root=projectRoot();prepare(root);loadSecrets(root);
const [command='help',...args]=process.argv.slice(2);
function print(value:unknown):void{console.log(typeof value==='string'?value:JSON.stringify(value,null,2));}
async function api(route:string,value?:unknown,approval?:string):Promise<any>{
  const config=loadConfig(root),tokenPath=safePath(root,'runtime/data/admin-token');
  if(!fs.existsSync(tokenPath))throw new FishError('START_BOT_FIRST');
  const res=await fetch(`http://127.0.0.1:${config.port}/api/${route}`,{method:value===undefined?'GET':'POST',
    headers:{authorization:'Bearer '+fs.readFileSync(tokenPath,'utf8').trim(),'content-type':'application/json',...(approval?{'x-fish-local-approval':approval}:{})},
    body:value===undefined?undefined:JSON.stringify(value),signal:AbortSignal.timeout(15000)});
  const data=await res.json();if(!res.ok)throw new FishError(data.error??'LOCAL_API_ERROR');return data;
}
async function main():Promise<void>{
  if(command==='start'){
    const app=createApp(root,args.includes('--mock'));let closing=false;
    const stop=()=>{if(closing)return;closing=true;void (async()=>{await app.bot.stop();server.close();await once(server,'close');clearInterval(prune);app.store.close();})();};
    const server=adminServer(app,stop);
    server.listen(app.cfg().port,'127.0.0.1');await once(server,'listening');
    app.tasks.recover();
    app.store.prune(app.cfg().historyHours,app.cfg().windowSize);
    const prune=setInterval(()=>app.store.prune(app.cfg().historyHours,app.cfg().windowSize),60000);prune.unref();
    if('start' in app.transport)(app.transport as any).start();
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
    print(`DeepSeekFish ${app.mock?'Mock':'Live'} 运行中：http://127.0.0.1:${app.cfg().port}；Ctrl+C 停止。`);
    print('本机令牌位于 runtime/data/admin-token。真实 Codex 无人值守执行关闭。');
  }else if(command==='status')print(await api('status'));
  else if(command==='tasks')print(await api('tasks'));
  else if(command==='set'){
    if(args.length!==2)throw new FishError('USAGE_SET_KEY_JSON');let value:unknown;try{value=JSON.parse(args[1]);}catch{throw new FishError('VALUE_MUST_BE_JSON');}
    print(await api('set',{key:args[0],value}));
  }else if(command==='history')print(await api('history?group='+encodeURIComponent(args[0]??'')));
  else if(command==='clear')print(await api('clear',{group:args[0]}));
  else if(command==='cancel')print(await api('cancel',{id:args[0]}));
  else if(command==='approve'){
    if(!args.includes('--reviewed'))throw new FishError('READ_TASK_WITH_TASKS_THEN_APPROVE_ID_REVIEWED');
    print(await api('approve',{id:args[0],reviewed:true},args[0]));
  }else if(command==='stop')print(await api('stop',{}));
  else if(command==='say')print(await api('mock-message',{text:args.join(' ')}));
  else if(command==='bind')await bind(root);
  else if(command==='sandbox-check'){
    const result=await checkSandbox(root);print(result);if(!result.ok)process.exitCode=1;
  }
  else if(command==='codex-image'){
    const reviewed=args.includes('--reviewed'),prompt=args.filter(arg=>arg!=='--reviewed').join(' ');
    const result=await codexImageSmoke(root,prompt,reviewed);print(result);if(!result.ok)process.exitCode=1;
  }
  else if(command==='codex-login'){
    // A NEW project-owned login, initiated only by a local human command.
    if(args.some(a=>a!=='--device-auth'))throw new FishError('USAGE_CODEX_LOGIN_DEVICE_AUTH');
    if(!fs.existsSync(safePath(root,'runtime/codex-home/config.toml')))writePrivate(root,'runtime/codex-home/config.toml','cli_auth_credentials_store = "file"\n');
    const proc=spawn(process.execPath,[codexEntry(root),'-c','cli_auth_credentials_store="file"','login',...args],{cwd:safePath(root,'runtime/workspace'),env:childEnvironment(root),stdio:'inherit',shell:false});
    const [exit]=await once(proc,'exit');if(exit!==0)throw new FishError('CODEX_LOGIN_FAILED');
  }else if(command==='doctor'){
    const versions:Record<string,string>={node:process.version};
    for(const name of ['@tencent-connect/qqbot-nodejs','@tencent-connect/qqbot-connector','@openai/codex','typescript']){
      const p=safePath(root,'node_modules/'+name+'/package.json');versions[name]=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')).version:'missing';
    }
    print({versions,platform:process.platform,root,qqConfigured:fs.existsSync(safePath(root,'runtime/data/qq-credentials.json'))||!!process.env.QQBOT_APPID,
      deepseekKeyPresent:!!process.env.DEEPSEEK_API_KEY,codexProjectLogin:fs.existsSync(safePath(root,'runtime/codex-home/auth.json')),
      unattendedCodex:false,codexBoundary:boundaryStatus(root),
      externalRuntimeWrites:'none requested by application; Node runtime itself is supplied externally read-only'});
  }else if(command==='demo'){
    const app=createApp(root,true,{codex:true,search:true,images:true},true);app.tasks.recover();
    const m={id:randomUUID(),group:app.cfg().groups[0],user:app.cfg().admins[0],at:Date.now(),mentioned:true,event:'mention' as const,text:'你好小鱼'};
    await app.bot.receive(m);await app.bot.flush();
    await app.bot.receive({...m,id:randomUUID(),text:'/fish codex 创建一个 hello 文件'});
    const task=app.tasks.list().find(t=>t.state==='waiting');if(!task)throw new FishError('DEMO_TASK_MISSING');
    app.tasks.approve(task.id);await app.tasks.idle();
    await app.bot.receive({...m,id:randomUUID(),text:'/fish search DeepSeek'});
    await app.bot.receive({...m,id:randomUUID(),text:'/fish image 测试图片'});
    print({messages:(app.transport as any).sent,files:(app.transport as any).files,task:app.tasks.get(task.id),budget:app.ledger.snapshot()});
    await app.bot.stop();app.store.close();
  }else print(`DeepSeekFish\n  npm run build / npm test\n  npm run mock / npm start / npm run demo\n  npm run cli -- status|tasks|history GROUP|clear GROUP|cancel ID|stop\n  npm run cli -- set autonomous false\n  npm run cli -- approve ID --reviewed\n  npm run cli -- say "你好小鱼"  (Mock only)\n  npm run bind / npm run cli -- codex-login [--device-auth]\n  npm run doctor / npm run cli -- sandbox-check (keyless, no model turn)\n  npm run cli -- codex-image --reviewed "one-image prompt" (real Codex subscription smoke test)`);
}
main().catch(e=>{console.error('DeepSeekFish: '+codeOf(e));process.exitCode=1;});
