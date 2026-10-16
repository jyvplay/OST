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
import { applyBorders, mergeCells, sanitizeValidation, validateEntry } from "../src/lib/formula/sheetlayout.ts";

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

await test("C. our writer → openpyxl: merges, per-edge borders (style+colour), vertical align, data validations (incl. inverted showDropDown), frozen rows+cols", { "FF-33": "full", "FF-34": "full", "FF-35": "full", "FF-20": "full" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(0, 0, "Title"); s.setCell(2, 0, "gone"); mergeCells(s, { c0: 0, r0: 0, c1: 3, r1: 0 }); mergeCells(s, { c0: 0, r0: 2, c1: 0, r1: 4 });
  s.setStyle(0, 0, { align: "center", valign: "center" });
  applyBorders(s, { c0: 1, r0: 2, c1: 2, r1: 3 }, "outside", { style: "medium", color: "#ff0000" });
  applyBorders(s, { c0: 1, r0: 2, c1: 2, r1: 3 }, "inside", { style: "dotted" });
  s.setStyle(4, 2, { border: { bottom: { style: "double" } } }); s.setStyle(5, 2, { border: { top: { style: "hair", color: "#00b050" } }, bold: true });
  const mk = (o: object) => sanitizeValidation({ allowBlank: true, showError: true, errorStyle: "stop", ...o })!;
  s.validations = [
    mk({ id: "a", sqref: "B6:B20", type: "list", formula1: '"Low,Medium,High"' }),
    mk({ id: "b", sqref: "C6:C20", type: "list", formula1: "$F$1:$F$3", inCellDropdown: false, allowBlank: false }),
    mk({ id: "c", sqref: "D6:D20 E6", type: "whole", operator: "between", formula1: "1", formula2: "10", errorStyle: "warning", errorTitle: "Range", error: "1 to 10 <please> & thanks" }),
    mk({ id: "d", sqref: "I6:I20", type: "custom", formula1: 'AND(I6>0,I6<"z")', promptTitle: "Even", prompt: "an even number" }),
  ];
  s.freezeRows = 1; s.freezeCols = 2;
  const f = join(dir, "layout-ours.xlsx"); writeFileSync(f, writeXlsxWorkbook(wb));
  const o = JSON.parse(execFileSync(PY, ["scripts/oracles/xlsx_openpyxl.py", "layout-read", f], { encoding: "utf8" })).sheets[0];
  assert.deepEqual(o.merges, ["A1:D1", "A3:A5"]); assert.equal(o.freeze, "C2");
  assert.deepEqual(o.valign, { A1: "center" });
  assert.deepEqual(o.borders.B3, { left: { style: "medium", color: "#ff0000" }, top: { style: "medium", color: "#ff0000" }, right: { style: "dotted", color: "#000000" }, bottom: { style: "dotted", color: "#000000" } });
  assert.deepEqual(o.borders.C4, { right: { style: "medium", color: "#ff0000" }, bottom: { style: "medium", color: "#ff0000" }, left: { style: "dotted", color: "#000000" }, top: { style: "dotted", color: "#000000" } });
  assert.deepEqual(o.borders.E3, { bottom: { style: "double", color: "#000000" } }); assert.deepEqual(o.borders.F3, { top: { style: "hair", color: "#00b050" } });
  const [a, b, c, d] = o.validations;
  assert.deepEqual([a.type, a.sqref, a.formula1, a.allowBlank, a.showDropDown, a.showErrorMessage], ["list", "B6:B20", '"Low,Medium,High"', true, false, true]);
  assert.deepEqual([b.formula1, b.allowBlank, b.showDropDown], ["$F$1:$F$3", false, true], "hidden arrow ⇒ showDropDown=1");
  assert.deepEqual([c.type, c.operator, c.sqref, c.formula1, c.formula2, c.errorStyle, c.errorTitle, c.error], ["whole", "between", "D6:D20 E6", "1", "10", "warning", "Range", "1 to 10 <please> & thanks"]);
  assert.deepEqual([d.type, d.formula1, d.promptTitle, d.prompt], ["custom", 'AND(I6>0,I6<"z")', "Even", "an even number"]);
});

await test("D. openpyxl-authored layout → our reader: merges, borders (theme colour → unset, mediumDashed dropped), valign, 6 validation kinds, freeze B2; rules enforce", { "FF-33": "full", "FF-34": "full", "FF-35": "full", "FF-21": "full" }, () => {
  const f = join(dir, "layout-theirs.xlsx"); execFileSync(PY, ["scripts/oracles/xlsx_openpyxl.py", "layout-write", f]);
  const wb = readXlsxWorkbook(readFileSync(f)); const s = wb.sheet("Layout");
  assert.deepEqual(s.merges, [{ c0: 0, r0: 0, c1: 3, r1: 0 }, { c0: 0, r0: 2, c1: 0, r1: 4 }]);
  assert.equal(s.get(2, 0)?.input ?? "", "", "covered cell value not present");
  assert.deepEqual(s.get(0, 0)?.style, { align: "center", valign: "center" });
  assert.deepEqual(s.get(1, 2)?.style?.border, { left: { style: "thin", color: "#000000" }, right: { style: "medium", color: "#ff0000" }, top: { style: "dashed" }, bottom: { style: "double", color: "#00b050" } });
  assert.deepEqual(s.get(2, 2)?.style?.border, { bottom: { style: "thick" } }, "theme colour read as unset");
  assert.equal(s.get(3, 2)?.style?.border, undefined, "mediumDashed is outside our border set (declared)");
  assert.equal(s.get(1, 3)?.style?.valign, "top");
  assert.equal(s.freezeRows, 1); assert.equal(s.freezeCols, 1);
  assert.deepEqual(s.validations.map((v) => [v.type, v.sqref, v.inCellDropdown, v.showError, v.errorStyle]), [
    ["list", "B6:B20", true, true, "stop"], ["list", "C6:C20", false, true, "stop"], ["whole", "D6:D20 E6", true, false, "warning"],
    ["decimal", "G6:G20", true, true, "stop"], ["textLength", "H6:H20", true, true, "stop"], ["custom", "I6:I20", true, true, "stop"]]);
  assert.equal(s.validations[3].prompt, "positive");
  const ok = (c: number, r: number, v: string) => validateEntry(wb, "Layout", c, r, v).ok;
  assert.ok(ok(1, 5, "high") && !ok(1, 6, "Extreme")); assert.ok(ok(2, 5, "Green") && !ok(2, 6, "Pink"));
  assert.ok(ok(3, 5, "50"), "showErrorMessage=0 in the file ⇒ no block (Excel shows no alert)");
  assert.ok(ok(6, 5, "0.5") && !ok(6, 6, "-1")); assert.ok(ok(7, 5, "hello") && !ok(7, 6, "toolong"));
  assert.ok(ok(8, 5, "4") && !ok(8, 6, "3"));
});

finish();
