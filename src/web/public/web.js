'use strict';
const $=id=>document.getElementById(id);
const imageUrls=new Set();let pendingImageConfirmation=null,confirmedImageRequest=null;
let token=sessionStorage.getItem('fish-token')||'',state,currentId=null,mode='chat',busy=false,abortController,tailnetOwner=false;
const errors={CODEX_IMAGE_ONLY:'当前服务器仅启用 Codex 生图，不提供普通执行任务。',CODEX_QUOTA_UNKNOWN:'暂时无法读取 Codex 额度，自动生图已暂停，请刷新额度。',CODEX_QUOTA_LOW:'Codex 剩余额度低于 10% 或账号已受限，已暂停生图。',CODEX_QUOTA_CONFIRM_REQUIRED:'Codex 剩余额度在 10%～30%，需要逐张确认。',CODEX_RATE_LIMITED:'Codex 已限流，暂停生图，等待重试时间及官方确认恢复。',IMAGE_RESET_BUSY_OR_UNCERTAIN:'存在运行中或用量未确认的任务，暂时不能重置本地计数。',IMAGE_BUDGET_EXHAUSTED:'今天的本地生图额度已用完；可等待明天，或使用右侧 Reset 本地计数。',CODEX_BUDGET_EXHAUSTED:'今天的 Codex 任务额度已用完。',CODEX_TIME_BUDGET:'今天的 Codex 时长额度不足。',CODEX_BUSY:'已有 Codex 任务正在运行，请完成后再试。',CODEX_PROJECT_LOGIN_REQUIRED:'请在项目终端运行 bash scripts/manage.sh codex-login --device-auth（Windows：npm run cli -- codex-login --device-auth）后重试。',CHARACTER_REFERENCE_MISSING:'缺少鲸酱设定图，请恢复仓库中的 assets/character/whalechan-reference.png，或将自定义图放到 runtime/character/whalechan-reference.png。',CHARACTER_REFERENCE_NOT_USED:'Codex 没有确认使用设定图，未发布图片。',IMAGE_PLAN_REQUIRED:'模型未返回有效画面方案，未开始生图。',INVALID_IMAGE_PLAN:'画面方案格式不正确，未开始生图。',CODEX_IMAGE_CANCELLED_OR_TIMED_OUT:'生图已取消或超时，已发生的调用仍计入额度。',CODEX_IMAGE_UNSUPPORTED_OR_MISSING:'未收到 Codex 原生生图结果，未发布图片。',ARTIFACT_CHANGED:'图片文件发生变化，已停止提供该文件。',DEEPSEEK_KEY_MISSING:'请先在「连接与设置」中保存 DeepSeek API Key。',LOCAL_AUTH_REQUIRED:'本机连接已失效，请重新输入令牌。',DEEPSEEK_HTTP_401:'API Key 无效，请检查连接设置。',DEEPSEEK_HTTP_402:'DeepSeek 账户余额不足。',DEEPSEEK_HTTP_429:'DeepSeek 请求过于频繁，请稍后重试。',DEEPSEEK_HTTP_400:'模型或请求参数不受支持，请检查模型设置。',TOKEN_BUDGET_EXHAUSTED:'当前会话、每日额度或单用户请求次数已到上限。',BUDGET_USAGE_FAULT:'用量与预留不一致，后续调用已停止，请在本机检查预算。',CHAT_CANCELLED:'本次请求已停止。已发生的调用或文件写入会保留。',CHAT_BUSY:'此会话正在处理消息，请稍后再发。',CONVERSATION_LIMIT_CREATE_NEW:'当前会话已满，请开启新的对话。',TOOL_LIMIT_OR_DISABLED:'本次工具调用达到上限，或当前模式不允许工具。',BOOTSTRAP_EXPIRED:'自动连接链接已使用或过期，请输入本机令牌。'};
const explain=e=>errors[e]||'操作未完成：'+e;
const node=(tag,className,text)=>{const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=text;return n;};
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,5000);}
async function api(path,value){
  const r=await fetch('/api/'+path,{method:value===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value)});
  const data=await r.json();if(!r.ok){if(r.status===401&&!tailnetOwner&&!$('auth-dialog').open)$('auth-dialog').showModal();throw Error(data.error||'REQUEST_FAILED');}return data;
}
function setMode(next){mode=next;for(const key of ['chat','agent','image']){const button=$('mode-'+key);button.classList.toggle('selected',next===key);button.setAttribute('aria-pressed',String(next===key));}$('mode-label').textContent=({chat:'聊天',agent:'受限助手',image:'画图'})[next];$('mode-note').textContent=next==='image'?'发送即授权本次一张：DeepSeek 设计 → Codex 生图，可随时停止。':next==='agent'?'可操作会话文件；明确画图请求会自动进入单张生图流程。':'明确请求画图时，小鱼会设计方案并交给 Codex 生成一张。';}

