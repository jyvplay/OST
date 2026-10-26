/**
 * TT77 image differential: Fusion's decoded image samples vs PDFium's decoded bitmaps (scripts/oracle/pdf_images.py).
 * usage: node … scripts/tt77/imgcmp.mts REF.jsonl [PDFDIR]   → prints per-image results and a summary JSON line
 * Comparison is on gray (L) or RGB after the image's Decode array and colour space; `exact` = every sample equal,
 * `close` = mean abs difference ≤ 2/255 with ≤ 1 % of samples differing by more than 8 (lossy-codec rounding).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PdfDoc } from "../../src/lib/pdf/pdfdoc.ts";
import { Interpreter, IDENT } from "../../src/lib/pdf/pdfinterp.ts";
import { samplesToRGBA } from "../../src/lib/pdf/pdfcanvas.ts";
import type { PdfImage } from "../../src/lib/pdf/pdfinterp.ts";

export function readPnm(path: string): { w: number; h: number; ch: number; data: Uint8Array } {
  const b = readFileSync(path); let p = 0; const tok = () => { while (/\s/.test(String.fromCharCode(b[p]))) p++; if (b[p] === 0x23) { while (b[p] !== 10) p++; return tok(); } const s = p; while (!/\s/.test(String.fromCharCode(b[p]))) p++; return b.subarray(s, p).toString(); };
  const magic = tok(); const w = +tok(), h = +tok(); tok(); p++;
  return { w, h, ch: magic === "P5" ? 1 : 3, data: new Uint8Array(b.subarray(p, p + w * h * (magic === "P5" ? 1 : 3))) };
}

/** every image Fusion's interpreter draws on a page, in drawing order */
export function pageImages(doc: PdfDoc, pageIndex: number): PdfImage[] {
  const got: PdfImage[] = [];
  const dev = { wantsImages: true, wantsPaths: false, save() {}, restore() {}, fill() {}, stroke() {}, clip() {}, glyph() {}, shade() {}, image(img: PdfImage) { got.push(img); } };
  try { new Interpreter(doc, dev as never, IDENT, { warnings: [], deadline: Date.now() + 20000 }).runPage(doc.pages()[pageIndex]); } catch { /* keep what was drawn */ }
  return got;
}

export interface CmpResult { file: string; page: number; i: number; ok: "exact" | "close" | "diff" | "missing" | "size"; mad?: number; bad?: number; note?: string }
export function compareImage(img: PdfImage | undefined, ref: { w: number; h: number; ch: number; data: Uint8Array }): Omit<CmpResult, "file" | "page" | "i"> {
  if (!img) return { ok: "missing" };
  if (img.codec) return { ok: "missing", note: `codec ${img.codec.name} not decoded` };
  if (img.w !== ref.w || img.h !== ref.h) return { ok: "size", note: `${img.w}×${img.h} vs ${ref.w}×${ref.h}` };
  const rgba = img.imageMask ? maskRGBA(img) : samplesToRGBA(img);
  let sum = 0, bad = 0, diff = 0; const n = ref.w * ref.h;
  for (let k = 0; k < n; k++) {
    for (let c = 0; c < ref.ch; c++) {
      const ours = ref.ch === 1 ? Math.round(0.299 * rgba[k * 4] + 0.587 * rgba[k * 4 + 1] + 0.114 * rgba[k * 4 + 2]) : rgba[k * 4 + c];
      const e = Math.abs(ours - ref.data[k * ref.ch + c]); sum += e; if (e) diff++; if (e > 8) bad++;
    }
  }
  const mad = sum / (n * ref.ch);
  return { ok: diff === 0 ? "exact" : mad <= 2 && bad <= n * ref.ch * 0.01 ? "close" : "diff", mad: +mad.toFixed(3), bad };
}
/** image masks: PDFium returns the stencil as gray (painted = 0); Decode [1 0] swaps which samples paint */
function maskRGBA(img: PdfImage): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.w * img.h * 4); const rb = (img.w + 7) >> 3; const inv = img.decode[0] === 1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) { const b = (img.data[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1; const v = (b ^ (inv ? 1 : 0)) ? 255 : 0; const o = (y * img.w + x) * 4; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255; }
  return out;
}

export function runCompare(refJsonl: string, pdfDir: string, only?: RegExp): CmpResult[] {
  const recs = readFileSync(refJsonl, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.error && (!only || only.test(r.file)));
  const out: CmpResult[] = []; const docs = new Map<string, PdfDoc | null>(); const imgs = new Map<string, PdfImage[]>();
  for (const r of recs) {
    if (!docs.has(r.file)) { try { docs.set(r.file, PdfDoc.open(new Uint8Array(readFileSync(join(pdfDir, r.file))))); } catch { docs.set(r.file, null); } }
    const doc = docs.get(r.file); if (!doc) { out.push({ file: r.file, page: r.page, i: r.i, ok: "missing", note: "open failed" }); continue; }
    const key = `${r.file}#${r.page}`; if (!imgs.has(key)) imgs.set(key, pageImages(doc, r.page));
    const t0 = Date.now(); const res = compareImage(imgs.get(key)![r.i], readPnm(r.png));
    out.push({ file: r.file, page: r.page, i: r.i, ...res, note: [res.note, Date.now() - t0 > 2000 ? `${Date.now() - t0} ms` : ""].filter(Boolean).join(" ") || undefined });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = runCompare(process.argv[2], process.argv[3] ?? "/home/user/tools/corpus/pdf", process.env.ONLY ? new RegExp(process.env.ONLY) : undefined);
  for (const r of res) if (r.ok !== "exact" || process.env.ALL) console.log(JSON.stringify(r));
  const c: Record<string, number> = {}; for (const r of res) c[r.ok] = (c[r.ok] ?? 0) + 1;
  console.log(JSON.stringify({ total: res.length, ...c }));
}
