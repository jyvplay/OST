/**
 * Office engine suite, part 2 (TT15): spreadsheet editing operations
 * (sheetops.ts) and the Excel number-format engine (numfmt.ts).
 *
 * Expected values come from Microsoft's documented Excel behaviour (format-code
 * guide, TEXT() examples, AutoFill/insert/delete reference rules), hand-derived
 * here — NOT read back from our own output. The PyPI `formulas` TEXT() was
 * probed as a second oracle and found wrong (e.g. TEXT(45361,"mmm d") → "Mar 1",
 * h with AM/PM → "18:00 PM", "#,##0," unscaled), so it is not used for numfmt.
 */
import assert from "node:assert/strict";
import type { Workbook, Scalar } from "../src/lib/formula/index.ts";
import {
  shiftFormula, adjustForStructure, insertDelete, toTsv, parseTsv, copyBlock, pasteBlock, clearRange, autoFill,
  sortRange, findAll, replaceAll, selectionStats, addFuturePrefixes, stripFuturePrefixes, parseA1Range, rangeA1,
} from "../src/lib/formula/sheetops.ts";
import { formatValue, formatGeneral } from "../src/lib/formula/numfmt.ts";
import { currentRegion, jump, fillTarget, looksLikeHeader, completionToken, completions, activeCall, hasValueIn } from "../src/lib/formula/sheetui.ts";
import { chartDataFromRange, buildChartSvg, niceTicks, evalCondFormats, sanitizeCharts, sanitizeCondFormats } from "../src/lib/formula/sheetmeta.ts";
import { workbookToJson, workbookFromJson } from "../src/lib/formula/workbook-json.ts";

