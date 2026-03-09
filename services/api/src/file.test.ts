import { describe, it, expect } from "vitest";
import { sniff } from "./file.js";

describe("sniff", () => {
  it("detects JPEG magic bytes", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(sniff(buf)).toBe("jpeg");
  });

  it("detects PNG magic bytes", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniff(buf)).toBe("png");
  });

  it("returns null for unknown formats", () => {
    expect(sniff(Buffer.from([0x00, 0x00, 0x00]))).toBeNull();
    expect(sniff(Buffer.from("GIF89a"))).toBeNull();
  });

  it("returns null for buffers too short to identify", () => {
    expect(sniff(Buffer.alloc(0))).toBeNull();
    expect(sniff(Buffer.from([0xff, 0xd8]))).toBeNull(); // JPEG needs 3 bytes
  });

  it("rejects JPEG-like bytes with wrong third byte", () => {
    // starts like JPEG (FF D8) but third byte isn't FF
    expect(sniff(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
  });

  it("rejects truncated PNG header", () => {
    // first 4 bytes of PNG magic, but not all 8
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
