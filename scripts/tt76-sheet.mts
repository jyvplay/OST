/**
 * TT76 — AutoFilter criteria EVALUATION (custom / top-10 / average / dynamic dates / date groups / colour / icon).
 *
 * Until TT75 Fusion kept these criteria byte-faithfully but never evaluated them ("foreign": the file's hidden rows
 * were frozen). TT76 evaluates every ECMA-376 §18.3.2 criterion (src/lib/formula/filtereval.ts). Evidence here:
 *
 *  O1  EXTERNAL ORACLE FILES — files whose hidden rows were computed by OTHER implementations: Excel (Apache POI's
 *      ConditionalFormattingSamples.xlsx, a table custom filter and an icon filter), ClosedXML (MIT; its AutoFilter
 *      example outputs: custom, top/bottom, dynamic average, date-group, regular) and LibreOffice (autofilter.xlsx).
 *      Fusion re-evaluates each filter and must hide EXACTLY the rows the file hides. One file is declared up front as a
 *      locale boundary (Excel wrote "10 000.00" with a space thousands separator; Fusion formats en-US).
 *  S1–S4 PORTED EXPECTATIONS — ClosedXML (MIT) Custom/Regular/Dynamic/Top10 filter tests and PhpSpreadsheet (MIT)
 *      AutoFilterAverageTop10Test, re-typed as data (test-only; no code copied — expectations are facts about Excel).
 *  D1  dynamic date ranges: the ECMA-376 §18.18.26 worked example and every relative type on a fixed "today".
 *  R1–R4 round trips: Fusion's new-package writer and in-place patcher → ECMA-376 XSD → openpyxl (independent reader)
 *      sees the same typed criterion and the same hidden rows → Fusion rereads and re-evaluates identically; colour
 *      filters re-create their dxf; the UI's JSON form keeps criteria + colours; column insert/delete shifts them.
 *  N1–N17 negative shapes (hostile files, ReDoS, out-of-range numbers, malformed criteria, epoch confusion, …).
 *
 * Needs: /home/user/tools/venv (openpyxl, lxml), /home/user/tools/xsd (ECMA-376), /home/user/tools/corpus/filters.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx, loadedBaseline } from "../src/lib/formula/xlsx-patch.ts";
import { openZip } from "../src/lib/office/zipkit.ts";
import { workbookFromJson, workbookToJson, type WorkbookJson } from "../src/lib/formula/workbook-json.ts";
import { insertDelete } from "../src/lib/formula/sheetops.ts";
import { setAutoFilter, setFilterCriteria, setFilterColumn, applyAutoFilter, applyTableFilter, filterCriteria, readAutoFilterXml, sanitizeFilterColumnXml, filterRange } from "../src/lib/formula/sheetfilter.ts";
import { parseCrit, critXml, matchWildcard, hasWildcard, dateRange, evaluateFilter, type ColumnCrit } from "../src/lib/formula/filtereval.ts";
import { dateToSerial, isDate1904, setDate1904 } from "../src/lib/formula/dates.ts";
import { UI_OPS, uiRule, ruleUi, draftToCrit, critToDraft, emptyDraft, colourOptions, iconOptions, describeCrit, DATE_CHOICES, type CondDraft } from "../src/lib/formula/filterui.ts";

const { test, finish } = makeHarness("tt76-sheet");
const ONLY = process.env.TT76_ONLY;
const want = (id: string) => !ONLY || ONLY.split(/[ ,]+/).includes(id);
const PY = "/home/user/tools/venv/bin/python";
const FILTERS = "/home/user/tools/corpus/filters";
const tmp = mkdtempSync(join(tmpdir(), "tt76s-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const J = (v: unknown) => JSON.stringify(v);
// TT76 register row FF-62: AutoFilter criteria evaluation (plus the sheet rows it extends)
const FILT = { "FF-19": "full", "FF-21": "full", "FF-62": "full" } as const;

/* ------------------------------------------------------------------ helpers */
type Spec = string | [string, string]; // setCell input, or [input, numFmt]
/** Column A: header "H" in row 0, then the given cells; an AutoFilter over A1:A(n+1). */
function colBook(cells: Spec[]): Workbook {
  const wb = new Workbook(); const s = wb.sheet("Sheet1");
  s.setCell(0, 0, "H");
  cells.forEach((c, i) => {
    const [input, fmt] = typeof c === "string" ? [c, undefined] : c;
    if (input !== "") s.setCell(0, i + 1, input);
    if (fmt) s.setStyle(0, i + 1, { numFmt: fmt });
  });
  wb.recalculate();
  setAutoFilter(wb, "Sheet1", { c0: 0, r0: 0, c1: 0, r1: cells.length });
  return wb;
}
/** Which data rows (1-based positions in `cells`) stay visible under `crit`. */
function visible(cells: Spec[], crit: ColumnCrit, today?: number): boolean[] {
  const wb = colBook(cells); setFilterCriteria(wb, "Sheet1", 0, crit, undefined, { today });
  const s = wb.sheet("Sheet1"); return cells.map((_, i) => !s.hiddenRows.has(i + 1));
}
const vis = (b: boolean[]) => b.map((x) => (x ? "T" : "F")).join("");
const custom = (op: string, val: string, op2?: string, val2?: string, and = false): ColumnCrit =>
  ({ kind: "custom", and, rules: [{ op, val }, ...(op2 ? [{ op: op2, val: val2! }] : [])] } as ColumnCrit);
