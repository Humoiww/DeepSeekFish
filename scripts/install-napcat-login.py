#!/usr/bin/env python3
"""Install a reproducible login-persistence adapter for the pinned NapCat build."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import hashlib
import urllib.request

p=argparse.ArgumentParser();p.add_argument('--restart',action='store_true');p.add_argument('--reload-worker',action='store_true');args=p.parse_args()
if os.geteuid()!=0:
    raise SystemExit('Run with sudo to update the isolated NapCat deployment.')
source=Path(__file__).resolve().parent.parent
base=Path('/srv/deepseekfish/napcat/vendor/napcat')
target=base/'napcat.mjs';original=base/'napcat.mjs.deepseekfish-original'
if not original.exists():
    shutil.copyfile(target,original);original.chmod(0o644)
text=original.read_text()
replacements={
 'Ke.NapCatHelper.onPasswordLoginRequested = t;':'Ke.NapCatHelper.onPasswordLoginRequested = fishLogin.wrap(t);',
 'Ke.NapCatHelper.onCaptchaLoginRequested = t;':'Ke.NapCatHelper.onCaptchaLoginRequested = fishLogin.wrap(t);',
 'Ke.NapCatHelper.onNewDeviceLoginRequested = t;':'Ke.NapCatHelper.onNewDeviceLoginRequested = fishLogin.wrap(t);',
 'Ke.WebUiConfigQuickFunction = t;':'Ke.WebUiConfigQuickFunction = fishLogin.guard(t); fishLogin.attach(pe, uin => At.UpdateAutoLoginAccount(uin));',
 'mt.post("/PasswordLogin", Vue);':'''mt.post("/FishLoginStatus", (t,e) => { try { return he(e, fishLogin.status()); } catch { return te(e,"LOGIN_STATE_UNAVAILABLE"); } });
mt.post("/FishRememberLogin", async (t,e) => { if (!pe.getQQLoginStatus() || String(t.body?.uin) !== pe.getQQLoginUin()) return te(e,"CURRENT_ACCOUNT_REQUIRED"); try { await fishLogin.save(String(t.body.uin),t.body.passwordMd5,false); return he(e,{saved:true}); } catch { return te(e,"LOGIN_SAVE_FAILED"); } });
mt.post("/FishForgetLogin", (t,e) => { try { fishLogin.forget(); return he(e,{saved:false}); } catch { return te(e,"LOGIN_DELETE_FAILED"); } });
mt.post("/PasswordLogin", (t,e,n) => { fishLogin.choose(t.body?.uin,t.body?.rememberLogin); return Vue(t,e,n); });'''
}
for before,after in replacements.items():
    if text.count(before)!=1:
        raise SystemExit('Pinned NapCat layout differs; no patch applied: '+before)
    text=text.replace(before,after,1)
text='import {fishLogin} from "./deepseekfish-login.mjs";\n'+text
assets=base/'static/assets'
manager=next(p for p in assets.glob('qq_manager-*.js') if 'static async passwordLogin' in p.read_text())
login=next(p for p in assets.glob('qq_login-*.js') if 'Me=({onSubmit:' in p.read_text())
def native_source(file):
    backup=file.with_name(file.name+'.deepseekfish-original')
    if not backup.exists():shutil.copyfile(file,backup);backup.chmod(0o644)
    return backup.read_text()
def replace_once(text,before,after):
    if text.count(before)!=1:raise SystemExit('Pinned Native login form differs; no UI patch applied.')
    return text.replace(before,after,1)
manager_text=replace_once(native_source(manager),
    'static async passwordLogin(a,i){return(await t.post("/QQLogin/PasswordLogin",{uin:a,passwordMd5:i}))',
    'static async passwordLogin(a,i,s=!1){return(await t.post("/QQLogin/PasswordLogin",{uin:a,passwordMd5:i,rememberLogin:s===!0}))')
login_text=native_source(login)
for before,after in [
    ('[w,_]=r.useState(""),Q=()=>','[w,_]=r.useState(""),[fishRemember,fishSetRemember]=r.useState(!1),Q=()=>'),
    ('n(f,w)};return','n(f,w,fishRemember)};return'),
    ('ae=async(c,s)=>','ae=async(c,s,fishRemember)=>'),
    ('C.passwordLogin(c,x)','C.passwordLogin(c,x,fishRemember)'),
    ('size:"lg",autoComplete:"new-password"})]}),e.jsx("div",{className:"flex justify-center mt-5"',
     'size:"lg",autoComplete:"new-password"}),e.jsxs("label",{className:"flex items-center gap-2 text-sm text-default-600 cursor-pointer",children:[e.jsx("input",{type:"checkbox",name:"rememberLogin",checked:fishRemember,onChange:j=>fishSetRemember(j.target.checked),disabled:l,style:{width:16,height:16,accentColor:"hsl(var(--heroui-primary))"}}),"未来自动登录"]})]}),e.jsx("div",{className:"flex justify-center mt-5"')
]:login_text=replace_once(login_text,before,after)
html=base/'static/index.html';html_original=base/'static/index.html.deepseekfish-original'
if not html_original.exists():shutil.copyfile(html,html_original);html_original.chmod(0o644)
document=html_original.read_text()
if '</body>' not in document:
    raise SystemExit('Native WebUI HTML differs; inspect before applying.')
shutil.copyfile(source/'deploy/napcat-login-memory.mjs',base/'deepseekfish-login.mjs')
(base/'deepseekfish-login.mjs').chmod(0o644)
manager.write_text(manager_text);manager.chmod(0o644)
login.write_text(login_text);login.chmod(0o644)
(assets/'deepseekfish-login.js').unlink(missing_ok=True)
temp=target.with_name('napcat.deepseekfish-next.mjs');temp.write_text(text);temp.chmod(0o644)
subprocess.run(['/srv/deepseekfish/app/runtime/tools/node/bin/node','--check',str(temp)],check=True)
temp.replace(target);html.write_text(document);html.chmod(0o644)
if args.restart:subprocess.run(['systemctl','restart','deepseekfish-napcat.service'],check=True)
elif args.reload_worker:
    token=json.loads(Path('/srv/deepseekfish/napcat/state/config/webui.json').read_text())['token']
    def call(route,body,credential=None):
        headers={'Content-Type':'application/json'}
        if credential:headers['Authorization']='Bearer '+credential
        req=urllib.request.Request('http://127.0.0.1:6099/api'+route,data=json.dumps(body).encode(),headers=headers)
        return json.load(urllib.request.urlopen(req,timeout=20))
    auth=call('/auth/login',{'hash':hashlib.sha256((token+'.napcat').encode()).hexdigest()})
    credential=auth.get('data',{}).get('Credential')
    if not credential:raise SystemExit('Native WebUI authentication failed; installed files preserved.')
    result=call('/QQLogin/RestartNapCat',{},credential)
    if result.get('code')!=0:raise SystemExit('Native worker reload was not accepted.')
print('Installed native password persistence and inline future-auto-login checkbox.')
