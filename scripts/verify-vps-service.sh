#!/usr/bin/env bash
# Run manually as root after enabling the service. No paid requests or task execution.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Root required to inspect the service account and unit.' >&2; exit 1; }
[[ $# == 0 || $# == 1 && $1 == --restart ]] || exit 2
target=/srv/deepseekfish/app
systemctl is-active --quiet deepseekfish-web.service
runuser -u deepseekfish -- test ! -x /home/fishops
runuser -u deepseekfish -- test ! -w "$target"
runuser -u deepseekfish -- test ! -w "$target/runtime/tools/node/bin/node"
runuser -u deepseekfish -- test ! -w "$target/runtime/codex-home"
before=$(sha256sum "$target/runtime/data/webui-admin-token")
if [[ ${1:-} == --restart ]]; then
  systemctl restart deepseekfish-web.service
fi
python3 - <<'PY'
import json,time,urllib.request,urllib.error
base='http://127.0.0.1:17862'
token=open('/srv/deepseekfish/app/runtime/data/webui-admin-token').read().strip()
for attempt in range(30):
    try:
        req=urllib.request.Request(base+'/api/status',headers={'Authorization':'Bearer '+token})
        with urllib.request.urlopen(req,timeout=2) as r: status=json.load(r)
        break
    except (OSError,urllib.error.URLError): time.sleep(.2)
else: raise SystemExit('Service readiness failed')
assert status['mock'] is False, 'Old Mock still occupies the port'
assert status['credentialPresent'] is False, 'Do not configure credentials before this initial check'
assert status['settings']['codexQueue'] is False
assert status['settings']['search'] is False
try:
    urllib.request.urlopen(base+'/api/status',timeout=2)
    raise AssertionError('Unauthenticated API unexpectedly accessible')
except urllib.error.HTTPError as e: assert e.code==401
print('PASS: credential-free production WebUI ready, Codex queue/search off, authentication enforced')
PY
after=$(sha256sum "$target/runtime/data/webui-admin-token")
[[ $before == "$after" ]] || { echo 'Admin token changed across restart' >&2; exit 1; }
ss -ltnp 'sport = :17862'
systemctl show deepseekfish-web.service -p User -p ActiveState -p SubState -p MainPID -p NRestarts
systemctl is-active tailscaled ssh
echo 'PASS: restart/token persistence (if requested), account boundary and immutable release. This is NOT a Codex sandbox pass.'
