'use strict';
(()=>{
 const dialog=$('tieba-dialog'),screen=$('tieba-frame');let frameUrl,working=false,drag,frameSerial=0;
 const labels={unconfigured:'未配置账号环境',needs_check:'已保存浏览器资料，等待实际验证',waiting_login:'等待你手动登录',logged_in:'已登录（服务端已确认身份）',expired:'登录已失效，需要重新登录',check_failed:'最近一次检查失败；未据此判定会话失效'};
 function render(s){
  const lines=[labels[s.state]||s.state];
  if(s.identity)lines.push('当前账号：'+s.identity.name+' · UID '+s.identity.id);
  else if(s.lastIdentity)lines.push('上次确认的账号：'+s.lastIdentity.name+'（当前未确认）');
  if(s.verifiedAt)lines.push('最近验证：'+new Date(s.verifiedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'}));
  if(s.lastError?.code==='TIEBA_WORKER_UNAVAILABLE')lines.push('无法连接隔离服务，浏览器和资料状态暂时无法确认');else lines.push('浏览器：'+(s.browserRunning?'运行中':'已关闭')+'；资料：'+(s.profileSaved?'已保存':'未保存'));
  if(s.loginPage)lines.push('官方页面：'+s.loginPage.title+' · '+s.loginPage.origin+(s.loginPage.blocked?' · 页面暂不可用':s.loginPage.challenge?' · 需要手动完成验证':''));
  if(s.lastError)lines.push('最近错误：'+s.lastError.code+' · '+s.lastError.stage);
  if(s.publication?.needsHuman)lines.push('发言已暂停：贴吧要求人工安全验证（'+s.publication.error+'）。已登录不代表发言验证已通过。'+(s.publication.detectedAt?'\n触发时间：'+new Date(s.publication.detectedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'}):''));
  $('tieba-status').textContent=lines.join('\n');$('tieba-status').style.whiteSpace='pre-wrap';
  $('tieba-login').hidden=!(s.browserRunning&&s.state==='waiting_login');
 }
 async function status(){const s=await api('tieba');render(s);return s;}
 async function frame(){
  const serial=++frameSerial,previous=frameUrl;
  $('tieba-frame-state').textContent='正在加载官方登录画面…';
  const r=await fetch('/api/tieba/frame',{cache:'no-store',headers:{authorization:'Bearer '+token}});
  if(!r.ok){const e=await r.json();$('tieba-frame-state').textContent='画面未加载：'+(e.error||'请求失败')+'。请重新打开登录。';throw Error(e.error);}
  const blob=await r.blob();if(!blob.size||!blob.type.startsWith('image/'))throw Error('TIEBA_FRAME_INVALID');
  const next=URL.createObjectURL(blob),preview=new Image();preview.src=next;
  try{await preview.decode();}catch{URL.revokeObjectURL(next);$('tieba-frame-state').textContent='登录画面无法显示，请刷新页面。';throw Error('TIEBA_FRAME_DECODE_FAILED');}
  if(serial!==frameSerial||!dialog.open){URL.revokeObjectURL(next);return;}
  screen.src=next;screen.hidden=false;frameUrl=next;
  $('tieba-frame-state').textContent='扫码或点击画面登录；画面没有变化时点「刷新画面」。';
  if(previous)URL.revokeObjectURL(previous);
 }
 async function task(work){if(working)return;working=true;$('tieba-error').textContent='';try{await work();}catch(e){$('tieba-error').textContent='操作未完成：'+e.message;await status().catch(()=>{});}finally{working=false;}}
 const input=v=>task(async()=>{await api('tieba/input',v);await frame();});
 $('tieba-button').onclick=()=>{closeDrawers(false);dialog.showModal();void task(async()=>{const s=await status();if(s.browserRunning&&s.state==='waiting_login')await frame();});};
 $('tieba-start').onclick=()=>task(async()=>{render(await api('tieba/start',{}));await frame();});
 $('tieba-account-refresh').onclick=()=>task(async()=>{const a=await api('tieba/account',{});$('tieba-following').textContent=a.account.name+' · UID '+a.account.id+'\n'+a.following.map(f=>f.name+'吧 · '+f.id).join('\n');$('tieba-posting-policy').textContent=(a.posting.needsHuman?'发言已暂停：贴吧要求人工安全验证。已登录不代表发言验证已通过。\n':'')+(a.posting.mode==='preview'?'预演模式：只保存，不真实发布；仅已关注的贴吧允许准备发言。':a.posting.mode==='live'?'仅已关注的贴吧允许真实发言；其他贴吧只读。':'发言配置不可读，当前不能发帖。');});
 $('tieba-actions-refresh').onclick=()=>task(async()=>{$('tieba-actions').textContent=JSON.stringify(await api('tieba/actions'),null,2);});
 $('tieba-check').onclick=()=>task(async()=>{const s=await api('tieba/check',{});render(s);if(s.browserRunning&&s.state==='waiting_login')await frame();});
 $('tieba-status-refresh').onclick=()=>task(status);$('tieba-frame-refresh').onclick=()=>task(frame);
 $('tieba-logout').onclick=()=>task(async()=>{render(await api('tieba/logout',{}));screen.removeAttribute('src');if(frameUrl){URL.revokeObjectURL(frameUrl);frameUrl=undefined;}});
 $('tieba-dismiss').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{frameSerial++;screen.hidden=true;if(frameUrl){URL.revokeObjectURL(frameUrl);frameUrl=undefined;}screen.removeAttribute('src');$('tieba-text').value='';void api('tieba/close',{}).catch(()=>{});});
 for(const [id,key] of [['tab','Tab'],['enter','Enter'],['backspace','Backspace'],['selectall','SelectAll']])$('tieba-'+id).onclick=()=>input({kind:'key',key});
 $('tieba-scroll-up').onclick=()=>input({kind:'scroll',delta:-500});$('tieba-scroll-down').onclick=()=>input({kind:'scroll',delta:500});
 $('tieba-input-form').onsubmit=e=>{e.preventDefault();const text=$('tieba-text').value;$('tieba-text').value='';if(text)void input({kind:'text',text});};
 function point(e){const r=screen.getBoundingClientRect();return {x:Math.max(0,Math.min(999,(e.clientX-r.left)*1000/r.width)),y:Math.max(0,Math.min(799,(e.clientY-r.top)*800/r.height))};}
 screen.onpointerdown=e=>{if(working)return;e.preventDefault();drag=point(e);screen.setPointerCapture(e.pointerId);};
 screen.onpointerup=e=>{if(!drag)return;e.preventDefault();const end=point(e),start=drag;drag=undefined;if(Math.hypot(end.x-start.x,end.y-start.y)>8)void input({kind:'drag',...start,toX:end.x,toY:end.y});else void input({kind:'click',...end});};
 screen.onpointercancel=()=>{drag=undefined;};
 $('tieba-read-form').onsubmit=e=>{e.preventDefault();void task(async()=>{let url=$('tieba-read-url').value.trim();if(!url)return;if(!/^https:\/\//.test(url))url='https://tieba.baidu.com/f?kw='+encodeURIComponent(url);const r=await api('tieba/read',{url,mode:$('tieba-read-mode').value});$('tieba-read-result').textContent=JSON.stringify(r,null,2);await status();});};
})();
