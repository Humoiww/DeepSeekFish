'use strict';
(()=>{
  document.addEventListener('exploration-history',async e=>{closeDrawers();for(const id of ['activity-state','activity-conversation','activity-from','activity-to','activity-query'])$(id).value='';$('activity-kind').value='exploration';offset=0;$('activity-dialog').showModal();await refresh(true);if(e.detail)await openDetail('exploration:'+e.detail);});
  const kindNames={qq:'QQ 对话',web:'网页对话',news:'早间新闻',memory:'记忆回顾',diary:'空间动态',image:'Codex 生图',audit:'系统事件',exploration:'自主探索',development:'开发任务',chain:'连续任务链'};
  const stateNames={accepted:'平台已受理',deleted:'已被平台删除',unconfirmed:'送达未确认',paused:'已暂停',cancelled:'已停止',interrupted:'重启中断',completed:'已完成',failed:'失败',partial:'部分失败',running:'进行中',pending:'等待结果',unknown:'状态未记录'};
  const toolNames={save_curiosity_summary:'保存会话好奇心',skip_curiosity_summary:'本段无需记录',list_conversations:'查看授权会话',search_memory:'检索记忆',read_memory:'回看记忆',read_curiosity:'翻阅好奇心日志',write_curiosity:'更新好奇心日志',read_exploration:'回看探索',send_message:'主动私聊',propose_project:'提出创意',finish_exploration:'结束闲逛',publish_qzone:'发布空间',reply:'回复消息',search_web:'联网搜索',fetch_page:'查询网页',browse_page:'浏览网页',download_image:'下载图片',generate_image:'请求生图',send_image:'发送成图',send_meme:'发送表情',list_images:'浏览图库',view_images:'查看原图',collect_meme:'收藏表情',remember_images:'记录图片',get_knowledge:'读取知识库',update_knowledge:'更新知识库',recall_chat:'翻阅聊天历史',read_forward:'读取转发记录',get_qzone:'读取空间动态',get_person:'查看 QQ 资料',get_quota:'查看额度',read_tool_result:'继续读取工具结果',draft_news:'准备新闻',finish_memory:'完成记忆回顾',image_plan:'设计画面',codex_record:'Codex 返回结果'};
  let offset=0,next=null,selected=null,sequence=0,detailSequence=0,searchTimer,listRequest,items=[];
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
  const conversation=v=>v==='development'?'主人私聊':v.startsWith('private:')?'私聊 · '+v.slice(8):v.startsWith('web:')?'网页 · '+v.slice(4,12):v.startsWith('QQ ')?v:v?'群聊 · '+v:'未记录会话';
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
  const pageActions=new Set(['browse_page','fetch_page','download_image']);
  const messageActions=new Set(['reply','send_message','send_image','send_file','send_meme']);
  const publicationActions=new Set(['publish_tieba','publish_qzone']);
  const timelineToolNames={get_tieba_replies:'查看贴吧回复',get_tieba_account:'查看贴吧账号',get_tieba_sections:'查看贴吧分区',
    check_tieba_publication:'复查贴吧发言',send_file:'发送文件',request_development:'交给 Neon小猫处理',activity_chain_start:'建立连续任务链',
    get_person:'读取 QQ 资料',get_qzone:'访问 QQ 空间',read_qq_quote:'查看 QQ 引用',download_qq_attachment:'下载 QQ 附件',view_qq_attachment:'查看 QQ 附件',
    activity_chain_status:'查询自己的任务链'};
  const textValue=value=>typeof value==='string'?value.trim():'';
  function activityLink(...candidates){
    for(const candidate of candidates){
      if(typeof candidate!=='string'||!/^https?:\/\//i.test(candidate))continue;
      try{const url=new URL(candidate);if(!url.username&&!url.password)return url;}catch{}
    }
  }
  function describeTool(event){
    if(event.qqAccess){
      const visit=event.qqAccess;
      return {title:visit.label,text:visit.text,url:activityLink(visit.url),at:event.at,state:event.state,status:'已有 QQ 访问回执'};
    }
    const args=event.args??{},result=event.result??{};
    const publication=publicationActions.has(event.name),message=messageActions.has(event.name);
    let title=timelineToolNames[event.name]||toolNames[event.name]||event.name;
    if(event.name==='publish_tieba')title=args.action==='thread'||result.action==='thread'?'发贴吧主题':
      args.replyScope==='subreply'?'回一条楼中楼':args.replyScope==='floor'?'回具体楼层':result.action==='reply'?'在主题盖新楼':'回贴吧帖子';
    let state=result.status==='partial'?'partial':event.state,status;
    if(publication||message){
      if(result.mode==='preview'){state='completed';status='预演完成';}
      else if(result.published===true||result.publicVerified===true){
        state='completed';status=event.name==='publish_tieba'?'已确认公开':'已发布';
      }else if(state==='accepted'||result.submitted===true&&state==='completed'){
        state='accepted';status='平台已受理';
      }else if(message&&(result.sent===true||result.delivered===true||result.deliveryStatus==='confirmed')&&state!=='partial'){
        state='completed';status='已发送';
      }else if(result.sent===false||result.submitted===false||result.skipped){
        if(state==='completed')state='unknown';
        status=publication?'未提交':'未发送';
      }else if(state==='completed'){
        state='unconfirmed';status=publication?'发布未确认':'发送未确认';
      }
    }
    const page=pageActions.has(event.name);
    const url=page?activityLink(result.url,args.url):publication?activityLink(result.url,args.target):undefined;
    const text=publication?[textValue(args.title),textValue(args.content)||textValue(args.text)].filter(Boolean).join('\n'):
      message?textValue(result.text)||textValue(args.text)||textValue(result.filename)||textValue(args.caption):
      event.name==='search_web'?textValue(args.query):event.name==='finish_exploration'?textValue(result.note):'';
    const issue=textValue(result.issue?.reason)||textValue(result.error)||textValue(result.unavailable?.[0]?.error);
    return {title,state,status,text,issue,url,linkTitle:page?textValue(result.title):textValue(result.forum?.name),at:event.at};
  }
  function timelineEntry({title,state,status,text,issue,url,linkTitle,at}){
    const item=node('li','activity-flow-entry'),heading=node('div','activity-flow-heading');
    heading.append(node('strong','',title));
    if(state){const badge=tag(state);if(status)badge.textContent=status;heading.append(badge);}
    if(at)heading.append(node('time','',date(at).slice(-8)));
    item.append(heading);
    if(url){
      const link=node('a','activity-flow-link',linkTitle?linkTitle+' · '+url.hostname:url.hostname+url.pathname);
      link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';item.append(link);
    }
    if(text)item.append(node('p','activity-flow-text',text));
    if(issue)item.append(node('p','activity-flow-issue',issue));
    return item;
  }
  function activityTimeline(record){
    const details=node('details','activity-block activity-flow');
    details.open=true;details.append(node('summary','','回复 / 结果'));
    const final=textValue(record.reply);
    const displayedText=new Set();let entries,round;
    function add(entry,nextRound){
      if(!entries||round!==nextRound){
        round=nextRound;
        const group=node('div','activity-flow-round');
        if(round!==undefined)group.append(node('h4','','第 '+(round+1)+' 轮'));
        entries=node('ol','activity-flow-entries');group.append(entries);details.append(group);
      }
      entries.append(timelineEntry(entry));
      if(entry.text)displayedText.add(entry.text);
    }
    for(const event of record.events){
      const nextRound=Number.isSafeInteger(event.round)?event.round:round;
      if(event.type==='model'){
        const text=textValue(event.result?.text);
        if(text||event.state==='failed'){
          const title=!text?'模型返回错误':record.kind==='web'&&text===final?'网页回复':'当时的想法';
          add({title,text,issue:event.result?.error,at:event.at,state:event.state==='failed'?'failed':undefined},nextRound);
        }
      }else if(event.type==='tool')add(describeTool(event),nextRound);
      else if(event.type==='event'&&record.kind==='chain'){
        add({title:event.name,state:event.state,text:textValue(event.result?.text),issue:textValue(event.result?.error),url:activityLink(event.result?.url),at:event.at},nextRound);
      }
      else if(event.type==='context'&&event.result?.recovery===true&&event.result.attempt===3){
        add({title:'工具恢复提示',text:textValue(event.result.content)},nextRound);
      }else if(event.type==='error'){
        const stalled=event.name==='EXPLORATION_DECISION_STALLED';
        add({title:stalled?'探索未收到工具动作':'执行遇到错误',issue:stalled?'连续三次只返回了文字。':event.name,state:stalled&&record.state==='completed'?undefined:event.state,at:event.at},nextRound);
      }else if(event.type==='message'||event.type==='result'){
        const result=event.result,text=textValue(result)||textValue(result?.text)||textValue(result?.draft?.text);
        if(text)add({title:event.name,text,at:event.at},nextRound);
      }
    }
    if(final&&!displayedText.has(final))add({title:record.kind==='exploration'?'本轮小记':'记录结果',text:final},undefined);
    return entries?details:null;
  }
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
      const usage=r.usage.known?number(r.usage.total)+' token':'token 未记录';
      const metrics=['development','chain'].includes(r.kind)?r.reply.split('\n')[0].slice(0,130):usage+' · '+number(r.counts.tools)+' 次工具调用'+(r.errors?' · '+r.errors+' 次异常':'');
      const visits=r.qqAccess?' · QQ 访问 '+number(r.qqAccess)+' 次':'';
      if(metrics||visits)row.append(node('span','activity-row-metrics',metrics+visits));
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
      if(r.kind==='development')box.append(node('p','activity-detail-meta','任务 '+r.id.slice('development:'.length)+' · 更新于 '+date(r.updated)));
      box.append(block(r.kind==='image'?'生图提示词':'问题 / 任务',r.title,true));
      const failures=r.events.filter(e=>e.state==='failed');
      if(failures.length)box.append(block('失败位置与原因',failures.map(failureSummary).join('\n\n'),true));
      const timeline=activityTimeline(r);if(timeline)box.append(timeline);
      if(r.kind!=='development')box.append(node('p','activity-detail-meta',r.usage.known?'已记录输入 '+number(r.usage.input)+' + 输出 '+number(r.usage.output)+' = '+number(r.usage.total)+' token':r.usage.unreportedCalls?'模型没有返回 token 用量，实际消耗未确认。':'这条记录没有保存 DeepSeek token 用量。'));
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
        if(e.state)summary.append(tag(e.state));step.append(summary);if(e.state==='failed'||r.kind==='development'&&e.name.startsWith('Codex · '))step.open=true;
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
      box.append(block(r.kind==='development'?'任务快照':'完整记录（凭据与图片二进制已省略）',r.raw));
    }catch(e){if(version===detailSequence){box.replaceChildren(node('p','form-error','记录读取失败：'+e.message));const back=node('button','quiet-button','← 返回列表');back.onclick=()=>{selected=null;++detailSequence;$('activity-body').classList.remove('has-selection');renderList();};box.append(back);}}
  }
  async function previewImage(id,box,version){
    try{const res=await fetch('/api/activity/image?id='+encodeURIComponent(id),{headers:{authorization:'Bearer '+token}});if(!res.ok)return;const blob=await res.blob();if(version!==detailSequence||!$('activity-dialog').open)return;
      const url=URL.createObjectURL(blob),img=node('img','activity-image');img.alt='这次生成的图片';img.src=url;img.onload=()=>URL.revokeObjectURL(url);img.onerror=()=>URL.revokeObjectURL(url);box.insertBefore(img,box.querySelector('h3').nextSibling);
    }catch{}
  }
  function clearDetail(){
    selected=null;++detailSequence;$('activity-body').classList.remove('has-selection');
    $('activity-detail').replaceChildren(node('p','muted','选择一条记录，查看调用过程。'));
  }
  const interruptButton=$('activity-interrupt');
  const liveStates={waiting_discussion:'等待讨论答复',queued:'等待执行',drafting:'准备执行',executing:'正在执行',ready:'等待提交',publishing:'已开始提交',unconfirmed:'正在核对回执'};
  let interruptTimer,interruptStatus,live=null,pendingInterrupt=false,interruptNotice='';
  const stoppingDevelopment=new Set();
  function renderInterrupt(){
    const chains=live?.chains??[],exploration=live?.exploration,development=live?.development??[];
    const canStop=task=>task.interruptible&&!stoppingDevelopment.has(task.id);
    interruptButton.disabled=pendingInterrupt||!chains.some(chain=>chain.canInterrupt)&&(!exploration||!!exploration.cancel)&&!development.some(canStop);
    interruptButton.textContent=pendingInterrupt?'正在急停…':'急停';
    $('activity-live-status').textContent=interruptNotice||(live?`当前有 ${chains.length} 条任务链${exploration?'、1 次自主探索':''}${development.length?'、'+development.length+' 项开发':''}。`:'正在读取当前活动…');
    const item=(title,progress,id,action)=>{
      const row=node('div','activity-live-row'),open=node('button','quiet-button activity-live-open',title);
      open.type='button';open.onclick=()=>typeof id==='function'?id():openDetail(id);
      row.append(open,node('span','muted',progress));
      if(action){
        const stop=node('button','quiet-button activity-stop','停止');
        stop.type='button';stop.disabled=pendingInterrupt;stop.onclick=()=>interrupt(action);row.append(stop);
      }
      return row;
    };
    const rows=chains.map(chain=>item(chain.nextStep??chain.title??'连续任务链',
      (liveStates[chain.state]??chain.state)+(chain.totalSteps===null?'':` · ${chain.completedSteps}/${chain.totalSteps} 已完成`)+
      ' · '+chain.chainId.slice(0,8),'chain:'+chain.chainId,chain.canInterrupt?{chainId:chain.chainId}:null));
    if(exploration)rows.push(item('自主探索',exploration.cancel?'正在停止':liveStates[exploration.state]??stateNames[exploration.state],
      'exploration:'+exploration.id,exploration.cancel?null:{runId:exploration.id}));
    for(const task of development){
      const progress=stoppingDevelopment.has(task.id)?'正在打断':
        ({code:task.codexStep||'正在开发',candidate:'候选编译',deploy:'部署切换',live:'上线核对'}[task.phase]??task.phase);
      rows.push(item(task.goal||'Neon / Codex',progress,()=>{
        $('activity-dialog').close();
        $('neon-button').click();
      },canStop(task)?{taskId:task.id}:null));
    }
    $('activity-active-rows').replaceChildren(...rows);
  }
  async function refreshInterrupt(){
    if(!$('activity-dialog').open||interruptStatus)return;
    const request=new AbortController();interruptStatus=request;
    try{
      const status=await api('activity/active',undefined,request.signal);
      if(interruptStatus!==request)return;
      live=status;
      const liveIds=new Set((live.development??[]).map(task=>task.id));
      for(const id of stoppingDevelopment)if(!liveIds.has(id))stoppingDevelopment.delete(id);
      if(interruptNotice.startsWith('当前活动读取失败'))interruptNotice='';
      renderInterrupt();
    }catch(error){
      if(interruptStatus===request&&!request.signal.aborted){
        live=null;interruptNotice='当前活动读取失败：'+error.message;renderInterrupt();
      }
    }
    finally{if(interruptStatus===request)interruptStatus=null;}
  }
  async function interrupt(target){
    if(pendingInterrupt)return;
    pendingInterrupt=true;interruptNotice='';renderInterrupt();
    try{
      const result=await api('activity/interrupt',target);
      const requested=result.developmentRequested??[];
      requested.forEach(id=>stoppingDevelopment.add(id));
      interruptNotice=[
        result.stopped.length?`已停止 ${result.stopped.length} 条任务链。`:'',
        result.explorationRequested?'自主探索已请求停止。':'',
        requested.length?`已请求打断 ${requested.length} 项开发任务，等待后台确认。`:'',
        result.settling.length?`${result.settling.length} 条已开始提交，继续核对回执。`:'',
      ].filter(Boolean).join('')||'当前没有可急停的活动。';
      if(live){
        live.chains=live.chains.filter(chain=>!result.stopped.includes(chain.chainId));
        if(result.explorationRequested&&live.exploration)live.exploration.cancel=1;
      }
      if(interruptStatus){interruptStatus.abort();interruptStatus=null;}
      await refresh();
    }
    catch(e){
      interruptNotice='急停失败：'+e.message;
    }
    finally{pendingInterrupt=false;renderInterrupt();}
  }
  interruptButton.onclick=()=>interrupt({});
  async function refresh(reset=false){
    if(!interruptTimer&&$('activity-dialog').open)interruptTimer=setInterval(refreshInterrupt,3000);
    void refreshInterrupt();
    if(reset){offset=0;clearDetail();}
    listRequest?.abort();const request=new AbortController();listRequest=request;
    const version=++sequence,params=new URLSearchParams({offset:String(offset)});for(const key of ['kind','state','conversation','from','to'])if($('activity-'+key).value)params.set(key,$('activity-'+key).value);if($('activity-query').value.trim())params.set('q',$('activity-query').value.trim());
    $('activity-error').textContent='';$('activity-refresh').disabled=true;$('activity-page').textContent='读取中…';
    try{
      const data=await api('activity?'+params,undefined,request.signal);if(version!==sequence)return;
      items=data.items;next=data.nextOffset;stats(data.totals);renderList();
      const select=$('activity-conversation'),value=select.value;select.replaceChildren(new Option('全部会话',''));for(const c of data.conversations)select.append(new Option(conversation(c),c));select.value=value;
      $('activity-page').textContent=data.totals.records?number(offset+1)+'–'+number(Math.min(offset+data.limit,data.totals.records))+' / '+number(data.totals.records):'0 条';$('activity-prev').disabled=offset===0;$('activity-next').disabled=next===null;
      if(selected)await openDetail(selected);
    }catch(e){if(version===sequence){$('activity-error').textContent='活动记录读取失败：'+e.message;$('activity-page').textContent='读取失败';}}
    finally{if(listRequest===request)listRequest=null;if(version===sequence)$('activity-refresh').disabled=false;}
  }
  $('activity-button').onclick=()=>{closeDrawers(false);$('activity-dialog').showModal();void refresh(true);};
  $('activity-close').onclick=()=>$('activity-dialog').close();$('activity-refresh').onclick=()=>refresh();
  $('activity-filters').onsubmit=e=>{e.preventDefault();void refresh(true);};
  for(const key of ['kind','state','conversation','from','to'])$('activity-'+key).onchange=()=>refresh(true);
  $('activity-query').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>refresh(true),350);};
  $('activity-prev').onclick=()=>{offset=Math.max(0,offset-20);clearDetail();void refresh();};$('activity-next').onclick=()=>{if(next!==null){offset=next;clearDetail();void refresh();}};
  $('activity-dialog').addEventListener('close',()=>{
    ++sequence;++detailSequence;listRequest?.abort();clearTimeout(searchTimer);$('activity-refresh').disabled=false;
    clearInterval(interruptTimer);interruptTimer=null;interruptStatus?.abort();interruptStatus=null;
    live=null;interruptNotice='';stoppingDevelopment.clear();renderInterrupt();
  });
})();
