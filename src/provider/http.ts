import {FishError} from '../types.js';

/** Bound bytes while reading instead of after parsing. */
export async function boundedJson(response:Response,limit=1048576):Promise<any>{
 if(!response.body)throw new FishError('EMPTY_RESPONSE');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];
 let size=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   if(size>limit)throw new FishError('RESPONSE_TOO_LARGE');
   chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }finally{await reader.cancel().catch(()=>{});}
}
