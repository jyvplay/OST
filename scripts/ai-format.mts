/**
 * Unit suite "ai-format" (TT24): FF-04 Illustrator/EPS detection (src/lib/ai-format.ts), offline.
 *
 * Inputs:
 *  - committed REAL files: file-type's Illustrator 24.1 PDF export, Illustrator 24.1 DOS-EPS and Illustrator 88 EPS (MIT),
 *    and Apache Tika's FreeHand-8 AI-dialect PostScript (Apache-2.0). See scripts/fixtures/ai/README.md.
 *  - CONSTRUCTED edge cases from scripts/fixtures/ai/build.mts (labelled; real .ai files are in scripts/oracle-ai.mts).
 * Expected values come from the bytes (opened in a hex view / grep) and from pypdf, not from the engine.
 * The inflater under test is the one that ships (DecompressionStream), not node:zlib.
 */
import { readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { sniffAi, streamInflate, illustratorVersion, pdfLiteral, MAX_STREAMS } from "../src/lib/ai-format.ts";
import { formatFor } from "../src/lib/forge.ts";
import { guessMime } from "../src/lib/mime.ts";
import * as F from "./fixtures/ai/build.mts";

const { test, finish } = makeHarness("ai-format");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (a !== b) throw new Error(`${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); };
const fx = (n: string) => new Uint8Array(readFileSync(`scripts/fixtures/ai/${n}`));
const sniff = (b: Uint8Array) => sniffAi(b, streamInflate);

await test("real Illustrator output: PDF export, DOS-EPS, Illustrator 88 EPS and FreeHand AI-dialect PostScript", { "FF-04": "full" }, async () => {
  const exp = await sniff(fx("ft-fixture-adobe-illustrator.pdf"));
  // has /PieceInfo <</Illustrator>> but no /AIPrivateData (grep count 0) → a PDF export, not an .ai
  eq(exp.kind, "illustrator-pdf", "Illustrator PDF export kind"); eq(exp.renderable, true, "export renders");
  eq(exp.creator, "Adobe Illustrator 24.1 (Windows)", "creator (pypdf reads the same /Creator)"); eq(exp.illustratorVersion, "24.1", "version");
  const dos = await sniff(fx("ft-fixture.eps"));
  eq(dos.kind, "ai-ps", "DOS-EPS from Illustrator"); eq(dos.renderable, false, "PostScript is not rendered");
  ok(dos.dosEps && dos.dosEps.psOffset === 32 && dos.dosEps.psLength === 331532, `DOS header offsets ${JSON.stringify(dos.dosEps)}`); // 0x20 / 331532 read from the header bytes
  eq(dos.illustratorVersion, "24.1", "DOS-EPS version");
  const i88 = await sniff(fx("ft-fixture2.eps"));
  eq(i88.kind, "ai-ps", "Illustrator 88"); eq(i88.illustratorVersion, "88", "Illustrator 88 version"); eq(i88.title, "earth", "DSC %%Title");
  const fh = await sniff(fx("tika-testAI_PS.ai"));
  eq(fh.kind, "ai-ps", "FreeHand file in the AI dialect (Adobe_level2_AI5 procsets)"); eq(fh.creator, "FreeHand 8.0", "creator");
  eq(fh.illustratorVersion, undefined, "no Illustrator version for FreeHand"); ok(fh.notes.some((n) => n.includes("FreeHand 8.0")), "names the writing app");
  const min = await sniff(fx("ft-fixture-minimal.pdf"));
  eq(min.kind, "pdf", "plain PDF"); eq(min.renderable, true, "plain PDF renders");
});

await test("constructed .ai with and without PDF compatibility (the spec's open-vs-limited split)", { "FF-04": "full" }, async () => {
  const withPdf = await sniff(F.aiWithPdf());
  eq(withPdf.kind, "ai-pdf", "with PDF"); eq(withPdf.renderable, true, "with PDF renders"); eq(withPdf.illustratorVersion, "28.5", "version");
  ok(withPdf.label.includes("PDF compatibility"), withPdf.label);
  const noPdf = await sniff(F.aiWithoutPdf());
  // the placeholder text is only inside a Flate stream, so this also proves the inflate path runs
  eq(noPdf.kind, "ai-no-pdf", "without PDF content"); eq(noPdf.renderable, false, "placeholder page must not be shown as the artwork");
  ok(/limited/.test(noPdf.label), "labelled limited"); eq(noPdf.illustratorVersion, "27.1", "escaped-paren creator");
  const noInflate = await sniffAi(F.aiWithoutPdf());
  eq(noInflate.kind, "ai-pdf", "without an inflater the marker is invisible"); ok(noInflate.notes.some((n) => n.includes("not searched")), "and the sniff says so");
});

await test("creator hidden in a compressed object stream, UTF-16BE strings, junk before the header", { "FF-04": "full" }, async () => {
  const os = await sniff(F.creatorInObjectStream());
  eq(os.kind, "illustrator-pdf", "object-stream creator"); eq(os.illustratorVersion, "CC 23.0", "CC version");
  eq((await sniffAi(F.creatorInObjectStream())).kind, "pdf", "plain-text scan alone cannot see it");
  const u = await sniff(F.utf16Creator());
  eq(u.creator, "Adobe Illustrator 26.0", "UTF-16BE creator"); eq(u.kind, "illustrator-pdf", "utf16 kind");
  const j = await sniff(F.junkBeforeHeader());
  eq(j.kind, "pdf", "header after 300 bytes of junk"); eq(j.pdfVersion, "1.6", "pdf version");
});

await test("FF-12 guards: inflate bomb, 1 000 streams, corrupt Flate data, damaged DOS-EPS, empty and text files", { "FF-04": "full", "FF-12": "partial" }, async () => {
  let t = performance.now();
  const bomb = await sniff(F.inflateBomb());
  const ms = performance.now() - t;
  eq(bomb.kind, "ai-pdf", "bomb file still classified"); ok(ms < 3000, `bomb took ${ms.toFixed(0)} ms`);
  // 64 MiB of zeros must be cut at MAX_STREAM_OUT: assert on the shipping inflater directly
  const { deflateSync } = await import("node:zlib");
  const z = new Uint8Array(deflateSync(new Uint8Array(64 * 1024 * 1024)));
  const cut = await streamInflate(z, 1024 * 1024);
  eq(cut?.length, 1024 * 1024, "inflate stops at the cap");
  // ...and stops *reading* there: output length alone cannot tell a real cap from inflate-everything-then-slice.
  const time = async (cap: number) => { const t0 = performance.now(); await streamInflate(z, cap); return performance.now() - t0; };
  await time(64 * 1024); // warm-up
  const capped = Math.min(await time(64 * 1024), await time(64 * 1024));
  const full = await time(128 * 1024 * 1024);
  ok(capped * 4 < full, `capped inflate ${capped.toFixed(1)} ms vs full ${full.toFixed(1)} ms: the cap does not stop the work`);
  t = performance.now();
  const many = await sniff(F.manyStreams());
  ok(many.notes.some((n) => new RegExp(`Searched ${MAX_STREAMS} compressed`).test(n)), `stream cap: ${many.notes.join(" | ")}`);
  ok(performance.now() - t < 3000, "1 000 streams in < 3 s");
  const bad = await sniff(F.corruptFlate());
  eq(bad.kind, "ai-pdf", "corrupt Flate does not throw"); eq(await streamInflate(new Uint8Array([0x78, 0x9c, 1, 2, 3]), 100), null, "corrupt → null");
  const dmg = await sniff(F.damagedDosEps());
  eq(dmg.kind, "unknown", "damaged DOS-EPS"); ok(dmg.notes[0].includes("outside the file"), dmg.notes[0]);
  eq((await sniff(new Uint8Array(0))).kind, "unknown", "empty file");
  eq((await sniff(new TextEncoder().encode("hello, I am a text file renamed to .ai"))).kind, "unknown", "text file");
  const de = await sniff(F.dosEpsIllustrator());
  eq(de.kind, "ai-ps", "valid DOS-EPS"); eq(de.aiFileFormat, "4.0", "%AI5_FileFormat"); ok(de.boundingBox?.join(",") === "0,0,120,80", "bbox");
  ok(de.notes[0].includes("TIFF preview 16 B"), de.notes[0]);
});

await test("version strings, PDF literal escapes, format registry and MIME", { "FF-04": "full", "FF-14": "partial" }, () => {
  const cases: [string, string | undefined][] = [
    ["Adobe Illustrator 27.1 (Macintosh)", "27.1"], ["Adobe Illustrator CC 2017 (Macintosh)", "CC 2017"], ["Adobe Illustrator CS6 (Windows)", "CS6"],
    ["Adobe Illustrator(R) 8.0", "8.0"], ["Adobe Illustrator 88(TM) 1.6", "88"], ["Adobe Illustrator CS (Windows)", "CS"], ["Inkscape 1.3", undefined], ["FreeHand 8.0", undefined],
  ];
  for (const [c, v] of cases) eq(illustratorVersion(c), v, c);
  eq(pdfLiteral("A\\(b\\)\\\\c\\101"), "A(b)\\cA", "escapes");
  const ai = formatFor("logo.ai"); ok(ai && ai.grade === "B" && /limited/.test(ai.boundary), `ai registry row ${JSON.stringify(ai)}`);
  const eps = formatFor("x.eps"); ok(eps && eps.grade === "E", "eps is metadata-only");
  eq(guessMime("logo.ai"), "application/illustrator", "ai mime"); eq(guessMime("x.eps"), "application/postscript", "eps mime");
});

finish();
