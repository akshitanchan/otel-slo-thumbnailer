import process from "node:process";
import { startOtel, shutdownOtel } from "./otel.js";
import { startReadinessLoop } from "./readiness.js";

await startOtel();

const { buildServer } = await import("./server.js");

const { app, db, config } = await buildServer({
  getReady: () => readiness?.getReady() ?? false,
});

const readiness = startReadinessLoop(
  async () => {
    await db.query("readiness_check", "SELECT 1");
  },
  2000
);

const close = async () => {
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
  close().finally(() => process.exit(0)).catch(() => process.exit(1));
});
process.on("SIGTERM", () => {
  close().finally(() => process.exit(0)).catch(() => process.exit(1));
});

await app.listen({ host: "0.0.0.0", port: config.port });
