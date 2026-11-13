#!/usr/bin/env bash
# Starts the REAL Worker on http://127.0.0.1:${L1_E2E_WORKER_PORT:-8791} (8787 is the AIW status page on aiw-k8) against a fresh local D1/R2/KV (.wrangler/e2e). Playwright owns the
# process: this script `exec`s wrangler so the PID Playwright signals is the server itself (no name-based killing anywhere).
set -euo pipefail
cd "$(dirname "$0")/../../.."
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/tmp/wcfg}"
export WRANGLER_SEND_METRICS=false CI=1
STATE=.wrangler/e2e
rm -rf "$STATE"
mkdir -p "$STATE"
npx wrangler d1 migrations apply l1-builder --local --config worker/wrangler.toml --persist-to "$STATE"
exec npx wrangler dev --config worker/wrangler.toml --local --port "${L1_E2E_WORKER_PORT:-8791}" --ip 127.0.0.1 --persist-to "$STATE" \
  --var ENVIRONMENT:development --var AUTH_MODE:test --var "PUBLIC_ORIGIN:http://127.0.0.1:${L1_E2E_VITE_PORT:-5183}"
