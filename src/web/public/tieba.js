'use strict';
(()=>{
 const dialog=$('tieba-dialog'),screen=$('tieba-frame');let frameUrl,working=false,drag,frameSerial=0,screenMode='login',currentStatus,lastAttempt,refreshing=false,shownRequest,announced='',pendingOpen=false,verified='',evidenceKey='',evidenceUrls=[];
 function failureText(code,receipt={}){
  if(receipt.reason==='pre_submit_stalled'||receipt.submission?.phase==='pre_submit_stalled')return '官网在发布前长时间没有继续，本次已安全结束，尚未发出发布请求。可查看现场截图并手动处理；程序不会自动重发。';
  if(receipt.guardReason==='content_mismatch')return '官网生成的待发送正文与原稿核对不一致，已停在发送前；展开诊断可查看具体差异。';
  if(receipt.guardReason==='section_mismatch')return '官网生成的分区与肥鱼所选不一致，本次没有提交。';
  if(['TIEBA_WEB_SECTION_NOT_VISIBLE','TIEBA_WEB_SECTION_NOT_SELECTED'].includes(code))return '未能在官网编辑器确认所选分区，本次没有提交。';
  if(code==='TIEBA_NO_REJECTED_PUBLICATION')return '这条记录没有可恢复的拒绝回执。请查看本条记录的实际回执。';
  if(code==='TIEBA_MATCHING_PUBLICATION_EXISTS')return '同一份原稿已有发送记录，请先核对该记录的公开结果。';
  if(code==='TIEBA_CHECK_PENDING_PUBLICATION_FIRST')return '这次提交已有回执或结果待确认，可以只读核对。';
  if(code==='TIEBA_PUBLICATION_RESPONSE_PENDING')return '官网已经提交，正在等这条发言的贴吧回执。收到回执后再点「恢复发送」。';
  const text={INTERNAL_ERROR:'程序内部异常；展开实际回执与诊断查看原因。旧记录未保存原始异常时无法恢复细节。',TIEBA_QUEUE_EXECUTION_TIMEOUT:'本次任务超过执行期限；这是本地执行超时，发言是否被受理需看原回执，不会自动重发。',TIEBA_BROWSER_COMMAND_TIMEOUT:'浏览器单条指令等待20秒仍未完成，当前操作已结束。',TIEBA_READ_TIMEOUT:'贴吧读取请求超过20秒，已中止该请求。',TIEBA_OPERATION_CANCELLED:'当前操作已停止。',TIEBA_CLEANUP_FAILED:'尚未确认浏览器完全停止，程序会重启账号工作进程清理。',TIEBA_QUEUE_INTERRUPTED:'服务在处理期间重启；该状态不是贴吧拒绝。请按原回执核对，程序未自动重发。',TIEBA_WEB_EDITOR_NOT_VISIBLE:'已定位并点击目标的回复按钮，但官网没有展开对应编辑器；尚未提交，现场见截图。',TIEBA_WEB_CONTROL_NOT_VISIBLE:'网页控件不存在或不可见，未能点击。',TIEBA_WEB_CONTROL_OBSCURED:'回复或发布按钮被其他页面元素遮挡，未能点击。',TIEBA_WEB_REPLY_ENTRY_NOT_READY:'帖子已打开，但回复入口未加载出来。',TIEBA_WEB_REPLY_EDITOR_NOT_READY:'已点击回复按钮，但编辑器没有出现。',TIEBA_WEB_REPLY_TARGET_NOT_VISIBLE:'帖子已打开，但未找到目标楼层或子回复的可见回复按钮。',TIEBA_WEB_CONTENT_NOT_VERIFIED:'编辑器里的正文与原稿不一致，尚未提交。',TIEBA_WEB_COMPOSER_CHANGED:receipt.step==='fill_reply_editor'?'回复框没有正常打开，未能填写正文。':receipt.step==='locate_reply_target'?'目标回复按钮没有正常定位或点击。':'官网发言控件未正常加载或定位，尚未提交。',TIEBA_REPLY_PARENT_UNRESOLVED:'尚未从实际记录和页面确认最外层父楼，没有提交。',TIEBA_REPLY_TARGET_UNAVAILABLE:'父楼已确认，但本次读取未找到目标回复，没有提交。',TIEBA_THREAD_NOT_VERIFIED:'读帖结果未能确认目标帖子与所属吧，未提交。',TIEBA_PUBLICATION_CHALLENGE:'贴吧实际返回安全验证，请在下方官网画面完成验证。',TIEBA_PUBLICATION_REJECTED:'贴吧明确拒绝了本次发布，具体原因见平台提示。',TIEBA_WEB_PRE_SUBMIT_FAILED:'官网发布前的处理失败，未发起发布请求；具体官网提示见下方记录。',TIEBA_PUBLICATION_UNCONFIRMED:'尚未取得能确认发布的回执；请求是否发起、官网提示和网络阶段见下方记录。',TIEBA_PUBLICATION_NOT_FOUND:'这次操作尚无可核对的发布回执。',TIEBA_PUBLICATION_NOT_PREPARED:'官网回复尚未准备好，请先打开并定位编辑器。',TIEBA_EVIDENCE_NOT_FOUND:'本次截图不存在或已超出现场保留范围。',TIEBA_BUSY:'官网正在处理上一项操作，请稍后刷新。',TIEBA_LOGIN_REQUIRED:'官网确认需要重新登录，请使用下方官方登录入口。',TIEBA_PUBLICATION_WINDOW_CHANGED:'当前官网窗口已切换到新的操作，请刷新查看最新现场。'};
  return text[code]||code;
 }
 const labels={unconfigured:'未配置账号环境',needs_check:'已保存浏览器资料，等待实际验证',waiting_login:'等待你手动登录',logged_in:'已登录（服务端已确认身份）',expired:'登录已失效，需要重新登录',check_failed:'最近一次检查失败；未据此判定会话失效'};
 async function call(path,value){
  const controller=new AbortController(),timer=value===undefined?setTimeout(()=>controller.abort(),10000):null;
  try{const r=await fetch('/api/'+path,{method:value===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:value===undefined?undefined:JSON.stringify(value),signal:controller.signal});const data=await r.json();if(!r.ok)throw Error(data.error||'REQUEST_FAILED');return data;}
  catch(e){if(e.name==='AbortError')throw Error('等待超时。发布结果可能尚未返回，请刷新状态或只读检查结果，勿重复提交。');throw e;}finally{clearTimeout(timer);}
 }
 let queueLoading=false,queueData,queueKey='',selectedQueueId,selectedQueueItem,queueDetailKey='',queueFilter='all',dismissing=false;
 const queueChecks=new Map();
 window.addEventListener('corpus-likes-changed',()=>{queueKey='';queueDetailKey='';if(dialog.open)void refreshQueue();});
 const queueActions={publish:'发言',verify:'核对发言结果',account:'读取账号与关注列表',replies:'读取回复通知',mentions:'读取 @ 通知',read:'读帖',start:'打开登录',check:'确认登录','publication-start':'准备原回复','publication-submit':'提交原回复','publication-check':'核对公开结果',input:'操作官网页面',frame:'更新官网画面','publication-frame':'更新发言画面',moderator:'吧务申请',logout:'退出账号',close:'释放官网窗口'};
 const submissionStages={pre_submit_stalled:'官网发布前处理停滞，已结束且未提交',native_page_notice:'官网页面出现提示（不是发布API回执）',publish_request_blocked:'发布请求在本地核对时未获放行',click_publish:'点击官网发布按钮',wait_native_publish_request:'等待官网完成发布前处理，尚未发起发布请求',await_publication_response:'发布请求已发起，等待贴吧返回回执',publication_response_received:'已收到发布请求的结果'};
 const queueOutcomes={timeout:'执行超时',preview:'预演（未发布）',public:'公开成功',accepted:'已受理，待公开确认',challenge:'需要人工验证',failed:'出现问题',unknown:'结果不确定',removed:'已被系统删除',interrupted:'服务重启中断',cancelled:'已取消',done:'已完成'};
 const queueTime=at=>at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false}):'未记录';
 const paceTime=at=>new Date(at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
 function intervalDescription({intervalMs,maxIntervalMs=intervalMs}){
  if(maxIntervalMs===0)return '无额外间隔';
  if(intervalMs===maxIntervalMs)return intervalMs/1000+' 秒（固定）';
  return intervalMs/1000+'～'+maxIntervalMs/1000+' 秒（随机）';
 }
 const pacingLabel=item=>item.state==='queued'&&item.scheduledAt?(item.queuePosition?'排队第 '+item.queuePosition+' 条':'排队中')+' · 预计 '+paceTime(item.scheduledAt)+' 发送':'';
 const recordRange=(offset,count,total)=>count?`${offset+1}–${offset+count} / ${total}`:`0 / ${total}`;
 const visibleLabels={public:'公开正文可见',author_only:'账号侧已找到，公开未确认',not_observed:'本次未找到匹配正文',no_longer_observed:'此前公开，本次未找到',removed_by_system:'回收站确认系统删除'};
 const queueLabel=item=>item.state==='cleaning'?'超时清理中':item.state==='running'?'处理中':item.state==='queued'?pacingLabel(item)||'等待中':
   visibleLabels[item.result?.visibility]||queueOutcomes[item.result?.outcome]||'已完成';
 const isProblem=item=>item.problem??(!['queued','running','cleaning'].includes(item.state)&&!item.result?.publicVerified&&item.result?.visibility!=='public'&&!!(item.result?.error||['challenge','failed','unknown','removed','interrupted','timeout'].includes(item.result?.outcome)));
 const statusTone=item=>item.dismissed?'muted':['running','queued','cleaning'].includes(item.state)?'live':isProblem(item)?'warning':item.result?.publicVerified||item.result?.outcome==='public'?'success':'neutral';
 const shortTime=at=>at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'时间未记录';
 function statusPill(item){const pill=node('span','tieba-status-pill',item.dismissed?'已忽略 · '+queueLabel(item):queueLabel(item));pill.dataset.tone=statusTone(item);return pill;}
 function dismissButton(item){
  const button=node('button','quiet-button',item.dismissed?'取消忽略':'忽略当前条目');button.type='button';
  const requestId=item.metadata?.requestId??item.requestId??item.result?.requestId??item.id;
  button.onclick=()=>void dismissIssue(item.dismissed?{restore:true,requestId}:{requestId});return button;
 }
 async function dismissIssue(payload){
  if(dismissing)return;dismissing=true;pendingOpen=false;
  const message=$('tieba-dismiss-message');message.textContent='正在保存提醒设置…';
  try{
   await call('tieba/dismiss',payload);queueKey='';queueDetailKey='';
   await status();await refreshQueue();
   message.textContent=payload.restore?'已恢复这条提醒。':payload.all?'已忽略现有问题，之后的新问题仍会提醒。':'已忽略这条提醒，可在「已忽略」中恢复。';
  }catch(e){message.textContent='未能保存忽略设置：'+failureText(e.message);$('tieba-alert-text').textContent=message.textContent;}
  finally{dismissing=false;}
 }
 document.addEventListener('click',e=>{
  const button=e.target.closest('button[data-tieba-dismiss]');if(!button||button.disabled)return;
  const action=button.dataset.tiebaDismiss;
  if(action==='all')void dismissIssue({all:true});
  else{
   const item=action==='selected'?selectedQueueItem:action==='publication'?currentStatus?.publicationWork:currentStatus?.attention;
   const requestId=item?.metadata?.requestId??item?.requestId??item?.result?.requestId??item?.id;
   if(requestId)void dismissIssue(item.dismissed?{restore:true,requestId}:{requestId});
  }
 });
 for(const button of document.querySelectorAll('[data-tieba-filter]'))button.onclick=()=>{
  queueFilter=button.dataset.tiebaFilter;queueKey='';if(queueData)renderQueue(queueData);void refreshQueue(0);
 };
 async function verifyQueueReply(requestId){
  if(queueChecks.get(requestId)?.checking)return;
  queueChecks.set(requestId,{checking:true});renderQueueSelection();
  try{
   const result=await call('tieba/publication-check',{requestId});
   if(result?.requestId!==requestId)throw Error('核对结果没有返回这条回帖的请求编号。');
   queueChecks.set(requestId,{result});
   void refreshQueue();
  }catch(error){queueChecks.set(requestId,{error:failureText(error.message)});}
  renderQueueSelection();
 }
 // Reuse the real browser and its controls inside the selected record.
 const rowControls=node('section'),rowProgress=node('p','hint'),rowError=node('p','form-error');
 rowProgress.setAttribute('role','status');rowError.setAttribute('role','alert');
 const movable=['tieba-publication','tieba-login'].map(id=>{
  const element=$(id),anchor=document.createComment(id);element.before(anchor);return {element,anchor};
 });
 let rowOpening,displayedFrame;
 function belongsTo(work,id){return !!work&&!!id&&(id===work.requestId||id===work.sourceId);}
 function placeControls(){
  const here=!!selectedQueueId&&belongsTo(currentStatus?.publicationWork,selectedQueueId)&&currentStatus.interaction==='publication';
  for(const {element,anchor} of movable){
   if(here&&element.parentNode!==rowControls)rowControls.append(element);
   if(!here&&element.parentNode===rowControls)anchor.after(element);
  }
  rowControls.hidden=!here;
 }
 async function openReply(id){
  if(rowOpening||working){rowProgress.textContent='正在处理上一个官网操作，请稍候。';return;}
  rowOpening=id;rowError.textContent='';rowProgress.textContent='正在打开这条原回复的官网页面…';
  try{
   const s=await call('tieba/publication-start',{requestId:id});
   if(selectedQueueId!==id)return;
   if(!belongsTo(s.publicationWork,id)||s.interaction!=='publication')throw Error('TIEBA_PUBLICATION_WINDOW_CHANGED');
   render(s);await frame();
   if(selectedQueueId===id)$('tieba-login').scrollIntoView({block:'nearest'});
  }catch(e){if(selectedQueueId===id)rowError.textContent=failureText(e.message);}
  finally{if(selectedQueueId===id)rowProgress.textContent='';rowOpening=undefined;}
 }
 function recordEvidence(id,shots){
  const detail=node('details'),summary=node('summary','','查看本条官网截图');detail.append(summary);
  const shot=shots.findLast(s=>s.stage==='response'||s.stage==='submission_ended')??shots.at(-1);
  detail.ontoggle=async()=>{
   if(!detail.open||detail.dataset.loading)return;detail.dataset.loading='1';
   try{
    const response=await fetch('/api/tieba/publication-frame?'+new URLSearchParams({requestId:id,evidence:shot.id}),{headers:{authorization:'Bearer '+token},cache:'no-store'});
    if(!response.ok)throw Error((await response.json()).error);
    const blob=await response.blob();if(!detail.isConnected)return;
    const url=URL.createObjectURL(blob),img=node('img');img.onload=img.onerror=()=>URL.revokeObjectURL(url);
    img.alt='这条回帖的历史截图';img.style.maxWidth='100%';img.src=url;detail.append(img);
   }catch(e){detail.append(node('p','hint',failureText(e.message)));}
  };
  return detail;
 }
 function renderQueueDetail(item){
  const box=$('tieba-queue-detail'),overview=$('tieba-account-overview');box.hidden=!item;overview.hidden=!!item;
  if(!item){box.replaceChildren();return;}
  box.replaceChildren();
  const m=item.metadata||{},requestId=m.requestId??item.result?.requestId??item.id,check=queueChecks.get(requestId);
  const currentProof=check?.result&&(check.result.verifiedAt??0)>=(item.result?.verifiedAt??0)?check.result:undefined;
  const r={...item.result,...currentProof},receipt=r.receipt||{};
  const heading=node('div','tieba-reply-heading'),close=node('button','quiet-button','返回账号');
  close.type='button';close.onclick=()=>selectQueueReply(undefined);
  const title=node('div');title.append(node('span','eyebrow','REPLY · 回复记录'),node('h3','','回帖详情'));
  heading.append(title,statusPill({...item,result:r}),close);box.append(heading);
  const toolbar=node('div','tieba-actions tieba-detail-toolbar');
  if(item.dismissed||isProblem(item))toolbar.append(dismissButton(item));
  if(isProblem(item)&&!item.dismissed){const all=node('button','quiet-button','忽略所有条目');all.type='button';all.onclick=()=>void dismissIssue({all:true});toolbar.append(all);}
  if(item.corpusLike&&window.corpusReplyButton)toolbar.append(window.corpusReplyButton({queueId:item.id},item.corpusLike.liked));
  box.append(toolbar);
  const meta=node('dl','tieba-meta-grid');
  for(const [label,value] of [['进入队列',queueTime(item.createdAt)],['处理结束',item.finishedAt?queueTime(item.finishedAt):'—'],['贴吧 ID',m.forumId||'—'],['帖子 / 父楼',[m.threadId,m.postId].filter(Boolean).join(' / ')||'—']]){const pair=node('div');pair.append(node('dt','',label),node('dd','',value));meta.append(pair);}
  box.append(meta);
  if(pacingLabel(item))box.append(node('p','hint',pacingLabel(item)+'（香港时间）。预计时间随队列变化更新，排队时间不计入执行上限。'));
  if(m.title)box.append(node('strong','',m.title));if(m.content)box.append(node('blockquote','tieba-quoted-content',m.content));
  const diagnostics=node('details','tieba-diagnostics');diagnostics.append(node('summary','','运行细节与平台提示'));
  const diagnosticLine=(...elements)=>diagnostics.append(...elements);
  if(requestId){
   const recoverable=r.error==='TIEBA_PUBLICATION_CHALLENGE'||r.submitted===false&&receipt.notSubmitted===true;
   if(recoverable){
    const button=node('button','primary-button',r.error==='TIEBA_PUBLICATION_CHALLENGE'?'打开本条人工验证':'打开本条官网编辑器');
    button.type='button';button.onclick=()=>void openReply(requestId);toolbar.prepend(button);
   }
   box.append(rowProgress,rowError,rowControls);placeControls();
   if(r.evidence?.length)box.append(recordEvidence(requestId,r.evidence));
  }
  const times=[(m.source==='publication_history'?'历史发言时间：':'进入队列：')+queueTime(item.createdAt)];
  if(item.startedAt)times.push('开始处理：'+queueTime(item.startedAt)+'；等待 '+((item.startedAt-item.createdAt)/1000).toFixed(1)+' 秒');
  if(item.finishedAt)times.push('处理结束：'+queueTime(item.finishedAt));
  if(m.source!=='publication_history'&&item.limitMs)times.push('执行上限：'+item.limitMs/1000+' 秒（排队时间不计入）');
  diagnosticLine(node('p','hint',times.join('\n')));
  if(m.source==='publication_history')box.append(node('p','hint','来自已有发言记录；并非本次新排队或重发。'));
  if(m.subPostId)diagnosticLine(node('p','','子回复：'+m.subPostId));
  if(m.target)diagnosticLine(node('p','hint',m.target));
  if(r.resolvedTarget)diagnosticLine(node('p','','目标层级已校正：父楼 '+r.resolvedTarget.parentPostId+(r.resolvedTarget.subPostId?'；目标子回复 '+r.resolvedTarget.subPostId:'')));
  const canVerify=item.canVerify??!!(r.submitted===true||r.id||['accepted','unknown','public','removed'].includes(r.outcome));
  if(requestId&&(canVerify||check)){
   const read=node('button','quiet-button',check?.checking?'正在查贴吧正文…':'核对贴吧正文');
   read.type='button';read.disabled=!!check?.checking;read.onclick=()=>void verifyQueueReply(requestId);toolbar.prepend(read);
  }
  if(check?.error)box.append(node('p','form-error',check.error));
  if(r.checks||check?.result){
   const summary=r.checks?(visibleLabels[r.visibility]||(r.publicVerified?'公开正文可见':'本次未找到匹配正文')):'这条回帖尚未进入正文核对。';
   const status=node('p','tieba-reply-proof',summary+(r.verifiedAt?' · '+queueTime(r.verifiedAt):''));
   status.setAttribute('role','status');box.append(status);
   const publicRead=r.checks?.public;
   if(publicRead&&!r.publicVerified&&publicRead.status!=='content')
    box.append(node('p','hint','这次未能读取公开正文'+(publicRead.error?' · '+failureText(publicRead.error):'。')));
  }
  if(r.error)box.append(node('p','form-error',failureText(r.error,receipt)));
  if(receipt.errorMessage)diagnosticLine(node('p','','平台回执：'+receipt.errorMessage));
  if(receipt.pageNotice)diagnosticLine(node('p','','官网页面提示：'+receipt.pageNotice));
  if(receipt.requestCounterSource==='native_publish_interception')diagnosticLine(node('p','',receipt.httpAttempts>0?'官网发布请求已发起：'+receipt.httpAttempts+' 次；'+(r.id?'取得发言 ID '+r.id:receipt.accepted===true?'平台已受理，尚无有效发言 ID':'是否受理以实际回执为准'):'官网尚未发起发布请求'+(receipt.notSubmitted?'，本次已结束。':'，仍在发布前处理。')));
  if(receipt.submission){const v=receipt.submission.page;diagnosticLine(node('p','', '官网提交阶段：'+(submissionStages[receipt.submission.phase]||receipt.submission.phase)+(v?.loading?'；发布按钮仍在加载':'')));if(v?.notices?.length)diagnosticLine(node('p','','官网通知：'+v.notices.join('；')));}
  if(r.notice)box.append(node('p','hint',r.notice));
  if(r.diagnostic)box.append(node('p','form-error','具体异常：'+[r.diagnostic.name,r.diagnostic.message].filter(Boolean).join('：')));
  if(r.timeout){const t=r.timeout,p=t.phase||{},stages={publish:'发言处理',publication_submit:'提交官网发言',publication_prepare:'准备官网编辑器',verify_publication:'核对公开结果',publication_check:'核对公开结果',open_thread:'打开帖子',wait_reply_entry:'等待回复入口',locate_reply_target:'定位回复对象',fill_reply_editor:'打开并填写编辑器',open_forum:'打开贴吧',wait_thread_entry:'等待发帖入口',wait_thread_editor:'加载发帖编辑器',await_publication_response:'等待贴吧发布回执',publication_response_received:'已收到发布回执，等待后续核对',read:'读取帖子',replies:'读取回复通知',frame:'获取官网截图',account:'读取账号信息',login:'打开登录页面',verify:'验证账号'};
   box.append(node('p','form-error','超时发生：'+queueTime(t.timedOutAt)+'；'+(t.subLimitMs?'单次'+(t.reason==='TIEBA_READ_TIMEOUT'?'网络读取':'浏览器指令')+'等待超过 '+t.subLimitMs/1000+' 秒（任务总执行上限 '+t.limitMs/1000+' 秒）。':'执行超过 '+t.limitMs/1000+' 秒。')),node('p','','所在环节：'+[p.operation,p.stage].filter(Boolean).map(s=>submissionStages[s]||stages[s]||s).join(' → ')));
   const cleanup={cleaning:'正在中止旧操作并清理浏览器。',stopped:'旧任务已结束，浏览器已清理，后续队列继续。',restart_required:'清理未能及时完成，使用工作进程自动重启恢复队列。'};
   box.append(node('p','','清理结果：'+(cleanup[t.cleanup?.state]||'尚未确认')+(t.cleanup?.limitMs?'（清理宽限 '+t.cleanup.limitMs/1000+' 秒）':'')));
   if(t.cleanup?.error)box.append(node('p','form-error',failureText(t.cleanup.error)));
   if(r.delivery)box.append(node('p','','原发布回执：'+(queueOutcomes[r.delivery.outcome]||r.delivery.outcome)+(r.delivery.id?'；ID '+r.delivery.id:'')));
  }

  if(r.submitted===false)box.append(node('p','','本次未提交成功。'));else if(r.submitted===true)box.append(node('p','','平台已受理。'+(r.publicVerified?'已实际确认公开可见。':'尚未确认公开可见。')));
  const target=r.url||(/^[1-9]\d{0,19}$/.test(m.threadId)?'https://tieba.baidu.com/p/'+m.threadId:undefined);
  if(target){try{const u=new URL(target);if(u.protocol==='https:'&&u.hostname==='tieba.baidu.com'){const a=node('a','','打开贴吧帖子');a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}}catch{}}
  if(requestId)diagnosticLine(node('p','hint','发言请求：'+requestId));
  box.append(diagnostics);
  if(item.steps?.length){
   const details=node('details'),steps=node('ol');
   for(const step of item.steps)steps.append(node('li','',(queueActions[step.action]||step.action)+' · '+queueLabel({...step,result:step})+' · '+queueTime(step.createdAt)+(step.error?' · '+failureText(step.error):'')));
   details.append(node('summary','','处理步骤'),steps);box.append(details);
  }
  const diagnostic=node('details');diagnostic.append(node('summary','','实际回执与诊断'),node('pre','',JSON.stringify(r,null,2)));box.append(diagnostic);
 }
 function replyView(data){
  if(data.view==='replies')return data;
  // An older account worker may still return raw operations during rollout.
  const rows=new Map();
  for(const item of [...data.completed].reverse().concat(data.active)){
   const type=item.metadata?.action,id=item.result?.requestId??item.metadata?.requestId??item.id;
   const previous=rows.get(id);
   if(previous||type==='reply'||type==='comment')rows.set(id,{...item,id,metadata:{...previous?.metadata,...item.metadata,requestId:id}});
  }
  const items=[...rows.values()].reverse(),active=items.filter(item=>['queued','running','cleaning'].includes(item.state));
  const workerBusy=data.active.some(item=>['running','cleaning'].includes(item.state)&&!['frame','publication-frame'].includes(item.action));
  return {...data,active,workerBusy,completed:items.filter(item=>!active.includes(item))};
 }
 function renderQueueSelection(){
  const items=queueData?[...queueData.active,...queueData.completed,queueData.selected].filter(Boolean):[];
  selectedQueueItem=selectedQueueId?(items.find(item=>item.id===selectedQueueId)??selectedQueueItem):undefined;
  for(const button of $('tieba-queue-list').querySelectorAll('button[data-reply-id]')){
   const selected=button.dataset.replyId===selectedQueueId;
   button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));
  }
  const requestId=selectedQueueItem?.metadata?.requestId??selectedQueueItem?.result?.requestId;
  const ignore=$('tieba-queue-ignore-actions').querySelector('[data-tieba-dismiss="selected"]');
  ignore.disabled=!selectedQueueItem||!isProblem(selectedQueueItem)||selectedQueueItem.dismissed;
  const key=JSON.stringify([selectedQueueItem,queueChecks.get(requestId)]);
  if(key!==queueDetailKey){queueDetailKey=key;renderQueueDetail(selectedQueueItem);}
 }
 function selectQueueReply(id){
  selectedQueueId=id;selectedQueueItem=undefined;rowError.textContent='';rowProgress.textContent='';
  placeControls();renderQueueSelection();
  if(id)$('tieba-queue-detail').scrollIntoView({block:'nearest'});
 }
 function renderQueue(snapshot){
  const data=replyView(snapshot);queueData=data;
  const pacing=data.publishPacing,pacingActive=pacing?.nextPublishAt>Date.now();
  const key=JSON.stringify([data.counts,data.issueCounts,data.active,data.completed,data.offset,data.hasMore,queueFilter,pacing,pacingActive]);
  if(key!==queueKey){
   queueKey=key;
   $('tieba-queue-counts').textContent=data.view==='replies'?'处理中 '+data.counts.running+' · 等待 '+data.counts.queued+' · 已结束 '+(data.counts.totalCompleted??data.counts.completed):'回帖记录';
   if(pacingActive)$('tieba-queue-counts').textContent+=' · 放行间隔 '+intervalDescription(pacing)+' · 下次可发送 '+paceTime(pacing.nextPublishAt)+'（香港时间）';
   const allItems=data.completed,attention=data.issueCounts?.attention??allItems.filter(i=>isProblem(i)&&!i.dismissed).length,ignored=data.issueCounts?.dismissed??allItems.filter(i=>i.dismissed).length;
   for(const button of document.querySelectorAll('[data-tieba-filter]')){const f=button.dataset.tiebaFilter;button.setAttribute('aria-pressed',String(f===queueFilter));button.textContent=f==='all'?'全部':f==='attention'?'需处理 ('+attention+')':'已忽略 ('+ignored+')';}
   $('tieba-queue-ignore-actions').hidden=!attention;
   const box=$('tieba-queue-list'),items=allItems.filter(i=>queueFilter==='dismissed'?i.dismissed:!i.dismissed&&(queueFilter!=='attention'||isProblem(i)));box.replaceChildren();
   if(!items.length)box.append(node('p','tieba-queue-empty',queueFilter==='dismissed'?'没有已忽略的回复。':queueFilter==='attention'?'没有需要处理的问题。':'还没有可显示的回复。'));
   for(const item of items){
    const button=node('button','tieba-queue-card');button.type='button';button.dataset.replyId=item.id;
    button.dataset.outcome=['queued','running','cleaning'].includes(item.state)?item.state:item.result?.outcome||item.state;
    const m=item.metadata||{};
    const top=node('span','tieba-queue-card-top');top.append(statusPill(item),node('time','',shortTime(item.createdAt)));
    button.append(top,node('strong','tieba-reply-preview',(m.content||m.title||'帖子 '+(m.threadId||'—')).slice(0,160)),node('span','hint',m.threadId?'帖子 '+m.threadId:m.title||'回复记录'));
    button.onclick=()=>selectQueueReply(item.id);box.append(button);
   }
   $('tieba-queue-page').textContent=data.view==='replies'?recordRange(data.offset,data.completed.length,data.counts.completed):'第 '+(Math.floor(data.offset/data.limit)+1)+' 页';
  }
  renderQueueSelection();updateQueuePagination();
 }
 function updateQueuePagination(){
  $('tieba-queue-prev').disabled=queueLoading||!queueData?.offset;
  $('tieba-queue-next').disabled=queueLoading||!queueData?.hasMore;
 }
 async function refreshQueue(offset=queueData?.offset??0){
  if(queueLoading||!dialog.open||$('tieba-account-panel').hidden||document.hidden)return;
  queueLoading=true;updateQueuePagination();const requestedFilter=queueFilter;
  try{
   const params=new URLSearchParams({offset:String(offset),replies:'1',filter:requestedFilter});
   if(selectedQueueId)params.set('selectedId',selectedQueueId);
   const data=await api('tieba/queue?'+params);
   if(requestedFilter===queueFilter)renderQueue(data);
  }catch(e){queueKey='';$('tieba-queue-counts').textContent='队列读取失败：'+e.message;}
  finally{queueLoading=false;updateQueuePagination();if(requestedFilter!==queueFilter)void refreshQueue(0);}
 }
 $('tieba-queue-refresh').onclick=()=>void refreshQueue();
 $('tieba-queue-prev').onclick=()=>{if(queueData?.offset)void refreshQueue(Math.max(0,queueData.offset-queueData.limit));};
 $('tieba-queue-next').onclick=()=>{if(queueData?.hasMore)void refreshQueue(queueData.offset+queueData.limit);};
 let pendingRequest,pendingKey='',pendingPause,pendingIntervals;
 const cancellingPublications=new Set();
 const intervalButton=$('tieba-pending-interval'),intervalForm=$('tieba-pending-interval-form');
 function showIntervals(timing){
  pendingIntervals=timing;
  intervalButton.disabled=false;
  $('tieba-pending-spacing').textContent='当前放行间隔 '+intervalDescription(timing)+'。预计发送时间以香港时间显示。';
 }
 function countdown(at){
  const seconds=Math.max(0,Math.ceil((at-Date.now())/1000));
  return seconds?seconds+' 秒后':'可放行，等待执行';
 }
 function updateCountdowns(){
  if(!dialog.open||$('tieba-pending-panel').hidden||document.hidden)return;
  for(const label of $('tieba-pending-panel').querySelectorAll('[data-tieba-countdown]'))label.textContent=countdown(Number(label.dataset.tiebaCountdown));
 }
 function until(at){
  const label=node('strong','tieba-pending-clock',countdown(at));label.dataset.tiebaCountdown=at;return label;
 }
 async function refreshPending(fresh=false){
  if(!dialog.open||document.hidden)return;
  if(pendingRequest){
   if(!fresh)return pendingRequest;
   await pendingRequest;
  }
  if(!pendingRequest)pendingRequest=loadPending().finally(()=>{pendingRequest=undefined;});
  return pendingRequest;
 }
 async function loadPending(){
  try{
   const data=await api('tieba/queue?publications=1'),items=data.active,counts=data.counts;
   if(!Array.isArray(items))throw Error('队列接口未就绪');
   showIntervals(data.publishPacing);
   pendingPause=data.publishPacing?.verificationPause;
   const badge=$('tieba-pending-count');badge.hidden=!items.length&&!pendingPause;badge.textContent=items.length||'暂停';
   $('tieba-pending-status').textContent=(pendingPause?'已暂停自动发送 · ':'')+'进行中 '+counts.running+' · 排队 '+counts.queued+(data.workerBusy&&!counts.running?' · 工作器正在执行其他操作':'');
   const work=currentStatus?.publicationWork;
   $('tieba-pending-verify').hidden=belongsTo(work,pendingPause?.requestId)&&['started','accepted','confirmed','unknown'].includes(work.stage);
   $('tieba-pending-recovery').hidden=!pendingPause;
   const next=data.publishPacing?.nextPublishAt,key=JSON.stringify([next,pendingPause,items]);
   if(key!==pendingKey){
    pendingKey=key;
    const release=$('tieba-pending-release'),box=$('tieba-pending-list');
    if(pendingPause)release.textContent='贴吧在 '+queueTime(pendingPause.detectedAt)+' 要求人工验证。新发言仍可入队，等你点「恢复发送」后继续。';
    else if(next)release.replaceChildren('下次放行 '+paceTime(next)+' · ',until(next));
    else release.textContent='当前无间隔等待';
    box.replaceChildren();
    if(!items.length)box.append(node('p','tieba-queue-empty','没有正在处理或排队的发言。'));
    for(const item of [...items].sort((a,b)=>Number(a.state==='queued')-Number(b.state==='queued'))){
     const m=item.metadata||{},card=node('article','tieba-queue-card');
     const type=m.action==='thread'?'发新帖':m.action==='comment'||['floor','subreply'].includes(m.replyScope)?'楼中楼':m.action==='reply'?'回帖':'发言';
     card.append(node('strong','tieba-reply-preview',m.title||m.content||(m.threadId?'帖子 '+m.threadId:type)));
     card.append(node('span','hint',type+' · '+(item.state==='queued'?'第 '+item.queuePosition+' 位':queueLabel(item))));
     card.append(node('span','hint','入队 '+queueTime(item.createdAt)));
     if(item.scheduledAt){
      const when=node('span','hint','预计 '+queueTime(item.scheduledAt)+' · ');when.append(until(item.scheduledAt));card.append(when);
     }else if(item.state==='queued'&&pendingPause)card.append(node('span','hint','等待手动恢复发送'));
     else if(item.startedAt)card.append(node('span','hint','已开始 '+queueTime(item.startedAt)));
     if(item.state==='queued'){
      const cancel=node('button','quiet-button','取消排队');
      cancel.type='button';cancel.disabled=cancellingPublications.has(item.id);
      cancel.onclick=()=>void cancelQueuedPublication(item.id,cancel);
      card.append(cancel);
     }
     box.append(card);
    }
   }
   updateCountdowns();
  }catch(e){$('tieba-pending-status').textContent='排队状态读取失败：'+e.message;}
 }
 async function cancelQueuedPublication(operationId,button){
  if(cancellingPublications.has(operationId))return;
  const message=$('tieba-pending-error');message.textContent='';
  cancellingPublications.add(operationId);button.disabled=true;
  try{
   const result=await call('tieba/queue-cancel',{operationId});
   if(!result.cancelled)message.textContent=result.state==='running'||result.state==='cleaning'?'这条已开始处理。':'这条已经离开排队。';
  }catch(e){message.textContent='取消失败：'+failureText(e.message);}
  finally{cancellingPublications.delete(operationId);button.disabled=false;await refreshPending(true);void refreshQueue();}
 }
 $('tieba-pending-refresh').onclick=()=>void refreshPending();
 intervalButton.onclick=()=>{
  if(!pendingIntervals)return;
  const open=intervalForm.hidden;
  intervalForm.hidden=!open;
  intervalButton.setAttribute('aria-expanded',String(open));
  if(open){
   $('tieba-interval-min').value=pendingIntervals.intervalMs/1000;
   $('tieba-interval-max').value=pendingIntervals.maxIntervalMs/1000;
   $('tieba-interval-error').textContent='';
   $('tieba-interval-min').focus();
  }
 };
 intervalForm.onsubmit=async event=>{
  event.preventDefault();
  const save=$('tieba-interval-save'),error=$('tieba-interval-error');
  if(save.disabled)return;
  const min=$('tieba-interval-min').valueAsNumber,max=$('tieba-interval-max').valueAsNumber;
  if(max<min){error.textContent='最长间隔要大于或等于最短间隔。';return;}
  save.disabled=true;error.textContent='';
  try{
   const timing=await call('tieba/queue-interval',{intervalMs:min*1000,maxIntervalMs:max*1000});
   showIntervals(timing);
   intervalForm.hidden=true;
   intervalButton.setAttribute('aria-expanded','false');
   intervalButton.focus();
   await refreshPending();
  }catch(e){error.textContent=e.message==='TIEBA_PUBLISH_INTERVAL_INVALID'?'请检查间隔秒数。':'保存失败：'+failureText(e.message);}
  finally{save.disabled=false;}
 };
 $('tieba-pending-verify').onclick=()=>{
  if(!pendingPause||working||rowOpening)return;
  const {requestId}=pendingPause;
  showTiebaTab('account');selectQueueReply(undefined);
  void task(async()=>{render(await call('tieba/publication-start',{requestId}));if(currentStatus?.interaction==='publication')await frame();},'正在打开这条发言的官网验证页面…');
 };
 $('tieba-pending-resume').onclick=async()=>{
  const button=$('tieba-pending-resume');if(!pendingPause||button.disabled)return;
  const error=$('tieba-pending-error');button.disabled=true;error.textContent='';
  try{await call('tieba/queue-resume',pendingPause);}
  catch(e){error.textContent=e.message==='TIEBA_QUEUE_PAUSE_CHANGED'?'出现了新的人工验证，请查看最新状态。':failureText(e.message);}
  finally{await refreshPending();button.disabled=false;}
 };
 setInterval(()=>{void refreshQueue();void refreshPending();},2500);
 setInterval(updateCountdowns,1000);
 function render(s){
  currentStatus=s;
  if(Object.hasOwn(s,'latestAttempt'))lastAttempt=s.latestAttempt;
  const interactive=['publication','application'].includes(s.interaction),application=s.moderatorWork&&s.moderatorWork.created>=(s.publicationWork?.created||0)?s.moderatorWork:null;
  const lines=[labels[s.state]||s.state];
  if(s.identity)lines.push('当前账号：'+s.identity.name+' · UID '+s.identity.id);
  else if(s.lastIdentity)lines.push('上次确认的账号：'+s.lastIdentity.name+'（当前未确认）');
  if(s.verifiedAt)lines.push('最近验证：'+new Date(s.verifiedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'}));
  if(s.lastError?.code==='TIEBA_WORKER_UNAVAILABLE')lines.push('无法连接隔离服务，浏览器和资料状态暂时无法确认');else lines.push('浏览器：'+(s.browserRunning?'运行中':'已关闭')+'；资料：'+(s.profileSaved?'已保存':'未保存'));
  if(s.loginPage)lines.push('官方页面：'+s.loginPage.title+' · '+s.loginPage.origin+(s.loginPage.blocked?' · 页面暂不可用':s.loginPage.challenge?' · 需要手动完成验证':''));
  if(s.loginPage?.notice)lines.push('官网当前文字：'+s.loginPage.notice);
  if(s.lastError)lines.push('最近操作：'+failureText(s.lastError.code,s.publicationWork?.result?.receipt));
  if(!application&&s.publication?.needsHuman)lines.push('这次请求收到贴吧安全验证（'+s.publication.error+'）。已登录不代表发言验证已通过。'+(s.publication.detectedAt?'\n触发时间：'+new Date(s.publication.detectedAt).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong'}):''));
  $('tieba-status').textContent=lines.join('\n');$('tieba-status').style.whiteSpace='pre-wrap';
  const accountBadge=$('tieba-account-badge');accountBadge.textContent=s.state==='logged_in'?'已登录':s.state==='waiting_login'?'等待登录':s.state==='expired'?'登录失效':'待确认';accountBadge.dataset.tone=s.state==='logged_in'?'success':s.state==='waiting_login'?'live':'neutral';
  const facts=$('tieba-account-facts');facts.replaceChildren();
  for(const [label,value] of [['当前账号',s.identity?s.identity.name+' · '+s.identity.id:s.lastIdentity?s.lastIdentity.name+'（上次确认）':'尚未确认'],['账号状态',labels[s.state]||s.state],['官网窗口',s.browserRunning?'运行中':'已关闭'],['最近验证',s.verifiedAt?queueTime(s.verifiedAt):'尚未验证']]){const pair=node('div');pair.append(node('dt','',label),node('dd','',value));facts.append(pair);}
  screenMode=interactive?s.interaction:'login';
  $('tieba-login').hidden=!(s.browserRunning&&(s.state==='waiting_login'||['publication','application'].includes(s.interaction)));
  $('tieba-start').disabled=interactive;$('tieba-check').disabled=interactive;
  $('tieba-login-actions').hidden=interactive;$('tieba-login-description').hidden=interactive;
  const w=application?null:s.publicationWork,stage=w?.stage,stageLabels={prepare_failed:'未能自动找到或填好官网编辑器，现场保留在下方；尚未提交。',preparing:'正在处理这次发言请求',prepared:'原回复已填入官网，尚未提交',started:'提交已开始，等待真实回执',challenge:s.interaction==='publication'?'贴吧已要求验证，请在下方官网画面操作。':'贴吧已要求验证，原窗口已关闭。打开本条人工验证可重新准备同一条原回复。',accepted:'已获得回执，等待公开确认',confirmed:'已从公开视角确认',rejected:'这次请求未发出或被拒绝，详情见实际回执',unknown:'回执不确定，仅可检查结果，不自动重发'};
  $('tieba-publication').hidden=!!application||!(s.publication?.needsHuman||w);
  const localGuard=w?.result?.receipt?.guardReason;
  $('tieba-publication-state').textContent=(stageLabels[stage]||'这次请求需要官网验证，可在下方操作。')+(w?.result?.receipt?.errorMessage?'\n平台提示：'+w.result.receipt.errorMessage:'')+(localGuard?'\n本地请求校验未通过（'+localGuard+'），发布请求未发往贴吧。':'');
  $('tieba-publication-preview').textContent=w?(w.input.action==='thread'?'新主题 '+w.input.title:'帖子 '+w.input.threadId)+'\n'+w.input.content:'';
  const stepNames={open_thread:'打开目标帖子',wait_reply_entry:'等待回复入口',locate_reply_target:'定位目标楼层或子回复',fill_reply_editor:'打开并填写编辑器',open_forum:'打开目标吧',wait_thread_entry:'等待发帖入口',wait_thread_editor:'加载新帖编辑器'};
  const receipt=w?.result?.receipt;
  if(receipt?.reason==='pre_submit_stalled'||receipt?.submission?.phase==='pre_submit_stalled')$('tieba-publication-state').textContent=failureText(w?.result?.error,receipt);
  if(receipt?.step)$('tieba-publication-state').textContent+='\n卡在：'+(stepNames[receipt.step]||receipt.step);
  if(receipt?.page?.notice)$('tieba-publication-state').textContent+='\n官网文字：'+receipt.page.notice;
  if(receipt?.pageNotice)$('tieba-publication-state').textContent+='\n官网页面提示：'+receipt.pageNotice;
  if(receipt?.submission)$('tieba-publication-state').textContent+='\n'+(submissionStages[receipt.submission.phase]||receipt.submission.phase);
  let evidenceBox=$('tieba-evidence');if(!evidenceBox){evidenceBox=node('details','tieba-card tieba-collapse');evidenceBox.id='tieba-evidence';$('tieba-publication').append(evidenceBox);}
  const shots=w?.evidence||[],key=(w?.requestId||'')+JSON.stringify(shots);
  let diagnosticBox=$('tieba-diagnostic');if(!diagnosticBox){diagnosticBox=node('details');diagnosticBox.id='tieba-diagnostic';$('tieba-publication').append(diagnosticBox);}diagnosticBox.hidden=!w?.result?.error;
  if(w?.result?.error){diagnosticBox.replaceChildren(node('summary','','技术诊断（内部码、失败步骤和正文差异）'),node('pre','',JSON.stringify({code:w.result.error,step:receipt?.step,click:receipt?.click,contentDifference:receipt?.contentDifference,page:receipt?.page,httpAttempts:receipt?.httpAttempts,notSubmitted:receipt?.notSubmitted,pageNotice:receipt?.pageNotice,submission:receipt?.submission},null,2)));}
  if(key!==evidenceKey){evidenceKey=key;for(const u of evidenceUrls)URL.revokeObjectURL(u);evidenceUrls=[];evidenceBox.replaceChildren();
   evidenceBox.hidden=!shots.length;evidenceBox.append(node('summary','','本次官网现场截图 · '+shots.length));
   const shotNames={pre_submit_stalled:'发布前停滞（尚未提交）',after_reply_click:'点击回复按钮后',after_reply_click_retry:'重新打开未展开的回复框后',prepared:'正文已填好（未提交）',prepare_failed:'自动准备失败现场',before_submit:'点击发布前',after_click:'点击发布后',response:'请求返回后的官网画面',unconfirmed:'未收到确认时的画面',waiting:'等待官网发布过程中的最新画面',submission_ended:'本次提交结束时的现场'};
   for(const shot of shots){const d=node('details'),summary=node('summary','',(shotNames[shot.stage]||shot.stage)+' · '+new Date(shot.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false}));d.append(summary);const requestId=w.requestId;
    d.addEventListener('toggle',async()=>{if(!d.open||d.dataset.loaded)return;d.dataset.loaded='loading';const note=node('p','hint','正在读取此次操作实际截图…');d.append(note);try{const r=await fetch('/api/tieba/publication-frame?'+new URLSearchParams({requestId,evidence:shot.id}),{headers:{authorization:'Bearer '+token},cache:'no-store'});if(!r.ok)throw Error((await r.json()).error||'截图读取失败');const u=URL.createObjectURL(await r.blob());if(!d.isConnected){URL.revokeObjectURL(u);return;}evidenceUrls.push(u);const img=node('img');img.src=u;img.alt=summary.textContent;img.style.maxWidth='100%';d.append(img);note.remove();d.dataset.loaded='yes';}catch(e){note.textContent=e.message;delete d.dataset.loaded;}});evidenceBox.append(d);
   }
  }
  $('tieba-publication-submit').hidden=stage!=='prepared'||s.interaction!=='publication';
  $('tieba-publication-check').hidden=!w||['preparing','prepared','prepare_failed'].includes(stage);
  $('tieba-publication-start').textContent=stage==='prepare_failed'?'重新定位官网编辑器':'打开官方发言验证';
  $('tieba-publication-start').disabled=!!w&&['started','accepted','unknown'].includes(stage);
  $('tieba-publication-start').hidden=stage==='confirmed';
  const activeId=application?.requestId||w?.requestId,a=lastAttempt&&(lastAttempt.requestId===activeId||lastAttempt.startedAt>=Math.max(w?.created||0,application?.created||0))?lastAttempt:null,matched=a?.requestId===activeId,result=application?.result|| (matched&&w?.result?w.result:a?.result||w?.result),request=application?{action:'moderator_application',content:application.declaration,forumId:application.forumId}:a?.request||w?.input;
  if(shownRequest&&shownRequest!==activeId){shownRequest=undefined;frameSerial++;screen.hidden=true;screen.removeAttribute('src');if(frameUrl){URL.revokeObjectURL(frameUrl);frameUrl=undefined;}}
  const queued=result?.deliveryStatus==='queued'||result?.queued===true;
  const problem=!queued&&(s.attention?.problem??(result?.error&&!(result.error==='TIEBA_PUBLICATION_NEEDS_HUMAN'&&!s.publication?.needsHuman)||!application&&s.publication?.needsHuman&&stage==='challenge'));
  const blocked=problem&&!s.attentionDismissed;
  $('tieba-attention').hidden=!blocked;
  $('tieba-alert').hidden=!blocked;
  const issue=result?.issue,detail=issue?'参数 '+issue.field+'：'+issue.reason:result?.receipt?.errorMessage||(result?.error?failureText(result.error,result?.receipt):'')||(application?'官网申请结果尚未确认':'贴吧要求安全验证');
  $('tieba-alert-text').textContent=(application?'肥鱼的小吧主申请需要处理：':'肥鱼的贴吧发言需要处理：')+detail;
  $('tieba-attempt').hidden=!a&&!w&&!application||!!w&&!application&&(!a||matched)&&!queued;
  const queuedDetail=queued?['已进入贴吧通用队列',result.queuePosition?'排队第 '+result.queuePosition+' 条':'',result.verificationPause?'等待手动恢复发送':result.scheduledAt?'预计 '+paceTime(result.scheduledAt)+' 发送（香港时间）':''].filter(Boolean).join(' · '):'';
  $('tieba-attempt-detail').textContent=[application?'小吧主申请 · 吧ID '+application.forumId:request?.threadId?'帖子 '+request.threadId:request?.title?'新主题 '+request.title:'',queued?queuedDetail:result?.stage==='input_validation'?'本地参数校验未通过，请求没有发往贴吧':result?.stage==='running'?'正在处理这次请求':result?.applicationStatus==='pending_approval'?'申请已提交，等待吧主审批':result?.applicationStatus==='already_moderator'?'官网确认已是小吧主':result?.applicationStatus==='eligible'?'官网允许填写申请感言，尚未提交':result?.published?'已确认公开可见':result?.deliveryStatus==='accepted'?'贴吧已接收，正在核对公开结果':detail,request?.content||'',a?.requestId||activeId||''].filter(Boolean).join('\n');
  for(const [id,item] of [['tieba-attempt',s.attention],['tieba-publication',w]]){
   const badge=$(id+'-badge'),needsAttention=id==='tieba-attempt'?problem:item?.problem;
   const waiting=id==='tieba-attempt'&&queued;
   badge.textContent=waiting?'已进入排队':item?.dismissed?'已忽略':needsAttention?'需处理':'当前记录';badge.dataset.tone=waiting?'live':item?.dismissed?'muted':needsAttention?'warning':'neutral';
   $(id).dataset.tone=badge.dataset.tone;
   $(id+'-ignore').hidden=!needsAttention&&!item?.dismissed;
  }
  for(const button of document.querySelectorAll('[data-tieba-dismiss="current"],[data-tieba-dismiss="publication"]')){
   const item=button.dataset.tiebaDismiss==='publication'?w:s.attention;
   button.disabled=!item?.requestId;button.textContent=item?.dismissed?'取消忽略':'忽略当前条目';
  }
  if(blocked){
   const key=(a?.requestId||activeId||'')+':'+detail+':'+(w?.result?.receipt?.httpAttempts||0);
   if(key!==announced){announced=key;pendingOpen=true;}
  }else pendingOpen=false;
  placeControls();
 }
 async function status(){const s=await call('tieba');render(s);return s;}
 async function frame(){
  const serial=++frameSerial,previous=frameUrl,scene=currentStatus?.browserScene;
  const requestId=currentStatus?.interaction==='application'?currentStatus.moderatorWork?.requestId:currentStatus?.interaction==='publication'?currentStatus.publicationWork?.requestId:undefined;
  $('tieba-frame-state').textContent='正在读取当前官网画面…';
  const r=await fetch(requestId?'/api/tieba/publication-frame?requestId='+encodeURIComponent(requestId):'/api/tieba/frame',{cache:'no-store',headers:{authorization:'Bearer '+token}});
  if(!r.ok){const e=await r.json();$('tieba-frame-state').textContent='当前画面未读到：'+failureText(e.error||'请求失败')+'，正在等待状态更新。';throw Error(e.error);}
  const blob=await r.blob();if(!blob.size||!blob.type.startsWith('image/'))throw Error('TIEBA_FRAME_INVALID');
  const next=URL.createObjectURL(blob),preview=new Image();preview.src=next;
  try{await preview.decode();}catch{URL.revokeObjectURL(next);$('tieba-frame-state').textContent='登录画面无法显示，请刷新页面。';throw Error('TIEBA_FRAME_DECODE_FAILED');}
  if(serial!==frameSerial||!dialog.open||scene!==currentStatus?.browserScene||requestId&&requestId!==(currentStatus?.interaction==='application'?currentStatus.moderatorWork?.requestId:currentStatus?.publicationWork?.requestId)){URL.revokeObjectURL(next);return;}
  screen.src=next;screen.hidden=false;frameUrl=next;displayedFrame={requestId,scene};
  $('tieba-frame-state').textContent=screenMode!=='login'?'这是当前官网画面，可直接点击、拖动完成验证。画面会自动更新。':'扫码或点击画面登录。画面会自动更新。';
  if(requestId&&shownRequest!==requestId){shownRequest=requestId;$('tieba-login').scrollIntoView({block:'start'});}
  if(previous)URL.revokeObjectURL(previous);
 }
 async function task(work,label='正在读取，请稍候…'){if(working){$('tieba-operation').textContent='上一项操作仍在等待反馈，可关闭窗口；不会重复提交。';return;}working=true;rowError.textContent='';if(selectedQueueId)rowProgress.textContent=label;$('tieba-error').textContent='';$('tieba-operation').textContent=label;dialog.setAttribute('aria-busy','true');try{await work();}catch(e){$('tieba-error').textContent='操作未完成：'+failureText(e.message,currentStatus?.publicationWork?.result?.receipt);if(selectedQueueId)rowError.textContent=$('tieba-error').textContent;await status().catch(()=>{});}finally{rowProgress.textContent='';working=false;$('tieba-operation').textContent='';dialog.removeAttribute('aria-busy');}}
 let sectionsRevision,sectionsLoading=false;
 const sectionsMessage=$('tieba-sections-message'),sectionsForm=$('tieba-sections-form');
 function showTiebaTab(tab){
  for(const name of ['account','pending','sections']){
   $('tieba-'+name+'-panel').hidden=name!==tab;
   $('tieba-'+name+'-tab').setAttribute('aria-pressed',String(name===tab));
  }
  dialog.scrollTop=0;
 }
 async function loadSections(){
  if(sectionsLoading)return;sectionsLoading=true;$('tieba-sections-retry').hidden=true;sectionsMessage.textContent='正在读取大肥鱼吧分区…';
  try{
   const data=await api('tieba/sections');sectionsRevision=data.revision;$('tieba-sections-guidance').value=data.guidance;
   const fields=$('tieba-sections-fields');fields.replaceChildren();
   for(const section of data.sections){
    const label=node('label','',section.name),input=node('textarea');input.rows=3;input.maxLength=400;input.dataset.sectionId=section.id;input.value=section.suggestion;
    label.append(input);fields.append(label);
   }
   sectionsForm.hidden=false;sectionsMessage.textContent='';
  }catch(e){sectionsMessage.textContent='暂时读不到实时分区，请重试。';$('tieba-sections-retry').hidden=false;}
  finally{sectionsLoading=false;}
 }
 $('tieba-account-tab').onclick=()=>{showTiebaTab('account');void refreshQueue();};
 $('tieba-pending-tab').onclick=()=>{showTiebaTab('pending');void refreshPending();};
 $('tieba-sections-tab').onclick=()=>{showTiebaTab('sections');if(!sectionsRevision)void loadSections();};
 $('tieba-sections-retry').onclick=loadSections;
 sectionsForm.onsubmit=async e=>{
  e.preventDefault();const button=$('tieba-sections-save');if(button.disabled||sectionsLoading)return;button.disabled=true;
  try{
   const suggestions=Object.fromEntries([...$('tieba-sections-fields').querySelectorAll('textarea')].map(input=>[input.dataset.sectionId,input.value]));
   const saved=await api('tieba/sections',{revision:sectionsRevision,guidance:$('tieba-sections-guidance').value,suggestions});
   sectionsRevision=saved.revision;sectionsMessage.textContent='已保存，下次查询大肥鱼吧分区时生效。';
  }catch(e){
   sectionsMessage.textContent=e.message==='TIEBA_SECTION_SETTINGS_CHANGED'?'另一个页面已保存修改。请先复制本页草稿，再重新加载。':'保存未完成，请检查提示长度后重试。';
   if(e.message==='TIEBA_SECTION_SETTINGS_CHANGED')$('tieba-sections-retry').hidden=false;
  }finally{button.disabled=false;}
 };
 const input=v=>task(async()=>{if(!displayedFrame?.scene||screen.hidden||displayedFrame.scene!==currentStatus?.browserScene)throw Error('TIEBA_PUBLICATION_WINDOW_CHANGED');const s=await call('tieba/input',{...v,...displayedFrame});render(s);if(s.frameImage)applyInlineFrame(s,displayedFrame.scene,displayedFrame.requestId);else if(s.browserRunning)await frame();},'正在处理点击；如果点击了发布，正在等待官网回执…');
 function open(){pendingOpen=false;closeDrawers(false);if(!dialog.open)dialog.showModal();void refreshQueue();void refreshPending();void task(async()=>{const s=await status();if(s.browserRunning&&(s.state==='waiting_login'||['publication','application'].includes(s.interaction)))await frame();});}
 function maybeOpen(){if(!pendingOpen||document.hidden||document.querySelector('dialog[open]')&&!dialog.open)return;if(!dialog.open)open();else pendingOpen=false;}
 $('tieba-button').onclick=open;$('tieba-alert-open').onclick=()=>{showTiebaTab('account');selectQueueReply(undefined);open();};
 $('tieba-start').onclick=()=>task(async()=>{render(await call('tieba/start',{}));await frame();},'正在打开官方登录页面…');
 $('tieba-account-refresh').onclick=()=>task(async()=>{const a=await api('tieba/account',{});$('tieba-following').textContent=a.account.name+' · UID '+a.account.id+'\n'+a.following.map(f=>f.name+'吧 · '+f.id).join('\n');$('tieba-posting-policy').textContent=(a.posting.needsHuman?'上次请求收到贴吧验证要求；不阻止新的独立请求。\n':'')+(a.posting.mode==='preview'?'预演模式：只保存，不真实发布；仅已关注的贴吧允许准备发言。':a.posting.mode==='live'?'仅已关注的贴吧允许真实发言；其他贴吧只读。':'发言配置不可读，当前不能发帖。');});
 let historyPage,historyLoading=false;
 const historyLabels={preview:'预演',rejected:'失败或需验证',held:'处理中',unknown:'结果不确定',accepted:'已受理',confirmed:'公开成功',deleted:'已删除'};
 function updateHistoryPagination(){
  $('tieba-actions-refresh').disabled=historyLoading;
  $('tieba-actions-prev').disabled=historyLoading||!historyPage?.offset;
  $('tieba-actions-next').disabled=historyLoading||!historyPage?.hasMore;
 }
 async function loadHistory(offset=0){
  if(historyLoading)return;
  historyLoading=true;updateHistoryPagination();
  const message=$('tieba-actions-message');message.textContent='正在读取发言记录…';
  try{
   const page=await api('tieba/actions?offset='+offset),container=$('tieba-actions');
   container.replaceChildren();
   for(const row of page.items){
    const request=row.request??{},label=request.title||request.content||row.id;
    const details=node('details'),summary=node('summary','',`${queueTime(row.created)} · ${historyLabels[row.state]||row.state} · ${label.slice(0,80)}`);
    details.append(summary,node('pre','',JSON.stringify(row,null,2)));container.append(details);
   }
   historyPage=page;$('tieba-actions-pagination').hidden=false;
   $('tieba-actions-page').textContent=recordRange(page.offset,page.items.length,page.total);
   message.textContent=page.items.length?'':'这一页没有发言记录。';
  }catch(e){message.textContent='发言记录读取失败：'+failureText(e.message);}
  finally{historyLoading=false;updateHistoryPagination();}
 }
 $('tieba-actions-refresh').onclick=()=>void loadHistory();
 $('tieba-actions-prev').onclick=()=>{if(historyPage?.offset)void loadHistory(Math.max(0,historyPage.offset-historyPage.limit));};
 $('tieba-actions-next').onclick=()=>{if(historyPage?.hasMore)void loadHistory(historyPage.offset+historyPage.limit);};
 $('tieba-check').onclick=()=>task(async()=>{const s=await api('tieba/check',{});render(s);if(s.browserRunning&&s.state==='waiting_login')await frame();});
 for(const [id,action,label] of [['start','publication-start','正在打开官网并填入原回复，尚未发布…'],['submit','publication-submit','正在提交原回复并等待官网反馈…'],['check','publication-check','正在只读核对公开发布结果…']])$('tieba-publication-'+id).onclick=()=>task(async()=>{const id=currentStatus?.publicationWork?.requestId;
  if(!id)throw Error('TIEBA_PUBLICATION_NOT_FOUND');
  const s=await call('tieba/'+action,{requestId:id});
  if(action==='publication-check')await status();else render(s);if(currentStatus?.interaction==='publication')await frame();},label);
 $('tieba-status-refresh').onclick=()=>task(status);$('tieba-frame-refresh').onclick=()=>task(frame);
 $('tieba-logout').onclick=()=>task(async()=>{render(await api('tieba/logout',{}));screen.removeAttribute('src');if(frameUrl){URL.revokeObjectURL(frameUrl);frameUrl=undefined;}});
 $('tieba-dismiss').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{if(activePointer){activePointer.ended=true;activePointer.cancelled=true;activePointer.endPoint=activePointer.latest;if(activePointer.dragging)void pumpDrag(activePointer);else{activePointer=null;drag=undefined;screen.classList.remove('dragging');}}frameSerial++;screen.hidden=true;if(frameUrl){URL.revokeObjectURL(frameUrl);frameUrl=undefined;}screen.removeAttribute('src');$('tieba-text').value='';const pending=currentStatus?.interaction==='application'||currentStatus?.interaction==='publication'&&['preparing','prepared','prepare_failed','challenge'].includes(currentStatus?.publicationWork?.stage);if(!pending)void api('tieba/close',{}).catch(()=>{});});
 window.addEventListener('fish-tieba-status',event=>{
  lastAttempt=event.detail.attempt;if(!event.detail.status)return;render(event.detail.status);maybeOpen();void live();
 });
 document.addEventListener('close',()=>{queueMicrotask(maybeOpen);},true);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){maybeOpen();if(dialog.open)void live();}});
 async function live(){
  if(!dialog.open||!$('tieba-sections-panel').hidden||document.hidden||working||drag||refreshing)return;
  if(rowOpening||selectedQueueId&&!belongsTo(currentStatus?.publicationWork,selectedQueueId)||queueData?.workerBusy)return;refreshing=true;
  try{
   let s=currentStatus,w=s?.interaction==='application'||s?.moderatorWork?.created>=(s?.publicationWork?.created||Infinity)?null:s?.publicationWork;
   // Late native captcha success only needs one read-only reconciliation.
   const key=w?.requestId+':'+w?.result?.id;
   if(w?.stage==='accepted'&&w.result?.id&&verified!==key){verified=key;await call('tieba/publication-check',{requestId:w.requestId});s=await status();}
   if(s?.browserRunning&&(s.state==='waiting_login'||['publication','application'].includes(s.interaction)))await frame();
  }catch(e){$('tieba-frame-state').textContent='等待当前窗口更新：'+e.message;}
  finally{refreshing=false;}
 }
 for(const [id,key] of [['tab','Tab'],['enter','Enter'],['backspace','Backspace'],['selectall','SelectAll']])$('tieba-'+id).onclick=()=>input({kind:'key',key});
 $('tieba-scroll-up').onclick=()=>input({kind:'scroll',delta:-500});$('tieba-scroll-down').onclick=()=>input({kind:'scroll',delta:500});
 $('tieba-input-form').onsubmit=e=>{e.preventDefault();const text=$('tieba-text').value;$('tieba-text').value='';if(text)void input({kind:'text',text});};
 function applyInlineFrame(data,scene,requestId){
  if(!data?.frameImage)return false;
  ++frameSerial;
  const previous=frameUrl;
  frameUrl=undefined;
  screen.src='data:'+(data.frameMime||'image/jpeg')+';base64,'+data.frameImage;
  screen.hidden=false;
  displayedFrame={requestId,scene};
  if(previous)URL.revokeObjectURL(previous);
  return true;
 }
 function point(e){const r=screen.getBoundingClientRect();return {x:Math.max(0,Math.min(999,(e.clientX-r.left)*1000/r.width)),y:Math.max(0,Math.min(799,(e.clientY-r.top)*800/r.height))};}
 let activePointer=null;
 async function finishDrag(state){
  const pos=state.endPoint||state.latest;
  const shouldRelease=!!state.lastSent;
  const fallbackDrag=!shouldRelease&&!state.cancelled;
  activePointer=null;
  drag=undefined;
  screen.classList.remove('dragging');
  if(fallbackDrag){
   await input({kind:'drag',x:state.start.x,y:state.start.y,toX:pos.x,toY:pos.y});
   return;
  }
  if(!shouldRelease)return;
  await task(async()=>{
   const s=await call('tieba/input',{kind:'pointer_up',x:pos.x,y:pos.y,requestId:state.requestId,scene:state.scene});
   render(s);
   if(s.frameImage)applyInlineFrame(s,state.scene,state.requestId);
   else if(s.browserRunning)await frame();
   if(!s.browserRunning)return;
   $('tieba-frame-state').textContent=screenMode!=='login'?'拖动已完成，可继续验证或检查发布结果。':'拖动已完成，可继续操作或确认登录。';
  },'正在松开并更新官网画面…');
 }
 async function pumpDrag(state){
  if(state.inFlight)return;
  state.inFlight=true;
  try{
   while(state.dragging){
    if(state.ended){
     state.dragging=false;
     state.inFlight=false;
     await finishDrag(state);
     return;
    }
    const target={x:state.latest.x,y:state.latest.y};
    let payload;
    if(!state.lastSent){
     payload={kind:'pointer_down',x:state.start.x,y:state.start.y,toX:target.x,toY:target.y,requestId:state.requestId,scene:state.scene};
    }else if(Math.hypot(target.x-state.lastSent.x,target.y-state.lastSent.y)>=1.5){
     payload={kind:'pointer_move',x:target.x,y:target.y,requestId:state.requestId,scene:state.scene};
    }else{
     break;
    }
    try{
     const s=await call('tieba/input',payload);
     state.lastSent=target;
     if(s.frameImage)applyInlineFrame(s,state.scene,state.requestId);
    }catch(e){
     if(e.message==='TIEBA_BUSY'&&!state.ended){
      await new Promise(r=>setTimeout(r,100));
      continue;
     }
     if(e.message==='TIEBA_PUBLICATION_WINDOW_CHANGED'||e.message==='TIEBA_LOGIN_NOT_OPEN'){
      state.dragging=false;
      state.lastSent=null;
      activePointer=null;
      drag=undefined;
      screen.classList.remove('dragging');
      $('tieba-error').textContent='操作未完成：'+failureText(e.message);
      await status().catch(()=>{});
      return;
     }
     if(state.ended){
      state.dragging=false;
      state.inFlight=false;
      await finishDrag(state);
      return;
     }
     await new Promise(r=>setTimeout(r,80));
    }
   }
  }finally{
   state.inFlight=false;
  }
 }
 screen.onpointerdown=e=>{
  if(working||activePointer||!displayedFrame?.scene||screen.hidden||displayedFrame.scene!==currentStatus?.browserScene)return;
  e.preventDefault();
  const start=point(e);
  drag=start;
  activePointer={pointerId:e.pointerId,start,latest:start,lastSent:null,dragging:false,inFlight:false,ended:false,cancelled:false,endPoint:null,scene:displayedFrame.scene,requestId:displayedFrame.requestId};
  try{screen.setPointerCapture(e.pointerId);}catch{}
 };
 screen.onpointermove=e=>{
  if(!activePointer||e.pointerId!==activePointer.pointerId||activePointer.ended)return;
  e.preventDefault();
  activePointer.latest=point(e);
  if(!activePointer.dragging){
   if(Math.hypot(activePointer.latest.x-activePointer.start.x,activePointer.latest.y-activePointer.start.y)<=5)return;
   activePointer.dragging=true;
   screen.classList.add('dragging');
   $('tieba-frame-state').textContent='正在实时拖动…画面会跟随更新，松手完成验证。';
  }
  void pumpDrag(activePointer);
 };
 function endPointer(e,cancelled){
  if(!activePointer||e.pointerId!==activePointer.pointerId)return;
  e.preventDefault();
  const state=activePointer,end=point(e);
  if(!state.dragging){
   activePointer=null;
   drag=undefined;
   screen.classList.remove('dragging');
   if(!cancelled)void input({kind:'click',...end});
   return;
  }
  state.ended=true;
  state.cancelled=cancelled;
  state.endPoint=end;
  void pumpDrag(state);
 }
 screen.onpointerup=e=>endPointer(e,false);
 screen.onpointercancel=e=>endPointer(e,true);
 screen.ondragstart=e=>e.preventDefault();
 $('tieba-read-form').onsubmit=e=>{e.preventDefault();void task(async()=>{let url=$('tieba-read-url').value.trim();if(!url)return;if(!/^https:\/\//.test(url))url='https://tieba.baidu.com/f?kw='+encodeURIComponent(url);const r=await api('tieba/read',{url,mode:$('tieba-read-mode').value});$('tieba-read-result').textContent=JSON.stringify(r,null,2);await status();});};
})();
