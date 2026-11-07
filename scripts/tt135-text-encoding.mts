/**
 * TT135 pure-suite: text encoding (PR-01).
 */
import { makeHarness } from "./harness.mts";
import { decodeText, encodeText, lineEndings, describeDecode, sizeClass, DECODE_LIMIT } from "../src/lib/text-encoding.ts";

const { test, finish } = makeHarness("tt135-text-encoding");

// ── UTF-8 ──────────────────────────────────────────────────────────────────────
await test("PR-14 · valid UTF-8 decodes with strict confidence", { "PR-14": "full" }, () => {
  const bytes = new TextEncoder().encode("Hello, world!");
  const r = decodeText(bytes);
  if (r.encoding !== "utf-8") throw new Error(`expected utf-8, got ${r.encoding}`);
  if (r.confidence !== "strict") throw new Error(`expected strict, got ${r.confidence}`);
  if (r.lossy) throw new Error("UTF-8 decode should not be lossy");
  if (r.text !== "Hello, world!") throw new Error(`wrong text: ${r.text}`);
});

await test("PR-14 · UTF-8 BOM is detected", { "PR-14": "full" }, () => {
  const body = new TextEncoder().encode("hi");
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
  const r = decodeText(bytes);
  if (r.encoding !== "utf-8") throw new Error(`expected utf-8, got ${r.encoding}`);
  if (!r.bom) throw new Error("should detect BOM");
  if (r.confidence !== "bom") throw new Error(`expected bom confidence, got ${r.confidence}`);
});

await test("PR-14 · invalid UTF-8 falls back to Latin-1, flagged lossy", { "PR-14": "full" }, () => {
  // 0xff is not valid UTF-8, but is valid Latin-1
  const bytes = new Uint8Array([0xff, 0xfd]);
  const r = decodeText(bytes);
  if (r.encoding !== "latin1") throw new Error(`expected latin1, got ${r.encoding}`);
  if (!r.lossy) throw new Error("Latin-1 fallback must be flagged lossy");
  if (r.confidence !== "heuristic") throw new Error(`expected heuristic, got ${r.confidence}`);
});

await test("PR-14 · UTF-16LE without BOM is detected by NUL pattern", { "PR-14": "full" }, () => {
  // "AB" in UTF-16LE: 0x41 0x00 0x42 0x00
  const bytes = new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43, 0x00, 0x44, 0x00, 0x45, 0x00, 0x46, 0x00, 0x47, 0x00, 0x48, 0x00]);
  const r = decodeText(bytes);
  if (r.encoding !== "utf-16le") throw new Error(`expected utf-16le, got ${r.encoding}`);
  if (r.lossy) throw new Error("UTF-16LE decode should not be lossy");
});

await test("PR-14 · empty input returns empty text", { "PR-14": "full" }, () => {
  const r = decodeText(new Uint8Array(0));
  if (r.text !== "") throw new Error("empty should give empty text");
  if (r.encoding !== "utf-8") throw new Error(`expected utf-8 for empty, got ${r.encoding}`);
});

await test("PR-14 · binary-looking data is refused, not decoded", { "PR-14": "full" }, () => {
  // Many control bytes in the first 8 KiB
  const bad = new Uint8Array(100);
  for (let i = 0; i < 100; i++) bad[i] = i % 30 + 1; // 0x01–0x1E (mostly control)
  try {
    decodeText(bad);
    throw new Error("should have thrown on binary-looking data");
  } catch (e) {
    if (!(e instanceof Error) || !/binary/i.test(e.message)) throw e;
  }
});

await test("PR-14 · file larger than 8 MiB is refused", { "PR-14": "full" }, () => {
  const big = new Uint8Array(DECODE_LIMIT + 1);
  try {
    decodeText(big);
    throw new Error("should have thrown on oversized file");
  } catch (e) {
    if (!(e instanceof Error) || !/8 MiB/.test(e.message)) throw e;
  }
});

await test("PR-14 · sizeClass classifies warn/refuse correctly", { "PR-14": "full" }, () => {
  if (sizeClass(1024) !== "ok") throw new Error("1KB should be ok");
  if (sizeClass(3 * 1024 * 1024) !== "warn") throw new Error("3MB should be warn");
  if (sizeClass(DECODE_LIMIT + 1) !== "refuse") throw new Error("over limit should refuse");
});

await test("PR-14 · encodeText round-trips UTF-8", { "PR-14": "full" }, () => {
  const text = "Hello, world!";
  const bytes = encodeText(text, "utf-8");
  const r = decodeText(bytes);
  if (r.text !== text) throw new Error(`round-trip failed: ${r.text}`);
});

await test("PR-14 · encodeText with BOM round-trips", { "PR-14": "full" }, () => {
  const text = "Hello";
  const bytes = encodeText(text, "utf-8", true);
  const r = decodeText(bytes);
  if (r.text !== text) throw new Error(`BOM round-trip failed: ${r.text}`);
  if (!r.bom) throw new Error("should detect BOM");
});

await test("PR-14 · encodeText rejects characters > 255 in Latin-1", { "PR-14": "full" }, () => {
  try {
    encodeText("café", "latin1");
    throw new Error("should have thrown on non-Latin-1 characters");
  } catch (e) {
    if (!(e instanceof Error) || !/Latin-1/.test(e.message)) throw e;
  }
});

await test("PR-14 · lineEndings detects dominant ending", { "PR-14": "full" }, () => {
  const crlf = lineEndings("a\r\nb\r\nc");
  if (crlf.dominant !== "crlf") throw new Error(`expected crlf, got ${crlf.dominant}`);
  const lf = lineEndings("a\nb\nc");
  if (lf.dominant !== "lf") throw new Error(`expected lf, got ${lf.dominant}`);
});

await test("PR-14 · describeDecode mentions encoding and how", { "PR-14": "full" }, () => {
  const r = decodeText(new TextEncoder().encode("hi"));
  const d = describeDecode(r);
  if (!d.includes("UTF-8")) throw new Error(`should mention UTF-8: ${d}`);
  if (!d.includes("strict")) throw new Error(`should mention strict: ${d}`);
});

await test("PR-14 · corrupt BOM is refused, not guessed", { "PR-14": "full" }, () => {
  // UTF-8 BOM followed by invalid UTF-8
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0xfe]);
  try {
    decodeText(bytes);
    throw new Error("should have thrown on corrupt BOM");
  } catch (e) {
    if (!(e instanceof Error) || !/byte-order mark/i.test(e.message)) throw e;
  }
});

finish();
