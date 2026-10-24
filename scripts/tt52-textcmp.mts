import { readFileSync } from "node:fs";
import { PdfDoc } from "../src/lib/pdf/pdfdoc";
import { pageText } from "../src/lib/pdf/pdftext";
const DIR = "/home/user/tools/corpus/pdf";
const PW: Record<string, string> = { "issue15893_reduced.pdf": "test", "issue3371.pdf": "ELXRTQWS", "issue6010_1.pdf": "abc", "issue6010_2.pdf": "æøå", "bug1782186.pdf": "Hello", "issue21579.pdf": "pässwört", "saslprep-r6.pdf": "SªSL\u00adprep" };
const norm = (s: string) => s.normalize("NFKC").replace(/[\s\u0000-\u001f\ufffe\uffff]/g, "");
function f1(a: string, b: string) {
  if (!a && !b) return 1; if (!a || !b) return 0;
  const bg = (s: string) => { const m = new Map<string, number>(); const cs = [...s]; for (let i = 0; i + 1 < cs.length; i++) { const k = cs[i] + cs[i + 1]; m.set(k, (m.get(k) ?? 0) + 1); } if (cs.length === 1) m.set(cs[0], 1); return m; };
  const A = bg(a), B = bg(b); let inter = 0, na = 0, nb = 0; for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 1;
}
const only = process.env.ONLY;
let pages = 0, sum = 0, ge95 = 0, ge80 = 0, lt50: string[] = [], errs: string[] = []; const t0 = Date.now(); const worst: [number, string][] = [];
for (const line of readFileSync("/tmp/text.jsonl", "utf8").trim().split("\n")) {
  const o = JSON.parse(line); if (!o.pages || (only && o.file !== only)) continue;
  let d: PdfDoc; try { d = PdfDoc.open(new Uint8Array(readFileSync(`${DIR}/${o.file}`)), PW[o.file]); } catch (e) { errs.push(`${o.file}: ${(e as Error).message}`); continue; }
  const ps = d.pages();
  o.pages.forEach((ref: string, i: number) => {
    if (i >= ps.length) return;
    let ours = ""; try { ours = pageText(d, ps[i], { includeHiddenOC: true }); } catch (e) { errs.push(`${o.file}#${i}: ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}`); }
    const s = f1(norm(ours), norm(ref)); pages++; sum += s; if (s >= 0.95) ge95++; if (s >= 0.8) ge80++;
    worst.push([s, `${o.file}#${i} ours=${JSON.stringify(norm(ours).slice(0, 60))} pdfium=${JSON.stringify(norm(ref).slice(0, 60))}`]);
    if (only) { console.log("OURS:\n" + ours.slice(0, 1500)); console.log("PDFIUM:\n" + ref.slice(0, 1500)); }
  });
}
worst.sort((a, b) => a[0] - b[0]);
console.log({ pages, mean: (sum / pages).toFixed(4), ge95, ge80, ms: Date.now() - t0 });
console.log("WORST", worst.slice(0, Number(process.env.N ?? 25)).map(([s, t]) => `${s.toFixed(3)} ${t}`).join("\n"));
console.log("ERRS", errs.length, errs.slice(0, 10));
