#!/usr/bin/env python3
"""Readable daily GitHub backups, original filenames, no encryption or custom hashes."""
import argparse
import collections
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('Asia/Hong_Kong')
VERSION = 2
LARGE_FILE = 90 * 1024 * 1024
PART_SIZE = 48 * 1024 * 1024
DATA_FILES = ('persona.json', 'qq-settings.json', 'qq-enabled', 'daily-news.json', 'daily-qzone.json', 'tieba-sections.json')
DATABASES = ('runtime/data/knowledge.sqlite', 'runtime/data/fish.sqlite', 'runtime/data/webui.sqlite', 'runtime/tieba-account/actions.sqlite')
TREES = ('personas', 'assets', 'src', 'scripts', 'deploy', 'runtime/memory', 'runtime/logs', 'runtime/outputs', 'runtime/workspace', 'runtime/character')
ROOT_FILES = ('package.json', 'package-lock.json', 'tsconfig.json', 'AGENTS.md', 'README.md', 'LICENSE')
TIEBA_FILES = ('publishing.json', 'publishing-web.json', 'moderator-permission.json', 'publication-work.json', 'moderator-work.json', 'verified-capabilities.json')
DENIED_NAMES = {'auth.json', 'credentials.json', 'onebot-credentials.json', 'webui-secrets.json', 'login-secrets.json', 'admin-token', 'webui-admin-token'}
SECRET_KEY = re.compile(r'(secret|password|credential|api_?key|access_?token|refresh_?token|id_?token)', re.I)
DATE = re.compile(r'20\d{2}-\d{2}-\d{2}')


def now():
    return datetime.now(ZONE).isoformat(timespec='seconds')


def write_json(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, file)


def write_text(file, text):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding='utf-8')
    file.chmod(0o600)


def no_links(file):
    for item in (file, *file.parents):
        if item.is_symlink():
            raise RuntimeError('Linked backup path refused: ' + str(item))


def safe_relative(name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or '\\' in name or any(v in ('.', '..', '') for v in p.parts):
        raise RuntimeError('Invalid backup path')
    return p


def allowed(name):
    safe_relative(name)
    return name in ROOT_FILES or name == 'config/local.json' or name in DATABASES or name in ['runtime/data/' + v for v in DATA_FILES] or name in ['runtime/tieba-account/' + v for v in TIEBA_FILES] or any(name.startswith(t + '/') for t in TREES)


def git_env(work):
    env = os.environ.copy()
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0', GIT_SSH=str(work / 'github-ssh.py'))
    return env


def git(repo, work, *args):
    return subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'user.name=DeepSeekFish Backup', '-c', 'user.email=backup@deepseekfish.invalid', '-C', str(repo), *args], env=git_env(work), check=True, capture_output=True, text=True, timeout=600).stdout.strip()


