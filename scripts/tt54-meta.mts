/**
 * TT54 — FF-13 metadata + TIFF decoder, FF-07 export encoder, MD-03 recipe engine: unit level with external oracles.
 *
 * Oracles (test-only, never shipped): Pillow 13 (+ libavif) and pillow-heif (libheif + libde265 + x265), exifread,
 * mutagen, FFmpeg via PyAV (libdav1d, libsvtav1), pypdf, python-docx / openpyxl / python-pptx, lxml, numpy.
 * Corpora (not committed): ianare/exif-samples, mutagen tests/data, pdf.js + Apache POI corpora (scripts/corpus/*).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt54-meta.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readMetadata, inflateZlib } from "../src/lib/meta/index.ts";
import { readExif, orientationOf } from "../src/lib/meta/exif.ts";
import { decodeTiff } from "../src/lib/image/tiff.ts";
import { avifFromAv1, injectExifJpeg, injectExifPng, injectExifWebp, exportExif } from "../src/lib/image/encode.ts";
import { parseRecipe, renderRecipe, outputSize } from "../src/lib/photos/recipe.ts";

const { test: test0, finish } = makeHarness("tt54-meta");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const PY = "/home/user/tools/venv/bin/python"; const NODE = ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs"];
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const run = (cmd: string, args: string[], input?: string) => execFileSync(cmd, args, { encoding: "utf8", input, maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"], timeout: 600_000 });
const C = "/home/user/tools/corpus";
const ensure = (dir: string, marker: string, script: string) => { if (!existsSync(join(dir, marker))) run(PY, [script, dir]); };

await test("FF-13 metadata readers agree with independent readers on every field over the real corpora (EXIF / XMP / GPS / thumbnails, image size & frames, audio tags & duration, PDF pages / Info / size / encryption, OOXML core, video size & duration): 0 disagreements", { "FF-13": "full" }, async () => {
  ensure("/tmp/tt54-meta", "expected.json", "scripts/oracle/meta_fixtures.py");
  ensure("/tmp/tt53-media", "vp9-opus.webm", "scripts/oracle/media_fixtures.py");
  const skip = /README|SOURCE\.txt|LICENSE/i;
  const paths = [...["audio", "docx", "exif", "pdf", "pptx", "xlsx"].flatMap((d) => existsSync(join(C, d)) ? readdirSync(join(C, d)).filter((n) => !skip.test(n)).map((n) => join(C, d, n)) : []),
    ...readdirSync("/tmp/tt53-media").filter((n) => /\.(mp4|mov|mkv|webm)$/.test(n)).map((n) => join("/tmp/tt53-media", n)),
    ...readdirSync("/tmp/tt54-meta").filter((n) => n !== "expected.json").map((n) => join("/tmp/tt54-meta", n))];
  ok(paths.length > 1700, `corpus too small: ${paths.length} (run scripts/corpus/fetch-*.py)`);
  const t0 = Date.now(); const dump = run("node", [...NODE, "scripts/tt54/meta-dump.mts"], paths.join("\n")); const dumpMs = Date.now() - t0;
  writeFileSync("/tmp/tt54-meta-dump.jsonl", dump);
  const out = run(PY, ["scripts/oracle/meta_check.py", "/tmp/tt54-meta-dump.jsonl", "--fixtures", "/tmp/tt54-meta", "--json", "/tmp/tt54-meta-res.json"]);
  const bad = Number(/TOTAL_BAD (\d+)/.exec(out)?.[1] ?? NaN); const res = JSON.parse(readFileSync("/tmp/tt54-meta-res.json", "utf8")) as Record<string, { ok: number; bad: number }>;
  const n = (k: string) => res[k]?.ok ?? 0;
  ok(bad === 0, `oracle disagreements: ${bad}\n${out.slice(-2000)}`);
  ok(n("exif.tag") > 3000 && n("xmp.prop") > 500 && n("pdf.pages") > 900 && n("ooxml.core") > 1000 && n("audio.tag") > 100 && n("image.size") > 100 && n("video.duration") >= 10, `coverage dropped: ${JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.ok])))}`);
  ok(dumpMs < 60_000, `metadata pass took ${dumpMs} ms for ${paths.length} files`);
  console.log(`    ${paths.length} files, ${dumpMs} ms; exif.tag ${n("exif.tag")} xmp ${n("xmp.prop")} pdf.info ${n("pdf.info")} ooxml ${n("ooxml.core")} audio.tag ${n("audio.tag")}`);
});

await test("FF-13 TIFF decoder: 34 files (8 corpus LZW+predictor, Pillow-written 1 / L / P / RGB / RGBA / 16-bit × none / LZW / Deflate / PackBits, multi-strip, hand-built planar) bit-exact to Pillow", { "FF-13": "full" }, async () => {
  ensure("/tmp/tt54-tiff", "manifest.json", "scripts/oracle/tiff_fixtures.py");
  const man = JSON.parse(readFileSync("/tmp/tt54-tiff/manifest.json", "utf8")) as string[]; const bad: string[] = [];
  for (const f of man) {
    const want = readFileSync(`/tmp/tt54-tiff/${f}.rgba`); const j = JSON.parse(readFileSync(`/tmp/tt54-tiff/${f}.json`, "utf8"));
    const t = await decodeTiff(new Uint8Array(readFileSync(`/tmp/tt54-tiff/${f}`)), inflateZlib);
    if (t.width !== j.w || t.height !== j.h || !Buffer.from(t.data.buffer, t.data.byteOffset, t.data.byteLength).equals(want)) bad.push(f);
  }
  ok(man.length >= 34 && bad.length === 0, `mismatch: ${bad.join(", ")}`);
});

await test("FF-07 export encoder: EXIF injection into JPEG / PNG / WebP (VP8, VP8L, VP8X+alpha) read back by Pillow + exifread, pixels untouched, one EXIF block after re-injection; AVIF from libsvtav1 key frames decoded by libavif + FFmpeg/dav1d; HEIC re-wrap decoded by libheif pixel-identical", { "FF-07": "full" }, async () => {
  if (!existsSync("/tmp/tt54-enc/manifest.json")) run(PY, ["scripts/oracle/encode_fixtures.py", "/tmp/tt54-enc"]);
  run("node", [...NODE, "scripts/tt54/encode-run.mts", "/tmp/tt54-enc"]);
  let out = ""; try { out = run(PY, ["scripts/oracle/encode_check.py", "/tmp/tt54-enc"]); } catch (e) { out = String((e as { stdout?: string }).stdout ?? e); }
  const j = JSON.parse(out) as { fails: string[]; exif: number; avif: number; heic: number; exifread?: number };
  ok(j.fails.length === 0, j.fails.join("\n"));
  ok(j.exif === 22 && j.avif === 4 && j.heic === 1 && (j.exifread ?? 0) >= 10, `coverage: ${JSON.stringify(j)}`);
});

await test("MD-03 recipe engine: 117 renders vs numpy/Pillow (geometry bit-exact, tone ≤ 1 level, straighten ≥ 30 dB vs Pillow rotate with the crop scale checked by bisection, resolution independence) + 14 properties (rotate⁴ = id, flips, monotone curves on 343 slider combos, hostile sidecars bounded, no prototype keys)", { "MD-03": "full" }, async () => {
  if (!existsSync("/tmp/tt54-rec/sources.json")) run(PY, ["scripts/oracle/recipe_check.py", "--prep", "/tmp/tt54-rec"]);
  run("node", [...NODE, "scripts/tt54/recipe-run.mts", "/tmp/tt54-rec"]);
  let out = ""; try { out = run(PY, ["scripts/oracle/recipe_check.py", "/tmp/tt54-rec"]); } catch (e) { out = String((e as { stdout?: string }).stdout ?? e); }
  const j = JSON.parse(out) as { fails: string[]; cases: number; tone_max_diff: number };
  ok(j.fails.length === 0, j.fails.join("\n")); ok(j.cases >= 117 && j.tone_max_diff <= 1, JSON.stringify(j));
});

await test("FF-13 PDF recovery: a damaged incremental update (bad startxref, trailer without /Info or /ID) is rebuilt by scanning and inherits /Info + /ID from the older trailer — same title as pypdf (strict=False)", { "FF-13": "full" }, async () => {
  const objs = ["1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>\nendobj\n", "4 0 obj\n<< /Title (Recovered Ledger) /Author (Fusion QA) >>\nendobj\n"];
  let body = "%PDF-1.7\n"; const off: number[] = [];
  for (const o of objs) { off.push(body.length); body += o; }
  const x1 = body.length;
  body += `xref\n0 5\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R /Info 4 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] >>\nstartxref\n${x1}\n%%EOF\n`;
  // incremental update: page 3 gets a new MediaBox; its xref offset is wrong and its trailer forgets /Info and /ID
  const o3 = body.length; body += "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 250] >>\nendobj\n";
  body += `xref\n0 1\n0000000000 65535 f \n3 1\n${String(o3).padStart(10, "0")} 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R /Prev ${x1} >>\nstartxref\n${body.length + 12345}\n%%EOF\n`;
  const bytes = new TextEncoder().encode(body); writeFileSync("/tmp/tt54-recover.pdf", bytes);
  const m = await readMetadata(bytes, "r.pdf");
  ok(m.tags?.title === "Recovered Ledger" && m.tags?.creator === "Fusion QA", `tags ${JSON.stringify(m.tags)} warnings ${JSON.stringify(m.warnings)}`);
  ok(m.pages === 1 && JSON.stringify(m.pageSize).includes("400") && JSON.stringify(m.pageSize).includes("250"), `newest page revision expected: ${m.pages} ${JSON.stringify(m.pageSize)}`);
  const py = run(PY, ["-c", "import pypdf,warnings;warnings.simplefilter('ignore');r=pypdf.PdfReader('/tmp/tt54-recover.pdf',strict=False);print((r.metadata or {}).get('/Title'));print(r.pages[0].mediabox.width)"]).trim().split("\n");
  ok(py[0] === "Recovered Ledger" && Number(py[1]) === 400, `pypdf disagrees: ${py.join(" | ")}`);
});

await test("Negative shapes: 22 hostile inputs to the readers / decoder / writers are refused or bounded — no crash, no hang, no garbage output", { "FF-13": "full", "FF-07": "full", "MD-03": "full" }, async () => {
  const t0 = Date.now(); const res: Record<string, string> = {};
  const tryA = async (k: string, f: () => unknown) => { try { const v = await f(); res[k] = `ok:${typeof v === "object" && v && "warnings" in v ? (v as { warnings: string[] }).warnings.length : "-"}`; } catch (e) { res[k] = `refused:${(e as Error).message.slice(0, 60)}`; } };
  const u8 = (a: number[]) => new Uint8Array(a);
  // IFD that points at itself (loop), absurd counts, offsets past the end
  const loop = u8([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0]);
  await tryA("exif-ifd-loop", () => readExif(loop));
  await tryA("exif-huge-count", () => readExif(u8([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 1, 0x0f, 0, 2, 0x7f, 0xff, 0xff, 0xff, 0, 0, 0, 0x20, 0, 0, 0, 0])));
  await tryA("jpeg-truncated", () => readMetadata(u8([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45, 0x78]), "x.jpg"));
  await tryA("png-bad-chunk-len", () => readMetadata(u8([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0x7f, 0xff, 0xff, 0xff, 0x49, 0x48, 0x44, 0x52]), "x.png"));
  await tryA("mp4-box-size-overflow", () => readMetadata(u8([0, 0, 0, 1, 0x66, 0x74, 0x79, 0x70, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), "x.mp4"));
  await tryA("mkv-vint-zero", () => readMetadata(u8([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]), "x.mkv"));
  await tryA("mp3-id3-size-past-end", () => readMetadata(u8([0x49, 0x44, 0x33, 4, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f, 0x54]), "x.mp3"));
  await tryA("flac-no-streaminfo", () => readMetadata(u8([0x66, 0x4c, 0x61, 0x43, 0x84, 0, 0, 0]), "x.flac"));
  await tryA("pdf-garbage", () => readMetadata(new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >>\ntrailer << /Root 1 0 R /Size -5 >>\n%%EOF"), "x.pdf"));
  await tryA("docx-not-zip", () => readMetadata(new TextEncoder().encode("PK\x03\x04garbage"), "x.docx"));
  await tryA("xmp-billion-laughs", () => readMetadata(new TextEncoder().encode(`<?xpacket begin=""?><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:title="&b;"/></rdf:RDF></x:xmpmeta>`), "x.xmp"));
  const tiffHdr = (ifd: number[]) => u8([0x49, 0x49, 42, 0, 8, 0, 0, 0, ...ifd]);
  const ent = (tag: number, type: number, count: number, v: number) => [tag & 255, tag >> 8, type, 0, count & 255, (count >> 8) & 255, 0, 0, v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  await tryA("tiff-strip-outside", () => decodeTiff(tiffHdr([4, 0, ...ent(256, 3, 1, 4), ...ent(257, 3, 1, 4), ...ent(273, 4, 1, 999999), ...ent(279, 4, 1, 16), 0, 0, 0, 0]), inflateZlib));
  await tryA("tiff-gigapixel", () => decodeTiff(tiffHdr([2, 0, ...ent(256, 4, 1, 100000), ...ent(257, 4, 1, 100000), 0, 0, 0, 0]), inflateZlib));
  await tryA("tiff-tiled", () => decodeTiff(tiffHdr([3, 0, ...ent(256, 3, 1, 4), ...ent(257, 3, 1, 4), ...ent(322, 3, 1, 16), 0, 0, 0, 0]), inflateZlib));
  await tryA("tiff-jpeg-compression", () => decodeTiff(tiffHdr([3, 0, ...ent(256, 3, 1, 4), ...ent(257, 3, 1, 4), ...ent(259, 3, 1, 7), 0, 0, 0, 0]), inflateZlib));
  await tryA("tiff-cmyk", () => decodeTiff(tiffHdr([3, 0, ...ent(256, 3, 1, 4), ...ent(257, 3, 1, 4), ...ent(262, 3, 1, 5), 0, 0, 0, 0]), inflateZlib));
  await tryA("tiff-lzw-bad-code", async () => { const { lzw } = await import("../src/lib/image/tiff.ts"); return lzw(u8([0xff, 0xff, 0xff, 0xff]), 64); });
  await tryA("avif-forbidden-bit", () => avifFromAv1(u8([0x8a, 0x01, 0x00])));
  await tryA("jpeg-inject-not-jpeg", () => injectExifJpeg(u8([0x89, 0x50]), u8([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
  await tryA("png-inject-not-png", () => injectExifPng(u8([0xff, 0xd8]), u8([1])));
  await tryA("webp-inject-not-webp", () => injectExifWebp(new Uint8Array(20), u8([1]), 1, 1));
  await tryA("recipe-hostile", () => { const r = parseRecipe({ rotate: 9, crop: { x: 2, y: 2, w: -1, h: 1e9 }, exposure: "9", preset: "constructor" }); const o = renderRecipe({ width: 3, height: 2, data: new Uint8ClampedArray(24) }, r); const s = outputSize(3, 2, r); if (o.width !== s.width || o.height !== s.height || !o.width) throw new Error("bad output"); return r; });
  // Orientation outside 1..8 (0, 9) is not a transform: treated as upright, never passed to the renderer
  const orient = (v: number) => orientationOf(readExif(u8([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, v, 0, 0, 0, 0, 0, 0, 0])));
  ok(orient(0) === 1 && orient(9) === 1 && orient(6) === 6, `orientation 0/9/6 → ${orient(0)}/${orient(9)}/${orient(6)}`);
  ok(exportExif(u8([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]), { width: 1, height: 1 }) === null, "empty EXIF must produce no block");
  const ms = Date.now() - t0;
  const mustRefuse = ["tiff-strip-outside", "tiff-gigapixel", "tiff-tiled", "tiff-jpeg-compression", "tiff-cmyk", "avif-forbidden-bit", "jpeg-inject-not-jpeg", "png-inject-not-png", "webp-inject-not-webp"];
  ok(Object.keys(res).length === 22, `count ${Object.keys(res).length}`);
  ok(mustRefuse.every((k) => res[k].startsWith("refused")), JSON.stringify(res));
  // refused for the RIGHT reason (an incidental later failure would hide a removed guard)
  const why: Record<string, string> = { "tiff-strip-outside": "outside", "tiff-gigapixel": "megapixels", "tiff-tiled": "tiled", "tiff-jpeg-compression": "compression 7", "tiff-cmyk": "photometric", "tiff-lzw-bad-code": "LZW", "avif-forbidden-bit": "forbidden" };
  for (const [k, w] of Object.entries(why)) ok(res[k].includes(w), `${k} refused for the wrong reason: ${res[k]}`);
  ok(res["exif-ifd-loop"].startsWith("ok") && res["xmp-billion-laughs"].startsWith("ok") && res["recipe-hostile"].startsWith("ok"), JSON.stringify(res));
  ok(ms < 5000, `took ${ms} ms`);
  console.log(`    ${JSON.stringify(res)}`);
});

finish();
