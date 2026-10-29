import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createLoginMemory(root,env=process.env){
  const file=path.join(root,'login-secrets.json');
  const preferences=new Map();
  let api,saveAccount,busy=0,humanRequired=false,failed=false,nextAttempt=0,timer;
  const valid=(uin,md5)=>typeof uin==='string'&&/^[1-9]\d{4,19}$/.test(uin)&&typeof md5==='string'&&/^[a-f0-9]{32}$/i.test(md5);
  function read(){
    let fd;try{
      fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const st=fs.fstatSync(fd);
      if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o077)||st.size>2048)throw Error('LOGIN_SECRET_PERMISSIONS');
      const d=JSON.parse(fs.readFileSync(fd,'utf8'));if(!valid(d.uin,d.passwordMd5))throw Error('LOGIN_SECRET_INVALID');return d;
    }catch(e){if(e.code==='ENOENT')return null;throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function load(){
    const d=read();
    if(d){env.NAPCAT_QUICK_ACCOUNT=d.uin;env.NAPCAT_QUICK_PASSWORD_MD5=d.passwordMd5;env.FISH_NAPCAT_LOGIN_SOURCE='file';}
    else if(env.FISH_NAPCAT_LOGIN_SOURCE==='file'){delete env.NAPCAT_QUICK_ACCOUNT;delete env.NAPCAT_QUICK_PASSWORD_MD5;delete env.FISH_NAPCAT_LOGIN_SOURCE;}
    return d;
  }
  async function save(uin,passwordMd5,verified=true){
    uin=String(uin);if(!valid(uin,passwordMd5))throw Error('LOGIN_CREDENTIAL_INVALID');
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeFileSync(fd,JSON.stringify({uin,passwordMd5:passwordMd5.toLowerCase(),verified,updatedAt:Date.now()})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
    humanRequired=false;failed=false;nextAttempt=0;load();await saveAccount?.(uin);
  }
  function status(){
    const d=read();return {uin:d?.uin||api?.getQQLoginUin?.()||'',saved:!!d,verified:d?.verified===true,humanRequired,paused:failed,
      online:api?.getQQLoginStatus?.()===true,nextAttempt:nextAttempt||null};
  }
  function wrap(fn){
    return async(uin,passwordMd5,...rest)=>{
      const remember=preferences.get(String(uin))!==false;
      busy++;try{
        const result=await fn(uin,passwordMd5,...rest);
        if(result?.result===true){
          if(remember)await save(String(uin),passwordMd5,true);
          else if(read()?.uin===String(uin))forget();
          humanRequired=false;failed=false;nextAttempt=0;
          preferences.delete(String(uin));
        }
        else if(result?.needCaptcha||result?.needNewDevice){humanRequired=true;}
        else {failed=true;}
        return result;
      }finally{busy--;}
    };
  }
  function guard(fn){return async(...args)=>{busy++;try{return await fn(...args);}finally{busy--;}};}
  async function recover(now=Date.now()){
    if(!api||busy||humanRequired||failed||now<nextAttempt||!read())return;
    const online=api.getQQLoginStatus()===true||api.getOneBotContext?.()?.core?.selfInfo?.online===true,phase=api.getQQLoginPhase?.();
    if(online||phase==='reconnecting'||phase==='logging_in')return;
    nextAttempt=now+300000;
    try{load();await api.runWebUiConfigQuickFunction();}catch{failed=true;}
  }
  function attach(value,persistAccount){
    api=value;saveAccount=persistAccount;
    if(!timer){timer=setInterval(()=>void recover().catch(()=>{failed=true;}),30000);timer.unref();}
  }
  function forget(){
    fs.rmSync(file,{force:true});
    if(env.FISH_NAPCAT_LOGIN_SOURCE==='file'){delete env.NAPCAT_QUICK_PASSWORD_MD5;delete env.NAPCAT_QUICK_ACCOUNT;delete env.FISH_NAPCAT_LOGIN_SOURCE;}
    humanRequired=false;failed=false;
  }
  load();
  return {save,status,wrap,guard,attach,recover,forget,choose(uin,enabled){preferences.set(String(uin),enabled===true);},close(){clearInterval(timer);}};
}
export const fishLogin=createLoginMemory(process.env.NAPCAT_WORKDIR||process.cwd());
