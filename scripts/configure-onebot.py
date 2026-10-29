#!/usr/bin/env python3
"""Save non-secret QQ options and privately prompt for the separate WS token."""
import argparse
import getpass
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import sqlite3
from urllib.parse import urlsplit

p = argparse.ArgumentParser()
p.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
p.add_argument('--url', default='ws://127.0.0.1:3001')
p.add_argument('--groups', default='', help='Optional comma-separated QQ group numbers')
p.add_argument('--admins', required=True, help='Comma-separated administrator QQ numbers')
p.add_argument('--use-existing-token', action='store_true', help='Reuse the token prepared by install-napcat.py')
args = p.parse_args()
root = args.root.resolve()
url = urlsplit(args.url)
private = url.hostname in ['localhost', '127.0.0.1', '::1']
try:
    private = private or ipaddress.ip_address(url.hostname) in ipaddress.ip_network('100.64.0.0/10')
except ValueError:
    pass
if url.scheme not in ['ws', 'wss'] or not url.hostname or url.username or url.password or url.query or url.fragment or len(args.url) > 512 or (url.scheme == 'ws' and not private):
    p.error('Use a credential-free loopback/Tailscale ws URL or a wss URL.')
def ids(value, allow_empty=False):
    values = [s.strip() for s in value.split(',') if s.strip()]
    if (not values and not allow_empty) or not all(re.fullmatch(r'[1-9]\d{0,19}', s) for s in values):
        p.error('Group/admin IDs must be comma-separated numeric QQ identifiers.')
    return list(dict.fromkeys(values))
groups, admins = ids(args.groups, True), ids(args.admins)
config_file = root / 'config/local.json'
if config_file.is_symlink():
    raise SystemExit('Linked config is not supported.')
config = json.loads(config_file.read_text()) if config_file.exists() else {}
config.update(qqTransport='onebot', onebotUrl=args.url, groups=groups, admins=admins, privateUsers=admins, codex=False, images=False)
config.setdefault('names', ['鲸酱', '小鱼', 'DeepSeekFish'])
config.setdefault('autonomous', False)
config.setdefault('autoReply', False)
web_db = root / 'runtime/data/webui.sqlite'
if web_db.is_file():
    with sqlite3.connect('file:' + str(web_db) + '?mode=ro', uri=True) as db:
        row = db.execute("SELECT value FROM meta WHERE key='web-settings'").fetchone()
    if row:
        model = json.loads(row[0]).get('model')
        if isinstance(model, str) and re.fullmatch(r'[a-zA-Z0-9._-]{1,80}', model):
            config['model'] = model
existing_token = root / 'runtime/data/onebot-credentials.json'
token = json.loads(existing_token.read_text())['accessToken'] if args.use_existing_token else getpass.getpass('OneBot Access Token（NapCat 网络配置中的 Token，不是 WebUI 密码）: ')
if not token or len(token) > 512 or any(c in token for c in '\r\n\0'):
    raise SystemExit('Invalid OneBot token.')
config_file.parent.mkdir(parents=True, exist_ok=True)
secret = root / 'runtime/data/onebot-credentials.json'
secret.parent.mkdir(parents=True, exist_ok=True)
if secret.is_symlink() or (secret.exists() and secret.stat().st_nlink != 1):
    raise SystemExit('Linked credential file is not supported.')
fd = os.open(secret, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump({'accessToken': token}, f)
secret.chmod(0o600)
if os.geteuid() == 0 and root == Path('/srv/deepseekfish/app'):
    u = pwd.getpwnam('deepseekfish')
    os.chown(secret, u.pw_uid, u.pw_gid)
config_file.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
config_file.chmod(0o644)
print('QQ configuration saved; token stays private. No messages sent and no services started.')
print('Next: bash scripts/manage.sh qq-check, then start the QQ service when ready.')
