'use strict';
(()=>{
 const dialog=$('corpus-dialog'),names={meme:'梗',phrase:'说法',habit:'习惯',pending:'待审',trial:'试用',active:'已生效',paused:'已暂停',retired:'已停用'};
 const fields=['kind','label','meaning','cues','applies_to','avoid_in','example_good','example_bad','scope','source_note'];
 let cards=[],selected=null,checked=new Set(),offset=0,next=null,total=0,likesOffset=0,likesNext=null,serial=0,likeSerial=0,dirty=false,settingsQueue=Promise.resolve(),extractTimer,lastExtractState='';
 const note=message=>{$('corpus-notice').textContent=message;};
 const report=e=>note(({CORPUS_UNSAFE_CONTENT:'内容涉及身份、提示词、权限、凭据或本机路径，请只保留表达的释义。',PROMPT_NUMBER_BLOCKED:'内容含私密账号号码，请去掉号码后再保存。',CORPUS_SCOPE_FORBIDDEN:'该来源不能写入其他作用域。',CORPUS_PRIVATE_IDENTITY:'全局语料不能包含私人身份，请保留在原会话或只写通用表达。',CORPUS_EXTRACT_DISABLED:'提取已关闭，请先开启语料库、自动提取及至少一个来源。',CORPUS_VERSION_CHANGED:'卡片已在其他页面修改，请刷新后再编辑。'})[e.message]||'操作未完成：'+e.message);
 const scopeName=scope=>scope==='global'?'全局':scope==='tieba'?'贴吧 / 探索':scope.startsWith('conversation:private:')?'QQ 私聊 · '+scope.slice(21):scope.startsWith('conversation:web:')?'网页 · '+scope.slice(17):'QQ 群 · '+scope.slice(13);
 function badge(value){const b=$('corpus-pending');b.hidden=!value?.pendingCount;b.textContent='待审 '+(value?.pendingCount||0);}
 window.addEventListener('fish-corpus-status',event=>badge(event.detail));
 window.corpusReplyButton=(payload,liked=false)=>{
  const button=node('button','quiet-button corpus-like');button.type='button';
  const render=()=>{button.textContent=liked?'✓ 已点赞（取消）':'👍 学这条';button.setAttribute('aria-pressed',String(liked));};render();
  button.onclick=async()=>{button.disabled=true;try{const result=await api('corpus/likes/toggle',payload);liked=result.liked;render();toast(liked?'已加入同作用域满意回复参考。':'已撤回点赞。');window.dispatchEvent(new CustomEvent('corpus-likes-changed'));}catch(e){toast(e.message==='CORPUS_UNSAFE_CONTENT'?'这条回复含身份指令或敏感内容，不能作为语料。':explain(e.message));}finally{button.disabled=false;}};
  return button;
 };
 function filters(){const f={};for(const key of ['kind','status','scope','q']){const value=$('corpus-filter-'+key).value.trim();if(value)f[key]=value;}const exact=$('corpus-filter-exact').value.trim();if(exact)f.scope=exact;return f;}
 function settingsView(s){
  for(const key of ['enabled','autoExtract','extractQQ','extractPublic','allowActiveUse','allowTieba','replyLearningEnabled'])$('corpus-setting-'+key).checked=s[key];
  $('corpus-extract').disabled=!s.enabled||!s.autoExtract||!s.extractQQ&&!s.extractPublic;
  for(const key of ['reviewMode','extractMaxPerDay','memeCooldownMinutes','maxMemeUsesPerContext','maxHintChars'])$('corpus-setting-'+key).value=s[key];
 }
 function countsView(counts){
  const lines=[];for(const kind of ['meme','phrase','habit'])lines.push(names[kind]+' '+counts.filter(c=>c.kind===kind).reduce((n,c)=>n+Number(c.count),0));
  for(const status of ['pending','trial','active','paused','retired'])lines.push(names[status]+' '+counts.filter(c=>c.status===status).reduce((n,c)=>n+Number(c.count),0));
  $('corpus-counts').textContent=lines.join(' · ');
 }
 function selectionView(){$('corpus-selected-count').textContent='已选 '+checked.size;$('corpus-select-page').checked=cards.length>0&&cards.every(c=>checked.has(c.id));$('corpus-bulk-status-apply').disabled=!checked.size;$('corpus-bulk-delete').disabled=!checked.size;}
 function listView(){
  const box=$('corpus-list');box.replaceChildren();
  if(!cards.length)box.append(node('p','muted','暂无匹配语料。可以调整筛选或新增一条。'));
  for(const card of cards){const row=node('div','corpus-card-row'+(selected?.id===card.id?' selected':'')),check=node('input');check.type='checkbox';check.checked=checked.has(card.id);check.setAttribute('aria-label','选择 '+card.label);
   check.onchange=()=>{if(check.checked)checked.add(card.id);else checked.delete(card.id);selectionView();};
   const open=node('button','corpus-card-open');open.type='button';open.append(node('strong','',card.label),node('small','',names[card.kind]+' · '+names[card.status]),node('span','',card.meaning.slice(0,90)),node('small','muted',scopeName(card.scope)));
   open.onclick=()=>{if(dirty&&!confirm('放弃当前未保存的编辑？'))return;editor(card);listView();};row.append(check,open);box.append(row);
  }
  $('corpus-page').textContent=total?`${offset+1}–${offset+cards.length} / ${total}`:'0 / 0';$('corpus-prev').disabled=offset===0;$('corpus-next').disabled=next===null;selectionView();
 }
 async function refresh(){const version=++serial;try{const data=await api('corpus?'+new URLSearchParams({...filters(),offset:String(offset),limit:'30'}));if(version!==serial)return;
  cards=data.items;total=data.total;next=data.nextOffset;if(offset&&offset>=total){offset=total?Math.floor((total-1)/30)*30:0;return refresh();}checked=new Set([...checked].filter(id=>cards.some(c=>c.id===id)));countsView(data.counts);badge(data);settingsView(data.settings);extractionView(data.extraction);listView();
 }catch(e){if(version===serial)report(e);}}
 function editor(card){
  selected=card||null;dirty=false;$('corpus-editor-title').textContent=card?'编辑语料 · '+names[card.status]:'新增语料';
  for(const field of fields)$('corpus-edit-'+field).value=card?.[field]??(field==='kind'?'phrase':field==='scope'?'global':'');
  $('corpus-editor-state').textContent=card?scopeName(card.scope)+' · 版本 '+card.version+' · 使用 '+card.use_count+' 次 · 正反馈 '+(card.positive_count||0)+' · 负反馈 '+(card.negative_count||0):'主人新增默认生效；模型默认自动试用并可立即运用，仍可切换手动审批。';
  $('corpus-entry-actions').hidden=!card;$('corpus-history').textContent=card?JSON.stringify({来源:card.source_origin,创建时间:new Date(card.created_at).toLocaleString('zh-CN'),历史:JSON.parse(card.history_json)},null,2):'尚无历史';
  $('corpus-editor').hidden=false;
 }
 async function mutate(path,payload,message){try{const result=await api('corpus/'+path,payload);note(message);dirty=false;await refresh();if(path==='cards'&&result.id){const created=(await api('corpus?id='+encodeURIComponent(result.id))).items[0];if(created){editor(created);return;}}if(selected){const fresh=cards.find(c=>c.id===selected.id);if(fresh)editor(fresh);else{selected=null;$('corpus-editor').hidden=true;}}}catch(e){report(e);}}
 $('corpus-card-form').onsubmit=async event=>{event.preventDefault();const input=Object.fromEntries(fields.map(field=>[field,$('corpus-edit-'+field).value.trim()]));if(selected){input.id=selected.id;input.version=selected.version;}
  const save=$('corpus-card-save');save.disabled=true;try{await mutate(selected?'cards/update':'cards',input,'语料已保存。');}finally{save.disabled=false;}};
 $('corpus-card-form').oninput=()=>{dirty=true;};
 $('corpus-new').onclick=()=>{if(dirty&&!confirm('放弃当前未保存的编辑？'))return;editor(null);$('corpus-edit-label').focus();};
 $('corpus-select-page').onchange=event=>{checked=new Set(event.target.checked?cards.map(c=>c.id):[]);listView();};
 $('corpus-bulk-status-apply').onclick=()=>mutate('cards/status',{ids:[...checked],status:$('corpus-bulk-status').value},'已更新所选语料状态。');
 $('corpus-bulk-delete').onclick=()=>{if(checked.size&&confirm('删除选中的 '+checked.size+' 条语料？'))void mutate('cards/delete',{ids:[...checked]},'所选语料已删除。');};
 $('corpus-clear-filter').onclick=()=>{const filter=filters();if(!Object.keys(filter).length){note('请先选择状态、分类或作用域，再清空对应语料。');return;}if(confirm('删除当前筛选下的全部 '+total+' 条语料？此操作不可撤销。'))void mutate('cards/delete',filter,'当前筛选下的语料已删除。');};
 for(const button of dialog.querySelectorAll('[data-corpus-status]'))button.onclick=()=>selected&&mutate('cards/status',{id:selected.id,status:button.dataset.corpusStatus},'语料状态已更新。');
 $('corpus-delete-one').onclick=()=>{if(selected&&confirm('删除「'+selected.label+'」？'))void mutate('cards/delete',{id:selected.id},'语料已删除。');};
 let searchTimer;for(const id of ['kind','status','scope','q','exact'])$('corpus-filter-'+id).addEventListener(['q','exact'].includes(id)?'input':'change',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{offset=0;checked.clear();void refresh();},180);});
 $('corpus-prev').onclick=()=>{offset=Math.max(0,offset-30);void refresh();};$('corpus-next').onclick=()=>{if(next!==null){offset=next;void refresh();}};
 $('corpus-refresh').onclick=()=>void refresh();
 function extractionLatest(value){const request=value?.recent?.[0],last=value?.last;return !request||(last?.at??0)>(request.finished??request.started??request.created)?last:request;}
 function extractionView(value){
  if(!value)return;
  const last=extractionLatest(value),labels={queued:'等待后台认领',running:'正在提取',completed:'提取完成',empty:'没有未提取的安全增量',failed:'提取失败',cancelled:'提取已取消'};
  const result=typeof last?.result==='string'?JSON.parse(last.result):last?.result;
  $('corpus-extract-state').textContent='今日自动尝试 '+value.automaticBatches+' / '+value.limit+' 批（香港日期）'+(last?' · '+(labels[last.state]||last.state)+(result?.saved?' · 新增 '+result.saved.length+' 条':'')+(last.error?' · '+last.error:''):' · 暂无提取记录')+'；手动提取不占自动批数。';
 }
 $('corpus-extract').onclick=async()=>{const button=$('corpus-extract');button.disabled=true;try{const result=await api('corpus/extract',{});note(result.reused?'已有提取请求，正在等待结果。':'提取已排队，后台会扫描尚未提取的自然语言。');await refresh();}catch(e){report(e);}finally{button.disabled=false;if(dialog.open)void pollExtraction();}};
 async function pollExtraction(){if(!dialog.open)return;try{const data=await api('corpus?limit=1');extractionView(data.extraction);badge(data);const latest=extractionLatest(data.extraction),key=latest?.id+':'+latest?.state;
  if(lastExtractState&&key!==lastExtractState&&latest?.state==='completed'&&!dirty)await refresh();lastExtractState=key;
 }catch(e){report(e);}}
 dialog.addEventListener('close',()=>{clearInterval(extractTimer);extractTimer=null;});

 async function refreshLikes(){const version=++likeSerial;try{const platform=$('corpus-like-platform').value,q=$('corpus-like-query').value;
  const data=await api('corpus/likes?'+new URLSearchParams({...(platform?{platform}:{}),...(q?{q}:{}),offset:String(likesOffset),limit:'30'}));if(version!==likeSerial)return;
  likesNext=data.nextOffset;const box=$('corpus-likes-list');box.replaceChildren();if(!data.items.length)box.append(node('p','muted','还没有匹配的满意回复。可以在活动记录或贴吧回帖详情里点击「学这条」。'));
  for(const reply of data.items){const card=node('article','corpus-liked-reply'),remove=node('button','quiet-button','撤回点赞');remove.type='button';remove.onclick=async()=>{try{await api('corpus/likes/delete',{id:reply.id});await refreshLikes();window.dispatchEvent(new CustomEvent('corpus-likes-changed'));}catch(e){report(e);}};
   card.append(node('strong','',reply.topic||'满意回复'),node('small','muted',reply.platform+' · '+reply.conversation),node('blockquote','',reply.reply_text),remove);box.append(card);
  }
  $('corpus-likes-page').textContent=data.total?`${likesOffset+1}–${likesOffset+data.items.length} / ${data.total}`:'0 / 0';$('corpus-likes-prev').disabled=!likesOffset;$('corpus-likes-next').disabled=likesNext===null;
 }catch(e){if(version===likeSerial)report(e);}}
 $('corpus-like-platform').onchange=()=>{likesOffset=0;void refreshLikes();};$('corpus-like-query').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{likesOffset=0;void refreshLikes();},180);};
 $('corpus-likes-refresh').onclick=()=>void refreshLikes();$('corpus-likes-prev').onclick=()=>{likesOffset=Math.max(0,likesOffset-30);void refreshLikes();};$('corpus-likes-next').onclick=()=>{if(likesNext!==null){likesOffset=likesNext;void refreshLikes();}};
 $('corpus-likes-clear').onclick=async()=>{const platform=$('corpus-like-platform').value;if(!platform){note('请先选择一个平台，再清空该平台的满意回复。');return;}if(!confirm('撤回 '+platform+' 平台的全部点赞？'))return;try{await api('corpus/likes/delete',{platform});await refreshLikes();window.dispatchEvent(new CustomEvent('corpus-likes-changed'));}catch(e){report(e);}};
 for(const input of dialog.querySelectorAll('[data-corpus-setting]'))input.onchange=()=>{
  const key=input.dataset.corpusSetting,value=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;input.disabled=true;note('正在保存学习设置…');
  settingsQueue=settingsQueue.catch(()=>{}).then(async()=>{try{const settings=await api('corpus/settings',{[key]:value});settingsView(settings);note('学习设置已生效。');await refresh();}catch(e){report(e);}finally{input.disabled=false;}});
 };
 function tab(name){for(const button of dialog.querySelectorAll('[data-corpus-tab]')){const active=button.dataset.corpusTab===name;button.classList.toggle('selected',active);button.setAttribute('aria-selected',String(active));}
  for(const pane of dialog.querySelectorAll('[data-corpus-pane]'))pane.hidden=pane.dataset.corpusPane!==name;if(name==='likes')void refreshLikes();else void refresh();}
 for(const button of dialog.querySelectorAll('[data-corpus-tab]'))button.onclick=()=>tab(button.dataset.corpusTab);
 $('corpus-button').onclick=()=>{closeDrawers(false);if(!dialog.open)dialog.showModal();if(!extractTimer)extractTimer=setInterval(pollExtraction,4000);note('');void refresh();};
 window.addEventListener('corpus-likes-changed',()=>{if(dialog.open)void refreshLikes();});
})();