function quotaTime(seconds){return Number.isFinite(seconds)?new Date(seconds*1000).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'未提供';}
function renderCodexQuota(q){
  const content=$('codex-quota-content');content.replaceChildren();if(!q){content.append(node('p','muted','等待服务端提供额度…'));return;}
  const all=q.pools.flatMap(p=>p.windows.map(w=>({...w,pool:p.name}))),weekly=all.filter(w=>w.windowDurationMins===10080);
  if(!weekly.length){const missing=node('div','quota-weekly');missing.append(node('span','','本周剩余额度'),node('strong','','—'),node('small','','接口尚未提供周窗口数据'));content.append(missing);}
  for(const w of [...weekly,...all.filter(w=>w.windowDurationMins!==10080)]){const weeklyWindow=w.windowDurationMins===10080,box=node('div',weeklyWindow?'quota-weekly':'quota-window');box.append(node('span','',weeklyWindow?'本周剩余额度 · '+w.pool:(w.windowDurationMins===null?'未知时长窗口':w.windowDurationMins<1440?w.windowDurationMins/60+' 小时窗口':w.windowDurationMins/1440+' 天窗口')+' · '+w.pool),node('strong','',Number(w.remainingPercent.toFixed(1))+'%'));const meter=node('div','meter'),bar=node('i');bar.style.width=w.remainingPercent+'%';meter.append(bar);box.append(meter,node('small','','重置：'+quotaTime(w.resetsAt)));content.append(box);}
  for(const p of q.pools)if(p.credits)content.append(node('p','quota-credits',p.name+' Credits：'+(p.credits.unlimited?'无限':p.credits.balance??(p.credits.hasCredits?'有额度，余额未提供':'未提供可用余额'))));
  const policy=node('p','quota-policy '+q.decision,({allow:'可以自动生图',confirm:'每张图片需要人工确认',pause:'自动生图已暂停'})[q.decision]||'等待额度');content.append(policy);
  if(q.error)content.append(node('small','quota-error',explain(q.error)));
  if(q.reason&&q.decision==='pause')content.append(node('small','quota-error',explain(q.reason)));
  if(q.retryAt)content.append(node('small','quota-error','最早重试：'+quotaTime(q.retryAt/1000)+'；仍需官方确认恢复。'));
  content.append(node('small','quota-updated',(q.mock?'离线示例 · ':q.loading?'刷新中 · ':'')+(q.updatedAt?'更新 '+quotaTime(q.updatedAt/1000):'尚无有效数据')+' · 每5分钟自动刷新'));
  content.append(node('small','quota-policy-note','>30% 自动 · 10%～30% 确认 · <10% 暂停'));
  const latest=q.recentUsage?.[0];if(latest)content.append(node('small','quota-observation',latest.changes.length?'最近一次窗口变化：'+latest.changes.map(c=>c.window+' +'+c.percentagePoints+' 个百分点').join('，')+'（可能包含其他调用）':'最近一次窗口消耗暂不可比较；不推算剩余张数。'));
}
function renderStatus(s){renderCodexQuota(s.codexQuota);$('reset-images').disabled=busy||s.active>0;
  state=s;$('image-quota').textContent=((s.budgets.usage.find(x=>x.metric==='image'&&x.scope==='*')?.value)||0)+' / '+s.imageLimits.daily;$('model-name').textContent=s.settings.model;$('connection').textContent=s.mock?'离线演示':s.credentialPresent?'API 已配置':'待配置';
  $('demo-banner').hidden=!s.mock;$('setup-banner').hidden=s.mock||s.credentialPresent;
  const count=s.budgets.usage.find(x=>x.metric==='tokens'&&x.scope==='*')?.value||0,limit=s.budgets.dailyTokens;
  $('budget-text').textContent=Math.round(count/limit*100)+'%';$('budget-detail').textContent=count.toLocaleString()+' / '+limit.toLocaleString()+' tokens';$('budget-bar').style.width=Math.min(100,count/limit*100)+'%';
  $('search-state').textContent=s.settings.search?'已允许':'未开启';$('search-dot').textContent=s.settings.search?'✓':'○';$('codex-state').textContent=s.settings.codexQueue?'仅排队':'未开启';$('codex-dot').textContent=s.settings.codexQueue?'✓':'○';
  const tasks=s.tasks.filter(t=>t.sessionId===currentId);$('task-count').textContent=String(tasks.length);$('tasks').replaceChildren();
  if(!tasks.length)$('tasks').append(node('p','muted','暂时没有待审任务'));
  for(const t of tasks){const card=node('div','task-card');card.append(node('strong','',t.request),node('small','',({waiting:'等待本机终端审核',running:'正在执行',succeeded:'已完成',cancelled:'已取消',failed:'未完成',timed_out:'已超时'})[t.state]||t.state));
    if(t.state==='waiting')card.append(node('code','','npm run cli -- web-approve '+t.id+' --reviewed'));
    if(t.result)card.append(node('small','',t.result.slice(0,300)));
    if(['waiting','running'].includes(t.state)){const b=node('button','','取消任务');b.onclick=async()=>{try{await api('cancel',{id:t.id});renderStatus(await api('status'));}catch(e){toast(explain(e.message));}};card.append(b);}$('tasks').append(card);}
}
async function refreshSessions(){const list=await api('sessions');$('sessions').replaceChildren();$('session-count').textContent=String(list.length);for(const s of list){const b=node('button','session-button'+(s.id===currentId?' active':''));b.append(node('span','bubble','◯'),node('span','',s.title));b.onclick=()=>selectSession(s.id).catch(e=>toast(explain(e.message)));$('sessions').append(b);}return list;}
function formatted(text){const box=node('div','assistant-answer');const pieces=String(text).split(/```[^\n]*\n([\s\S]*?)```/g);for(let i=0;i<pieces.length;i++){if(i%2){const pre=node('pre');pre.append(node('code','',pieces[i]));box.append(pre);}else box.append(document.createTextNode(pieces[i]));}return box;}
function toolEvent(event){if(event.name==='codex_record'){
  const box=node('details','tool-event codex-record');box.open=event.state==='failed';box.append(node('summary','','Codex 调用记录'));
  try{const r=JSON.parse(event.result),count=(r.images||[]).filter(i=>i.status==='completed').length;
    box.append(node('p','',new Date(r.startedAt).toLocaleString('zh-CN')+' · '+((r.events||[]).some(e=>e.method==='turn-requested')?'已提交 Codex 回合':'尚未提交模型回合')+' · 图片完成事件 '+count+' 个'),node('small','','记录 ID：'+r.id));
    const text=r.finalText||(r.messages||[]).map(m=>m.text).filter(Boolean).join('\n\n');
    box.append(node('strong','','Codex 返回文字'),node('pre','codex-reply',text||'未收到文字回复。请查看下方事件和错误记录。'));
    if(r.delivery?.error||r.error)box.append(node('p','',r.delivery?.error||r.error));
    const details=node('details');details.append(node('summary','','请求与事件明细'),node('pre','',event.result));box.append(details);
    const download=node('button','','下载 JSON 记录');download.type='button';download.onclick=()=>{const url=URL.createObjectURL(new Blob([event.result],{type:'application/json'})),a=node('a');a.href=url;a.download='codex-'+r.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};box.append(download);
  }catch{box.append(node('pre','',event.result));}return box;
}if(event.name==='image_plan'){const card=node('details','image-plan');card.open=true;card.append(node('summary','',event.mock?'离线演示 · 画面方案':'画面方案 · 小鱼来设计'));const list=node('dl');for(const [key,label] of Object.entries({subject:'主体',scene:'场景',style:'画风',composition:'构图',lighting:'光线',palette:'配色',details:'细节'})){list.append(node('dt','',label),node('dd','',event.plan[key]));}card.append(list);if(event.character)card.append(node('small','',event.mock?'演示关联鲸酱设定图；未发送给 Codex。':'本次会附上鲸酱设定图，保持角色外观。'));return card;}const d=node('details','tool-event'+(event.state==='failed'?' failed':''));const labels={list_files:'查看会话文件',read_file:'读取文件',write_file:'保存文件',search_web:'搜索公开网页',queue_codex:'提交 Codex 待审任务'};d.append(node('summary','',(event.state==='failed'?'○ ':'✓ ')+(labels[event.name]||event.name)));d.append(node('pre','',event.result));return d;}
function imageElement(image,sid){const figure=node('figure','generated-image'+(image.mock?' mock-image':'')),preview=node('div','image-preview'),caption=node('figcaption'),button=node('button','','下载 PNG');button.type='button';button.disabled=true;caption.append(node('span','',image.mock?'离线演示 · 1×1 PNG 测试占位':'Codex 生成 · 已校验 PNG'),button);figure.append(preview,caption);
  if(image.mock)preview.append(node('span','','▧'),node('strong','','出图流程演示'),node('small','','此处是测试占位，未调用真实模型。'));
  else preview.append(node('p','muted','正在读取图片…'));
  void (async()=>{try{const r=await fetch('/api/image?sessionId='+encodeURIComponent(sid)+'&id='+encodeURIComponent(image.id),{headers:{authorization:'Bearer '+token}});if(!r.ok){const e=await r.json();throw Error(e.error);}const url=URL.createObjectURL(await r.blob());imageUrls.add(url);if(!image.mock){const img=node('img');img.alt='小鱼设计、Codex 生成的图片';img.src=url;img.onload=scrollEnd;preview.replaceChildren(img);}button.disabled=false;button.onclick=()=>{const a=node('a');a.href=url;a.download='deepseekfish-'+image.id+'.png';a.click();};}catch(e){preview.replaceChildren(node('p','error-message',explain(e.message)));}})();return figure;}