const DATE = "yyyy-mm-dd";
const d = (y: number, m: number, dd: number): Spec => [String(dateToSerial(y, m, dd)), DATE];
const py = <T,>(script: string, files: string[]): Record<string, T> => {
  const out: Record<string, T> = {};
  for (let k = 0; k < files.length; k += 20) Object.assign(out, JSON.parse(execFileSync(PY, [script, ...files.slice(k, k + 20)], { encoding: "utf8", maxBuffer: 256 << 20 })));
  return out;
};
type OxCol = { colId: number; values?: string[]; blank?: boolean; dates?: Record<string, unknown>[]; top10?: { top: boolean; percent: boolean; val: number; filterVal: number | null }; custom?: { and: boolean; rules: { op: string; val: string }[] }; dynamic?: { type: string; val: number | null; maxVal: number | null }; color?: { cell: boolean; dxfId: number; rgb: string | null }; icon?: { iconSet: string; iconId: number | null } };
type OxAf = { ref: string; columns: OxCol[] } | null;
type OxFile = { sheets: Record<string, { autoFilter: OxAf; hidden: number[]; tables: Record<string, OxAf> }> } | { error: string };
const ox = (files: string[]) => py<OxFile>("scripts/oracle/xlsx_filters.py", files);
const xsd = (files: string[]) => py<{ parts: Record<string, string[]> }>("scripts/oracle/ooxml_xsd.py", files);
const xsdErrors = (r: { parts: Record<string, string[]> } | undefined) => r ? Object.entries(r.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e[0]}`) : ["no XSD result"];
/** rows hidden (any reason) strictly inside (r0, r1] */
const hiddenIn = (wb: Workbook, sheet: string, r0: number, r1: number) => [...wb.sheet(sheet).hiddenRows.keys()].filter((r) => r > r0 && r <= r1).sort((a, b) => a - b);

/* ================================================================== O1 external oracle files */
if (want("O1")) await test("O1 external oracles: Excel / ClosedXML / LibreOffice hidden rows == Fusion's re-evaluation", FILT, () => {
  ok(existsSync(FILTERS), `${FILTERS} missing (scripts/corpus/fetch-filters.sh)`);
  // Locale boundary declared BEFORE running: Excel (a locale with a space thousands separator) stored the value-list item
  // "10 000.00"; Fusion displays 10000 as "10,000.00" (en-US), so that one row is expected to differ.
  const LOCALE = new Set(["cx_Other_AutoFilter_AutoFilterWithThousandsSeparator.xlsx"]);
  const files = readdirSync(FILTERS).filter((f) => f.endsWith(".xlsx")).sort();
  const rows: string[] = []; let agree = 0, cases = 0; const bad: string[] = []; const localeSeen: string[] = [];
  const kinds = new Set<string>(); const writers = new Set<string>();
  for (const f of files) {
    const wb = readXlsxWorkbook(readFileSync(join(FILTERS, f)));
    const writer = f.startsWith("poi_") ? "Excel" : f.includes("_LO_") ? "LibreOffice" : f.includes("ThousandsSeparator") ? "Excel" : "ClosedXML";
    const check = (label: string, sheet: string, r0: number, r1: number, critKinds: string[], apply: () => void, foreign: () => boolean) => {
      if (!critKinds.length) return;
      const before = hiddenIn(wb, sheet, r0, r1); apply(); const after = hiddenIn(wb, sheet, r0, r1);
      cases++; const same = J(before) === J(after) && !foreign();
      critKinds.forEach((k) => kinds.add(k)); writers.add(writer);
      rows.push(`${f} ${label} [${critKinds.join(",")}] file=${J(before)} fusion=${J(after)}${foreign() ? " FOREIGN" : ""}`);
      if (same) agree++; else if (LOCALE.has(f)) localeSeen.push(f); else bad.push(rows[rows.length - 1]);
    };
    const kindOf = (raw: Record<number, string> | undefined, cols: Record<number, string[]>) => [
      ...Object.values(raw ?? {}).map((x) => { const c = parseCrit(x); return c ? (c.kind === "values" && c.dates.length ? "dateGroup" : c.kind === "dynamic" ? `dynamic:${c.type}` : c.kind) : "unparsed"; }),
      ...Object.keys(cols).filter((k) => !(raw && k in raw)).map(() => "values")];
    for (const name of [...wb.sheets.keys()]) {
      const sh = wb.sheet(name); const r = filterRange(sh);
      if (r && sh.autoFilter) check(`sheet ${name} ${sh.autoFilter.ref}`, name, r.r0, r.r1, kindOf(sh.autoFilter.raw, sh.autoFilter.cols), () => applyAutoFilter(wb, name), () => !!sh.autoFilter?.foreign);
    }
    for (const t of wb.tables.values()) {
      if (!t.filter) continue;
      check(`table ${t.name}`, t.sheet, t.r0, t.r1 - t.totalsRows, kindOf(t.filter.raw, t.filter.cols), () => applyTableFilter(wb, t.name), () => !!t.filter?.foreign);
    }
  }
  console.log("  " + rows.join("\n  "));
  ok(!bad.length, `disagreements:\n${bad.join("\n")}`);
  ok(J(localeSeen) === J([...LOCALE]), `declared locale boundary not observed exactly: ${J(localeSeen)}`);
  for (const k of ["custom", "top10", "dynamic:aboveAverage", "dynamic:belowAverage", "dateGroup", "values", "icon"]) ok(kinds.has(k), `no oracle case of ${k}`);
  for (const w of ["Excel", "ClosedXML", "LibreOffice"]) ok(writers.has(w), `no oracle written by ${w}`);
  ok(cases >= 15, `only ${cases} oracle cases`);
  return `${agree}/${cases} filters agree exactly (writers: ${[...writers].join(", ")}; kinds: ${[...kinds].sort().join(", ")}); locale boundary: ${localeSeen.length}`;
});

/* ================================================================== S1 top-10 (ClosedXML Top10 tests, PhpSpreadsheet AutoFilterAverageTop10Test) */
if (want("S1")) await test("S1 top/bottom N and N% — ties included, numbers only (ported ClosedXML + PhpSpreadsheet expectations)", FILT, () => {
  const top = (val: number, t = true, percent = false): ColumnCrit => ({ kind: "top10", top: t, percent, val });
  const cases: [string, Spec[], ColumnCrit, string][] = [
    ["CX top 3", ["4", "4", "1", "3", "2", "5"], top(3), "TTFFFT"],
    ["CX top 2 tie on 2nd", ["5", "4", "4", "4", "3", "2", "1"], top(2), "TTTTFFF"],
    ["CX top 2 tie on 1st", ["5", "5", "4", "4", "4", "3"], top(2), "TTFFFF"],
    ["CX bottom 2 tie", ["1", "2", "2", "2", "3", "4", "5"], top(2, false), "TTTTFFF"],
    ["CX top 1% of 3 → at least 1", ["3", "2", "1"], top(1, true, true), "TFF"],
    ["CX numbers only (date counts, text/bool/error/blank never)", [[String(41), DATE], "11", "10", "'-1000", "Text", "", "TRUE", "FALSE", "#VALUE!"], top(1), "TFFFFFFFF"],
    // PhpSpreadsheet A2:A10 = 1,3,5,7,9,2,4,6,8
    ["PS top 2", ["1", "3", "5", "7", "9", "2", "4", "6", "8"], top(2), "FFFFTFFFT"],
    ["PS bottom 3", ["1", "3", "5", "7", "9", "2", "4", "6", "8"], top(3, false), "TTFFFTFFF"],
    ["PS top 10%", ["1", "3", "5", "7", "9", "2", "4", "6", "8"], top(10, true, true), "FFFFTFFFF"],
    ["PS bottom 40%", ["1", "3", "5", "7", "9", "2", "4", "6", "8"], top(40, false, true), "TTFFFTFFF"],
    // PhpSpreadsheet tie data 1,3,3,7,9,4,4,8,8
    ["PS ties bottom 2", ["1", "3", "3", "7", "9", "4", "4", "8", "8"], top(2, false), "TTTFFFFFF"],
    ["PS ties bottom 1", ["1", "3", "3", "7", "9", "4", "4", "8", "8"], top(1, false), "TFFFFFFFF"],
    ["PS ties top 5", ["1", "3", "3", "7", "9", "4", "4", "8", "8"], top(5), "FFFTTTTTT"],
    ["PS ties top 1", ["1", "3", "3", "7", "9", "4", "4", "8", "8"], top(1), "FFFFTFFFF"],
    ["PS ties bottom 25%", ["1", "3", "3", "7", "9", "4", "4", "8", "8"], top(25, false, true), "TTTFFFFFF"],
    ["PS ties top 25%", ["1", "3", "3", "7", "9", "4", "4", "8", "8"], top(25, true, true), "FFFFTFFTT"],
  ];
  const fails = cases.filter(([, cells, c, exp]) => vis(visible(cells, c)) !== exp).map(([n, cells, c, exp]) => `${n}: want ${exp} got ${vis(visible(cells, c))}`);
  // top 25% of 1..1000 → exactly 751..1000
  const big = Array.from({ length: 1000 }, (_, i) => String(i + 1)); const v = visible(big, top(25, true, true));
  if (v.filter(Boolean).length !== 250 || !v[750] || v[749]) fails.push(`CX top 25% of 1..1000: ${v.filter(Boolean).length} shown`);
  // recomputed cut-off is written back as filterVal (Excel stores it; readers rely on it)
  const wb = colBook(["1", "3", "5", "7", "9"]); setFilterCriteria(wb, "Sheet1", 0, top(2));
  const fc = filterCriteria(wb.sheet("Sheet1"), 0); if (fc?.kind !== "top10" || fc.filterVal !== 7) fails.push(`filterVal ${J(fc)}`);
  ok(!fails.length, fails.join("\n"));
  return `${cases.length + 2} top-10 expectations hold (16 ported cases + 1..1000 + filterVal write-back)`;
});

/* ================================================================== S2 average (ClosedXML DynamicFilterTests, PhpSpreadsheet) */
if (want("S2")) await test("S2 above/below average — numbers only, strict, average written back as val", FILT, () => {
  const av = (type: "aboveAverage" | "belowAverage"): ColumnCrit => ({ kind: "dynamic", type });
  const cases: [string, Spec[], ColumnCrit, string][] = [
    ["CX above 1,2,3,4,5,10", ["1", "2", "3", "4", "5", "10"], av("aboveAverage"), "FFFFTT"],
    ["CX below 1,2,3", ["1", "2", "3"], av("belowAverage"), "TFF"],
    ["CX above 1,2,3", ["1", "2", "3"], av("aboveAverage"), "FFT"],
    ["CX non-numbers ignored", [[String(1), DATE], "1.1", "1.2", "=NA()", "TRUE", "FALSE", "'-100", "Text", ""], av("belowAverage"), "TFFFFFFFF"],
    ["CX no numbers → all hidden", ["a", "b", "TRUE"], av("aboveAverage"), "FFF"],
    ["PS above", ["1", "3", "5", "7", "9", "2", "4", "6", "8"], av("aboveAverage"), "FFFTTFFTT"],
    ["PS below", ["1", "3", "5", "7", "9", "2", "4", "6", "8"], av("belowAverage"), "TTFFFTTFF"],
  ];
  const fails = cases.filter(([, cells, c, exp]) => vis(visible(cells, c)) !== exp).map(([n, cells, c, exp]) => `${n}: want ${exp} got ${vis(visible(cells, c))}`);
  const wb = colBook(["1", "2", "6"]); setFilterCriteria(wb, "Sheet1", 0, av("aboveAverage"));
  const fc = filterCriteria(wb.sheet("Sheet1"), 0); if (fc?.kind !== "dynamic" || fc.val !== 3) fails.push(`val write-back ${J(fc)}`);
  ok(!fails.length, fails.join("\n"));
  return `${cases.length + 1} average expectations hold`;
});

/* ================================================================== S3 custom (ClosedXML CustomFilterTests) */
if (want("S3")) await test("S3 custom filters — typed comparison, wildcard equal, display-text equal, typed notEqual, And/Or", FILT, () => {
  const cases: [string, Spec[], ColumnCrit, string][] = [
    ["<= TRUE: booleans only", ["FALSE", "TRUE", "", "1", "'FALSE", "'TRUE", "#NULL!"], custom("lessThanOrEqual", "TRUE"), "TTFFFFF"],
    ["<= 1: numbers (dates too) only", ["1", [String(1), DATE], "0.9", "1.1", "'1", "", "Hello", "TRUE", "#NULL!"], custom("lessThanOrEqual", "1"), "TTTFFFFFF"],
    ["<= b: text, case-insensitive, \"\" counts", ['=""', "A", "b", "B", "C", "", "1", "FALSE", "#NULL!"], custom("lessThanOrEqual", "b"), "TTTTFFFFF"],
    ["<= #REF!: errors by code", ["#NULL!", "#VALUE!", "#REF!", "#NAME?", "1", "'#NULL!", "Test", '=""', "TRUE", "FALSE", ""], custom("lessThanOrEqual", "#REF!"), "TTTFFFFFFFF"],
    ["< b", ['=""', "A", "b", "B", "C", ""], custom("lessThan", "b"), "TTFFFF"],
    ["> b", ["C", "c", '=""', "A", "b", "B", "", "1", "FALSE", "#NULL!"], custom("greaterThan", "b"), "TTFFFFFFFF"],
    [">= b", ["b", "B", "Ba", "C", "c", '=""', "A", "", "1", "FALSE", "#NULL!"], custom("greaterThanOrEqual", "b"), "TTTTTFFFFFF"],
    ["equal 1*0: wildcard → text only", ["'1.0", "1 and 0", "1", "A", "B", "2", "#DIV/0!", "TRUE", "FALSE", ["1", '"1.0"'], ["1", "0.00"]], custom("equal", "1*0"), "TTFFFFFFFFF"],
    ["equal 1.00: displayed text", ["'1.00", ["1", "0.00"], ["99", '"1.00"'], "1", "A", "B", "2", "#DIV/0!", "TRUE", "FALSE"], custom("equal", "1.00"), "TTTFFFFFFF"],
    ["notEqual 1.00: hides same type+value only", ["1", ["1", "0.00"], "'1.00", ["99", '"1.00"'], "A", "B", "2", "#DIV/0!", "TRUE", "FALSE"], custom("notEqual", "1.00"), "FFTTTTTTTT"],
    ["notEqual 1*0: hides matching text only", ["1", ["1", "0.00"], "'1.00", "'100", "100", ["99", '"1.00"'], "A", "B", "2", "#DIV/0!", "TRUE", "FALSE"], custom("notEqual", "1*0"), "TTFFTTTTTTTT"],
    ["between 2 and 4 (And)", ["1", "2", "3", "4", "5"], custom("greaterThanOrEqual", "2", "lessThanOrEqual", "4", true), "FTTTF"],
    ["1 or 5 (Or)", ["1", "2", "3", "4", "5"], custom("equal", "1", "equal", "5"), "TFFFT"],
    ["begins with ap (wildcard ap*)", ["apple", "Apricot", "grape", "snap", "1"], custom("equal", "ap*"), "TTFFF"],
    ["contains ?a? escaped ~?", ["wh?", "what", "a?b"], custom("equal", "*~?*"), "TFT"],
    ["blanks: equal ' '", ["1", "", '=""', "x"], custom("equal", " "), "FTTF"],
    ["non-blanks: notEqual ' '", ["1", "", '=""', "x"], custom("notEqual", " "), "TFFT"],
  ];
  const fails = cases.filter(([, cells, c, exp]) => vis(visible(cells, c)) !== exp).map(([n, cells, c, exp]) => `${n}: want ${exp} got ${vis(visible(cells, c))}`);
  ok(!fails.length, fails.join("\n"));
  return `${cases.length} custom-filter expectations hold (10 ported ClosedXML, en-US decimal separator)`;
});

/* ================================================================== S4 value lists + date groups (ClosedXML RegularFilterTests) */
if (want("S4")) await test("S4 value lists compare displayed text, * is literal, date groups OR with values", FILT, () => {
  const vals = (vs: string[], dates: ColumnCrit extends infer _ ? { year: number; month?: number; day?: number; grouping: string }[] : never = []): ColumnCrit =>
    ({ kind: "values", vals: vs, blank: false, dates: dates.map((g) => ({ hour: undefined, minute: undefined, second: undefined, ...g })) } as unknown as ColumnCrit);
  const cases: [string, Spec[], ColumnCrit, string][] = [
    ["1.5 matches displayed 1.5 and text 1.5", ["1.5", "'1.5", "'1.50", ["1.5", "0.00%"], ["700", '"1.5"']], vals(["1.5"]), "TTFFT"],
    ["A* literal", ["'A*", "A", "A something"], vals(["A*"]), "TFF"],
    ["FALSE", ["FALSE", "0", "'FALSE", "'TRUE", "TRUE", ["77", '"FALSE"']], vals(["FALSE"]), "TFTFFT"],
    ["#VALUE!", ["#VALUE!", "2", "'#VALUE!"], vals(["#VALUE!"]), "TFT"],
    ["value 1 OR Aug 2015", ["1", "2", d(2015, 7, 25), d(2015, 8, 25)], vals(["1"], [{ year: 2015, month: 8, grouping: "month" }]), "TFFT"],
    ["year group", [d(2014, 12, 31), d(2015, 1, 1), d(2015, 12, 31), d(2016, 1, 1)], vals([], [{ year: 2015, grouping: "year" }]), "FTTF"],
    ["day group", [d(2018, 1, 4), d(2018, 1, 5), d(2018, 2, 4)], vals([], [{ year: 2018, month: 1, day: 4, grouping: "day" }]), "TFF"],
  ];
  const fails = cases.filter(([, cells, c, exp]) => vis(visible(cells, c)) !== exp).map(([n, cells, c, exp]) => `${n}: want ${exp} got ${vis(visible(cells, c))}`);
  ok(!fails.length, fails.join("\n"));
  return `${cases.length} value-list / date-group expectations hold`;
});

/* ================================================================== D1 dynamic dates */
if (want("D1")) await test("D1 relative dates: ECMA-376 §18.18.26 example + every relative type on a fixed today", FILT, () => {
  const S = dateToSerial; const fails: string[] = [];
  // ECMA example: today 22 Sep (2006) → thisWeek is >= 17 Sep and < 24 Sep (weeks start on Sunday)
  const ex = dateRange("thisWeek", S(2006, 9, 22)); if (J(ex) !== J([S(2006, 9, 17), S(2006, 9, 24)])) fails.push(`ECMA thisWeek ${J(ex)}`);
  const T = S(2026, 10, 25); // a Sunday
  const want2: Record<string, [number, number]> = {
    today: [T, T + 1], yesterday: [T - 1, T], tomorrow: [T + 1, T + 2], thisWeek: [T, T + 7], lastWeek: [T - 7, T], nextWeek: [T + 7, T + 14],
    thisMonth: [S(2026, 10, 1), S(2026, 11, 1)], lastMonth: [S(2026, 9, 1), S(2026, 10, 1)], nextMonth: [S(2026, 11, 1), S(2026, 12, 1)],
    thisQuarter: [S(2026, 10, 1), S(2027, 1, 1)], lastQuarter: [S(2026, 7, 1), S(2026, 10, 1)], nextQuarter: [S(2027, 1, 1), S(2027, 4, 1)],
    thisYear: [S(2026, 1, 1), S(2027, 1, 1)], lastYear: [S(2025, 1, 1), S(2026, 1, 1)], nextYear: [S(2027, 1, 1), S(2028, 1, 1)], yearToDate: [S(2026, 1, 1), T + 1],
  };
  for (const [k, w] of Object.entries(want2)) { const g = dateRange(k, T); if (J(g) !== J(w)) fails.push(`${k}: want ${J(w)} got ${J(g)}`); }
  // December rolls the year for next month / next quarter
  const dec = S(2026, 12, 15); if (J(dateRange("nextMonth", dec)) !== J([S(2027, 1, 1), S(2027, 2, 1)])) fails.push("Dec nextMonth");
  if (J(dateRange("lastMonth", S(2026, 1, 5))) !== J([S(2025, 12, 1), S(2026, 1, 1)])) fails.push("Jan lastMonth");
  // evaluation: half-open ranges, times inside the day count, non-dates never match; M10 / Q4 ignore the year
  const cells: Spec[] = [[String(T - 1), DATE], [String(T + 0.75), "yyyy-mm-dd hh:mm"], [String(T + 1), DATE], "text", "", [String(S(2019, 10, 3)), DATE], [String(S(2026, 3, 3)), DATE]];
  const dyn = (type: string): ColumnCrit => ({ kind: "dynamic", type } as ColumnCrit);
  const exp: Record<string, string> = { today: "FTFFFFF", yesterday: "TFFFFFF", tomorrow: "FFTFFFF", M10: "TTTFFTF", Q4: "TTTFFTF", Q1: "FFFFFFT", yearToDate: "TTFFFFT" };
  for (const [k, e] of Object.entries(exp)) { const g = vis(visible(cells, dyn(k), T)); if (g !== e) fails.push(`eval ${k}: want ${e} got ${g}`); }
  // recomputed range is written back as val/maxVal (what Excel stores)
  const wb = colBook(cells); setFilterCriteria(wb, "Sheet1", 0, dyn("thisMonth"), undefined, { today: T });
  const fc = filterCriteria(wb.sheet("Sheet1"), 0); if (fc?.kind !== "dynamic" || fc.val !== S(2026, 10, 1) || fc.maxVal !== S(2026, 11, 1)) fails.push(`write-back ${J(fc)}`);
  ok(!fails.length, fails.join("\n"));
  return `ECMA worked example + ${Object.keys(want2).length} relative ranges + 2 rollovers + ${Object.keys(exp).length} evaluations + val/maxVal write-back`;
});

/* ================================================================== R1 new-package round trip */
const KINDS: [string, ColumnCrit, string | null | undefined][] = [
  ["custom-and", custom("greaterThan", "2", "lessThan", "9", true), undefined],
  ["custom-wild", custom("equal", "b*"), undefined],
  ["top10", { kind: "top10", top: true, percent: false, val: 3 }, undefined],
  ["bottom-pct", { kind: "top10", top: false, percent: true, val: 40 }, undefined],
  ["above-avg", { kind: "dynamic", type: "aboveAverage" }, undefined],
  ["thisYear", { kind: "dynamic", type: "thisYear" }, undefined],
  ["M3", { kind: "dynamic", type: "M3" }, undefined],
  ["dates", { kind: "values", vals: ["7"], blank: false, dates: [{ year: 2026, month: 3, grouping: "month" }] } as unknown as ColumnCrit, undefined],
  ["cell-colour", { kind: "color", cell: true, dxfId: 0 }, "#FFC000"],
  ["font-colour", { kind: "color", cell: false, dxfId: 0 }, "#C00000"],
  ["no-fill", { kind: "color", cell: true, dxfId: 0 }, null],
];
const TODAY = dateToSerial(2026, 10, 25);
function richBook(): Workbook {
  const wb = new Workbook(); const sh = wb.sheet("Sheet1");
  sh.setCell(0, 0, "N"); sh.setCell(1, 0, "Name"); sh.setCell(2, 0, "When");
  const names = ["bob", "Bea", "al", "bo", "cy", "b", "Dee", "ben", "x"];
  const fills = ["#FFC000", undefined, "#FFC000", undefined, "#FFC000", undefined, undefined, "#FFC000", undefined];
  const fonts = [undefined, "#C00000", undefined, "#C00000", undefined, undefined, "#C00000", undefined, undefined];
  for (let i = 0; i < 9; i++) {
    sh.setCell(0, i + 1, String([1, 3, 5, 7, 9, 2, 4, 6, 8][i])); sh.setCell(1, i + 1, names[i]);
    sh.setCell(2, i + 1, String(dateToSerial(i % 2 ? 2025 : 2026, 1 + (i % 4), 1 + i))); sh.setStyle(2, i + 1, { numFmt: DATE });
    sh.setStyle(0, i + 1, { ...(fills[i] ? { fill: fills[i] } : {}), ...(fonts[i] ? { color: fonts[i] } : {}) });
  }
  wb.recalculate(); setAutoFilter(wb, "Sheet1", { c0: 0, r0: 0, c1: 2, r1: 9 }); return wb;
}
const colFor = (name: string) => (name === "custom-wild" ? 1 : ["thisYear", "M3", "dates"].includes(name) ? 2 : 0);

if (want("R1")) await test("R1 new package: every criterion kind → XSD-valid → openpyxl reads it + same hidden rows → reread re-evaluates identically", FILT, () => {
  const files: string[] = []; const ours: Record<string, { crit: ColumnCrit; hidden: number[]; sheet: string }> = {};
  for (const [name, crit, colour] of KINDS) {
    const wb = richBook(); const sheet = [...wb.sheets.keys()][0]; const col = colFor(name);
    setFilterCriteria(wb, sheet, col, crit, colour, { today: TODAY });
    const f = join(tmp, `r1-${name}.xlsx`); writeFileSync(f, writeXlsxWorkbook(wb, name)); files.push(f);
    ours[f] = { crit: filterCriteria(wb.sheet(sheet), col)!, hidden: hiddenIn(wb, sheet, 0, 9), sheet };
  }
  const v = xsd(files); const o = ox(files); const fails: string[] = []; const notes: string[] = [];
  for (const [name, , colour] of KINDS) {
    const f = join(tmp, `r1-${name}.xlsx`); const me = ours[f]; const col = colFor(name);
    const e = xsdErrors(v[f]); if (e.length) fails.push(`${name} XSD: ${e.join("; ")}`);
    const of = o[f]; if (!of || "error" in of) { fails.push(`${name} openpyxl: ${J(of)}`); continue; }
    const os = of.sheets[me.sheet]; const oc = os.autoFilter?.columns.find((c) => c.colId === col);
    if (!oc) { fails.push(`${name}: openpyxl sees no filterColumn ${col}`); continue; }
    if (J(os.hidden) !== J(me.hidden)) fails.push(`${name}: openpyxl hidden ${J(os.hidden)} vs Fusion ${J(me.hidden)}`);
    const c = me.crit;
    if (c.kind === "custom" && (!oc.custom || oc.custom.and !== c.and || J(oc.custom.rules) !== J(c.rules))) fails.push(`${name}: custom ${J(oc.custom)}`);
    if (c.kind === "top10" && (!oc.top10 || oc.top10.top !== c.top || oc.top10.percent !== c.percent || oc.top10.val !== c.val || oc.top10.filterVal !== c.filterVal)) fails.push(`${name}: top10 ${J(oc.top10)} vs ${J(c)}`);
    if (c.kind === "dynamic" && (!oc.dynamic || oc.dynamic.type !== c.type || (oc.dynamic.val ?? undefined) !== c.val || (oc.dynamic.maxVal ?? undefined) !== c.maxVal)) fails.push(`${name}: dynamic ${J(oc.dynamic)} vs ${J(c)}`);
    if (c.kind === "values" && (!oc.dates || oc.dates.length !== 1 || J(oc.values) !== J(c.vals))) fails.push(`${name}: values ${J(oc)}`);
    if (c.kind === "color") {
      if (!oc.color || oc.color.cell !== c.cell) fails.push(`${name}: colour ${J(oc.color)}`);
      else if ((oc.color.rgb ?? null) !== (colour ?? null)) fails.push(`${name}: dxf colour ${oc.color.rgb} want ${colour}`);
      else notes.push(`${name}→dxf ${oc.color.dxfId}`);
    }
    // reread with Fusion: same criterion, colour resolved again, and re-evaluation leaves the file's rows unchanged
    const back = readXlsxWorkbook(readFileSync(f)); const bs = back.sheet(me.sheet);
    const before = hiddenIn(back, me.sheet, 0, 9); applyAutoFilter(back, me.sheet, { today: TODAY });
    if (bs.autoFilter?.foreign) fails.push(`${name}: reread marked foreign`);
    if (J(hiddenIn(back, me.sheet, 0, 9)) !== J(before) || J(before) !== J(me.hidden)) fails.push(`${name}: reread hidden ${J(before)} → ${J(hiddenIn(back, me.sheet, 0, 9))}, saved ${J(me.hidden)}`);
    const bc = filterCriteria(bs, col); if (bc?.kind !== c.kind) fails.push(`${name}: reread criterion ${J(bc)}`);
    if (c.kind === "color" && (bs.autoFilter?.fx?.[col] ?? null) !== (colour ?? null)) fails.push(`${name}: reread colour ${J(bs.autoFilter?.fx)}`);
  }
  ok(!fails.length, fails.join("\n"));
  return `${KINDS.length} criterion kinds: XSD-valid, openpyxl agrees on criterion + hidden rows, Fusion reread identical (${notes.join(", ")})`;
});

/* ================================================================== R2 in-place patch of a foreign file */
if (want("R2")) await test("R2 in-place patch: change a ClosedXML file's filter to custom + colour → XSD → openpyxl → only the new dxf appended", FILT, async () => {
  const src = join(FILTERS, "cx_Examples_AutoFilter_RegularAutoFilter.xlsx"); const bytes = new Uint8Array(readFileSync(src));
  const wb = readXlsxWorkbook(Buffer.from(bytes)); const sheet = [...wb.sheets.keys()][3]; // "Multi Column": A1:C7, filter on B
  const sh = wb.sheet(sheet); const r = filterRange(sh)!; ok(r, "no autofilter");
  // the file also filters C = "C"; clear it so the new criteria are what decides (B = 5,4,3,3,2,1 in rows 2–7)
  setFilterCriteria(wb, sheet, 2, null);
  for (const r of [1, 3, 5]) sh.setStyle(0, r, { fill: "#92D050" });
  setFilterCriteria(wb, sheet, 1, custom("greaterThanOrEqual", "3"));
  setFilterCriteria(wb, sheet, 0, { kind: "color", cell: true, dxfId: 0 }, "#92D050");
  const exp = hiddenIn(wb, sheet, r.r0, r.r1);
  const out = (await patchXlsx(bytes, wb, {}, loadedBaseline(bytes))).bytes; const f = join(tmp, "r2.xlsx"); writeFileSync(f, out);
  const e = xsdErrors(xsd([f])[f]); ok(!e.length, `XSD: ${e.join("; ")}`);
  const of = ox([f])[f]; ok(of && !("error" in of), `openpyxl ${J(of)}`);
  const os = of.sheets[sheet]; const cA = os.autoFilter!.columns.find((c) => c.colId === 0); const cB = os.autoFilter!.columns.find((c) => c.colId === 1);
  ok(cA?.color?.rgb === "#92D050" && cA.color.cell, `colour column ${J(cA)}`);
  ok(cB?.custom?.rules[0].op === "greaterThanOrEqual" && cB.custom.rules[0].val === "3", `custom column ${J(cB)}`);
  ok(J(os.hidden) === J(exp), `openpyxl hidden ${J(os.hidden)} vs Fusion ${J(exp)}`);
  ok(J(exp) === J([2, 4, 5, 6]), `want rows 2,4,5,6 hidden (colour ∧ B≥3 keeps 1,3): ${J(exp)}`);
  // the other sheets' filters are untouched (byte-level: their worksheet parts are identical)
  const za = openZip(bytes), zb = openZip(out); const parts = za.entries.map((e) => e.name).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
  const changed: string[] = [];
  for (const p of parts) { const x = await za.read(p), y = await zb.read(p); if (!x || !y || Buffer.compare(Buffer.from(x), Buffer.from(y)) !== 0) changed.push(p); }
  ok(changed.length === 1, `worksheet parts changed: ${J(changed)}`);
  const back = readXlsxWorkbook(Buffer.from(out)); applyAutoFilter(back, sheet); ok(J(hiddenIn(back, sheet, r.r0, r.r1)) === J(exp), "reread re-evaluation differs");
  return `patched ${changed[0]}: colour (#92D050 via a new dxf) + custom ≥3 → hidden ${J(exp)}; openpyxl agrees; other ${parts.length - 1} sheets byte-identical`;
});

