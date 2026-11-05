'use strict';
(()=>{
  document.addEventListener('exploration-history',async e=>{closeDrawers();for(const id of ['activity-state','activity-conversation','activity-from','activity-to','activity-query'])$(id).value='';$('activity-kind').value='exploration';offset=0;$('activity-dialog').showModal();await refresh(true);if(e.detail)await openDetail('exploration:'+e.detail);});
  const kindNames={qq:'QQ 对话',web:'网页对话',news:'早间新闻',memory:'记忆回顾',diary:'空间动态',image:'Codex 生图',audit:'系统事件',exploration:'自主探索'};
  const stateNames={unconfirmed:'送达未确认',paused:'已暂停',cancelled:'已停止',interrupted:'重启中断',completed:'已完成',failed:'失败',partial:'部分失败',running:'进行中',pending:'等待结果',unknown:'状态未记录'};
  const toolNames={read_curiosity:'翻阅好奇心日志',write_curiosity:'更新好奇心日志',read_exploration:'回看探索',send_message:'主动私聊',propose_project:'提出创意',finish_exploration:'结束闲逛',publish_qzone:'发布空间',reply:'回复消息',search_web:'联网搜索',fetch_page:'查询网页',browse_page:'浏览网页',download_image:'下载图片',generate_image:'请求生图',send_image:'发送成图',send_meme:'发送表情',list_images:'浏览图库',view_images:'查看原图',collect_meme:'收藏表情',remember_images:'记录图片',get_knowledge:'读取知识库',update_knowledge:'更新知识库',recall_chat:'翻阅聊天历史',read_forward:'读取转发记录',get_qzone:'读取空间动态',get_person:'查看 QQ 资料',get_quota:'查看额度',read_tool_result:'继续读取工具结果',draft_news:'准备新闻',finish_memory:'完成记忆回顾',image_plan:'设计画面',codex_record:'Codex 返回结果'};
  let offset=0,next=null,selected=null,sequence=0,detailSequence=0,searchTimer,items=[];
  const number=n=>Number(n||0).toLocaleString('zh-CN');
  const splitKnown=u=>Number.isSafeInteger(u?.cachedInput)&&Number.isSafeInteger(u?.uncachedInput);
  const usageText=u=>u?'输入 '+number(u.input)+' / 输出 '+number(u.output)+' token\n'+(splitKnown(u)?'缓存输入 '+number(u.cachedInput)+' / 未缓存输入 '+number(u.uncachedInput):'缓存拆分：未记录'):'输入 / 输出 token 未记录';
  const cacheText=u=>u.cacheKnownCalls?'缓存输入 '+number(u.cachedInput)+' / 未缓存输入 '+number(u.uncachedInput)+(u.cacheUnknownInput?'；另有 '+number(u.cacheUnknownInput)+' 输入未拆分':''):'缓存拆分：未记录';
  function usagePanel(u){
    const panel=node('div','activity-usage-panel');
    for(const [label,value] of [['输入 token',u.known?number(u.input):'未返回'],['缓存输入',u.cacheKnownCalls?number(u.cachedInput):'未记录'],['未缓存输入',u.cacheKnownCalls?number(u.uncachedInput):'未记录'],['输出 token',u.known?number(u.output):'未返回']]){const cell=node('div');cell.append(node('small','',label),node('strong','',value));panel.append(cell);}
    if(u.cacheUnknownInput)panel.append(node('p','activity-usage-note','另有 '+number(u.cacheUnknownInput)+' 输入 token 未记录缓存拆分。'));
    if(u.unreportedCalls)panel.append(node('p','activity-usage-note',number(u.unreportedCalls)+' 次模型调用未提供用量，未计入这些数字。'));
    if(u.unconfirmedTokens)panel.append(node('p','activity-usage-note',number(u.unconfirmedTokens)+' token 预留未确认，并非已确认消耗；账本保留这笔预留。'));
    return panel;
  }
  const date=n=>n?new Date(n).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'时间未记录';
  const conversation=v=>v.startsWith('private:')?'私聊 · '+v.slice(8):v.startsWith('web:')?'网页 · '+v.slice(4,12):v.startsWith('QQ ')?v:v?'群聊 · '+v:'未记录会话';
  function block(title,value,expanded=false){
    const details=node('details','activity-block'),summary=node('summary','',title);details.open=expanded;details.append(summary);
    const text=typeof value==='string'?value:JSON.stringify(value,null,2),pre=node('pre','activity-json',text);details.append(pre);return details;
  }
  function requestBlock(request){
    const details=node('details','activity-block');details.append(node('summary','','本次实际输入 · '+(request.messages?.length||0)+' 条消息'));
    const roles={system:'系统',user:'用户',assistant:'大肥鱼',tool:'工具结果'};
    for(const [i,m] of (request.messages||[]).entries()){
      const part=node('details','activity-block');part.open=m.role==='user'||m.role==='assistant';
      part.append(node('summary','',(i+1)+'. '+m.role+' · '+(roles[m.role]||m.role)+(m.tool_call_id?' · '+m.tool_call_id:'')),node('pre','activity-json',typeof m.content==='string'?m.content:JSON.stringify(m.content,null,2)));
      if(m.tool_calls?.length)part.append(block('原生工具调用',m.tool_calls,true));details.append(part);
    }
    const {messages,...options}=request;details.append(block('模型参数与当轮可用工具',options));return details;
  }
  function failureSummary(e){
    const d=e.diagnostic??e.result?.diagnostic,items=Array.isArray(d)?d:d?[d]:[];
    const causes=items.map(item=>{const chain=[];for(let at=item;at;at=at.cause)chain.push((at.name?at.name+': ':'')+(at.message||at.code||''));return chain.join('\n↳ ');});
    return [e.name+(e.modelCall?' · 调用 #'+e.modelCall:'')+(e.round===undefined?'':' · 第 '+(e.round+1)+' 轮')+(e.durationMs===undefined?'':' · '+(e.durationMs/1000).toFixed(2)+' 秒'),e.result?.error,...(causes.length?causes:['旧记录未保存更多异常详情'])].filter(Boolean).join('\n');
  }
  function tag(state){return node('span','activity-state state-'+state,stateNames[state]||state);}
  function stats(t){
    const box=$('activity-stats');box.replaceChildren();
    for(const [label,value,note] of [['活动记录',t.records,'含异常 '+number(t.errors)+' 次'],['DeepSeek token',t.tokens,'输入 '+number(t.input)+' / 输出 '+number(t.output)+'\n'+cacheText(t)],['模型调用',t.modelCalls,'未提供用量 '+number(t.unknownUsage)+' 条'],['搜索 / 查询',t.search+t.fetch,'搜索 '+number(t.search)+' / 查询 '+number(t.fetch)],['浏览 / 下载',t.browse+t.downloads,'浏览 '+number(t.browse)+' / 下载 '+number(t.downloads)],['生图 / 分享',t.images+t.sends,'生图调用 '+number(t.images)+' / 发送调用 '+number(t.sends)]]){
      const card=node('div','activity-stat');card.append(node('span','',label),node('strong','',number(value)),node('small','',note));box.append(card);
    }
  }
  function renderList(){
    const list=$('activity-list');list.replaceChildren();
    if(!items.length){list.append(node('p','activity-empty','没有符合条件的记录。可以清除日期或关键词后重试。'));return;}
    for(const r of items){
      const row=node('button','activity-row'+(selected===r.id?' selected':''));row.type='button';row.setAttribute('aria-pressed',String(selected===r.id));
      const top=node('div','activity-row-top');top.append(node('span','',kindNames[r.kind]||r.kind),tag(r.state));row.append(top,node('strong','activity-row-title',r.title||'未记录请求'),node('small','',date(r.at)+' · '+conversation(r.conversation)));
      const usage=r.usage.known?number(r.usage.total)+' token':'token 未记录';row.append(node('span','activity-row-metrics',usage+' · '+number(r.counts.tools)+' 次工具调用'+(r.errors?' · '+r.errors+' 次异常':'')));
      row.onclick=()=>openDetail(r.id);list.append(row);
    }
  }
  async function openDetail(id){
    selected=id;renderList();const version=++detailSequence,box=$('activity-detail');$('activity-body').classList.add('has-selection');
    box.replaceChildren(node('p','muted','正在读取完整记录…'));
    try{
      const r=await api('activity/detail?id='+encodeURIComponent(id));if(version!==detailSequence)return;
      box.replaceChildren();box.scrollTop=0;
      const toolbar=node('div','activity-detail-toolbar'),back=node('button','quiet-button activity-back','← 返回列表');back.type='button';back.onclick=()=>{selected=null;++detailSequence;$('activity-body').classList.remove('has-selection');renderList();};
      const download=node('button','quiet-button','下载记录');download.type='button';download.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(r,null,2)],{type:'application/json'})),a=node('a');a.href=url;a.download=r.id.replace(':','-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
      toolbar.append(back,tag(r.state),download);box.append(toolbar,node('h3','',kindNames[r.kind]||r.kind),node('p','activity-detail-meta',date(r.at)+' · '+conversation(r.conversation)+(r.speaker?' · 发言者 '+r.speaker:'')+(r.durationMs!==null?' · '+(r.durationMs/1000).toFixed(1)+' 秒':'')));
      box.append(block(r.kind==='image'?'生图提示词':'问题 / 任务',r.title,true));
      const failures=r.events.filter(e=>e.state==='failed');
      if(failures.length)box.append(block('失败位置与原因',failures.map(failureSummary).join('\n\n'),true));
      if(r.reply)box.append(block('回复 / 结果',r.reply,true));
      box.append(node('p','activity-detail-meta',r.usage.known?'已记录输入 '+number(r.usage.input)+' + 输出 '+number(r.usage.output)+' = '+number(r.usage.total)+' token':r.usage.unreportedCalls?'模型没有返回 token 用量，实际消耗未确认。':'这条记录没有保存 DeepSeek token 用量。'));
      if(r.usage.known||r.usage.calls)box.append(usagePanel(r.usage));
      if(r.related.length){const related=node('div','activity-related');related.append(node('span','','关联生图记录：'));for(const id of r.related){const b=node('button','quiet-button',id.slice(6,14)+' ↗');b.type='button';b.onclick=()=>openDetail(id);related.append(b);}box.append(related);}
      if(r.kind==='image')void previewImage(r.id,box,version);
      box.append(node('h3','',r.events.length?'调用与动作':'没有保存调用明细'));
      if(r.events.some(e=>e.type==='model'))box.append(node('p','activity-detail-meta','每个动作列出关联模型调用的用量。同次调用的多个动作共享这笔用量，总计只加一次；工具返回内容计入后续模型输入。'));
      for(const [i,e] of r.events.entries()){
        const step=node('details','activity-step'),summary=node('summary'),name=toolNames[e.name]||e.name;
        const title=node('span','activity-step-title',name+(e.type==='tool'?' · '+e.name:e.modelCall?' · 调用 #'+e.modelCall:''));
        if(e.type==='model'||e.type==='tool'){
          const prefix=e.type==='tool'?(e.decision?'决策调用 #'+e.decision.call+(e.decision.actions.length>1?' · '+e.decision.actions.length+' 个动作共享':'')+'\n':'关联模型用量：未记录\n'):'';
          title.append(node('small','activity-step-usage',prefix+usageText(e.usage||e.decision?.usage)));
        }
        summary.append(node('span','activity-step-number',String(i+1)),title);
        if(e.state)summary.append(tag(e.state));step.append(summary);if(e.state==='failed')step.open=true;
        if(e.decision?.actions.length>1)step.append(node('p','activity-step-meta','共享动作：'+e.decision.actions.map(n=>toolNames[n]||n).join('、')+'。接口未提供各动作单独占用的 token。'));
        if(e.type==='tool'&&e.result?.billing)step.append(node('p','activity-step-meta','联网请求 '+e.result.billing.requests+' 次 · '+(e.result.billing.chargedCny!==undefined?'¥'+e.result.billing.chargedCny.toFixed(6):'旧账本折算 '+number(e.result.billing.chargedTokens)+' token')+(e.result.billing.cached?' · 缓存命中':'')+(e.result.billing.uncertain?' · 费用未确认，保留预留量':'')));
        if(e.type==='model'&&e.result?.billing){const b=e.result.billing;step.append(node('p','activity-step-meta','本次费用 ¥'+b.amountCny.toFixed(6)+' · '+({confirmed:'按返回用量计费',estimated:'估算',held:'预留',unknown:'费用未确认',refunded:'未计费'}[b.status]||b.status)));}
        if(e.type==='tool')step.append(node('p','activity-step-meta','以上为 DeepSeek 决策调用用量；搜索、GPT 生图等工具的独立服务费用不算作这里的对话 token。'));
        if(e.round!==undefined||e.at)step.append(node('p','activity-step-meta',(e.round!==undefined?'第 '+(e.round+1)+' 轮':'')+(e.at?' · '+date(e.at):'')));
        if(e.durationMs!==undefined)step.append(node('p','activity-step-meta','耗时 '+(e.durationMs/1000).toFixed(2)+' 秒'));
        if(e.request)step.append(requestBlock(e.request));
        if(e.diagnostic)step.append(block('实际异常 · 原因链与堆栈',e.diagnostic,true));
        if(e.args!==undefined)step.append(block('调用参数',e.args,true));if(e.result!==undefined)step.append(block('返回结果',e.result,true));
        if(e.phases?.length)step.append(block('执行阶段',e.phases));if(e.callId)step.append(node('small','activity-call-id',e.callId));box.append(step);
      }
      if(r.raw?.inputContext)box.append(block('当时的对话上下文',r.raw.inputContext));
      box.append(block('完整记录（凭据与图片二进制已省略）',r.raw));
    }catch(e){if(version===detailSequence){box.replaceChildren(node('p','form-error','记录读取失败：'+e.message));const back=node('button','quiet-button','← 返回列表');back.onclick=()=>{selected=null;++detailSequence;$('activity-body').classList.remove('has-selection');renderList();};box.append(back);}}
  }
  async function previewImage(id,box,version){
    try{const res=await fetch('/api/activity/image?id='+encodeURIComponent(id),{headers:{authorization:'Bearer '+token}});if(!res.ok)return;const blob=await res.blob();if(version!==detailSequence||!$('activity-dialog').open)return;
      const url=URL.createObjectURL(blob),img=node('img','activity-image');img.alt='这次生成的图片';img.src=url;img.onload=()=>URL.revokeObjectURL(url);img.onerror=()=>URL.revokeObjectURL(url);box.insertBefore(img,box.querySelector('h3').nextSibling);
    }catch{}
  }
  async function refresh(reset=false){
    if(reset){offset=0;selected=null;++detailSequence;$('activity-body').classList.remove('has-selection');$('activity-detail').replaceChildren(node('p','muted','选择一条记录，查看调用过程。'));}
    const version=++sequence,params=new URLSearchParams({offset:String(offset)});for(const key of ['kind','state','conversation','from','to'])if($('activity-'+key).value)params.set(key,$('activity-'+key).value);if($('activity-query').value.trim())params.set('q',$('activity-query').value.trim());
    $('activity-error').textContent='';$('activity-refresh').disabled=true;$('activity-page').textContent='读取中…';
    try{
      const data=await api('activity?'+params);if(version!==sequence)return;
      items=data.items;next=data.nextOffset;stats(data.totals);renderList();
      const select=$('activity-conversation'),value=select.value;select.replaceChildren(new Option('全部会话',''));for(const c of data.conversations)select.append(new Option(conversation(c),c));select.value=value;
      $('activity-page').textContent=data.totals.records?number(offset+1)+'–'+number(Math.min(offset+data.limit,data.totals.records))+' / '+number(data.totals.records):'0 条';$('activity-prev').disabled=offset===0;$('activity-next').disabled=next===null;
      if(selected)await openDetail(selected);
    }catch(e){if(version===sequence){$('activity-error').textContent='活动记录读取失败：'+e.message;$('activity-page').textContent='读取失败';}}
    finally{if(version===sequence)$('activity-refresh').disabled=false;}
  }
  $('activity-button').onclick=()=>{closeDrawers(false);$('activity-dialog').showModal();void refresh();};
  $('activity-close').onclick=()=>$('activity-dialog').close();$('activity-refresh').onclick=()=>refresh();
  $('activity-filters').onsubmit=e=>{e.preventDefault();void refresh(true);};
  for(const key of ['kind','state','conversation','from','to'])$('activity-'+key).onchange=()=>refresh(true);
  $('activity-query').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>refresh(true),350);};
  $('activity-prev').onclick=()=>{offset=Math.max(0,offset-20);void refresh();};$('activity-next').onclick=()=>{if(next!==null){offset=next;void refresh();}};
  $('activity-dialog').addEventListener('close',()=>{++sequence;++detailSequence;clearTimeout(searchTimer);$('activity-refresh').disabled=false;});
})();
