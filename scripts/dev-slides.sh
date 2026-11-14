#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINNED_NODE_VERSION="$(cat "$ROOT/.node-version")"

if command -v nodenv >/dev/null 2>&1; then
  NODENV_NODE_BIN="$(nodenv root)/versions/$PINNED_NODE_VERSION/bin"
  if [[ -x "$NODENV_NODE_BIN/node" ]]; then
    PATH="$NODENV_NODE_BIN:$PATH"
    export PATH
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js $PINNED_NODE_VERSION and npm are required to preview the slides." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 24 )); then
  echo "Node.js 24 or newer is required. Found $(node --version)." >&2
  exit 1
fi

if [[ ! -x "$ROOT/slides/node_modules/.bin/slidev" ]]; then
  npm --prefix "$ROOT/slides" ci
fi

cd "$ROOT/slides"
exec npm run dev -- "$@"
