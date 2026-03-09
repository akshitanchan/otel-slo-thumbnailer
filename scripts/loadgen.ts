#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type RunEvent = {
  offset_ms: number;
  sizes: number[];
};

type RunResult = {
  offset_ms: number;
  sizes: number[];
  status: "succeeded" | "failed" | "enqueue_failed" | "timeout";
  job_id?: string;
  enqueue_ms?: number;
  total_ms?: number;
  error?: string;
};

type RunRecord = {
  version: 1;
  started_at: string;
  api_url: string;
  count: number;
  concurrency: number;
  default_sizes: number[];
  events: RunEvent[];
  results: RunResult[];
};

// 1x1 transparent PNG — smallest valid image for testing
const DEFAULT_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+5l9cAAAAASUVORK5CYII=";

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSizes(raw: string | undefined, fallback: number[] = [64, 256]): number[] {
  if (!raw) return fallback;
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  const sizes = parts.map((p) => Number(p)).filter((n) => Number.isInteger(n));
  return sizes.length ? sizes : fallback;
}

async function createJob(apiUrl: string, sizes: number[], image: Buffer) {
  const form = new FormData();
  const blob = new Blob([image], { type: "image/png" });
  form.append("file", blob, "sample.png");

  const start = Date.now();
  const res = await fetch(`${apiUrl}/v1/thumbnails?sizes=${sizes.join(",")}`, {
    method: "POST",
    headers: {
      "X-Tenant-Id": "demo",
      "Idempotency-Key": crypto.randomUUID()
    },
    body: form
  });

  const enqueueMs = Date.now() - start;

  if (res.status !== 202) {
    const body = await res.text();
    throw new Error(`enqueue_failed status=${res.status} body=${body}`);
  }

  const data = (await res.json()) as { job_id: string };
  return { jobId: data.job_id, enqueueMs };
}

async function pollJob(apiUrl: string, jobId: string, timeoutMs: number, pollIntervalMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${apiUrl}/v1/jobs/${jobId}`);
    if (res.status === 404) {
      await sleep(pollIntervalMs);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`poll_failed status=${res.status} body=${body}`);
    }
    const data = (await res.json()) as { status: string };
    if (data.status === "succeeded" || data.status === "failed") {
      return data.status as "succeeded" | "failed";
    }
    await sleep(pollIntervalMs);
  }
  return "timeout" as const;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = String(args.api ?? "http://localhost:8080");
  const count = Number(args.count ?? "100");
  const concurrency = Number(args.concurrency ?? "5");
  const sizes = parseSizes(args.sizes as string | undefined, [64, 256]);
  const recordPath = args.record ? String(args.record) : undefined;
  const replayPath = args.replay ? String(args.replay) : undefined;
  const strict = args.strict === true || String(args.strict ?? "").toLowerCase() === "true";
  const timeoutMs = Number(args["timeout-ms"] ?? "30000");
  const pollIntervalMs = Number(args["poll-interval-ms"] ?? "200");

  const image = Buffer.from(DEFAULT_IMAGE_BASE64, "base64");

  let events: RunEvent[] = [];
  if (replayPath) {
    const replayRaw = await fs.readFile(replayPath, "utf-8");
    const replay = JSON.parse(replayRaw) as RunRecord;
    events = replay.events.slice().sort((a, b) => a.offset_ms - b.offset_ms);
  } else {
    events = Array.from({ length: count }).map(() => ({ offset_ms: 0, sizes }));
  }

  const startedAt = Date.now();
  const results: RunResult[] = [];

  let index = 0;
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= events.length) return;

      const ev = events[i];
      const targetAt = startedAt + (ev.offset_ms ?? 0);
      const waitMs = targetAt - Date.now();
      if (waitMs > 0) await sleep(waitMs);

      const result: RunResult = {
        offset_ms: Math.max(0, Date.now() - startedAt),
        sizes: ev.sizes
      };
      const t0 = Date.now();

      try {
        const { jobId, enqueueMs } = await createJob(apiUrl, ev.sizes, image);
        result.job_id = jobId;
        result.enqueue_ms = enqueueMs;
        const status = await pollJob(apiUrl, jobId, timeoutMs, pollIntervalMs);
        if (status === "timeout") {
          result.status = "timeout";
        } else {
          result.status = status;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.status = "enqueue_failed";
        result.error = msg;
      } finally {
        result.total_ms = Date.now() - t0;
        results.push(result);
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }).map(() => worker());
  await Promise.all(workers);

  const record: RunRecord = {
    version: 1,
    started_at: new Date(startedAt).toISOString(),
    api_url: apiUrl,
    count: results.length,
    concurrency,
    default_sizes: sizes,
    events: results
      .map((r) => ({ offset_ms: r.offset_ms, sizes: r.sizes }))
      .sort((a, b) => a.offset_ms - b.offset_ms),
    results
  };

  if (recordPath) {
    const dir = path.dirname(recordPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(recordPath, JSON.stringify(record, null, 2));
  }

  const summary = results.reduce(
    (acc, r) => {
      acc.total += 1;
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    { total: 0 } as Record<string, number>
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ event: "loadgen_summary", ...summary }, null, 2));

  if (strict) {
    const failed = results.some((r) => r.status !== "succeeded");
    if (failed) process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
