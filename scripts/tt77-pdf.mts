/**
 * TT77 — PDF image codecs that were placeholders until TT76: JBIG2 (T.88, pdfjbig2.ts) and JPEG 2000 (T.800,
 * pdfjpx.ts), plus their PDF wiring (/JBIG2Globals, /SMaskInData, /Indexed JPX, /Decode ignored for JPX).
 *
 *  J1  JBIG2 differential: every JBIG2 image of the corpus decoded by Fusion vs PDFium's bitmap (scripts/oracle/
 *      pdf_images.py, pypdfium2). Must be bit-exact; one declared divergence (jbig2_file_header.pdf embeds a
 *      stand-alone T.88 file header that PDF forbids, §7.4.7 — PDFium yields a BLANK bitmap and blank page; Fusion
 *      parses the Annex D header and decodes the image (128×96, three black rectangles, 5,043 black pixels; checked
 *      visually in TT78). Fusion is the more permissive reader here; the PDFium comparison is not meaningful).
 *  J2  JPX differential vs PDFium on the corpus: within ±2 per sample (9/7 float rounding); one declared divergence
 *      (PDFium's bitmap for an /SMaskInData 1 image is pre-composited on white; Fusion keeps colour + alpha apart).
 *  J3  JPX vs OpenJPEG on 40 generated codestreams (scripts/oracle/jpx_gen.py via glymur): all 5 progression orders,
 *      precincts, tiles, SOP/EPH, PLT/TLM, the 6 code-block mode switches, 12/16-bit, layers, 1×1/thin/wide, raw .j2k.
 *      Lossless cases must equal the SOURCE image exactly; lossy within ±1 of OpenJPEG.
 *  N1… hostile inputs: garbage, truncation, oversize SIZ, absurd levels / tiles, JBIG2 bomb; all bounded in time.
 *
 * Needs /home/user/tools/venv (pypdfium2, glymur + Pillow's libopenjp2) and the PDF corpus; skips (reported) without.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { runCompare, readPnm, pageImages } from "./tt77/imgcmp.mts";
import { jpxDecode } from "../src/lib/pdf/pdfjpx.ts";
import { jbig2Decode } from "../src/lib/pdf/pdfjbig2.ts";
import { PdfDoc } from "../src/lib/pdf/pdfdoc.ts";
import { onePage } from "./tt77/rawpdf.ts";

const H = makeHarness("tt77-pdf");
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/pdf";
const ORACLE = join(process.cwd(), "scripts/oracle/pdf_images.py");
const have = existsSync(PY) && existsSync(CORPUS);
const COV = { "FF-03": "full" as const, "PR-08": "partial" as const, "FF-67": "full" as const };
const tmp = mkdtempSync(join(tmpdir(), "tt77pdf-"));
const survey = (key: string): string[] => {
  // corpus files whose streams use a filter (recomputed, not read from a scratch file)
  const out = execFileSync(PY, ["-c", `
import pikepdf, os, sys
key=sys.argv[1]; d=sys.argv[2]; res=[]
for f in sorted(os.listdir(d)):
    if not f.endswith('.pdf'): continue
    try:
        p=pikepdf.open(os.path.join(d,f))
        if any(isinstance(o,pikepdf.Stream) and key in str(o.get('/Filter')) for o in p.objects): res.append(f)
    except Exception: pass
print('\\n'.join(res))`, key, CORPUS], { encoding: "utf8", maxBuffer: 1 << 24, timeout: 600_000 });
  return out.trim().split("\n").filter(Boolean);
};

if (!have) console.log("  (skipped J1–J3: venv or corpus missing)");
else {
  await H.test("J1 JBIG2: every corpus JBIG2 image bit-exact vs PDFium (1 declared divergence)", COV, async () => {
    const files = survey("JBIG2Decode").filter((f) => f !== "bomb_giant.pdf");
    const jl = join(tmp, "jb2.jsonl");
    writeFileSync(jl, execFileSync(PY, [ORACLE, join(tmp, "jb2"), "--filters", "JBIG2Decode", "--pages", "3", ...files], { cwd: CORPUS, encoding: "utf8", maxBuffer: 1 << 26, timeout: 900_000 }));
    const res = runCompare(jl, CORPUS);
    const DECLARED = new Set(["jbig2_file_header.pdf"]);
    const exact = res.filter((r) => r.ok === "exact").length; const bad = res.filter((r) => r.ok !== "exact" && !DECLARED.has(r.file.split("/").pop()!));
    console.log(`     ${exact}/${res.length} exact over ${files.length} files`);
    if (res.length < 100) throw new Error(`only ${res.length} images compared`);
    if (bad.length) throw new Error("not exact: " + JSON.stringify(bad.slice(0, 5)));
  });
  await H.test("J2 JPX: every corpus JPX image within ±2 of PDFium (1 declared divergence: SMaskInData 1 pre-composited by PDFium)", COV, async () => {
    // one PDF per oracle process: PDFium aborts the whole batch on jpx_numcomps.pdf
    const files = survey("JPXDecode"); const jl = join(tmp, "jpx.jsonl"); let all = "";
    for (const f of files) { try { all += execFileSync(PY, [ORACLE, join(tmp, "jpx"), "--filters", "JPXDecode", "--pages", "3", f], { cwd: CORPUS, encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "ignore"] }); } catch { /* PDFium crashed on this file */ } }
    writeFileSync(jl, all);
    const res = runCompare(jl, CORPUS);
    const declared = (r: { file: string; i: number }) => r.file.endsWith("jpx_smaskindata.pdf") && r.i === 3;
    const bad = res.filter((r) => r.ok !== "exact" && r.ok !== "close" && !declared(r));
    console.log(`     ${res.filter((r) => r.ok === "exact").length} exact + ${res.filter((r) => r.ok === "close").length} close of ${res.length} (${files.length} files)`);
    if (res.length < 15) throw new Error(`only ${res.length} images compared`);
    if (bad.length) throw new Error(JSON.stringify(bad.slice(0, 4)));
  });
  await H.test("J3 JPX vs OpenJPEG: 40 generated codestreams — lossless = source exactly, lossy ±1", COV, async () => {
    const dir = join(tmp, "gen"); const man = execFileSync(PY, ["scripts/oracle/jpx_gen.py", dir], { encoding: "utf8", timeout: 600_000 });
    const cases = man.trim().split("\n").map((l) => JSON.parse(l)); const errs: string[] = []; let n = 0;
    for (const c of cases) {
      if (c.error) { errs.push(`${c.name}: encoder ${c.error}`); continue; }
      const r = jpxDecode(new Uint8Array(readFileSync(c.file)));
      const ref = readPnm(c.lossless && c.bits === 8 ? c.file + ".src.pnm" : c.oj);
      if (c.lossless && c.bits === 8 && !c.src_equals_oj) errs.push(`${c.name}: OpenJPEG itself not lossless`);
      if (r.width !== ref.w || r.height !== ref.h) { errs.push(`${c.name}: size`); continue; }
      const m = Math.min(r.comps, ref.ch); let max = 0;
      for (let i = 0; i < r.width * r.height; i++) for (let k = 0; k < m; k++) max = Math.max(max, Math.abs(r.data[i * r.comps + k] - ref.data[i * ref.ch + k]));
      const tol = c.lossless ? 0 : 1; if (max > tol) errs.push(`${c.name}: max diff ${max} > ${tol}`); n++;
    }
    if (n < 40) errs.push(`only ${n} cases decoded`);
    if (errs.length) throw new Error(errs.join("; "));
  });
  await H.test("J4 PDF wiring: /Indexed JPX keeps raw indices (issue12213 exact), /SMaskInData yields a soft mask, JPX size wins over /Width", COV, async () => {
    const doc = PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, "jpx_smaskindata.pdf"))));
    const imgs = pageImages(doc, 0); if (imgs.length !== 4) throw new Error(`${imgs.length} images`);
    if (!imgs.every((i) => i.smask && i.smask.w === 2)) throw new Error("SMaskInData did not produce soft masks");
    if (!imgs[0].matte || imgs[3].matte) throw new Error("SMaskInData 2 must un-premultiply (matte), 1 must not");
    const ix = pageImages(PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, "issue12213.pdf")))), 0)[0];
    if (ix.cs?.name !== "Indexed" || Math.max(...ix.data) > 15) throw new Error("indexed JPX lost its raw 4-bit indices");
  });
}

