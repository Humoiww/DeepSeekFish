import {VIDEO_FPS} from './video-plan.js';

function integers(bytes:number,values:number[]):Buffer{
 const result=Buffer.allocUnsafe(bytes*values.length);
 values.forEach((value,index)=>result.writeUIntBE(value,index*bytes,bytes));
 return result;
}
const u8=(...v:number[])=>integers(1,v);
const u16=(...v:number[])=>integers(2,v);
const u32=(...v:number[])=>integers(4,v);
const ascii=(s:string)=>Buffer.from(s,'ascii');
const box=(name:string,...contents:Buffer[])=>Buffer.concat([u32(8+contents.reduce((sum,b)=>sum+b.length,0)),ascii(name),...contents]);
const full=(name:string,flags:number,...contents:Buffer[])=>box(name,u32(flags),...contents);

class Bits {
 private length=0;
 constructor(private bytes:Buffer){}
 bit(bit:number){
  if(bit)this.bytes[this.length>>>3]|=1<<(7-(this.length&7));
  this.length++;
 }
 uint(value:number,width:number){
  for(let bit=width-1;bit>=0;bit--)this.bit(value>>>bit&1);
 }
 ue(value:number){
  const width=32-Math.clz32(value+1);
  this.length+=width-1;
  this.uint(value+1,width);
 }
 pcm(bytes:Buffer,start:number,end:number){
  const offset=Math.ceil(this.length/8);
  bytes.copy(this.bytes,offset,start,end);
  this.length=(offset+end-start)*8;
 }
 finish(){
  this.bit(1); // rbsp_stop_one_bit, followed by zero alignment.
  return this.bytes.subarray(0,Math.ceil(this.length/8));
 }
}

function nal(header:number,bits:Bits):Buffer{
 const raw=bits.finish(),escaped=Buffer.allocUnsafe(1+raw.length*2);
 escaped[0]=header;
 let zeros=0,length=1;
 for(const byte of raw){
  if(zeros===2&&byte<=3){escaped[length++]=3;zeros=0;}
  escaped[length++]=byte;
  zeros=byte===0?zeros+1:0;
 }
 return Buffer.from(escaped.subarray(0,length));
}

const pcmSize=384; // 16x16 luma and two 8x8 chroma blocks, YUV 4:2:0.
const framesPerKeyframe=48;
function parameterSets(width:number,height:number,columns:number,rows:number){
 const sps=new Bits(Buffer.alloc(64));
 sps.uint(66,8);sps.uint(0xc0,8);sps.uint(31,8); // Constrained Baseline, level 3.1.
 sps.ue(0); // seq_parameter_set_id
 sps.ue(0); // 4-bit frame_num
 sps.ue(2); // POC follows decode order with no B frames.
 sps.ue(1);sps.bit(0); // one reference, no frame_num gaps
 sps.ue(columns-1);sps.ue(rows-1);
 sps.bit(1);sps.bit(1); // progressive frames; direct_8x8_inference_flag
 sps.bit(1);sps.ue(0);sps.ue((columns*16-width)/2);sps.ue(0);sps.ue((rows*16-height)/2);
 sps.bit(0); // Timing and colour information are in the MP4.
 const pps=new Bits(Buffer.alloc(16));
 pps.ue(0);pps.ue(0); // PPS and SPS IDs
 pps.bit(0);pps.bit(0); // CAVLC; no bottom-field POC
 pps.ue(0);pps.ue(0);pps.ue(0); // one slice group and default reference counts
 pps.bit(0);pps.uint(0,2); // no weighted prediction
 pps.ue(0);pps.ue(0);pps.ue(0); // zero signed QP/QS/chroma offsets
 pps.bit(1);pps.bit(0);pps.bit(0); // signal deblocking mode in slice, no redundant picture
 return [nal(0x67,sps),nal(0x68,pps)];
}

/** Encode the bounded animation as standard AVC. Use lossless I_PCM blocks
 * for changed pixels and zero-motion P skips for unchanged parts of a frame. */
