import process from "node:process";

export type Config = {
  port: number;
  databaseUrl: string;
  storageDir: string;
  maxUploadBytes: number;
  allowedSizes: number[];
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? "8080"),
    databaseUrl: requiredEnv("DATABASE_URL"),
    storageDir: process.env.STORAGE_DIR ?? "/data",
    maxUploadBytes: 5 * 1024 * 1024,
    allowedSizes: [64, 128, 256, 512]
  };
}
