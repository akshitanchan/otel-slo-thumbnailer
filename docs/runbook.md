# Runbook: DB Down Incident

This is by far the most common failure mode in this system. When Postgres goes
away, both the API and worker detect it within ~2 seconds via the readiness loop
and start returning 503s. The worker stops claiming jobs. Everything is designed
to recover automatically once the DB comes back.

## What you'll see

- `thumbnailer_ready` or `worker_ready` drops to 0
- API 5xx rate spikes (the POST endpoint short-circuits with 503)
- Queue depth flatlines (worker can't claim)
- ThumbnailerApiNotReady, ThumbnailerWorkerNotReady, and ThumbnailerApiHigh5xxRate alerts fire
- If it lasts long enough: ThumbnailerLatencySLOFastBurn and ThumbnailerJobLatencySLOFastBurn too

Open the **Thumbnailer Overview** dashboard in Grafana — the readiness panel
and 5xx rate panel are the two to watch.

## Confirm

```bash
docker compose ps          # is postgres healthy?
curl localhost:8080/readyz  # expect {"ok":false} / 503
curl localhost:8081/readyz  # same for worker
```

## Fix it

```bash
docker compose up -d postgres
```

If the container is running but the app still isn't ready after 10s, restart
the services: `docker compose restart api worker`

## Verify recovery

- `thumbnailer_ready` and `worker_ready` back to 1
- 5xx rate drops to baseline
- Queue depth starts decreasing (worker drains the backlog)

## Lessons from the demo runs

During the first demo we noticed that jobs enqueued right before the outage
get stuck in `processing` state because the worker crashes mid-job. The retry
logic picks them back up after the backoff window, but it means p95 latency
stays elevated for a while after recovery. Something to keep in mind if we
ever add tighter latency SLOs.
