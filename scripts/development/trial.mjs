import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const root=process.cwd(),input=JSON.parse(fs.readFileSync(0,'utf8'));
const modulePath=name=>pathToFileURL(path.join(root,'dist/src',name)).href;
const signal=AbortSignal.timeout(25000);

if(input.entry==='web'){
  const {createWebApp}=await import(modulePath('web/app.js'));
  const app=createWebApp(root,true);
  const events=[];
  try{
    const s=app.createSession();
    await app.chat(s.id,input.text,input.mode==='agent'?'agent':'chat',signal,event=>events.push(event));
    console.log('FISH_TRIAL '+JSON.stringify({events}));
  }finally{await app.close();}
}else if(input.entry==='qq'){
  const {createApp}=await import(modulePath('app.js'));
  const {normalizeOneBot}=await import(modulePath('qq/onebot.js'));
  const user='100001',self='100002';
  const app=createApp(root,true,{qqTransport:'onebot',privateUsers:[user],groups:[],enabled:true,search:true,bufferMs:0});
  if(Array.isArray(input.turns)){
    const queue=[...input.turns];
    app.model.provider.complete=async()=>{
      const next=queue.shift()??{reply:'已结束这次试用。'};
      const calls=next.tool?[{name:next.tool,args:next.args??{}}]:[{name:'reply',args:{text:String(next.reply??'')}}];
      return {text:'',usage:{input:100,output:30},tool_calls:calls.map(call=>({id:randomUUID(),type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}))};
    };
  }
  try{
    const inbound=normalizeOneBot({post_type:'message',message_type:'private',self_id:self,user_id:user,sender:{user_id:user},time:Math.floor(Date.now()/1000),message_id:'1234',message:[{type:'text',data:{text:input.text}}]},self);
    await app.bot.receive(inbound);await app.bot.flush();
    const folder=path.join(root,'runtime/logs/qq');
    const logs=fs.existsSync(folder)?fs.readdirSync(folder).filter(f=>f.endsWith('.json')):[];
    const trace=logs.map(file=>JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'))).filter(t=>t.messageId==='1234').at(-1)?.trace
      ?.flatMap(e=>e.tool?[{tool:e.tool,result:e.result}]:e.error?[{error:e.error}]:[])??[];
    console.log('FISH_TRIAL '+JSON.stringify({sent:app.transport.sent,trace}));
  }finally{await app.bot.stop();app.store.close();}
}else throw Error('Unknown trial entry.');
