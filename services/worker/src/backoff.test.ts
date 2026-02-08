import { describe, it, expect } from "vitest";
import { backoffMs } from "./backoff.js";

describe("backoffMs", () => {
  it("increases with attempts and caps", () => {
    const rng = () => 0;
    const a1 = backoffMs(1, rng);
    const a2 = backoffMs(2, rng);
    const a3 = backoffMs(3, rng);
    const a10 = backoffMs(10, rng);

    expect(a1).toBe(250);
    expect(a2).toBe(500);
    expect(a3).toBe(1000);
    expect(a10).toBeLessThanOrEqual(15000);
  });

  it("treats attempt 0 the same as attempt 1", () => {
    const rng = () => 0;
    expect(backoffMs(0, rng)).toBe(250);
  });

  it("caps at 15 000 ms (no jitter)", () => {
    const rng = () => 0;
    expect(backoffMs(7, rng)).toBe(15_000); // 250 * 2^6 = 16000 → capped
    expect(backoffMs(20, rng)).toBe(15_000);
  });

  it("adds jitter in [0, 250)", () => {
    const low = backoffMs(1, () => 0);
    const high = backoffMs(1, () => 0.999);
    expect(high - low).toBe(249); // floor(0.999 * 250) = 249
  });
});
