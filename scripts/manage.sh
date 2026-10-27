#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd -- "$FISH_PROJECT_ROOT"
if [[ ! -f dist/src/cli.js ]]; then
  echo '请先执行 bash scripts/install.sh。' >&2
  exit 1
fi
exec "$FISH_NODE_BIN" dist/src/cli.js "$@"
