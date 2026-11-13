#!/usr/bin/env python3
"""Deploy the human-only Tieba login surface into the existing browser worker.
No account state, app settings, keys or machine network configuration is copied.
"""
import argparse,datetime,json,os,pwd,shutil,sqlite3,subprocess,time,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path('/srv/deepseekfish/app'));args=p.parse_args()
if os.geteuid()!=0:raise SystemExit('Run with sudo; only the existing app/capture units are managed.')
source=Path(__file__).resolve().parent.parent;root=args.root.resolve()
if root!=Path('/srv/deepseekfish/app'):raise SystemExit('This VPS installer targets /srv/deepseekfish/app only.')
for item in [root,root/'runtime',root/'runtime/tieba-account']:
 if item.is_symlink():raise SystemExit('Refusing linked runtime paths.')
worker=pwd.getpwnam('fishview')
chrome=Path('/srv/deepseekfish/capture/browser/chrome-headless-shell')
if not chrome.is_file():raise SystemExit('Install the existing browser worker first: sudo python3 scripts/install-capture.py --stage-only')
actual=subprocess.check_output([str(chrome),'--version'],text=True).strip()
if actual!='Google Chrome for Testing 156.0.8078.47':raise SystemExit('Browser differs from the reviewed existing version: '+actual)
files=['src/capture/cdp.ts','src/capture/server.ts','src/capture/tieba-browser.ts','src/tieba/session.ts','src/tieba/client.ts','src/tieba/posting.ts','src/tieba/replies.ts','src/tieba/reply-watch.ts','src/agent/bot.ts','src/exploration/tools.ts','src/exploration/state.ts','src/exploration/worker.ts','src/search/tieba.ts','src/search/public-web.ts','src/web/app.ts','src/web/server.ts','src/web/tailnet.ts','src/web/public/index.html','src/web/public/web.css','src/web/public/tieba.js','scripts/install-tieba-session.py','scripts/migrate-state.py','docs/tieba-account.md','scripts/smoke-tieba-posting.mjs']
files.extend(['src/tieba/app-post.ts','src/tieba/protobuf.ts','third_party/dsh-tieba-dive.LICENSE','docs/tieba-reply-transport.md'])
for name in list(files):
 if name.endswith('.ts'):files.extend(['dist/'+name[:-3]+'.js','dist/'+name[:-3]+'.js.map'])
files.append('src/web/public/exploration.js')
for name in files:
 if not (source/name).is_file():raise SystemExit('Build/copy missing: '+name)
# Refuse to interrupt actual model, publication or image work. No model calls.
def idle():
 for filename in ['fish.sqlite','webui.sqlite']:
  db=sqlite3.connect('file:'+str(root/'runtime/data'/filename)+'?mode=ro',uri=True)
  try:
   tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
   for table,states in [('reservations',"'held'"),('exploration_runs',"'running'"),('web_turns',"'running'"),('tasks',"'running'")]:
    if table in tables and db.execute(f'SELECT 1 FROM {table} WHERE state IN ({states}) LIMIT 1').fetchone():raise SystemExit('Active '+table+'; wait for this work to finish, then rerun.')
  finally:db.close()
 for unit in ['deepseekfish-daily-news.service','deepseekfish-daily-qzone.service']:
  if subprocess.run(['systemctl','is-active','--quiet',unit]).returncode==0:raise SystemExit('Active scheduled work; rerun after completion.')
idle()
backup=Path('/srv/deepseekfish/backups')/('tieba-session-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'));backup.mkdir(mode=0o700)
records=[]
def preserve(destination):
 key=str(len(records));prior=backup/key
 if destination.exists():shutil.copy2(destination,prior)
 records.append((str(destination),key if destination.exists() else None))
def install_file(src,dest):
 preserve(dest);dest.parent.mkdir(parents=True,exist_ok=True);tmp=dest.with_name(dest.name+'.tieba-deploy');shutil.copyfile(src,tmp);tmp.chmod(0o644);os.replace(tmp,dest)
def install_text(dest,text):
 preserve(dest);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_text(text);dest.chmod(0o644)
