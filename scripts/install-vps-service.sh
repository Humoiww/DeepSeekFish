#!/usr/bin/env bash
# Review and run as root. Installs a dedicated AppArmor launcher/profile and
# units, but does not start services or alter SSH/Tailscale/firewall/global policy.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run this reviewed script in a root terminal.' >&2; exit 1; }
test -x /usr/bin/bwrap
command -v apparmor_parser >/dev/null
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
target=/srv/deepseekfish/app
[[ ! -e /srv/deepseekfish ]] || { echo 'Destination exists: inspect it before migration; refusing to overwrite.' >&2; exit 1; }
if getent passwd deepseekfish >/dev/null || getent group deepseekfish >/dev/null; then
  echo 'Account/group exists: inspect it before migration; refusing to reuse blindly.' >&2; exit 1
fi
[[ -f "$source_root/runtime/deployment/deepseekfish-release.tar.gz" ]]
expected=$(awk '$2=="deepseekfish-release.tar.gz" {print $1}' "$source_root/runtime/deployment/deepseekfish-release.sha256")
[[ $expected =~ ^[0-9a-f]{64}$ ]]
install -d -o root -g root -m 0755 /srv/deepseekfish
# Copy to root-owned storage before verifying/extracting to avoid source races.
install -o root -g root -m 0600 "$source_root/runtime/deployment/deepseekfish-release.tar.gz" /srv/deepseekfish/release.tar.gz
actual=$(sha256sum /srv/deepseekfish/release.tar.gz)
[[ ${actual%% *} == "$expected" ]] || { echo 'Release digest mismatch; nothing extracted.' >&2; exit 1; }
python3 - <<'PY'
import tarfile,posixpath
with tarfile.open('/srv/deepseekfish/release.tar.gz') as t:
    for m in t.getmembers():
        if m.name.startswith('/') or '..' in m.name.split('/') or not (m.isfile() or m.isdir() or m.issym()):
            raise SystemExit('Unsafe archive entry: '+m.name)
        if m.issym():
            resolved=posixpath.normpath(posixpath.join(posixpath.dirname(m.name),m.linkname))
            if m.linkname.startswith('/') or resolved=='..' or resolved.startswith('../'):
                raise SystemExit('Unsafe archive link: '+m.name)
PY
install -d -o root -g root -m 0755 "$target"
tar -xzf /srv/deepseekfish/release.tar.gz -C "$target" --no-same-owner --no-same-permissions
chown -R root:root "$target"
chmod -R u=rwX,go=rX "$target"
useradd --system --user-group --no-create-home --home-dir /srv/deepseekfish --shell /usr/sbin/nologin deepseekfish
for name in data logs cache tmp workspace outputs memory probe-codex-home; do
  install -d -o deepseekfish -g deepseekfish -m 0700 "$target/runtime/$name"
done
install -d -o root -g root -m 0755 "$target/runtime/codex-home"
install -o root -g root -m 0755 /usr/bin/bwrap "$target/runtime/tools/bwrap"
install -o root -g root -m 0644 "$target/deploy/deepseekfish-sandbox.apparmor" /etc/apparmor.d/deepseekfish-sandbox
apparmor_parser -r /etc/apparmor.d/deepseekfish-sandbox
install -o root -g root -m 0644 "$target/deploy/server-config.json" "$target/config/local.json"
install -o root -g root -m 0644 "$target/deploy/deepseekfish-web.service" /etc/systemd/system/deepseekfish-web.service
install -o root -g root -m 0644 "$target/deploy/deepseekfish-sandbox-check.service" /etc/systemd/system/deepseekfish-sandbox-check.service
install -o root -g root -m 0644 "$target/deploy/deepseekfish-qq.service" /etc/systemd/system/deepseekfish-qq.service
install -o root -g root -m 0644 "$target/deploy/deepseekfish-qq.path" /etc/systemd/system/deepseekfish-qq.path
systemd-analyze verify /etc/systemd/system/deepseekfish-web.service /etc/systemd/system/deepseekfish-sandbox-check.service
systemctl daemon-reload
systemctl enable --now deepseekfish-qq.path
echo 'Staged, not started. Stop the old Mock with its CLI, then systemctl enable --now deepseekfish-web.service.'
