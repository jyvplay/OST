/** TT52 — edit differential: apply edits with src/lib/pdf/pdfedit.ts to corpus files, then verify with PDFium + qpdf
 *  (scripts/oracle/pdf_editcheck.py). Env: N (max files), OUT (dir). */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PdfDoc } from "../src/lib/pdf/pdfdoc.ts";
import { PdfEditor, extractPages, mergeDocuments } from "../src/lib/pdf/pdfedit.ts";
const DIR = process.env.PDFDIR ?? "/home/user/tools/corpus/pdf", OUT = process.env.OUT ?? "/tmp/edits";
mkdirSync(OUT, { recursive: true });
const PW: Record<string, string> = { "issue15893_reduced.pdf": "test", "issue3371.pdf": "ELXRTQWS", "issue6010_1.pdf": "abc", "issue6010_2.pdf": "æøå", "bug1782186.pdf": "Hello", "issue21579.pdf": "pässwört", "saslprep-r6.pdf": "SªSL\u00adprep" };
const files = readdirSync(DIR).filter((f) => f.endsWith(".pdf")).sort().slice(0, Number(process.env.N ?? 100000));
const jobs: Record<string, unknown>[] = []; let openFail = 0, editFail = 0, incCount = 0, cleanCount = 0; const errs: string[] = [];
for (const f of files) {
  let doc: PdfDoc; const bytes = new Uint8Array(readFileSync(`${DIR}/${f}`));
  try { doc = PdfDoc.open(bytes, PW[f]); if (!doc.pages().length) { openFail++; continue; } } catch { openFail++; continue; }
  const n = doc.pages().length; const base = f.replace(/\.pdf$/, "");
  try {
    // 1) incremental: rotate p0 +90, add highlight + ink + freetext on p0, set title
    const ed = new PdfEditor(doc); const p0 = doc.pages()[0]; const [x0, y0, x1, y1] = p0.crop;
    const r0 = (p0.rotate + 90) % 360; ed.rotate(0, 90);
    const before = (doc.arr(p0.dict.get("Annots")) ?? []).length;
    ed.addAnnotation(0, { type: "Highlight", rects: [[x0 + 20, y1 - 60, x0 + 200, y1 - 40]], contents: "TT52 hl" });
    ed.addAnnotation(0, { type: "Ink", ink: [[x0 + 30, y0 + 30, x0 + 60, y0 + 70, x0 + 90, y0 + 40]], color: [0, 0, 1] });
    ed.addAnnotation(0, { type: "FreeText", rect: [x0 + 40, y0 + 100, x0 + 240, y0 + 140], contents: "Fusion note é", fontSize: 11 });
    ed.setInfo({ Title: "TT52 édit" });
    const exact = !doc.recovered && doc.startxref >= 0 && ed.xrefExact(); if (exact) incCount++; else cleanCount++;
    const inc = ed.save(); writeFileSync(`${OUT}/${base}.inc.pdf`, inc);
    jobs.push({ file: `${base}.inc.pdf`, src: f, password: PW[f] ?? "", pages: n, rot0: r0, annots0: before + 3, title: "TT52 édit", prefixOf: f, incremental: exact });
    // 2) page ops on multi-page docs: reverse order + delete last + insert blank at 0 → clean copy
    if (n >= 2) {
      const e2 = new PdfEditor(PdfDoc.open(bytes, PW[f])); const order = [...Array(n).keys()].reverse(); e2.reorder(order); e2.deletePages([n - 1]); e2.insertBlank(0, 300, 400);
      const out = e2.saveClean(); writeFileSync(`${OUT}/${base}.ops.pdf`, out);
      // expected: blank(300x400) then original pages n-1 … 1  (original page 0 deleted, since it ended last)
      jobs.push({ file: `${base}.ops.pdf`, src: f, password: PW[f] ?? "", pages: n, order: [-1, ...order.slice(0, n - 1)], blank: [300, 400] });
    }
  } catch (e) { editFail++; errs.push(`${f}: ${(e as Error).message}`); }
}
// 3) merge + extract on a few unencrypted docs
const plain = files.filter((f) => !PW[f]).slice(0, 400).filter((f) => { try { const d = PdfDoc.open(new Uint8Array(readFileSync(`${DIR}/${f}`))); return !d.sec && d.pages().length >= 1; } catch { return false; } });
for (let i = 0; i + 1 < Math.min(plain.length, 120); i += 2) {
  const a = PdfDoc.open(new Uint8Array(readFileSync(`${DIR}/${plain[i]}`))), b = PdfDoc.open(new Uint8Array(readFileSync(`${DIR}/${plain[i + 1]}`)));
  try { const m = mergeDocuments([a, b]); const name = `merge-${i}.pdf`; writeFileSync(`${OUT}/${name}`, m); jobs.push({ file: name, merge: [plain[i], plain[i + 1]], pages: a.pages().length + b.pages().length }); }
  catch (e) { editFail++; errs.push(`merge ${plain[i]}+${plain[i + 1]}: ${(e as Error).message}`); }
  try { const k = b.pages().length - 1; const x = extractPages(b, [k]); const name = `extract-${i}.pdf`; writeFileSync(`${OUT}/${name}`, x); jobs.push({ file: name, extract: plain[i + 1], index: k }); }
  catch (e) { editFail++; errs.push(`extract ${plain[i + 1]}: ${(e as Error).message}`); }
}
writeFileSync(`${OUT}/jobs.json`, JSON.stringify(jobs));
console.log({ files: files.length, openFail, editFail, jobs: jobs.length, incremental: incCount, cleanFallback: cleanCount }); if (errs.length) console.log(errs.slice(0, 20));