/* ================================================================== R3 JSON (the UI's document) */
if (want("R3")) await test("R3 workbook JSON keeps criteria + colours and re-evaluates identically; hostile fx dropped", FILT, () => {
  const wb = richBook(); const sheet = [...wb.sheets.keys()][0];
  setFilterCriteria(wb, sheet, 0, { kind: "color", cell: true, dxfId: 0 }, "#FFC000");
  setFilterCriteria(wb, sheet, 2, { kind: "dynamic", type: "thisYear" }, undefined, { today: TODAY });
  const exp = hiddenIn(wb, sheet, 0, 9);
  const j = JSON.parse(J(workbookToJson(wb))) as WorkbookJson; const back = workbookFromJson(j); back.recalculate();
  applyAutoFilter(back, sheet, { today: TODAY });
  ok(J(hiddenIn(back, sheet, 0, 9)) === J(exp), `JSON round trip ${J(hiddenIn(back, sheet, 0, 9))} vs ${J(exp)}`);
  // hostile colours in a crafted document are dropped (never reach styles / CSS)
  const evil = JSON.parse(J(j)) as { sheets: { autoFilter?: { fx?: Record<string, unknown> } }[] };
  const af = evil.sheets.find((s) => s.autoFilter)!.autoFilter!;
  af.fx = { 0: "red; background:url(javascript:1)", 1: "#12345", 2: "#ABCDEF", "-1": "#000000", x: "#000000", 99999999999: "#000000" };
  const w2 = workbookFromJson(evil as unknown as WorkbookJson); const fx = w2.sheet(sheet).autoFilter?.fx ?? {};
  ok(J(fx) === J({ 2: "#ABCDEF" }), `fx kept ${J(fx)}`);
  return `JSON keeps raw+fx (${exp.length} rows hidden both sides); crafted fx reduced to ${J(fx)}`;
});

