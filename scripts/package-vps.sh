#!/usr/bin/env bash
# Reuse the existing, already-built installation; never downloads or rebuilds.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
umask 077
test -f dist/src/cli.js
test -x runtime/tools/node/bin/node
mkdir -p runtime/deployment
tar -czf runtime/deployment/deepseekfish-release.tar.gz \
  --exclude='config/local.json' --exclude='*.log' \
  AGENTS.md README.md package.json package-lock.json tsconfig.json .npmrc \
  start.sh start.bat .env.example src dist scripts deploy docs config/example.json config/onebot.example.json prompts personas assets node_modules runtime/tools/node
cd runtime/deployment
sha256sum deepseekfish-release.tar.gz > deepseekfish-release.sha256
echo 'Prepared existing build only; no credentials, databases, tokens, or workspaces included.'
