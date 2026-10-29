#!/usr/bin/env bash
# Enable the user-authorized QQ -> private broker -> existing image runner.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
target=/srv/deepseekfish/app
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
test -f /etc/systemd/system/deepseekfish-web.service.d/images.conf
test -f "$target/dist/src/qq/image-broker.js"
install -d -o deepseekfish -g deepseekfish -m 0700 "$target/runtime/broker"
install -o root -g root -m 0644 "$source_root/deploy/deepseekfish-qq-images.conf" /etc/systemd/system/deepseekfish-web.service.d/qq-images.conf
systemctl daemon-reload
systemctl restart deepseekfish-web.service
python3 - <<'PY'
import json,urllib.request
from pathlib import Path
root=Path('/srv/deepseekfish/app')
token=(root/'runtime/data/admin-token').read_text().strip()
def api(route,value=None):
    req=urllib.request.Request('http://127.0.0.1:17861/api/'+route,
        data=json.dumps(value).encode() if value is not None else None,
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(req,timeout=15))
api('set',{'key':'images','value':True})
if api('status')['budgets']['maxOutputTokens']<768:
    api('set',{'key':'maxOutputTokens','value':768})
print('QQ image broker enabled; shared allowances and ordinary Codex approval remain in force.')
PY
