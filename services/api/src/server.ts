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
