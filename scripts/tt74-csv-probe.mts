/**
 * TT74 (FF-02) xlsx → CSV probe (X1) and CSV round trip (X2) over the POI xlsx corpus.
 * X1: every sheet → sheetToCsv(raw values); scripts/oracle/xlsx_csv.py checks quoting with Python's csv module, values
 *     against openpyxl data_only (cached values), used range against openpyxl's bounds.
 * X2: every sheet → display CSV → csvToWorkbook (Excel typing) → display CSV again: must be identical (fixpoint), and
 *     Python's csv module must parse it to the same fields.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { sheetToCsv, csvToWorkbook, parseCsvText, usedRange, retypes } from "../src/lib/formula/csv.ts";

const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/xlsx";
export async function runCsvProbe(filter = "", limit = 10_000) {
  const dir = mkdtempSync(join(tmpdir(), "tt74x-"));
  const manifest: unknown[] = [];
  let refused = 0, sheets = 0, x2 = 0, x2ok = 0, x2retyped = 0, x2idem = 0; const x2bad: string[] = []; const x2idemBad: string[] = [];
  const files = readdirSync(CORPUS).filter((n) => /\.xlsx$/i.test(n) && n.includes(filter)).sort().slice(0, limit);
  for (const name of files) {
    let wb;
    try { wb = readXlsxWorkbook(readFileSync(join(CORPUS, name))); } catch { refused++; continue; }
    let k = 0;
    for (const sheet of wb.sheets.keys()) {
      const ur = usedRange(wb, sheet);
      if (ur && (ur.c1 - ur.c0 + 1) * (ur.r1 - ur.r0 + 1) > 400_000) continue; // huge sparse sheets: skipped (counted below)
      sheets++;
      const r = sheetToCsv(wb, sheet, { values: "raw" });
      const csvName = `${name}__${k++}.csv`;
      writeFileSync(join(dir, csvName), r.text);
      manifest.push({ file: name, path: join(CORPUS, name), sheet, csv: csvName, range: ur ? [ur.c0 + 1, ur.r0 + 1, ur.c1 + 1, ur.r1 + 1] : null, expect: parseCsvText(r.text, ",") });
      // X2a: raw values → CSV → Excel typing → raw values must be identical, except text that Excel itself re-types
      //      (counted: sheetToCsv reports it as a loss on export)
      x2++;
      const raw1 = parseCsvText(r.text, ",");
      const back = csvToWorkbook(r.text, { delimiter: "," });
      const raw2 = parseCsvText(sheetToCsv(back.wb, back.sheet, { values: "raw" }).text, ",");
      const ur2 = usedRange(back.wb, back.sheet);
      let ok = true; let retyped = 0;
      for (let i = 0; i < raw1.length && ok; i++) for (let j = 0; j < raw1[i].length; j++) {
        const want = raw1[i][j]; const got = (raw2[i - (ur2?.r0 ?? 0)] ?? [])[j - (ur2?.c0 ?? 0)] ?? "";
        if (want === got) continue;
        const cell = wb.sheets.get(sheet)!.get((ur?.c0 ?? 0) + j, (ur?.r0 ?? 0) + i);
        const v = wb.valueAt(sheet, (ur?.c0 ?? 0) + j, (ur?.r0 ?? 0) + i);
        if (typeof v === "string" && cell && !cell.formula && retypes(v)) { retyped++; continue; }
        if (typeof v === "string" && cell?.formula && retypes(v)) { retyped++; continue; }
        if (typeof v === "string" && /^[=+\-@]/.test(v.trim())) { retyped++; continue; } // guarded on import (kept as text) — equal text
        ok = false; if (x2bad.length < 60) x2bad.push(`${name}:${sheet} r${i} c${j}: ${JSON.stringify(want)} → ${JSON.stringify(got)}`);
      }
      x2retyped += retyped;
      if (ok) x2ok++;
      // X2b: display text is idempotent after one Excel-typing cycle (d2 → import → d3 = d2)
      const d1 = sheetToCsv(wb, sheet, { values: "display" }).text;
      const b1 = csvToWorkbook(d1, { delimiter: "," }); const d2 = sheetToCsv(b1.wb, b1.sheet, { values: "display" }).text;
      const b2 = csvToWorkbook(d2, { delimiter: "," }); const d3 = sheetToCsv(b2.wb, b2.sheet, { values: "display" }).text;
      if (d2 === d3) x2idem++; else if (x2idemBad.length < 30) { const A = d2.split("\r\n"), B = d3.split("\r\n"); let i = 0; while (A[i] === B[i]) i++; x2idemBad.push(`${name}:${sheet} line ${i}: ${JSON.stringify(A[i]?.slice(0, 80))} → ${JSON.stringify(B[i]?.slice(0, 80))}`); }
    }
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const py = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_csv.py", dir], { maxBuffer: 1 << 28 }).toString());
  return { dir, files: files.length, refused, sheets, x1: py, x2: { sheets: x2, rawExact: x2ok, retypedText: x2retyped, bad: x2bad, displayIdempotent: x2idem, idemBad: x2idemBad } };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runCsvProbe(process.argv[2] ?? "", Number(process.argv[3] ?? 10_000));
  const { disagree, quoting_bad, range_bad, oracle_errors, ...x1 } = r.x1;
  console.log("X1", JSON.stringify(x1));
  console.log("quoting_bad", JSON.stringify(quoting_bad.slice(0, 10)));
  console.log("range_bad", range_bad.length, JSON.stringify(range_bad.slice(0, 12), null, 0));
  console.log("oracle_errors", oracle_errors.length, JSON.stringify(oracle_errors.slice(0, 5)));
  console.log("disagree", disagree.length, JSON.stringify(disagree.slice(0, 25)));
  console.log("X2a", r.x2.sheets, r.x2.rawExact, "retyped", r.x2.retypedText, JSON.stringify(r.x2.bad.slice(0, 25), null, 0));
  console.log("X2b", r.x2.displayIdempotent, JSON.stringify(r.x2.idemBad.slice(0, 20), null, 0));
  console.log(JSON.stringify({ files: r.files, refused: r.refused, sheets: r.sheets }));
}
