import { request } from 'node:http';

/** Authenticate the actual TCP peer via tailscaled, never forwarded headers. */
export function isTailnetOwner(address:string,port:number,ownerID:string):Promise<boolean>{
  const ip=address.replace(/^::ffff:/,'');
  if(!/^100\.(?:\d{1,3}\.){2}\d{1,3}$/.test(ip))return Promise.resolve(false);
  return new Promise(resolve=>{
    const req=request({socketPath:'/run/tailscale/tailscaled.sock',path:'/localapi/v0/whois?addr='+encodeURIComponent(ip+':'+port),headers:{Host:'local-tailscaled.sock'},timeout:1500},res=>{
      let body='';res.setEncoding('utf8');
      res.on('data',chunk=>{body+=chunk;if(body.length>65536){res.destroy();resolve(false);}});
      res.on('error',()=>resolve(false));
      res.on('end',()=>{try{resolve(res.statusCode===200&&String(JSON.parse(body).UserProfile?.ID)===ownerID);}catch{resolve(false);}});
    });
    req.on('error',()=>resolve(false));req.on('timeout',()=>{req.destroy();resolve(false);});req.end();
  });
}
