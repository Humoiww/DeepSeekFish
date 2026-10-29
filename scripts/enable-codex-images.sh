#!/usr/bin/env bash
# Explicitly enable image-only runtime support; does not log in or run a model.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
target=/srv/deepseekfish/app
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
getent passwd deepseekfish >/dev/null
install -d -o deepseekfish -g deepseekfish -m 0700 "$target/runtime/codex-home"
install -d -o root -g root -m 0755 /etc/systemd/system/deepseekfish-web.service.d
install -o root -g root -m 0644 "$source_root/deploy/deepseekfish-web-images.conf" /etc/systemd/system/deepseekfish-web.service.d/images.conf
systemctl daemon-reload
systemctl restart deepseekfish-web.service
echo 'Image-only runtime enabled; ordinary autonomous Codex remains disabled.'
echo 'New account login: sudo -u deepseekfish bash /srv/deepseekfish/app/scripts/manage.sh codex-login --device-auth'