units=['deepseekfish-web.service','deepseekfish-qq.service','deepseekfish-tailnet.service','deepseekfish-capture.socket','deepseekfish-capture.service','deepseekfish-tailnet.socket']
prior_units={u:subprocess.run(['systemctl','is-active','--quiet',u]).returncode==0 for u in units}
unchanged=['deepseekfish-napcat.service','ssh.service','tailscaled.service']
pids=lambda:{u:subprocess.check_output(['systemctl','show',u,'-p','MainPID','--value'],text=True).strip() for u in unchanged}
baseline=pids()
try:
 # Stop the path watcher first, so queued startup cannot race file installation.
 subprocess.run(['systemctl','stop','deepseekfish-qq.path',*units],check=True,timeout=80)
 for name in files:install_file(source/name,root/name)
 private=root/'runtime/tieba-account';private.mkdir(mode=0o700,exist_ok=True)
 if private.stat().st_uid not in [0,worker.pw_uid]:raise RuntimeError('Unexpected account directory owner')
 os.chown(private,worker.pw_uid,worker.pw_gid);private.chmod(0o700)
 marker=private/'installed.json'
 if not marker.exists():marker.write_text(json.dumps({'version':1,'browser':'156.0.8078.47','driver':'private-cdp-pipe'}));os.chown(marker,worker.pw_uid,worker.pw_gid);marker.chmod(0o600)
 policy=private/'publishing.json'
 if not policy.exists():
  saved=json.loads((private/'status.json').read_text()) if (private/'status.json').exists() else {};who=saved.get('identity') or saved.get('lastIdentity')
  # A fresh install must expose the login page before an identity exists.
  # The first successful human check will initialize preview for that UID.
  if who and str(who.get('id','')).isdigit():
   policy.write_text(json.dumps({'mode':'preview','accountId':str(who['id'])}));os.chown(policy,0,worker.pw_gid);policy.chmod(0o640)
 install_text(Path('/etc/systemd/system/deepseekfish-capture.service.d/tieba.conf'),'[Service]\nReadWritePaths='+str(private)+'\n')
 for unit in ['deepseekfish-web.service','deepseekfish-qq.service']:
  install_text(Path('/etc/systemd/system')/(unit+'.d')/'tieba.conf','[Service]\nInaccessiblePaths=-'+str(private)+'\n')
 (backup/'files.json').write_text(json.dumps(records,indent=2))
 subprocess.run(['systemctl','daemon-reload'],check=True)
 for socket in ['deepseekfish-capture.socket','deepseekfish-tailnet.socket']:
  if prior_units.get(socket) or prior_units.get(socket.replace('.socket','.service')):subprocess.run(['systemctl','start',socket],check=True,timeout=20)
 for unit,active in prior_units.items():
  if active:subprocess.run(['systemctl','start',unit],check=True,timeout=40)
 subprocess.run(['systemctl','start','deepseekfish-qq.path'],check=True)
 token=(root/'runtime/data/webui-admin-token').read_text().strip()
 for attempt in range(40):
  try:
   for unit,active in prior_units.items():
    if active:subprocess.run(['systemctl','is-active','--quiet',unit],check=True)
   req=urllib.request.Request('http://127.0.0.1:17862/api/tieba',headers={'Authorization':'Bearer '+token})
   with urllib.request.urlopen(req,timeout=3) as response:status=json.load(response)
   if status.get('state')=='unconfigured' or status.get('lastError',{}) and status['lastError'].get('code')=='TIEBA_WORKER_UNAVAILABLE':raise RuntimeError('Account worker not available')
   break
  except Exception:
   if attempt==39:raise
   time.sleep(.25)
 if pids()!=baseline:raise RuntimeError('An unrelated service process changed')
 print(json.dumps({'deployed':True,'backup':str(backup),'files':len(files),'browser':actual,'profilePreserved':True,'healthChecked':True,'unrelatedPids':baseline}))
except BaseException:
 for dest,prior in reversed(records):
  destination=Path(dest)
  if prior is None:destination.unlink(missing_ok=True)
  else:shutil.copy2(backup/prior,destination)
 subprocess.run(['systemctl','daemon-reload'])
 for socket in ['deepseekfish-capture.socket','deepseekfish-tailnet.socket']:
  if prior_units.get(socket) or prior_units.get(socket.replace('.socket','.service')):subprocess.run(['systemctl','start',socket])
 for unit,active in prior_units.items():
  if active:subprocess.run(['systemctl','start',unit])
 subprocess.run(['systemctl','start','deepseekfish-qq.path'])
 print('Code rolled back; account profile and all app state preserved. Backup:',backup);raise
