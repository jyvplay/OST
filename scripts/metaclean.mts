/**
 * TT18 privacy suite 3 — metadata cleaner (src/lib/privacy/metaclean.ts) against independent decoders.
 * Fixtures and verification: scripts/oracles/metaclean_oracle.py (Pillow, python-docx, openpyxl,
 * python-pptx, svgelements). Pixels/text must be identical; metadata must be gone.
 *
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/metaclean.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { cleanMetadata, readZip, writeZip, detectKind, minimalOrientationExif } from "../src/lib/privacy/metaclean.ts";

const { test, finish } = makeHarness("metaclean");
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const dir = mkdtempSync(join(tmpdir(), "metaclean-"));
const src = join(dir, "src"); const out = join(dir, "clean");
mkdirSync(out);
const py = (...a: string[]) => JSON.parse(execFileSync(PY, ["scripts/oracles/metaclean_oracle.py", ...a], { encoding: "utf8", timeout: 120_000 }));

const made = py("make", src).files as string[];
const reports: Record<string, Awaited<ReturnType<typeof cleanMetadata>>["report"]> = {};
for (const f of made) {
  const r = await cleanMetadata(new Uint8Array(readFileSync(join(src, f))), f);
  reports[f] = r.report;
  writeFileSync(join(out, f), r.data);
}
const verdict = py("verify", src, out) as Record<string, { problems: string[]; info: Record<string, unknown> }>;
const clean = (f: string) => assert.deepEqual(verdict[f].problems, [], `${f}: ${JSON.stringify(verdict[f])}`);
const said = (f: string, re: RegExp) => assert.ok(reports[f].removed.some((x) => re.test(x)), `${f} report should mention ${re}: ${JSON.stringify(reports[f].removed)}`);

await test("JPEG: identical pixels (Pillow); camera, author, date, software, GPS, XMP, COM, IPTC gone; Orientation=6 kept alone", { "SC-12": "full" }, () => {
  clean("photo.jpg");
  said("photo.jpg", /Make: Canon/); said("photo.jpg", /GPS/); said("photo.jpg", /Artist: Jane Doe/); said("photo.jpg", /XMP/); said("photo.jpg", /comment/i); said("photo.jpg", /APP13/);
  assert.ok(reports["photo.jpg"].kept.some((k) => /Orientation=6/.test(k)));
});

await test("PNG / WebP / GIF: identical decoded frames; text, eXIf, tIME, EXIF/XMP chunks, comments and XMP app-ext gone; GIF loop kept", { "SC-12": "full" }, () => {
  for (const f of ["pic.png", "img.webp", "anim.gif"]) clean(f);
  said("pic.png", /tEXt "Author": Jane Doe/); said("pic.png", /tIME/); said("pic.png", /iTXt/); said("pic.png", /zTXt/); said("pic.png", /eXIf/);
  said("img.webp", /EXIF/); said("img.webp", /XMP/);
  said("anim.gif", /comment/); said("anim.gif", /XMP/);
});

await test("DOCX / XLSX / PPTX: text and values identical in python-docx/openpyxl/python-pptx; authors, rsids, custom props, absPath, revision GUID gone; zip normalised", { "SC-12": "full" }, () => {
  for (const f of ["doc.docx", "book.xlsx", "deck.pptx"]) clean(f);
  said("doc.docx", /core property creator: Jane Doe/); said("doc.docx", /revision-session ids/); said("doc.docx", /docProps\/custom\.xml/);
  said("book.xlsx", /local folder C:\\Users\\jane/); said("book.xlsx", /comment authors Jane Doe/); said("book.xlsx", /revision pointer/);
  said("deck.pptx", /core property creator: Jane Doe/);
});

await test("SVG: same shapes (svgelements); comments, <metadata>, RDF, sodipodi/inkscape elements+attributes, local path gone; <title> kept", { "SC-12": "full" }, () => {
  clean("draw.svg");
  said("draw.svg", /<metadata>/); said("draw.svg", /editor attribute/);
});

await test("idempotent: cleaning a cleaned file changes nothing and reports nothing new to remove", { "SC-12": "partial" }, async () => {
  for (const f of made) {
    const once = new Uint8Array(readFileSync(join(out, f)));
    const twice = await cleanMetadata(once, f);
    assert.equal(Buffer.compare(Buffer.from(twice.data), Buffer.from(once)), 0, `${f} second pass changed bytes`);
    const meaningful = twice.report.removed.filter((x) => !/zip timestamps/.test(x));
    assert.deepEqual(meaningful, [], `${f} second pass found ${meaningful}`);
  }
});

await test("refusals and hostile input: PDF unchanged + explained; truncated JPEG/PNG and corrupt zip throw cleanly; zip bomb and ../ entries refused", { "SC-12": "full" }, async () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj<</Author(Jane Doe)>>endobj\n%%EOF");
  const r = await cleanMetadata(pdf, "x.pdf");
  assert.equal(r.report.supported, false); assert.equal(Buffer.compare(Buffer.from(r.data), Buffer.from(pdf)), 0);
  assert.match(r.report.kept.join(" "), /Refusing rather than half-cleaning/);
  const jpg = new Uint8Array(readFileSync(join(src, "photo.jpg")));
  await assert.rejects(cleanMetadata(jpg.subarray(0, 40), "t.jpg"), /out of bounds|marker expected/);
  const png = new Uint8Array(readFileSync(join(src, "pic.png")));
  await assert.rejects(cleanMetadata(png.subarray(0, 60), "t.png"), /out of bounds|truncated/);
  const docx = new Uint8Array(readFileSync(join(src, "doc.docx")));
  // flip a byte INSIDE entry data (my first version flipped an EOCD field the reader never uses — undetectable by design)
  const bad = docx.slice(); bad[Math.floor(bad.length / 2)] ^= 0xff;
  await assert.rejects(cleanMetadata(bad, "bad.docx"), /CRC|corrupt|invalid|incorrect|zlib|deflate|data/i);
  const gif = new Uint8Array(readFileSync(join(src, "anim.gif")));
  await assert.rejects(cleanMetadata(gif.subarray(0, gif.length - 1), "t.gif"), /truncated|past the end/);
  const webp = new Uint8Array(readFileSync(join(src, "img.webp")));
  await assert.rejects(cleanMetadata(webp.subarray(0, webp.length - 4), "t.webp"), /RIFF size/);
  const bomb = await writeZip([{ name: "word/document.xml", data: new Uint8Array(20 * 1024 * 1024) }]);
  await assert.rejects(readZip(bomb), /bomb guard/);
  const evil = await writeZip([{ name: "../../etc/passwd", data: new TextEncoder().encode("x") }]);
  await assert.rejects(readZip(evil), /escapes/);
  assert.equal(detectKind(new Uint8Array([1, 2, 3])), "unknown");
  const ex = minimalOrientationExif(8);
  assert.equal(ex.length, 32); assert.equal(ex[ex.length - 8], 0); assert.equal(ex[ex.length - 7], 8);
});

console.log("  artifacts:", dir, readdirSync(out).join(", "));
finish();