export class AnimationMp4 {
 private readonly columns:number;
 private readonly rows:number;
 private current:Buffer;
 private previous:Buffer;
 private samples:Buffer[]=[];
 private keyframes:number[]=[];
 constructor(private width:number,private height:number){
  this.columns=Math.ceil(width/16);this.rows=Math.ceil(height/16);
  this.current=Buffer.allocUnsafe(this.columns*this.rows*pcmSize);
  this.previous=Buffer.allocUnsafe(this.current.length);
 }
 // Limited-range BT.601 from RGB. Pad the cropped edges with their last pixel.
 private pixels(rgb:Buffer){
  for(let by=0;by<this.rows;by++)for(let bx=0;bx<this.columns;bx++){
   const base=(by*this.columns+bx)*pcmSize;
   for(let y=0;y<16;y+=2)for(let x=0;x<16;x+=2){
    let r=0,g=0,b=0;
    for(let i=0;i<4;i++){
     const dx=i&1,dy=i>>1;
     const source=(Math.min(this.height-1,by*16+y+dy)*this.width+Math.min(this.width-1,bx*16+x+dx))*3;
     const red=rgb[source],green=rgb[source+1],blue=rgb[source+2];
     this.current[base+(y+dy)*16+x+dx]=16+((66*red+129*green+25*blue+128)>>8);
     r+=red;g+=green;b+=blue;
    }
    const chroma=(y>>1)*8+(x>>1);
    this.current[base+256+chroma]=128+((-38*r-74*g+112*b+512)>>10);
    this.current[base+320+chroma]=128+((112*r-94*g-18*b+512)>>10);
   }
  }
 }
 append(rgb?:Buffer){
  const index=this.samples.length,frameNumber=index%framesPerKeyframe,key=frameNumber===0;
  if(rgb)this.pixels(rgb);
  const source=rgb?this.current:this.previous;
  const macroblocks=this.columns*this.rows,bits=new Bits(Buffer.alloc(macroblocks*(pcmSize+4)+64));
  bits.ue(0);bits.ue(key?2:0);bits.ue(0); // first_mb, slice_type, PPS id
  bits.uint(frameNumber%16,4);
  if(key){
   this.keyframes.push(index+1);
   bits.ue((index/framesPerKeyframe)%2);bits.bit(0);bits.bit(0); // idr_pic_id and reference flags
  }else{bits.bit(0);bits.bit(0);bits.bit(0);} // default references, no list changes or adaptive marking
  bits.ue(0);bits.ue(1); // delta QP zero, deblocking off to preserve exact reference blocks
  let skipped=0;
  for(let block=0;block<macroblocks;block++){
   const from=block*pcmSize,to=from+pcmSize;
   if(!key){
    if(!rgb||source.compare(this.previous,from,to,from,to)===0){skipped++;continue;}
    bits.ue(skipped);skipped=0;
   }
   bits.ue(key?25:30); // I_PCM in an I or P slice respectively
   bits.pcm(source,from,to);
  }
  if(skipped)bits.ue(skipped);
  const sample=nal(key?0x65:0x41,bits);
  this.samples.push(Buffer.concat([u32(sample.length),sample]));
  if(rgb)[this.previous,this.current]=[this.current,this.previous];
 }
 parts():Buffer[]{
  const [sps,pps]=parameterSets(this.width,this.height,this.columns,this.rows);
  const avcC=box('avcC',u8(1,sps[1],sps[2],sps[3],255,225),u16(sps.length),sps,u8(1),u16(pps.length),pps);
  const colr=box('colr',ascii('nclx'),u16(6,6,6),u8(0)); // BT.601, limited range.
  const avc1=box('avc1',Buffer.alloc(6),u16(1),Buffer.alloc(16),u16(this.width,this.height),
   u32(72<<16,72<<16,0),u16(1),Buffer.alloc(32),u16(24,65535),avcC,colr);
  const duration=this.samples.length,ftyp=box('ftyp',ascii('isom'),u32(512),ascii('isomiso2avc1mp41'));
  const sizes=this.samples.map(s=>s.length),matrix=u32(65536,0,0,0,65536,0,0,0,0x40000000);
  const mvhd=full('mvhd',0,u32(0,0,VIDEO_FPS,duration,65536),u16(256,0),Buffer.alloc(8),matrix,Buffer.alloc(24),u32(2));
  const tkhd=full('tkhd',7,u32(0,0,1,0,duration),Buffer.alloc(16),matrix,u32(this.width<<16,this.height<<16));
  const mdhd=full('mdhd',0,u32(0,0,VIDEO_FPS,duration),u16(0x55c4,0)); // und
  const hdlr=full('hdlr',0,u32(0),ascii('vide'),Buffer.alloc(12),ascii('VideoHandler\0'));
  const dref=full('dref',0,u32(1),full('url ',1));
  const stsd=full('stsd',0,u32(1),avc1);
  const stts=full('stts',0,u32(1,duration,1));
  const stsc=full('stsc',0,u32(1,1,duration,1));
  const stsz=full('stsz',0,u32(0,duration,...sizes));
  const stss=full('stss',0,u32(this.keyframes.length,...this.keyframes));
  const movie=(offset:number)=>{
   const stbl=box('stbl',stsd,stts,stsc,stsz,full('stco',0,u32(1,offset)),stss);
   const minf=box('minf',full('vmhd',1,Buffer.alloc(8)),box('dinf',dref),stbl);
   return box('moov',mvhd,box('trak',tkhd,box('mdia',mdhd,hdlr,minf)));
  };
  // Fast-start layout, with one chunk of sequential video samples.
  const moov=movie(ftyp.length+movie(0).length+8);
  const mdat=Buffer.concat([u32(8+sizes.reduce((total,size)=>total+size,0)),ascii('mdat')]);
  return [ftyp,moov,mdat,...this.samples];
 }
}
