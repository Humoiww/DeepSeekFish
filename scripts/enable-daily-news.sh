#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
target=/srv/deepseekfish/app
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
test -f "$target/dist/src/qq/daily-news.js"
python3 - <<'PY'
import json,os,pwd
from pathlib import Path
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
root=Path('/srv/deepseekfish/app');file=root/'runtime/data/daily-news.json'
settings=json.loads((root/'runtime/data/qq-settings.json').read_text())
users=settings.get('privateUsers',[])
if len(users)!=1: raise SystemExit('Exactly one owner QQ private conversation is required.')
now=datetime.now(ZoneInfo('Asia/Hong_Kong'))
first=(now if now.hour<8 else now+timedelta(days=1)).date().isoformat()
config=json.loads(file.read_text()) if file.exists() else {'owner':users[0],'startsOn':first}
if config['owner']!=users[0]: raise SystemExit('Scheduled owner no longer matches the configured QQ owner.')
config.update(enabled=True,timezone='Asia/Hong_Kong')
temporary=file.with_suffix('.tmp');temporary.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
account=pwd.getpwnam('deepseekfish');os.chown(temporary,account.pw_uid,account.pw_gid);temporary.chmod(0o600);temporary.replace(file)
print('Daily news enabled: '+config['startsOn']+' 08:00 Asia/Hong_Kong; private owner only.')
PY
install -o root -g root -m 0644 "$source_root/deploy/deepseekfish-daily-news.service" /etc/systemd/system/
install -o root -g root -m 0644 "$source_root/deploy/deepseekfish-daily-news.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now deepseekfish-daily-news.timer
systemctl list-timers deepseekfish-daily-news.timer --no-pager
