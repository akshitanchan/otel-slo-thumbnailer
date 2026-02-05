import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

export type SniffedType = "jpeg" | "png";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniff(buf: Buffer): SniffedType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return "png";
  return null;
}

export async function saveUploadWithHash(opts: {
  stream: Readable;
  destPath: string;
  maxBytes: number;
}): Promise<{ sha256: string; kind: SniffedType; bytes: number }> {
  await fsp.mkdir(path.dirname(opts.destPath), { recursive: true });

  const hash = crypto.createHash("sha256");
  let header = Buffer.alloc(0);
  let bytes = 0;

  const out = fs.createWriteStream(opts.destPath, { flags: "wx" });

  opts.stream.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > opts.maxBytes) {
      opts.stream.destroy(new Error("file too large"));
      return;
    }

    hash.update(chunk);

    if (header.length < 16) {
      const need = 16 - header.length;
      header = Buffer.concat([header, chunk.subarray(0, Math.min(need, chunk.length))]);
    }
  });

  try {
    await pipeline(opts.stream, out);
  } catch (err) {
    try {
      await fsp.unlink(opts.destPath);
    } catch {
      // ignore
    }
    throw err;
  }

  const kind = sniff(header);
  if (!kind) {
    await fsp.unlink(opts.destPath).catch(() => {});
    throw new Error("unsupported format");
  }

  return {
    sha256: hash.digest("hex"),
    kind,
    bytes
  };
}
