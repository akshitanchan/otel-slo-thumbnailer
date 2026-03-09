import { describe, it, expect } from "vitest";
import { parseSizes } from "./validation.js";

describe("parseSizes", () => {
  it("returns defaults for empty", () => {
    expect(parseSizes(undefined, [64, 256])).toEqual([256]);
    expect(parseSizes("", [64, 256])).toEqual([256]);
  });

  it("parses and dedupes sizes", () => {
    expect(parseSizes("64,256,64", [64, 256, 512])).toEqual([64, 256]);
  });

  it("rejects invalid sizes", () => {
    expect(() => parseSizes("abc", [64, 256])).toThrow("invalid sizes");
    expect(() => parseSizes("128", [64, 256])).toThrow("invalid sizes");
  });

  it("handles a single valid size", () => {
    expect(parseSizes("64", [64, 256])).toEqual([64]);
  });

  it("treats null the same as undefined", () => {
    expect(parseSizes(null, [64, 256])).toEqual([256]);
  });
});
