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
