import fs from 'node:fs';
import path from 'node:path';
import { makeDir, safePath } from '../paths.js';
import { FishError } from '../types.js';
import type { ProcessSpec } from './process.js';

export const PERMISSION_PROFILE='deepseekfish-restricted-v1';
export const codexWebSearchMode=(development:boolean)=>development?'live':'disabled';
const developmentNetworkDomains={
  'github.com':'allow',
  'api.github.com':'allow',
  'raw.githubusercontent.com':'allow',
  'codeload.github.com':'allow',
};
export const disabledFeatures={multi_agent:false,apps:false,hooks:false,image_generation:false,plugins:false,remote_plugin:false,
  computer_use:false,browser_use:false,skill_mcp_dependency_install:false,workspace_dependencies:false,use_legacy_landlock:false};
export function executionFeatures(imageGeneration=false):Record<string,boolean>{
  return {...disabledFeatures,image_generation:imageGeneration,image_generation_animation:imageGeneration,...(imageGeneration?{shell_tool:false}: {})};
}
export function childEnvironment(root:string):NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const k of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL'])if(process.env[k])env[k]=process.env[k];
  env.CODEX_HOME=safePath(root,'runtime/codex-home');
  env.TMP=env.TEMP=env.TMPDIR=safePath(root,'runtime/tmp');
  env.XDG_CACHE_HOME=safePath(root,'runtime/cache');
  env.NO_COLOR='1';env.CODEX_DISABLE_UPDATE_CHECK='1';
  return env;
}
export function codexEntry(root:string):string{return safePath(root,'node_modules/@openai/codex/bin/codex.js');}
/** Adapt the existing app-server client to its native WebSocket-over-Unix transport. */
export function nativeDaemonSpec(installation:string,socket:string):ProcessSpec {
  const transport=`
    import net from 'node:net';
    import {createInterface} from 'node:readline';
    import {createRequire} from 'node:module';
    const [socket,dependencies]=process.argv.slice(1);
    const WebSocket=createRequire(dependencies)('ws');
    const ws=new WebSocket('ws://localhost/',{createConnection:()=>net.createConnection(socket),handshakeTimeout:5000});
    ws.on('open',()=>{
      const input=createInterface({input:process.stdin,crlfDelay:Infinity});
      input.on('line',line=>{if(ws.readyState===WebSocket.OPEN)ws.send(line);});
      input.on('close',()=>ws.close());
    });
    ws.on('message',bytes=>process.stdout.write(bytes.toString()+'\\n'));
    ws.on('error',error=>{console.error(error.message);process.exitCode=1;});
    ws.on('close',()=>process.stdin.destroy());`;
  return {command:process.execPath,args:['--input-type=module','--eval',transport,socket,safePath(installation,'package.json')],
    cwd:installation,env:childEnvironment(installation)};
}
export function permissionArgs(cwd:string,root?:string,platform=process.platform,installation=root,development=false):string[]{
  const fileSystem:Record<string,string>={':root':'deny',':minimal':'read',[cwd]:'write'};
  if(root&&platform==='linux'){
    fileSystem[path.dirname(path.dirname(linuxExecutable(installation!)))]='read';
    // A task grant must leave the shared login and session store inaccessible.
    if(development){
      fileSystem[safePath(installation!,'runtime/codex-home')]='deny';
      const authority=safePath(cwd,'src/development');
      if(fs.existsSync(authority))fileSystem[authority]='read';
    }
    else fileSystem[safePath(installation!,'runtime/codex-home/tmp/arg0-linux')]='read';
    fileSystem['/opt/deepseekfish-runtime/node']='read';
  }
  return ['-c',`default_permissions="${PERMISSION_PROFILE}"`,
    '-c',`permissions.${PERMISSION_PROFILE}.filesystem={${Object.entries(fileSystem).map(([key,value])=>`${JSON.stringify(key)}="${value}"`).join(',')}}`,
    '-c',`permissions.${PERMISSION_PROFILE}.network.enabled=${development}`,
    ...(development?['-c','features.network_proxy=true',
      '-c',`permissions.${PERMISSION_PROFILE}.network.domains={${Object.entries(developmentNetworkDomains)
        .map(([domain,rule])=>`${JSON.stringify(domain)}=${JSON.stringify(rule)}`).join(',')}}`,
      '-c',`permissions.${PERMISSION_PROFILE}.network.allow_local_binding=false`,
      '-c',`permissions.${PERMISSION_PROFILE}.network.allow_upstream_proxy=false`,
      '-c',`permissions.${PERMISSION_PROFILE}.network.enable_socks5_udp=false`]:[])];
}
export function taskDirectory(root:string,cwd:string):string {
  const workspace=safePath(root,'runtime/workspace'),relative=path.relative(workspace,path.resolve(cwd));
  if(!/^[a-z0-9-]{1,64}$/.test(relative))throw new FishError('CODEX_INVALID_WORKDIR');
  const expected=safePath(workspace,relative);
  if(!fs.statSync(expected).isDirectory())throw new FishError('CODEX_INVALID_WORKDIR');
  return expected;
}
export function linuxExecutable(root:string,arch=process.arch):string {
  const triples:Record<string,string>={x64:'x86_64-unknown-linux-musl',arm64:'aarch64-unknown-linux-musl'};
  if(!triples[arch])throw new FishError('CODEX_LINUX_ARCH_UNSUPPORTED');
  const p=safePath(root,`node_modules/@openai/codex-linux-${arch}/vendor/${triples[arch]}/bin/codex`);
  if(!fs.existsSync(p))throw new FishError('CODEX_NATIVE_PAYLOAD_MISSING');
  return p;
}
export function bubblewrap(root:string):string|undefined {
  // An administrator may install a narrowly scoped AppArmor launcher. Never
  // trust a service-writable binary or ancestor for this privileged policy.
  try {
    const scoped=safePath(root,'runtime/tools/bwrap');
    let p=scoped;
    for(;;){
      const st=fs.lstatSync(p);
      if(st.uid!==0||(st.mode&0o022)!==0||st.isSymbolicLink())throw new Error('untrusted launcher');
      if(path.dirname(p)===p)break;
      p=path.dirname(p);
    }
    fs.accessSync(scoped,fs.constants.X_OK);return scoped;
  }catch{}
  const candidates=['/usr/bin/bwrap','/bin/bwrap'];
  try { candidates.push(path.join(path.dirname(linuxExecutable(root)),'../codex-resources/bwrap')); } catch {}
  for(const p of candidates){try{fs.accessSync(p,fs.constants.X_OK);return fs.realpathSync(p);}catch{}}
}
/** A fresh mount/PID namespace hides the user's home and all other projects
 * from the entire app-server. Inner Codex profiles separately protect its auth. */
