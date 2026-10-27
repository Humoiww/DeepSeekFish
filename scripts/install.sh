#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/env.sh"
cd -- "$FISH_PROJECT_ROOT"
fish_npm ci --ignore-scripts
fish_npm run build
echo '依赖与构建完成。运行 bash scripts/start.sh --mock 验证离线模式。'
