# Runbook: DB Down Incident

## Summary
When Postgres is unavailable, the API and worker should fail fast and surface clear alerts. This runbook describes how to confirm the incident, mitigate, and verify recovery.

## Symptoms
- Elevated API 5xx rate.
- `thumbnailer_ready` or `worker_ready` is 0.
- Increased queue depth.
- Job latency SLO burn.

## Alerts
- **ThumbnailerApiNotReady**
- **ThumbnailerWorkerNotReady**
- **ThumbnailerApiHigh5xxRate**
- **ThumbnailerLatencySLOFastBurn**
- **ThumbnailerJobLatencySLOFastBurn**

## Dashboards to Check
Grafana: Thumbnailer Overview
- API RPS
- API Latency (p50/p95/p99)
- API 5xx Rate
- Readiness
- Queue Depth
- Job End-to-End Latency
- DB Query Latency p95

## Confirm the Incident
1. Check Postgres container health:
   - `docker compose ps`
2. Confirm readiness metrics:
   - `thumbnailer_ready == 0` and/or `worker_ready == 0`
3. Confirm error spike:
   - API 5xx rate > 5%

## Immediate Mitigation
1. Restore Postgres:
   - `docker compose up -d postgres`
2. If container is healthy but app is not ready:
   - Restart api/worker:
     - `docker compose restart api worker`

## Recovery Verification
1. Readiness returns to 1:
   - `thumbnailer_ready == 1`
   - `worker_ready == 1`
2. API 5xx rate returns to baseline.
3. Queue depth decreases over time.
4. Job latency returns to normal range.

## Post-Incident Notes
- Capture a screenshot of the dashboard for the demo.
- Record the demo run output in demo_runs/run.json for replay.
