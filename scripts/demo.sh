#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:8080}"
COUNT="${COUNT:-100}"
CONCURRENCY="${CONCURRENCY:-5}"
SIZES="${SIZES:-64,256}"
RECORD="${RECORD:-demo_runs/run.json}"
DB_DOWN_SECS="${DB_DOWN_SECS:-45}"

mkdir -p "$(dirname "$RECORD")"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# ------------------------------------------------------------------
# Phase 1 — baseline load (ramp up for ~30s before incident)
# ------------------------------------------------------------------
log "starting loadgen: count=$COUNT concurrency=$CONCURRENCY sizes=$SIZES"
node ./node_modules/.bin/tsx scripts/loadgen.ts \
  --api "$API_URL" \
  --count "$COUNT" \
  --concurrency "$CONCURRENCY" \
  --sizes "$SIZES" \
  --record "$RECORD" &

LOADGEN_PID=$!

sleep 30
log "baseline phase complete – injecting db-down incident for ${DB_DOWN_SECS}s"

# ------------------------------------------------------------------
# Phase 2 — DB outage (loadgen keeps running → 5xx / timeouts pile up)
# ------------------------------------------------------------------
docker compose pause postgres
sleep "$DB_DOWN_SECS"

# ------------------------------------------------------------------
# Phase 3 — recovery (unpause, loadgen still running → backlog drains)
# ------------------------------------------------------------------
log "restoring postgres"
docker compose unpause postgres

wait "$LOADGEN_PID" || true
log "demo complete. run saved to $RECORD"
