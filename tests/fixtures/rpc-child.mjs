import readline from 'node:readline';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const lines=readline.createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
lines.on('line',line=>{
  const msg=JSON.parse(line);
  if(msg.method==='initialize')send({id:msg.id,result:{ok:true}});
  else if(msg.method==='spawn'){
    const child=spawn(process.execPath,['-e',"const fs=require('fs');setInterval(()=>fs.writeFileSync('heartbeat.txt',String(Date.now())),20)"],{stdio:'ignore'});
    send({id:msg.id,result:{pid:process.pid,child:child.pid}});
  }else if(msg.method==='hang'){} // actual process remains alive until killed
  else if(msg.method==='approval'){
    send({id:900,method:'item/commandExecution/requestApproval',params:{}});
    send({id:msg.id,result:{ok:true}});
  }else if(msg.id===900)send({method:'approvalResult',params:msg.result});
});
setInterval(()=>{},1000);
