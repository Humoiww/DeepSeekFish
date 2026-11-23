'use strict';
(()=>{
 const dialog=$('exploration-dialog'),numbers=['minMinutes','maxMinutes','probability','maxRunMinutes','runTokens'],checks=['enabled','tiebaPatrol','allowImages','allowPublicPosts'];
 const states={queued:'等待后台接手',running:'进行中',completed:'已完成',paused:'错误',failed:'错误',cancelled:'已停止',interrupted:'进程中断'};
 const errorText=e=>({EXPLORATION_DECISION_STALLED:'模型连续三次没有返回工具调用',EXPLORATION_TIME_BUDGET:'达到本次探索的时长上限',EXPLORATION_TOKEN_BUDGET:'本次探索的 token 额度不足'})[e]||e;
 let poll,dirty=false,loading=false,postHintSaving=false,offset=0,next=null;
 const date=n=>n?new Date(n).toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false}):'—';
 const fail=e=>$('exploration-error').textContent=e.message;
 function estimate(){const min=+$('explore-minMinutes').value,max=+$('explore-maxMinutes').value,p=+$('explore-probability').value/100,n=1440/((min+max)/2)*p;$('exploration-estimate').textContent=min>0&&max>=min&&p>=0&&p<=1?'平均约 '+n.toFixed(2)+' 次 / 天，仅为估计；每天不凑数，也不设次数上限。':'请检查间隔与概率。';}
 function history(id){dialog.close();document.dispatchEvent(new CustomEvent('exploration-history',{detail:id}));}
 async function refresh(fill=false){
  if(loading)return;loading=true;
  try{
   const s=await api('exploration');$('exploration-error').textContent='';
   if(fill&&!dirty){for(const k of numbers)$('explore-'+k).value=k==='probability'?+(s.settings[k]*100).toFixed(6):s.settings[k];for(const k of checks)$('explore-'+k).checked=s.settings[k];const select=$('explore-owner');select.replaceChildren(...s.owners.map(id=>{const o=node('option','',id);o.value=id;return o;}));if(!s.owners.length){const o=node('option','','请先在 QQ 设置添加私聊账号');o.value='';select.append(o);}select.value=s.settings.owner;estimate();$('exploration-fields').disabled=false;}
   const online=s.worker&&Date.now()-s.worker.at<15000,box=$('exploration-status');box.replaceChildren();
   for(const [k,v] of [['后台',online?(s.active?states[s.active.state]:s.settings.enabled?'等待随机刻':'空闲（可手动唤醒）'):'尚未连接 · 设置已保存在数据库'],['随机刻',s.settings.enabled?'开启':'关闭'],['下次检查（香港）',date(s.schedule.next_check)],['最近探索',s.last?date(s.last.started||s.last.created)+' · '+states[s.last.state]:'还没有'],['最近错误',s.lastError?errorText(s.lastError.error)+' · '+date(s.lastError.finished):s.worker?.error||'无']]){const row=node('p');row.append(node('strong','',k+'：'),node('span','',v));box.append(row);}
   $('exploration-run').disabled=!s.settings.owner||!!s.active;$('exploration-cancel').disabled=!s.active;
   if(s.tiebaRedDot){const b=s.tiebaRedDot,p=node('p'),dot=node('span','',b.redDot?'● ':'○ ');dot.style.color=b.redDot?'#ef6464':'#94a3b8';p.append(node('strong','','贴吧小红点：'),dot,node('span','',b.message+' · 最近检查（香港）'+date(b.checkedAt)+(b.clearedAt?' · 最近清除 '+date(b.clearedAt):'')));box.append(p);}
   for(const [label,w] of [['贴吧回复',s.tiebaReplies],['贴吧 @',s.tiebaMentions]])if(w){const p=node('p');p.append(node('strong','',label+'：'),node('span','',!s.settings.enabled?'随自主探索关闭':w.lastError?w.lastError+(w.paused?' · 请在贴吧账号页检查登录':''):w.pending?.count?'已收到 '+w.pending.count+' 条 · 唤醒时间（香港）'+date(w.pending.due):'最近检查 '+date(w.lastCheck)));box.append(p);}
   if(s.tiebaPatrol){const w=s.tiebaPatrol,p=node('p'),status=w.enabled?'开启':!s.settings.tiebaPatrol?'关闭':!s.settings.enabled?'随自主探索关闭':'等待启用聊天与联网';p.append(node('strong','','贴吧巡视：'),node('span','',status+' · '+w.forums.map(f=>f.name+'吧').join('、')+' · 待看 '+w.pending+' 条 · 最近检查（香港）'+date(w.lastCheck)+(w.lastError?' · '+w.lastError:'')));box.append(p);}
   if(s.tiebaDailyPost){
    const h=s.tiebaDailyPost,p=node('p'),toggle=node('button','post-hint-toggle',h.attemptedToday?'标记未发':'标记已发');
    toggle.type='button';toggle.disabled=postHintSaving;toggle.title='切换今天的发帖提醒状态';
    toggle.onclick=async()=>{if(postHintSaving)return;postHintSaving=true;toggle.disabled=true;let saved=false;try{await api('exploration/daily-post',{attemptedToday:!h.attemptedToday});saved=true;}catch(e){fail(e);}finally{postHintSaving=false;toggle.disabled=false;if(saved)await refresh(false);const current=box.querySelector('.post-hint-toggle');if(current)current.disabled=false;}};
    p.append(node('strong','','发帖提醒：'),node('span','',(h.attemptedToday?(h.manual?'已手动标记发过':'已调用过发新帖功能'):(h.manual?'已手动标记未发':'今天还没发帖，可以找点有意思的东西发帖'))+' · 下次重置（香港09:00）'+date(h.resetsAt)),toggle);box.append(p);
   }
   $('exploration-recent').replaceChildren(...s.recent.slice(0,8).map(r=>{const b=node('button','exploration-entry',date(r.created)+' · '+states[r.state]+(r.error?' · '+errorText(r.error):'')+'\n'+r.tokens.toLocaleString()+' 模型 token · 联网 ¥'+((r.web_nano||0)/1e9).toFixed(4)+(r.web_tokens?' · 旧联网折算 '+r.web_tokens+' token':'')+(r.unknown_tokens?' · 未确认预留 '+r.unknown_tokens.toLocaleString():'')+' · 已分享 '+r.shared+' 次'+(r.note?'\n'+r.note.slice(0,160):''));b.type='button';b.onclick=()=>history(r.id);return b;}));
   if(!s.recent.length)$('exploration-recent').append(node('p','hint','还没有探索记录。'));
   $('exploration-proposals').replaceChildren(...s.proposals.map(r=>{const d=node('details'),pre=node('pre','activity-json',r.brief);d.append(node('summary','',r.request+' · '+r.state),node('p','hint','提案 '+r.id),pre);return d;}));
   if(!s.proposals.length)$('exploration-proposals').append(node('p','hint','还没有提案；她不必每次都提出一个。'));
  }catch(e){fail(e);}finally{loading=false;}
 }
 async function journal(append=false){try{
  const q=$('exploration-query').value,params=new URLSearchParams({query:q,offset:String(append?offset:0)}),data=await api('exploration/journal?'+params),box=$('exploration-entries');
  if(!append)box.replaceChildren();for(const entry of data.entries){const d=node('details'),text=node('pre','activity-json',entry.preview),sources=node('div');d.append(node('summary','',entry.title+(entry.groupName?' · '+entry.groupName:'')+' · '+date(entry.updated)),text,sources);d.addEventListener('toggle',async()=>{if(!d.open||d.dataset.loaded)return;try{const r=await api('exploration/journal?id='+encodeURIComponent(entry.id));text.textContent=r.entry.content;for(const url of r.entry.sources){const a=node('a','',url);a.href=url;a.target='_blank';a.rel='noopener noreferrer';sources.append(a,node('br'));}d.dataset.loaded='1';}catch(e){fail(e);}});box.append(d);}
  if(!data.entries.length&&!append)box.append(node('p','hint','还没有这类记录。她可以自行决定记什么。'));next=data.nextOffset;$('exploration-more').hidden=next===null;
 }catch(e){fail(e);}}
 $('exploration-button').onclick=async()=>{closeDrawers();dirty=false;dialog.showModal();await refresh(true);poll=setInterval(()=>void refresh(false),4000);};
 $('exploration-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>clearInterval(poll));
 $('exploration-form').oninput=()=>{dirty=true;estimate();$('exploration-saved').textContent='尚未保存';};
 $('exploration-form').onsubmit=async e=>{e.preventDefault();const input={owner:$('explore-owner').value};for(const k of numbers)input[k]=Number($('explore-'+k).value)/(k==='probability'?100:1);for(const k of checks)input[k]=$('explore-'+k).checked;try{await api('exploration/settings',input);dirty=false;$('exploration-saved').textContent='已保存，后台即时读取';await refresh(true);}catch(e){fail(e);}};
 $('exploration-refresh').onclick=()=>refresh(!dirty);
 $('exploration-run').onclick=async()=>{try{$('exploration-run').disabled=true;await api('exploration/run',{});await refresh(false);}catch(e){fail(e);$('exploration-run').disabled=false;}};
 $('exploration-cancel').onclick=async()=>{try{await api('exploration/cancel',{});await refresh(false);}catch(e){fail(e);}};
 $('exploration-history').onclick=()=>history();$('exploration-journal').addEventListener('toggle',()=>{if($('exploration-journal').open)void journal();});
 $('exploration-search').onsubmit=e=>{e.preventDefault();void journal();};$('exploration-more').onclick=()=>{offset=next;void journal(true);};
})();
