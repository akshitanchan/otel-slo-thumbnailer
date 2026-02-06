import { describe, it, expect } from "vitest";
import { parseSizes } from "./validation.js";

describe("parseSizes", () => {
  it("parses array sizes and dedupes", () => {
    expect(parseSizes([64, 256, 64], [64, 256, 512])).toEqual([64, 256]);
  });

  it("rejects invalid sizes", () => {
    expect(() => parseSizes(["x"], [64, 256])).toThrow("invalid sizes");
    expect(() => parseSizes([128], [64, 256])).toThrow("invalid sizes");
  });
});
