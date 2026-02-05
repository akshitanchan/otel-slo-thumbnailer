

# ===== db/migrations/001_init.sql =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  idempotency_key TEXT NULL,

  input_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sizes JSONB NOT NULL,

  status job_status NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  traceparent TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idem_key_uniq
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outputs (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  size INT NOT NULL,
  output_path TEXT NOT NULL,
  bytes INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'jpeg',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(job_id, size)
);

CREATE INDEX IF NOT EXISTS outputs_job_id_idx
  ON outputs (job_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;

CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


# ===== docker-compose.yml =====

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: thumbnailer
    ports:
      - "5432:5432"
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
      - ./.data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d thumbnailer"]
      interval: 2s
      timeout: 2s
      retries: 20

  jaeger:
    image: jaegertracing/all-in-one:1.55
    ports:
      - "16686:16686"   # ui
      - "4317:4317"     # otlp grpc ingest
      - "4318:4318"     # otlp http ingest
    environment:
      COLLECTOR_OTLP_ENABLED: "true"

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.142.0
    command: ["--config=/etc/otel-collector.yaml"]
    volumes:
      - ./docker/otel/otel-collector.yaml:/etc/otel-collector.yaml:ro
      - ./docker/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro

    ports:
      - "4319:4317"   # expose collector grpc on host:4319 (optional)
      - "4320:4318"   # expose collector http on host:4320 (optional)
    depends_on:
      - jaeger

  prometheus:
    image: prom/prometheus:v2.51.0
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:11.3.0
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_USERS_DEFAULT_THEME: light
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./docker/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus

  migrate:
    build:
      context: .
      dockerfile: services/migrate/Dockerfile
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      MIGRATIONS_DIR: /app/db/migrations
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      dockerfile: services/api/Dockerfile
    environment:
      PORT: "8080"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-api
    volumes:
      - thumb_data:/data
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started

  worker:
    build:
      context: .
      dockerfile: services/worker/Dockerfile
    environment:
      PORT: "8081"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      POLL_MS: "200"
      CLAIM_BACKOFF_MS: "500"
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-worker
    volumes:
      - thumb_data:/data
    ports:
      - "8081:8081"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started
      api:
        condition: service_started

volumes:
  grafana_data:
  thumb_data:


# ===== docker/grafana/dashboards/thumbnailer-overview.json =====

{
  "annotations": { "list": [] },
  "editable": false,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [],
  "refresh": "5s",
  "schemaVersion": 39,
  "tags": ["thumbnailer"],
  "templating": { "list": [] },
  "time": { "from": "now-15m", "to": "now" },
  "timepicker": {},
  "timezone": "browser",
  "title": "thumbnailer overview",
  "uid": "thumbnailer-overview",
  "version": 1
}


# ===== docker/grafana/provisioning/dashboards/dashboards.yml =====

apiVersion: 1

providers:
  - name: "default"
    orgId: 1
    folder: ""
    type: file
    disableDeletion: true
    editable: false
    options:
      path: /var/lib/grafana/dashboards


# ===== docker/grafana/provisioning/datasources/datasources.yml =====

apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true


# ===== docker/otel/otel-collector.yaml =====

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]



# ===== docker/prometheus/alerts.yml =====

