#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:8080}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

log "starting docker compose..."
docker compose up -d --build

log "waiting for api ready..."
for i in {1..60}; do
  if curl -fsS --max-time 1 "$API_URL/readyz" | grep -q '"ok":true'; then
    break
  fi
  sleep 1
  if [[ $i -eq 60 ]]; then
    log "api did not become ready"
    exit 1
  fi
done

log "running loadgen strict (1 request)..."
node ./node_modules/.bin/tsx scripts/loadgen.ts --api "$API_URL" --count 1 --concurrency 1 --sizes 64 --strict true

log "integration test passed"
