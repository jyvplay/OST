/**
 * TT70 sparse whole-column ranges (src/lib/formula/engine.ts resolveRangeMatrix + blankMask).
 * TT69 materialised every cell of a full column: =SUM(A:C) with data in row 1,048,576 was #NUM! (over the 2^21 cap) and
 * one =SUM(A:A) took ~1 s / ~280 MB. Large ranges are now sparse: rows with no input and no spill share one frozen
 * empty row that is never evaluated cell by cell, and the blank mask of such a row is a shared all-true row.
 *  1. Excel's results for whole-column formulas with data in the LAST row (hand-computed; Microsoft COUNTBLANK /
 *     COUNTIF "" semantics): SUM / COUNTA / COUNTBLANK / COUNTIF "" / SUMIF / MATCH / INDEX / XLOOKUP / MAX / SUMPRODUCT.
 *  2. adversary — a spill whose child rows have NO input (SEQUENCE in a remote row) is counted by a whole-column SUM;
 *     an empty-text formula (="") in a remote row is non-blank for COUNTA and blank-like for COUNTIF "".
 *  3. differential oracle: 40 random sparse sheets (numbers, text, ="" and spills scattered over 1,048,576 rows) —
 *     SUM / COUNT / COUNTA / COUNTBLANK / MAX / SUMIF of whole columns equal a brute-force computation from the cell list.
 *  4. both evaluation paths: recalculation and evalFormulaAt (conditional-format formulas).
 *  5. cross-sheet whole columns keep one shape (workbook-wide used area); mismatched full sizes stay #VALUE!.
 *  6. limits: 16 full columns with bottom-row data evaluate; 17 are #NUM! (documented cap, Excel has none); speed.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt70-range.mts
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";

const { test, finish } = makeHarness("tt70-range");
const COV = { "SH-06": "full" } as const;
const LAST = 1_048_575;
const valueOf = (wb: Workbook, c: number, r: number) => wb.sheet().get(c, r)?.value;

function bottomSheet(): Workbook {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(0, 0, "1"); s.setCell(0, LAST, "2"); s.setCell(1, LAST, "10"); s.setCell(2, LAST, "100");
  return wb;
}

await test("Excel results for whole-column formulas with data in row 1,048,576 (TT69: #NUM! beyond two columns)", COV, () => {
  const cases: [string, unknown][] = [
    ["=SUM(A:C)", 113], ["=SUM(A:A)", 3], ["=COUNTA(A:C)", 4], ["=COUNT(A:C)", 4], ["=MAX(A:C)", 100], ["=MIN(A:C)", 1],
    ["=COUNTBLANK(A:A)", 1_048_574], ["=COUNTIF(A:A,\"\")", 1_048_574], ["=COUNTIF(A:A,\"<>\")", 2],
    ["=SUMIF(A:A,\">1\",C:C)", 100], ["=MATCH(2,A:A,0)", 1_048_576], ["=INDEX(C:C,1048576)", 100],
    ["=XLOOKUP(2,A:A,B:B)", 10], ["=SUMPRODUCT((A1:A1048576>0)*1)", 2], ["=AVERAGE(A:C)", 28.25],
  ];
  for (const [f, want] of cases) {
    const wb = bottomSheet(); wb.sheet().setCell(5, 0, f); wb.recalculate();
    assert.deepEqual(valueOf(wb, 5, 0), want, f);
  }
});

await test("adversary: spill child rows (no input) are counted; =\"\" in a remote row is non-blank for COUNTA, blank-like for COUNTIF \"\"", COV, () => {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(1, 900_000, "=SEQUENCE(3)");     // B900001:B900003 — two rows hold only spilled values
  s.setCell(1, LAST, "5");
  s.setCell(2, 700_000, "=\"\"");             // C700001: empty TEXT, not a blank cell
  s.setCell(2, LAST, "1");
  s.setCell(6, 0, "=SUM(B:B)"); s.setCell(6, 1, "=COUNT(B:B)"); s.setCell(6, 2, "=COUNTA(C:C)");
  s.setCell(6, 3, "=COUNTBLANK(C:C)"); s.setCell(6, 4, "=COUNTIF(C:C,\"\")"); s.setCell(6, 5, "=MATCH(3,B:B,0)");
  wb.recalculate();
  assert.equal(valueOf(wb, 6, 0), 1 + 2 + 3 + 5, "SUM(B:B) includes the spilled 2 and 3");
  assert.equal(valueOf(wb, 6, 1), 4, "COUNT(B:B)");
  assert.equal(valueOf(wb, 6, 2), 2, "COUNTA counts the =\"\" cell");
  assert.equal(valueOf(wb, 6, 3), 1_048_575, "COUNTBLANK counts =\"\" as blank (Microsoft) — 1,048,576 − 1 number");
  assert.equal(valueOf(wb, 6, 4), 1_048_575, "COUNTIF \"\" matches blanks and empty text");
  assert.equal(valueOf(wb, 6, 5), 900_003, "MATCH finds the spilled 3");
});

await test("differential oracle: 40 random sparse sheets — whole-column aggregates equal a brute-force computation from the cell list", COV, () => {
  let seed = 70;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let t = 0; t < 40; t++) {
    const wb = new Workbook(); const s = wb.sheet();
    const cells = new Map<number, { kind: "num" | "text" | "empty"; v: number | string }>(); // column A
    const crit = new Map<number, number>();                                                 // column B (SUMIF sum_range)
    const n = 1 + Math.floor(rnd() * 25);
    for (let i = 0; i < n; i++) {
      const r = Math.floor(rnd() * (LAST + 1)); const k = rnd();
      if (k < 0.6) { const v = Math.round(rnd() * 2000 - 1000); s.setCell(0, r, String(v)); cells.set(r, { kind: "num", v }); }
      else if (k < 0.8) { s.setCell(0, r, `t${i}`); cells.set(r, { kind: "text", v: `t${i}` }); }
      else { s.setCell(0, r, "=\"\""); cells.set(r, { kind: "empty", v: "" }); }
      if (rnd() < 0.5) { const b = Math.round(rnd() * 100); s.setCell(1, r, String(b)); crit.set(r, b); }
    }
    if (rnd() < 0.5) { const r = Math.floor(rnd() * (LAST - 10)); if (![0, 1, 2, 3].some((d) => cells.has(r + d))) { s.setCell(0, r, "=SEQUENCE(4)"); for (let d = 0; d < 4; d++) cells.set(r + d, { kind: "num", v: d + 1 }); } }
    const fs = ["=SUM(A:A)", "=COUNT(A:A)", "=COUNTA(A:A)", "=COUNTBLANK(A:A)", "=MAX(A:A)", "=SUMIF(A:A,\">0\",B:B)"];
    fs.forEach((f, i) => s.setCell(8, i, f));
    wb.recalculate();
    const nums = [...cells.values()].filter((c) => c.kind === "num").map((c) => c.v as number);
    const want = [
      nums.reduce((a, b) => a + b, 0), nums.length, cells.size,
      // COUNTBLANK of a whole column counts every blank of the column (1,048,576 rows; ="" counts as blank)
      LAST + 1 - [...cells.values()].filter((c) => c.kind !== "empty").length,
      nums.length ? Math.max(...nums) : 0,
      [...cells.entries()].filter(([, c]) => c.kind === "num" && (c.v as number) > 0).reduce((a, [r]) => a + (crit.get(r) ?? 0), 0),
    ];
    fs.forEach((f, i) => assert.equal(valueOf(wb, 8, i), want[i], `sheet ${t}: ${f}`));
  }
});

await test("both evaluation paths: evalFormulaAt (conditional formats) gives the same sparse results as recalculation", COV, () => {
  const wb = bottomSheet(); wb.recalculate();
  assert.equal(wb.evalFormulaAt("Sheet1", 5, 5, "=SUM(A:C)"), 113);
  assert.equal(wb.evalFormulaAt("Sheet1", 5, 5, "=COUNTBLANK(A:A)"), 1_048_574);
  assert.equal(wb.evalFormulaAt("Sheet1", 5, 5, "=COUNTA(A:C)"), 4);
});

await test("cross-sheet: whole columns keep one shape on every sheet (TT69: COUNTIFS / SUMIFS / SUMPRODUCT across sheets were #VALUE!); full sizes still must agree", COV, () => {
  const mk = (f: string) => {
    const wb = new Workbook(); const s = wb.sheet(); const d = wb.addSheet("Data");
    for (let r = 0; r < 20; r++) { d.setCell(0, r, String(r + 1)); d.setCell(1, r, "1"); }
    s.setCell(0, 0, "1"); s.setCell(1, 0, "2"); s.setCell(1, 1, "3"); s.setCell(4, 0, f); wb.recalculate();
    return wb.sheet().get(4, 0)?.value;
  };
  assert.equal(mk("=COUNTIFS(A:A,\">0\",Data!A:A,\">0\")"), 1);
  assert.equal(mk("=SUMIFS(B:B,Data!A:A,\">0\")"), 5);
  assert.equal(mk("=SUMPRODUCT(A:A,Data!A:A)"), 1);
  assert.equal(mk("=SUMIFS(Data!B:B,Data!A:A,\">0\")"), 20);
  assert.equal(mk("=COUNTIFS(Data!A:A,\"\",B:B,\"\")"), 1_048_576 - 20, "blank tail of both columns matches \"\" in both");
  assert.equal(mk("=COUNTIFS(Data!A:A,\"\",B:B,\">0\")"), 0, "the tail does not match \">0\"");
  assert.deepEqual(mk("=COUNTIFS(A:A,\">0\",A1:A10,\">0\")"), { error: "#VALUE!" }, "1,048,576 rows vs 10 rows: sizes differ (Excel #VALUE!)");
  assert.deepEqual(mk("=SUMIFS(A1:A10,Data!A:A,\">0\")"), { error: "#VALUE!" }, "sum range smaller than the criteria range");
  assert.equal(mk("=COUNTBLANK(A1:A300000)"), 299_999, "an explicit 300,000-row range counts all its blanks");
  assert.equal(mk("=COUNTIF(Data!A:A,\"<>5\")"), 1_048_575);
  assert.equal(mk("=COUNTIF(Data!A:A,\">0\")"), 20, "the blank tail is not counted when the criterion does not match a blank");
  // the used area is 20 rows, so A1:A20 and A:A PRESENT the same 20 rows — only their full sizes tell them apart
  assert.deepEqual(mk("=COUNTIFS(Data!A:A,\">0\",A1:A20,\">0\")"), { error: "#VALUE!" }, "A:A vs A1:A20 (same shown shape, different size)");
  assert.deepEqual(mk("=SUMIFS(Data!B1:B20,Data!A:A,\">0\")"), { error: "#VALUE!" }, "sum range A1:A20-sized vs whole-column criteria");
});

await test("limits: 16 full columns with bottom-row data evaluate, 17 are #NUM! (documented cap); =SUM(A:C) is fast", COV, () => {
  const wb = new Workbook(); const s = wb.sheet();
  for (let c = 0; c < 17; c++) s.setCell(c, LAST, "1");
  s.setCell(20, 0, "=SUM(A:P)"); s.setCell(20, 1, "=SUM(A:Q)");
  wb.recalculate();
  assert.equal(valueOf(wb, 20, 0), 16);
  assert.deepEqual(valueOf(wb, 20, 1), { error: "#NUM!" });
  const w2 = bottomSheet(); w2.sheet().setCell(5, 0, "=SUM(A:C)");
  w2.recalculate();
  const t = performance.now(); w2.recalculate(); const ms = performance.now() - t;
  assert.equal(valueOf(w2, 5, 0), 113);
  console.log(`    (=SUM(A:C) over 1,048,576 rows: ${ms.toFixed(0)} ms; TT69 build: #NUM!, =SUM(A:A) ~1,060 ms)`);
  assert.ok(ms < 1500, `=SUM(A:C) recalculates in ${ms.toFixed(0)} ms`);
});

finish();
