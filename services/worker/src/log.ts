import { context, trace } from "@opentelemetry/api";

export type LogLevel = "info" | "error";

function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...activeTraceIds(),
      ...fields
    })
  );
}
