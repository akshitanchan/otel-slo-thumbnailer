#!/usr/bin/env bash
#
# Runs a full incident simulation: baseline traffic, DB outage, recovery.
# Useful for showing the Grafana dashboard during a live demo — the run
# is saved to demo_runs/run.json so you can replay it later with the
# same timing.
#
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
# Baseline — send traffic for ~30s before we break anything
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
# Outage — pause postgres so connections hang then timeout
# ------------------------------------------------------------------
docker compose pause postgres
sleep "$DB_DOWN_SECS"

# ------------------------------------------------------------------
# Recovery — unpause and let the worker drain the backlog
# ------------------------------------------------------------------
log "restoring postgres"
docker compose unpause postgres

wait "$LOADGEN_PID" || true
log "demo complete. run saved to $RECORD"
