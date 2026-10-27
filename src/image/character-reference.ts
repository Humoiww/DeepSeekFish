import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CHARACTER_APPEARANCE,CHARACTER_REFERENCE } from '../character.js';
import { safePath } from '../paths.js';
import { FishError } from '../types.js';
import { taskDirectory } from '../codex/platform.js';
import { verifyPng } from './provider.js';

export interface CharacterReference {path:string;sha256:string}
export function isCharacterPortrait(prompt:string):boolean{
  return /(?:[你她](?:自己|本人)|你的(?:照片|图片|图|画像|立绘|形象|样子)|自画像|自拍|鲸酱|whale[- ]?chan|self[- ]?portrait|portrait of yourself|your (?:own )?(?:portrait|selfie))/i.test(prompt);
}
export function prepareCharacterPortrait(root:string,cwd:string,prompt:string,character=isCharacterPortrait(prompt)):{prompt:string;reference?:CharacterReference}{
  if(!character)return {prompt};
  cwd=taskDirectory(root,cwd);
  const source=safePath(root,CHARACTER_REFERENCE);
  if(!fs.existsSync(source))throw new FishError('CHARACTER_REFERENCE_MISSING');
  verifyPng(root,CHARACTER_REFERENCE,10485760);
  const target=safePath(cwd,'character-reference.png');
  fs.copyFileSync(source,target,fs.constants.COPYFILE_EXCL);
  const sha256=createHash('sha256').update(fs.readFileSync(target)).digest('hex');
  return {prompt:CHARACTER_APPEARANCE+'\n生成用户请求的同一位鲸酱。附带的 character-reference.png 是身份参考；必须在内置生图工具的 referenced_image_paths 中使用它，不能把参考图直接当作新作品返回。保留身份特征，默认附图Q版比例；只生成一张 PNG。\n用户要求：'+prompt,
    reference:{path:target,sha256}};
}
export function verifyCharacterReference(items:{inputImages?:{path:string;sha256:string}[]}[],reference:CharacterReference):void{
  if(items.length!==1||!items[0].inputImages?.some(input=>input.path===reference.path&&input.sha256===reference.sha256))throw new FishError('CHARACTER_REFERENCE_NOT_USED');
}
