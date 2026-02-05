import { Pool } from "pg";
import { dbQueryDurationSeconds } from "./metrics.js";

export type Db = {
  pool: Pool;
  close(): Promise<void>;
  query<T>(operation: string, text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export function createDb(databaseUrl: string): Db {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10
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