/* ================================================================== R4 column insert/delete */
if (want("R4")) await test("R4 inserting / deleting a column shifts criteria AND colours; re-evaluation is unchanged", FILT, () => {
  const wb = richBook(); const sheet = [...wb.sheets.keys()][0];
  setFilterCriteria(wb, sheet, 0, { kind: "color", cell: false, dxfId: 0 }, "#C00000");
  setFilterCriteria(wb, sheet, 1, custom("equal", "b*"));
  const exp = hiddenIn(wb, sheet, 0, 9);
  insertDelete(wb, sheet, "col", 0, 1); // insert a column before A
  const s = wb.sheet(sheet); ok(s.autoFilter?.ref === "B1:D10", `ref ${s.autoFilter?.ref}`);
  ok(filterCriteria(s, 1)?.kind === "color" && s.autoFilter?.fx?.[0] === "#C00000", `colour moved? ${J(s.autoFilter)}`);
  ok(filterCriteria(s, 2)?.kind === "custom", "custom moved?");
  applyAutoFilter(wb, sheet); ok(J(hiddenIn(wb, sheet, 0, 9)) === J(exp), `after insert ${J(hiddenIn(wb, sheet, 0, 9))} vs ${J(exp)}`);
  // XML colIds rewritten on save
  const f = join(tmp, "r4.xlsx"); writeFileSync(f, writeXlsxWorkbook(wb, "r4"));
  const o = ox([f])[f]; ok(o && !("error" in o), J(o)); const cols = o.sheets[sheet].autoFilter!.columns.map((c) => [c.colId, c.color ? "color" : c.custom ? "custom" : "?"]);
  ok(J(cols) === J([[0, "color"], [1, "custom"]]), `colIds ${J(cols)}`);
  // deleting the colour column drops its criterion and colour
  insertDelete(wb, sheet, "col", 1, -1); const s2 = wb.sheet(sheet);
  ok(!s2.autoFilter?.fx || !(0 in s2.autoFilter.fx), `fx survived delete ${J(s2.autoFilter?.fx)}`);
  ok(filterCriteria(s2, 1)?.kind === "custom", `custom after delete ${J(s2.autoFilter)}`);
  return `shift on insert (ref ${s.autoFilter?.ref}), colIds rewritten ${J(cols)}, delete drops the column's colour`;
});

