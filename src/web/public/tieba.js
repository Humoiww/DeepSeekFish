'use strict';
(()=>{
 const dialog=$('tieba-dialog'),screen=$('tieba-frame');let frameUrl,working=false,drag,frameSerial=0,screenMode='login',currentStatus,lastAttempt,refreshing=false,shownRequest,announced='',pendingOpen=false,verified='';
 const labels={unconfigured:'未配置账号环境',needs_check:'已保存浏览器资料，等待实际验证',waiting_login:'等待你手动登录',logged_in:'已登录（服务端已确认身份）',expired:'登录已失效，需要重新登录',check_failed:'最近一次检查失败；未据此判定会话失效'};
 async function call(path,value){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),path.endsWith('submit')||path.endsWith('input')?65000:path.endsWith('start')?35000:10000);
  try{const r=await fetch('/api/'+path,{method:value===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value),signal:controller.signal});const data=await r.json();if(!r.ok)throw Error(data.error||'REQUEST_FAILED');return data;}
  catch(e){if(e.name==='AbortError')throw Error('等待超时。发布结果可能尚未返回，请刷新状态或只读检查结果，勿重复提交。');throw e;}finally{clearTimeout(timer);}
 }
 function render(s){
  currentStatus=s;
  const lines=[labels[s.state]||s.state];
  if(s.identity)lines.push('当前账号：'+s.identity.name+' · UID '+s.identity.id);
  else if(s.lastIdentity)lines.push('上次确认的账号：'+s.lastIdentity.name+'（当前未确认）');
  if(s.verifiedAt)lines.push('最近验证：'+new Date(s.verifiedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'}));
  if(s.lastError?.code==='TIEBA_WORKER_UNAVAILABLE')lines.push('无法连接隔离服务，浏览器和资料状态暂时无法确认');else lines.push('浏览器：'+(s.browserRunning?'运行中':'已关闭')+'；资料：'+(s.profileSaved?'已保存':'未保存'));
  if(s.loginPage)lines.push('官方页面：'+s.loginPage.title+' · '+s.loginPage.origin+(s.loginPage.blocked?' · 页面暂不可用':s.loginPage.challenge?' · 需要手动完成验证':''));
  if(s.lastError)lines.push('最近错误：'+s.lastError.code+' · '+s.lastError.stage);
  if(s.publication?.needsHuman)lines.push('这次请求收到贴吧安全验证（'+s.publication.error+'）。已登录不代表发言验证已通过。'+(s.publication.detectedAt?'\n触发时间：'+new Date(s.publication.detectedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'}):''));
  $('tieba-status').textContent=lines.join('\n');$('tieba-status').style.whiteSpace='pre-wrap';
  screenMode=s.interaction==='publication'?'publication':'login';
  $('tieba-login').hidden=!(s.browserRunning&&(s.state==='waiting_login'||s.interaction==='publication'));
  $('tieba-start').disabled=s.interaction==='publication';$('tieba-check').disabled=s.interaction==='publication';
  $('tieba-login-actions').hidden=s.interaction==='publication';$('tieba-login-description').hidden=s.interaction==='publication';
  const w=s.publicationWork,stage=w?.stage,stageLabels={preparing:'正在处理这次发言请求',prepared:'原回复已填入官网，尚未提交',started:'提交已开始，等待真实回执',challenge:'官网要求验证，请在下方画面手动完成',accepted:'已获得回执，等待公开确认',confirmed:'已从公开视角确认',rejected:'这次请求未发出或被拒绝，详情见实际回执',unknown:'回执不确定，仅可检查结果，不自动重发'};
  $('tieba-publication').hidden=!(s.publication?.needsHuman||w);
  $('tieba-publication-state').textContent=(stageLabels[stage]||'这次请求需要官网验证，可在下方操作。')+(w?.result?.receipt?.errorMessage?'\n平台提示：'+w.result.receipt.errorMessage:'');
  $('tieba-publication-preview').textContent=w?(w.input.action==='thread'?'新主题 '+w.input.title:'帖子 '+w.input.threadId)+'\n'+w.input.content:'';
  $('tieba-publication-submit').hidden=stage!=='prepared'||s.interaction!=='publication';
  $('tieba-publication-check').hidden=!w||stage==='prepared';
  $('tieba-publication-start').disabled=!!w&&['started','accepted','unknown'].includes(stage);
  $('tieba-publication-start').hidden=stage==='confirmed';
  const a=lastAttempt&&(lastAttempt.requestId===w?.requestId||lastAttempt.startedAt>=(w?.created||0))?lastAttempt:null,matched=a?.requestId===w?.requestId,result=matched&&w?.result?w.result:a?.result||w?.result,request=a?.request||w?.input;
  if(shownRequest&&shownRequest!==w?.requestId){shownRequest=undefined;frameSerial++;screen.hidden=true;screen.removeAttribute('src');if(frameUrl){URL.revokeObjectURL(frameUrl);frameUrl=undefined;}}
  const blocked=result?.error&&!(result.error==='TIEBA_PUBLICATION_NEEDS_HUMAN'&&!s.publication?.needsHuman)||s.publication?.needsHuman&&stage==='challenge';
  $('tieba-attention').hidden=!blocked;
  $('tieba-alert').hidden=!blocked;
  const issue=result?.issue,detail=issue?'参数 '+issue.field+'：'+issue.reason:result?.receipt?.errorMessage||result?.error||'贴吧要求安全验证';
  $('tieba-alert-text').textContent='肥鱼的贴吧发言需要处理：'+detail;
  $('tieba-attempt').hidden=!a&&!w;
  $('tieba-attempt-detail').textContent=[request?.threadId?'帖子 '+request.threadId:request?.title?'新主题 '+request.title:'',result?.stage==='input_validation'?'本地参数校验未通过，请求没有发往贴吧':result?.stage==='running'?'正在处理这次请求':result?.published?'已确认公开可见':result?.deliveryStatus==='accepted'?'贴吧已接收，正在核对公开结果':detail,request?.content||'',a?.requestId||w?.requestId||''].filter(Boolean).join('\n');
  if(blocked){
   const key=(a?.requestId||w?.requestId||'')+':'+detail+':'+(w?.result?.receipt?.httpAttempts||0);
   if(key!==announced){announced=key;pendingOpen=true;}
  }else pendingOpen=false;
 }
 async function status(){const s=await call('tieba');render(s);return s;}
 async function frame(){
  const serial=++frameSerial,previous=frameUrl;
  const requestId=currentStatus?.interaction==='publication'?currentStatus.publicationWork?.requestId:undefined;
  $('tieba-frame-state').textContent='正在读取当前官网画面…';
  const r=await fetch(requestId?'/api/tieba/publication-frame?requestId='+encodeURIComponent(requestId):'/api/tieba/frame',{cache:'no-store',headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
  if(!r.ok){const e=await r.json();$('tieba-frame-state').textContent='当前画面未读到：'+(e.error||'请求失败')+'，正在等待状态更新。';throw Error(e.error);}
  const blob=await r.blob();if(!blob.size||!blob.type.startsWith('image/'))throw Error('TIEBA_FRAME_INVALID');
  const next=URL.createObjectURL(blob),preview=new Image();preview.src=next;
  try{await preview.decode();}catch{URL.revokeObjectURL(next);$('tieba-frame-state').textContent='登录画面无法显示，请刷新页面。';throw Error('TIEBA_FRAME_DECODE_FAILED');}
  if(serial!==frameSerial||!dialog.open||requestId&&requestId!==currentStatus?.publicationWork?.requestId){URL.revokeObjectURL(next);return;}
  screen.src=next;screen.hidden=false;frameUrl=next;
  $('tieba-frame-state').textContent=screenMode==='publication'?'这是当前官网画面，可直接点击、拖动完成验证。画面会自动更新。':'扫码或点击画面登录。画面会自动更新。';
  if(requestId&&shownRequest!==requestId){shownRequest=requestId;$('tieba-login').scrollIntoView({block:'start'});}
  if(previous)URL.revokeObjectURL(previous);
 }
 async function task(work,label='正在读取，请稍候…'){if(working){$('tieba-operation').textContent='上一项操作仍在等待反馈，可关闭窗口；不会重复提交。';return;}working=true;$('tieba-error').textContent='';$('tieba-operation').textContent=label;dialog.setAttribute('aria-busy','true');try{await work();}catch(e){$('tieba-error').textContent='操作未完成：'+e.message;await status().catch(()=>{});}finally{working=false;$('tieba-operation').textContent='';dialog.removeAttribute('aria-busy');}}
 const input=v=>task(async()=>{const s=await call('tieba/input',v);render(s);if(s.browserRunning)await frame();},'正在处理点击；如果点击了发布，正在等待官网回执…');
 function open(){pendingOpen=false;closeDrawers(false);if(!dialog.open)dialog.showModal();void task(async()=>{const s=await status();if(s.browserRunning&&(s.state==='waiting_login'||s.interaction==='publication'))await frame();});}
 function maybeOpen(){if(!pendingOpen||document.hidden||document.querySelector('dialog[open]')&&!dialog.open)return;if(!dialog.open)open();else pendingOpen=false;}
 $('tieba-button').onclick=open;$('tieba-alert-open').onclick=open;
 $('tieba-start').onclick=()=>task(async()=>{render(await call('tieba/start',{}));await frame();},'正在打开官方登录页面…');
 $('tieba-account-refresh').onclick=()=>task(async()=>{const a=await api('tieba/account',{});$('tieba-following').textContent=a.account.name+' · UID '+a.account.id+'\n'+a.following.map(f=>f.name+'吧 · '+f.id).join('\n');$('tieba-posting-policy').textContent=(a.posting.needsHuman?'上次请求收到贴吧验证要求；不阻止新的独立请求。\n':'')+(a.posting.mode==='preview'?'预演模式：只保存，不真实发布；仅已关注的贴吧允许准备发言。':a.posting.mode==='live'?'仅已关注的贴吧允许真实发言；其他贴吧只读。':'发言配置不可读，当前不能发帖。');});
 $('tieba-actions-refresh').onclick=()=>task(async()=>{$('tieba-actions').textContent=JSON.stringify(await api('tieba/actions'),null,2);});
 $('tieba-check').onclick=()=>task(async()=>{const s=await api('tieba/check',{});render(s);if(s.browserRunning&&s.state==='waiting_login')await frame();});
 for(const [id,action,label] of [['start','publication-start','正在打开官网并填入原回复，尚未发布…'],['submit','publication-submit','正在提交原回复并等待官网反馈…'],['check','publication-check','正在只读核对公开发布结果…']])$('tieba-publication-'+id).onclick=()=>task(async()=>{const s=await call('tieba/'+action,{});render(s);if(s.browserRunning&&s.interaction==='publication')await frame();},label);
 $('tieba-status-refresh').onclick=()=>task(status);$('tieba-frame-refresh').onclick=()=>task(frame);
 $('tieba-logout').onclick=()=>task(async()=>{render(await api('tieba/logout',{}));screen.removeAttribute('src');if(frameUrl){URL.revokeObjectURL(frameUrl);frameUrl=undefined;}});
 $('tieba-dismiss').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{frameSerial++;screen.hidden=true;if(frameUrl){URL.revokeObjectURL(frameUrl);frameUrl=undefined;}screen.removeAttribute('src');$('tieba-text').value='';if(currentStatus?.interaction!=='publication')void api('tieba/close',{}).catch(()=>{});});
 window.addEventListener('fish-tieba-status',event=>{
  lastAttempt=event.detail.attempt;if(!event.detail.status)return;render(event.detail.status);maybeOpen();void live();
 });
 document.addEventListener('close',()=>{queueMicrotask(maybeOpen);},true);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){maybeOpen();if(dialog.open)void live();}});
 async function live(){
  if(!dialog.open||document.hidden||working||drag||refreshing)return;refreshing=true;
  try{
   let s=currentStatus,w=s?.publicationWork;
   // Late native captcha success only needs one read-only reconciliation.
   const key=w?.requestId+':'+w?.result?.id;
   if(w?.stage==='accepted'&&w.result?.id&&verified!==key){verified=key;s=await call('tieba/publication-check',{});render(s);}
   if(s?.browserRunning&&(s.state==='waiting_login'||s.interaction==='publication'))await frame();
  }catch(e){$('tieba-frame-state').textContent='等待当前窗口更新：'+e.message;}
  finally{refreshing=false;}
 }
 for(const [id,key] of [['tab','Tab'],['enter','Enter'],['backspace','Backspace'],['selectall','SelectAll']])$('tieba-'+id).onclick=()=>input({kind:'key',key});
 $('tieba-scroll-up').onclick=()=>input({kind:'scroll',delta:-500});$('tieba-scroll-down').onclick=()=>input({kind:'scroll',delta:500});
 $('tieba-input-form').onsubmit=e=>{e.preventDefault();const text=$('tieba-text').value;$('tieba-text').value='';if(text)void input({kind:'text',text});};
 function point(e){const r=screen.getBoundingClientRect();return {x:Math.max(0,Math.min(999,(e.clientX-r.left)*1000/r.width)),y:Math.max(0,Math.min(799,(e.clientY-r.top)*800/r.height))};}
 screen.onpointerdown=e=>{if(working)return;if(e.pointerType==='mouse')e.preventDefault();drag=point(e);screen.setPointerCapture(e.pointerId);};
 screen.onpointerup=e=>{if(!drag)return;e.preventDefault();const end=point(e),start=drag;drag=undefined;if(Math.hypot(end.x-start.x,end.y-start.y)>8)void input({kind:'drag',...start,toX:end.x,toY:end.y});else void input({kind:'click',...end});};
 screen.onpointercancel=()=>{drag=undefined;};
 $('tieba-read-form').onsubmit=e=>{e.preventDefault();void task(async()=>{let url=$('tieba-read-url').value.trim();if(!url)return;if(!/^https:\/\//.test(url))url='https://tieba.baidu.com/f?kw='+encodeURIComponent(url);const r=await api('tieba/read',{url,mode:$('tieba-read-mode').value});$('tieba-read-result').textContent=JSON.stringify(r,null,2);await status();});};
})();
