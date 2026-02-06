export type LogLevel = "info" | "error";

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  // keep it structured and boring
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields
    })
  );
}
