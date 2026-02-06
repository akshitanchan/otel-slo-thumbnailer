export function backoffMs(attempt: number, rng: () => number = Math.random): number {
  const base = 250;
  const cap = 15_000;
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = Math.floor(rng() * 250);
  return exp + jitter;
}