/* ================================================================== R5 table colour filters */
if (want("R5")) await test("R5 a TABLE's colour filter: new package re-creates its dxf (openpyxl resolves the colour); a dangling one is dropped from a new package and reported", FILT, async () => {
  const src = join(FILTERS, "cx_Examples_AutoFilter_RegularAutoFilter.xlsx"); const bytes = new Uint8Array(readFileSync(src));
  const wb = readXlsxWorkbook(Buffer.from(bytes)); const t = [...wb.tables.values()][0]; ok(t && t.filter, "no table filter");
  for (const r of [t.r0 + 1, t.r0 + 3]) wb.sheet(t.sheet).setStyle(t.c0, r, { fill: "#00B0F0" });
  t.filter = { cols: {}, raw: { 0: critXml({ kind: "color", cell: true, dxfId: 42 }, 0) }, fx: { 0: "#00B0F0" } };
  applyTableFilter(wb, t.name); const exp = hiddenIn(wb, t.sheet, t.r0, t.r1 - t.totalsRows);
  ok(!t.filter.foreign && exp.length === t.r1 - t.totalsRows - t.r0 - 2, `colour hides all but 2: ${J(exp)} ${J(t.filter)}`);
  const f1 = join(tmp, "r5a.xlsx"); writeFileSync(f1, writeXlsxWorkbook(wb, "r5"));
  // dangling: a colour criterion whose dxf never resolved (no fx)
  const wb2 = readXlsxWorkbook(Buffer.from(bytes)); const t2 = [...wb2.tables.values()][0];
  t2.filter = { cols: {}, raw: { 0: critXml({ kind: "color", cell: true, dxfId: 42 }, 0) } };
  applyTableFilter(wb2, t2.name); ok(t2.filter.foreign === true, "dangling colour must be unsupported");
  const report = { pivots: [], tables: [] as string[] }; const f2 = join(tmp, "r5b.xlsx"); writeFileSync(f2, writeXlsxWorkbook(wb2, "r5b", report));
  const v = xsd([f1, f2]); const e = [...xsdErrors(v[f1]), ...xsdErrors(v[f2])]; ok(!e.length, `XSD ${e.join("; ")}`);
  const o = ox([f1, f2]); const o1 = o[f1], o2 = o[f2]; ok(o1 && !("error" in o1) && o2 && !("error" in o2), J([o1, o2]));
  const tf = o1.sheets[t.sheet].tables[t.name]; const c0 = tf?.columns.find((c) => c.colId === 0);
  ok(c0?.color?.rgb === "#00B0F0" && c0.color.cell, `openpyxl table colour ${J(tf)}`);
  ok(J(o1.sheets[t.sheet].hidden.filter((r) => r > t.r0 && r <= t.r1)) === J(exp), `openpyxl hidden ${J(o1.sheets[t.sheet].hidden)} vs ${J(exp)}`);
  const tf2 = o2.sheets[t2.sheet].tables[t2.name]; ok(!tf2?.columns.some((c) => c.colId === 0 && c.color), `dangling colour written into a new package: ${J(tf2)}`);
  ok(report.tables.some((x) => x.includes(t2.name) && x.includes("cannot evaluate")), `save report silent: ${J(report.tables)}`);
  const back = readXlsxWorkbook(readFileSync(f1)); const bt = back.tables.get(t.name.toUpperCase())!; ok(bt.filter?.fx?.[0] === "#00B0F0", `reread fx ${J(bt.filter)}`);
  applyTableFilter(back, bt.name); ok(J(hiddenIn(back, bt.sheet, bt.r0, bt.r1 - bt.totalsRows)) === J(exp), "reread re-evaluation differs");
  return `table colour → new dxf (openpyxl #00B0F0, hidden ${J(exp)}); dangling colour dropped from the new package + reported`;
});