def copy_stable(source, destination):
    no_links(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        with os.fdopen(os.open(source, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as src:
            before = os.fstat(src.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise RuntimeError('Non-regular backup input')
            with destination.open('wb') as out:
                shutil.copyfileobj(src, out, 1024 * 1024)
            after = os.fstat(src.fileno())
        if (before.st_ino, before.st_size, before.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns):
            destination.chmod(0o600)
            os.utime(destination, ns=(before.st_atime_ns, before.st_mtime_ns))
            return {'bytes': before.st_size, 'mtimeNs': str(before.st_mtime_ns)}
        if attempt == 2:
            raise RuntimeError('Input changed while copying: ' + source.name)
        time.sleep(.2)


def inputs(root):
    for name in (*ROOT_FILES, *('runtime/data/' + v for v in DATA_FILES), *('runtime/tieba-account/' + v for v in TIEBA_FILES)):
        if (root / name).is_file():
            yield root / name
    config = root / 'config/local.json'
    if config.is_file():
        no_links(config)
        content = json.loads(config.read_text())
        if any(SECRET_KEY.search(k) or k.lower() in ('token', 'key', 'authorization', 'cookie') for k in content):
            raise RuntimeError('Credential-like config field; config was not uploaded')
        yield config
    for tree in TREES:
        parent = root / tree
        if not parent.exists():
            continue
        no_links(parent)
        for base, directories, files in os.walk(parent, followlinks=False):
            directories[:] = sorted(d for d in directories if not (Path(base) / d).is_symlink() and d not in ('.git', 'node_modules', '__pycache__'))
            for name in sorted(files):
                file = Path(base) / name
                if file.is_symlink() or name in DENIED_NAMES or name.startswith('.env') or name.endswith(('.tmp', '.partial', '.key', '.pem', '.sqlite-wal', '.sqlite-shm')):
                    continue
                if file.is_file():
                    yield file


def database_snapshot(source, target, temporary):
    no_links(source)
    database = temporary / source.parent.name / source.name
    database.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=10) as src, sqlite3.connect(database) as dst:
        src.backup(dst, pages=256, sleep=.05)
    target.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(database) as db, target.open('w', encoding='utf-8') as f:
        for line in db.iterdump():
            f.write(line + '\n')
        for pragma in ('user_version', 'application_id'):
            f.write('PRAGMA ' + pragma + '=' + str(int(db.execute('PRAGMA ' + pragma).fetchone()[0])) + ';\n')
    target.chmod(0o600)
    return database


def timestamp(value):
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000 if value > 100000000000 else value, ZONE)
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(ZONE)
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def record_time(record, file):
    for key in ('startedAt', 'at', 'created', 'createdAt', 'updated', 'finishedAt'):
        date = timestamp(record.get(key))
        if date:
            return date
    day = record.get('day')
    if isinstance(day, str) and DATE.fullmatch(day):
        return datetime.fromisoformat(day).replace(tzinfo=ZONE)
    return datetime.fromtimestamp(file.stat().st_mtime, ZONE)


def quoted(value):
    return '\n'.join('> ' + line for line in str(value).replace('\r\n', '\n').split('\n'))


def read_json(file):
    try:
        value = json.loads(file.read_text())
        return value if isinstance(value, dict) else {}
    except (ValueError, UnicodeError):
        return {}


def render_chats(folder):
    conversations = collections.defaultdict(list)
    for file in sorted((folder / 'chat-originals').glob('*.jsonl')):
        for line in file.read_text().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                raise RuntimeError('Incomplete chat archive: ' + file.name) from None
            conversations[str(event.get('conversation', '未知会话'))].append(event)
    if not conversations:
        return 0
    out = ['# ' + folder.name + ' 聊天记录', '', '香港时间 UTC+8；下列内容来自原始归档，没有用模型总结或补写。', '']
    count = 0
    for conversation, events in sorted(conversations.items()):
        out.extend(['## ' + conversation, ''])
        for event in sorted(events, key=lambda e: e.get('at', 0)):
            count += 1
            time_value = timestamp(event.get('at'))
            who = str(event.get('actor', '未知用户'))
            if event.get('role') == 'assistant' or who == 'DeepSeekFish':
                who = '肥鱼'
            else:
                sender = event.get('sender') or {}
                observed = sender.get('card') or sender.get('nickname') if isinstance(sender, dict) else None
                if observed:
                    who = str(observed) + ' · ' + who
            out.extend(['### ' + (time_value.strftime('%H:%M:%S') if time_value else '时间未记录') + ' · ' + who, '', quoted(event.get('text', '')), ''])
    write_text(folder / '聊天记录.md', '\n'.join(out))
    return count


def render_calls(folder):
    rows = []
    for file in (folder / 'logs').glob('*/*.json'):
        record = read_json(file)
        rows.append((record_time(record, file), file, record))
    if not rows:
        return 0
    out = ['# ' + folder.name + ' 调用记录', '', '按真实请求时间排列。原始 JSON 保留完整已记录的请求、工具参数、回执、失败及用量；这里仅作阅读索引。', '']
    for date, file, record in sorted(rows, key=lambda row: (row[0], str(row[1]))):
        title = str(record.get('request') or record.get('note') or record.get('id') or file.stem)
        if isinstance(record.get('request'), dict):
            title = str(record['request'].get('prompt') or file.stem)
        title = title.replace('\n', ' ')[:150]
        out.extend(['## ' + date.strftime('%H:%M:%S') + ' · ' + file.parent.name + ' · ' + title, '', '- 状态：' + str(record.get('state') or record.get('outcome') or '未记录'), '- [原始 JSON](' + quote(file.relative_to(folder).as_posix(), safe='/') + ')'])
        trace = record.get('trace', [])
        models = [e for e in trace if isinstance(e, dict) and e.get('kind') == 'model'] if isinstance(trace, list) else []
        usages = [e['usage'] for e in models if isinstance(e.get('usage'), dict)]
        if usages:
            known = [u for u in usages if isinstance(u.get('input'), int) and isinstance(u.get('output'), int)]
            text = '- 已记录 token：输入 ' + str(sum(u['input'] for u in known)) + '；输出 ' + str(sum(u['output'] for u in known))
            cached = [u.get('cachedInput') for u in known]
            if known and all(isinstance(v, int) for v in cached):
                text += '；缓存输入 ' + str(sum(cached))
            if len(known) < len(models):
                text += '（部分请求未报告用量）'
            out.append(text)
        if isinstance(trace, list):
            for event in trace:
                if not isinstance(event, dict) or not event.get('tool'):
                    continue
                result = event.get('result')
                state = result.get('error') or result.get('deliveryStatus') or result.get('state') if isinstance(result, dict) else None
                out.append('- 工具：`' + str(event['tool']) + '`' + (' · ' + str(state) if state else ''))
        out.append('')
    write_text(folder / '调用记录.md', '\n'.join(out))
    return len(rows)


def daily_records(repo, state, databases, captured_at):
    daily = repo / 'daily'
    daily.mkdir(exist_ok=True)
    archive = state / 'runtime/memory/days'
    if archive.exists():
        for date_folder in archive.iterdir():
            if not date_folder.is_dir() or not DATE.fullmatch(date_folder.name):
                continue
            for file in date_folder.glob('*.jsonl'):
                target = daily / date_folder.name / 'chat-originals' / file.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, target)
    logs = state / 'runtime/logs'
    if logs.exists():
        for file in logs.glob('*/*.json'):
            date = record_time(read_json(file), file).strftime('%Y-%m-%d')
            target = daily / date / 'logs' / file.parent.name / file.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(file, target)
    today = daily / captured_at[:10]
    today.mkdir(exist_ok=True)
    persona = state / 'runtime/data/persona.json'
    if persona.is_file():
        data = read_json(persona)
        out = ['# 人格快照', '', '实际备份时间：' + captured_at, '']
        for block in data.get('blocks', []):
            out.extend(['## ' + str(block.get('title', '人格分块')), '', str(block.get('text', '')), ''])
        out.extend(['## 外观', '', str(data.get('appearance', '')), ''])
        write_text(today / '人格.md', '\n'.join(out))
        shutil.copyfile(persona, today / 'persona.json')
    knowledge = databases.get('runtime/data/knowledge.sqlite')
    if knowledge:
        with sqlite3.connect(knowledge) as db:
            rows = db.execute('SELECT id,text FROM knowledge ORDER BY id').fetchall()
        write_text(today / '知识库.md', '# 知识库快照\n\n实际备份时间：' + captured_at + '\n\n' + '\n\n'.join(str(i) + '. ' + text for i, text in rows) + '\n')
    fish = databases.get('runtime/data/fish.sqlite')
    if fish:
        with sqlite3.connect(fish) as db:
            db.row_factory = sqlite3.Row
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE name='curiosity_entries'").fetchone()
            entries = [dict(r) for r in db.execute('SELECT * FROM curiosity_entries ORDER BY created,id')] if exists else []
        out = ['# 好奇心日志', '', '实际备份时间：' + captured_at, '']
        for entry in entries:
            out.extend(['## ' + str(entry.get('title', '未命名兴趣')) + ('（已移除）' if entry.get('removed') else ''), '', str(entry.get('content', '')), ''])
            sources = entry.get('sources')
            if sources:
                out.extend(['来源：' + str(sources), ''])
        write_text(today / '好奇心日志.md', '\n'.join(out))
    folders = sorted([d for d in daily.iterdir() if d.is_dir() and DATE.fullmatch(d.name)], reverse=True)
    index = ['# 每日记录', '', '日期均为香港时间 UTC+8。点击日期直接阅读；没有重新生成对话内容。', '']
    for folder in folders:
        chats, calls = render_chats(folder), render_calls(folder)
        out = ['# ' + folder.name + ' · 大肥鱼的记录', '', '聊天和调用按实际发生日期归档；人格、知识库等按实际备份时间保存。', '']
        for name, label in [('聊天记录.md', '聊天记录（' + str(chats) + '条）'), ('调用记录.md', '调用记录（' + str(calls) + '轮／任务）'), ('人格.md', '人格快照'), ('知识库.md', '长期知识库快照'), ('好奇心日志.md', '好奇心日志快照')]:
            if (folder / name).exists():
                out.append('- [' + label + '](' + quote(name) + ')')
        out.extend(['', '[当前完整原始状态](../../state/) · [每日记录目录](../README.md)', ''])
        write_text(folder / 'README.md', '\n'.join(out))
        index.append('- [' + folder.name + '](' + folder.name + '/README.md) · 聊天 ' + str(chats) + ' 条 · 调用 ' + str(calls) + ' 轮／任务')
    write_text(daily / 'README.md', '\n'.join(index) + '\n')
    return [d.name for d in folders]


def require_private_repository(config):
    import urllib.request
    import urllib.error
    request = urllib.request.Request('https://api.github.com/repos/' + config['repository'], headers={'User-Agent': 'DeepSeekFish-state-backup', 'Accept': 'application/vnd.github+json'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.load(response)
        if data.get('private') is not True:
            raise RuntimeError('Backup repository is publicly accessible; upload refused')
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise RuntimeError('Could not confirm repository privacy: HTTP ' + str(e.code)) from None


def run(root, work):
    root = root.resolve()
    no_links(root)
    no_links(work)
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (work / 'run.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Backup already running; no duplicate run started.')
            return
        config = json.loads((work / 'config.json').read_text())
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', config['repository']):
            raise RuntimeError('Invalid backup repository')
        repo = work / 'repository'
        remote = 'git@github.com:' + config['repository'] + '.git'
        if not (repo / '.git').is_dir() or git(repo, work, 'remote', 'get-url', 'origin') != remote:
            raise RuntimeError('Backup repository differs from the authorized configuration')
        previous = read_json(work / 'status.json') if (work / 'status.json').exists() else {}
        status = {'version': VERSION, 'state': 'running', 'startedAt': now(), 'lastSuccessAt': previous.get('lastSuccessAt'), 'lastSuccessCommit': previous.get('lastSuccessCommit')}
        write_json(work / 'status.json', status)
        local_commit = None
        try:
            started = datetime.now(ZONE)
            captured = started.isoformat(timespec='seconds')
            receipts, file_count, total_bytes, splits = {}, 0, 0, []
            with tempfile.TemporaryDirectory(prefix='readable-backup-', dir=work) as temporary:
                stage = Path(temporary)
                state = stage / 'state'
                state.mkdir()
                databases = {}
                for relative in DATABASES:
                    source = root / relative
                    if source.is_file():
                        databases[relative] = database_snapshot(source, state / (relative + '.sql'), stage / 'databases')
                        file_count += 1
                        total_bytes += (state / (relative + '.sql')).stat().st_size
                for source in inputs(root):
                    relative = source.relative_to(root).as_posix()
                    target = state / relative
                    info = copy_stable(source, target)
                    file_count += 1
                    total_bytes += info['bytes']
                    if relative.startswith('runtime/logs/exploration/'):
                        receipts[relative] = info
                    if info['bytes'] > LARGE_FILE:
                        parts = []
                        with target.open('rb') as f:
                            number = 1
                            while block := f.read(PART_SIZE):
                                part = target.with_name(target.name + '.part-' + str(number).zfill(3))
                                part.write_bytes(block)
                                parts.append(part.relative_to(state).as_posix())
                                number += 1
                        target.unlink()
                        splits.append({'path': relative, 'parts': parts, 'bytes': info['bytes']})
                dates = daily_records(repo, state, databases, captured)
                deployment = read_json(root / 'runtime/logs/tieba-deployment.json') if (root / 'runtime/logs/tieba-deployment.json').exists() else {}
                info = {'version': VERSION, 'createdAt': captured, 'timezone': 'Asia/Hong_Kong', 'encrypted': False, 'credentialsIncluded': False, 'sourceRevision': deployment.get('revision'), 'sourceModified': deployment.get('workingTreeModified'), 'fileCount': file_count, 'payloadBytes': total_bytes, 'databases': list(databases), 'splitFiles': splits, 'consistency': 'Online snapshot per SQLite database; normal files copied with change detection.'}
                write_json(state / 'backup-info.json', info)
                if (repo / 'state').exists():
                    shutil.rmtree(repo / 'state')
                os.replace(state, repo / 'state')
            tools = repo / 'tools'
            tools.mkdir(exist_ok=True)
            for script in ('backup-state.py', 'install-memory-backup.py'):
                shutil.copyfile(root / 'scripts' / script, tools / script)
            (tools / 'deploy').mkdir(exist_ok=True)
            for unit in ('deepseekfish-memory-backup.service', 'deepseekfish-memory-backup.timer'):
                shutil.copyfile(root / 'deploy' / unit, tools / 'deploy' / unit)
            policy = (root / 'docs/memory-backup.md').read_text()
            links = '\n'.join('- [' + day + '](daily/' + day + '/README.md)' for day in dates[:14])
            write_text(repo / 'README.md', policy + '\n## 最近日期\n\n' + links + '\n\n[全部日期](daily/README.md)\n')
            write_json(repo / 'latest.json', {'version': VERSION, 'date': started.strftime('%Y-%m-%d'), 'createdAt': captured, 'records': 'daily/' + started.strftime('%Y-%m-%d') + '/README.md', 'state': 'state/'})
            # Format migration is a normal new commit. The original SHA-named
            # backup remains recoverable at its existing historical commit.
            for legacy in ('objects', 'snapshots', 'current'):
                if (repo / legacy).exists():
                    git(repo, work, 'rm', '-r', '--ignore-unmatch', '--', legacy)
            git(repo, work, 'add', '-A', '--', 'README.md', 'daily', 'state', 'tools', 'latest.json')
            git(repo, work, 'commit', '-m', 'Daily readable backup ' + captured)
            local_commit = git(repo, work, 'rev-parse', 'HEAD')
            status.update(state='uploading', date=started.strftime('%Y-%m-%d'), fileCount=file_count, payloadBytes=total_bytes, localCommit=local_commit)
            write_json(work / 'status.json', status)
            require_private_repository(config)
            git(repo, work, 'fetch', 'origin', 'main')
            git(repo, work, 'merge', '--no-edit', 'origin/main')
            git(repo, work, 'push', 'origin', 'HEAD:main')
            commit = git(repo, work, 'rev-parse', 'HEAD')
            if git(repo, work, 'ls-remote', 'origin', 'refs/heads/main').split()[0] != commit:
                raise RuntimeError('Remote branch changed before upload confirmation')
            status.update(state='succeeded', completedAt=now(), lastSuccessAt=now(), lastSuccessCommit=commit, commit=commit, error=None)
            write_json(work / 'status.json', status)
            write_json(root / 'runtime/data/backup-log-receipts.json', {'enabled': True, 'confirmedAt': now(), 'commit': commit, 'files': receipts})
            (root / 'runtime/data/backup-log-receipts.json').chmod(0o644)
            print(json.dumps({k: status[k] for k in ('state', 'completedAt', 'date', 'commit', 'fileCount')}, ensure_ascii=False))
        except Exception as e:
            message = ('Git failed (exit ' + str(e.returncode) + '): ' + str(e.stderr or '').strip()[:800]) if isinstance(e, subprocess.CalledProcessError) else str(e)[:800]
            status.update(state='failed', completedAt=now(), error=message, pendingLocalBackup=bool(local_commit))
            write_json(work / 'status.json', status)
            print(json.dumps({'state': 'failed', 'error': message, 'pendingLocalBackup': bool(local_commit)}), file=sys.stderr)
            raise SystemExit(1)


def materialize(repo, output):
    repo, output = repo.resolve(), output.absolute()
    no_links(output)
    if output.exists() and any(output.iterdir()):
        raise RuntimeError('Restore destination must be empty; live state is never overwritten')
    state = repo / 'state'
    metadata = read_json(state / 'backup-info.json') if (state / 'backup-info.json').exists() else {}
    if metadata.get('version') != VERSION or metadata.get('credentialsIncluded') is not False:
        raise RuntimeError('This is not a readable v2 backup. For the first v1 backup, checkout its original commit and use that commit\'s tools/backup-state.py.')
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    split_paths = {p for entry in metadata.get('splitFiles', []) for p in entry['parts']}
    database_paths = set(metadata['databases'])
    for base, directories, files in os.walk(state, followlinks=False):
        for name in files:
            source = Path(base) / name
            relative = source.relative_to(state).as_posix()
            if relative == 'backup-info.json' or relative in split_paths:
                continue
            database = relative[:-4] if relative.endswith('.sql') and relative[:-4] in database_paths else None
            if not allowed(database or relative):
                raise RuntimeError('Restore path outside the backup scope')
            no_links(source)
            target = output.joinpath(*safe_relative(database or relative).parts)
            no_links(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            if database:
                with sqlite3.connect(target) as db:
                    def authorize(action, first, second, database_name, trigger):
                        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH) or database_name not in (None, 'main', 'temp'):
                            return sqlite3.SQLITE_DENY
                        if action == sqlite3.SQLITE_FUNCTION and str(second).lower() == 'load_extension':
                            return sqlite3.SQLITE_DENY
                        if action == sqlite3.SQLITE_PRAGMA and str(first).lower() not in ('user_version', 'application_id', 'foreign_keys'):
                            return sqlite3.SQLITE_DENY
                        return sqlite3.SQLITE_OK
                    db.set_authorizer(authorize)
                    db.executescript(source.read_text())
            else:
                shutil.copyfile(source, target)
            target.chmod(0o600)
    for entry in metadata.get('splitFiles', []):
        if not allowed(entry['path']):
            raise RuntimeError('Split restore path outside scope')
        target = output.joinpath(*safe_relative(entry['path']).parts)
        no_links(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as out:
            for name in entry['parts']:
                source = state.joinpath(*safe_relative(name).parts)
                no_links(source)
                with source.open('rb') as part:
                    shutil.copyfileobj(part, out)
        if target.stat().st_size != entry['bytes']:
            raise RuntimeError('Incomplete split file')
    write_json(output / 'backup-restored.json', {'version': VERSION, 'createdAt': metadata['createdAt'], 'materializedAt': now(), 'credentialsIncluded': False})
    print('Backup materialized into: ' + str(output))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('run', 'status'):
        p = sub.add_parser(action)
        p.add_argument('--root', type=Path, default=Path('/srv/deepseekfish/app'))
        p.add_argument('--work', type=Path)
    p = sub.add_parser('materialize')
    p.add_argument('--repository', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'materialize':
        materialize(args.repository, args.output)
    else:
        work = args.work or args.root / 'runtime/backup'
        if args.action == 'run':
            run(args.root, work)
        else:
            print((work / 'status.json').read_text() if (work / 'status.json').exists() else '{"state":"not_run"}')


if __name__ == '__main__':
    main()
