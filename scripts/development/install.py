#!/usr/bin/env python3
"""Install the pinned development supervisor and the ordinary QQ handoff."""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time

app = Path('/srv/deepseekfish/app')
dev = Path('/srv/deepseekfish/development')
stage = Path(__file__).resolve().parent
group = 'deepseekfish-development'
service = 'deepseekfish-development.service'
watch = 'deepseekfish-development-deploy.path'
release = 'deepseekfish-development-deploy.service'
units = (service, watch, release)
web, qq, route = 'deepseekfish-web.service', 'deepseekfish-qq.service', 'deepseekfish-qq.path'
sources = ('src/agent/bot.ts','src/codex/platform.ts','src/codex/tasks.ts','src/qq/onebot.ts','src/types.ts',
           'src/development/intake.ts','src/development/jobs.ts','src/development/codex.ts',
           'src/development/workspace.ts','src/development/worker.ts')
names = sorted((*sources, 'docs/development.md', 'README.md',
                *('dist/'+name[:-3]+suffix for name in sources for suffix in ('.js','.js.map'))))


def ctl(*args, check=True):
    return subprocess.run(['/usr/bin/systemctl',*args], check=check, timeout=220,
                          capture_output=True, text=True)


def active(unit):
    return ctl('is-active',unit,check=False).returncode==0


def replace(file, value, mode=0o644):
    fd,temporary=tempfile.mkstemp(prefix='.fish-dev-',dir=file.parent)
    try:
        with os.fdopen(fd,'wb') as output:
            output.write(value)
            os.fchmod(output.fileno(),mode)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary,file)
    finally:
        Path(temporary).unlink(missing_ok=True)


def owner_account():
    data=app/'runtime/data'
    qq_settings=json.loads((data/'qq-settings.json').read_text())
    with sqlite3.connect((data/'fish.sqlite').as_uri()+'?mode=ro',uri=True) as db:
        row=db.execute("SELECT value FROM meta WHERE key='exploration:settings'").fetchone()
    owner=json.loads(row[0]).get('owner') if row else None
    private=qq_settings.get('privateUsers',[])
    if not owner and len(private)==1:
        owner=private[0]
    if not isinstance(owner,str) or not owner.isascii() or not owner.isdigit() or owner not in private:
        raise RuntimeError('Existing owner account could not be uniquely verified')
    if qq_settings.get('enabled') is not True or qq_settings.get('qqTransport')!='onebot':
        raise RuntimeError('Current OneBot private chat is disabled')
    return owner


def blocking_work():
    data=app/'runtime'
    for file,query in (
        ('data/fish.sqlite',"SELECT 1 FROM exploration_runs WHERE state='running' LIMIT 1"),
        ('data/webui.sqlite',"SELECT 1 FROM web_turns WHERE state='running' LIMIT 1"),
        ('tieba-account/actions.sqlite',"SELECT 1 FROM tieba_operations WHERE state IN ('queued','running','cleaning') AND action IN ('publish','publication-submit','input','moderator') LIMIT 1")):
        if not (data/file).exists():
            continue
        with sqlite3.connect((data/file).as_uri()+'?mode=ro',uri=True,timeout=3) as db:
            if db.execute(query).fetchone():
                return file
    for unit in ('deepseekfish-daily-news.service','deepseekfish-daily-qzone.service'):
        if active(unit):
            return unit
    return None


