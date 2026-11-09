import {once} from 'node:events';
import {imageMime} from '../memory/people.js';
import {MAX_IMAGE_BYTES} from '../image/limits.js';
import {FishError,codeOf} from '../types.js';

/** Trusted one-shot decoder. Binary input/output avoids base64 copies in the
 * chat process; native allocations disappear when this process exits. */
async function main(){
 const chunks:Buffer[]=[];let size=0;
 for await(const part of process.stdin){size+=part.length;if(size>MAX_IMAGE_BYTES)throw new FishError('QQ_MEDIA_TOO_LARGE');chunks.push(part);}
 const bytes=Buffer.concat(chunks);chunks.length=0;
 const mime=imageMime(bytes),{default:sharp}=await import('sharp');
 sharp.concurrency(1);sharp.cache(false);
 const options={limitInputPixels:24000000,failOn:'warning' as const,sequentialRead:true};
 const meta=await sharp(bytes,options).metadata();
 if(!meta.width||!meta.height||meta.width*(meta.pageHeight??meta.height)>24000000)throw new FishError('QQ_MEDIA_PIXEL_LIMIT');
 const pages=meta.pages??1;if(pages>500)throw new FishError('QQ_MEDIA_FRAME_LIMIT');
 const count=Math.min(4,pages),indices=Array.from({length:count},(_,i)=>count===1?0:Math.round(i*(pages-1)/(count-1)));
 const images:Buffer[]=[],frames:{index:number;atMs:number;bytes:number}[]=[];
 for(const index of indices){
  const png=await sharp(bytes,{...options,page:index,pages:1}).rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).png().timeout({seconds:5}).toBuffer();
  images.push(png);frames.push({index,atMs:(meta.delay??[]).slice(0,index).reduce((a,b)=>a+b,0),bytes:png.length});
 }
 const header=Buffer.from(JSON.stringify({mime,pages,width:meta.width,height:meta.pageHeight??meta.height,durationMs:(meta.delay??[]).reduce((a,b)=>a+b,0),frames}));
 const length=Buffer.alloc(4);length.writeUInt32BE(header.length);
 for(const part of [length,header,...images])if(!process.stdout.write(part))await once(process.stdout,'drain');
}
const deadline=setTimeout(()=>{process.stderr.write('QQ_MEDIA_DECODE_TIMEOUT\n');process.exit(124);},11000);deadline.unref();
process.stdout.on('error',()=>process.exit(1));
main().catch(e=>{process.stderr.write(codeOf(e)+'\n');process.exitCode=1;}).finally(()=>clearTimeout(deadline));
