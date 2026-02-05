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
