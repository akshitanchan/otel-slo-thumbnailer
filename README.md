# Observability-First Image Thumbnailer

Microservice demo with API + worker + Postgres, fully instrumented with OpenTelemetry, Prometheus, Grafana, and Jaeger. Includes a demo script that injects a DB-down incident and captures a replayable run. Implementation is in TypeScript/Node.

## Quickstart

```bash
docker compose up -d --build
```

Open:
- Grafana: http://localhost:3000 (admin/admin)
- Prometheus: http://localhost:9090
- Jaeger: http://localhost:16686

## Demo

```bash
npm run demo
```

This will:
- Send 100 requests
- Inject a DB-down incident
- Recover and write a run record to demo_runs/run.json

To replay a run:

```bash
npm run loadgen -- --replay demo_runs/run.json
```

## Endpoints

- `POST /v1/thumbnails` (multipart upload)
- `GET /v1/jobs/:id`
- `GET /v1/thumbnails/:id/:size`
- `GET /healthz` / `GET /readyz` / `GET /metrics`

## SLOs

- API enqueue latency: 99% under 300ms
- End-to-end job latency: p95 under 5s

## Runbook

See docs/runbook.md

## Tests

```bash
npm test
npm run test:integration
npm run test:chaos
```

## Makefile

For convenience:

```bash
make up
make demo
make chaos-dbdown
make test
make lint
```
