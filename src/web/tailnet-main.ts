import { tailnetGateway } from './tailnet.js';
import { isTailnetOwner } from './tailnet-identity.js';
import fs from 'node:fs';
import path from 'node:path';

const host=process.env.FISH_TAILNET_HOST??'';
const match=/^(100)\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):17863$/.exec(host);
if(!match||Number(match[2])<64||Number(match[2])>127||Number(match[3])>255||Number(match[4])>255)throw Error('TAILNET_HOST_REQUIRED');
if(process.env.LISTEN_PID!==String(process.pid)||process.env.LISTEN_FDS!=='1')throw Error('TAILNET_SOCKET_ACTIVATION_REQUIRED');
const ownerID=process.env.FISH_TAILNET_OWNER??'';
if(!/^\d+$/.test(ownerID)||!process.env.CREDENTIALS_DIRECTORY)throw Error('TAILNET_OWNER_CREDENTIAL_REQUIRED');
const token=fs.readFileSync(path.join(process.env.CREDENTIALS_DIRECTORY,'webui-admin-token'),'utf8').trim();
if(!/^[a-f0-9]{64}$/.test(token))throw Error('INVALID_GATEWAY_CREDENTIAL');
const server=tailnetGateway(host,17862,{token,owner:(address,port)=>isTailnetOwner(address,port,ownerID)});
server.listen({fd:3},()=>console.log('DeepSeekFish Tailscale-only WebUI gateway ready.'));
process.on('SIGTERM',()=>{server.close();server.closeIdleConnections();setTimeout(()=>server.closeAllConnections(),5000).unref();});
