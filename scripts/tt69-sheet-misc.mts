/**
 * TT69 Spreadsheet carry-overs from TT68:
 *  1. Paste Special ▸ Values of an EMPTY-TEXT value (="" or a typed ') pastes empty text, not a blank cell: ISBLANK FALSE,
 *     COUNTA 1, COUNTBLANK 1 (as Excel: a pasted zero-length string stays a string). A truly blank source still pastes blank.
 *     The .xlsx we write keeps it a string cell (openpyxl reads '' not None) and our reader reads it back as empty text.
 *  2. SUMIF / AVERAGEIF resize sum_range from its top-left cell to the shape of `range` (Microsoft's SUMIF remarks).
 *     TT68 paired cells by flat index. Includes a recalc check: a cell OUTSIDE the written sum_range but inside the resized
 *     one changes the result. Oracle: a brute-force reference over 400 random shapes.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt69-sheet-misc.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook, a1 } from "../src/lib/formula/engine.ts";
import { copyBlock, pasteSpecial } from "../src/lib/formula/sheetops.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import type { Scalar } from "../src/lib/formula/types.ts";

const { test, finish } = makeHarness("tt69-sheet-misc");
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt69m-"));
const at = (ref: string) => { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; return [m[1].charCodeAt(0) - 65, Number(m[2]) - 1] as const; };
function book(cells: Record<string, string>) {
  const wb = new Workbook(); const s = wb.sheet();
  for (const [r, v] of Object.entries(cells)) s.setCell(...at(r), v);
  wb.recalculate();
  return { wb, s, v: (r: string) => wb.valueAt("Sheet1", ...at(r)), inp: (r: string) => s.get(...at(r))?.input ?? "" };
}

await test("Paste Values: =\"\" and a typed ' paste as EMPTY TEXT (ISBLANK FALSE, COUNTA counts it); a blank source pastes blank; formulas/numbers unchanged", { "FF-20": "full" }, () => {
  const t = book({ A1: '=""', A2: "'", A3: "", A4: "=1+1", A5: "x" });
  const clip = copyBlock(t.s, { c0: 0, r0: 0, c1: 0, r1: 4 });
  const vals: Scalar[][] = [0, 1, 2, 3, 4].map((r) => [t.wb.valueAt("Sheet1", 0, r) ?? ""]);
  pasteSpecial(t.s, clip, vals, 2, 0, { what: "values" });
  for (const [r, f] of [["E1", "=ISBLANK(C1)"], ["E2", "=ISBLANK(C2)"], ["E3", "=ISBLANK(C3)"], ["E4", "=COUNTA(C1:C5)"], ["E5", "=COUNTBLANK(C1:C5)"], ["E6", "=LEN(C1)"]] as const) t.s.setCell(...at(r), f);
  t.wb.recalculate();
  eq([t.inp("C1"), t.inp("C2"), t.inp("C3"), t.inp("C4"), t.inp("C5")], ["'", "'", "", "2", "x"], "pasted inputs");
  eq([t.v("E1"), t.v("E2"), t.v("E3"), t.v("E4"), t.v("E5"), t.v("E6")], [false, false, true, 4, 3, 0], "ISBLANK / COUNTA / COUNTBLANK / LEN");
  // skip blanks still skips only truly blank sources
  pasteSpecial(t.s, clip, vals, 3, 0, { what: "values", skipBlanks: true });
  eq([t.inp("D1"), t.inp("D3")], ["'", ""], "skip blanks");
});

await test("an empty-text cell survives .xlsx: openpyxl reads '' (a string cell, not None) and our reader reads it back as empty text", { "FF-20": "full", "FF-19": "full" }, () => {
  const t = book({ A1: "'", B1: '=ISBLANK(A1)', A2: "1" });
  const bytes = writeXlsxWorkbook(t.wb); const f = join(tmp, "et.xlsx"); writeFileSync(f, bytes);
  eq(execFileSync(PY, ["-c", "import openpyxl,sys,json; ws=openpyxl.load_workbook(sys.argv[1]).active; print(json.dumps([ws['A1'].value, ws['A2'].value]))", f], { encoding: "utf8" }).trim(), '["", 1]', "openpyxl");
  const back = readXlsxWorkbook(Buffer.from(bytes)); back.recalculate();
  eq([back.valueAt("Sheet1", 0, 0), back.valueAt("Sheet1", 1, 0)], ["", false], "re-read: empty text, ISBLANK FALSE");
});

await test("SUMIF / AVERAGEIF resize sum_range from its top-left cell to range's shape (hand cases + recalc of a cell outside the written sum_range)", { "FF-19": "full" }, () => {
  const t = book({ A1: "1", A2: "1", A3: "0", B1: "1", B2: "1", C1: "10", C2: "20", C3: "30", C4: "40", D1: "100", D2: "200",
    F1: '=SUMIF(A1:A3,">0",C1)', F2: '=SUMIF(A1:B2,">0",C1:C4)', F3: '=AVERAGEIF(A1:A3,">0",C1:C2)', F4: '=SUMIF(A1:A3,">0",C1:C3)', F5: '=SUMIF(A1:A3,">0",C2:D9)' });
  eq(t.v("F1"), 30, "C1 → C1:C3 (C1+C2)");
  eq(t.v("F2"), 330, "C1:C4 → C1:D2 (10+100+20+200)");
  eq(t.v("F3"), 15, "AVERAGEIF C1:C2 → C1:C3");
  eq(t.v("F4"), 30, "same shape unchanged");
  eq(t.v("F5"), 50, "larger sum_range shrinks to C2:C4 (20+30)");
  t.s.setCell(...at("C2"), "25"); t.wb.recalculate();
  eq(t.v("F1"), 35, "editing C2 (outside the written sum_range C1) updates SUMIF");
});

await test("SUMIF / AVERAGEIF resize: brute-force reference over 400 random shapes and offsets", { "FF-19": "full" }, () => {
  let seed = 69; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let k = 0; k < 400; k++) {
    const cells: Record<string, string> = {};
    for (let c = 0; c < 12; c++) for (let r = 0; r < 12; r++) if (rnd(5)) cells[a1(c, r)] = String(rnd(9) - 3);
    const h = 1 + rnd(4), w = 1 + rnd(3), c0 = rnd(4), r0 = rnd(4), sc = 4 + rnd(4), sr = rnd(6), sh = 1 + rnd(5), sw = 1 + rnd(3);
    const rng = `${a1(c0, r0)}:${a1(c0 + w - 1, r0 + h - 1)}`, sum = `${a1(sc, sr)}:${a1(sc + sw - 1, sr + sh - 1)}`;
    cells.Z1 = `=SUMIF(${rng},">0",${sum})`; cells.Z2 = `=AVERAGEIF(${rng},">0",${sum})`;
    const t = book(cells);
    const num = (c: number, r: number) => { const x = cells[a1(c, r)]; return x === undefined ? null : Number(x); };
    let total = 0, n = 0;
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) { const cv = num(c0 + j, r0 + i); const sv = num(sc + j, sr + i); if (cv !== null && cv > 0 && sv !== null) { total += sv; n++; } }
    eq(t.v("Z1"), total, `SUMIF ${cells.Z1}`);
    eq(t.v("Z2"), n ? total / n : { error: "#DIV/0!" }, `AVERAGEIF ${cells.Z2}`);
  }
});

await test("adversary on the resize patch: cross-sheet sum_range keeps its sheet; a resize past the last row is clipped (no crash; Excel's behaviour there is unverified); whole columns; a union sum_range is left alone; Paste Values+Add of empty text over a number", { "FF-19": "full", "FF-20": "full" }, () => {
  const wb = new Workbook(); const s1 = wb.sheet(); const s2 = wb.addSheet("Data");
  for (let r = 0; r < 3; r++) { s1.setCell(0, r, "1"); s2.setCell(2, r, String(10 * (r + 1))); }
  s1.setCell(5, 0, '=SUMIF(A1:A3,">0",Data!C1)');
  s1.setCell(5, 1, '=SUMIF(A1:A3,">0",C1048576)'); s1.setCell(2, 1048575, "7");
  s1.setCell(5, 2, '=SUMIF(A:A,">0",Data!C1)');
  s1.setCell(5, 3, '=SUMIF(A1:A3,">0",Data!C1:C2)');
  wb.recalculate();
  const v = (r: number) => wb.valueAt("Sheet1", 5, r);
  eq(v(0), 60, "Data!C1 → Data!C1:C3");
  eq(v(1), 7, "C1048576 resized past the last row is clipped to C1048576 (no crash; Excel unverified)");
  eq(v(2), 60, "whole column A:A with a single-cell sum_range");
  eq(v(3), 60, "a 2-row Data! sum_range grows to 3");
  // Paste Values + Add: an empty-text source over a number leaves empty text (TT68 deleted the target cell outright)
  const t = book({ A1: '=""', C1: "5" });
  pasteSpecial(t.s, copyBlock(t.s, { c0: 0, r0: 0, c1: 0, r1: 0 }), [[""]], 2, 0, { what: "values", op: "add" }, () => 5);
  eq(t.inp("C1"), "'", "target becomes empty text (no arithmetic on text, as Excel pastes text sources over)");
});

finish();