type Covers = Record<string, "full" | "partial">;
interface H {
  test: (name: string, covers: Covers, fn: () => unknown) => Promise<void>;
  book: (cells: Record<string, string>) => { wb: Workbook; get: (ref: string) => Scalar | undefined; set: (ref: string, v: string) => void };
  near: (a: unknown, b: number, eps?: number) => void;
  errOf: (v: Scalar | undefined) => string | null;
}
const colOf = (s: string) => { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const at = (ref: string) => { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; return [colOf(m[1]), Number(m[2]) - 1] as const; };

export async function run({ test, book, errOf }: H) {
  console.log("\nSheet operations (sheetops.ts)");

  await test("shiftFormula: relative parts move, $-anchored parts stay, strings untouched, off-grid → #REF!", { "FF-28": "full" }, () => {
    assert.equal(shiftFormula("=A1+$B$1+C$2+$D3", 2, 3), "=C4+$B$1+E$2+$D6");
    assert.equal(shiftFormula("=SUM(A1:B2)", 1, 1), "=SUM(B2:C3)");
    assert.equal(shiftFormula('=CONCAT("A1",A1)', 0, 1), '=CONCAT("A1",A2)');
    assert.equal(shiftFormula("=Sheet2!A1*2", 1, 0), "=Sheet2!B1*2");
    assert.equal(shiftFormula("=A1", -1, 0), "=#REF!");
    assert.equal(shiftFormula("=$A1", -0, -0), "=$A1");
    assert.equal(shiftFormula("plain A1", 3, 3), "plain A1");
  });

  await test("adjustForStructure: insert/delete rows repair refs; deleted single ref → #REF!; ranges shrink; other sheets untouched", { "FF-28": "full" }, () => {
    assert.equal(adjustForStructure("=A5+A2", "Sheet1", "Sheet1", "row", 2, 3), "=A8+A2"); // insert 3 rows at index 2 (row 3)
    assert.equal(adjustForStructure("=SUM(A1:A10)", "Sheet1", "Sheet1", "row", 3, -2), "=SUM(A1:A8)");
    assert.equal(adjustForStructure("=A4", "Sheet1", "Sheet1", "row", 3, -1), "=#REF!");
    assert.equal(adjustForStructure("=SUM(A4:A5)", "Sheet1", "Sheet1", "row", 3, -2), "=SUM(#REF!)");
    assert.equal(adjustForStructure("=SUM(A3:A6)", "Sheet1", "Sheet1", "row", 1, -3), "=SUM(A2:A3)"); // band rows 2-4 deleted
    assert.equal(adjustForStructure("=Sheet2!A5", "Sheet1", "Sheet1", "row", 0, 1), "=Sheet2!A5");
    assert.equal(adjustForStructure("=Sheet2!A5", "Sheet1", "Sheet2", "row", 0, 1), "=Sheet2!A6");
    assert.equal(adjustForStructure("=C1+$C$1", "Sheet1", "Sheet1", "col", 1, 1), "=D1+$D$1"); // structural moves shift absolute refs too
  });

  await test("insertDelete: physical move + workbook-wide repair + recalculated values", { "FF-28": "full" }, () => {
    const { wb, get } = book({ A1: "1", A2: "2", A3: "3", A4: "=SUM(A1:A3)", B1: "=A3*10" });
    wb.addSheet("Other").setCell(0, 0, "=Sheet1!A3+1"); wb.recalculate();
    insertDelete(wb, "Sheet1", "row", 1, 2); // two blank rows before row 2
    assert.equal(wb.sheet("Sheet1").get(0, 5)?.input, "=SUM(A1:A5)");
    assert.equal(get("A6"), 6); assert.equal(get("B1"), 30);
    assert.equal(wb.sheet("Other").get(0, 0)?.input, "=Sheet1!A5+1"); assert.equal(wb.valueAt("Other", 0, 0), 4);
    insertDelete(wb, "Sheet1", "row", 4, -1); // delete the row holding the 3
    assert.equal(wb.sheet("Sheet1").get(1, 0)?.input, "=#REF!*10");
    assert.equal(errOf(get("B1")), "#REF!");
    assert.equal(get("A5"), 3); // SUM(A1:A4) of 1,_,_,2
    const s = wb.sheet("Sheet1"); s.colWidths[2] = 150; insertDelete(wb, "Sheet1", "col", 0, 1);
    assert.equal(s.colWidths[3], 150); assert.equal(s.get(1, 4)?.input, "=SUM(B1:B4)");
  });

  await test("TSV clipboard round-trip: tabs, newlines, quotes, CRLF, Excel-style quoting", { "FF-28": "full" }, () => {
    const rows = [["a", "b\tc", 'say "hi"'], ["multi\nline", "", "=A1"], ["", "x", ""]];
    const tsv = toTsv(rows);
    assert.equal(tsv.split("\r\n")[0], 'a\t"b\tc"\t"say ""hi"""');
    assert.deepEqual(parseTsv(tsv), rows);
    assert.deepEqual(parseTsv("1\t2\r\n3\t4\r\n"), [["1", "2"], ["3", "4"]]); // trailing newline as Excel copies
    assert.deepEqual(parseTsv('a"b\tc'), [['a"b', "c"]]); // mid-cell quote is literal
  });

  await test("copy/paste block shifts formulas and carries styles; clearRange contents vs all", { "FF-28": "full" }, () => {
    const { wb, get } = book({ A1: "2", B1: "=A1*3", A2: "5" });
    const s = wb.sheet(); s.setStyle(1, 0, { bold: true, numFmt: "0.00" });
    const clip = copyBlock(s, parseA1Range("A1:B1")!);
    pasteBlock(s, clip, 0, 1); wb.recalculate(); // paste onto A2:B2
    assert.equal(s.get(1, 1)?.input, "=A2*3"); assert.equal(get("B2"), 6); assert.deepEqual(s.get(1, 1)?.style, { bold: true, numFmt: "0.00" });
    clearRange(s, parseA1Range("B2")!); assert.equal(s.get(1, 1)?.input, ""); assert.ok(s.get(1, 1)?.style?.bold);
    clearRange(s, parseA1Range("B2")!, "all"); assert.equal(s.get(1, 1), undefined);
    assert.equal(rangeA1({ c0: 2, r0: 4, c1: 0, r1: 0 }), "A1:C5");
  });

  await test("autoFill: linear trend, text+number series, cyclic copy, formula shift, upward fill", { "FF-28": "full" }, () => {
    const { wb, get } = book({ A1: "1", A2: "3", B1: "Item 1", C1: "x", C2: "y", D1: "10", E1: "=D1*2" });
    const s = wb.sheet();
    autoFill(s, parseA1Range("A1:A2")!, parseA1Range("A1:A5")!);
    assert.deepEqual([3, 4, 5].map((r) => s.get(0, r - 1)?.input), ["5", "7", "9"]);
    autoFill(s, parseA1Range("B1")!, parseA1Range("B1:B3")!);
    assert.equal(s.get(1, 2)?.input, "Item 3");
    autoFill(s, parseA1Range("C1:C2")!, parseA1Range("C1:C5")!);
    assert.deepEqual([2, 3, 4].map((r) => s.get(2, r)?.input), ["x", "y", "x"]);
    autoFill(s, parseA1Range("D1:E1")!, parseA1Range("D1:E3")!); wb.recalculate();
    assert.equal(s.get(4, 2)?.input, "=D3*2"); assert.equal(get("E3"), 20); // single number copies (Excel without Ctrl)
    const b = book({ A5: "10", A6: "20" });
    autoFill(b.wb.sheet(), parseA1Range("A5:A6")!, parseA1Range("A3:A6")!);
    assert.equal(b.wb.sheet().get(0, 3)?.input, "0"); assert.equal(b.wb.sheet().get(0, 2)?.input, "-10");
    const c = book({ A1: "1", A2: "2", A3: "4" }); // least-squares trend: slope 1.5, intercept 0.8333
    autoFill(c.wb.sheet(), parseA1Range("A1:A3")!, parseA1Range("A1:A4")!);
    assert.equal(Number(c.wb.sheet().get(0, 3)?.input).toFixed(6), "5.333333");
  });

  await test("sortRange: stable, numbers<text<bool, blanks last both directions, header kept, formulas move", { "FF-28": "full" }, () => {
    const { wb, get } = book({ A1: "Name", B1: "Score", A2: "b", B2: "2", A3: "a", B3: "", A4: "c", B4: "2", A5: "d", B5: "1", A6: "e", B6: "x", C2: "=B2*10" });
    sortRange(wb, "Sheet1", parseA1Range("A1:C6")!, 1, true, true);
    assert.deepEqual([2, 3, 4, 5, 6].map((r) => get(`A${r}`)), ["d", "b", "c", "e", "a"]);
    assert.equal(get("A1"), "Name");
    assert.equal(wb.sheet().get(2, 2)?.input, "=B3*10"); assert.equal(get("C3"), 20);
    sortRange(wb, "Sheet1", parseA1Range("A2:B6")!, 1, false);
    assert.deepEqual([2, 3, 4, 5, 6].map((r) => get(`A${r}`)), ["e", "b", "c", "d", "a"]); // text>numbers, stable b before c, blank last
  });

  await test("find/replace and status-bar selection statistics", { "FF-28": "full" }, () => {
    const { wb } = book({ A1: "Apple", A2: "pineapple", A3: "=LEN(A1)", B1: "4", B2: "x", B3: "6" });
    assert.deepEqual(findAll(wb, "apple").map((h) => `${h.col},${h.row}`), ["0,0", "0,1"]);
    assert.equal(findAll(wb, "apple", { matchCase: true }).length, 1);
    assert.equal(findAll(wb, "LEN", { inFormulas: true }).length, 1);
    assert.equal(findAll(wb, "apple", { whole: true }).length, 1);
    assert.equal(replaceAll(wb, "apple", "pear"), 2);
    assert.equal(wb.valueAt("Sheet1", 0, 0), "pear"); assert.equal(wb.valueAt("Sheet1", 0, 2), 4);
    const st = selectionStats(wb, "Sheet1", parseA1Range("A1:B3")!);
    assert.deepEqual(st, { count: 6, numeric: 3, sum: 14, average: 14 / 3, min: 4, max: 6 });
  });

  await test("OOXML future-function prefixes: _xlfn./_xlfn._xlws. added on write, stripped on read, strings safe", { "FF-20": "partial", "FF-26": "partial" }, () => {
    assert.equal(addFuturePrefixes("SUM(FILTER(A1:A9,A1:A9>0))+XLOOKUP(1,B:B,C:C)"), "SUM(_xlfn._xlws.FILTER(A1:A9,A1:A9>0))+_xlfn.XLOOKUP(1,B:B,C:C)");
    assert.equal(addFuturePrefixes('CONCAT("SORT(",UNIQUE(A1:A3))'), '_xlfn.CONCAT("SORT(",_xlfn.UNIQUE(A1:A3))');
    assert.equal(stripFuturePrefixes('_xlfn._xlws.SORT(_xlfn.UNIQUE(A1:A3))&"_xlfn.x"'), 'SORT(UNIQUE(A1:A3))&"_xlfn.x"');
    for (const f of ["SEQUENCE(3)", "STDEV.S(A1:A4)", "IF(A1,1,2)"]) assert.equal(stripFuturePrefixes(addFuturePrefixes(f)), f);
  });

  console.log("\nNumber formats (numfmt.ts) — expected strings from Microsoft's format-code guide");
  const F = (v: Scalar, f: string) => formatValue(v, f).text;
  await test("numeric codes: 0.00, #,##0, $, %, scaling commas, ? alignment, # trailing, literals", { "FF-28": "full", "FF-19": "partial" }, () => {
    assert.equal(F(1234.567, "#,##0.00"), "1,234.57");
    assert.equal(F(1234.567, "$#,##0.00"), "$1,234.57");
    assert.equal(F(0.256, "0.0%"), "25.6%");
    assert.equal(F(1234567, "#,##0,"), "1,235"); // trailing comma scales by 1000
    assert.equal(F(12200000, "0.0,,\"M\""), "12.2M");
    assert.equal(F(3.1, "000.000"), "003.100");
    assert.equal(F(0.123, "#.##"), ".12");
    assert.equal(F(5, "#.##"), "5.");
    assert.equal(F(12.3, "???.??"), " 12.3 ");
    assert.equal(F(1234, '0" units"'), "1234 units");
    assert.equal(F(2.5, "0"), "3"); assert.equal(F(-2.5, "0"), "-3"); // half away from zero
    assert.equal(F(1.005, "0.00"), "1.01"); // decimal-string rounding, not binary 1.00499…
    assert.equal(F(-0.001, "0.00"), "0.00"); // no "-0.00"
  });
  await test("sections and colours: pos;neg;zero;text, [Red], auto minus only for 1 section", { "FF-28": "full" }, () => {
    assert.equal(F(-1234.5, "#,##0.00;(#,##0.00)"), "(1,234.50)");
    assert.equal(F(0, '0;-0;"zero"'), "zero");
    assert.deepEqual(formatValue(-5, "#,##0.00;[Red]-#,##0.00"), { text: "-5.00", color: "#ef4444" });
    assert.equal(F("abc", '0;0;0;"txt: "@'), "txt: abc");
    assert.equal(F("abc", "0.00"), "abc");
    assert.equal(F(true, "0.00"), "TRUE");
  });
  await test("scientific and General", { "FF-28": "full" }, () => {
    assert.equal(F(12200000, "0.00E+00"), "1.22E+07");
    assert.equal(F(0.000123, "0.00E+00"), "1.23E-04");
    assert.equal(F(999.99, "0.0E+0"), "1.0E+3"); // mantissa rounding carries into the exponent
    assert.equal(formatGeneral(0.1 + 0.2), "0.3");
    assert.equal(formatGeneral(1 / 3), "0.3333333333");
    assert.equal(formatGeneral(123456789012), "1.23457E+11");
    assert.equal(formatGeneral(42), "42");
  });
  await test("dates and times: serial 45361 = Sun 2024-03-10; m = minutes after h; AM/PM; elapsed [h]", { "FF-28": "full", "FF-19": "partial" }, () => {
    assert.equal(F(45361, "yyyy-mm-dd"), "2024-03-10");
    assert.equal(F(45361, "m/d/yy"), "3/10/24");
    assert.equal(F(45361, "mmm d"), "Mar 10");
    assert.equal(F(45361, "mmmmm"), "M");
    assert.equal(F(45361.75, "dddd, mmmm d, yyyy h:mm AM/PM"), "Sunday, March 10, 2024 6:00 PM");
    assert.equal(F(45361.5, "hh:mm:ss"), "12:00:00");
    assert.equal(F(0.5208333, "h:mm AM/PM"), "12:30 PM");
    assert.equal(F(0, "h:mm A/P"), "12:00 A");
    assert.equal(F(1.5, "[h]:mm"), "36:00");
    assert.equal(F(0.75, "[m]"), "1080");
    assert.equal(F(45361.000011574, "hh:mm:ss.00"), "00:00:01.00");
  });
  await test("TEXT() uses the format engine end-to-end through the formula engine", { "FF-19": "partial", "FF-28": "partial" }, () => {
    const { get } = book({ A1: "45361.75", B1: '=TEXT(A1,"ddd mmm d, h AM/PM")', B2: '=TEXT(-1234.5,"$#,##0.00;($#,##0.00)")', B3: '=TEXT("12.5","0.0")', B4: '=TEXT(1234.5,"0.00")' });
    assert.equal(get("B1"), "Sun Mar 10, 6 PM"); assert.equal(get("B2"), "($1,234.50)"); assert.equal(get("B3"), "12.5"); assert.equal(get("B4"), "1234.50");
  });

  console.log("\nSpreadsheet UI logic (sheetui.ts) and metadata (sheetmeta.ts, workbook JSON v2)");
  await test("currentRegion / Ctrl+Arrow jump / fill-handle geometry / header heuristic", { "FF-28": "full" }, () => {
    const { wb } = book({ B2: "Name", C2: "Qty", B3: "a", C3: "1", B4: "b", C4: "2", E9: "x" });
    const has = hasValueIn(wb, "Sheet1");
    assert.deepEqual(currentRegion(has, 2, 3, 51, 999), { c0: 1, r0: 1, c1: 2, r1: 3 });
    assert.deepEqual(currentRegion(has, 0, 0, 51, 999), { c0: 0, r0: 0, c1: 2, r1: 3 }); // diagonal neighbour B2 joins (Excel behaviour)
    assert.deepEqual(jump(has, 1, 1, 0, 1, 51, 999), { col: 1, row: 3 });   // B2 → end of block B4
    assert.deepEqual(jump(has, 1, 3, 0, 1, 51, 999), { col: 1, row: 999 }); // B4 → nothing below → sheet edge
    assert.deepEqual(jump(has, 4, 0, 0, 1, 51, 999), { col: 4, row: 8 });   // E1 (blank) → next value E9
    assert.deepEqual(jump(has, 0, 0, -1, 0, 51, 999), { col: 0, row: 0 });  // already at edge
    const sel = { c0: 1, r0: 1, c1: 2, r1: 3 };
    assert.deepEqual(fillTarget(sel, 2, 7), { c0: 1, r0: 1, c1: 2, r1: 7 });
    assert.deepEqual(fillTarget(sel, 6, 4), { c0: 1, r0: 1, c1: 6, r1: 3 }); // right dominates (4 cols vs 1 row)
    assert.equal(fillTarget(sel, 2, 2), null);
    assert.equal(looksLikeHeader(wb, "Sheet1", sel), true);
    assert.equal(looksLikeHeader(wb, "Sheet1", { c0: 1, r0: 2, c1: 2, r1: 3 }), false);
  });
  await test("formula autocomplete token, ranked completions, active-call argument index (strings/nesting aware)", { "FF-28": "full" }, () => {
    assert.equal(completionToken("=SU"), "SU"); assert.equal(completionToken("=A1+VLO"), "VLO");
    assert.equal(completionToken("=A1"), null); assert.equal(completionToken('="SU'), null); assert.equal(completionToken("SU"), null);
    assert.equal(completionToken("=Sheet2!A"), null);
    assert.deepEqual(completions("su", ["SUMIFS", "SUM", "SUBSTITUTE", "AVERAGE", "SUMIF"]).slice(0, 3), ["SUM", "SUMIF", "SUMIFS"]);
    assert.deepEqual(activeCall("=IF(A1>0,SUM(B1,"), { name: "SUM", arg: 1 });
    assert.deepEqual(activeCall("=IF(A1>0,SUM(B1,2),"), { name: "IF", arg: 2 });
    assert.deepEqual(activeCall('=TEXTJOIN(",",'), { name: "TEXTJOIN", arg: 1 }); // comma inside a string is not a separator
    assert.equal(activeCall("=SUM(1)"), null);
  });
  await test("charts: series from columns with header names, gaps for text, nice ticks, SVG escaping, error on no data", { "FF-29": "full" }, () => {
    const { wb } = book({ A1: "Month", B1: "Sales", C1: "<Cost>", A2: "Jan", B2: "10", C2: "4", A3: "Feb", B3: "n/a", C3: "6", A4: "Mar", B4: "=B2*3", C4: "5" });
    const d = chartDataFromRange(wb, "Sheet1", "A1:C4", true);
    assert.deepEqual(d.categories, ["Jan", "Feb", "Mar"]);
    assert.deepEqual(d.series, [{ name: "Sales", values: [10, null, 30] }, { name: "<Cost>", values: [4, 6, 5] }]);
    assert.deepEqual(niceTicks(0, 30), [0, 10, 20, 30]); assert.deepEqual(niceTicks(-3, 7), [-4, -2, 0, 2, 4, 6, 8]);
    for (const kind of ["bar", "line", "pie", "scatter"] as const) {
      const svg = buildChartSvg(kind, 'T & "q"', kind === "scatter" ? { categories: ["1", "2", "4"], series: d.series } : d);
      assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"), kind);
      assert.ok(!/<script|on\w+=/i.test(svg), "no active content");
      assert.ok(svg.includes("T &amp; &quot;q&quot;"), "title escaped");
      if (kind !== "pie") assert.ok(svg.includes("&lt;Cost&gt;"), "legend escaped");
    }
    assert.equal((buildChartSvg("bar", "", d).match(/<rect /g) ?? []).length - 1 - 2, 5 - 0); // bg + 5 bars (one gap) + 2 legend swatches
    assert.equal((buildChartSvg("line", "", d).match(/<polyline /g) ?? []).length, 1 + 3); // axis + Sales split by gap into 2 + Cost 1
    assert.throws(() => buildChartSvg("bar", "", { categories: ["x"], series: [{ name: "s", values: [null] }] }), /numeric point/);
    assert.throws(() => buildChartSvg("scatter", "", { categories: ["a"], series: [{ name: "s", values: [1] }] }), /numeric/);
  });
  await test("conditional formatting: comparison, between, contains, duplicate, top-N, colour scale, priority order", { "FF-29": "partial", "FF-28": "partial" }, () => {
    const { wb } = book({ A1: "5", A2: "15", A3: "25", A4: "15", B1: "apple", B2: "Pineapple", B3: "kiwi" });
    const m = evalCondFormats(wb, "Sheet1", [
      { id: "r1", sheet: "Sheet1", range: "A1:A4", kind: "gt", a: "20", fill: "#ff0000" },
      { id: "r2", sheet: "Sheet1", range: "A1:A4", kind: "between", a: "10", b: "30", fill: "#00ff00", bold: true },
      { id: "r3", sheet: "Sheet1", range: "B1:B3", kind: "contains", a: "APPLE", color: "#0000ff" },
      { id: "r4", sheet: "Sheet1", range: "A1:A4", kind: "duplicate", color: "#ffff00" },
    ]);
    assert.equal(m.get("0,2")?.fill, "#ff0000"); // r1 has priority over r2 for fill
    assert.equal(m.get("0,2")?.bold, true);       // non-conflicting props from lower rules still apply
    assert.equal(m.get("0,1")?.fill, "#00ff00"); assert.equal(m.get("0,0"), undefined);
    assert.equal(m.get("1,0")?.color, "#0000ff"); assert.equal(m.get("1,1")?.color, "#0000ff"); assert.equal(m.get("1,2"), undefined);
    assert.equal(m.get("0,1")?.color, "#ffff00"); assert.equal(m.get("0,3")?.color, "#ffff00");
    const top = evalCondFormats(wb, "Sheet1", [{ id: "t", sheet: "Sheet1", range: "A1:A4", kind: "top", a: "1", fill: "#123456" }]);
    assert.deepEqual([...top.keys()], ["0,2"]);
    const sc = evalCondFormats(wb, "Sheet1", [{ id: "s", sheet: "Sheet1", range: "A1:A3", kind: "scale", scaleMin: "#000000", scaleMax: "#ffffff" }]);
    assert.deepEqual([sc.get("0,0")?.fill, sc.get("0,1")?.fill, sc.get("0,2")?.fill], ["#000000", "#808080", "#ffffff"]);
  });
  await test("workbook JSON v2: styles, widths, freeze, charts, rules round-trip; untrusted input sanitised; v1 still loads", { "FF-28": "full", "FF-29": "partial" }, () => {
    const { wb } = book({ A1: "x", B2: "=A1" });
    const s = wb.sheet(); s.setStyle(0, 0, { bold: true, fill: "#112233", numFmt: "0.00" }); s.setStyle(3, 3, { italic: true }); s.colWidths[1] = 150; s.freezeRows = 1;
    wb.charts = [{ id: "c1", sheet: "Sheet1", range: "A1:B2", kind: "line", title: "t", headerRow: true }];
    wb.condFormats = [{ id: "r1", sheet: "Sheet1", range: "A1:A9", kind: "gt", a: "1", fill: "#ff0000" }];
    const back = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(wb))));
    const t = back.sheet();
    assert.deepEqual(t.get(0, 0)?.style, { bold: true, fill: "#112233", numFmt: "0.00" }); assert.deepEqual(t.get(3, 3)?.style, { italic: true });
    assert.equal(t.colWidths[1], 150); assert.equal(t.freezeRows, 1); assert.equal(back.valueAt("Sheet1", 1, 1), "x");
    assert.deepEqual(back.charts, wb.charts); assert.equal(back.condFormats[0].fill, "#ff0000");
    const evil = workbookFromJson({ sheets: [{ name: "S", cells: [{ ref: "A1", input: "1", style: { fill: "red;background:url(x)", color: "#abcdef", align: "evil" as never, bogus: 1 } as never }], colWidths: { "0": 1e9, x: 50 } as never }],
      charts: [{ id: "<img>", sheet: "S", range: "A1:B2", kind: "bar" }, { id: "ok", sheet: "S", range: "A1:B2", kind: "donut" }, { id: "ok2", sheet: "S", range: "A1:B2", kind: "pie", title: 7 }],
      condFormats: [{ id: "r", sheet: "S", range: "nope", kind: "gt" }, { id: "r2", sheet: "S", range: "A1:A2", kind: "gt", fill: "javascript:1" }] });
    assert.deepEqual(evil.sheet("S").get(0, 0)?.style, { color: "#abcdef" });
    assert.deepEqual(evil.sheet("S").colWidths, {});
    assert.deepEqual(evil.charts.map((c) => [c.id, c.title]), [["ok2", ""]]);
    assert.deepEqual(evil.condFormats.map((c) => [c.id, c.fill]), [["r2", undefined]]);
    const v1 = workbookFromJson({ sheets: [{ name: "Old", cells: [{ ref: "A1", input: "2" }, { ref: "A2", input: "=A1*2" }] }] });
    assert.equal(v1.valueAt("Old", 0, 1), 4);
  });
  await test("SORTBY (multi-key, mixed orders, size check) and SORT Excel ordering (case-insensitive, blanks last, by_col, index check)", { "FF-26": "full", "FF-27": "partial" }, () => {
    const { get } = book({ A1: "b", A2: "A", A3: "c", B1: "2", B2: "2", B3: "1", B4: "5",
      E1: "=SORTBY(A1:A3,B1:B3,1,A1:A3,-1)", F1: "=SORT(A1:B4,2,-1)", H1: "=SORTBY(A1:A3,B1:B2)", J1: "=SORT(A1:A3,3)",
      K1: '=SORT({"b";"B";"a";10;TRUE})', A8: "x", B8: "TRUE", C8: "3", D8: "apple", A10: "=SORT(A8:D8,1,1,TRUE)", A12: "=SORTBY({1,2,3},{3,1,2})", A14: "=SORT(B1:B3,1,0)" });
    assert.deepEqual(["E1", "E2", "E3"].map(get), ["c", "b", "A"]);
    assert.deepEqual(["F1", "G1", "F2", "G2", "F4", "G4"].map(get), ["", 5, "b", 2, "c", 1]);
    assert.equal(errOf(get("H1")), "#VALUE!"); assert.equal(errOf(get("J1")), "#VALUE!"); assert.equal(errOf(get("A14")), "#VALUE!");
    assert.deepEqual(["K1", "K2", "K3", "K4", "K5"].map(get), [10, "a", "b", "B", true]);
    assert.deepEqual(["A10", "B10", "C10", "D10"].map(get), [3, "apple", "x", true]);
    assert.deepEqual(["A12", "B12", "C12"].map(get), [2, 3, 1]);
  });
  void at;
}