export function linuxSpec(root:string,cwd:string,args:string[],options:{installation?:string;trial?:string;development?:boolean}={}):ProcessSpec {
  const installation=options.installation??root;
  const binary=bubblewrap(installation);if(!binary)throw new FishError('CODEX_BWRAP_MISSING');
  cwd=taskDirectory(root,cwd);
  const temp=makeDir(root,'runtime/tmp/codex-'+path.basename(cwd));
  const cache=options.development?makeDir(temp,'cache'):makeDir(root,'runtime/cache/codex');
  const env=options.trial?{NO_COLOR:'1',LANG:'C.UTF-8'}:childEnvironment(installation);
  env.PATH='/opt/deepseekfish-runtime:/usr/bin:/bin';env.TMP=env.TEMP=env.TMPDIR=temp;env.XDG_CACHE_HOME=cache;
  const mounts=['--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--die-with-parent','--new-session','--cap-drop','ALL'];
  for(const dir of ['/usr','/bin','/sbin','/lib','/lib64']){
    if(!fs.existsSync(dir))continue;
    if(fs.lstatSync(dir).isSymbolicLink())mounts.push('--symlink',fs.readlinkSync(dir),dir);
    else mounts.push('--ro-bind',dir,dir);
  }
  for(const file of ['/etc/ssl','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf','/etc/ld.so.cache','/etc/passwd','/etc/group','/etc/gai.conf']){
    if(fs.existsSync(file))mounts.push('--ro-bind',fs.realpathSync(file),file);
  }
  const modules=safePath(installation,'node_modules'),home=safePath(installation,'runtime/codex-home');
  // Deliberately never bind the repository root, /home, /run or host /proc.
  mounts.push('--proc','/proc','--dev','/dev','--ro-bind',fs.realpathSync(process.execPath),'/opt/deepseekfish-runtime/node','--ro-bind',modules,modules,
    '--bind',temp,temp,'--bind',cwd,cwd);
  if(options.development){
    const authority=safePath(cwd,'src/development');
    if(fs.existsSync(authority))mounts.push('--ro-bind',authority,authority);
  }
  if(options.trial)mounts.push('--unshare-net','--ro-bind',options.trial,'/opt/fish-trial.mjs');
  else{
    mounts.push('--bind',home,home);
    if(!options.development)mounts.push('--bind',cache,cache);
  }
  if(root!==installation)mounts.push('--ro-bind',modules,path.join(cwd,'node_modules'));
  mounts.push('--bind',temp,'/tmp','--remount-ro','/','--chdir',cwd,'--',
    options.trial?'/opt/deepseekfish-runtime/node':linuxExecutable(installation),...args);
  return {command:binary,args:mounts,cwd,env};
}
export function appServerSpec(root:string,cwd:string,platform=process.platform,imageGeneration=false,installation=root,development=false):ProcessSpec {
  cwd=taskDirectory(root,cwd);
  if(!['linux','win32'].includes(platform))throw new FishError('CODEX_PLATFORM_UNSUPPORTED');
  const args=['app-server','--listen','stdio://','-c','approval_policy="never"',...permissionArgs(cwd,root,platform,installation,development),
    '-c','cli_auth_credentials_store="file"','-c',`web_search="${codexWebSearchMode(development)}"`,'-c','mcp_servers={}',
    ...Object.entries(executionFeatures(imageGeneration)).flatMap(([key,value])=>['-c',`features.${key}=${value}`])];
  if(platform==='linux')return linuxSpec(root,cwd,args,{installation,development});
  const command=[process.execPath,codexEntry(root),...args,'-c','windows.sandbox="mxc"'];
  const quote=(s:string)=>'"'+s.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
  return {command:path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    args:['-NoProfile','-NonInteractive','-File',safePath(root,'scripts/windows-job.ps1'),'-OwnerPid',String(process.pid),
      '-CommandBase64',Buffer.from(command.map(quote).join(' '),'utf16le').toString('base64')],cwd,env:childEnvironment(root)};
}
export function boundaryStatus(root:string):{platform:string;launcher:string;available:boolean;detail:string}{
  if(process.platform==='linux'){
    const binary=bubblewrap(root);
    return {platform:'linux',launcher:'bubblewrap PID/mount namespace + Codex permission profile',available:!!binary,
      detail:binary?'not probed; run npm run cli -- sandbox-check':'bubblewrap missing; QQ/DeepSeek/Mock still work'};
  }
  return {platform:process.platform,launcher:process.platform==='win32'?'Windows MXC + Job Object':'unsupported',
    available:process.platform==='win32',detail:'requires sandbox-check; no unattended execution'};
}