groups:
  - name: thumbnailer.rules
    interval: 15s
    rules:
      - alert: ThumbnailerApiDown
        expr: up{job="thumbnailer_api"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is down"
          description: "prometheus cannot scrape thumbnailer api /metrics for 30s"

      - alert: ThumbnailerWorkerDown
        expr: up{job="thumbnailer_worker"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is down"
          description: "prometheus cannot scrape thumbnailer worker /metrics for 30s"

      # db health as seen by app readiness probes
      - alert: ThumbnailerApiNotReady
        expr: thumbnailer_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is not ready"
          description: "api /readyz reports not ready for 30s (commonly db down)"

      - alert: ThumbnailerWorkerNotReady
        expr: worker_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is not ready"
          description: "worker /readyz reports not ready for 30s (commonly db down)"

      # high 5xx rate (fast signal during failures)
      - alert: ThumbnailerApiHigh5xxRate
        expr: |
          (
            sum(rate(http_requests_total{service="api",status_code=~"5.."}[2m]))
            /
            sum(rate(http_requests_total{service="api"}[2m]))
          ) > 0.05
        for: 2m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "api 5xx rate > 5% (2m)"
          description: "api is returning elevated 5xx responses"

      # latency slo: 99% under 300ms
      # we alert on a "fast burn" using error budget style:
      # good = under 0.3s, bad = >= 0.3s
      - alert: ThumbnailerLatencySLOFastBurn
        expr: |
          (
            sum(rate(http_request_duration_seconds_bucket{service="api",route="POST /v1/thumbnails",le="0.3"}[5m]))
            /
            sum(rate(http_request_duration_seconds_count{service="api",route="POST /v1/thumbnails"}[5m]))
          ) < 0.99
        for: 5m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "latency slo burn (fast)"
          description: "less than 99% of POST /v1/thumbnails requests are under 300ms over 5m"


# ===== docker/prometheus/prometheus.yml =====

global:
  scrape_interval: 5s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["prometheus:9090"]
  - job_name: thumbnailer_api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:8080"]
  - job_name: thumbnailer_worker
    metrics_path: /metrics
    static_configs:
      - targets: ["worker:8081"]

rule_files:
  - /etc/prometheus/alerts.yml


# ===== dump.md =====



# ===== db/migrations/001_init.sql =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  idempotency_key TEXT NULL,

  input_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sizes JSONB NOT NULL,

  status job_status NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  traceparent TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idem_key_uniq
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outputs (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  size INT NOT NULL,
  output_path TEXT NOT NULL,
  bytes INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'jpeg',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(job_id, size)
);

CREATE INDEX IF NOT EXISTS outputs_job_id_idx
  ON outputs (job_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;

CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


# ===== docker-compose.yml =====

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: thumbnailer
    ports:
      - "5432:5432"
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
      - ./.data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d thumbnailer"]
      interval: 2s
      timeout: 2s
      retries: 20

  jaeger:
    image: jaegertracing/all-in-one:1.55
    ports:
      - "16686:16686"   # ui
      - "4317:4317"     # otlp grpc ingest
      - "4318:4318"     # otlp http ingest
    environment:
      COLLECTOR_OTLP_ENABLED: "true"

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.142.0
    command: ["--config=/etc/otel-collector.yaml"]
    volumes:
      - ./docker/otel/otel-collector.yaml:/etc/otel-collector.yaml:ro
      - ./docker/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro

    ports:
      - "4319:4317"   # expose collector grpc on host:4319 (optional)
      - "4320:4318"   # expose collector http on host:4320 (optional)
    depends_on:
      - jaeger

  prometheus:
    image: prom/prometheus:v2.51.0
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:11.3.0
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_USERS_DEFAULT_THEME: light
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./docker/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus

  migrate:
    build:
      context: .
      dockerfile: services/migrate/Dockerfile
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      MIGRATIONS_DIR: /app/db/migrations
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      dockerfile: services/api/Dockerfile
    environment:
      PORT: "8080"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-api
    volumes:
      - thumb_data:/data
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started

  worker:
    build:
      context: .
      dockerfile: services/worker/Dockerfile
    environment:
      PORT: "8081"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      POLL_MS: "200"
      CLAIM_BACKOFF_MS: "500"
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-worker
    volumes:
      - thumb_data:/data
    ports:
      - "8081:8081"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started
      api:
        condition: service_started

volumes:
  grafana_data:
  thumb_data:


# ===== docker/grafana/dashboards/thumbnailer-overview.json =====

{
  "annotations": { "list": [] },
  "editable": false,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [],
  "refresh": "5s",
  "schemaVersion": 39,
  "tags": ["thumbnailer"],
  "templating": { "list": [] },
  "time": { "from": "now-15m", "to": "now" },
  "timepicker": {},
  "timezone": "browser",
  "title": "thumbnailer overview",
  "uid": "thumbnailer-overview",
  "version": 1
}


# ===== docker/grafana/provisioning/dashboards/dashboards.yml =====

apiVersion: 1

providers:
  - name: "default"
    orgId: 1
    folder: ""
    type: file
    disableDeletion: true
    editable: false
    options:
      path: /var/lib/grafana/dashboards


# ===== docker/grafana/provisioning/datasources/datasources.yml =====

apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true


# ===== docker/otel/otel-collector.yaml =====

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]



# ===== docker/prometheus/alerts.yml =====

groups:
  - name: thumbnailer.rules
    interval: 15s
    rules:
      - alert: ThumbnailerApiDown
        expr: up{job="thumbnailer_api"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is down"
          description: "prometheus cannot scrape thumbnailer api /metrics for 30s"

      - alert: ThumbnailerWorkerDown
        expr: up{job="thumbnailer_worker"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is down"
          description: "prometheus cannot scrape thumbnailer worker /metrics for 30s"

      # db health as seen by app readiness probes
      - alert: ThumbnailerApiNotReady
        expr: thumbnailer_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is not ready"
          description: "api /readyz reports not ready for 30s (commonly db down)"

      - alert: ThumbnailerWorkerNotReady
        expr: worker_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is not ready"
          description: "worker /readyz reports not ready for 30s (commonly db down)"

      # high 5xx rate (fast signal during failures)
      - alert: ThumbnailerApiHigh5xxRate
        expr: |
          (
            sum(rate(http_requests_total{service="api",status_code=~"5.."}[2m]))
            /
            sum(rate(http_requests_total{service="api"}[2m]))
          ) > 0.05
        for: 2m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "api 5xx rate > 5% (2m)"
          description: "api is returning elevated 5xx responses"

      # latency slo: 99% under 300ms
      # we alert on a "fast burn" using error budget style:
      # good = under 0.3s, bad = >= 0.3s
      - alert: ThumbnailerLatencySLOFastBurn
        expr: |
          (
            sum(rate(http_request_duration_seconds_bucket{service="api",route="POST /v1/thumbnails",le="0.3"}[5m]))
            /
            sum(rate(http_request_duration_seconds_count{service="api",route="POST /v1/thumbnails"}[5m]))
          ) < 0.99
        for: 5m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "latency slo burn (fast)"
          description: "less than 99% of POST /v1/thumbnails requests are under 300ms over 5m"


# ===== docker/prometheus/prometheus.yml =====

global:
  scrape_interval: 5s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["prometheus:9090"]
  - job_name: thumbnailer_api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:8080"]
  - job_name: thumbnailer_worker
    metrics_path: /metrics
    static_configs:
      - targets: ["worker:8081"]

rule_files:
  - /etc/prometheus/alerts.yml


# ===== dump.md =====



# ===== db/migrations/001_init.sql =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  idempotency_key TEXT NULL,

  input_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sizes JSONB NOT NULL,

  status job_status NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  traceparent TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idem_key_uniq
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outputs (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  size INT NOT NULL,
  output_path TEXT NOT NULL,
  bytes INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'jpeg',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(job_id, size)
);

CREATE INDEX IF NOT EXISTS outputs_job_id_idx
  ON outputs (job_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;

CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


# ===== docker-compose.yml =====

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: thumbnailer
    ports:
      - "5432:5432"
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
      - ./.data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d thumbnailer"]
      interval: 2s
      timeout: 2s
      retries: 20

  jaeger:
    image: jaegertracing/all-in-one:1.55
    ports:
      - "16686:16686"   # ui
      - "4317:4317"     # otlp grpc ingest
      - "4318:4318"     # otlp http ingest
    environment:
      COLLECTOR_OTLP_ENABLED: "true"

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.142.0
    command: ["--config=/etc/otel-collector.yaml"]
    volumes:
      - ./docker/otel/otel-collector.yaml:/etc/otel-collector.yaml:ro
      - ./docker/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro

    ports:
      - "4319:4317"   # expose collector grpc on host:4319 (optional)
      - "4320:4318"   # expose collector http on host:4320 (optional)
    depends_on:
      - jaeger

  prometheus:
    image: prom/prometheus:v2.51.0
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:11.3.0
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_USERS_DEFAULT_THEME: light
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./docker/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus

  migrate:
    build:
      context: .
      dockerfile: services/migrate/Dockerfile
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      MIGRATIONS_DIR: /app/db/migrations
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      dockerfile: services/api/Dockerfile
    environment:
      PORT: "8080"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-api
    volumes:
      - thumb_data:/data
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started

  worker:
    build:
      context: .
      dockerfile: services/worker/Dockerfile
    environment:
      PORT: "8081"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      POLL_MS: "200"
      CLAIM_BACKOFF_MS: "500"
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-worker
    volumes:
      - thumb_data:/data
    ports:
      - "8081:8081"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started
      api:
        condition: service_started

volumes:
  grafana_data:
  thumb_data:


# ===== docker/grafana/dashboards/thumbnailer-overview.json =====

{
  "annotations": { "list": [] },
  "editable": false,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [],
  "refresh": "5s",
  "schemaVersion": 39,
  "tags": ["thumbnailer"],
  "templating": { "list": [] },
  "time": { "from": "now-15m", "to": "now" },
  "timepicker": {},
  "timezone": "browser",
  "title": "thumbnailer overview",
  "uid": "thumbnailer-overview",
  "version": 1
}


# ===== docker/grafana/provisioning/dashboards/dashboards.yml =====

apiVersion: 1

providers:
  - name: "default"
    orgId: 1
    folder: ""
    type: file
    disableDeletion: true
    editable: false
    options:
      path: /var/lib/grafana/dashboards


# ===== docker/grafana/provisioning/datasources/datasources.yml =====

apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true


# ===== docker/otel/otel-collector.yaml =====

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]



# ===== docker/prometheus/alerts.yml =====

groups:
  - name: thumbnailer.rules
    interval: 15s
    rules:
      - alert: ThumbnailerApiDown
        expr: up{job="thumbnailer_api"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is down"
          description: "prometheus cannot scrape thumbnailer api /metrics for 30s"

      - alert: ThumbnailerWorkerDown
        expr: up{job="thumbnailer_worker"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is down"
          description: "prometheus cannot scrape thumbnailer worker /metrics for 30s"

      # db health as seen by app readiness probes
      - alert: ThumbnailerApiNotReady
        expr: thumbnailer_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is not ready"
          description: "api /readyz reports not ready for 30s (commonly db down)"

      - alert: ThumbnailerWorkerNotReady
        expr: worker_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is not ready"
          description: "worker /readyz reports not ready for 30s (commonly db down)"

      # high 5xx rate (fast signal during failures)
      - alert: ThumbnailerApiHigh5xxRate
        expr: |
          (
            sum(rate(http_requests_total{service="api",status_code=~"5.."}[2m]))
            /
            sum(rate(http_requests_total{service="api"}[2m]))
          ) > 0.05
        for: 2m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "api 5xx rate > 5% (2m)"
          description: "api is returning elevated 5xx responses"

      # latency slo: 99% under 300ms
      # we alert on a "fast burn" using error budget style:
      # good = under 0.3s, bad = >= 0.3s
      - alert: ThumbnailerLatencySLOFastBurn
        expr: |
          (
            sum(rate(http_request_duration_seconds_bucket{service="api",route="POST /v1/thumbnails",le="0.3"}[5m]))
            /
            sum(rate(http_request_duration_seconds_count{service="api",route="POST /v1/thumbnails"}[5m]))
          ) < 0.99
        for: 5m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "latency slo burn (fast)"
          description: "less than 99% of POST /v1/thumbnails requests are under 300ms over 5m"


# ===== docker/prometheus/prometheus.yml =====

global:
  scrape_interval: 5s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["prometheus:9090"]
  - job_name: thumbnailer_api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:8080"]
  - job_name: thumbnailer_worker
    metrics_path: /metrics
    static_configs:
      - targets: ["worker:8081"]

rule_files:
  - /etc/prometheus/alerts.yml


# ===== dump.md =====



# ===== db/migrations/001_init.sql =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  idempotency_key TEXT NULL,

  input_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sizes JSONB NOT NULL,

  status job_status NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  traceparent TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idem_key_uniq
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outputs (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  size INT NOT NULL,
  output_path TEXT NOT NULL,
  bytes INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'jpeg',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(job_id, size)
);

CREATE INDEX IF NOT EXISTS outputs_job_id_idx
  ON outputs (job_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;

CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


# ===== docker-compose.yml =====

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: thumbnailer
    ports:
      - "5432:5432"
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
      - ./.data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d thumbnailer"]
      interval: 2s
      timeout: 2s
      retries: 20

  jaeger:
    image: jaegertracing/all-in-one:1.55
    ports:
      - "16686:16686"   # ui
      - "4317:4317"     # otlp grpc ingest
      - "4318:4318"     # otlp http ingest
    environment:
      COLLECTOR_OTLP_ENABLED: "true"

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.142.0
    command: ["--config=/etc/otel-collector.yaml"]
    volumes:
      - ./docker/otel/otel-collector.yaml:/etc/otel-collector.yaml:ro
      - ./docker/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro

    ports:
      - "4319:4317"   # expose collector grpc on host:4319 (optional)
      - "4320:4318"   # expose collector http on host:4320 (optional)
    depends_on:
      - jaeger

  prometheus:
    image: prom/prometheus:v2.51.0
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:11.3.0
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_USERS_DEFAULT_THEME: light
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./docker/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus

  migrate:
    build:
      context: .
      dockerfile: services/migrate/Dockerfile
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      MIGRATIONS_DIR: /app/db/migrations
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      dockerfile: services/api/Dockerfile
    environment:
      PORT: "8080"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-api
    volumes:
      - thumb_data:/data
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started

  worker:
    build:
      context: .
      dockerfile: services/worker/Dockerfile
    environment:
      PORT: "8081"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      POLL_MS: "200"
      CLAIM_BACKOFF_MS: "500"
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-worker
    volumes:
      - thumb_data:/data
    ports:
      - "8081:8081"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started
      api:
        condition: service_started

volumes:
  grafana_data:
  thumb_data:


# ===== docker/grafana/dashboards/thumbnailer-overview.json =====

{
  "annotations": { "list": [] },
  "editable": false,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [],
  "refresh": "5s",
  "schemaVersion": 39,
  "tags": ["thumbnailer"],
  "templating": { "list": [] },
  "time": { "from": "now-15m", "to": "now" },
  "timepicker": {},
  "timezone": "browser",
  "title": "thumbnailer overview",
  "uid": "thumbnailer-overview",
  "version": 1
}


# ===== docker/grafana/provisioning/dashboards/dashboards.yml =====

apiVersion: 1

providers:
  - name: "default"
    orgId: 1
    folder: ""
    type: file
    disableDeletion: true
    editable: false
    options:
      path: /var/lib/grafana/dashboards


# ===== docker/grafana/provisioning/datasources/datasources.yml =====

apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true


# ===== docker/otel/otel-collector.yaml =====

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]



# ===== docker/prometheus/alerts.yml =====

groups:
  - name: thumbnailer.rules
    interval: 15s
    rules:
      - alert: ThumbnailerApiDown
        expr: up{job="thumbnailer_api"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is down"
          description: "prometheus cannot scrape thumbnailer api /metrics for 30s"

      - alert: ThumbnailerWorkerDown
        expr: up{job="thumbnailer_worker"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is down"
          description: "prometheus cannot scrape thumbnailer worker /metrics for 30s"

      # db health as seen by app readiness probes
      - alert: ThumbnailerApiNotReady
        expr: thumbnailer_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is not ready"
          description: "api /readyz reports not ready for 30s (commonly db down)"

      - alert: ThumbnailerWorkerNotReady
        expr: worker_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is not ready"
          description: "worker /readyz reports not ready for 30s (commonly db down)"

      # high 5xx rate (fast signal during failures)
      - alert: ThumbnailerApiHigh5xxRate
        expr: |
          (
            sum(rate(http_requests_total{service="api",status_code=~"5.."}[2m]))
            /
            sum(rate(http_requests_total{service="api"}[2m]))
          ) > 0.05
        for: 2m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "api 5xx rate > 5% (2m)"
          description: "api is returning elevated 5xx responses"

      # latency slo: 99% under 300ms
      # we alert on a "fast burn" using error budget style:
      # good = under 0.3s, bad = >= 0.3s
      - alert: ThumbnailerLatencySLOFastBurn
        expr: |
          (
            sum(rate(http_request_duration_seconds_bucket{service="api",route="POST /v1/thumbnails",le="0.3"}[5m]))
            /
            sum(rate(http_request_duration_seconds_count{service="api",route="POST /v1/thumbnails"}[5m]))
          ) < 0.99
        for: 5m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "latency slo burn (fast)"
          description: "less than 99% of POST /v1/thumbnails requests are under 300ms over 5m"


# ===== docker/prometheus/prometheus.yml =====

global:
  scrape_interval: 5s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["prometheus:9090"]
  - job_name: thumbnailer_api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:8080"]
  - job_name: thumbnailer_worker
    metrics_path: /metrics
    static_configs:
      - targets: ["worker:8081"]

rule_files:
  - /etc/prometheus/alerts.yml


# ===== dump.md =====



# ===== db/migrations/001_init.sql =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  idempotency_key TEXT NULL,

  input_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sizes JSONB NOT NULL,

  status job_status NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  traceparent TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idem_key_uniq
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outputs (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  size INT NOT NULL,
  output_path TEXT NOT NULL,
  bytes INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'jpeg',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(job_id, size)
);

CREATE INDEX IF NOT EXISTS outputs_job_id_idx
  ON outputs (job_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;

CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


# ===== docker-compose.yml =====

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: thumbnailer
    ports:
      - "5432:5432"
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
      - ./.data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d thumbnailer"]
      interval: 2s
      timeout: 2s
      retries: 20

  jaeger:
    image: jaegertracing/all-in-one:1.55
    ports:
      - "16686:16686"   # ui
      - "4317:4317"     # otlp grpc ingest
      - "4318:4318"     # otlp http ingest
    environment:
      COLLECTOR_OTLP_ENABLED: "true"

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.142.0
    command: ["--config=/etc/otel-collector.yaml"]
    volumes:
      - ./docker/otel/otel-collector.yaml:/etc/otel-collector.yaml:ro
      - ./docker/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro

    ports:
      - "4319:4317"   # expose collector grpc on host:4319 (optional)
      - "4320:4318"   # expose collector http on host:4320 (optional)
    depends_on:
      - jaeger

  prometheus:
    image: prom/prometheus:v2.51.0
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:11.3.0
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_USERS_DEFAULT_THEME: light
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./docker/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus

  migrate:
    build:
      context: .
      dockerfile: services/migrate/Dockerfile
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      MIGRATIONS_DIR: /app/db/migrations
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      dockerfile: services/api/Dockerfile
    environment:
      PORT: "8080"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-api
    volumes:
      - thumb_data:/data
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started

  worker:
    build:
      context: .
      dockerfile: services/worker/Dockerfile
    environment:
      PORT: "8081"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      POLL_MS: "200"
      CLAIM_BACKOFF_MS: "500"
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-worker
    volumes:
      - thumb_data:/data
    ports:
      - "8081:8081"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started
      api:
        condition: service_started

volumes:
  grafana_data:
  thumb_data:


# ===== docker/grafana/dashboards/thumbnailer-overview.json =====

{
  "annotations": { "list": [] },
  "editable": false,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [],
  "refresh": "5s",
  "schemaVersion": 39,
  "tags": ["thumbnailer"],
  "templating": { "list": [] },
  "time": { "from": "now-15m", "to": "now" },
  "timepicker": {},
  "timezone": "browser",
  "title": "thumbnailer overview",
  "uid": "thumbnailer-overview",
  "version": 1
}


# ===== docker/grafana/provisioning/dashboards/dashboards.yml =====

apiVersion: 1

providers:
  - name: "default"
    orgId: 1
    folder: ""
    type: file
    disableDeletion: true
    editable: false
    options:
      path: /var/lib/grafana/dashboards


# ===== docker/grafana/provisioning/datasources/datasources.yml =====

apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true


# ===== docker/otel/otel-collector.yaml =====

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]



# ===== docker/prometheus/alerts.yml =====

groups:
  - name: thumbnailer.rules
    interval: 15s
    rules:
      - alert: ThumbnailerApiDown
        expr: up{job="thumbnailer_api"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is down"
          description: "prometheus cannot scrape thumbnailer api /metrics for 30s"

      - alert: ThumbnailerWorkerDown
        expr: up{job="thumbnailer_worker"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is down"
          description: "prometheus cannot scrape thumbnailer worker /metrics for 30s"

      # db health as seen by app readiness probes
      - alert: ThumbnailerApiNotReady
        expr: thumbnailer_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is not ready"
          description: "api /readyz reports not ready for 30s (commonly db down)"

      - alert: ThumbnailerWorkerNotReady
        expr: worker_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is not ready"
          description: "worker /readyz reports not ready for 30s (commonly db down)"

      # high 5xx rate (fast signal during failures)
      - alert: ThumbnailerApiHigh5xxRate
        expr: |
          (
            sum(rate(http_requests_total{service="api",status_code=~"5.."}[2m]))
            /
            sum(rate(http_requests_total{service="api"}[2m]))
          ) > 0.05
        for: 2m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "api 5xx rate > 5% (2m)"
          description: "api is returning elevated 5xx responses"

      # latency slo: 99% under 300ms
      # we alert on a "fast burn" using error budget style:
      # good = under 0.3s, bad = >= 0.3s
      - alert: ThumbnailerLatencySLOFastBurn
        expr: |
          (
            sum(rate(http_request_duration_seconds_bucket{service="api",route="POST /v1/thumbnails",le="0.3"}[5m]))
            /
            sum(rate(http_request_duration_seconds_count{service="api",route="POST /v1/thumbnails"}[5m]))
          ) < 0.99
        for: 5m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "latency slo burn (fast)"
          description: "less than 99% of POST /v1/thumbnails requests are under 300ms over 5m"


# ===== docker/prometheus/prometheus.yml =====

global:
  scrape_interval: 5s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["prometheus:9090"]
  - job_name: thumbnailer_api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:8080"]
  - job_name: thumbnailer_worker
    metrics_path: /metrics
    static_configs:
      - targets: ["worker:8081"]

rule_files:
  - /etc/prometheus/alerts.yml


# ===== dump.md =====



# ===== db/migrations/001_init.sql =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  idempotency_key TEXT NULL,

  input_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sizes JSONB NOT NULL,

  status job_status NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  traceparent TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idem_key_uniq
  ON jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS outputs (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,

  size INT NOT NULL,
  output_path TEXT NOT NULL,
  bytes INT NOT NULL,
  format TEXT NOT NULL DEFAULT 'jpeg',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(job_id, size)
);

CREATE INDEX IF NOT EXISTS outputs_job_id_idx
  ON outputs (job_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;

CREATE TRIGGER trg_jobs_updated_at
BEFORE UPDATE ON jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


# ===== docker-compose.yml =====

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_USER: postgres
      POSTGRES_DB: thumbnailer
    ports:
      - "5432:5432"
    volumes:
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
      - ./.data/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d thumbnailer"]
      interval: 2s
      timeout: 2s
      retries: 20

  jaeger:
    image: jaegertracing/all-in-one:1.55
    ports:
      - "16686:16686"   # ui
      - "4317:4317"     # otlp grpc ingest
      - "4318:4318"     # otlp http ingest
    environment:
      COLLECTOR_OTLP_ENABLED: "true"

  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.142.0
    command: ["--config=/etc/otel-collector.yaml"]
    volumes:
      - ./docker/otel/otel-collector.yaml:/etc/otel-collector.yaml:ro
      - ./docker/prometheus/alerts.yml:/etc/prometheus/alerts.yml:ro

    ports:
      - "4319:4317"   # expose collector grpc on host:4319 (optional)
      - "4320:4318"   # expose collector http on host:4320 (optional)
    depends_on:
      - jaeger

  prometheus:
    image: prom/prometheus:v2.51.0
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
    volumes:
      - ./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:11.3.0
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_USERS_DEFAULT_THEME: light
    volumes:
      - ./docker/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./docker/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana_data:/var/lib/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus

  migrate:
    build:
      context: .
      dockerfile: services/migrate/Dockerfile
    environment:
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      MIGRATIONS_DIR: /app/db/migrations
    depends_on:
      postgres:
        condition: service_healthy

  api:
    build:
      context: .
      dockerfile: services/api/Dockerfile
    environment:
      PORT: "8080"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-api
    volumes:
      - thumb_data:/data
    ports:
      - "8080:8080"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started

  worker:
    build:
      context: .
      dockerfile: services/worker/Dockerfile
    environment:
      PORT: "8081"
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/thumbnailer
      STORAGE_DIR: /data
      POLL_MS: "200"
      CLAIM_BACKOFF_MS: "500"
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: http://otel-collector:4318/v1/traces
      OTEL_RESOURCE_ATTRIBUTES: service.name=thumbnailer-worker
    volumes:
      - thumb_data:/data
    ports:
      - "8081:8081"
    depends_on:
      postgres:
        condition: service_healthy
      otel-collector:
        condition: service_started
      api:
        condition: service_started

volumes:
  grafana_data:
  thumb_data:


# ===== docker/grafana/dashboards/thumbnailer-overview.json =====

{
  "annotations": { "list": [] },
  "editable": false,
  "fiscalYearStartMonth": 0,
  "graphTooltip": 0,
  "id": null,
  "links": [],
  "panels": [],
  "refresh": "5s",
  "schemaVersion": 39,
  "tags": ["thumbnailer"],
  "templating": { "list": [] },
  "time": { "from": "now-15m", "to": "now" },
  "timepicker": {},
  "timezone": "browser",
  "title": "thumbnailer overview",
  "uid": "thumbnailer-overview",
  "version": 1
}


# ===== docker/grafana/provisioning/dashboards/dashboards.yml =====

apiVersion: 1

providers:
  - name: "default"
    orgId: 1
    folder: ""
    type: file
    disableDeletion: true
    editable: false
    options:
      path: /var/lib/grafana/dashboards


# ===== docker/grafana/provisioning/datasources/datasources.yml =====

apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true


# ===== docker/otel/otel-collector.yaml =====

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]



# ===== docker/prometheus/alerts.yml =====

groups:
  - name: thumbnailer.rules
    interval: 15s
    rules:
      - alert: ThumbnailerApiDown
        expr: up{job="thumbnailer_api"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is down"
          description: "prometheus cannot scrape thumbnailer api /metrics for 30s"

      - alert: ThumbnailerWorkerDown
        expr: up{job="thumbnailer_worker"} == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is down"
          description: "prometheus cannot scrape thumbnailer worker /metrics for 30s"

      # db health as seen by app readiness probes
      - alert: ThumbnailerApiNotReady
        expr: thumbnailer_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "thumbnailer api is not ready"
          description: "api /readyz reports not ready for 30s (commonly db down)"

      - alert: ThumbnailerWorkerNotReady
        expr: worker_ready == 0
        for: 30s
        labels:
          severity: page
          service: thumbnailer-worker
        annotations:
          summary: "thumbnailer worker is not ready"
          description: "worker /readyz reports not ready for 30s (commonly db down)"

      # high 5xx rate (fast signal during failures)
      - alert: ThumbnailerApiHigh5xxRate
        expr: |
          (
            sum(rate(http_requests_total{service="api",status_code=~"5.."}[2m]))
            /
            sum(rate(http_requests_total{service="api"}[2m]))
          ) > 0.05
        for: 2m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "api 5xx rate > 5% (2m)"
          description: "api is returning elevated 5xx responses"

      # latency slo: 99% under 300ms
      # we alert on a "fast burn" using error budget style:
      # good = under 0.3s, bad = >= 0.3s
      - alert: ThumbnailerLatencySLOFastBurn
        expr: |
          (
            sum(rate(http_request_duration_seconds_bucket{service="api",route="POST /v1/thumbnails",le="0.3"}[5m]))
            /
            sum(rate(http_request_duration_seconds_count{service="api",route="POST /v1/thumbnails"}[5m]))
          ) < 0.99
        for: 5m
        labels:
          severity: page
          service: thumbnailer-api
        annotations:
          summary: "latency slo burn (fast)"
          description: "less than 99% of POST /v1/thumbnails requests are under 300ms over 5m"


# ===== docker/prometheus/prometheus.yml =====

global:
  scrape_interval: 5s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["prometheus:9090"]
  - job_name: thumbnailer_api
    metrics_path: /metrics
    static_configs:
      - targets: ["api:8080"]
  - job_name: thumbnailer_worker
    metrics_path: /metrics
    static_configs:
      - targets: ["worker:8081"]

rule_files:
  - /etc/prometheus/alerts.yml


# ===== dump.md =====



# ===== db/migrations/001_init.sql =====

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('queued', 'processing', 'succeeded', 'failed');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'demo',
  idempotency_key TEXT NULL,

  input_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  sizes JSONB NOT NULL,

  status job_status NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  traceparent TEXT NULL,

  error_code TEXT NULL,
  error_message TEXT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ NULL,
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (status, run_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_tenant_idem_key_uniq


# ===== eslint.config.js =====

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
];


# ===== mise.toml =====

[tools]
node = "20"


# ===== package.json =====

{
  "name": "otel-slo-thumbnailer",
  "private": true,
  "workspaces": [
    "services/*"
  ],
  "scripts": {
    "build": "npm -ws run build",
    "dev": "npm -ws run dev",
    "lint": "npm -ws run lint",
    "typecheck": "npm -ws run typecheck"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@types/node": "^25.0.3",
    "eslint": "^9.17.0",
    "globals": "^15.14.0",
    "tsup": "^8.3.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "typescript-eslint": "^8.19.1"
  }
}


# ===== package-lock.json =====

{
  "name": "otel-slo-thumbnailer",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "otel-slo-thumbnailer",
      "workspaces": [
        "services/*"
      ],
      "devDependencies": {
        "@eslint/js": "^9.17.0",
        "@types/node": "^25.0.3",
        "eslint": "^9.17.0",
        "globals": "^15.14.0",
        "tsup": "^8.3.5",
        "tsx": "^4.19.2",
        "typescript": "^5.7.3",
        "typescript-eslint": "^8.19.1"
      }
    },
    "node_modules/@emnapi/runtime": {
      "version": "1.8.0",
      "resolved": "https://registry.npmjs.org/@emnapi/runtime/-/runtime-1.8.0.tgz",
      "integrity": "sha512-Z82FDl1ByxqPEPrAYYeTQVlx2FSHPe1qwX465c+96IRS3fTdSYRoJcRxg3g2fEG5I69z1dSEWQlNRRr0/677mg==",
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "tslib": "^2.4.0"
      }
    },
    "node_modules/@esbuild/aix-ppc64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/aix-ppc64/-/aix-ppc64-0.27.2.tgz",
      "integrity": "sha512-GZMB+a0mOMZs4MpDbj8RJp4cw+w1WV5NYD6xzgvzUJ5Ek2jerwfO2eADyI6ExDSUED+1X8aMbegahsJi+8mgpw==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "aix"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/android-arm": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/android-arm/-/android-arm-0.27.2.tgz",
      "integrity": "sha512-DVNI8jlPa7Ujbr1yjU2PfUSRtAUZPG9I1RwW4F4xFB1Imiu2on0ADiI/c3td+KmDtVKNbi+nffGDQMfcIMkwIA==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/android-arm64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/android-arm64/-/android-arm64-0.27.2.tgz",
      "integrity": "sha512-pvz8ZZ7ot/RBphf8fv60ljmaoydPU12VuXHImtAs0XhLLw+EXBi2BLe3OYSBslR4rryHvweW5gmkKFwTiFy6KA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/android-x64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/android-x64/-/android-x64-0.27.2.tgz",
      "integrity": "sha512-z8Ank4Byh4TJJOh4wpz8g2vDy75zFL0TlZlkUkEwYXuPSgX8yzep596n6mT7905kA9uHZsf/o2OJZubl2l3M7A==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/darwin-arm64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/darwin-arm64/-/darwin-arm64-0.27.2.tgz",
      "integrity": "sha512-davCD2Zc80nzDVRwXTcQP/28fiJbcOwvdolL0sOiOsbwBa72kegmVU0Wrh1MYrbuCL98Omp5dVhQFWRKR2ZAlg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/darwin-x64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/darwin-x64/-/darwin-x64-0.27.2.tgz",
      "integrity": "sha512-ZxtijOmlQCBWGwbVmwOF/UCzuGIbUkqB1faQRf5akQmxRJ1ujusWsb3CVfk/9iZKr2L5SMU5wPBi1UWbvL+VQA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/freebsd-arm64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/freebsd-arm64/-/freebsd-arm64-0.27.2.tgz",
      "integrity": "sha512-lS/9CN+rgqQ9czogxlMcBMGd+l8Q3Nj1MFQwBZJyoEKI50XGxwuzznYdwcav6lpOGv5BqaZXqvBSiB/kJ5op+g==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/freebsd-x64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/freebsd-x64/-/freebsd-x64-0.27.2.tgz",
      "integrity": "sha512-tAfqtNYb4YgPnJlEFu4c212HYjQWSO/w/h/lQaBK7RbwGIkBOuNKQI9tqWzx7Wtp7bTPaGC6MJvWI608P3wXYA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-arm": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-arm/-/linux-arm-0.27.2.tgz",
      "integrity": "sha512-vWfq4GaIMP9AIe4yj1ZUW18RDhx6EPQKjwe7n8BbIecFtCQG4CfHGaHuh7fdfq+y3LIA2vGS/o9ZBGVxIDi9hw==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-arm64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-arm64/-/linux-arm64-0.27.2.tgz",
      "integrity": "sha512-hYxN8pr66NsCCiRFkHUAsxylNOcAQaxSSkHMMjcpx0si13t1LHFphxJZUiGwojB1a/Hd5OiPIqDdXONia6bhTw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-ia32": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-ia32/-/linux-ia32-0.27.2.tgz",
      "integrity": "sha512-MJt5BRRSScPDwG2hLelYhAAKh9imjHK5+NE/tvnRLbIqUWa+0E9N4WNMjmp/kXXPHZGqPLxggwVhz7QP8CTR8w==",
      "cpu": [
        "ia32"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-loong64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-loong64/-/linux-loong64-0.27.2.tgz",
      "integrity": "sha512-lugyF1atnAT463aO6KPshVCJK5NgRnU4yb3FUumyVz+cGvZbontBgzeGFO1nF+dPueHD367a2ZXe1NtUkAjOtg==",
      "cpu": [
        "loong64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-mips64el": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-mips64el/-/linux-mips64el-0.27.2.tgz",
      "integrity": "sha512-nlP2I6ArEBewvJ2gjrrkESEZkB5mIoaTswuqNFRv/WYd+ATtUpe9Y09RnJvgvdag7he0OWgEZWhviS1OTOKixw==",
      "cpu": [
        "mips64el"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-ppc64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-ppc64/-/linux-ppc64-0.27.2.tgz",
      "integrity": "sha512-C92gnpey7tUQONqg1n6dKVbx3vphKtTHJaNG2Ok9lGwbZil6DrfyecMsp9CrmXGQJmZ7iiVXvvZH6Ml5hL6XdQ==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-riscv64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-riscv64/-/linux-riscv64-0.27.2.tgz",
      "integrity": "sha512-B5BOmojNtUyN8AXlK0QJyvjEZkWwy/FKvakkTDCziX95AowLZKR6aCDhG7LeF7uMCXEJqwa8Bejz5LTPYm8AvA==",
      "cpu": [
        "riscv64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-s390x": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-s390x/-/linux-s390x-0.27.2.tgz",
      "integrity": "sha512-p4bm9+wsPwup5Z8f4EpfN63qNagQ47Ua2znaqGH6bqLlmJ4bx97Y9JdqxgGZ6Y8xVTixUnEkoKSHcpRlDnNr5w==",
      "cpu": [
        "s390x"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-x64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.27.2.tgz",
      "integrity": "sha512-uwp2Tip5aPmH+NRUwTcfLb+W32WXjpFejTIOWZFw/v7/KnpCDKG66u4DLcurQpiYTiYwQ9B7KOeMJvLCu/OvbA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/netbsd-arm64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/netbsd-arm64/-/netbsd-arm64-0.27.2.tgz",
      "integrity": "sha512-Kj6DiBlwXrPsCRDeRvGAUb/LNrBASrfqAIok+xB0LxK8CHqxZ037viF13ugfsIpePH93mX7xfJp97cyDuTZ3cw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "netbsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/netbsd-x64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/netbsd-x64/-/netbsd-x64-0.27.2.tgz",
      "integrity": "sha512-HwGDZ0VLVBY3Y+Nw0JexZy9o/nUAWq9MlV7cahpaXKW6TOzfVno3y3/M8Ga8u8Yr7GldLOov27xiCnqRZf0tCA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "netbsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/openbsd-arm64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/openbsd-arm64/-/openbsd-arm64-0.27.2.tgz",
      "integrity": "sha512-DNIHH2BPQ5551A7oSHD0CKbwIA/Ox7+78/AWkbS5QoRzaqlev2uFayfSxq68EkonB+IKjiuxBFoV8ESJy8bOHA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openbsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/openbsd-x64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/openbsd-x64/-/openbsd-x64-0.27.2.tgz",
      "integrity": "sha512-/it7w9Nb7+0KFIzjalNJVR5bOzA9Vay+yIPLVHfIQYG/j+j9VTH84aNB8ExGKPU4AzfaEvN9/V4HV+F+vo8OEg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openbsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/openharmony-arm64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/openharmony-arm64/-/openharmony-arm64-0.27.2.tgz",
      "integrity": "sha512-LRBbCmiU51IXfeXk59csuX/aSaToeG7w48nMwA6049Y4J4+VbWALAuXcs+qcD04rHDuSCSRKdmY63sruDS5qag==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openharmony"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/sunos-x64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/sunos-x64/-/sunos-x64-0.27.2.tgz",
      "integrity": "sha512-kMtx1yqJHTmqaqHPAzKCAkDaKsffmXkPHThSfRwZGyuqyIeBvf08KSsYXl+abf5HDAPMJIPnbBfXvP2ZC2TfHg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "sunos"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/win32-arm64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/win32-arm64/-/win32-arm64-0.27.2.tgz",
      "integrity": "sha512-Yaf78O/B3Kkh+nKABUF++bvJv5Ijoy9AN1ww904rOXZFLWVc5OLOfL56W+C8F9xn5JQZa3UX6m+IktJnIb1Jjg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/win32-ia32": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/win32-ia32/-/win32-ia32-0.27.2.tgz",
      "integrity": "sha512-Iuws0kxo4yusk7sw70Xa2E2imZU5HoixzxfGCdxwBdhiDgt9vX9VUCBhqcwY7/uh//78A1hMkkROMJq9l27oLQ==",
      "cpu": [
        "ia32"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/win32-x64": {
      "version": "0.27.2",
      "resolved": "https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-0.27.2.tgz",
      "integrity": "sha512-sRdU18mcKf7F+YgheI/zGf5alZatMUTKj/jNS6l744f9u3WFu4v7twcUI9vu4mknF4Y9aDlblIie0IM+5xxaqQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@eslint-community/eslint-utils": {
      "version": "4.9.1",
      "resolved": "https://registry.npmjs.org/@eslint-community/eslint-utils/-/eslint-utils-4.9.1.tgz",
      "integrity": "sha512-phrYmNiYppR7znFEdqgfWHXR6NCkZEK7hwWDHZUjit/2/U0r6XvkDl0SYnoM51Hq7FhCGdLDT6zxCCOY1hexsQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "eslint-visitor-keys": "^3.4.3"
      },
      "engines": {
        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      },
      "peerDependencies": {
        "eslint": "^6.0.0 || ^7.0.0 || >=8.0.0"
      }
    },
    "node_modules/@eslint-community/eslint-utils/node_modules/eslint-visitor-keys": {
      "version": "3.4.3",
      "resolved": "https://registry.npmjs.org/eslint-visitor-keys/-/eslint-visitor-keys-3.4.3.tgz",
      "integrity": "sha512-wpc+LXeiyiisxPlEkUzU6svyS1frIO3Mgxj1fdy7Pm8Ygzguax2N3Fa/D/ag1WqbOprdI+uY6wMUl8/a2G+iag==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      }
    },
    "node_modules/@eslint-community/regexpp": {
      "version": "4.12.2",
      "resolved": "https://registry.npmjs.org/@eslint-community/regexpp/-/regexpp-4.12.2.tgz",
      "integrity": "sha512-EriSTlt5OC9/7SXkRSCAhfSxxoSUgBm33OH+IkwbdpgoqsSsUg7y3uh+IICI/Qg4BBWr3U2i39RpmycbxMq4ew==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "^12.0.0 || ^14.0.0 || >=16.0.0"
      }
    },
    "node_modules/@eslint/config-array": {
      "version": "0.21.1",
      "resolved": "https://registry.npmjs.org/@eslint/config-array/-/config-array-0.21.1.tgz",
      "integrity": "sha512-aw1gNayWpdI/jSYVgzN5pL0cfzU02GT3NBpeT/DXbx1/1x7ZKxFPd9bwrzygx/qiwIQiJ1sw/zD8qY/kRvlGHA==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@eslint/object-schema": "^2.1.7",
        "debug": "^4.3.1",
        "minimatch": "^3.1.2"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@eslint/config-helpers": {
      "version": "0.4.2",
      "resolved": "https://registry.npmjs.org/@eslint/config-helpers/-/config-helpers-0.4.2.tgz",
      "integrity": "sha512-gBrxN88gOIf3R7ja5K9slwNayVcZgK6SOUORm2uBzTeIEfeVaIhOpCtTox3P6R7o2jLFwLFTLnC7kU/RGcYEgw==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@eslint/core": "^0.17.0"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@eslint/core": {
      "version": "0.17.0",
      "resolved": "https://registry.npmjs.org/@eslint/core/-/core-0.17.0.tgz",
      "integrity": "sha512-yL/sLrpmtDaFEiUj1osRP4TI2MDz1AddJL+jZ7KSqvBuliN4xqYY54IfdN8qD8Toa6g1iloph1fxQNkjOxrrpQ==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@types/json-schema": "^7.0.15"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@eslint/eslintrc": {
      "version": "3.3.3",
      "resolved": "https://registry.npmjs.org/@eslint/eslintrc/-/eslintrc-3.3.3.tgz",
      "integrity": "sha512-Kr+LPIUVKz2qkx1HAMH8q1q6azbqBAsXJUxBl/ODDuVPX45Z9DfwB8tPjTi6nNZ8BuM3nbJxC5zCAg5elnBUTQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "ajv": "^6.12.4",
        "debug": "^4.3.2",
        "espree": "^10.0.1",
        "globals": "^14.0.0",
        "ignore": "^5.2.0",
        "import-fresh": "^3.2.1",
        "js-yaml": "^4.1.1",
        "minimatch": "^3.1.2",
        "strip-json-comments": "^3.1.1"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "url": "https://opencollective.com/eslint"
      }
    },
    "node_modules/@eslint/eslintrc/node_modules/globals": {
      "version": "14.0.0",
      "resolved": "https://registry.npmjs.org/globals/-/globals-14.0.0.tgz",
      "integrity": "sha512-oahGvuMGQlPw/ivIYBjVSrWAfWLBeku5tpPE2fOPLi+WHffIWbuh2tCjhyQhTBPMf5E9jDEH4FOmTYgYwbKwtQ==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=18"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/@eslint/js": {
      "version": "9.39.2",
      "resolved": "https://registry.npmjs.org/@eslint/js/-/js-9.39.2.tgz",
      "integrity": "sha512-q1mjIoW1VX4IvSocvM/vbTiveKC4k9eLrajNEuSsmjymSDEbpGddtpfOoN7YGAqBK3NG+uqo8ia4PDTt8buCYA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      },
      "funding": {
        "url": "https://eslint.org/donate"
      }
    },
    "node_modules/@eslint/object-schema": {
      "version": "2.1.7",
      "resolved": "https://registry.npmjs.org/@eslint/object-schema/-/object-schema-2.1.7.tgz",
      "integrity": "sha512-VtAOaymWVfZcmZbp6E2mympDIHvyjXs/12LqWYjVw6qjrfF+VK+fyG33kChz3nnK+SU5/NeHOqrTEHS8sXO3OA==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@eslint/plugin-kit": {
      "version": "0.4.1",
      "resolved": "https://registry.npmjs.org/@eslint/plugin-kit/-/plugin-kit-0.4.1.tgz",
      "integrity": "sha512-43/qtrDUokr7LJqoF2c3+RInu/t4zfrpYdoSDfYyhg52rwLV6TnOvdG4fXm7IkSB3wErkcmJS9iEhjVtOSEjjA==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@eslint/core": "^0.17.0",
        "levn": "^0.4.1"
      },
      "engines": {
        "node": "^18.18.0 || ^20.9.0 || >=21.1.0"
      }
    },
    "node_modules/@fastify/ajv-compiler": {
      "version": "3.6.0",
      "resolved": "https://registry.npmjs.org/@fastify/ajv-compiler/-/ajv-compiler-3.6.0.tgz",
      "integrity": "sha512-LwdXQJjmMD+GwLOkP7TVC68qa+pSSogeWWmznRJ/coyTcfe9qA05AHFSe1eZFwK6q+xVRpChnvFUkf1iYaSZsQ==",
      "license": "MIT",
      "dependencies": {
        "ajv": "^8.11.0",
        "ajv-formats": "^2.1.1",
        "fast-uri": "^2.0.0"
      }
    },
    "node_modules/@fastify/ajv-compiler/node_modules/ajv": {
      "version": "8.17.1",
      "resolved": "https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz",
      "integrity": "sha512-B/gBuNg5SiMTrPkC+A2+cW0RszwxYmn6VYxB/inlBStS5nx6xHIt/ehKRhIMhqusl7a8LjQoZnjCs5vhwxOQ1g==",
      "license": "MIT",
      "dependencies": {
        "fast-deep-equal": "^3.1.3",
        "fast-uri": "^3.0.1",
        "json-schema-traverse": "^1.0.0",
        "require-from-string": "^2.0.2"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/epoberezkin"
      }
    },
    "node_modules/@fastify/ajv-compiler/node_modules/ajv/node_modules/fast-uri": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.0.tgz",
      "integrity": "sha512-iPeeDKJSWf4IEOasVVrknXpaBV0IApz/gp7S2bb7Z4Lljbl2MGJRqInZiUrQwV16cpzw/D3S5j5Julj/gT52AA==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "BSD-3-Clause"
    },
    "node_modules/@fastify/ajv-compiler/node_modules/json-schema-traverse": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz",
      "integrity": "sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==",
      "license": "MIT"
    },
    "node_modules/@fastify/busboy": {
      "version": "3.2.0",
      "resolved": "https://registry.npmjs.org/@fastify/busboy/-/busboy-3.2.0.tgz",
      "integrity": "sha512-m9FVDXU3GT2ITSe0UaMA5rU3QkfC/UXtCU8y0gSN/GugTqtVldOBWIB5V6V3sbmenVZUIpU6f+mPEO2+m5iTaA==",
      "license": "MIT"
    },
    "node_modules/@fastify/deepmerge": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/@fastify/deepmerge/-/deepmerge-2.0.2.tgz",
      "integrity": "sha512-3wuLdX5iiiYeZWP6bQrjqhrcvBIf0NHbQH1Ur1WbHvoiuTYUEItgygea3zs8aHpiitn0lOB8gX20u1qO+FDm7Q==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT"
    },
    "node_modules/@fastify/error": {
      "version": "4.2.0",
      "resolved": "https://registry.npmjs.org/@fastify/error/-/error-4.2.0.tgz",
      "integrity": "sha512-RSo3sVDXfHskiBZKBPRgnQTtIqpi/7zhJOEmAxCiBcM7d0uwdGdxLlsCaLzGs8v8NnxIRlfG0N51p5yFaOentQ==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT"
    },
    "node_modules/@fastify/fast-json-stringify-compiler": {
      "version": "4.3.0",
      "resolved": "https://registry.npmjs.org/@fastify/fast-json-stringify-compiler/-/fast-json-stringify-compiler-4.3.0.tgz",
      "integrity": "sha512-aZAXGYo6m22Fk1zZzEUKBvut/CIIQe/BapEORnxiD5Qr0kPHqqI69NtEMCme74h+at72sPhbkb4ZrLd1W3KRLA==",
      "license": "MIT",
      "dependencies": {
        "fast-json-stringify": "^5.7.0"
      }
    },
    "node_modules/@fastify/merge-json-schemas": {
      "version": "0.1.1",
      "resolved": "https://registry.npmjs.org/@fastify/merge-json-schemas/-/merge-json-schemas-0.1.1.tgz",
      "integrity": "sha512-fERDVz7topgNjtXsJTTW1JKLy0rhuLRcquYqNR9rF7OcVpCa2OVW49ZPDIhaRRCaUuvVxI+N416xUoF76HNSXA==",
      "license": "MIT",
      "dependencies": {
        "fast-deep-equal": "^3.1.3"
      }
    },
    "node_modules/@fastify/multipart": {
      "version": "8.3.1",
      "resolved": "https://registry.npmjs.org/@fastify/multipart/-/multipart-8.3.1.tgz",
      "integrity": "sha512-pncbnG28S6MIskFSVRtzTKE9dK+GrKAJl0NbaQ/CG8ded80okWFsYKzSlP9haaLNQhNRDOoHqmGQNvgbiPVpWQ==",
      "license": "MIT",
      "dependencies": {
        "@fastify/busboy": "^3.0.0",
        "@fastify/deepmerge": "^2.0.0",
        "@fastify/error": "^4.0.0",
        "fastify-plugin": "^4.0.0",
        "secure-json-parse": "^2.4.0",
        "stream-wormhole": "^1.1.0"
      }
    },
    "node_modules/@grpc/grpc-js": {
      "version": "1.14.3",
      "resolved": "https://registry.npmjs.org/@grpc/grpc-js/-/grpc-js-1.14.3.tgz",
      "integrity": "sha512-Iq8QQQ/7X3Sac15oB6p0FmUg/klxQvXLeileoqrTRGJYLV+/9tubbr9ipz0GKHjmXVsgFPo/+W+2cA8eNcR+XA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@grpc/proto-loader": "^0.8.0",
        "@js-sdsl/ordered-map": "^4.4.2"
      },
      "engines": {
        "node": ">=12.10.0"
      }
    },
    "node_modules/@grpc/proto-loader": {
      "version": "0.8.0",
      "resolved": "https://registry.npmjs.org/@grpc/proto-loader/-/proto-loader-0.8.0.tgz",
      "integrity": "sha512-rc1hOQtjIWGxcxpb9aHAfLpIctjEnsDehj0DAiVfBlmT84uvR0uUtN2hEi/ecvWVjXUGf5qPF4qEgiLOx1YIMQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "lodash.camelcase": "^4.3.0",
        "long": "^5.0.0",
        "protobufjs": "^7.5.3",
        "yargs": "^17.7.2"
      },
      "bin": {
        "proto-loader-gen-types": "build/bin/proto-loader-gen-types.js"
      },
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/@humanfs/core": {
      "version": "0.19.1",
      "resolved": "https://registry.npmjs.org/@humanfs/core/-/core-0.19.1.tgz",
      "integrity": "sha512-5DyQ4+1JEUzejeK1JGICcideyfUbGixgS9jNgex5nqkW+cY7WZhxBigmieN5Qnw9ZosSNVC9KQKyb+GUaGyKUA==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=18.18.0"
      }
    },
    "node_modules/@humanfs/node": {
      "version": "0.16.7",
      "resolved": "https://registry.npmjs.org/@humanfs/node/-/node-0.16.7.tgz",
      "integrity": "sha512-/zUx+yOsIrG4Y43Eh2peDeKCxlRt/gET6aHfaKpuq267qXdYDFViVHfMaLyygZOnl0kGWxFIgsBy8QFuTLUXEQ==",
      "dev": true,
      "license": "Apache-2.0",
      "dependencies": {
        "@humanfs/core": "^0.19.1",
        "@humanwhocodes/retry": "^0.4.0"
      },
      "engines": {
        "node": ">=18.18.0"
      }
    },
    "node_modules/@humanwhocodes/module-importer": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/@humanwhocodes/module-importer/-/module-importer-1.0.1.tgz",
      "integrity": "sha512-bxveV4V8v5Yb4ncFTT3rPSgZBOpCkjfK0y4oVVVJwIuDVBRMDXrPyXRL988i5ap9m9bnyEEjWfm5WkBmtffLfA==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=12.22"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/nzakas"
      }
    },
    "node_modules/@humanwhocodes/retry": {
      "version": "0.4.3",
      "resolved": "https://registry.npmjs.org/@humanwhocodes/retry/-/retry-0.4.3.tgz",
      "integrity": "sha512-bV0Tgo9K4hfPCek+aMAn81RppFKv2ySDQeMoSZuvTASywNTnVJCArCZE2FWqpvIatKu7VMRLWlR1EazvVhDyhQ==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=18.18"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/nzakas"
      }
    },
    "node_modules/@img/sharp-darwin-arm64": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-darwin-arm64/-/sharp-darwin-arm64-0.33.5.tgz",
      "integrity": "sha512-UT4p+iz/2H4twwAoLCqfA9UH5pI6DggwKEGuaPy7nCVQ8ZsiY5PIcrRvD1DzuY3qYL07NtIQcWnBSY/heikIFQ==",
      "cpu": [
        "arm64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-darwin-arm64": "1.0.4"
      }
    },
    "node_modules/@img/sharp-darwin-x64": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-darwin-x64/-/sharp-darwin-x64-0.33.5.tgz",
      "integrity": "sha512-fyHac4jIc1ANYGRDxtiqelIbdWkIuQaI84Mv45KvGRRxSAa7o7d1ZKAOBaYbnepLC1WqxfpimdeWfvqqSGwR2Q==",
      "cpu": [
        "x64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-darwin-x64": "1.0.4"
      }
    },
    "node_modules/@img/sharp-libvips-darwin-arm64": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-darwin-arm64/-/sharp-libvips-darwin-arm64-1.0.4.tgz",
      "integrity": "sha512-XblONe153h0O2zuFfTAbQYAX2JhYmDHeWikp1LM9Hul9gVPjFY427k6dFEcOL72O01QxQsWi761svJ/ev9xEDg==",
      "cpu": [
        "arm64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "darwin"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-darwin-x64": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-darwin-x64/-/sharp-libvips-darwin-x64-1.0.4.tgz",
      "integrity": "sha512-xnGR8YuZYfJGmWPvmlunFaWJsb9T/AO2ykoP3Fz/0X5XV2aoYBPkX6xqCQvUTKKiLddarLaxpzNe+b1hjeWHAQ==",
      "cpu": [
        "x64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "darwin"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-arm": {
      "version": "1.0.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-arm/-/sharp-libvips-linux-arm-1.0.5.tgz",
      "integrity": "sha512-gvcC4ACAOPRNATg/ov8/MnbxFDJqf/pDePbBnuBDcjsI8PssmjoKMAz4LtLaVi+OnSb5FK/yIOamqDwGmXW32g==",
      "cpu": [
        "arm"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-arm64": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-arm64/-/sharp-libvips-linux-arm64-1.0.4.tgz",
      "integrity": "sha512-9B+taZ8DlyyqzZQnoeIvDVR/2F4EbMepXMc/NdVbkzsJbzkUjhXv/70GQJ7tdLA4YJgNP25zukcxpX2/SueNrA==",
      "cpu": [
        "arm64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-s390x": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-s390x/-/sharp-libvips-linux-s390x-1.0.4.tgz",
      "integrity": "sha512-u7Wz6ntiSSgGSGcjZ55im6uvTrOxSIS8/dgoVMoiGE9I6JAfU50yH5BoDlYA1tcuGS7g/QNtetJnxA6QEsCVTA==",
      "cpu": [
        "s390x"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-x64": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-x64/-/sharp-libvips-linux-x64-1.0.4.tgz",
      "integrity": "sha512-MmWmQ3iPFZr0Iev+BAgVMb3ZyC4KeFc3jFxnNbEPas60e1cIfevbtuyf9nDGIzOaW9PdnDciJm+wFFaTlj5xYw==",
      "cpu": [
        "x64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linuxmusl-arm64": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linuxmusl-arm64/-/sharp-libvips-linuxmusl-arm64-1.0.4.tgz",
      "integrity": "sha512-9Ti+BbTYDcsbp4wfYib8Ctm1ilkugkA/uscUn6UXK1ldpC1JjiXbLfFZtRlBhjPZ5o1NCLiDbg8fhUPKStHoTA==",
      "cpu": [
        "arm64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linuxmusl-x64": {
      "version": "1.0.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linuxmusl-x64/-/sharp-libvips-linuxmusl-x64-1.0.4.tgz",
      "integrity": "sha512-viYN1KX9m+/hGkJtvYYp+CCLgnJXwiQB39damAO7WMdKWlIhmYTfHjwSbQeUK/20vY154mwezd9HflVFM1wVSw==",
      "cpu": [
        "x64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-linux-arm": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-arm/-/sharp-linux-arm-0.33.5.tgz",
      "integrity": "sha512-JTS1eldqZbJxjvKaAkxhZmBqPRGmxgu+qFKSInv8moZ2AmT5Yib3EQ1c6gp493HvrvV8QgdOXdyaIBrhvFhBMQ==",
      "cpu": [
        "arm"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-arm": "1.0.5"
      }
    },
    "node_modules/@img/sharp-linux-arm64": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-arm64/-/sharp-linux-arm64-0.33.5.tgz",
      "integrity": "sha512-JMVv+AMRyGOHtO1RFBiJy/MBsgz0x4AWrT6QoEVVTyh1E39TrCUpTRI7mx9VksGX4awWASxqCYLCV4wBZHAYxA==",
      "cpu": [
        "arm64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-arm64": "1.0.4"
      }
    },
    "node_modules/@img/sharp-linux-s390x": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-s390x/-/sharp-linux-s390x-0.33.5.tgz",
      "integrity": "sha512-y/5PCd+mP4CA/sPDKl2961b+C9d+vPAveS33s6Z3zfASk2j5upL6fXVPZi7ztePZ5CuH+1kW8JtvxgbuXHRa4Q==",
      "cpu": [
        "s390x"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-s390x": "1.0.4"
      }
    },
    "node_modules/@img/sharp-linux-x64": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-x64/-/sharp-linux-x64-0.33.5.tgz",
      "integrity": "sha512-opC+Ok5pRNAzuvq1AG0ar+1owsu842/Ab+4qvU879ippJBHvyY5n2mxF1izXqkPYlGuP/M556uh53jRLJmzTWA==",
      "cpu": [
        "x64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-x64": "1.0.4"
      }
    },
    "node_modules/@img/sharp-linuxmusl-arm64": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linuxmusl-arm64/-/sharp-linuxmusl-arm64-0.33.5.tgz",
      "integrity": "sha512-XrHMZwGQGvJg2V/oRSUfSAfjfPxO+4DkiRh6p2AFjLQztWUuY/o8Mq0eMQVIY7HJ1CDQUJlxGGZRw1a5bqmd1g==",
      "cpu": [
        "arm64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linuxmusl-arm64": "1.0.4"
      }
    },
    "node_modules/@img/sharp-linuxmusl-x64": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linuxmusl-x64/-/sharp-linuxmusl-x64-0.33.5.tgz",
      "integrity": "sha512-WT+d/cgqKkkKySYmqoZ8y3pxx7lx9vVejxW/W4DOFMYVSkErR+w7mf2u8m/y4+xHe7yY9DAXQMWQhpnMuFfScw==",
      "cpu": [
        "x64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linuxmusl-x64": "1.0.4"
      }
    },
    "node_modules/@img/sharp-wasm32": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-wasm32/-/sharp-wasm32-0.33.5.tgz",
      "integrity": "sha512-ykUW4LVGaMcU9lu9thv85CbRMAwfeadCJHRsg2GmeRa/cJxsVY9Rbd57JcMxBkKHag5U/x7TSBpScF4U8ElVzg==",
      "cpu": [
        "wasm32"
      ],
      "license": "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
      "optional": true,
      "dependencies": {
        "@emnapi/runtime": "^1.2.0"
      },
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-win32-ia32": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-win32-ia32/-/sharp-win32-ia32-0.33.5.tgz",
      "integrity": "sha512-T36PblLaTwuVJ/zw/LaH0PdZkRz5rd3SmMHX8GSmR7vtNSP5Z6bQkExdSK7xGWyxLw4sUknBuugTelgw2faBbQ==",
      "cpu": [
        "ia32"
      ],
      "license": "Apache-2.0 AND LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-win32-x64": {
      "version": "0.33.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-0.33.5.tgz",
      "integrity": "sha512-MpY/o8/8kj+EcnxwvrP4aTJSWw/aZ7JIGR4aBeZkZw5B7/Jn+tY9/VNwtcoGmdT7GfggGIU4kygOMSbYnOrAbg==",
      "cpu": [
        "x64"
      ],
      "license": "Apache-2.0 AND LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": "^18.17.0 || ^20.3.0 || >=21.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@jridgewell/gen-mapping": {
      "version": "0.3.13",
      "resolved": "https://registry.npmjs.org/@jridgewell/gen-mapping/-/gen-mapping-0.3.13.tgz",
      "integrity": "sha512-2kkt/7niJ6MgEPxF0bYdQ6etZaA+fQvDcLKckhy1yIQOzaoKjBBjSj63/aLVjYE3qhRt5dvM+uUyfCg6UKCBbA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/sourcemap-codec": "^1.5.0",
        "@jridgewell/trace-mapping": "^0.3.24"
      }
    },
    "node_modules/@jridgewell/resolve-uri": {
      "version": "3.1.2",
      "resolved": "https://registry.npmjs.org/@jridgewell/resolve-uri/-/resolve-uri-3.1.2.tgz",
      "integrity": "sha512-bRISgCIjP20/tbWSPWMEi54QVPRZExkuD9lJL+UIxUKtwVJA8wW1Trb1jMs1RFXo1CBTNZ/5hpC9QvmKWdopKw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.0.0"
      }
    },
    "node_modules/@jridgewell/sourcemap-codec": {
      "version": "1.5.5",
      "resolved": "https://registry.npmjs.org/@jridgewell/sourcemap-codec/-/sourcemap-codec-1.5.5.tgz",
      "integrity": "sha512-cYQ9310grqxueWbl+WuIUIaiUaDcj7WOq5fVhEljNVgRfOUhY9fy2zTvfoqWsnebh8Sl70VScFbICvJnLKB0Og==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@jridgewell/trace-mapping": {
      "version": "0.3.31",
      "resolved": "https://registry.npmjs.org/@jridgewell/trace-mapping/-/trace-mapping-0.3.31.tgz",
      "integrity": "sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/resolve-uri": "^3.1.0",
        "@jridgewell/sourcemap-codec": "^1.4.14"
      }
    },
    "node_modules/@js-sdsl/ordered-map": {
      "version": "4.4.2",
      "resolved": "https://registry.npmjs.org/@js-sdsl/ordered-map/-/ordered-map-4.4.2.tgz",
      "integrity": "sha512-iUKgm52T8HOE/makSxjqoWhe95ZJA1/G1sYsGev2JDKUSS14KAgg1LHb+Ba+IPow0xflbnSkOsZcO08C7w1gYw==",
      "license": "MIT",
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/js-sdsl"
      }
    },
    "node_modules/@opentelemetry/api": {
      "version": "1.9.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/api/-/api-1.9.0.tgz",
      "integrity": "sha512-3giAOQvZiH5F9bMlMiv8+GSPMeqg0dbaeo58/0SlA9sxSqZhnUtxzX9/2FzyhS9sWQf5S0GJE0AKBrFqjpeYcg==",
      "license": "Apache-2.0",
      "engines": {
        "node": ">=8.0.0"
      }
    },
    "node_modules/@opentelemetry/api-logs": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/api-logs/-/api-logs-0.208.0.tgz",
      "integrity": "sha512-CjruKY9V6NMssL/T1kAFgzosF1v9o6oeN+aX5JB/C/xPNtmgIJqcXHG7fA82Ou1zCpWGl4lROQUKwUNE1pMCyg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api": "^1.3.0"
      },
      "engines": {
        "node": ">=8.0.0"
      }
    },
    "node_modules/@opentelemetry/auto-instrumentations-node": {
      "version": "0.67.3",
      "resolved": "https://registry.npmjs.org/@opentelemetry/auto-instrumentations-node/-/auto-instrumentations-node-0.67.3.tgz",
      "integrity": "sha512-sRzw/T1JU7CCATGxnnKhHbWMlwMH1qO62+4/znfsJTg24ATP5qNKFkt8B/JD7HAQ/0ceMeyQin9KOBnjkLkCvA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/instrumentation-amqplib": "^0.56.0",
        "@opentelemetry/instrumentation-aws-lambda": "^0.61.1",
        "@opentelemetry/instrumentation-aws-sdk": "^0.64.1",
        "@opentelemetry/instrumentation-bunyan": "^0.54.0",
        "@opentelemetry/instrumentation-cassandra-driver": "^0.54.1",
        "@opentelemetry/instrumentation-connect": "^0.52.0",
        "@opentelemetry/instrumentation-cucumber": "^0.24.0",
        "@opentelemetry/instrumentation-dataloader": "^0.26.1",
        "@opentelemetry/instrumentation-dns": "^0.52.0",
        "@opentelemetry/instrumentation-express": "^0.57.1",
        "@opentelemetry/instrumentation-fastify": "^0.53.1",
        "@opentelemetry/instrumentation-fs": "^0.28.0",
        "@opentelemetry/instrumentation-generic-pool": "^0.52.0",
        "@opentelemetry/instrumentation-graphql": "^0.56.0",
        "@opentelemetry/instrumentation-grpc": "^0.208.0",
        "@opentelemetry/instrumentation-hapi": "^0.55.1",
        "@opentelemetry/instrumentation-http": "^0.208.0",
        "@opentelemetry/instrumentation-ioredis": "^0.57.0",
        "@opentelemetry/instrumentation-kafkajs": "^0.18.1",
        "@opentelemetry/instrumentation-knex": "^0.53.1",
        "@opentelemetry/instrumentation-koa": "^0.57.1",
        "@opentelemetry/instrumentation-lru-memoizer": "^0.53.1",
        "@opentelemetry/instrumentation-memcached": "^0.52.1",
        "@opentelemetry/instrumentation-mongodb": "^0.62.0",
        "@opentelemetry/instrumentation-mongoose": "^0.55.1",
        "@opentelemetry/instrumentation-mysql": "^0.55.0",
        "@opentelemetry/instrumentation-mysql2": "^0.55.1",
        "@opentelemetry/instrumentation-nestjs-core": "^0.55.0",
        "@opentelemetry/instrumentation-net": "^0.53.0",
        "@opentelemetry/instrumentation-openai": "^0.7.1",
        "@opentelemetry/instrumentation-oracledb": "^0.34.1",
        "@opentelemetry/instrumentation-pg": "^0.61.2",
        "@opentelemetry/instrumentation-pino": "^0.55.1",
        "@opentelemetry/instrumentation-redis": "^0.57.2",
        "@opentelemetry/instrumentation-restify": "^0.54.0",
        "@opentelemetry/instrumentation-router": "^0.53.0",
        "@opentelemetry/instrumentation-runtime-node": "^0.22.0",
        "@opentelemetry/instrumentation-socket.io": "^0.55.1",
        "@opentelemetry/instrumentation-tedious": "^0.28.0",
        "@opentelemetry/instrumentation-undici": "^0.19.0",
        "@opentelemetry/instrumentation-winston": "^0.53.0",
        "@opentelemetry/resource-detector-alibaba-cloud": "^0.32.0",
        "@opentelemetry/resource-detector-aws": "^2.9.0",
        "@opentelemetry/resource-detector-azure": "^0.17.0",
        "@opentelemetry/resource-detector-container": "^0.8.0",
        "@opentelemetry/resource-detector-gcp": "^0.44.0",
        "@opentelemetry/resources": "^2.0.0",
        "@opentelemetry/sdk-node": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.4.1",
        "@opentelemetry/core": "^2.0.0"
      }
    },
    "node_modules/@opentelemetry/context-async-hooks": {
      "version": "2.2.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/context-async-hooks/-/context-async-hooks-2.2.0.tgz",
      "integrity": "sha512-qRkLWiUEZNAmYapZ7KGS5C4OmBLcP/H2foXeOEaowYCR0wi89fHejrfYfbuLVCMLp/dWZXKvQusdbUEZjERfwQ==",
      "license": "Apache-2.0",
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/core": {
      "version": "2.2.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/core/-/core-2.2.0.tgz",
      "integrity": "sha512-FuabnnUm8LflnieVxs6eP7Z383hgQU4W1e3KJS6aOG3RxWxcHyBxH8fDMHNgu/gFx/M2jvTOW/4/PHhLz6bjWw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/semantic-conventions": "^1.29.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": ">=1.0.0 <1.10.0"
      }
    },
    "node_modules/@opentelemetry/exporter-logs-otlp-grpc": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-logs-otlp-grpc/-/exporter-logs-otlp-grpc-0.208.0.tgz",
      "integrity": "sha512-AmZDKFzbq/idME/yq68M155CJW1y056MNBekH9OZewiZKaqgwYN4VYfn3mXVPftYsfrCM2r4V6tS8H2LmfiDCg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@grpc/grpc-js": "^1.7.1",
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-grpc-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/sdk-logs": "0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-logs-otlp-http": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-logs-otlp-http/-/exporter-logs-otlp-http-0.208.0.tgz",
      "integrity": "sha512-jOv40Bs9jy9bZVLo/i8FwUiuCvbjWDI+ZW13wimJm4LjnlwJxGgB+N/VWOZUTpM+ah/awXeQqKdNlpLf2EjvYg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api-logs": "0.208.0",
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/sdk-logs": "0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-logs-otlp-proto": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-logs-otlp-proto/-/exporter-logs-otlp-proto-0.208.0.tgz",
      "integrity": "sha512-Wy8dZm16AOfM7yddEzSFzutHZDZ6HspKUODSUJVjyhnZFMBojWDjSNgduyCMlw6qaxJYz0dlb0OEcb4Eme+BfQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api-logs": "0.208.0",
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-logs": "0.208.0",
        "@opentelemetry/sdk-trace-base": "2.2.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-metrics-otlp-grpc": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-metrics-otlp-grpc/-/exporter-metrics-otlp-grpc-0.208.0.tgz",
      "integrity": "sha512-YbEnk7jjYmvhIwp2xJGkEvdgnayrA2QSr28R1LR1klDPvCxsoQPxE6TokDbQpoCEhD3+KmJVEXfb4EeEQxjymg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@grpc/grpc-js": "^1.7.1",
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/exporter-metrics-otlp-http": "0.208.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-grpc-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-metrics": "2.2.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-metrics-otlp-http": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-metrics-otlp-http/-/exporter-metrics-otlp-http-0.208.0.tgz",
      "integrity": "sha512-QZ3TrI90Y0i1ezWQdvreryjY0a5TK4J9gyDLIyhLBwV+EQUvyp5wR7TFPKCAexD4TDSWM0t3ulQDbYYjVtzTyA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-metrics": "2.2.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-metrics-otlp-proto": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-metrics-otlp-proto/-/exporter-metrics-otlp-proto-0.208.0.tgz",
      "integrity": "sha512-CvvVD5kRDmRB/uSMalvEF6kiamY02pB46YAqclHtfjJccNZFxbkkXkMMmcJ7NgBFa5THmQBNVQ2AHyX29nRxOw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/exporter-metrics-otlp-http": "0.208.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-metrics": "2.2.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-prometheus": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-prometheus/-/exporter-prometheus-0.208.0.tgz",
      "integrity": "sha512-Rgws8GfIfq2iNWCD3G1dTD9xwYsCof1+tc5S5X0Ahdb5CrAPE+k5P70XCWHqrFFurVCcKaHLJ/6DjIBHWVfLiw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-metrics": "2.2.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-trace-otlp-grpc": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-trace-otlp-grpc/-/exporter-trace-otlp-grpc-0.208.0.tgz",
      "integrity": "sha512-E/eNdcqVUTAT7BC+e8VOw/krqb+5rjzYkztMZ/o+eyJl+iEY6PfczPXpwWuICwvsm0SIhBoh9hmYED5Vh5RwIw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@grpc/grpc-js": "^1.7.1",
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-grpc-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-trace-base": "2.2.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-trace-otlp-http": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-trace-otlp-http/-/exporter-trace-otlp-http-0.208.0.tgz",
      "integrity": "sha512-jbzDw1q+BkwKFq9yxhjAJ9rjKldbt5AgIy1gmEIJjEV/WRxQ3B6HcLVkwbjJ3RcMif86BDNKR846KJ0tY0aOJA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-trace-base": "2.2.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-trace-otlp-proto": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-trace-otlp-proto/-/exporter-trace-otlp-proto-0.208.0.tgz",
      "integrity": "sha512-q844Jc3ApkZVdWYd5OAl+an3n1XXf3RWHa3Zgmnhw3HpsM3VluEKHckUUEqHPzbwDUx2lhPRVkqK7LsJ/CbDzA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/otlp-exporter-base": "0.208.0",
        "@opentelemetry/otlp-transformer": "0.208.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-trace-base": "2.2.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/exporter-zipkin": {
      "version": "2.2.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/exporter-zipkin/-/exporter-zipkin-2.2.0.tgz",
      "integrity": "sha512-VV4QzhGCT7cWrGasBWxelBjqbNBbyHicWWS/66KoZoe9BzYwFB72SH2/kkc4uAviQlO8iwv2okIJy+/jqqEHTg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/resources": "2.2.0",
        "@opentelemetry/sdk-trace-base": "2.2.0",
        "@opentelemetry/semantic-conventions": "^1.29.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.0.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation/-/instrumentation-0.208.0.tgz",
      "integrity": "sha512-Eju0L4qWcQS+oXxi6pgh7zvE2byogAkcsVv0OjHF/97iOz1N/aKE6etSGowYkie+YA1uo6DNwdSxaaNnLvcRlA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api-logs": "0.208.0",
        "import-in-the-middle": "^2.0.0",
        "require-in-the-middle": "^8.0.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-amqplib": {
      "version": "0.56.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-amqplib/-/instrumentation-amqplib-0.56.0.tgz",
      "integrity": "sha512-/orV2zO2K7iGa1TR6lbs170LNNDbeTC6E3JF1EeB+okJ3rB5tl1gHFSjoqEDkQYFprNs5CPitqU8Y4l4S2Pkmg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.33.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-aws-lambda": {
      "version": "0.61.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-aws-lambda/-/instrumentation-aws-lambda-0.61.1.tgz",
      "integrity": "sha512-leISmqN7/KSCYAKEVOAnQ0NUCa3rigB7ShCVLnYrHr6+7CXPef7C+nvowElMcYTid8egiHKgApR/FaNdlBda3A==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.27.0",
        "@types/aws-lambda": "^8.10.155"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-aws-sdk": {
      "version": "0.64.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-aws-sdk/-/instrumentation-aws-sdk-0.64.1.tgz",
      "integrity": "sha512-A8joPAuHwvwrkG5UpH7OYhzkeYznNBiG3o1TKoZ7yvyXU/q4CNxnZ7vzZBEpt9OocptCe6X/YyBENFSa0axqiw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.34.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-bunyan": {
      "version": "0.54.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-bunyan/-/instrumentation-bunyan-0.54.0.tgz",
      "integrity": "sha512-DnPoHSLcKwQmueW+7OOaXFD/cj1M6hqwTm6P88QdMbln/dqEatLxzt/ACPk4Yb5x4aU3ZLyeLyKxtzfhp76+aw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/api-logs": "^0.208.0",
        "@opentelemetry/instrumentation": "^0.208.0",
        "@types/bunyan": "1.8.11"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-cassandra-driver": {
      "version": "0.54.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-cassandra-driver/-/instrumentation-cassandra-driver-0.54.1.tgz",
      "integrity": "sha512-wVGI4YrWmaNNtNjg84KTl8sHebG7jm3PHvmZxPl2V/aSskAyQMSxgJZpnv1dmBmJuISc+a8H8daporljbscCcQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-connect": {
      "version": "0.52.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-connect/-/instrumentation-connect-0.52.0.tgz",
      "integrity": "sha512-GXPxfNB5szMbV3I9b7kNWSmQBoBzw7MT0ui6iU/p+NIzVx3a06Ri2cdQO7tG9EKb4aKSLmfX9Cw5cKxXqX6Ohg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.27.0",
        "@types/connect": "3.4.38"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-cucumber": {
      "version": "0.24.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-cucumber/-/instrumentation-cucumber-0.24.0.tgz",
      "integrity": "sha512-ICHrmax9PwU/Z+fehD0uIjM8W0cEvdToglV1+o76Mgw51HZBVp2Y3mkga1qMPIN5tPMoWUYoYtI4U85rea5HYg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.27.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.0.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-dataloader": {
      "version": "0.26.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-dataloader/-/instrumentation-dataloader-0.26.1.tgz",
      "integrity": "sha512-S2JAM6lV16tMravuPLd3tJCC6ySb5a//5KgJeXutbTVb/UbSTXcnHSdEtMaAvE2KbazVWyWzcoytLRy6AUOwsw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-dns": {
      "version": "0.52.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-dns/-/instrumentation-dns-0.52.0.tgz",
      "integrity": "sha512-XJvS8PkZec+X6HhOi1xldJydTpmIUAW14+1vyqwAK97LWKXlxmiWst8/fjZ709+CHgshz8i5V37yCHlr6o3pxw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-express": {
      "version": "0.57.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-express/-/instrumentation-express-0.57.1.tgz",
      "integrity": "sha512-r+ulPbvgG8rGgFFWbJWJpTh7nMzsEYH7rBFNWdFs7ZfVAtgpFijMkRtU7DecIo6ItF8Op+RxogSuk/083W8HKw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.27.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-fastify": {
      "version": "0.53.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-fastify/-/instrumentation-fastify-0.53.1.tgz",
      "integrity": "sha512-tTa84J9rcrl4iTHdJDwirrNbM4prgJH+MF0iMlVLu++6gZg8TTfmYYqDiKPWBgdXB4M+bnlCkvgag36uV34uwA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.27.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-fs": {
      "version": "0.28.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-fs/-/instrumentation-fs-0.28.0.tgz",
      "integrity": "sha512-FFvg8fq53RRXVBRHZViP+EMxMR03tqzEGpuq55lHNbVPyFklSVfQBN50syPhK5UYYwaStx0eyCtHtbRreusc5g==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-generic-pool": {
      "version": "0.52.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-generic-pool/-/instrumentation-generic-pool-0.52.0.tgz",
      "integrity": "sha512-ISkNcv5CM2IwvsMVL31Tl61/p2Zm2I2NAsYq5SSBgOsOndT0TjnptjufYVScCnD5ZLD1tpl4T3GEYULLYOdIdQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-graphql": {
      "version": "0.56.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-graphql/-/instrumentation-graphql-0.56.0.tgz",
      "integrity": "sha512-IPvNk8AFoVzTAM0Z399t34VDmGDgwT6rIqCUug8P9oAGerl2/PEIYMPOl/rerPGu+q8gSWdmbFSjgg7PDVRd3Q==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-grpc": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-grpc/-/instrumentation-grpc-0.208.0.tgz",
      "integrity": "sha512-8hFEQRAiOyIWO6LYj7tUfdAgNCuQUdYjLYMItRYlOLGJhshGdGYD7aeNzt2H+HPMDEWnKWqldIHfLTqM7ep7gg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "0.208.0",
        "@opentelemetry/semantic-conventions": "^1.29.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-hapi": {
      "version": "0.55.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-hapi/-/instrumentation-hapi-0.55.1.tgz",
      "integrity": "sha512-Pm1HCHnnijUOGXd+nyJp96CfU8Lb6XdT6H6YvvmXO/NHMb6tV+EjzDRBr9sZ/XQjka9zLCz7jR0js7ut0IJAyg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.27.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-http": {
      "version": "0.208.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-http/-/instrumentation-http-0.208.0.tgz",
      "integrity": "sha512-rhmK46DRWEbQQB77RxmVXGyjs6783crXCnFjYQj+4tDH/Kpv9Rbg3h2kaNyp5Vz2emF1f9HOQQvZoHzwMWOFZQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "2.2.0",
        "@opentelemetry/instrumentation": "0.208.0",
        "@opentelemetry/semantic-conventions": "^1.29.0",
        "forwarded-parse": "2.1.2"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-ioredis": {
      "version": "0.57.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-ioredis/-/instrumentation-ioredis-0.57.0.tgz",
      "integrity": "sha512-o/PYGPbfFbS0Sq8EEQC8YUgDMiTGvwoMejPjV2d466yJoii+BUpffGejVQN0hC5V5/GT29m1B1jL+3yruNxwDw==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/redis-common": "^0.38.2",
        "@opentelemetry/semantic-conventions": "^1.33.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-kafkajs": {
      "version": "0.18.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-kafkajs/-/instrumentation-kafkajs-0.18.1.tgz",
      "integrity": "sha512-qM9hk7BIsVWqWJsrCa1fAEcEfutVvwhHO9kk4vpwaTGYR+lPWRk2r5+nEPcM+sIiYBmQNJCef5tEjQpKxTpP0A==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.30.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-knex": {
      "version": "0.53.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-knex/-/instrumentation-knex-0.53.1.tgz",
      "integrity": "sha512-tIW3gqVC8d9CCE+oxPO63WNvC+5PKC/LrPrYWFobii5afUpHJV+0pfyt08okAFBHztzT0voMOEPGkLKoacZRXQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.33.1"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-koa": {
      "version": "0.57.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-koa/-/instrumentation-koa-0.57.1.tgz",
      "integrity": "sha512-XPjdzgXvMG3YSZvsSgOj0Je0fsmlaBYIFFGJqUn1HRpbrVjdpP45eXI+6yUp48J8N5Qss32WDD5f+2tmV7Xvsg==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.36.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.9.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-lru-memoizer": {
      "version": "0.53.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-lru-memoizer/-/instrumentation-lru-memoizer-0.53.1.tgz",
      "integrity": "sha512-L93bPJKFzrObD4FvKpsavYEFTzXFKMmAeRHz7J4lUFc7TPZLouxX3PYW1+YGr/bT1y24H9NLNX66l7BW1s75QA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-memcached": {
      "version": "0.52.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-memcached/-/instrumentation-memcached-0.52.1.tgz",
      "integrity": "sha512-qg92SyWAypSZmX3Lhm2wz4BsovKarkWg9OHm4DPW6fGzmk40eB5voQIuctrBAfsml6gr+vbg4VEBcC1AKRvzzQ==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0",
        "@opentelemetry/semantic-conventions": "^1.33.0",
        "@types/memcached": "^2.2.6"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-mongodb": {
      "version": "0.62.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-mongodb/-/instrumentation-mongodb-0.62.0.tgz",
      "integrity": "sha512-hcEEW26ToGVpQGblXk9m3p2cXkBu9j2bcyeevS/ahujr1WodfrItmMldWCEJkmN4+4uMo9pb6jAMhm6bZIMnig==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-mongoose": {
      "version": "0.55.1",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-mongoose/-/instrumentation-mongoose-0.55.1.tgz",
      "integrity": "sha512-M2MusLn/31YOt176Y6qXJQcpDuZPmq/fqQ9vIaKb4x/qIJ3oYO2lT45SUMFmZpODEhrpYXgGaEKwG6TGXhlosA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/core": "^2.0.0",
        "@opentelemetry/instrumentation": "^0.208.0"
      },
      "engines": {
        "node": "^18.19.0 || >=20.6.0"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.3.0"
      }
    },
    "node_modules/@opentelemetry/instrumentation-mysql": {
      "version": "0.55.0",
      "resolved": "https://registry.npmjs.org/@opentelemetry/instrumentation-mysql/-/instrumentation-mysql-0.55.0.tgz",
      "integrity": "sha512-tEGaVMzqAlwhoDomaUWOP2H4KkK16m18qq+TZoyvcSe9O21UxnYFWQa87a4kmc7N4Q6Q70L/YhwDt+fC+NDRBA==",
      "license": "Apache-2.0",
      "dependencies": {
        "@opentelemetry/instrumentation": "^0.208.0",


# ===== scripts/chaos-db-down.sh =====

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


# ===== services/api/package.json =====

{
  "name": "@thumbnailer/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsup src/index.ts --format esm --target es2022 --sourcemap",
    "start": "node dist/index.js",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@fastify/multipart": "^8.0.0",
    "fastify": "^4.28.1",
    "pg": "^8.13.1",
    "prom-client": "^15.1.3",

    "@opentelemetry/api": "1.9.0",
    "@opentelemetry/auto-instrumentations-node": "0.67.3",
    "@opentelemetry/exporter-trace-otlp-http": "0.208.0",
    "@opentelemetry/sdk-node": "0.208.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/pg": "^8.10.9"
  }
}


# ===== services/api/src/config.ts =====

import process from "node:process";

export type Config = {
  port: number;
  databaseUrl: string;
  storageDir: string;
  maxUploadBytes: number;
  allowedSizes: number[];
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? "8080"),
    databaseUrl: requiredEnv("DATABASE_URL"),
    storageDir: process.env.STORAGE_DIR ?? "/data",
    maxUploadBytes: 5 * 1024 * 1024,
    allowedSizes: [64, 128, 256, 512]
  };
}


# ===== services/api/src/db.ts =====

import { Pool } from "pg";
import { dbQueryDurationSeconds } from "./metrics.js";

export type Db = {
  pool: Pool;
  close(): Promise<void>;
  query<T>(operation: string, text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export function createDb(databaseUrl: string): Db {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10
  });

  return {
    pool,
    async close() {
      await pool.end();
    },
    async query<T>(operation: string, text: string, params: unknown[] = []) {
      const end = dbQueryDurationSeconds.labels(operation).startTimer();
      try {
        const res = await pool.query(text, params);
        return { rows: res.rows as T[] };
      } finally {
        end();
      }
    }
  };
}


# ===== services/api/src/file.ts =====

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export type SniffedType = "jpeg" | "png";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(buf: Buffer): SniffedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  return null;
}

export async function saveUploadWithHash(opts: {
  stream: Readable;
  destPath: string;
  maxBytes: number;
}): Promise<{ sha256: string; kind: SniffedType; bytes: number }> {
  await fsp.mkdir(path.dirname(opts.destPath), { recursive: true });

  const hash = crypto.createHash("sha256");
  let header = Buffer.alloc(0);
  let bytes = 0;

  const out = fs.createWriteStream(opts.destPath, { flags: "wx" });

  opts.stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > opts.maxBytes) {
      opts.stream.destroy(new Error("file too large"));
      return;
    }

    hash.update(chunk);

    if (header.length < 16) {
      const need = 16 - header.length;
      header = Buffer.concat([header, chunk.subarray(0, Math.min(need, chunk.length))]);
    }
  });

  try {
    await pipeline(opts.stream, out);
  } catch (err) {
    try {
      await fsp.unlink(opts.destPath);
    } catch {
      // ignore
    }
    throw err;
  }

  const kind = sniff(header);
  if (!kind) {
    await fsp.unlink(opts.destPath).catch(() => {});
    throw new Error("unsupported format");
  }

  return {
    sha256: hash.digest("hex"),
    kind,
    bytes
  };
}


# ===== services/api/src/index.ts =====

import process from "node:process";
import { startOtel, shutdownOtel } from "./otel.js";
import { startReadinessLoop } from "./readiness.js";

let db: any;
let readiness: ReturnType<typeof startReadinessLoop>;

await startOtel();

const { buildServer } = await import("./server.js");

const { app, db: createdDb, config } = await buildServer({
  getReady: () => readiness?.getReady() ?? false,
});

db = createdDb;

readiness = startReadinessLoop(
  async () => {
    await db.query("readiness_check", "SELECT 1");
  },
  2000
);

const close = async () => {
  readiness.stop();
  try {
    await app.close();
  } catch {}
  try {
    await db.close();
  } catch {}
  await shutdownOtel().catch(() => {});
};

process.on("SIGINT", () => {
  close().finally(() => process.exit(0)).catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  close().finally(() => process.exit(0)).catch(() => process.exit(1));
});

await app.listen({ host: "0.0.0.0", port: config.port });


# ===== services/api/src/log.ts =====

export type LogLevel = "info" | "error";

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  // keep it structured and boring
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields
    })
  );
}


# ===== services/api/src/metrics.ts =====

import client from "prom-client";

export const registry = new client.Registry();
registry.setDefaultLabels({ service: "api" });
client.collectDefaultMetrics({ register: registry });

export const readyGauge = new client.Gauge({
  name: "thumbnailer_ready",
  help: "1 if api can reach db, else 0",
  registers: [registry]
});

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "http requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry]
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "http request duration in seconds",
  labelNames: ["method","route","status_code"] as const,
  registers: [registry],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.3, 2, 3, 5]
});

export const dbQueryDurationSeconds = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "db query duration in seconds",
  labelNames: ["operation"] as const,
  registers: [registry],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2]
});


# ===== services/api/src/otel.ts =====

import process from "node:process";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

let sdk: NodeSDK | null = null;

export async function startOtel() {
  const tracesEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://otel-collector:4318/v1/traces";

  const traceExporter = new OTLPTraceExporter({
    url: tracesEndpoint
  });

  sdk = new NodeSDK({
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  await sdk.start();

  process.on("SIGTERM", () => shutdownOtel().catch(() => {}));
  process.on("SIGINT", () => shutdownOtel().catch(() => {}));
}

export async function shutdownOtel() {
  if (!sdk) return;
  const s = sdk;
  sdk = null;
  await s.shutdown();
}


# ===== services/api/src/readiness.ts =====

import { readyGauge } from "./metrics.js";

export function startReadinessLoop(
  check: () => Promise<void>,
  intervalMs = 2000
): { getReady: () => boolean; stop: () => void } {
  let ready = false;

  function set(v: boolean) {
    ready = v;
    readyGauge.set(v ? 1 : 0);
  }

  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      await check();
      set(true);
    } catch {
      set(false);
    }
  }

  // run once immediately
  void tick();

  const t = setInterval(() => void tick(), intervalMs);
  t.unref();

  return {
    getReady: () => ready,
    stop: () => {
      stopped = true;
      clearInterval(t);
    }
  };
}


# ===== services/api/src/server.ts =====

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { context, propagation, trace } from "@opentelemetry/api";

import { loadConfig, type Config } from "./config.js";
import { createDb, type Db } from "./db.js";
import { registry, httpRequestDurationSeconds, httpRequestsTotal } from "./metrics.js";
import { log } from "./log.js";
import { saveUploadWithHash } from "./file.js";

type CreateJobResponse = {
  job_id: string;
  status: "queued";
  created_at: string;
};

type JobRow = {
  id: string;
  tenant_id: string;
  idempotency_key: string | null;
  input_path: string;
  sha256: string;
  sizes: unknown;
  status: "queued" | "processing" | "succeeded" | "failed";
  attempts: number;
  max_attempts: number;
  run_at: string;
  traceparent: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type OutputRow = {
  size: number;
  output_path: string;
  bytes: number;
  format: string;
  created_at: string;
};

function parseSizes(raw: unknown, allowed: number[]): number[] {
  if (raw === undefined || raw === null || raw === "") return [256];

  const str = String(raw);
  const parts = str.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [256];

  const sizes = parts.map((p) => Number(p));
  if (sizes.some((n) => !Number.isInteger(n))) throw new Error("invalid sizes");
  if (sizes.some((n) => !allowed.includes(n))) throw new Error("invalid sizes");

  // remove dupes, keep order
  const seen = new Set<number>();
  const unique: number[] = [];
  for (const s of sizes) {
    if (!seen.has(s)) {
      seen.add(s);
      unique.push(s);
    }
  }

  return unique.length ? unique : [256];
}

function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

export async function buildServer(
  opts: {
    getReady: () => boolean;
  }
): Promise<{ app: FastifyInstance; db: Db; config: Config }> {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);

  await fs.mkdir(path.join(config.storageDir, "inputs"), { recursive: true });
  await fs.mkdir(path.join(config.storageDir, "outputs"), { recursive: true });

  const app = Fastify({
    logger: true,
    trustProxy: true
  });

  // metrics hook
  app.addHook("onRequest", async (req) => {
    (req as any).__startHr = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (req, reply) => {
    const start = (req as any).__startHr as bigint | undefined;
    if (!start) return;

    const durNs = process.hrtime.bigint() - start;
    const durSec = Number(durNs) / 1e9;

    const route =
      (req.routeOptions && typeof req.routeOptions.url === "string" && req.routeOptions.url) ||
      req.routerPath ||
      "unknown";

    const status = String(reply.statusCode);
    httpRequestsTotal.labels(req.method, route, status).inc();
    httpRequestDurationSeconds.labels(req.method, route, status).observe(durSec);
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes
    }
  });

  app.get("/healthz", async () => ({ ok: true }));
  
  app.get("/readyz", async (_req, reply) => {
  const ready = opts.getReady();
  if (!ready) return reply.code(503).send({ ok: false });
  return reply.send({ ok: true });
});

  app.get("/metrics", async (_req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  app.post("/v1/thumbnails", async (req, reply) => {
    const tenantId = (req.headers["x-tenant-id"] ? String(req.headers["x-tenant-id"]) : "demo").trim();
    const idempotencyKey = req.headers["idempotency-key"] ? String(req.headers["idempotency-key"]).trim() : null;

    const sizes = parseSizes((req.query as any)?.sizes, config.allowedSizes);

    const file = await (req as any).file();
    if (!file) {
      reply.code(400);
      return { error: "missing file" };
    }

    const jobId = crypto.randomUUID();

    // capture traceparent for worker continuation
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    const traceparent = carrier["traceparent"] ?? null;

    const inputDir = path.join(config.storageDir, "inputs");
    const tmpPath = path.join(inputDir, `tmp-${jobId}`);

    let sha256: string;
    let kind: "jpeg" | "png";
    let bytes: number;

    try {
      const saved = await saveUploadWithHash({
        stream: file.file,
        destPath: tmpPath,
        maxBytes: config.maxUploadBytes
      });
      sha256 = saved.sha256;
      kind = saved.kind;
      bytes = saved.bytes;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes("too large") ? 413 : 400;
      reply.code(code);
      return { error: msg };
    }

    const ext = kind === "jpeg" ? "jpg" : "png";
    const finalRel = path.posix.join("inputs", `${jobId}.${ext}`);
    const finalAbs = path.join(config.storageDir, finalRel);

    // move into place
    await fs.rename(tmpPath, finalAbs);

    // idempotency: if conflict, delete stored file and return existing job id
    try {
      const insert = await db.query<{ id: string; created_at: string }>(
        "insert_job",
        `
        INSERT INTO jobs (id, tenant_id, idempotency_key, input_path, sha256, sizes, status, traceparent)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'queued', $7)
        ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
        DO NOTHING
        RETURNING id, created_at;
        `,
        [jobId, tenantId, idempotencyKey, finalRel, sha256, JSON.stringify(sizes), traceparent]
      );

      if (insert.rows.length === 1) {
        const r = insert.rows[0];
        const ids = activeTraceIds();
        log("info", "job_created", { ...ids, job_id: r.id, tenant_id: tenantId, bytes, sizes });

        reply.code(202);
        const resp: CreateJobResponse = { job_id: r.id, status: "queued", created_at: r.created_at };
        return resp;
      }

      // conflict happened
      await fs.unlink(finalAbs).catch(() => {});
      const existing = await db.query<{ id: string; created_at: string }>(
        "get_job_by_idem",
        `
        SELECT id, created_at
        FROM jobs
        WHERE tenant_id = $1 AND idempotency_key = $2
        LIMIT 1;
        `,
        [tenantId, idempotencyKey]
      );

      if (existing.rows.length !== 1) {
        reply.code(500);
        return { error: "idempotency conflict but job missing" };
      }

      reply.code(202);
      return { job_id: existing.rows[0].id, status: "queued", created_at: existing.rows[0].created_at };
    } catch (err) {
      await fs.unlink(finalAbs).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { error: msg };
    }
  });

  app.get("/v1/jobs/:id", async (req, reply) => {
    const id = (req.params as any).id as string;

    const jobRes = await db.query<JobRow>(
      "get_job",
      `
      SELECT *
      FROM jobs
      WHERE id = $1
      LIMIT 1;
      `,
      [id]
    );

    if (jobRes.rows.length !== 1) {
      reply.code(404);
      return { error: "job not found" };
    }

    const job = jobRes.rows[0];

    const outRes = await db.query<OutputRow>(
      "get_outputs",
      `
      SELECT size, output_path, bytes, format, created_at
      FROM outputs
      WHERE job_id = $1
      ORDER BY size ASC;
      `,
      [id]
    );

    const outputs = outRes.rows.map((o) => ({
      size: o.size,
      url: `/v1/thumbnails/${id}/${o.size}`,
      bytes: o.bytes,
      format: o.format,
      created_at: o.created_at
    }));

    return {
      id: job.id,
      tenant_id: job.tenant_id,
      status: job.status,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
      error_code: job.error_code,
      error_message: job.error_message,
      sizes: job.sizes,
      outputs
    };
  });

  app.get("/v1/thumbnails/:id/:size", async (req, reply) => {
    const id = (req.params as any).id as string;
    const sizeRaw = (req.params as any).size as string;
    const size = Number(sizeRaw);

    if (!Number.isInteger(size)) {
      reply.code(400);
      return { error: "invalid size" };
    }

    const rel = path.posix.join("outputs", id, `${size}.jpg`);
    const abs = path.join(config.storageDir, rel);

    try {
      const fh = await fs.open(abs, "r");
      await fh.close();
    } catch {
      reply.code(404);
      return { error: "thumbnail not found" };
    }

    reply.type("image/jpeg");
    return reply.sendFile ? reply.sendFile(abs) : await fs.readFile(abs);
  });

  return { app, db, config };
}


# ===== services/api/tsconfig.json =====

{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}


# ===== services/migrate/package.json =====

{
  "name": "@thumbnailer/migrate",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsup src/index.ts --format esm --target es2022 --sourcemap",
    "start": "node dist/index.js",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/pg": "^8.16.0"
  }
}


# ===== services/migrate/src/index.ts =====

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

type LogLevel = "info" | "error";

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function ensureSchemaMigrations(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied(client: Client): Promise<Set<string>> {
  const res = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set(res.rows.map((r) => r.version));
}

function isMigrationFile(name: string): boolean {
  return /^\d+_.+\.sql$/.test(name);
}

async function main() {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const migrationsDir = process.env.MIGRATIONS_DIR ?? path.resolve("db/migrations");

  const client = new Client({
    connectionString: databaseUrl,
    statement_timeout: 15_000
  });

  log("info", "migrate_start", { migrationsDir });

  await client.connect();
  try {
    await ensureSchemaMigrations(client);

    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && isMigrationFile(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const applied = await getApplied(client);

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) {
        log("info", "migration_skip", { version, file });
        continue;
      }

      const fullPath = path.join(migrationsDir, file);
      const sql = await fs.readFile(fullPath, "utf8");

      log("info", "migration_apply_begin", { version, file });

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        log("info", "migration_applied", { version, file });
      } catch (err) {
        await client.query("ROLLBACK");
        log("error", "migration_failed", {
          version,
          file,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    }

    log("info", "migrate_done", { total: files.length });
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  log("error", "migrate_fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});


# ===== services/migrate/tsconfig.json =====

{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}


# ===== services/worker/package.json =====

{
  "name": "@thumbnailer/worker",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsup src/index.ts --format esm --target es2022 --sourcemap",
    "start": "node dist/index.js",
    "lint": "eslint .",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "fastify": "^4.28.1",
    "pg": "^8.13.1",
    "prom-client": "^15.1.3",
    "sharp": "^0.33.5",

    "@opentelemetry/api": "1.9.0",
    "@opentelemetry/auto-instrumentations-node": "0.67.3",
    "@opentelemetry/exporter-trace-otlp-http": "0.208.0",
    "@opentelemetry/sdk-node": "0.208.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@types/pg": "^8.10.9"
  }
}


# ===== services/worker/src/config.ts =====

import process from "node:process";

export type Config = {
  port: number;
  databaseUrl: string;
  storageDir: string;

  pollMs: number;
  claimBackoffMs: number;

  jpegQuality: number;
  allowedSizes: number[];
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? "8081"),
    databaseUrl: requiredEnv("DATABASE_URL"),
    storageDir: process.env.STORAGE_DIR ?? "/data",

    pollMs: Number(process.env.POLL_MS ?? "200"),
    claimBackoffMs: Number(process.env.CLAIM_BACKOFF_MS ?? "500"),

    jpegQuality: 80,
    allowedSizes: [64, 128, 256, 512]
  };
}


# ===== services/worker/src/db.ts =====

import { Pool } from "pg";
import { dbQueryDurationSeconds } from "./metrics.js";

export type Db = {
  pool: Pool;
  close(): Promise<void>;
  query<T>(operation: string, text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export function createDb(databaseUrl: string): Db {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10
  });

  return {
    pool,
    async close() {
      await pool.end();
    },
    async query<T>(operation: string, text: string, params: unknown[] = []) {
      const end = dbQueryDurationSeconds.labels(operation).startTimer();
      try {
        const res = await pool.query(text, params);
        return { rows: res.rows as T[] };
      } finally {
        end();
      }
    }
  };
}


# ===== services/worker/src/http.ts =====

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registry } from "./metrics.js";

export async function startHttpServer(opts: {
  port: number;
  getReady: () => boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    const ok = opts.getReady();
    if (!ok) reply.code(503);
    return { ok };
  });

  app.get("/metrics", async (_req, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });

  await app.listen({ host: "0.0.0.0", port: opts.port });
  return app;
}


# ===== services/worker/src/index.ts =====

import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

import { startOtel, shutdownOtel } from "./otel.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { startHttpServer } from "./http.js";
import { runWorker } from "./worker.js";
import { startReadinessLoop } from "./readiness.js";
import { log } from "./log.js";

await startOtel();

const config = loadConfig();
const db = createDb(config.databaseUrl);

await fs.mkdir(path.join(config.storageDir, "outputs"), { recursive: true });

const stopSignal = { stopped: false };
const readiness = startReadinessLoop(db, 2000);

const app = await startHttpServer({ port: config.port, getReady: readiness.getReady });

const shutdown = async () => {
  stopSignal.stopped = true;
  readiness.stop();
  try {
    await app.close();
  } catch {}
  try {
    await db.close();
  } catch {}
  await shutdownOtel().catch(() => {});
};

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0)).catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0)).catch(() => process.exit(1));
});

