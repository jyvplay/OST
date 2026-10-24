/**
 * TT54 — dump readMetadata() for every file named on stdin (one path per line) as JSON lines, for the Python
 * oracle (scripts/oracle/meta_check.py). Uint8Array values become {bytes: n, head: [...first 16]} or int lists.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readMetadata } from "../../src/lib/meta/index.ts";

const files = readFileSync(0, "utf8").split("\n").filter(Boolean);
const enc = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return { u8: Array.from(v.length > 4096 ? v.subarray(0, 4096) : v), n: v.length };
  if (Array.isArray(v)) return v.map(enc);
  return v;
};
const ifd = (m?: Map<number, unknown>) => m ? Object.fromEntries([...m].map(([k, v]) => [k, enc(v)])) : undefined;
for (const f of files) {
  const t0 = performance.now();
  try {
    const b = new Uint8Array(readFileSync(f));
    const m = await readMetadata(b, f);
    const out = {
      file: f, ms: +(performance.now() - t0).toFixed(1), kind: m.kind, format: m.format, mime: m.mime, width: m.width, height: m.height,
      displayWidth: m.displayWidth, displayHeight: m.displayHeight, orientation: m.orientation, frames: m.frames,
      duration: m.duration, sampleRate: m.sampleRate, channels: m.channels, bitrate: m.bitrate, codecs: m.codecs,
      pages: m.pages, words: m.words, slides: m.slides, sheets: m.sheets, pageSize: m.pageSize, encrypted: m.encrypted, lines: m.lines,
      tags: m.tags, gps: m.gps, xmp: m.xmp,
      exif: m.exif ? { ifd0: ifd(m.exif.ifd0), exif: ifd(m.exif.exif), gps: ifd(m.exif.gps), ifd1: ifd(m.exif.ifd1), thumb: m.exif.thumbnail?.length ?? 0 } : undefined,
      picture: m.picture ? { mime: m.picture.mime, n: m.picture.data.length, sha: createHash("sha256").update(m.picture.data).digest("hex"), source: m.picture.source } : undefined,
      warnings: m.warnings,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ file: f, crash: String((e as Error).stack ?? e) }) + "\n");
  }
}
