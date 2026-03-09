import { Pool } from "pg";

export type Db = {
  pool: Pool;
  close(): Promise<void>;
  query<T>(operation: string, text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type TimerFn = (operation: string) => () => void;

// TODO: add connection retry on startup
export function createDb(databaseUrl: string, startTimer?: TimerFn): Db {
  const connectTimeoutMs = Number(process.env.DB_CONNECT_TIMEOUT_MS ?? "2000");
  const statementTimeoutMs = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? "2000");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: connectTimeoutMs,
    options: `-c statement_timeout=${statementTimeoutMs}`
  });

  pool.on("error", (err) => {
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
      const end = startTimer?.(operation);
      try {
        const res = await pool.query(text, params);
        return { rows: res.rows as T[] };
      } finally {
        end?.();
      }
    }
  };
}
