import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import sharp from 'sharp';
import {AnimationMp4} from './video-mp4.js';
import {VIDEO_FPS,type VideoPlan,type VideoScene} from './video-plan.js';

const xml=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
function drawLayer(layer:VideoScene['layers'][number],width:number,height:number,progress:number):string{
 const x=width*(layer.x+layer.dx*progress)/100,y=height*(layer.y+layer.dy*progress)/100;
 const rx=width*layer.width/200,ry=height*layer.height/200;
 const fill=layer.color;
 switch(layer.shape){
  case 'ellipse':return `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}"/>`;
  case 'ring':return `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="none" stroke="${fill}" stroke-width="${Math.max(1,Math.min(rx,ry)/5)}"/>`;
  case 'rect':return `<rect x="${x-rx}" y="${y-ry}" width="${2*rx}" height="${2*ry}" rx="${Math.min(rx,ry)*0.15}" fill="${fill}"/>`;
  default:{
   const vertices=layer.shape==='triangle'?3:layer.shape==='diamond'?4:10;
   const points=Array.from({length:vertices},(_,i)=>{
    const angle=2*Math.PI*i/vertices-Math.PI/2,scale=vertices===10&&i%2?0.44:1;
    return `${x+Math.cos(angle)*rx*scale},${y+Math.sin(angle)*ry*scale}`;
   }).join(' ');
   return `<polygon points="${points}" fill="${fill}"/>`;
  }
 }
}
function drawText(value:string,width:number,height:number,y:number,maxSize:number):string{
 const limit=width<200?12:21,chars=Array.from(value),lines:string[]=[];
 for(let i=0;i<chars.length;i+=limit)lines.push(chars.slice(i,i+limit).join(''));
 const size=Math.min(maxSize,(width-20)/Math.min(limit,chars.length),height*0.34/(lines.length*1.2));
 return lines.map((line,i)=>`<text x="${width/2}" y="${y+(i-(lines.length-1)/2)*size*1.2}" text-anchor="middle" dominant-baseline="central" font-family="Noto Sans CJK SC, sans-serif" font-weight="bold" font-size="${size}" fill="#ffffff" stroke="#102037" stroke-width="${size/12}" paint-order="stroke">${xml(line)}</text>`).join('');
}
function frame(plan:VideoPlan,width:number,height:number,index:number,total:number):string{
 const end=plan.endText?total-VIDEO_FPS:total,position=Math.min(index,end-1);
 const sceneIndex=Math.floor(position*plan.scenes.length/end);
 const start=Math.ceil(sceneIndex*end/plan.scenes.length),stop=Math.ceil((sceneIndex+1)*end/plan.scenes.length);
 const scene=plan.scenes[sceneIndex],t=(position-start)/Math.max(1,stop-start-1);
 const art=scene.layers.map(layer=>drawLayer(layer,width,height,t)).join('');
 const count=plan.countdown?index<end?String(plan.countdown-Math.floor(index*plan.countdown/end)):plan.endText:undefined;
 const title=count?drawText(count,width,height,height*0.46,height*0.4):'';
 const subtitle=scene.caption?drawText(scene.caption,width,height,art||title?height*0.79:height*0.5,art||title?18:34):'';
 return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${scene.background}"/>${art}${title}${subtitle}</svg>`;
}

// The parent validates the structured scene and supplies it over this pipe.
// The renderer loads no user-selected files, URLs, scripts or markup.
async function main(){
 let input='';
 process.stdin.setEncoding('utf8');
 for await(const part of process.stdin){
  input+=part;
  if(Buffer.byteLength(input)>16384)throw Error('QQ_VIDEO_PLAN_TOO_LARGE');
 }
 const plan:VideoPlan=JSON.parse(input);
 const [width,height]=plan.orientation==='portrait'?[180,320]:[320,180];
 sharp.cache(false);sharp.concurrency(1);
 const movie=new AnimationMp4(width,height),total=plan.durationSeconds*VIDEO_FPS;
 let previous='';
 for(let index=0;index<total;index++){
  const svg=frame(plan,width,height,index,total);
  const rgb=svg===previous?undefined:await sharp(Buffer.from(svg),{limitInputPixels:width*height}).removeAlpha().raw().toBuffer();
  movie.append(rgb);previous=svg;
 }
 await pipeline(Readable.from(movie.parts()),process.stdout);
}

main().catch(error=>{console.error(error);process.exitCode=1;});
