#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/scripts/env.sh"
cd -- "$FISH_PROJECT_ROOT"
if [[ ! -f node_modules/typescript/bin/tsc ]]; then
  fish_npm ci --ignore-scripts
fi
fish_npm run build
exec "$FISH_NODE_BIN" dist/src/cli.js webui "$@"
