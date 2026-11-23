#!/usr/bin/env python3
"""Install the project's independent daily backup worker; preserve all logins."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--repository', required=True, help='Authorized private GitHub owner/repository')
p.add_argument('--deploy-key', type=Path, required=True, help='Existing repository-scoped SSH private key; never uploaded')
p.add_argument('--root', type=Path, default=Path('/srv/deepseekfish/app'))
args = p.parse_args()
if os.geteuid() != 0:
    raise SystemExit('Run with sudo to install this project timer.')
root = args.root.resolve()
source = Path(__file__).resolve().parent.parent
if root != Path('/srv/deepseekfish/app') or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository):
    raise SystemExit('Invalid project root or repository.')
work = root / 'runtime/backup'
for file in (root, root / 'runtime', work, args.deploy_key.absolute()):
    for part in (file, *file.parents):
        if part.is_symlink():
            raise SystemExit('Linked installer paths are unsupported.')
files = ['scripts/backup-state.py', 'scripts/install-memory-backup.py', 'docs/memory-backup.md', 'deploy/deepseekfish-memory-backup.service', 'deploy/deepseekfish-memory-backup.timer', 'src/exploration/worker.ts', 'dist/src/exploration/worker.js', 'dist/src/exploration/worker.js.map']
for name in files:
    if not (source / name).is_file():
        raise SystemExit('Build/copy missing: ' + name)

# The only app code update protects already-configured remote log retention.
# Do not interrupt an actual model turn or image task to install it.
db = sqlite3.connect('file:' + str(root / 'runtime/data/fish.sqlite') + '?mode=ro', uri=True)
try:
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table, states in [('reservations', "'held'"), ('exploration_runs', "'running'"), ('tasks', "'running'")]:
        if table in tables and db.execute(f'SELECT 1 FROM {table} WHERE state IN ({states}) LIMIT 1').fetchone():
            raise SystemExit('Active ' + table + '; install after it finishes.')
finally:
    db.close()

work.mkdir(mode=0o700, exist_ok=True)
os.chown(work, 0, 0)
work.chmod(0o700)
key = work / 'github_ed25519'
if key.exists():
    same = subprocess.check_output(['ssh-keygen', '-y', '-f', str(key)]) == subprocess.check_output(['ssh-keygen', '-y', '-f', str(args.deploy_key)])
    if not same:
        raise SystemExit('An existing backup key differs; no credentials overwritten.')
else:
    shutil.copyfile(args.deploy_key, key)
key.chmod(0o600)
os.chown(key, 0, 0)
known = work / 'known_hosts'
# GitHub's published Ed25519 host key. No global SSH configuration is changed.
known.write_text('github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n')
known.chmod(0o600)
wrapper = work / 'github-ssh.py'
wrapper.write_text('#!/usr/bin/python3\nimport os,sys\nos.execv("/usr/bin/ssh", ["ssh", "-F", "/dev/null", "-i", ' + repr(str(key)) + ', "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=' + str(known) + '", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", *sys.argv[1:]])\n')
wrapper.chmod(0o700)
config_path = work / 'config.json'
if config_path.exists() and json.loads(config_path.read_text()).get('repository') != args.repository:
    raise SystemExit('Existing backup remote differs; configuration preserved.')
config_path.write_text(json.dumps({'version': 1, 'repository': args.repository, 'timezone': 'Asia/Hong_Kong', 'schedule': '03:00 daily'}) + '\n')
config_path.chmod(0o600)

env = os.environ.copy()
env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0', GIT_SSH=str(wrapper))
remote = 'git@github.com:' + args.repository + '.git'
repo = work / 'repository'
if not (repo / '.git').is_dir():
    try:
        subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', 'clone', '--branch', 'main', '--no-tags', remote, str(repo)], env=env, check=True, timeout=180)
    except (subprocess.SubprocessError, OSError):
        raise SystemExit('Could not clone the authorized backup repository; check its Deploy Key write access and initialized main branch.')
else:
    actual = subprocess.check_output(['git', '-C', str(repo), 'remote', 'get-url', 'origin'], env=env, text=True).strip()
    if actual != remote:
        raise SystemExit('Existing Git remote differs; no changes made.')

for name in files:
    destination = root / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if (source / name).resolve() != destination.resolve():
        tmp = destination.with_name(destination.name + '.backup-install')
        shutil.copyfile(source / name, tmp)
        tmp.chmod(0o644)
        os.replace(tmp, destination)
receipts = root / 'runtime/data/backup-log-receipts.json'
if not receipts.exists():
    receipts.write_text('{"enabled":true,"files":{}}\n')
receipts.chmod(0o644)
os.chown(receipts, 0, 0)
for name in ('deepseekfish-memory-backup.service', 'deepseekfish-memory-backup.timer'):
    destination = Path('/etc/systemd/system') / name
    shutil.copyfile(root / 'deploy' / name, destination)
    destination.chmod(0o644)
subprocess.run(['systemctl', 'daemon-reload'], check=True)
subprocess.run(['systemctl', 'try-restart', 'deepseekfish-qq.service'], check=True, timeout=45)
subprocess.run(['systemctl', 'enable', '--now', 'deepseekfish-memory-backup.timer'], check=True, timeout=30)
print(json.dumps({'installed': True, 'repository': args.repository, 'privateKeyUploaded': False, 'schedule': '03:00 Asia/Hong_Kong', 'timer': 'deepseekfish-memory-backup.timer', 'applicationStatePreserved': True}))
