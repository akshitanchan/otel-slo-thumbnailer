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
