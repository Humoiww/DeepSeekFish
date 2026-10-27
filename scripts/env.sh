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
fish_node_ready() {
  [[ -n "$FISH_NODE_BIN" && -x "$FISH_NODE_BIN" ]] &&
    "$FISH_NODE_BIN" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>24||major===24&&minor>=9?0:1)' >/dev/null 2>&1
}
if ! fish_node_ready; then
  if [[ -n "${FISH_NODE:-}" ]]; then
    echo 'FISH_NODE 指定的程序不可执行或版本过旧，需要 Node >=24.9。请修正该变量，或 unset FISH_NODE 后重试。' >&2
    exit 1
  fi
  if ! command -v python3 >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    echo '需要 Node >=24.9；自动准备需要 Python 3 和 tar。也可手动解压官方便携包到 runtime/tools/node/。' >&2
    exit 1
  fi
  python3 "$FISH_PROJECT_ROOT/scripts/bootstrap-node.py" || exit 1
  FISH_NODE_BIN="$FISH_PROJECT_ROOT/runtime/tools/node/bin/node"
  if ! fish_node_ready; then
    echo '项目 Node 仍无法运行，请检查主机是否符合官方 Node Linux 运行要求。' >&2
    exit 1
  fi
fi
unset -f fish_node_ready
export PATH="$(dirname -- "$FISH_NODE_BIN"):$PATH"
umask 077
mkdir -p "$FISH_PROJECT_ROOT/runtime/tmp" "$FISH_PROJECT_ROOT/runtime/cache/npm" "$FISH_PROJECT_ROOT/runtime/logs"
export TMPDIR="$FISH_PROJECT_ROOT/runtime/tmp" TMP="$FISH_PROJECT_ROOT/runtime/tmp" TEMP="$FISH_PROJECT_ROOT/runtime/tmp"
export XDG_CACHE_HOME="$FISH_PROJECT_ROOT/runtime/cache" npm_config_cache="$FISH_PROJECT_ROOT/runtime/cache/npm"
fish_npm() {
  if [[ -n "${FISH_NPM_CLI:-}" ]]; then
    "$FISH_NODE_BIN" "$FISH_NPM_CLI" "$@"
  elif [[ -f "$(dirname -- "$FISH_NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js" ]]; then
    "$FISH_NODE_BIN" "$(dirname -- "$FISH_NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js" "$@"
  elif command -v npm >/dev/null 2>&1; then
    npm "$@"
  else
    echo '未找到 npm。请使用包含 npm 的 Node 发行包，或用 FISH_NPM_CLI 指定本地 npm-cli.js。' >&2
    return 1
  fi
}
