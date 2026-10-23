/**
 * TT68 held-out probe (FF-52): Excel's CACHED formula results (openpyxl, scripts/oracle/xlsx_cached.py) over the
 * Apache POI corpus vs our recalculation, BEFORE (TT67 tree, git 8646947) and AFTER this tier's change. The cached
 * values were produced by the authoring application, never by us, so they are an independent oracle.
 * Usage: node … scripts/tt68-heldout.mts [outJson]   (writes per-cell flips)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/xlsx";
const BEFORE = "/tmp/tt68-before";
if (!existsSync(`${BEFORE}/src/lib/formula/xlsx.ts`)) { mkdirSync(BEFORE, { recursive: true }); execFileSync("bash", ["-c", `git archive 8646947 src/lib | tar -x -C ${BEFORE}`]); }
const before = (await import(`${BEFORE}/src/lib/formula/xlsx.ts`)) as { readXlsxWorkbook: typeof readXlsxWorkbook };

export type Flip = { file: string; sheet: string; ref: string; formula: string; cached: unknown; before: unknown; after: unknown };
export function heldOut(files: string[]) {
  const out = execFileSync(PY, ["scripts/oracle/xlsx_cached.py"], { input: files.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28, timeout: 1_200_000 });
  const norm = (v: unknown) => (v && typeof v === "object" && "error" in (v as object) ? (v as { error: string }).error : v === undefined || v === null ? "" : v);
  const same = (a: unknown, b: unknown) => {
    a = norm(a); b = norm(b);
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
    if (typeof b === "boolean" && typeof a === "number") return (a !== 0) === b;
    return a === b;
  };
  let cells = 0, okBefore = 0, okAfter = 0; const flips: Flip[] = []; const errors: string[] = [];
  for (const line of out.trim().split("\n")) {
    const j = JSON.parse(line) as { file: string; sheets?: Record<string, [string, string, unknown, string][]>; error?: string };
    if (!j.sheets) continue;
    let wa, wbB;
    try { const buf = readFileSync(j.file); wa = readXlsxWorkbook(buf); wa.recalculate(); wbB = before.readXlsxWorkbook(buf); wbB.recalculate(); } catch (e) { errors.push(`${j.file}: ${(e as Error).message}`); continue; }
    for (const [sh, rows] of Object.entries(j.sheets)) {
      const sa = wa.sheets.get(sh), sb = wbB.sheets.get(sh); if (!sa || !sb) continue;
      for (const [ref, formula, cached] of rows) {
        const m = /^([A-Z]+)(\d+)$/.exec(ref); if (!m) continue;
        const col = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, row = Number(m[2]) - 1;
        const va = wa.valueAt(sh, col, row), vb = wbB.valueAt(sh, col, row);
        cells++; const A = same(va, cached), B = same(vb, cached);
        if (A) okAfter++; if (B) okBefore++;
        if (A !== B || (!A && /COUNTA|ISBLANK|ISTEXT|ISNONTEXT|TYPE\(|COUNTBLANK|COUNTIF/i.test(formula))) flips.push({ file: j.file.split("/").pop()!, sheet: sh, ref, formula, cached, before: norm(vb), after: norm(va) });
      }
    }
  }
  return { cells, okBefore, okAfter, flips, errors };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const files = readdirSync(CORPUS).filter((f) => /\.xlsx$/i.test(f)).map((f) => `${CORPUS}/${f}`);
  const r = heldOut(files);
  console.log(JSON.stringify({ cells: r.cells, okBefore: r.okBefore, okAfter: r.okAfter, flips: r.flips.length, errors: r.errors.length }));
  for (const f of r.flips) console.log(JSON.stringify(f));
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(r, null, 1));
}
