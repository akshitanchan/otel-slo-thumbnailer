#!/usr/bin/env bash
set -euo pipefail

API_METRICS_URL="${API_METRICS_URL:-http://localhost:8080/metrics}"
WARMUP_SECONDS="${WARMUP_SECONDS:-5}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-60}"

log() { echo "$*"; }

metric_ready() {
  # returns: 0, 1, or empty if cannot parse (treat as not ready)
  curl -fsS --max-time 1 "$API_METRICS_URL" \
    | awk '/^thumbnailer_ready\{service="api"\}/ {print $2; exit}'
}

wait_for_ready_value() {
  local want="$1"
  local start_ts end_ts now v
  start_ts="$(date +%s)"
  end_ts="$((start_ts + TIMEOUT_SECONDS))"

  while true; do
    now="$(date +%s)"
    if (( now >= end_ts )); then
      log "timeout waiting for thumbnailer_ready=$want (last seen: ${v:-<none>})"
      exit 1
    fi

    v="$(metric_ready || true)"
    if [[ "$v" == "$want" ]]; then
      log "ok: thumbnailer_ready flipped to $want"
      return 0
    fi

    sleep 0.2
  done
}

log "start: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "warming traffic for ${WARMUP_SECONDS}s..."
sleep "$WARMUP_SECONDS"

log "killing postgres..."
docker compose stop postgres

log "waiting for thumbnailer_ready to flip to 0..."
wait_for_ready_value "0"

log "starting postgres..."
docker compose up -d postgres

log "waiting for thumbnailer_ready to flip back to 1..."
wait_for_ready_value "1"

log "done"
