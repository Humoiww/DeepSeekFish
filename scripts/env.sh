#!/usr/bin/env bash
# Source from the Linux helpers; modifies only this process's environment.
FISH_PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ -n "${FISH_NODE:-}" ]]; then
  FISH_NODE_BIN="$FISH_NODE"
elif [[ -x "$FISH_PROJECT_ROOT/runtime/tools/node/bin/node" ]]; then
  FISH_NODE_BIN="$FISH_PROJECT_ROOT/runtime/tools/node/bin/node"
else
  FISH_NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$FISH_NODE_BIN" || ! -x "$FISH_NODE_BIN" ]]; then
  echo '需要 Node >=24.9。使用已有 Node，或解压官方便携包到 runtime/tools/node/，再重试。' >&2
  exit 1
fi
if ! "$FISH_NODE_BIN" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>24||major===24&&minor>=9?0:1)'; then
  echo 'Node 版本过旧：需要 >=24.9。' >&2
  exit 1
fi
export PATH="$(dirname -- "$FISH_NODE_BIN"):$PATH"
umask 077
mkdir -p "$FISH_PROJECT_ROOT/runtime/tmp" "$FISH_PROJECT_ROOT/runtime/cache/npm" "$FISH_PROJECT_ROOT/runtime/logs"
export TMPDIR="$FISH_PROJECT_ROOT/runtime/tmp" TMP="$FISH_PROJECT_ROOT/runtime/tmp" TEMP="$FISH_PROJECT_ROOT/runtime/tmp"
export XDG_CACHE_HOME="$FISH_PROJECT_ROOT/runtime/cache" npm_config_cache="$FISH_PROJECT_ROOT/runtime/cache/npm"
fish_npm() {
  if [[ -n "${FISH_NPM_CLI:-}" ]]; then
    "$FISH_NODE_BIN" "$FISH_NPM_CLI" "$@"
  elif command -v npm >/dev/null 2>&1; then
    npm "$@"
  else
    echo '未找到 npm。请使用包含 npm 的 Node 发行包，或用 FISH_NPM_CLI 指定本地 npm-cli.js。' >&2
    return 1
  fi
}
