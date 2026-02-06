#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:8080}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

SAMPLE_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+5l9cAAAAASUVORK5CYII="

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

log "stopping postgres..."
docker compose stop postgres

log "waiting for api readiness to flip (expect 503)..."
for i in {1..60}; do
  STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_URL/readyz" || true)
  if [[ "$STATUS" == "503" ]]; then
    break
  fi
  sleep 0.2
  if [[ $i -eq 60 ]]; then
    log "api did not report not-ready"
    exit 1
  fi
done

log "issuing request while db is down (expect 503)..."
TMPFILE="/tmp/sample-thumbnail.png"
echo "$SAMPLE_B64" | base64 -d > "$TMPFILE"

STATUS=$(curl -sS -o /dev/null -w "%{http_code}" -F "file=@${TMPFILE}" "$API_URL/v1/thumbnails?sizes=64" || true)
if [[ "$STATUS" != "503" ]]; then
  log "expected 503, got $STATUS"
  exit 1
fi

log "restarting postgres..."
docker compose up -d postgres

log "waiting for api ready after recovery..."
for i in {1..60}; do
  if curl -fsS --max-time 1 "$API_URL/readyz" | grep -q '"ok":true'; then
    break
  fi
  sleep 1
  if [[ $i -eq 60 ]]; then
    log "api did not recover"
    exit 1
  fi
done

log "chaos test passed"
