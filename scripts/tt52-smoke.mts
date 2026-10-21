import { readFileSync, readdirSync } from "node:fs";
import { PdfDoc, PasswordRequired } from "../src/lib/pdf/pdfdoc";
const DIR = "/home/user/tools/corpus/pdf";
const oracle = new Map<string, any>(readFileSync("/tmp/struct.jsonl", "utf8").trim().split("\n").map((l) => { const o = JSON.parse(l); return [o.file, o]; }));
let open = 0, pw = 0, fail = 0, pageMatch = 0, pageMis: string[] = [], boxMis: string[] = [], errs: string[] = [], recovered = 0, both = 0;
const t0 = Date.now();
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".pdf")).sort()) {
  const o = oracle.get(f); const b = new Uint8Array(readFileSync(`${DIR}/${f}`));
  let d: PdfDoc;
  try { d = PdfDoc.open(b); } catch (e) { if (e instanceof PasswordRequired) { pw++; continue; } fail++; if (o?.pdfium) errs.push(`${f}: ${(e as Error).message} (pdfium opens: ${o.pdfium.n}p)`); continue; }
  open++; if (d.recovered) recovered++;
  let pages; try { pages = d.pages(); } catch (e) { errs.push(`${f}: pages ${(e as Error).message}`); continue; }
  const ref = o?.pdfium?.n ?? o?.pypdf?.n;
  if (ref === undefined) continue; both++;
  if (pages.length === ref) pageMatch++; else pageMis.push(`${f}: ours ${pages.length} pdfium ${o?.pdfium?.n} pypdf ${o?.pypdf?.n}`);
  if (o?.pdfium && pages.length === o.pdfium.n) {
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i]; const w = p.crop[2] - p.crop[0], h = p.crop[3] - p.crop[1];
      const [W, H] = o.pdfium.sizes[i]; const rot = o.pdfium.rot[i];
      const [ew, eh] = p.rotate % 180 ? [h, w] : [w, h];
      if (Math.abs(ew - W) > 0.6 || Math.abs(eh - H) > 0.6 || rot !== p.rotate) { boxMis.push(`${f}#${i}: ours ${ew.toFixed(1)}x${eh.toFixed(1)} r${p.rotate} pdfium ${W.toFixed(1)}x${H.toFixed(1)} r${rot}`); break; }
    }
  }
}
console.log({ open, pw, fail, recovered, both, pageMatch, ms: Date.now() - t0 });
console.log("PAGE MISMATCH", pageMis.length, pageMis.slice(0, 15));
console.log("BOX MISMATCH", boxMis.length, boxMis.slice(0, 15));
console.log("ERRORS", errs.length, errs.slice(0, 20));
