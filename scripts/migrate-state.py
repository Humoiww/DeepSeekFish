#!/usr/bin/env python3
"""Export/import private portable app state, deliberately excluding credentials."""
import argparse
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile

p = argparse.ArgumentParser()
p.add_argument('action', choices=['export', 'import'])
p.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
p.add_argument('--archive', type=Path)
p.add_argument('--replace', action='store_true', help='Replace existing non-secret state; services must be stopped')
args = p.parse_args()
os.umask(0o077)
root = args.root.resolve()
data_names = {'fish.sqlite', 'webui.sqlite', 'mock.sqlite', 'demo.sqlite', 'webui-mock.sqlite', 'webui-mock-budget.sqlite'}
nonsecret_data = {'qq-settings.json', 'qq-enabled'}
trees = ['runtime/outputs', 'runtime/workspace', 'runtime/logs', 'runtime/character', 'runtime/memory']
def allowed(name):
    parts = PurePosixPath(name).parts
    if name.startswith('/') or '\\' in name or any(x in ['..', '.'] for x in parts):
        return False
    return name == 'migration-manifest.json' or name == 'config/local.json' or name in {'runtime/data/' + s for s in data_names | nonsecret_data} or any(name.startswith(t + '/') for t in trees)
def no_links(path):
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise SystemExit('Linked paths cannot be migrated: ' + str(parent))
no_links(root)
uid, gid = os.getuid(), os.getgid()
if os.geteuid() == 0 and root == Path('/srv/deepseekfish/app'):
    u = pwd.getpwnam('deepseekfish'); uid, gid = u.pw_uid, u.pw_gid
tmp = root / 'runtime/tmp'
tmp.mkdir(parents=True, exist_ok=True)
if args.action == 'export':
    destination = args.archive or root / 'runtime/deployment' / ('state-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.tar.gz')
    destination = destination.absolute(); no_links(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise SystemExit('Refusing to overwrite existing archive.')
    with tempfile.TemporaryDirectory(prefix='migration-', dir=tmp) as temp:
        stage = Path(temp)
        for name in sorted(data_names):
            source = root / 'runtime/data' / name
            if not source.exists():
                continue
            no_links(source)
            target = stage / 'runtime/data' / name; target.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect('file:' + str(source) + '?mode=ro', uri=True) as src, sqlite3.connect(target) as dst:
                src.backup(dst)
        files = [f for f in stage.rglob('*') if f.is_file()]
        for name in nonsecret_data:
            source = root / 'runtime/data' / name
            if source.is_file():
                no_links(source);files.append(source)
        config = root / 'config/local.json'
        if config.is_file():
            no_links(config)
            content = json.loads(config.read_text())
            if any(any(s in k.lower() for s in ['secret', 'token', 'password', 'apikey', 'api_key', 'credential']) for k in content):
                raise SystemExit('Secret-like field in config/local.json; move it into private credential storage first.')
            target = stage / 'config/local.json'; target.parent.mkdir(parents=True, exist_ok=True);target.write_text(json.dumps(content, ensure_ascii=False, indent=2) + '\n');files.append(target)
        for tree in trees:
            directory = root / tree
            if not directory.exists():
                continue
            no_links(directory)
            for f in directory.rglob('*'):
                no_links(f)
                if f.is_file():
                    if f.stat().st_nlink != 1:
                        raise SystemExit('Hardlinked file cannot be migrated: ' + str(f))
                    files.append(f)
        partial = destination.with_name(destination.name + '.partial')
        try:
            with tarfile.open(partial, 'w:gz') as archive:
                for f in sorted(files):
                    relative = f.relative_to(stage) if f.is_relative_to(stage) else f.relative_to(root)
                    archive.add(f, arcname=str(relative), recursive=False)
                manifest = json.dumps({'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat(), 'files': len(files), 'credentialsIncluded': False,
                                       'excluded': ['.env', 'runtime/codex-home', 'runtime/data/*token*', 'runtime/data/*secrets*', 'runtime/data/*credentials*', 'runtime/napcat', 'node_modules', 'dist', 'runtime/tools', 'runtime/cache', 'runtime/tmp']}, indent=2).encode()
                member = tarfile.TarInfo('migration-manifest.json'); member.size = len(manifest); member.mode = 0o600;archive.addfile(member, io.BytesIO(manifest))
            partial.chmod(0o600); os.replace(partial, destination)
        finally:
            partial.unlink(missing_ok=True)
    print('Private portable state archive:', destination)
    print('Includes databases, settings, daily/person memory, chat state, generated images, workspaces and logs. Credentials and installed dependencies excluded.')
else:
    if not args.archive:
        p.error('--archive is required for import')
    if root == Path('/srv/deepseekfish/app'):
        for service in ['deepseekfish-web.service', 'deepseekfish-qq.service', 'deepseekfish-qq.path']:
            if subprocess.run(['systemctl', 'is-active', '--quiet', service]).returncode == 0:
                raise SystemExit('Stop DeepSeekFish WebUI, QQ service and QQ path watcher before restoring state.')
    no_links(args.archive.absolute())
    with tarfile.open(args.archive, 'r:gz') as archive, tempfile.TemporaryDirectory(prefix='migration-', dir=tmp) as temp:
        members = archive.getmembers(); names = set()
        for m in members:
            if not m.isfile() or not allowed(m.name) or m.name in names:
                raise SystemExit('Unsupported archive member: ' + m.name)
            names.add(m.name); target = root / m.name; no_links(target)
            if m.name != 'migration-manifest.json' and target.exists() and not args.replace:
                raise SystemExit('Existing state; stop services and pass --replace explicitly: ' + m.name)
        if 'migration-manifest.json' not in names:
            raise SystemExit('Not a DeepSeekFish migration archive')
        manifest = json.load(archive.extractfile('migration-manifest.json'))
        if manifest.get('version') != 1 or manifest.get('credentialsIncluded') is not False:
            raise SystemExit('Unsupported migration manifest')
        archive.extractall(temp, filter='data')
        for m in members:
            if m.name == 'migration-manifest.json':
                continue
            target = root / m.name; target.parent.mkdir(parents=True, exist_ok=True)
            if m.name.startswith('runtime/data/'):
                for suffix in ['-wal', '-shm']:
                    (target.parent / (target.name + suffix)).unlink(missing_ok=True)
            shutil.copyfile(Path(temp) / m.name, target)
            target.chmod(0o644 if m.name == 'config/local.json' else 0o600)
            if m.name != 'config/local.json':
                os.chown(target, uid, gid)
                for d in target.parents:
                    if d == root / 'runtime':
                        break
                    os.chown(d, uid, gid); d.chmod(0o700)
    print('State restored. Credentials unchanged; re-enter keys and log in separately on a new server.')
