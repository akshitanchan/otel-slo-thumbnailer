import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";

import { startOtel, shutdownOtel, createDb, startReadinessLoop, log } from "@thumbnailer/common";
import { loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { runWorker } from "./worker.js";
import { readyGauge, dbQueryDurationSeconds } from "./metrics.js";

await startOtel();

const config = loadConfig();
const db = createDb(config.databaseUrl, (op) => dbQueryDurationSeconds.labels(op).startTimer());

await fs.mkdir(path.join(config.storageDir, "outputs"), { recursive: true });

const stopSignal = { stopped: false };
let wasReady = false;
const readiness = startReadinessLoop(
  async () => { await db.query("readiness_check", "SELECT 1"); },
  2000,
  (v) => {
    readyGauge.set(v ? 1 : 0);
    if (v !== wasReady) {
      log(v ? "info" : "error", "ready_state_changed", { ready: v });
      wasReady = v;
    }
  }
);

const app = await startHttpServer({ port: config.port, getReady: readiness.getReady });

const shutdown = async () => {
  stopSignal.stopped = true;
  readiness.stop();
  try {
    await app.close();
  } catch { /* shutdown best-effort */ }
  try {
    await db.close();
  } catch { /* shutdown best-effort */ }
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
