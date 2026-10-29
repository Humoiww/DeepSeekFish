import fs from 'node:fs';
import path from 'node:path';
import { makeDir, safePath } from '../paths.js';
import { FishError } from '../types.js';
import type { ProcessSpec } from './process.js';

export const PERMISSION_PROFILE='deepseekfish-restricted-v1';
export const disabledFeatures={multi_agent:false,apps:false,hooks:false,image_generation:false,plugins:false,remote_plugin:false,
  computer_use:false,browser_use:false,skill_mcp_dependency_install:false,workspace_dependencies:false,use_legacy_landlock:false};
export function executionFeatures(imageGeneration=false):Record<string,boolean>{
  return {...disabledFeatures,image_generation:imageGeneration,...(imageGeneration?{shell_tool:false}: {})};
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
export function permissionArgs(cwd:string,root?:string,platform=process.platform):string[]{
  const runtimeReads=root&&platform==='linux'?
    `,${JSON.stringify(path.dirname(path.dirname(linuxExecutable(root))))}="read",${JSON.stringify(safePath(root,'runtime/codex-home/tmp/arg0-linux'))}="read","/opt/deepseekfish-runtime/node"="read"`:'';
  return ['-c',`default_permissions="${PERMISSION_PROFILE}"`,
    '-c',`permissions.${PERMISSION_PROFILE}.filesystem={":root"="deny",":minimal"="read",${JSON.stringify(cwd)}="write"${runtimeReads}}`,
    '-c',`permissions.${PERMISSION_PROFILE}.network.enabled=false`];
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
export function linuxSpec(root:string,cwd:string,args:string[]):ProcessSpec {
  const binary=bubblewrap(root);if(!binary)throw new FishError('CODEX_BWRAP_MISSING');
  cwd=taskDirectory(root,cwd);
  const temp=makeDir(root,'runtime/tmp/codex-'+path.basename(cwd));
  const cache=makeDir(root,'runtime/cache/codex');
  const env=childEnvironment(root);
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
  const modules=safePath(root,'node_modules'),home=safePath(root,'runtime/codex-home');
  // Deliberately never bind the repository root, /home, /run or host /proc.
  mounts.push('--proc','/proc','--dev','/dev','--ro-bind',fs.realpathSync(process.execPath),'/opt/deepseekfish-runtime/node','--ro-bind',modules,modules,
    '--bind',home,home,'--bind',temp,temp,'--bind',cache,cache,'--bind',cwd,cwd,
    '--bind',temp,'/tmp','--remount-ro','/','--chdir',cwd,'--',linuxExecutable(root),...args);
  return {command:binary,args:mounts,cwd,env};
}
export function appServerSpec(root:string,cwd:string,platform=process.platform,imageGeneration=false):ProcessSpec {
  cwd=taskDirectory(root,cwd);
  if(!['linux','win32'].includes(platform))throw new FishError('CODEX_PLATFORM_UNSUPPORTED');
  const args=['app-server','--listen','stdio://','-c','approval_policy="never"',...permissionArgs(cwd,root,platform),
    '-c','cli_auth_credentials_store="file"','-c','web_search="disabled"','-c','mcp_servers={}',
    ...Object.entries(executionFeatures(imageGeneration)).flatMap(([key,value])=>['-c',`features.${key}=${value}`])];
  if(platform==='linux')return linuxSpec(root,cwd,args);
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
