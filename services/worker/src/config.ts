import process from "node:process";

export type Config = {
  port: number;
  databaseUrl: string;
  storageDir: string;

  pollMs: number;
  claimBackoffMs: number;

  jpegQuality: number;
  allowedSizes: number[];
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? "8081"),
    databaseUrl: requiredEnv("DATABASE_URL"),
    storageDir: process.env.STORAGE_DIR ?? "/data",

    pollMs: Number(process.env.POLL_MS ?? "200"),
    claimBackoffMs: Number(process.env.CLAIM_BACKOFF_MS ?? "500"),

    jpegQuality: 80,
    allowedSizes: [64, 128, 256, 512]
  };
}
