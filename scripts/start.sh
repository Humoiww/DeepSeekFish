#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
if [[ $# -gt 1 || $# -eq 1 && "$1" != '--mock' ]]; then
  echo '用法：bash scripts/start.sh [--mock]' >&2
  exit 1
fi
cd -- "$FISH_PROJECT_ROOT"
fish_npm run build
exec "$FISH_NODE_BIN" dist/src/cli.js start "$@"
