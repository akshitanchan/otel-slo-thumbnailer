import { Pool } from "pg";
import { dbQueryDurationSeconds } from "./metrics.js";

export type Db = {
  pool: Pool;
  close(): Promise<void>;
  query<T>(operation: string, text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export function createDb(databaseUrl: string): Db {
  const connectTimeoutMs = Number(process.env.DB_CONNECT_TIMEOUT_MS ?? "2000");
  const statementTimeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? "2000");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: connectTimeoutMs,
    options: `-c statement_timeout=${statementTimeoutMs}`
  });

  pool.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "db_pool_error",
        error: err instanceof Error ? err.message : String(err)
      })
    );
  });

  return {
    pool,
    async close() {
      await pool.end();
    },
    async query<T>(operation: string, text: string, params: unknown[] = []) {
      const end = dbQueryDurationSeconds.labels(operation).startTimer();
      try {
        const res = await pool.query(text, params);
        return { rows: res.rows as T[] };
      } finally {
        end();
      }
    }
  };
}
