#!/usr/bin/env python3
"""Install a reproducible login-persistence adapter for the pinned NapCat build."""
import argparse
import json
import os
from pathlib import Path
import re
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
mt.post("/PasswordLogin", Vue);'''
}
for before,after in replacements.items():
    if text.count(before)!=1:
        raise SystemExit('Pinned NapCat layout differs; no patch applied: '+before)
    text=text.replace(before,after,1)
text='import {fishLogin} from "./deepseekfish-login.mjs";\n'+text
assets=base/'static/assets'
manager=next(p for p in assets.glob('qq_manager-*.js') if 'static async passwordLogin' in p.read_text())
head=manager.read_text().split(';',1)[0]
native_index=re.search(r'from"\./([^"]+)"',head)[1]
browser=(source/'deploy/napcat-login-browser.js').read_text().replace('@NATIVE_INDEX@',native_index).replace('@QQ_MANAGER@',manager.name)
html=base/'static/index.html';html_original=base/'static/index.html.deepseekfish-original'
if not html_original.exists():shutil.copyfile(html,html_original);html_original.chmod(0o644)
document=html_original.read_text()
if '</body>' not in document:
    raise SystemExit('Native WebUI HTML differs; inspect before applying.')
document=document.replace('</body>','<script type="module" src="/webui/assets/deepseekfish-login.js"></script></body>')
shutil.copyfile(source/'deploy/napcat-login-memory.mjs',base/'deepseekfish-login.mjs')
(base/'deepseekfish-login.mjs').chmod(0o644)
(assets/'deepseekfish-login.js').write_text(browser);(assets/'deepseekfish-login.js').chmod(0o644)
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
print('Installed native password persistence, quick-login fallback and private WebUI controls.')
