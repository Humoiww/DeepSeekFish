import fs from 'node:fs';
import path from 'node:path';
import {safePath} from '../paths.js';
import {FishError} from '../types.js';
import {verifyPng} from './provider.js';

/** Parse bounded GIF blocks without executing/decompressing untrusted content. */
export function gifInfo(bytes:Buffer){
 const bad=()=>{throw new FishError('INVALID_GIF');};
 if(bytes.length<14||!['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return bad();
 const width=bytes.readUInt16LE(6),height=bytes.readUInt16LE(8);if(!width||!height||width*height>24000000)return bad();
 let at=13+(bytes[10]&128?3*(1<<((bytes[10]&7)+1)):0),frames=0,delay=0,totalPixels=0;const delays:number[]=[];
 const subblocks=()=>{for(;;){if(at>=bytes.length)bad();const n=bytes[at++];if(!n)return;if(at+n>bytes.length)bad();at+=n;}};
 while(at<bytes.length){const tag=bytes[at++];
  if(tag===0x3b){if(!frames||at!==bytes.length)bad();return {width,height,frames,animated:frames>1,delay:delays,durationMs:delays.reduce((a,b)=>a+b,0)};}
  if(tag===0x21){if(at>=bytes.length)bad();const kind=bytes[at++];if(kind===0xf9){if(at+6>bytes.length||bytes[at]!==4||bytes[at+5]!==0)bad();delay=bytes.readUInt16LE(at+2)*10;at+=6;}else subblocks();continue;}
  if(tag!==0x2c||at+9>bytes.length)return bad();
  const x=bytes.readUInt16LE(at),y=bytes.readUInt16LE(at+2),w=bytes.readUInt16LE(at+4),h=bytes.readUInt16LE(at+6),flags=bytes[at+8];at+=9;
  if(!w||!h||x+w>width||y+h>height||++frames>500||(totalPixels+=w*h)>128000000)bad();
  if(flags&128)at+=3*(1<<((flags&7)+1));if(at>=bytes.length||bytes[at]<2||bytes[at]>8)bad();at++;subblocks();delays.push(delay);delay=0;
 }return bad();
}
export function verifyGeneratedImage(root:string,relative:string,maxBytes:number){
 if(relative.toLowerCase().endsWith('.png'))return verifyPng(root,relative,maxBytes);
 if(!relative.toLowerCase().endsWith('.gif'))throw new FishError('INVALID_IMAGE_MANIFEST');
 const file=safePath(root,relative),st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1||st.size>maxBytes||st.size<14)throw new FishError('INVALID_GIF');gifInfo(fs.readFileSync(file));return file;
}
export function generatedImage(root:string,id:string,maxBytes:number,name?:string){
 if(!/^[a-z0-9-]{1,64}$/.test(id)||name!==undefined&&!['image.png','image.gif'].includes(name))throw new FishError('INVALID_IMAGE_MANIFEST');
 const folder=safePath(root,'runtime/outputs/'+id);
 const names=name?[name]:['image.png','image.gif'].filter(n=>fs.existsSync(safePath(folder,n)));
 if(names.length!==1)throw new FishError('INVALID_IMAGE_MANIFEST');return verifyGeneratedImage(folder,names[0],maxBytes);
}
export function generatedInfo(file:string){
 if(path.extname(file)==='.gif')return {format:'gif',mime:'image/gif',...gifInfo(fs.readFileSync(file))};
 return {format:'png',mime:'image/png',animated:false,frames:1};
}
