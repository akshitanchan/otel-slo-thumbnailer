export function parseSizes(value: unknown, allowed: number[]): number[] {
  if (!Array.isArray(value)) throw new Error("invalid sizes");
  const sizes = value.map((x) => Number(x));
  if (sizes.some((n) => !Number.isInteger(n))) throw new Error("invalid sizes");
  if (sizes.some((n) => !allowed.includes(n))) throw new Error("invalid sizes");
  const seen = new Set<number>();
  const out: number[] = [];
  for (const s of sizes) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.length ? out : [256];
}
