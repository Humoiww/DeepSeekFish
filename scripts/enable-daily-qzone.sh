#!/usr/bin/env bash
# Explicit owner opt-in: one daily, illustrated Qzone post on the bot's account.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
target=/srv/deepseekfish/app
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
test -f "$target/dist/src/qq/daily-qzone.js"
python3 - <<'PY'
import json,os,pwd
from pathlib import Path
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
root=Path('/srv/deepseekfish/app');file=root/'runtime/data/daily-qzone.json'
settings=json.loads((root/'runtime/data/qq-settings.json').read_text())
users=settings.get('privateUsers',[])
if not users: raise SystemExit('Configure the owner QQ conversation first.')
config=json.loads(file.read_text()) if file.exists() else {'owner':users[0],'startsOn':(datetime.now(ZoneInfo('Asia/Hong_Kong'))+timedelta(days=1)).date().isoformat()}
if config['owner'] not in users: raise SystemExit('Scheduled owner is no longer allowed.')
config.update(enabled=True,timezone='Asia/Hong_Kong')
file.write_text(json.dumps(config,ensure_ascii=False,indent=2)+'\n')
account=pwd.getpwnam('deepseekfish');os.chown(file,account.pw_uid,account.pw_gid);file.chmod(0o600)
print('Daily Qzone enabled; first midnight: '+config['startsOn']+' Asia/Hong_Kong')
PY
install -o root -g root -m 0644 "$source_root/deploy/deepseekfish-daily-qzone.service" /etc/systemd/system/
install -o root -g root -m 0644 "$source_root/deploy/deepseekfish-daily-qzone.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now deepseekfish-daily-qzone.timer
systemctl list-timers deepseekfish-daily-qzone.timer --no-pager
