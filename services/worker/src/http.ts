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
