import {randomBytes} from 'node:crypto';
import {FishError} from '../types.js';

export type PBField={n:number;v?:bigint;b?:Buffer};
function integer(v:bigint){
 if(v<0n||v>0xffffffffffffffffn)throw new FishError('TIEBA_PROTOBUF_INTEGER_INVALID');
 const b:number[]=[];do{b.push(Number(v&127n)|(v>127n?128:0));v>>=7n;}while(v);return Buffer.from(b);
}
export const pbNumber=(n:number,v:number|bigint)=>Buffer.concat([integer(BigInt(n*8)),integer(BigInt(v))]);
export const pbBytes=(n:number,b:Buffer)=>Buffer.concat([integer(BigInt(n*8+2)),integer(BigInt(b.length)),b]);
export const pbString=(n:number,s:string)=>pbBytes(n,Buffer.from(s));
export function parseFields(b:Buffer,error='TIEBA_PROTOBUF_INVALID'):PBField[]{
 let p=0;const out:PBField[]=[];const fail=():never=>{throw new FishError(error);};
 if(b.length>2097152)fail();
 const read=()=>{let v=0n;for(let i=0;i<10;i++){if(p>=b.length)fail();const c=b[p++];if(i===9&&c>1)fail();v|=BigInt(c&127)<<BigInt(i*7);if(!(c&128))return v;}return fail();};
 while(p<b.length){
  if(out.length>=5000)fail();const raw=read();if(raw>0xffffffffn)fail();const tag=Number(raw),n=tag>>>3,w=tag&7;if(!n)fail();
  if(w===0)out.push({n,v:read()});
  else if(w===2){const len=Number(read());if(!Number.isSafeInteger(len)||len<0||p+len>b.length)fail();out.push({n,b:b.subarray(p,p+len)});p+=len;}
  else if(w===1||w===5){p+=w===1?8:4;if(p>b.length)fail();}
  else fail();
 }return out;
}
export function protoMultipart(data:Buffer,boundary='fish-tieba-'+randomBytes(16).toString('hex')){
 if(!/^[a-zA-Z0-9-]{1,80}$/.test(boundary))throw new FishError('TIEBA_MULTIPART_BOUNDARY_INVALID');
 return {type:'multipart/form-data; boundary='+boundary,body:Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="data"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n'),data,Buffer.from('\r\n--'+boundary+'--\r\n')])};
}
