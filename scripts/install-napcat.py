#!/usr/bin/env python3
"""Pinned community Shell launcher, private QQ state, no Docker/firewall changes."""
import json
import os
from pathlib import Path, PurePosixPath
import platform
import pwd
import secrets
import shutil
import subprocess
import urllib.request
import zipfile

if os.geteuid() != 0:
    raise SystemExit('Run with sudo to install the dedicated NapCat account/service.')
source = Path(__file__).resolve().parent.parent
versions = json.loads((source / 'deploy/napcat-versions.json').read_text())
machine = platform.machine()
if machine not in versions['qqUrls']:
    raise SystemExit('Supported architectures: aarch64 and x86_64.')
packages = ['xvfb', 'xauth', 'g++', 'libgssapi-krb5-2', 'libgtk-3-0t64', 'libasound2t64', 'libnss3', 'libgbm1']
missing = [p for p in packages if subprocess.run(['dpkg-query', '-W', '-f=${db:Status-Status}', p], capture_output=True, text=True).stdout.strip() != 'installed']
if missing:
    subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends', *missing], check=True,
                   env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive', 'NEEDRESTART_MODE': 'l'})
base = Path('/srv/deepseekfish/napcat'); state = base / 'state'; vendor = base / 'vendor'
base.mkdir(parents=True, exist_ok=True); base.chmod(0o755)
try:
    account = pwd.getpwnam('napcat')
    if account.pw_dir != str(state) or account.pw_shell != '/usr/sbin/nologin':
        raise SystemExit('Existing napcat account does not match this deployment; inspect it first.')
except KeyError:
    subprocess.run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(state), '--shell', '/usr/sbin/nologin', 'napcat'], check=True)
    account = pwd.getpwnam('napcat')
for d in [state, state/'config-home', state/'cache', state/'config', state/'logs']:
    d.mkdir(parents=True, exist_ok=True); os.chown(d, account.pw_uid, account.pw_gid); d.chmod(0o700)
vendor.mkdir(exist_ok=True); vendor.chmod(0o755)
cache = source / 'runtime/napcat-downloads'; cache.mkdir(parents=True, exist_ok=True)
def download(name, url):
    target = cache / name
    if not target.is_file():
        partial = target.with_name(target.name + '.partial')
        with urllib.request.urlopen(url, timeout=90) as response, partial.open('wb') as out:
            shutil.copyfileobj(response, out)
        partial.replace(target)
    return target
qq_url = versions['qqUrls'][machine]
deb = download(qq_url.rsplit('/', 1)[-1], qq_url)
if not (vendor / 'qq/opt/QQ/qq').is_file():
    (vendor / 'qq').mkdir(exist_ok=True)
    subprocess.run(['dpkg-deb', '--extract', str(deb), str(vendor / 'qq')], check=True)
zip_path = download('NapCat.Shell-' + versions['napcatVersion'] + '.zip', versions['napcatUrl'])
napcat = vendor / 'napcat'
if not (napcat / 'napcat.mjs').is_file():
    napcat.mkdir(exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        for m in z.infolist():
            if m.filename.startswith('/') or '..' in PurePosixPath(m.filename).parts or ((m.external_attr >> 16) & 0o170000) == 0o120000:
                raise SystemExit('Unsupported archive path: ' + m.filename)
        z.extractall(napcat)
for directory in ['config', 'logs', 'cache']:
    entry = napcat / directory
    if not entry.is_symlink():
        if entry.exists():
            shutil.copytree(entry, state / directory, dirs_exist_ok=True); shutil.rmtree(entry)
        entry.symlink_to(state / directory, target_is_directory=True)
    for file in (state / directory).rglob('*'):
        os.chown(file, account.pw_uid, account.pw_gid); file.chmod(0o700 if file.is_dir() else 0o600)
cpp = download('launcher-' + versions['launcherCommit'] + '.cpp', versions['launcherUrl'])
if not (vendor / 'libnapcat_launcher.so').is_file():
    subprocess.run(['g++', '-shared', '-fPIC', str(cpp), '-o', str(vendor/'libnapcat_launcher.so'), '-ldl'], check=True)
    (vendor/'libnapcat_launcher.so').chmod(0o755)
app = Path('/srv/deepseekfish/app'); service = pwd.getpwnam('deepseekfish')
onebot_file = app / 'runtime/data/onebot-credentials.json'
onebot_token = json.loads(onebot_file.read_text())['accessToken'] if onebot_file.is_file() else secrets.token_hex(32)
if not onebot_file.exists():
    onebot_file.write_text(json.dumps({'accessToken': onebot_token}) + '\n');onebot_file.chmod(0o600);os.chown(onebot_file, service.pw_uid, service.pw_gid)
def private_json(name, content):
    p = state/'config'/name
    if not p.exists():
        p.write_text(json.dumps(content, indent=2) + '\n');p.chmod(0o600);os.chown(p, account.pw_uid, account.pw_gid)
private_json('webui.json', {'host': '127.0.0.1', 'port': 6099, 'token': secrets.token_hex(32), 'loginRate': 10})
private_json('onebot11.json', {'network': {'websocketServers': [{'name': 'deepseekfish-local', 'enable': True, 'host': '127.0.0.1', 'port': 3001, 'messagePostFormat': 'array', 'reportSelfMessage': False, 'token': onebot_token, 'enableForcePushEvent': True, 'heartInterval': 30000}]}})
webui_token = json.loads((state/'config/webui.json').read_text())['token']
p = state/'webui-token';p.write_text(webui_token + '\n');p.chmod(0o600);os.chown(p, account.pw_uid, account.pw_gid)
shutil.copyfile(source/'deploy/napcat-versions.json', vendor/'versions.json')
shutil.copyfile(source/'deploy/deepseekfish-napcat.service', '/etc/systemd/system/deepseekfish-napcat.service')
Path('/etc/systemd/system/deepseekfish-napcat.service').chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'enable', '--now', 'deepseekfish-napcat.service'], check=True)
print('NapCat prepared under its own UID. WebUI: loopback 6099; OneBot: loopback 3001 after QQ login.')
print('No QQ account has been logged in automatically; no QQ messages sent.')
