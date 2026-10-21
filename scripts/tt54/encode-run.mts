/**
 * TT54 (FF-07) — drives the export encoder (src/lib/image/encode.ts) over the fixtures from
 * scripts/oracle/encode_fixtures.py and writes DIR/out/*; scripts/oracle/encode_check.py then verifies every output
 * with independent decoders. Usage: node … scripts/tt54/encode-run.mts DIR
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exportExif, injectExifJpeg, injectExifPng, injectExifWebp, avifFromAv1, writeHeifStill, obus, parseSequenceHeader } from "../../src/lib/image/encode.ts";
import { readMetadata } from "../../src/lib/meta/index.ts";

const dir = process.argv[2]; const out = join(dir, "out"); mkdirSync(out, { recursive: true });
const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { images: { name: string; w: number; h: number; bases: Record<string, string> }[]; av1: { name: string; w: number; h: number }[]; heic: { name: string; w: number; h: number }[] };
const cam = readFileSync(join(dir, "exif_src.jpg"));
const ifds = (await readMetadata(new Uint8Array(cam), "exif_src.jpg")).exif!;
if (!ifds?.raw.size) throw new Error("source EXIF not read");
const report: Record<string, unknown> = { outputs: [] as unknown[] };
const outputs = report.outputs as unknown[];

for (const im of man.images) {
  for (const [ext, fmt] of Object.entries(im.bases)) {
    for (const keepLocation of [false, true]) {
      const tiff = exportExif(ifds, { width: im.w, height: im.h, keepLocation })!;
      const base = new Uint8Array(readFileSync(join(dir, `base_${im.name}.${ext}`)));
      const res = fmt === "jpeg" ? injectExifJpeg(base, tiff) : fmt === "png" ? injectExifPng(base, tiff) : injectExifWebp(base, tiff, 1, 1);
      // idempotence: injecting twice must leave exactly one EXIF block
      const twice = fmt === "jpeg" ? injectExifJpeg(res, tiff) : fmt === "png" ? injectExifPng(res, tiff) : injectExifWebp(res, tiff, 1, 1);
      const file = `${im.name}.${ext}.${keepLocation ? "gps" : "nogps"}.${fmt === "jpeg" ? "jpg" : fmt}`;
      writeFileSync(join(out, file), res); writeFileSync(join(out, `twice.${file}`), twice);
      const ours = await readMetadata(res, file);
      outputs.push({ kind: "exif", file, base: `base_${im.name}.${ext}`, fmt, keepLocation, w: im.w, h: im.h, ourOrientation: ours.orientation ?? null, ourGps: !!ours.gps, ourDims: [ours.width, ours.height] });
    }
  }
}

for (const a of man.av1) {
  const chunk = new Uint8Array(readFileSync(join(dir, `av1_${a.name}.obu`)));
  const seqObu = obus(chunk).find((o) => o.type === 1)!;
  const seq = parseSequenceHeader(seqObu.all, seqObu.payload);
  const tiff = exportExif(ifds, { width: seq.width, height: seq.height });
  for (const withExif of [false, true]) {
    const { bytes } = avifFromAv1(chunk, withExif ? tiff : null);
    const file = `${a.name}.${withExif ? "exif" : "plain"}.avif`;
    writeFileSync(join(out, file), bytes);
    const ours = await readMetadata(bytes, file);
    outputs.push({ kind: "avif", file, ref: `av1_${a.name}_ref.png`, src: `av1_${a.name}_src.png`, withExif, seq: { ...seq, obu: undefined }, ourDims: [ours.width, ours.height], ourFormat: ours.format });
  }
}

for (const h of man.heic) {
  const cfg = new Uint8Array(readFileSync(join(dir, `heic_${h.name}.hvcC`)));
  const data = new Uint8Array(readFileSync(join(dir, `heic_${h.name}.hevc`)));
  const tiff = exportExif(ifds, { width: h.w, height: h.h });
  const bytes = writeHeifStill({ itemType: "hvc1", config: cfg, width: h.w, height: h.h, data, exif: tiff, nclx: { primaries: 1, transfer: 13, matrix: 6, fullRange: true } });
  const file = `${h.name}.rewrapped.heic`; writeFileSync(join(out, file), bytes);
  const ours = await readMetadata(bytes, file);
  outputs.push({ kind: "heic", file, ref: `heic_${h.name}_ref.png`, ourDims: [ours.width, ours.height], ourFormat: ours.format });
}

// negative shapes the writer must refuse rather than emit garbage
const neg: Record<string, string> = {};
const tryIt = (k: string, f: () => unknown) => { try { f(); neg[k] = "ACCEPTED"; } catch (e) { neg[k] = `refused: ${(e as Error).message}`; } };
const tiff0 = exportExif(ifds, { width: 1, height: 1 })!;
tryIt("jpeg-not-jpeg", () => injectExifJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), tiff0));
tryIt("png-not-png", () => injectExifPng(new Uint8Array([0xff, 0xd8, 0xff]), tiff0));
tryIt("webp-not-webp", () => injectExifWebp(new Uint8Array(16), tiff0, 1, 1));
tryIt("jpeg-exif-too-big", () => injectExifJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), new Uint8Array(70000)));
tryIt("av1-no-seqhdr", () => avifFromAv1(new Uint8Array([0x12, 0x00, 0x32, 0x01, 0x00])));
tryIt("av1-truncated-seqhdr", () => avifFromAv1(new Uint8Array([0x0a, 0x02, 0x00, 0x00])));
tryIt("av1-forbidden-bit", () => avifFromAv1(new Uint8Array([0x8a, 0x01, 0x00])));
tryIt("av1-leb128-truncated", () => avifFromAv1(new Uint8Array([0x0a, 0x80])));
tryIt("av1-no-size-field", () => avifFromAv1(new Uint8Array([0x08, 0x00, 0x00])));
report.negative = neg;
report.noExifSource = exportExif(new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]), { width: 1, height: 1 });
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ outputs: outputs.length, negative: neg }));