def main():
    if os.geteuid()!=0 or (dev/'deploy.py').exists():
        raise RuntimeError('This bootstrap requires root and a fresh supervisor installation')
    owner=owner_account()
    for _ in range(30):
        busy=blocking_work()
        if busy is None:
            break
        time.sleep(2)
    else:
        raise RuntimeError('Production still doing work in '+busy)
    baseline=json.loads((stage/'baseline.json').read_text())
    if sorted(baseline)!=names:
        raise RuntimeError('Unexpected application file list')
    for name in names:
        live=app/name
        digest=hashlib.sha256(live.read_bytes()).hexdigest() if live.is_file() else None
        if live.resolve()!=live or digest!=baseline[name]:
            raise RuntimeError('Installation changed while compiling '+name)
    backups=Path(tempfile.mkdtemp(prefix='development-bootstrap-',dir='/srv/deepseekfish/backups'))
    for name in names:
        if baseline[name] is not None:
            file=backups/name
            file.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(app/name,file)
    try:
        account=grp.getgrnam(group)
    except KeyError:
        subprocess.run(['/usr/sbin/groupadd','--system',group],check=True)
        account=grp.getgrnam(group)
    if account.gr_mem or account.gr_gid==pwd.getpwnam('deepseekfish').pw_gid:
        raise RuntimeError('Unexpected development group membership')
    uid=pwd.getpwnam('deepseekfish').pw_uid
    gid=account.gr_gid
    for folder in (dev,dev/'runtime',dev/'runtime/results'):
        folder.mkdir(parents=True,exist_ok=True)
        os.chown(folder,0,gid)
        folder.chmod(0o2750)
    for sub in ('data','deploy','packages','workspace','tmp','cache'):
        folder=dev/'runtime'/sub
        folder.mkdir(exist_ok=True)
        os.chown(folder,uid,gid)
        folder.chmod(0o2700)
    tooling=dev/'runtime/tools'
    tooling.mkdir(exist_ok=True)
    shutil.copytree(app/'runtime/tools/tokenizer',tooling/'tokenizer')
    shutil.copytree(stage/'dist/src',dev/'dist/src')
    for name in ('package.json','trial.mjs','deploy.py','private-process.node'):
        shutil.copyfile(stage/name,dev/name)
    os.symlink(app/'node_modules',dev/'node_modules',target_is_directory=True)
    (dev/'owner').write_text(owner+'\n')
    (dev/'owner').chmod(0o640)
    os.chown(dev/'owner',0,gid)
    qq_path=active(route)
    owner_marker=app/'config/development-owner'
    if owner_marker.exists():
        raise RuntimeError('Unexpected existing owner marker')
    installed=[]
    changed=[]
    stopped=False
    try:
        for unit in units:
            target=Path('/etc/systemd/system')/unit
            if target.exists():
                raise RuntimeError('Unexpected installed unit '+unit)
            replace(target,(stage/'deploy'/unit).read_bytes())
            installed.append(target)
        subprocess.run(['/usr/bin/systemd-analyze','verify',*[str(x) for x in installed]],check=True,
                       stdout=subprocess.DEVNULL,timeout=30)
        ctl('daemon-reload')
        stopped=True
        if qq_path:
            ctl('stop',route)
        ctl('stop',web,qq)
        for name in names:
            target=app/name
            target.parent.mkdir(parents=True,exist_ok=True)
            replace(target,(stage/name).read_bytes())
            changed.append(name)
        replace(owner_marker,(owner+'\n').encode(),0o640)
        os.chown(owner_marker,0,pwd.getpwnam('deepseekfish').pw_gid)
        ctl('start',web,qq)
        if qq_path:
            ctl('start',route)
        ctl('enable','--now',service,watch)
        time.sleep(2)
        if not all(active(unit) for unit in (service,watch,web,qq)) or not (dev/'runtime/data/development.sqlite').is_file():
            raise RuntimeError('Installed services did not start')
        print(json.dumps({'deployed':True,'applicationFiles':len(changed),'worker':True,'releaseWatcher':True,'backup':str(backups)}))
    except BaseException:
        ctl('disable','--now',service,watch,check=False)
        if stopped:
            if qq_path:
                ctl('stop',route,check=False)
            ctl('stop',web,qq,check=False)
            for name in reversed(changed):
                if baseline[name] is None:
                    (app/name).unlink(missing_ok=True)
                else:
                    original=backups/name
                    replace(app/name,original.read_bytes(),stat.S_IMODE(original.stat().st_mode))
            owner_marker.unlink(missing_ok=True)
            ctl('start',web,qq)
            if qq_path:
                ctl('start',route)
        for file in installed:
            file.unlink(missing_ok=True)
        ctl('daemon-reload')
        if dev.exists():
            dev.rename(backups/'failed-supervisor')
        raise


if __name__=='__main__':
    main()
