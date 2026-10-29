#!/usr/bin/env python3
"""Install a dedicated screenshot worker; keep Chromium's native sandbox on."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import platform
import pwd
import shutil
import subprocess
import urllib.request
import zipfile

p = argparse.ArgumentParser();p.add_argument('--stage-only', action='store_true');args = p.parse_args()
if os.geteuid() != 0:
    raise SystemExit('Run with sudo to create the separate screenshot account.')
source = Path(__file__).resolve().parent.parent
packages = ['fonts-noto-cjk', 'libnss3', 'libgbm1', 'libasound2t64', 'libatk-bridge2.0-0t64', 'libcups2t64', 'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2', 'libxkbcommon0', 'libdrm2']
missing = [p for p in packages if subprocess.run(['dpkg-query', '-W', '-f=${db:Status-Status}', p], capture_output=True, text=True).stdout.strip() != 'installed']
if missing:
    subprocess.run(['apt-get', 'install', '-y', '--no-install-recommends', *missing], check=True, env={**os.environ, 'DEBIAN_FRONTEND':'noninteractive', 'NEEDRESTART_MODE':'l'})
base = Path('/srv/deepseekfish/capture');state = base/'state'
machine = {'aarch64':'linux-arm64', 'x86_64':'linux64'}.get(platform.machine())
if not machine:
    raise SystemExit('Screenshot worker supports Linux ARM64 and x64.')
version = '156.0.8078.47'
url = f'https://storage.googleapis.com/chrome-for-testing-public/{version}/{machine}/chrome-headless-shell-{machine}.zip'
cache = source/'runtime/capture-downloads';cache.mkdir(parents=True, exist_ok=True)
archive = cache/f'chrome-headless-shell-{version}-{"arm64" if machine == "linux-arm64" else "x64"}.zip'
if not archive.is_file():
    with urllib.request.urlopen(url, timeout=90) as response, archive.with_suffix('.partial').open('wb') as out:
        shutil.copyfileobj(response, out)
    archive.with_suffix('.partial').replace(archive)
try:
    user = pwd.getpwnam('fishview')
    if user.pw_dir != str(state) or user.pw_shell != '/usr/sbin/nologin':
        raise SystemExit('Existing fishview account differs; inspect before reuse.')
except KeyError:
    subprocess.run(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', str(state), '--shell', '/usr/sbin/nologin', 'fishview'], check=True)
    user = pwd.getpwnam('fishview')
base.mkdir(parents=True, exist_ok=True);base.chmod(0o755)
state.mkdir(exist_ok=True);state.chmod(0o700);os.chown(state, user.pw_uid, user.pw_gid)
destination = base/'browser'
if not (destination/'chrome-headless-shell').is_file():
    destination.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            parts = PurePosixPath(member.filename).parts
            if '..' in parts or member.filename.startswith('/') or ((member.external_attr >> 16) & 0o170000) == 0o120000:
                raise SystemExit('Unsupported browser archive member')
            if len(parts) < 2 or member.is_dir():
                continue
            target = destination.joinpath(*parts[1:]);target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(member) as inp, target.open('wb') as out:shutil.copyfileobj(inp, out)
            target.chmod(0o755 if (member.external_attr >> 16) & 0o111 else 0o644)
    (destination/'chrome-headless-shell').chmod(0o755)
    (destination/'source.json').write_text(json.dumps({'version':version, 'url':url}, indent=2))
for name in ['deepseekfish-capture.service', 'deepseekfish-capture.socket']:
    shutil.copyfile(source/'deploy'/name, Path('/etc/systemd/system')/name);(Path('/etc/systemd/system')/name).chmod(0o644)
shutil.copyfile(source/'deploy/deepseekfish-capture.apparmor', '/etc/apparmor.d/deepseekfish-capture')
subprocess.run(['apparmor_parser', '-r', '/etc/apparmor.d/deepseekfish-capture'], check=True)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
if not args.stage_only:
    subprocess.run(['systemctl', 'enable', '--now', 'deepseekfish-capture.socket'], check=True)
print('Screenshot worker installed; separate UID, private Unix socket, native Chromium sandbox enabled.')
