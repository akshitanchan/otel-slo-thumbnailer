#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:8080}"
COUNT="${COUNT:-100}"
CONCURRENCY="${CONCURRENCY:-5}"
SIZES="${SIZES:-64,256}"
RECORD="${RECORD:-demo_runs/run.json}"

mkdir -p "$(dirname "$RECORD")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

log "starting loadgen: count=$COUNT concurrency=$CONCURRENCY sizes=$SIZES"
node ./node_modules/.bin/tsx scripts/loadgen.ts \
  --api "$API_URL" \
  --count "$COUNT" \
  --concurrency "$CONCURRENCY" \
  --sizes "$SIZES" \
  --record "$RECORD" &

LOADGEN_PID=$!

sleep 5
log "injecting db down incident"
WARMUP_SECONDS=0 scripts/chaos-db-down.sh || true

wait "$LOADGEN_PID"
log "demo complete. run saved to $RECORD"
