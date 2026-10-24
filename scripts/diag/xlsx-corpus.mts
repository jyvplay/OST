/**
 * TT46 measurement: our xlsx reader + formula engine vs. the values the authoring application (Excel, mostly) cached in
 * real files (Apache POI test-data corpus, TOOLS_DIR/corpus/xlsx; cached values listed independently by openpyxl in
 * corpus/cached.jsonl via scripts/oracle/xlsx_cached.py). Prints a per-function mismatch table.
 *   node … scripts/diag/xlsx-corpus.mts [--json out.json] [--show FN]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readXlsxWorkbook } from "../../src/lib/formula/xlsx.ts";
import { isError, lettersToCol } from "../../src/lib/formula/types.ts";

const TOOLS = process.env.TOOLS_DIR ?? "/home/user/tools";
const VOLATILE = /\b(RAND|RANDBETWEEN|RANDARRAY|NOW|TODAY|CELL|INFO)\s*\(/i;
const args = process.argv.slice(2);
const show = args.includes("--show") ? args[args.indexOf("--show") + 1].toUpperCase() : null;
const fnsOf = (f: string) => [...new Set([...f.toUpperCase().matchAll(/([A-Z][A-Z0-9.]*)\s*\(/g)].map((m) => m[1].replace(/^_XLFN\.|^_XLWS\./, "")))];
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

export interface CorpusResult { files: number; readFail: string[]; cells: number; excluded: number; match: number; mismatch: number; byFn: Record<string, { n: number; bad: number }>; samples: string[] }
export function runCorpus(limitFiles = Infinity): CorpusResult {
  const res: CorpusResult = { files: 0, readFail: [], cells: 0, excluded: 0, match: 0, mismatch: 0, byFn: {}, samples: [] };
  for (const line of readFileSync(`${TOOLS}/corpus/cached.jsonl`, "utf8").split("\n")) {
    if (!line) continue;
    const d = JSON.parse(line) as { file: string; sheets?: Record<string, [string, string, unknown, string][]>; error?: string };
    if (!d.sheets || !Object.keys(d.sheets).length) continue;
    if (res.files >= limitFiles) break;
    res.files++;
    let wb;
    try { wb = readXlsxWorkbook(readFileSync(d.file.startsWith("/") ? d.file : `${TOOLS}/corpus/${d.file}`)); } catch (e) { res.readFail.push(`${d.file.split("/").pop()}: ${(e as Error).message.slice(0, 80)}`); continue; }
    for (const [sheetName, cells] of Object.entries(d.sheets)) {
      const sh = wb.sheets.get(sheetName);
      for (const [ref, formula, cached] of cells) {
        res.cells++;
        if (VOLATILE.test(formula) || /\[\d+\]/.test(formula)) { res.excluded++; continue; }
        const m = /^([A-Z]+)(\d+)$/.exec(ref)!; const col = lettersToCol(m[1]), row = Number(m[2]) - 1;
        const got = sh ? wb.valueAt(sheetName, col, row) : undefined;
        let ok = false;
        if (got === undefined) ok = false;
        else if (typeof cached === "number") ok = typeof got === "number" ? near(got, cached) : typeof got === "boolean" ? false : false;
        else if (typeof cached === "boolean") ok = got === cached;
        else if (typeof cached === "string" && /^#(N\/A|VALUE!|REF!|DIV\/0!|NUM!|NAME\?|NULL!|SPILL!|CALC!)$/.test(cached)) ok = isError(got) && got.error === cached;
        else if (typeof cached === "string") ok = (isError(got) ? got.error : String(got)) === cached;
        const fns = fnsOf(formula); if (!fns.length) fns.push("(no function)");
        for (const fn of fns) { const b = (res.byFn[fn] ??= { n: 0, bad: 0 }); b.n++; if (!ok) b.bad++; }
        if (ok) res.match++; else {
          res.mismatch++;
          if ((show && fns.includes(show)) || (!show && res.samples.length < 4000)) res.samples.push(`${d.file.split("/").pop()} ${sheetName}!${ref} ${formula.slice(0, 90)} → ours ${JSON.stringify(got)} vs cached ${JSON.stringify(cached)}`);
        }
      }
    }
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runCorpus();
  console.log(`files ${r.files}, our reader failed on ${r.readFail.length}; cells ${r.cells}, excluded ${r.excluded} (volatile/external), match ${r.match}, mismatch ${r.mismatch} (${(100 * r.match / Math.max(1, r.match + r.mismatch)).toFixed(2)} %)`);
  for (const f of r.readFail) console.log("  read fail:", f);
  const rows = Object.entries(r.byFn).filter(([, v]) => v.bad).sort((a, b) => b[1].bad - a[1].bad);
  console.log("functions with mismatches:", rows.map(([k, v]) => `${k} ${v.bad}/${v.n}`).join(", "));
  for (const s of r.samples.slice(0, show ? 30 : 40)) console.log("  ", s);
  if (args.includes("--json")) writeFileSync(args[args.indexOf("--json") + 1], JSON.stringify(r, null, 1));
}
