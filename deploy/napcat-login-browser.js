import {K as http,C as crypto} from './@NATIVE_INDEX@';
import {Q as QQ} from './@QQ_MANAGER@';

const button=document.createElement('button');
button.textContent='自动登录';
button.style.cssText='position:fixed;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:9999;padding:9px 14px;border:1px solid #dbc9e3;border-radius:12px;background:#fff5fd;color:#513353;font:14px system-ui';
const dialog=document.createElement('dialog');
dialog.style.cssText='box-sizing:border-box;width:min(420px,calc(100vw - 28px));max-height:calc(100dvh - 32px);overflow:auto;padding:24px;border:1px solid #dbc9e3;border-radius:16px;background:#fff9fe;color:#38283c;font:16px system-ui';
dialog.innerHTML='<form><h3>记住自动登录</h3><p class="state"></p><p>缓存登录失效时，使用保存的密码重新登录。当前会话不会退出。</p><label>QQ 账号<input class="uin" name="username" autocomplete="username" inputmode="numeric" readonly></label><label>密码<input class="password" name="password" type="password" autocomplete="current-password" required></label><p style="font-size:13px">仅保存在这台服务器的 QQ 独立账户中。</p><p class="result" role="status"></p><div style="display:flex;gap:12px"><button type="submit">保存</button><button class="forget" type="button">删除保存的密码</button><button class="close" type="button">关闭</button></div></form>';
for(const input of dialog.querySelectorAll('input'))input.style.cssText='display:block;width:100%;padding:10px;margin:7px 0 15px;border:1px solid #d9cbdc;border-radius:8px;font-size:16px';
document.body.append(button,dialog);
const result=dialog.querySelector('.result'),password=dialog.querySelector('.password');
async function state(){
  const s=(await http.post('/QQLogin/FishLoginStatus',{})).data.data;
  const info=await QQ.getQQLoginInfo();
  dialog.querySelector('.uin').value=String(info?.uin||s.uin||'');
  dialog.querySelector('.state').textContent=s.saved?'已保存密码回退；成功登录后的密码也会自动更新。':'尚未保存密码回退。密码登录成功后会自动记住；已在线时也可在这里补存。';
}
button.onclick=async()=>{result.textContent='';password.value='';dialog.showModal();try{await state();}catch{result.textContent='请先在此页面完成登录。';}};
dialog.querySelector('.close').onclick=()=>{password.value='';dialog.close();};
dialog.addEventListener('close',()=>{password.value='';});
dialog.querySelector('form').onsubmit=async event=>{
  event.preventDefault();result.textContent='正在保存…';
  try{
    const md5=crypto.MD5(password.value).toString();password.value='';
    await http.post('/QQLogin/FishRememberLogin',{uin:dialog.querySelector('.uin').value,passwordMd5:md5});
    result.textContent='已保存，当前登录保持。';await state();
  }catch{result.textContent='保存未完成，请确认当前 QQ 账号已在线。';}
};
dialog.querySelector('.forget').onclick=async()=>{try{await http.post('/QQLogin/FishForgetLogin',{});password.value='';await state();result.textContent='已删除密码回退，当前登录保持。';}catch{result.textContent='删除未完成。';}};
