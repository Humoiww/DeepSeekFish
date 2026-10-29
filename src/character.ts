import fs from 'node:fs';
import { projectRoot } from './config.js';
import { safePath } from './paths.js';

export const CHARACTER_REFERENCE='runtime/character/whalechan-reference.png';
export const BUNDLED_CHARACTER_REFERENCE='assets/character/whalechan-reference.png';
export const CHARACTER_APPEARANCE=fs.readFileSync(safePath(projectRoot(),'personas/mesugaki/appearance.txt'),'utf8').trim();
export const CHARACTER_IMAGE_GUIDANCE='用户请求“你自己”“她自己”“自拍”“自画像”或鲸酱立绘时，指的是这套鲸酱形象，不是普通蓝色小鱼或鲸鱼动物。获准生图时必须附上原设定图作为身份参考，保留发色、鲸鳍耳、呆毛、眼睛、服饰与鲸尾；姿势、表情和背景可依请求变化，默认保持附图Q版比例。当前渠道无生图工具或未获授权时，只能说明限制并整理描述，不能声称已经生成，也不能自行调用付费服务。';
export function characterPrompt():string{
  const root=projectRoot(),active=JSON.parse(fs.readFileSync(safePath(root,'personas/active.json'),'utf8'));
  if(typeof active.id!=='string'||!/^[a-z0-9-]{1,40}$/.test(active.id))throw Error('PERSONA_INVALID');
  const rp=fs.readFileSync(safePath(root,'personas/'+active.id+'/prompt.md'),'utf8').trim();
  return [rp,CHARACTER_APPEARANCE,CHARACTER_IMAGE_GUIDANCE].join('\n');
}
