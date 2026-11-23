import fs from 'node:fs';
import {inflateRawSync} from 'node:zlib';
import {Parser} from 'htmlparser2';
import {FishError} from '../types.js';

// Read a specific part from the original DOCX. No archive contents are
// extracted to disk, and both compressed and expanded sizes are bounded.
export function wordText(file:string,bytes:number){
 const fd=fs.openSync(file,'r'),xmlLimit=4*1024*1024;
 const read=(at:number,size:number)=>{
  if(!Number.isSafeInteger(at)||at<0||size<0||at+size>bytes)throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');
  const out=Buffer.alloc(size);if(fs.readSync(fd,out,0,size,at)!==size)throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');
  return out;
 };
 try{
  const tail=read(Math.max(0,bytes-65557),Math.min(bytes,65557));
  let end=tail.length-22;
  while(end>=0&&(tail.readUInt32LE(end)!==0x06054b50||end+22+tail.readUInt16LE(end+20)!==tail.length))end--;
  if(end<0||tail.readUInt16LE(end+4)!==0||tail.readUInt16LE(end+6)!==0)throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');
  const entries=tail.readUInt16LE(end+10),directorySize=tail.readUInt32LE(end+12),directoryOffset=tail.readUInt32LE(end+16);
  if(entries>4096||directorySize>1024*1024||directoryOffset+directorySize>bytes-tail.length+end)throw new FishError('QQ_ATTACHMENT_DOCX_LIMIT');
  const directory=read(directoryOffset,directorySize);
  for(let n=0,cursor=0;n<entries;n++){
   if(cursor+46>directory.length||directory.readUInt32LE(cursor)!==0x02014b50)throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');
   const start=cursor;
   const nameLength=directory.readUInt16LE(start+28),nameStart=start+46,nameEnd=nameStart+nameLength;
   cursor=nameEnd+directory.readUInt16LE(start+30)+directory.readUInt16LE(start+32);
   if(cursor>directory.length)throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');
   const name=directory.toString('utf8',nameStart,nameEnd);
   if(name!=='word/document.xml')continue;
   const flags=directory.readUInt16LE(start+8),method=directory.readUInt16LE(start+10);
   const size=directory.readUInt32LE(start+24),compressed=directory.readUInt32LE(start+20),offset=directory.readUInt32LE(start+42);
   if(flags&1||![0,8].includes(method)||!size||size>xmlLimit||compressed>xmlLimit)throw new FishError('QQ_ATTACHMENT_DOCX_LIMIT');
   const header=read(offset,30);
   if(header.readUInt32LE(0)!==0x04034b50||header.readUInt16LE(8)!==method||header.readUInt16LE(6)&1||
     header.readUInt16LE(26)!==nameLength||read(offset+30,nameLength).toString('utf8')!==name)throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');
   const raw=read(offset+30+nameLength+header.readUInt16LE(28),compressed);
   let xml:Buffer;try{xml=method===0?raw:inflateRawSync(raw,{maxOutputLength:xmlLimit});}catch{throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');}
   if(xml.length!==size)throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');
   const chunks:string[]=[];let inText=false;
   new Parser({
    onopentag(tag){if(tag==='w:t')inText=true;else if(tag==='w:tab')chunks.push('\t');else if(tag==='w:br')chunks.push('\n');},
    ontext(value){if(inText)chunks.push(value);},
    onclosetag(tag){if(tag==='w:t')inText=false;else if(tag==='w:p')chunks.push('\n');},
   },{xmlMode:true,decodeEntities:true}).end(xml.toString('utf8'));
   return chunks.join('');
  }
  throw new FishError('QQ_ATTACHMENT_DOCX_INVALID');
 }finally{fs.closeSync(fd);}
}

type Box={type:string;start:number;end:number};
/** Read MP4/MOV time and track headers without loading mdat or decoding it. */
export function mp4Info(file:string,bytes:number){
 const fd=fs.openSync(file,'r');
 let remaining=4096;
 const small=(at:number,len:number)=>{
  const data=Buffer.alloc(len);return at>=0&&at+len<=bytes&&fs.readSync(fd,data,0,len,at)===len?data:undefined;
 };
 function* boxes(start:number,end:number):Iterable<Box>{
  for(;remaining>0&&start+8<=end;remaining--){
   const head=small(start,8);if(!head)return;
   const type=head.toString('ascii',4),first=head.readUInt32BE(0);
   const size=first===1?Number(small(start+8,8)?.readBigUInt64BE()):first===0?end-start:first;
   const header=first===1?16:8;
   if(!Number.isSafeInteger(size)||size<header||start+size>end)return;
   yield {type,start:start+header,end:start+size};start+=size;
  }
 }
 try{
  const roots=[...boxes(0,bytes)],brand=roots.find(b=>b.type==='ftyp'),movie=roots.find(b=>b.type==='moov');
  const format=brand&&small(brand.start,4)?.toString('ascii')==='qt  '?'mov':'mp4';
  let durationSeconds:number|undefined,width:number|undefined,height:number|undefined,audio=false;
  if(movie)for(const node of boxes(movie.start,movie.end)){
   if(node.type==='mvhd'){
    const data=small(node.start,Math.min(32,node.end-node.start));
    if(data&&((data[0]===0&&data.length>=20)||(data[0]===1&&data.length>=32))){
     const span=data[0]===0?data.readUInt32BE(16):Number(data.readBigUInt64BE(24)),scale=data.readUInt32BE(data[0]===0?12:20);
     if(scale>0&&span>0&&span!==0xffffffff&&Number.isSafeInteger(span))durationSeconds=span/scale;
    }
   }else if(node.type==='trak'){
    const children=[...boxes(node.start,node.end)],track=children.find(b=>b.type==='tkhd'),media=children.find(b=>b.type==='mdia');
    if(!media)continue;
    const handler=[...boxes(media.start,media.end)].find(b=>b.type==='hdlr');
    const type=handler&&handler.end-handler.start>=12?small(handler.start+8,4)?.toString('ascii'):undefined;
    if(type==='soun')audio=true;
    if(type==='vide'&&track&&track.end-track.start>=84&&width===undefined){
     const dims=small(track.end-8,8);
     if(dims){width=dims.readUInt32BE(0)/65536;height=dims.readUInt32BE(4)/65536;}
    }
   }
  }
  return {format,...(durationSeconds!==undefined?{durationSeconds}:{}),...(width&&height?{width,height}:{}),audio};
 }finally{fs.closeSync(fd);}
}
