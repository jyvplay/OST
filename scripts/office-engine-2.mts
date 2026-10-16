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
  void at;
}
