import readline from 'node:readline';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const lines=readline.createInterface({input:process.stdin});
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');

async function write(chunk){
  if(!process.stdout.write(chunk))await once(process.stdout,'drain');
}

async function sendPreviews(id){
  const block=Buffer.alloc(64*1024,0x41);
  for(let index=0;index<4;index++){
    await write('{"method":"preview","params":{"index":'+index+',"data":"');
    for(let bytes=0;bytes<18*1024*1024;bytes+=block.length)await write(block);
    await write('","label":"肥鱼预览"}}\n');
  }
  send({id,result:{ok:true}});
}

async function sendUnterminated(){
  const block=Buffer.from('鱼'.repeat(16*1024));
  await write('{"method":"overflow","params":"');
  for(let bytes=0;bytes<33*1024*1024;bytes+=block.length)await write(block);
}

lines.on('line',line=>{
  const msg=JSON.parse(line);
  if(msg.method==='initialize')send({id:msg.id,result:{ok:true}});
  else if(msg.method==='previews')void sendPreviews(msg.id);
  else if(msg.method==='unterminated')void sendUnterminated();
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