/* ================================================================== U1 the Condition dialog model */
if (want("U1")) await test("U1 Condition dialog model: Excel's wildcard encoding both ways, validation keeps OK disabled, reopen pre-fills, colour/icon options", FILT, () => {
  const fails: string[] = [];
  // every operator: dialog → stored rule → dialog is the identity for plain text, and the stored form is Excel's
  const want0: Record<string, [string, string]> = { eq: ["equal", "ab"], ne: ["notEqual", "ab"], gt: ["greaterThan", "ab"], ge: ["greaterThanOrEqual", "ab"], lt: ["lessThan", "ab"], le: ["lessThanOrEqual", "ab"], bw: ["equal", "ab*"], nbw: ["notEqual", "ab*"], ew: ["equal", "*ab"], new: ["notEqual", "*ab"], ct: ["equal", "*ab*"], nct: ["notEqual", "*ab*"] };
  for (const [op] of UI_OPS) {
    const r = uiRule(op, "ab"); if (J([r.op, r.val]) !== J(want0[op])) fails.push(`${op} stored ${J(r)}`);
    const back = ruleUi(r); if (back.op !== op || back.v !== "ab") fails.push(`${op} reopened as ${J(back)}`);
    // a value with its own wildcard round-trips SEMANTICALLY (same stored rule), even if shown as equals
    const r2 = uiRule(op, "a?b"); const b2 = ruleUi(r2); if (J(uiRule(b2.op, b2.v)) !== J(r2)) fails.push(`${op} a?b: ${J(r2)} → ${J(b2)} → ${J(uiRule(b2.op, b2.v))}`);
  }
  // ~* (escaped star) at the end is NOT "begins with"
  if (ruleUi({ op: "equal", val: "5~*" }).op !== "eq") fails.push("escaped trailing star read as begins-with");
  // validation: OK stays disabled (string) for every incomplete or out-of-range draft — the modal-shortcut guard
  const D = (p: Partial<CondDraft>) => ({ ...emptyDraft(), ...p });
  const bad: Partial<CondDraft>[] = [{}, { v1: "x", op2: "eq", v2: "" }, { mode: "top10", n: "0" }, { mode: "top10", n: "501" }, { mode: "top10", n: "abc" }, { mode: "top10", n: "10.5" }, { mode: "top10", n: "-3" }, { mode: "top10", n: "101", pct: true }, { mode: "color" }, { mode: "icon" }, { v1: "x".repeat(256) }, { mode: "date", date: "aboveAverage" as CondDraft["date"] }];
  bad.forEach((b, i) => { if (typeof draftToCrit(D(b), []) !== "string") fails.push(`bad draft ${i} ${J(b)} accepted`); });
  if (J(draftToCrit(emptyDraft(), [])) === J(draftToCrit(D({ v1: "x" }), []))) fails.push("empty draft == filled draft");
  // reopen: critToDraft(draftToCrit(d)) reproduces the draft for every mode
  const icons = iconOptions(["arrowUp:green", "arrowDown:red", undefined, "arrowUp:green"], ["3Arrows"]);
  const goods: Partial<CondDraft>[] = [{ v1: "ab", op1: "ct" }, { v1: "1", op1: "ge", op2: "le", v2: "9", and: true }, { v1: "a", op1: "bw", op2: "ew", v2: "z", and: false }, { mode: "top10", n: "3", top: false, pct: true }, { mode: "average", above: false }, { mode: "date", date: "M7" }, { mode: "color", color: "#FFC000", cell: false }, { mode: "color", color: null }, { mode: "icon", icon: 1 }, { mode: "icon", icon: -2 }];
  for (const g of goods) {
    const d = D(g); const c = draftToCrit(d, icons); if (typeof c === "string") { fails.push(`good ${J(g)}: ${c}`); continue; }
    const back = critToDraft(c, d.color, icons); const keys = Object.keys(g) as (keyof CondDraft)[];
    for (const k of keys) if (J(back[k]) !== J(d[k])) fails.push(`reopen ${J(g)}: ${k} ${J(back[k])}`);
    if (back.mode !== d.mode) fails.push(`reopen mode ${back.mode}`);
  }
  if (icons.length !== 2 || icons[0].set !== "3Arrows" || icons[0].id !== 2 || icons[1].id !== 0) fails.push(`icons ${J(icons)}`);
  // icon set preference: the sheet's own rule set wins over the first set that happens to contain the glyph
  const ic2 = iconOptions(["arrowUp:green"], ["5Arrows"]); if (ic2[0]?.set !== "5Arrows") fails.push(`prefer ${J(ic2)}`);
  // colour options: upper-cased, de-duplicated, first-seen order, "none" last, junk dropped, capped
  const co = colourOptions(["#ffc000", undefined, "#FFC000", "#00b0f0", "red", "url(x)"], [undefined, undefined]);
  if (J(co) !== J({ cell: ["#FFC000", "#00B0F0", null], font: [] })) fails.push(`colours ${J(co)}`);
  if (colourOptions(Array.from({ length: 40 }, (_, i) => `#0000${i.toString(16).padStart(2, "0")}`), []).cell.length !== 24) fails.push("cap");
  if (DATE_CHOICES.length !== 32 || DATE_CHOICES.includes("aboveAverage" as never)) fails.push(`date choices ${DATE_CHOICES.length}`);
  const ds = describeCrit({ kind: "custom", and: false, rules: [{ op: "equal", val: "a*" }, { op: "greaterThan", val: "5" }] });
  if (ds !== 'begins with "a" or is greater than "5"') fails.push(`describe ${ds}`);
  ok(!fails.length, fails.join("\n"));
  return `12 operators both ways + wildcard values, ${bad.length} incomplete drafts refused, ${goods.length} drafts reopen identically, colour/icon option rules`;
});

