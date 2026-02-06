import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Client } from "pg";

type LogLevel = "info" | "error";

function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  };
  console.log(JSON.stringify(line));
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function ensureSchemaMigrations(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getApplied(client: Client): Promise<Set<string>> {
  const res = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set(res.rows.map((r) => r.version));
}

function isMigrationFile(name: string): boolean {
  return /^\d+_.+\.sql$/.test(name);
}

async function main() {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const migrationsDir = process.env.MIGRATIONS_DIR ?? path.resolve("db/migrations");

  const client = new Client({
    connectionString: databaseUrl,
    statement_timeout: 15_000
  });

  log("info", "migrate_start", { migrationsDir });

  await client.connect();
  try {
    await ensureSchemaMigrations(client);

    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && isMigrationFile(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const applied = await getApplied(client);

    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) {
        log("info", "migration_skip", { version, file });
        continue;
      }

      const fullPath = path.join(migrationsDir, file);
      const sql = await fs.readFile(fullPath, "utf8");

      log("info", "migration_apply_begin", { version, file });

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        log("info", "migration_applied", { version, file });
      } catch (err) {
        await client.query("ROLLBACK");
        log("error", "migration_failed", {
          version,
          file,
          error: err instanceof Error ? err.message : String(err)
        });
        throw err;
      }
    }

    log("info", "migrate_done", { total: files.length });
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((err) => {
  log("error", "migrate_fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
