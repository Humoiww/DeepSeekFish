import { spawn } from 'node:child_process';
import path from 'node:path';

/** The user explicitly requested a browser window; never use a shell or log its login fragment. */
export function openLocalBrowser(url:string):boolean{
  if(process.platform!=='win32'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)return false;
  const env:NodeJS.ProcessEnv={};
  for(const k of ['PATH','HOME','USER','LANG','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','SystemRoot','WINDIR','LOCALAPPDATA','APPDATA'])if(process.env[k])env[k]=process.env[k];
  const command=process.platform==='win32'?path.join(process.env.SystemRoot??'C:\\Windows','System32/rundll32.exe'):'xdg-open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  try{const child=spawn(command,args,{shell:false,detached:true,stdio:'ignore',env});child.on('error',()=>{console.log('无法自动打开浏览器，请手动打开终端显示的本地链接。');});child.unref();return true;}catch{return false;}
}
