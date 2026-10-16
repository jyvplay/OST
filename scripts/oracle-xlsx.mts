/**
 * Oracle 3 (TT15): xlsx interoperability against openpyxl 3.1, an independent
 * OOXML implementation (PyPI). Both directions:
 *   A. OUR writer → openpyxl reads values, formulas (incl. _xlfn prefixes and
 *      array refs), fonts, fills, number formats, alignment, widths, panes.
 *   B. openpyxl-authored file (plus Excel-style shared/array formulas injected
 *      at XML level) → OUR reader; assert styles, widths, freeze, shared formula
 *      expansion, prefix stripping, and that stale array children don't block.
 * Requires a Python with openpyxl: ORACLE_PY=/path/to/python (default
 * /home/user/tools/venv/bin/python). If missing, the suite FAILS loudly rather
 * than reporting a pass it did not earn.
 *
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/oracle-xlsx.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook, isError } from "../src/lib/formula/index.ts";
import { writeXlsxWorkbook, readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const { test, finish } = makeHarness("oracle-xlsx");
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const dir = mkdtempSync(join(tmpdir(), "xlsx-oracle-"));
const py = (...args: string[]) => JSON.parse(execFileSync(PY, ["scripts/oracles/xlsx_openpyxl.py", ...args], { encoding: "utf8", timeout: 60_000 }));

await test("oracle available (openpyxl)", { "FF-20": "partial" }, () => {
  assert.ok(existsSync(PY), `no oracle python at ${PY} — set ORACLE_PY (pip install openpyxl)`);
  execFileSync(PY, ["-c", "import openpyxl"]);
});

await test("A. our writer → openpyxl: values, formulas, _xlfn prefixes, array formula + cached children, styles, widths, freeze", { "FF-20": "full", "FF-26": "partial", "FF-28": "partial" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  const put = (c: number, r: number, v: string) => s.setCell(c, r, v);
  put(0, 0, "Name"); put(1, 0, "Amount"); put(2, 0, "When");
  put(0, 1, "alpha"); put(1, 1, "1234.5"); put(2, 1, "45361");
  put(0, 2, "beta"); put(1, 2, "-20"); put(2, 2, "45362.5");
  put(3, 1, "=SUM(B2:B3)"); put(3, 2, '=TEXTJOIN("-",TRUE,A2:A3)'); put(3, 3, "=XLOOKUP(\"beta\",A2:A3,B2:B3)");
  put(4, 0, "=SEQUENCE(3)"); put(5, 0, "=SORT(B2:B3)"); put(6, 0, 'say "<hi>" & bye\u0007');
  s.setStyle(0, 0, { bold: true, italic: true, color: "#1f4e79" });
  s.setStyle(1, 0, { fill: "#fff2cc", align: "center", wrap: true, underline: true });
  s.setStyle(1, 1, { numFmt: "$#,##0.00" }); s.setStyle(1, 2, { numFmt: "#,##0.00;[Red]-#,##0.00" });
  s.setStyle(2, 1, { numFmt: "yyyy-mm-dd" }); s.setStyle(2, 2, { numFmt: "m/d/yyyy h:mm" });
  s.setStyle(7, 7, { fill: "#ff0000" }); // style-only blank H8
  s.colWidths[0] = 140; s.colWidths[3] = 75; s.freezeRows = 1;
  wb.recalculate();
  const f = join(dir, "ours.xlsx"); writeFileSync(f, writeXlsxWorkbook(wb, "Oracle"));
  const o = py("read", f).sheets[0]; const c = o.cells;
  assert.equal(c.A2.value, "alpha"); assert.equal(c.B2.value, 1234.5); assert.equal(c.G1.value, 'say "<hi>" & bye'); // control char stripped
  assert.equal(c.D2.value, "=SUM(B2:B3)"); assert.equal(c.D2.cached, 1214.5);
  assert.equal(c.D3.value, '=_xlfn.TEXTJOIN("-",TRUE,A2:A3)'); assert.equal(c.D3.cached, "alpha-beta");
  assert.equal(c.D4.value, '=_xlfn.XLOOKUP("beta",A2:A3,B2:B3)'); assert.equal(c.D4.cached, -20);
  assert.deepEqual(c.E1.value, { array: "=_xlfn.SEQUENCE(3)", ref: "E1:E3" });
  assert.deepEqual([c.E1.cached, c.E2.cached, c.E3.cached], [1, 2, 3]);
  assert.deepEqual(c.F1.value, { array: "=_xlfn._xlws.SORT(B2:B3)", ref: "F1:F2" }); assert.equal(c.F2.cached, 1234.5);
  assert.equal(c.A1.bold, true); assert.equal(c.A1.italic, true); assert.equal(c.A1.color, "#1f4e79");
  assert.equal(c.B1.fill, "#fff2cc"); assert.equal(c.B1.align, "center"); assert.equal(c.B1.wrap, true); assert.equal(c.B1.underline, "single");
  assert.equal(c.B2.numFmt, "$#,##0.00"); assert.equal(c.B3.numFmt, "#,##0.00;[Red]-#,##0.00");
  assert.equal(c.C2.numFmt, "yyyy-mm-dd"); assert.equal(c.C3.numFmt, "m/d/yyyy h:mm");
  assert.equal(c.H8.fill, "#ff0000"); assert.equal(c.H8.value, null);
  assert.ok(Math.abs(o.widths.A - 20) < 0.01, `A width ${o.widths.A}`); assert.ok(Math.abs(o.widths.D - 75 / 7) < 0.01);
  assert.equal(o.freeze, "A2");
});

await test("B. openpyxl-authored file → our reader: styles, widths, freeze, shared formulas, _xlfn strip, array children don't block", { "FF-21": "full", "FF-26": "partial", "FF-28": "partial" }, () => {
  const f = join(dir, "theirs.xlsx"); py("write", f);
  const wb = readXlsxWorkbook(readFileSync(f)); const s = wb.sheet("Data");
  const val = (c: number, r: number) => wb.valueAt("Data", c, r);
  assert.deepEqual(s.get(0, 0)?.style, { bold: true, italic: true, color: "#1f4e79" });
  assert.deepEqual(s.get(1, 0)?.style, { fill: "#fff2cc", align: "center", wrap: true });
  assert.equal(s.get(1, 1)?.style?.numFmt, "$#,##0.00");
  assert.deepEqual(s.get(4, 0)?.style, { underline: true }); assert.equal(s.get(4, 0)?.input, "");
  assert.equal(s.get(5, 1)?.style?.numFmt, "yyyy-mm-dd"); assert.equal(val(5, 1), 45361);
  assert.deepEqual([s.get(2, 1)?.input, s.get(2, 2)?.input, s.get(2, 3)?.input], ["=B2*2", "=B3*2", "=B4*2"]); // shared formula expanded
  assert.deepEqual([val(2, 1), val(2, 2), val(2, 3)], [3, 4.5, 8]);
  assert.equal(s.get(3, 1)?.input, '=TEXTJOIN(",",TRUE,A2:A4)'); assert.equal(val(3, 1), "a,b,c");
  assert.equal(s.get(6, 2), undefined, "array child cached value must not be materialised");
  assert.deepEqual([val(6, 1), val(6, 2), val(6, 3)], [15, 22.5, 40]); // re-spilled, stale 999s ignored
  assert.ok(!isError(val(6, 1) as never));
  assert.equal(s.colWidths[0], 140); assert.equal(s.freezeRows, 1); // width 20 → px = trunc((256·20 + trunc(128/7))/256 · 7) = 140 (Excel column-width rule)
});

finish();
