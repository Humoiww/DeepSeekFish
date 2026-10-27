import fs from 'node:fs';
import { crc32 } from 'node:zlib';
import { safePath } from '../paths.js';
import { FishError } from '../types.js';
export type ImageResult = {status:'ok';path:string;mock:boolean}|{status:'unsupported';reason:string};
export interface ImageProvider { generate(prompt:string,outputDir:string):Promise<ImageResult> }
export class MockImageProvider implements ImageProvider {
  async generate(_prompt:string,outputDir:string):Promise<ImageResult>{
    const p=safePath(outputDir,'mock.png');
    // A valid fixed 1x1 PNG fixture, explicitly labelled Mock; no model invocation.
    fs.writeFileSync(p,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwmnnmPwAFLwKXS3qtSwAAAABJRU5ErkJggg==','base64'),{flag:'wx'});
    return {status:'ok',path:p,mock:true};
  }
}
export class CodexImageProvider implements ImageProvider {
  async generate():Promise<ImageResult>{return {status:'unsupported',reason:'当前 app-server/DSH 集成未验证内置 imagegen 和项目内输出路径；未调用付费 Image API。'};}
}
export function verifyPng(root:string,pathRelative:string,maxBytes:number):string{
  const p=safePath(root,pathRelative),st=fs.lstatSync(p);
  if(!st.isFile()||st.nlink!==1||st.size>maxBytes||st.size<57)throw new FishError('INVALID_PNG');
  const bytes=fs.readFileSync(p);
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new FishError('INVALID_PNG');
  let offset=8,header=false,data=false,end=false;
  while(offset+12<=bytes.length){
    const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
    if(length>maxBytes||offset+12+length>bytes.length||crc32(bytes.subarray(offset+4,offset+8+length))!==bytes.readUInt32BE(offset+8+length))throw new FishError('INVALID_PNG');
    if(!header){
      if(type!=='IHDR'||length!==13||bytes.readUInt32BE(offset+8)<1||bytes.readUInt32BE(offset+8)>8192||bytes.readUInt32BE(offset+12)<1||bytes.readUInt32BE(offset+12)>8192)throw new FishError('INVALID_PNG');
      header=true;
    }else if(type==='IHDR')throw new FishError('INVALID_PNG');
    if(type==='IDAT')data=true;
    offset+=length+12;
    if(type==='IEND'){if(length!==0||offset!==bytes.length)throw new FishError('INVALID_PNG');end=true;break;}
  }
  if(!header||!data||!end)throw new FishError('INVALID_PNG');
  return p;
}