/* ================================================================== N negatives */
if (want("N")) await test("N1–N17 negative shapes: hostile criteria never hang, never hide wrongly, never corrupt the save", FILT, () => {
  const out: string[] = []; const fails: string[] = [];
  const t = (id: string, f: () => string | void) => { try { const r = f(); out.push(`${id} ${r ?? "ok"}`); } catch (e) { fails.push(`${id}: ${(e as Error).message}`); } };
  // N1 ReDoS: 40 stars against 32 767 'a's with no final 'b' — the matcher is regex-free
  t("N1", () => { const p = "*a".repeat(40) + "b"; const s = "a".repeat(32767); const t0 = performance.now(); const m = matchWildcard(p, s); const ms = performance.now() - t0; ok(!m && ms < 2000, `match=${m} ${ms.toFixed(0)}ms`); return `${ms.toFixed(0)} ms`; });
  // N2 regex metacharacters are literal
  t("N2", () => { ok(matchWildcard("(.*)[a]+$", "(.*)[A]+$") && !matchWildcard("a.c", "abc") && matchWildcard("a?c", "abc"), "metachar"); });
  // N3 escapes: ~* literal star, ~? literal ?, ~~ literal ~, trailing ~ literal
  t("N3", () => { ok(matchWildcard("5~*", "5*") && !matchWildcard("5~*", "55") && matchWildcard("~~", "~") && matchWildcard("a~", "a~") && !hasWildcard("5~*"), "escapes"); });
  // N4 astral characters: ? matches ONE character (a code point), not a UTF-16 half
  t("N4", () => { ok(matchWildcard("?", "😀") && !matchWildcard("??", "😀"), "astral"); });
  // N5 non-finite / out-of-range numbers in a hostile file are refused (column becomes unsupported → file state kept)
  t("N5", () => { for (const x of ['<top10 val="1e309"/>', '<top10 val="NaN"/>', '<top10 val="-3"/>', '<top10 val="0"/>', '<top10 percent="1" val="101"/>', '<top10 val="0x10"/>']) { const c = parseCrit(`<filterColumn colId="0">${x}</filterColumn>`); ok(c === null, `${x} accepted ${J(c)}`); } return "6 refused"; });
  // N6 a third customFilter / unknown operator / unknown dynamic type / iconId past the set
  t("N6", () => {
    const bad = ['<customFilters><customFilter val="1"/><customFilter val="2"/><customFilter val="3"/></customFilters>', '<customFilters><customFilter operator="like" val="1"/></customFilters>', '<dynamicFilter type="fortnight"/>', '<iconFilter iconSet="3Arrows" iconId="7"/>', '<iconFilter iconSet="NoSuchSet" iconId="0"/>'];
    for (const x of bad) { const s = sanitizeFilterColumnXml(`<filterColumn colId="0">${x}</filterColumn>`); const c = s ? parseCrit(s) : null; ok(c === null, `${x} → ${J(c)}`); }
    return `${bad.length} refused`;
  });
  // N7 unsupported criterion in a file → foreign, the file's hidden rows are NOT touched, saved verbatim
  t("N7", () => {
    const wb = colBook(["1", "2", "3"]); const s = wb.sheet("Sheet1");
    const af = readAutoFilterXml('<autoFilter ref="A1:A4"><filterColumn colId="0"><filters calendarType="hijri"><dateGroupItem year="1447" dateTimeGrouping="year"/></filters></filterColumn></autoFilter>');
    ok(af, "unparsed"); s.autoFilter = af; s.hiddenRows.set(2, "filter"); applyAutoFilter(wb, "Sheet1");
    ok(s.autoFilter?.foreign === true && J([...s.hiddenRows.keys()]) === J([2]), `state ${J(s.autoFilter)} ${J([...s.hiddenRows])}`);
    return "hijri calendar kept foreign, rows untouched";
  });
  // N8 a colour criterion with no resolvable colour (dangling dxfId) → unsupported, not "hide everything"
  t("N8", () => { const wb = colBook(["1", "2"]); const s = wb.sheet("Sheet1"); s.autoFilter = { ref: "A1:A3", cols: {}, raw: { 0: '<filterColumn colId="0"><colorFilter dxfId="99"/></filterColumn>' } }; applyAutoFilter(wb, "Sheet1"); ok(s.autoFilter.foreign && s.hiddenRows.size === 0, J(s.autoFilter)); });
  // N9 setFilterCriteria refuses a colour criterion without its colour, and a column outside the filter
  t("N9", () => { const wb = colBook(["1"]); let n = 0; try { setFilterCriteria(wb, "Sheet1", 0, { kind: "color", cell: true, dxfId: 0 }); } catch { n++; } try { setFilterCriteria(wb, "Sheet1", 5, custom("equal", "1")); } catch { n++; } ok(n === 2, `${n}/2 refused`); });
  // N10 criteria values with XML specials are escaped on write and survive a reread
  t("N10", () => { const x = critXml(custom("equal", `<a&"b'>`), 0); ok(!/<a&/.test(x) && parseCrit(x)?.kind === "custom" && (parseCrit(x) as { rules: { val: string }[] }).rules[0].val === `<a&"b'>`, x); });
  // N11 top N larger than the count shows every number (not an index error); percent 100 = all numbers
  t("N11", () => { ok(vis(visible(["1", "2", "x"], { kind: "top10", top: true, percent: false, val: 500 })) === "TTF", "N>count"); ok(vis(visible(["1", "2", "3"], { kind: "top10", top: false, percent: true, val: 100 })) === "TTT", "100%"); });
  // N12 1904 epoch: a 1904 workbook's M/Q/dateGroup evaluate in ITS epoch and the caller's epoch is restored
  t("N12", () => {
    const prev = isDate1904(); setDate1904(false);
    const wb = new Workbook(); wb.date1904 = true; const s = wb.sheet("Sheet1"); s.setCell(0, 0, "H");
    setDate1904(true); const mar = dateToSerial(2026, 3, 15); setDate1904(false); // the 1904 serial of 15 Mar 2026
    s.setCell(0, 1, String(mar)); s.setStyle(0, 1, { numFmt: DATE }); wb.recalculate(); setAutoFilter(wb, "Sheet1", { c0: 0, r0: 0, c1: 0, r1: 1 });
    setFilterCriteria(wb, "Sheet1", 0, { kind: "dynamic", type: "M3" });
    const shown = !s.hiddenRows.has(1); const after = isDate1904(); setDate1904(prev);
    ok(shown && after === false, `1904 M3 shown=${shown} epoch restored=${!after}`);
  });
  // N13 an empty filter range (header only) and a filter column with only blanks
  t("N13", () => { const wb = colBook([]); setFilterCriteria(wb, "Sheet1", 0, { kind: "dynamic", type: "aboveAverage" }); ok(wb.sheet("Sheet1").hiddenRows.size === 0, "header-only"); ok(vis(visible(["", ""], custom("greaterThan", "0"))) === "FF", "blanks"); });
  // N14 manual hides inside the range survive re-evaluation
  t("N14", () => { const wb = colBook(["1", "2", "3"]); const s = wb.sheet("Sheet1"); s.hiddenRows.set(1, "manual"); setFilterCriteria(wb, "Sheet1", 0, custom("greaterThan", "2")); ok(s.hiddenRows.get(1) === "manual" && s.hiddenRows.get(2) === "filter" && !s.hiddenRows.has(3), J([...s.hiddenRows])); });
  // N15 clearing a criterion (null) restores every row and removes raw + colour
  t("N15", () => { const wb = colBook(["1", "2"]); setFilterCriteria(wb, "Sheet1", 0, { kind: "color", cell: true, dxfId: 0 }, "#FF0000"); const s = wb.sheet("Sheet1"); const n0 = s.hiddenRows.size; ok(n0 === 2, "colour hid none?"); setFilterCriteria(wb, "Sheet1", 0, null); ok(s.hiddenRows.size as number === 0 && !s.autoFilter?.raw && !s.autoFilter?.fx, J(s.autoFilter)); });
  // N16 a value-list edit on a column replaces its criterion (no stale raw XML wins on save)
  t("N16", () => { const wb = colBook(["1", "2", "3"]); setFilterCriteria(wb, "Sheet1", 0, custom("greaterThan", "2")); setFilterColumn(wb, "Sheet1", 0, ["1"]); const s = wb.sheet("Sheet1"); ok(!s.autoFilter?.raw?.[0] && J([...s.hiddenRows.keys()].sort()) === J([2, 3]), J(s.autoFilter)); });
  // N17 formula cells evaluate by their VALUE (and errors from formulas compare as errors)
  t("N17", () => { ok(vis(visible(["=1+1", "=10/2", "=1/0"], custom("greaterThan", "3"))) === "FTF", "formula values"); ok(vis(visible(["=1/0", "=NA()"], custom("equal", "#DIV/0!"))) === "TF", "formula errors"); });
  // evaluateFilter itself is pure about the workbook's epoch even when it throws (sheet missing)
  t("N18", () => { const prev = isDate1904(); setDate1904(false); const wb = new Workbook(); wb.date1904 = true; let threw = false; try { evaluateFilter(wb, "Nope", { c0: 0, r0: 0, c1: 0, r1: 3 }, { 0: ["x"] }, undefined); } catch { threw = true; } const e = isDate1904(); setDate1904(prev); ok(threw && !e, `threw=${threw} epoch leaked=${e}`); });
  console.log("  " + out.join("\n  "));
  ok(!fails.length, fails.join("\n"));
  return `${out.length} negative shapes hold`;
});

finish();
