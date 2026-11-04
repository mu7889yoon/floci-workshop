#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node --test test/*.test.mjs
node --check control/handler.mjs
node --check control/aws-runtime.mjs
node --check control/reaper.mjs
node --check control/reaper-core.mjs
node --check microvm/server.mjs
bash -n scripts/create-microvm-image.sh scripts/deploy.sh scripts/verify.sh
if command -v terraform >/dev/null; then
  terraform fmt -check -recursive infra
fi

echo "Local verification passed. This does not deploy AWS resources or run the Floci integration tests."
