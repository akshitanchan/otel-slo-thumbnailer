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
