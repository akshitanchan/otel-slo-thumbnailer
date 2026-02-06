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
});