function turnElement(turn){const row=node('article','turn');row.append(node('div','user-message',turn.user));const assistant=node('div','assistant-row'),img=node('img','assistant-avatar');img.src='/fish.svg';img.alt='小鱼';const content=node('div','assistant-content');content.append(node('div','assistant-label','小鱼 · '+(state?.mock?'离线演示':'DeepSeek')));const trace=node('div','trace');for(const event of turn.trace||[])trace.append(toolEvent(event));content.append(trace);const answer=node('div','answer-slot');
  if(turn.state==='running')answer.append(node('div','thinking','小鱼正在想一想…'));else if(turn.state==='failed')answer.append(node('div','error-message',explain(turn.answer)));else answer.append(formatted(turn.answer));content.append(answer);const gallery=node('div','image-results');for(const image of turn.images||[])gallery.append(imageElement(image,currentId));content.append(gallery);assistant.append(img,content);row.append(assistant);return row;}
async function downloadFile(file){try{const r=await fetch('/api/file?id='+encodeURIComponent(currentId)+'&path='+encodeURIComponent(file.name),{headers:{authorization:'Bearer '+token}});if(!r.ok){const e=await r.json();throw Error(e.error);}const url=URL.createObjectURL(await r.blob()),a=node('a');a.href=url;a.download=file.name.split('/').at(-1);a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){toast(explain(e.message));}}
function renderFiles(files){$('file-count').textContent=String(files.length);$('files').replaceChildren();if(!files.length){const empty=node('div','empty-files');empty.append(node('span','','▱'),node('p','','文件会出现在这里'),node('small','','试试让助手创建 notes.md'));$('files').append(empty);}for(const f of files){const row=node('div','file-row'),info=node('div'),b=node('button','','↓');b.type='button';b.setAttribute('aria-label','下载 '+f.name);b.onclick=()=>downloadFile(f);info.append(node('strong','',f.name),node('small','',f.bytes.toLocaleString()+' bytes'));row.append(node('span','','▱'),info,b);$('files').append(row);}}
async function selectSession(id){if(busy&&id!==currentId){toast('请先等待或停止当前请求。');return;}for(const url of imageUrls)URL.revokeObjectURL(url);imageUrls.clear();currentId=id;const d=await api('session?id='+encodeURIComponent(id));$('welcome').hidden=d.turns.length>0;$('messages').replaceChildren(...d.turns.map(turnElement));renderFiles(d.files);await refreshSessions();if(state)renderStatus(state);closeDrawers(false);if(d.turns.length)scrollEnd();else $('conversation').scrollTop=0;}
function scrollEnd(){const box=$('conversation');box.scrollTop=box.scrollHeight;}
async function initialize(){renderStatus(await api('status'));const list=await refreshSessions();if(!currentId)currentId=list[0]?.id||(await api('sessions',{})).id;await selectSession(currentId);}
function settings(){if(!state)return;closeDrawers(false);$('model').value=state.settings.model;$('api-key').value='';$('key-state').textContent=state.credentialPresent?'已配置 · 留空保留':'尚未配置';$('max-output').value=state.settings.maxOutputTokens;$('daily-tokens').value=state.settings.dailyTokens;$('search-enabled').checked=state.settings.search;$('codex-enabled').checked=state.settings.codexQueue;$('codex-enabled').disabled=state.codexImageOnly===true;$('settings-error').textContent='';$('settings-dialog').showModal();}
$('refresh-quota').onclick=async()=>{const button=$('refresh-quota');button.disabled=true;try{renderStatus(await api('codex-quota/refresh',{}));}catch(e){toast(explain(e.message));}finally{button.disabled=false;}};
$('reset-images').onclick=()=>{$('reset-images-error').textContent='';$('reset-images-dialog').showModal();};
$('reset-images-form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{renderStatus(await api('images/reset',{}));$('reset-images-dialog').close();toast('本地生图计数已重置；Codex 账号额度未改变。');}catch(err){$('reset-images-error').textContent=explain(err.message);}finally{e.submitter.disabled=false;}};
$('confirm-image-once').onclick=()=>{const request=pendingImageConfirmation;pendingImageConfirmation=null;$('image-confirm-dialog').close();if(!request||request.sessionId!==currentId||busy)return;confirmedImageRequest=request;$('prompt').value=request.text;setMode(request.mode);$('chat-form').requestSubmit();};
$('image-confirm-dialog').addEventListener('close',()=>{pendingImageConfirmation=null;});
$('settings-button').onclick=settings;$('setup-button').onclick=settings;
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
$('settings-form').onsubmit=async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{renderStatus(await api('settings',{apiKey:$('api-key').value.trim(),model:$('model').value.trim(),maxOutputTokens:Number($('max-output').value),dailyTokens:Number($('daily-tokens').value),search:$('search-enabled').checked,codexQueue:$('codex-enabled').checked}));$('api-key').value='';$('settings-dialog').close();toast('连接设置已保存，尚未发起模型请求。');}catch(err){$('settings-error').textContent=explain(err.message);}finally{button.disabled=false;}};
$('auth-form').onsubmit=async e=>{e.preventDefault();token=$('auth-token').value.trim();try{await initialize();sessionStorage.setItem('fish-token',token);$('auth-token').value='';$('auth-dialog').close();}catch(err){$('auth-error').textContent=explain(err.message);}};
$('new-chat').onclick=async()=>{if(busy){toast('请先等待或停止当前请求。');return;}try{await selectSession((await api('sessions',{})).id);$('prompt').focus();}catch(e){toast(explain(e.message));}};
$('mode-chat').onclick=()=>{if(!busy)setMode('chat');};$('mode-agent').onclick=()=>{if(!busy)setMode('agent');};$('mode-image').onclick=()=>{if(!busy)setMode('image');};
for(const b of document.querySelectorAll('[data-prompt]'))b.onclick=()=>{if(busy)return;$('prompt').value=b.dataset.prompt;if(b.dataset.image)setMode('image');else if(b.dataset.agent)setMode('agent');$('prompt').focus();};
const narrow=matchMedia('(max-width:700px)'),overlayPanel=matchMedia('(max-width:1150px)'),touchInput=matchMedia('(pointer:coarse)');
let drawerReturnFocus;
function activeDrawer(){return narrow.matches&&$('sidebar').classList.contains('open')?$('sidebar'):overlayPanel.matches&&!$('workspace-panel').classList.contains('closed')?$('workspace-panel'):null;}
function syncDrawers(){
  const drawer=activeDrawer();$('drawer-backdrop').hidden=!drawer;document.querySelector('.main').inert=!!drawer;
  $('sidebar').inert=narrow.matches&&!$('sidebar').classList.contains('open');
  $('workspace-panel').inert=$('workspace-panel').classList.contains('closed');
  $('menu-button').setAttribute('aria-expanded',String($('sidebar').classList.contains('open')));
  $('panel-button').setAttribute('aria-expanded',String(!$('workspace-panel').classList.contains('closed')));
}
function closeDrawers(restore=true){$('sidebar').classList.remove('open');if(overlayPanel.matches)$('workspace-panel').classList.add('closed');syncDrawers();if(restore&&drawerReturnFocus?.isConnected)drawerReturnFocus.focus({preventScroll:true});}
function openDrawer(kind){
  const alreadyOpen=kind==='sidebar'?$('sidebar').classList.contains('open'):!$('workspace-panel').classList.contains('closed');
  if(alreadyOpen){if(kind==='panel')$('workspace-panel').classList.add('closed');closeDrawers();return;}
  drawerReturnFocus=document.activeElement;closeDrawers(false);
  if(kind==='sidebar')$('sidebar').classList.add('open');else $('workspace-panel').classList.remove('closed');
  syncDrawers();if(activeDrawer())$(kind==='sidebar'?'close-sidebar':'close-panel').focus({preventScroll:true});
}
$('panel-button').onclick=()=>openDrawer('panel');$('close-panel').onclick=()=>{$('workspace-panel').classList.add('closed');closeDrawers();};
$('menu-button').onclick=()=>openDrawer('sidebar');$('close-sidebar').onclick=()=>closeDrawers();$('drawer-backdrop').onclick=()=>closeDrawers();
function responsiveLayout(){closeDrawers(false);$('workspace-panel').classList.toggle('closed',overlayPanel.matches);syncDrawers();}
narrow.addEventListener('change',responsiveLayout);overlayPanel.addEventListener('change',responsiveLayout);responsiveLayout();
function visibleViewport(){const v=window.visualViewport;document.documentElement.style.setProperty('--app-height',(v?.height??innerHeight)+'px');document.documentElement.style.setProperty('--app-top',(v?.offsetTop??0)+'px');}
window.visualViewport?.addEventListener('resize',visibleViewport);window.visualViewport?.addEventListener('scroll',visibleViewport);window.addEventListener('resize',visibleViewport);visibleViewport();
$('input-hint').textContent=touchInput.matches?'点击发送':'Enter 发送';
document.addEventListener('keydown',e=>{
  const drawer=activeDrawer();if(!drawer||document.querySelector('dialog[open]'))return;
  if(e.key==='Escape'){e.preventDefault();closeDrawers();return;}
  if(e.key==='Tab'){const focusable=[...drawer.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled)')].filter(el=>el.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
});
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&(!touchInput.matches||e.ctrlKey||e.metaKey)){e.preventDefault();$('chat-form').requestSubmit();}});
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='n'){e.preventDefault();$('new-chat').click();}});
$('cancel').onclick=()=>{abortController?.abort();};
$('chat-form').onsubmit=async e=>{
  e.preventDefault();const confirmation=confirmedImageRequest;confirmedImageRequest=null;const text=$('prompt').value.trim(),requestMode=mode,imageConfirmed=!!confirmation&&confirmation.sessionId===currentId&&confirmation.text===text&&confirmation.mode===requestMode;if(busy||!text||!currentId)return;
  if(!state.mock&&!state.credentialPresent){settings();return;}
  busy=true;const id=currentId;abortController=new AbortController();$('send').hidden=true;$('cancel').hidden=false;$('prompt').disabled=true;$('mode-chat').disabled=true;$('mode-agent').disabled=true;$('mode-image').disabled=true;
  $('welcome').hidden=true;const row=turnElement({user:text,answer:'',trace:[],state:'running'});$('messages').append(row);const answer=row.querySelector('.answer-slot'),trace=row.querySelector('.trace');scrollEnd();
  try{
    const res=await fetch('/api/chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sessionId:id,text,mode:requestMode,imageConfirmed}),signal:abortController.signal});
    if(!res.ok){const data=await res.json();throw Error(data.error||'REQUEST_FAILED');}
    $('prompt').value='';const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='',finished=false;
    const handle=event=>{if(event.type==='done'||event.type==='error')finished=true;if(event.type==='thinking')answer.replaceChildren(node('div','thinking',event.stage==='planning'?'小鱼正在设计画面…':event.stage==='generating'?(state.mock?'正在演示出图流程…':'方案已交给 Codex，正在生成图片…'):event.round===1?'小鱼正在想一想…':'正在整理操作结果…'));if(event.type==='tool')trace.append(toolEvent(event.event));if(event.type==='image')row.querySelector('.image-results').append(imageElement(event.image,id));if(event.type==='answer')answer.replaceChildren(formatted(event.text));if(event.type==='error'){answer.replaceChildren(node('div','error-message',explain(event.error)));if(event.error==='CODEX_QUOTA_CONFIRM_REQUIRED')pendingImageConfirmation={sessionId:id,text,mode:requestMode};}scrollEnd();};
    for(;;){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(line.trim())handle(JSON.parse(line));}}
    if(!finished)throw Error('STREAM_INTERRUPTED');
  }catch(err){answer.replaceChildren(node('div','error-message',err.name==='AbortError'?explain('CHAT_CANCELLED'):explain(err.message)));}
  finally{busy=false;$('send').hidden=false;$('cancel').hidden=true;$('prompt').disabled=false;$('mode-chat').disabled=false;$('mode-agent').disabled=false;$('mode-image').disabled=false;$('prompt').focus();try{await refreshSessions();renderStatus(await api('status'));renderFiles((await api('session?id='+encodeURIComponent(id))).files);}catch{}if(pendingImageConfirmation){$('image-confirm-request').textContent=pendingImageConfirmation.text;$('image-confirm-dialog').showModal();}}
};
async function start(){
  const fragment=new URLSearchParams(location.hash.slice(1)),code=fragment.get('bootstrap');history.replaceState(null,'',location.pathname);
  try{
    const access=await fetch('/api/access');
    if(access.ok&&(await access.json()).tailnetOwner===true){tailnetOwner=true;token='';sessionStorage.removeItem('fish-token');await initialize();return;}
    if(access.status===403){toast('请使用你自己的 Tailscale 设备连接工作台。');return;}
  }catch(e){toast('连接暂时不可用，请刷新重试。');return;}
  if(code){try{const r=await fetch('/api/bootstrap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});const data=await r.json();if(!r.ok)throw Error(data.error);token=data.token;sessionStorage.setItem('fish-token',token);}catch(e){toast(explain(e.message));}}
  if(!token){$('auth-dialog').showModal();return;}try{await initialize();}catch(e){if(!$('auth-dialog').open)$('auth-dialog').showModal();toast(explain(e.message));}
}
void start();setInterval(async()=>{if((token||tailnetOwner)&&!$('auth-dialog').open){try{renderStatus(await api('status'));}catch{}}},6000);
