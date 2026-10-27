import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { projectRoot,loadConfig } from '../dist/src/config.js';
const root=projectRoot(),port=loadConfig(root).port;
async function cycle(send){
  const proc=spawn(process.execPath,[root+'/dist/src/cli.js','start','--mock'],{cwd:root,stdio:['ignore','pipe','pipe']});
  const closed=once(proc,'close');let log='';
  proc.stdout.on('data',b=>{log+=b;});proc.stderr.on('data',b=>{log+=b;});
  const deadline=setTimeout(()=>proc.kill('SIGKILL'),8000);
  try{
    await new Promise((resolve,reject)=>{
      proc.stdout.on('data',()=>{if(log.includes('运行中'))resolve();});proc.once('exit',()=>reject(new Error('START_FAILED: '+log)));
    });
    const headers={authorization:'Bearer '+fs.readFileSync(root+'/runtime/data/admin-token','utf8').trim(),'content-type':'application/json'};
    const status=await fetch(`http://127.0.0.1:${port}/api/status`,{headers}).then(r=>r.json());
    if(status.mode!=='mock')throw new Error('NOT_MOCK');
    if(send){
      const res=await fetch(`http://127.0.0.1:${port}/api/mock-message`,{method:'POST',headers,body:JSON.stringify({text:'你好小鱼'})}).then(r=>r.json());
      if(!res.sent?.length)throw new Error('NO_REPLY');
    }
    await fetch(`http://127.0.0.1:${port}/api/stop`,{method:'POST',headers,body:'{}'});
    const [code]=await closed;if(code!==0)throw new Error('STOP_FAILED');return {start:true,status:true,message:!!send,stop:true};
  }finally{clearTimeout(deadline);if(proc.exitCode===null)proc.kill('SIGKILL');}
}
const result={first:await cycle(true),restart:await cycle(false),realApiCalls:0};
fs.writeFileSync(root+'/runtime/cli-smoke.json',JSON.stringify(result,null,2));console.log(result);
