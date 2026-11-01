/** Retrieval time is not publication time. A successful HTTP response can be a
 * challenge page; retain that distinction in model-visible tool results. */
export function pageEvidence(title:string,content:string,scripted=false){
  const blocked=/^(验证码|人机验证|安全验证|captcha|access denied|just a moment|verify you are human)(\s|_|-|$)/i.test(title.trim())||content.length<300&&/请(?:先)?完成人机验证|verify you are human/i.test(content);
  const login=/^(登录|登陆|sign in|log in|login)(\s|_|-|$)/i.test(title.trim());
  const status=blocked?'challenge':login?'login_required':!content.trim()?(scripted?'client_rendered':'empty'):'content';
  return {status,latestVerified:false,...(status!=='content'?{notice:'未取得目标正文；这不是动态或文章内容。'}:{})};
}
