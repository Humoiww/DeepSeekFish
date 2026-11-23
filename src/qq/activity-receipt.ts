export type QQAccess={label:string;text:string;url?:string};

export function qqAccess(step:{type:string;name:string;state?:string;result?:any}):QQAccess|undefined{
 const result=step.result;
 if(step.type!=='tool'||!result||result.error||step.state==='failed')return;
 const postCount=Array.isArray(result.posts)?result.posts.length:result.postCount;
 if(step.name==='get_qzone'&&result.source==='QQ空间说说列表'&&Number.isSafeInteger(postCount)&&['ok','empty'].includes(result.status)){
  const target=result.spaceOwner?.relation==='self'?'自己的空间':result.spaceOwner?.relation==='speaker'?'聊天对方的空间':'对应账号的空间';
  const id=result.spaceOwner?.qq;
  return {label:'访问 QQ 空间',text:`读取${target}，QQ 返回 ${postCount} 条动态。`,
   url:typeof id==='string'&&/^[1-9]\d{0,19}$/.test(id)?`https://user.qzone.qq.com/${id}/`:undefined};
 }
 if(step.name==='get_person'&&result.source==='qq_profile'&&(result.profileAvailable||result.profile&&Object.keys(result.profile).length))
  return {label:'读取 QQ 资料',text:'收到 QQ 返回的账号资料。'};
 if(step.name==='read_qq_quote'&&result.source==='qq_history'&&(result.target||result.targetAvailable))
  return {label:'读取 QQ 聊天记录',text:'从 QQ 历史回读引用消息和可取得的上下文。'};
 if(['download_qq_attachment','view_qq_attachment'].includes(step.name)&&result.downloaded===true&&result.reused===false)
  return {label:'下载 QQ 附件',text:typeof result.name==='string'?result.name:'已下载 QQ 返回的附件。'};
 if(step.name==='publish_qzone'&&result.published===true&&result.deliveryStatus==='confirmed'&&result.reused!==true&&result.id)
  return {label:'已发 QQ 空间动态',text:'QQ 空间返回了动态 ID。',url:typeof result.url==='string'?result.url:undefined};
}
