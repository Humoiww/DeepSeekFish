#!/usr/bin/env python3
"""Privileged file switch only. Candidate code runs under the ordinary service account."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
import urllib.request

APP = Path('/srv/deepseekfish/app')
DEV = Path('/srv/deepseekfish/development')
STATE = DEV / 'runtime'
ROOTS = ('src', 'assets', 'docs', 'tests', 'third_party', 'prompts', 'personas')
JOURNAL = STATE / 'switch.json'
SERVICES = ('deepseekfish-web.service', 'deepseekfish-qq.service')
QQ_PATH = 'deepseekfish-qq.path'
TICKET = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}')
DIGEST = re.compile(r'[0-9a-f]{64}')
LIMIT = 40 * 1024 * 1024


def system(*args, check=True):
    return subprocess.run(['/usr/bin/systemctl', *args], check=check, capture_output=True,
                          text=True, timeout=210)


def active(unit):
    return system('is-active', unit, check=False).returncode == 0


def pids():
    return [int(system('show', '--property=MainPID', '--value', unit).stdout.strip() or '0')
            for unit in SERVICES]


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic(target, data, mode=0o640):
    fd, temp = tempfile.mkstemp(prefix='.fish-dev-', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        os.replace(temp, target)
        sync_directory(target.parent)
    finally:
        Path(temp).unlink(missing_ok=True)


def sync_directory(folder):
    fd = os.open(folder, os.O_DIRECTORY | os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def json_write(target, data):
    atomic(target, json.dumps(data, ensure_ascii=False).encode())


def allowed(name):
    if not isinstance(name, str) or len(name) > 250:
        return False
    parts = name.split('/')
    if any(not p or p.startswith('.') or not all(c.isalnum() or c in '_. @+-' for c in p) for p in parts):
        return False
    if parts[0] == 'dist':
        return (len(parts) >= 3 and parts[1] == 'src' and parts[2] != 'development'
                and name.endswith(('.js', '.js.map')))
    if parts[0] not in ROOTS or len(parts) < 2:
        return False
    return not (parts[0] == 'src' and parts[1] == 'development')


def read_file(root, name, missing=False):
    """Open each component relative to an already-open directory, rejecting links."""
    fd = os.open(root, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        parts = name.split('/')
        for component in parts[:-1]:
            child = os.open(component, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        child = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(child, 'rb') as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > LIMIT:
                raise ValueError('INVALID_FILE')
            return source.read(LIMIT + 1)
    except FileNotFoundError:
        if missing:
            return None
        raise
    finally:
        os.close(fd)


def revision():
    lines = []
    for folder in ROOTS:
        base = APP / folder
        if not base.exists():
            continue
        for file in base.rglob('*'):
            if file.is_symlink():
                raise ValueError('INSTALLATION_LINK')
            if file.is_file():
                name = file.relative_to(APP).as_posix()
                lines.append((name, sha(read_file(APP, name))))
    lines.sort(key=lambda item: item[0].encode('utf-16-be'))
    return sha(''.join(name + '\t' + digest + '\n' for name, digest in lines).encode())


def authorized(intent):
    with sqlite3.connect((STATE/'data/development.sqlite').as_uri()+'?mode=ro', uri=True, timeout=5) as db:
        row = db.execute('SELECT phase,body FROM development WHERE id=?',
                         (intent['task'],)).fetchone()
    if row is None or row[0] != 'deploy':
        return False
    job = json.loads(row[1])
    return (job['owner'] == (DEV/'owner').read_text().strip() and
            job['grant'] == intent['grant'] and job['version'] == intent['version'] and
            job.get('ticket') == intent['ticket'] and job.get('candidate') == intent['candidate'])


def healthy(previous=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for _ in range(45):
        try:
            current = pids()
            if not all(current) or (previous is not None and any(a == b for a, b in zip(current, previous))):
                time.sleep(1)
                continue
            with opener.open('http://127.0.0.1:17862/', timeout=3) as response:
                if response.status == 200 and all(active(s) for s in SERVICES):
                    return current
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        time.sleep(1)
    raise RuntimeError('SERVICE_HEALTH_FAILED')


def stop_units(path_was_active):
    if path_was_active:
        system('stop', QQ_PATH)
    system('stop', *SERVICES)


def start_units(path_was_active, reset_failures=False):
    if reset_failures:
        # The rejected candidate may have exhausted systemd's startup retries.
        units = (*SERVICES, QQ_PATH) if path_was_active else SERVICES
        system('reset-failed', *units)
    system('start', *SERVICES)
    if path_was_active:
        system('start', QQ_PATH)


def release_directory(folder):
    if folder == APP:
        return
    try:
        info = folder.lstat()
    except FileNotFoundError:
        release_directory(folder.parent)
        # Keep the private-data umask for every operation except mkdir.
        # Creating the directory with its final mode also survives interruption.
        previous_umask = os.umask(0o022)
        try:
            folder.mkdir(mode=0o755)
        finally:
            os.umask(previous_umask)
        sync_directory(folder.parent)
        return
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('INVALID_RELEASE_DIRECTORY')


def write_app(name, content, mode=0o644):
    dest = APP / name
    if content is None:
        dest.unlink(missing_ok=True)
        if dest.parent.exists():
            sync_directory(dest.parent)
    else:
        release_directory(dest.parent)
        atomic(dest, content, mode)


def finish(info, status, **details):
    ticket = info['ticket']
    json_write(STATE/'results'/f'{ticket}.json',
               {'ticket': ticket, 'state': status, 'before': info.get('base'), **details})
    # Result is durable before acknowledging the release job.
    (STATE/'deploy'/f'{ticket}.json').unlink(missing_ok=True)
    if JOURNAL.exists():
        saved = json.loads(JOURNAL.read_text())
        if saved['ticket'] == ticket:
            JOURNAL.unlink()
            sync_directory(STATE)


def recover():
    if not JOURNAL.exists():
        return
    info = json.loads(JOURNAL.read_text())
    if (STATE/'results'/f"{info['ticket']}.json").exists():
        (STATE/'deploy'/f"{info['ticket']}.json").unlink(missing_ok=True)
        JOURNAL.unlink()
        return
    if info.get('phase') == 'starting' and revision() == info['candidate'] and authorized(info):
        try:
            current = healthy(info['old_pids'])
            finish(info, 'switched', revision=info['candidate'], pids=current, restartedAt=int(time.time()*1000))
            return
        except (RuntimeError, OSError, subprocess.SubprocessError):
            pass
    rollback(info, info.get('rollback_reason', 'SWITCH_INTERRUPTED'))


def rollback(info, reason):
    json_write(JOURNAL, {**info, 'phase':'rolling_back', 'rollback_reason':reason})
    stop_units(info['qq_path'])
    backup = Path(info['backup'])
    for change in info['changes']:
        name = change['name']
        write_app(name, (backup/name).read_bytes() if change['old'] else None, change.get('mode', 0o644))
    actual = revision()
    if actual != info['base']:
        raise RuntimeError('ROLLBACK_REVISION_MISMATCH')
    start_units(info['qq_path'], reset_failures=True)
    current = healthy()
    finish(info, 'rolled_back', reason=reason, revision=actual, pids=current)


def apply(request):
    ticket = request.stem
    if not TICKET.fullmatch(ticket):
        request.unlink(missing_ok=True)
        return
    intent = {'ticket':ticket}
    if (STATE/'results'/f'{ticket}.json').exists():
        request.unlink(missing_ok=True)
        return
    try:
        data = json.loads(read_file(STATE/'deploy',request.name))
        if (data.get('ticket') != ticket or not TICKET.fullmatch(data.get('task','')) or
            not all(DIGEST.fullmatch(data.get(key,'')) for key in ('base','candidate','grant')) or
            type(data.get('version')) is not int or not isinstance(data.get('changes'),list) or
            not 1 <= len(data['changes']) <= 900):
            raise ValueError('INVALID_MANIFEST')
        intent = data
        if not authorized(intent):
            finish(intent,'revoked')
            return
        if revision() != intent['base']:
            finish(intent,'stale')
            return
        bundle = STATE/'packages'/ticket
        backup = Path(tempfile.mkdtemp(prefix='fish-development-',dir='/srv/deepseekfish/backups'))
        seen = set()
        incoming = {}
        total = 0
        for change in intent['changes']:
            name, old, next_value = change['name'], change['old'], change['next']
            if not allowed(name) or name in seen or old == next_value or any(
                entry is not None and (not isinstance(entry,str) or not DIGEST.fullmatch(entry))
                for entry in (old,next_value)):
                raise ValueError('INVALID_RELEASE_PATH')
            seen.add(name)
            current = read_file(APP,name,missing=True)
            if (sha(current) if current is not None else None) != old:
                finish(intent,'stale')
                return
            if current is not None:
                target = backup/name
                target.parent.mkdir(parents=True,exist_ok=True)
                atomic(target,current,0o600)
                change['mode'] = stat.S_IMODE((APP/name).stat().st_mode)
            replacement = read_file(bundle,name) if next_value else None
            if replacement is not None:
                total += len(replacement)
                if total > 64 * 1024 * 1024 or sha(replacement) != next_value:
                    raise ValueError('INVALID_RELEASE_CONTENT')
            if old or next_value:
                incoming[name] = replacement
        if not authorized(intent):
            finish(intent,'revoked')
            return
        info = {**intent,'phase':'stopping','backup':str(backup),'old_pids':pids(),'qq_path':active(QQ_PATH)}
        json_write(JOURNAL,info)
    except (KeyError,ValueError,TypeError,OSError,sqlite3.Error) as error:
        finish(intent,'failed',reason=type(error).__name__)
        return
    try:
        stop_units(info['qq_path'])
        if not authorized(info):
            raise RuntimeError('GRANT_REVOKED')
        if revision() != info['base']:
            # No files have changed, so there is no backup to restore.
            start_units(info['qq_path'])
            finish(info,'stale')
            return
        for name,replacement in incoming.items():
            previous = next(change for change in info['changes'] if change['name']==name)
            write_app(name,replacement,previous.get('mode',0o644))
        if revision() != info['candidate']:
            raise RuntimeError('CANDIDATE_REVISION_MISMATCH')
        json_write(JOURNAL,{**info,'phase':'starting'})
        start_units(info['qq_path'])
        current = healthy(info['old_pids'])
        if not authorized(info):
            raise RuntimeError('GRANT_REVOKED')
        finish(info,'switched',revision=info['candidate'],pids=current,restartedAt=int(time.time()*1000))
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
        reason=str(error) if isinstance(error,RuntimeError) else type(error).__name__
        rollback(info,reason)


if __name__ == '__main__':
    os.umask(0o027)
    with (STATE/'release.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        recover()
        for request in sorted((STATE/'deploy').glob('*.json')):
            apply(request)
