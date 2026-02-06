export function parseSizes(raw: unknown, allowed: number[]): number[] {
  if (raw === undefined || raw === null || raw === "") return [256];

  const str = String(raw);
  const parts = str.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [256];

  const sizes = parts.map((p) => Number(p));
  if (sizes.some((n) => !Number.isInteger(n))) throw new Error("invalid sizes");
  if (sizes.some((n) => !allowed.includes(n))) throw new Error("invalid sizes");

  const seen = new Set<number>();
  const unique: number[] = [];
  for (const s of sizes) {
    if (!seen.has(s)) {
      seen.add(s);
      unique.push(s);
    }
  }

  return unique.length ? unique : [256];
}