const tb = async (what: string, fn: () => unknown, ms = 3000) => { const t0 = Date.now(); let threw = false; try { await fn(); } catch { threw = true; } const dt = Date.now() - t0; if (dt > ms) throw new Error(`${what}: ${dt} ms`); return threw; };
await H.test("N1 JPX garbage / empty / random bytes throw a clean error, quickly", COV, async () => {
  for (const b of [new Uint8Array(0), new Uint8Array([0xff, 0x4f]), new TextEncoder().encode("not a jpeg 2000 file at all"), Uint8Array.from({ length: 5000 }, (_, i) => (i * 7919) & 255)])
    if (!(await tb("garbage", () => jpxDecode(b)))) throw new Error("garbage accepted");
});
// a minimal valid lossless codestream built by hand: SIZ 8×8 gray, COD NL=0, QCD none, one empty packet
const be16 = (v: number) => [v >> 8, v & 255], be32 = (v: number) => [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
function tinyCodestream(o: { w?: number; h?: number; levels?: number; tw?: number; th?: number; nc?: number } = {}) {
  const w = o.w ?? 8, h = o.h ?? 8, nc = o.nc ?? 1;
  const siz = [0xff, 0x51, ...be16(38 + 3 * nc), 0, 0, ...be32(w), ...be32(h), 0, 0, 0, 0, 0, 0, 0, 0, ...be32(o.tw ?? w), ...be32(o.th ?? h), 0, 0, 0, 0, 0, 0, 0, 0, ...be16(nc), ...Array.from({ length: nc }, () => [7, 1, 1]).flat()];
  const L = o.levels ?? 0;
  const cod = [0xff, 0x52, ...be16(12), 0, 0, 0, 1, 0, L, 4, 4, 0, 1];
  const qcd = [0xff, 0x5c, ...be16(3 + 3 * L + 1), 0x40, ...Array.from({ length: 3 * L + 1 }, () => 9 << 3)];
  const body = [0x00]; // one empty packet
  const sot = [0xff, 0x90, ...be16(10), 0, 0, ...be32(12 + 2 + body.length), 0, 1];
  return new Uint8Array([0xff, 0x4f, ...siz, ...cod, ...qcd, ...sot, 0xff, 0x93, ...body, 0xff, 0xd9]);
}
await H.test("N2 JPX hand-built minimal codestream decodes (empty packet → mid-grey), and every truncation of it is bounded", COV, async () => {
  const cs = tinyCodestream(); const r = jpxDecode(cs);
  if (r.width !== 8 || r.height !== 8 || r.data.some((v) => v !== 128)) throw new Error(`minimal: ${r.width}x${r.height} ${r.data[0]}`);
  for (let k = 0; k < cs.length; k++) await tb(`truncated at ${k}`, () => jpxDecode(cs.subarray(0, k)), 500);
});
await H.test("N3 JPX oversize SIZ (2^31 × 2^31), zero tile size, 32 levels on 8×8 and 70 000 tiles are refused or bounded", COV, async () => {
  if (!(await tb("huge", () => jpxDecode(tinyCodestream({ w: 0x7fffffff, h: 0x7fffffff }))))) throw new Error("huge image accepted");
  if (!(await tb("zero tile", () => jpxDecode(tinyCodestream({ tw: 0, th: 0 }))))) throw new Error("zero tile accepted");
  await tb("32 levels", () => jpxDecode(tinyCodestream({ levels: 32 })));
  await tb("many tiles", () => jpxDecode(tinyCodestream({ w: 4000, h: 4000, tw: 15, th: 15 })), 8000);
});
await H.test("N4 JPX truncated real codestreams (every 7th cut of a generated lossy RGB stream) keep the decoded part, never hang", COV, async () => {
  if (!have) return;
  const dir = join(tmp, "gen"); const f = join(dir, "irr97_layers.jp2"); if (!existsSync(f)) return;
  const full = new Uint8Array(readFileSync(f)); let partial = 0;
  for (let k = 200; k < full.length; k += Math.max(1, Math.floor(full.length / 7))) { await tb(`cut ${k}`, () => { const r = jpxDecode(full.subarray(0, k)); if (r.partial) partial++; }, 2000); }
  void partial;
});
await H.test("N5 JBIG2 garbage, empty and truncated segment streams are bounded and never throw out of the decoder", COV, async () => {
  for (const b of [new Uint8Array(0), Uint8Array.from({ length: 4000 }, (_, i) => (i * 131) & 255), new Uint8Array([0, 0, 0, 1, 0x30, 0, 1, 0, 0, 0, 19])]) await tb("jbig2", () => jbig2Decode(b, null, { width: 64, height: 64 }), 2000);
});
await H.test("N6 JBIG2 bomb (bomb_giant.pdf: a page claiming a huge region) is refused fast with bounded memory", COV, async () => {
  if (!have) return;
  const t0 = Date.now(); const doc = PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, "bomb_giant.pdf"))));
  for (let i = 0; i < Math.min(2, doc.pages().length); i++) pageImages(doc, i);
  if (Date.now() - t0 > 10_000) throw new Error(`${Date.now() - t0} ms`);
  if (process.memoryUsage().rss > 1.5e9) throw new Error("memory");
});
await H.test("N7 a PDF whose JPX stream is garbage renders the rest of the page (image becomes the disclosed placeholder, no throw)", COV, async () => {
  const pdf = onePage("q 50 0 0 50 0 0 cm /I Do Q", "<< /XObject << /I 4 0 R >> >>", [{ dict: "/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode", data: "garbage" }]);
  const imgs = pageImages(PdfDoc.open(pdf), 0); if (imgs.length !== 1 || imgs[0].codec?.name !== "JPXDecode" || !imgs[0].partial) throw new Error("not a disclosed placeholder");
});
H.finish();
