/**
 * TT61 Spreadsheet regression — a PivotTable deleted after its output cells were already gone must stay deleted.
 * Bug (latent since TT58): patchXlsx's "nothing changed → original bytes" shortcut compared cells / charts / conditional
 * formats / links but not pivot definitions, so the save returned the old file with the hidden _FusionPivot names and the
 * pivot came back on reopen. Independent check: openpyxl lists the workbook's defined names in each saved file.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt61-sheet-pivot-delete.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { writePivot, deletePivot, type PivotDef } from "../src/lib/formula/pivotsheet.ts";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";

const { test, finish } = makeHarness("tt61-sheet-pivot-delete");
const COV = { "FF-21": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt61p-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
let seq = 0;
const names = (b: Uint8Array): string[] => { const f = join(tmp, `n${seq++}.xlsx`); writeFileSync(f, b); return JSON.parse(execFileSync(PY, ["-c", "import openpyxl,json,sys,warnings;warnings.filterwarnings('ignore');wb=openpyxl.load_workbook(sys.argv[1]);n=list(wb.defined_names.keys());[n.extend(ws.defined_names.keys()) for ws in wb];print(json.dumps(sorted(n)))", f], { encoding: "utf8" })); };
const piv = (ns: string[]) => ns.filter((n) => n.startsWith("_FusionPivot"));

await test("delete every output cell (save), then delete the pivot (save): the pivot and its hidden names are gone in the file (openpyxl) and on reopen; an untouched save is still byte-identical", COV, async () => {
  const poi = readFileSync("/home/user/tools/corpus/xlsx/45430.xlsx");
  const pw = readXlsxWorkbook(poi); const src = [...pw.sheets.keys()][0]; const ps = pw.sheet(src);
  ps.setCell(20, 0, "K"); ps.setCell(21, 0, "V"); ps.setCell(20, 1, "a"); ps.setCell(21, 1, "2"); ps.setCell(20, 2, "b"); ps.setCell(21, 2, "5"); pw.recalculate();
  const pd: PivotDef = { name: "PivotTable1", src: { sheet: src, ref: "U1:V3" }, anchor: { col: 0, row: 2 }, spec: { rows: [0], cols: [], values: [{ field: 1, fn: "sum" }] } };
  ok(writePivot(pw, pw.addSheet("PivotOut"), pd).ok, "pivot written");
  const r1 = await patchXlsx(new Uint8Array(poi), pw);
  ok(piv(names(r1.bytes)).length > 0, "save 1 stores the definition names");
  const a = readXlsxWorkbook(Buffer.from(r1.bytes)); a.sheet("PivotOut").grid.clear(); a.recalculate();
  const r2 = await patchXlsx(r1.bytes, a);
  const b = readXlsxWorkbook(Buffer.from(r2.bytes));
  ok(b.sheet("PivotOut").grid.size === 0 && b.sheet("PivotOut").pivots.length === 1, "save 2: no cells, definition kept");
  // untouched save of that state = same bytes (the fix must not break the lossless shortcut)
  const r2b = await patchXlsx(r2.bytes, readXlsxWorkbook(Buffer.from(r2.bytes)));
  ok(r2b.bytes === r2.bytes || Buffer.compare(Buffer.from(r2b.bytes), Buffer.from(r2.bytes)) === 0, "untouched save byte-identical");
  deletePivot(b.sheet("PivotOut"), b.sheet("PivotOut").pivots[0]);
  const r3 = await patchXlsx(r2.bytes, b);
  ok(piv(names(r3.bytes)).length === 0, `save 3: hidden names removed (openpyxl: ${JSON.stringify(names(r3.bytes))})`);
  ok(readXlsxWorkbook(Buffer.from(r3.bytes)).sheet("PivotOut").pivots.length === 0, "reopen: no pivot");
});

finish();