log("info", "worker_started", { port: config.port });

runWorker(db, config, stopSignal).catch((err) => {
  log("error", "worker_fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});


# ===== services/worker/src/log.ts =====

import { context, trace } from "@opentelemetry/api";

export type LogLevel = "info" | "error";

function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...activeTraceIds(),
      ...fields
    })
  );
}


# ===== services/worker/src/metrics.ts =====

import client from "prom-client";

export const registry = new client.Registry();
registry.setDefaultLabels({ service: "worker" });
client.collectDefaultMetrics({ register: registry });

export const readyGauge = new client.Gauge({
  name: "worker_ready",
  help: "1 if worker can reach db, else 0",
  registers: [registry]
});

export const jobsClaimedTotal = new client.Counter({
  name: "jobs_claimed_total",
  help: "jobs claimed by worker",
  registers: [registry]
});

export const jobsCompletedTotal = new client.Counter({
  name: "jobs_completed_total",
  help: "jobs completed by result",
  labelNames: ["result"] as const,
  registers: [registry]
});

export const jobLatencySeconds = new client.Histogram({
  name: "job_latency_seconds",
  help: "end-to-end job latency (created_at -> completed_at)",
  registers: [registry],
  buckets: [0.1, 0.25, 0.5, 1, 2, 3, 5, 8, 13, 21, 34]
});

