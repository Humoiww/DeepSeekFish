'use strict';
(function(){
  const dialog=$('neon-dialog'),list=$('neon-list'),detail=$('neon-detail');
  const tabs=[...dialog.querySelectorAll('[data-neon-tab]')];
  const labels={triage:'Neon 分诊',codex:'Codex 改码',codex_retry:'Codex 返工',verify:'独立验证',review:'Neon Review',
    code:'正在开发',candidate:'候选编译',deploy:'部署切换',live:'上线核对',done:'已完成',blocked:'遇到问题',cancelled:'已打断'};
  const role={user:'用户',assistant:'助手',tool:'工具',bridge:'桥接'};
  const formatter=new Intl.DateTimeFormat('zh-HK',{timeZone:'Asia/Hong_Kong',dateStyle:'short',timeStyle:'medium',hour12:false});
  const date=at=>at?formatter.format(new Date(at)):'';
  const stop=$('neon-stop'),reset=$('neon-reset-conversation'),feedback=$('neon-feedback');
  let snapshot,tab='agy',selected,request,timer,pending,monitorVersion,listVersion,detailVersion,patchTaskId;

  let resetRequest,resetPosting=false;

  function notice(message=''){
    feedback.hidden=!message;
    feedback.textContent=message;
  }
  function eventNodes(steps){
    return steps.map(step=>{
      const row=node('li','neon-event'),heading=node('b','',step.title);
      row.append(heading,node('small','muted',[date(step.at),role[step.role]??step.role,
        step.exitCode==null?'':'退出码 '+step.exitCode].filter(Boolean).join(' · ')));
      if(step.text)row.append(node('pre','neon-text',step.text));
      return row;
    });
  }
  function renderMonitor(){
    const bridge=snapshot.bridge,current=snapshot.active[0];
    const conversation=$('neon-conversation'),id=bridge?.mainConversation?.conversationId;
    conversation.textContent=id?'主会话 '+id.slice(0,8):bridge?'主会话待建立':'主会话状态暂不可读';
    const receipt=snapshot.conversationReset;
    if(resetRequest&&receipt?.id===resetRequest&&(receipt.error||bridge?.updatedAt>=receipt.at)){
      resetRequest=undefined;
      notice(receipt.error?'重置请求未确认 · '+receipt.error:'Neon 和 Codex 主会话已重置，下次使用时开启新对话。');
    }
    reset.disabled=!bridge||resetPosting||!!resetRequest;
    const phase=['candidate','deploy','live'].includes(current?.phase)?current.phase:bridge?.stage??current?.agyStage??current?.phase;
    const start=bridge?.startedAt??current?.createdAt;
    $('neon-stage').textContent=snapshot.busy?(labels[phase]??'正在开发'):'空闲';
    const seconds=start?Math.max(0,Math.floor((Date.now()-start)/1000)):0;
    $('neon-elapsed').textContent=start&&snapshot.busy?'已用 '+Math.floor(seconds/60)+' 分 '+seconds%60+' 秒':'';
    const events=bridge?.recentEvents??[],key=JSON.stringify(events);
    if(key!==monitorVersion){
      const target=$('neon-events');
      const atBottom=target.scrollHeight-target.scrollTop-target.clientHeight<20;
      target.replaceChildren(...eventNodes(events));
      target.hidden=!events.length;
      if(atBottom)target.scrollTop=target.scrollHeight;
      monitorVersion=key;
    }
    if(pending&&!snapshot.active.some(task=>task.id===pending)&&bridge?.activeTaskId!==pending){
      const task=snapshot.tasks.find(item=>item.id===pending);
      pending=undefined;
      notice(task?.phase==='cancelled'?'当前开发任务已打断。':'该任务已结束，请查看执行记录。');
    }
    stop.disabled=!!pending||!snapshot.active.some(task=>task.interruptible);
    stop.textContent=pending?'正在打断…':'手动打断当前工作';
    $('neon-badge').hidden=!snapshot.busy;
  }
  const entryName=entry=>tab==='tasks'?entry.goal||entry.id:entry.id;
  const detailKey=entry=>tab+':'+entry.id+':'+entry.updatedAt+':'+(entry.bytes??'');
  function renderList(){
    const entries=tab==='tasks'?snapshot.tasks:snapshot.records.filter(entry=>entry.kind===tab);
    if(!entries.some(entry=>entry.id===selected))selected=entries[0]?.id;
    const key=JSON.stringify([tab,selected,entries]);
    if(listVersion!==key){
      const buttons=entries.map(entry=>{
        const button=node('button','neon-row'+(entry.id===selected?' selected':''),entryName(entry));
        button.type='button';
        button.setAttribute('aria-pressed',String(selected===entry.id));
        button.append(node('small','muted',[labels[entry.phase],date(entry.updatedAt)].filter(Boolean).join(' · ')));
        button.onclick=()=>{selected=entry.id;renderList();};
        return button;
      });
      list.replaceChildren(...(buttons.length?buttons:[node('p','muted','暂无记录')]));
      listVersion=key;
    }
    const entry=entries.find(row=>row.id===selected);
    if(!entry){
      detailVersion=undefined;
      detail.replaceChildren();
    }else if(detailVersion!==detailKey(entry)){
      detailVersion=detailKey(entry);
      patchTaskId=undefined;
      if(tab==='tasks')renderTask(entry);
      else void loadRecord(entry);
    }else if(tab==='codex')refreshPatch();
  }
  function renderTask(task){
    const fields=[['状态',labels[task.phase]],['任务 ID',task.id],['最近更新',date(task.updatedAt)],
      ['上线版本',task.deployedRevision],['上线时间',date(task.deployedAt)],['最近步骤',task.codexStep],
      ['原因',task.reason],['回执',task.report],['交付说明',task.codexHandoff]];
    const values=node('dl','neon-fields');
    for(const [name,value] of fields)if(value)values.append(node('dt','muted',name),node('dd','',value));
    detail.replaceChildren(node('h3','',task.goal||'开发任务'),values);
  }
  async function loadRecord(entry){
    const version=detailKey(entry);
    detail.replaceChildren(node('p','muted','正在读取实际记录…'));
    try{
      const query=new URLSearchParams({kind:entry.kind,id:entry.id});
      const record=await api('neon/record?'+query);
      if(detailVersion!==version||!dialog.open)return;
      const events=node('ol','neon-history');
      events.append(...eventNodes(record.steps));
      detail.replaceChildren(node('h3','',entry.id),
        node('p','muted',date(record.record.updatedAt)+(record.record.taskId?' · 任务 '+record.record.taskId:'')),
        record.steps.length?events:node('p','muted','没有可显示的事件'));
      if(record.truncated)detail.append(node('p','muted','较长的记录已截断。'));
      if(entry.kind==='codex'){
        patchTaskId=record.record.taskId;
        refreshPatch();
      }
    }catch(error){
      if(detailVersion===version&&dialog.open){
        detail.replaceChildren(node('p','form-error','读取记录失败 · '+error.message));
        detailVersion=undefined;
      }
    }
  }
  function refreshPatch(){
    if(!patchTaskId||detail.querySelector('.neon-patch'))return;
    const patch=snapshot.records.find(item=>item.kind==='patch'&&item.id===patchTaskId);
    if(!patch)return;
    const panel=node('details','neon-patch');
    panel.append(node('summary','','改动补丁'));
    panel.addEventListener('toggle',async()=>{
      if(!panel.open||panel.dataset.loaded)return;
      panel.dataset.loaded='1';
      try{
        const result=await api('neon/record?'+new URLSearchParams({kind:'patch',id:patch.id}));
        panel.append(node('pre','neon-text',result.patch||'补丁为空'));
        if(result.truncated)panel.append(node('p','muted','补丁已截断。'));
      }catch(error){panel.append(node('p','form-error','读取补丁失败 · '+error.message));}
    });
    detail.append(panel);
  }
  async function refresh(){
    if(!dialog.open||request)return;
    clearTimeout(timer);
    const controller=new AbortController();
    request=controller;
    try{
      const next=await api('neon',undefined,controller.signal);
      if(request!==controller)return;
      snapshot=next;
      if(feedback.textContent.startsWith('读取失败'))notice();
      renderMonitor();
      renderList();
    }catch(error){
      if(!controller.signal.aborted)notice('读取失败 · '+error.message);
    }finally{
      if(request===controller){
        request=undefined;
        if(dialog.open&&(snapshot?.busy||pending||resetRequest))timer=setTimeout(refresh,2000);
      }
    }
  }
  $('neon-button').onclick=()=>{
    closeDrawers(false);
    dialog.showModal();
    void refresh();
  };
  $('neon-close').onclick=()=>dialog.close();
  $('neon-refresh').onclick=()=>void refresh();
  dialog.addEventListener('close',()=>{
    clearTimeout(timer);
    request?.abort();
    request=undefined;
    detailVersion=undefined;
  });
  window.addEventListener('fish-neon-status',event=>{
    if(event.detail&&dialog.open&&!snapshot?.busy)void refresh();
  });
  for(const button of tabs)button.onclick=()=>{
    tab=button.dataset.neonTab;
    selected=undefined;
    for(const other of tabs)other.setAttribute('aria-pressed',String(button===other));
    if(snapshot)renderList();
  };
  reset.onclick=async()=>{
    if(resetPosting||resetRequest)return;
    resetPosting=true;
    reset.disabled=true;
    try{
      const result=await api('neon/reset-conversation',{});
      resetRequest=result.requestId;
      notice('已请求重置，正在等待后台确认。');
    }catch(error){notice('重置失败 · '+error.message);}
    finally{
      resetPosting=false;
      if(snapshot)renderMonitor();
      await refresh();
    }
  };
  stop.onclick=async()=>{
    const target=snapshot?.active.find(task=>task.interruptible);
    if(!target||pending)return;
    pending=target.id;
    renderMonitor();
    notice('已请求打断，正在等待后台确认。');
    try{await api('neon/interrupt',{taskId:target.id});}
    catch(error){pending=undefined;notice('打断失败 · '+error.message);renderMonitor();}
    await refresh();
  };
})();
