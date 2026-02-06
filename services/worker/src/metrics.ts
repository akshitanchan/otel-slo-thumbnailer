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

export const queueDepth = new client.Gauge({
  name: "queue_depth",
  help: "number of queued jobs ready to run",
  registers: [registry]
});

export const jobsStuck = new client.Gauge({
  name: "jobs_stuck",
  help: "number of processing jobs older than the stuck threshold",
  registers: [registry]
});

export const dbQueryDurationSeconds = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "db query duration in seconds",
  labelNames: ["operation"] as const,
  registers: [registry],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2]
});