export const dbQueryDurationSeconds = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "db query duration in seconds",
  labelNames: ["operation"] as const,
  registers: [registry],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2]
});


# ===== services/worker/src/otel.ts =====

import process from "node:process";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

let sdk: NodeSDK | null = null;

export async function startOtel() {
  const tracesEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? "http://otel-collector:4318/v1/traces";

  const traceExporter = new OTLPTraceExporter({ url: tracesEndpoint });

  sdk = new NodeSDK({
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()]
  });

  await sdk.start();

  process.on("SIGTERM", () => shutdownOtel().catch(() => {}));
  process.on("SIGINT", () => shutdownOtel().catch(() => {}));
}

export async function shutdownOtel() {
  if (!sdk) return;
  const s = sdk;
  sdk = null;
  await s.shutdown();
}


# ===== services/worker/src/readiness.ts =====

import type { Db } from "./db.js";
import { readyGauge } from "./metrics.js";
import { log } from "./log.js";

export type Readiness = {
  getReady(): boolean;
  stop(): void;
};

export function startReadinessLoop(db: Db, intervalMs: number): Readiness {
  let ready = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const set = (v: boolean) => {
    ready = v;
    readyGauge.set(v ? 1 : 0);
  };

  const check = async () => {
    try {
      await db.query("readiness_check", "SELECT 1");
      if (!ready) log("info", "ready_state_changed", { ready: true });
      set(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ready) log("error", "ready_state_changed", { ready: false, error: msg });
      set(false);
    }
  };

  // initial check + periodic
  void check();
  timer = setInterval(() => {
    if (stopped) return;
    void check();
  }, intervalMs);

  return {
    getReady: () => ready,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}


# ===== services/worker/src/worker.ts =====

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";
import { context, propagation, trace } from "@opentelemetry/api";

import type { Db } from "./db.js";
import type { Config } from "./config.js";
import { jobsClaimedTotal, jobsCompletedTotal, jobLatencySeconds } from "./metrics.js";
import { log } from "./log.js";

type JobRow = {
  id: string;
  input_path: string;
  sizes: unknown;
  attempts: number;
  max_attempts: number;
  created_at: string;
  traceparent: string | null;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  // attempt starts at 1 for first failure
  const base = 250;
  const cap = 15_000;
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

function parseSizes(value: unknown, allowed: number[]): number[] {
  if (!Array.isArray(value)) throw new Error("invalid sizes");
  const sizes = value.map((x) => Number(x));
  if (sizes.some((n) => !Number.isInteger(n))) throw new Error("invalid sizes");
  if (sizes.some((n) => !allowed.includes(n))) throw new Error("invalid sizes");
  // unique, keep order
  const seen = new Set<number>();
  const out: number[] = [];
  for (const s of sizes) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.length ? out : [256];
}

async function ensureDirs(storageDir: string, jobId: string) {
  await fs.mkdir(path.join(storageDir, "outputs", jobId), { recursive: true });
}

async function claimOne(db: Db): Promise<JobRow | null> {
  // claim inside a tx to avoid double-claim
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const sel = await client.query<JobRow>(`
      SELECT id, input_path, sizes, attempts, max_attempts, created_at, traceparent
      FROM jobs
      WHERE status = 'queued' AND run_at <= now()
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `);

    if (sel.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const job = sel.rows[0];

    await client.query(
      `
      UPDATE jobs
      SET status = 'processing',
          started_at = COALESCE(started_at, now()),
          attempts = attempts + 1
      WHERE id = $1
      `,
      [job.id]
    );

    job.attempts = job.attempts + 1;

    await client.query("COMMIT");
    return job;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markSucceeded(db: Db, jobId: string) {
  await db.query(
    "job_succeeded",
    `
    UPDATE jobs
    SET status = 'succeeded',
        completed_at = now(),
        error_code = NULL,
        error_message = NULL
    WHERE id = $1
    `,
    [jobId]
  );
}

async function markFailed(db: Db, jobId: string, errorCode: string, errorMessage: string) {
  await db.query(
    "job_failed",
    `
    UPDATE jobs
    SET status = 'failed',
        completed_at = now(),
        error_code = $2,
        error_message = $3
    WHERE id = $1
    `,
    [jobId, errorCode, errorMessage]
  );
}

async function scheduleRetry(db: Db, jobId: string, attempt: number, errorCode: string, errorMessage: string) {
  const delay = backoffMs(attempt);
  await db.query(
    "job_retry",
    `
    UPDATE jobs
    SET status = 'queued',
        run_at = now() + ($2 || ' milliseconds')::interval,
        error_code = $3,
        error_message = $4
    WHERE id = $1
    `,
    [jobId, delay, errorCode, errorMessage]
  );
  log("info", "job_retry_scheduled", { job_id: jobId, delay_ms: delay, attempt, error_code: errorCode });
}

async function writeOutputRecord(db: Db, jobId: string, size: number, relPath: string, bytes: number) {
  const outId = crypto.randomUUID();
  await db.query(
    "insert_output",
    `
    INSERT INTO outputs (id, job_id, size, output_path, bytes, format)
    VALUES ($1, $2, $3, $4, $5, 'jpeg')
    ON CONFLICT (job_id, size)
    DO UPDATE SET output_path = EXCLUDED.output_path, bytes = EXCLUDED.bytes, format = 'jpeg'
    `,
    [outId, jobId, size, relPath, bytes]
  );
}

async function processJob(db: Db, config: Config, job: JobRow) {
  const sizes = parseSizes(job.sizes, config.allowedSizes);

  const inputAbs = path.join(config.storageDir, job.input_path);
  await ensureDirs(config.storageDir, job.id);

  const outDirRel = path.posix.join("outputs", job.id);
  const outDirAbs = path.join(config.storageDir, outDirRel);

  // decode once by letting sharp handle pipeline; we do per-size encode outputs
  for (const size of sizes) {
    const outRel = path.posix.join(outDirRel, `${size}.jpg`);
    const outAbs = path.join(outDirAbs, `${size}.jpg`);

    const buf = await sharp(inputAbs)
      .rotate() // respect exif orientation
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: config.jpegQuality })
      .toBuffer();

    await fs.writeFile(outAbs, buf);
    await writeOutputRecord(db, job.id, size, outRel, buf.length);
  }

  await markSucceeded(db, job.id);

  const created = Date.parse(job.created_at);
  const latencySec = Math.max(0, (Date.now() - created) / 1000);
  jobLatencySeconds.observe(latencySec);

  jobsCompletedTotal.labels("succeeded").inc();
  log("info", "job_succeeded", { job_id: job.id, sizes });
}

export async function runWorker(db: Db, config: Config, stopSignal: { stopped: boolean }) {
  const tracer = trace.getTracer("thumbnailer-worker");

  while (!stopSignal.stopped) {
    let job: JobRow | null = null;

    try {
      job = await claimOne(db);
      if (!job) {
        await sleep(config.pollMs);
        continue;
      }
      jobsClaimedTotal.inc();
    } catch (err) {
      // db might be down, don't crash loop
      const msg = err instanceof Error ? err.message : String(err);
      log("error", "claim_failed", { error: msg });
      await sleep(config.claimBackoffMs);
      continue;
    }

    // continue trace if we have traceparent
    const carrier: Record<string, string> = {};
    if (job.traceparent) carrier.traceparent = job.traceparent;

    const parentCtx = propagation.extract(context.active(), carrier);
    await context.with(parentCtx, async () => {
      await tracer.startActiveSpan(
        "job.process",
        { attributes: { "job.id": job!.id, "job.attempts": job!.attempts } },
        async (span) => {
          try {
            log("info", "job_started", { job_id: job!.id, attempt: job!.attempts });
            await processJob(db, config, job!);
            span.setStatus({ code: 1 });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);

            // retry vs fail decision
            const attempt = job!.attempts;
            const max = job!.max_attempts;

            const badInput =
              msg.includes("unsupported") ||
              msg.includes("invalid sizes") ||
              msg.includes("pngload") ||
              msg.includes("jpegload") ||
              msg.includes("heifload") ||
              msg.includes("webpload") ||
              msg.includes("gifload") ||
              msg.includes("tiffload") ||
              msg.includes("svgload");

            const errorCode = badInput ? "bad_input" : "processing_error";

            if (attempt < max && errorCode !== "bad_input") {
              try {
                await scheduleRetry(db, job!.id, attempt, errorCode, msg);
                jobsCompletedTotal.labels("retried").inc();
              } catch (e2) {
                const msg2 = e2 instanceof Error ? e2.message : String(e2);
                log("error", "retry_schedule_failed", { job_id: job!.id, error: msg2 });
              }
            } else {
              try {
                await markFailed(db, job!.id, errorCode, msg);
                jobsCompletedTotal.labels("failed").inc();
                log("error", "job_failed", { job_id: job!.id, error_code: errorCode, error: msg });
              } catch (e2) {
                const msg2 = e2 instanceof Error ? e2.message : String(e2);
                log("error", "mark_failed_failed", { job_id: job!.id, error: msg2 });
              }
            }

            span.recordException(err as Error);
            span.setStatus({ code: 2, message: msg });
          } finally {
            span.end();
          }
        }
      );
    });
  }
}


# ===== services/worker/tsconfig.json =====

{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}


# ===== tsconfig.base.json =====

{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "sourceMap": true
  }
}
