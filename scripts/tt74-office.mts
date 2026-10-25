/**
 * TT74 office class-A gates — FF-02 extract/convert, Spreadsheet hide / AutoFilter / SUBTOTAL, Excel function semantics.
 * Every corpus oracle is independent of the app: mammoth (docx → markdown), markdown-it-py (CommonMark/GFM), python-docx,
 * python-pptx, openpyxl (Excel's cached values, row/column dimensions, autoFilter), Excel's own cached formula values.
 *
 *  D1  docx → Markdown: every convertible corpus docx agrees with mammoth on 7 axes (blocks, inline format, headings,
 *      list items, tables, links, notes)
 *  M1  Markdown → docx: every corpus Markdown file's docx agrees with markdown-it-py on 7 axes and python-docx opens it
 *  M2  every Markdown → docx output is schema-valid (ECMA-376 transitional XSDs, 0 errors allowed)
 *  K1  pptx → outline: every corpus deck's outline agrees with python-pptx slide by slide (titles, paragraphs, levels,
 *      notes, hidden flags)
 *  X1  xlsx → CSV: every sheet's CSV equals openpyxl's view of Excel's cached values, except the allowlisted cells
 *      (each with evidence below) — and nothing outside the allowlist disagrees
 *  X2  CSV round trip: raw values survive CSV → Excel typing exactly (X2a); display text is a fixpoint after one Excel
 *      typing cycle except Excel's own 6-significant-digit General rendering (X2b)
 *  U1  CSV writer / reader units (quoting, CRLF, BOM, delimiter sniffing, Excel typing, formula-injection guard)
 *  U2  Excel function semantics fixed in TT74 (ROUND, A-family, XLOOKUP, CSE shaping, text-function truncation, dates,
 *      SUMPRODUCT errors)
 *  U3  SUBTOTAL / AGGREGATE over manual- and filter-hidden rows, hidden columns, nested subtotals, all-excluded results
 *  U4  hide / unhide / AutoFilter model (manual vs filter, case-insensitive criteria, blanks, foreign criteria)
 *  U5  new-package .xlsx round trip of hidden rows / columns and AutoFilter — re-read by us AND by openpyxl
 *  U6  in-place save (patch) of hidden rows / columns / AutoFilter on a corpus workbook — openpyxl sees them, the table
 *      filter rows of ConditionalFormattingSamples keep Excel's SUBTOTAL values, unhide removes the attribute
 *  U7  workbook JSON persistence of hidden state, AutoFilter and cached external links; hostile JSON is sanitised
 *  U8  insert / delete rows and columns shift hidden state and the AutoFilter (deleting the whole range removes it)
 *  U9  keyboard stepping skips hidden rows / columns; convert dispatcher refuses unsupported pairs; loss lists
 *  N1… negative shapes (hostile CSV / Markdown / XML / JSON / arguments)
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt74-office.mts
 *      TT74_ONLY="U1 U3" runs a subset.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook, type Scalar } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx, loadedBaseline } from "../src/lib/formula/xlsx-patch.ts";
import { workbookFromJson, workbookToJson, type WorkbookJson } from "../src/lib/formula/workbook-json.ts";
import { insertDelete } from "../src/lib/formula/sheetops.ts";
import { stepCell } from "../src/lib/formula/sheetlayout.ts";
import { hideRows, unhideRows, hideCols, unhideCols, setAutoFilter, filterValues, setFilterColumn, applyAutoFilter, autoFilterXml, readAutoFilterXml } from "../src/lib/formula/sheetfilter.ts";
import { sheetToCsv, csvToWorkbook, parseCsvText, detectDelimiter, typeField } from "../src/lib/formula/csv.ts";
import { convertBytes, CONVERSIONS } from "../src/lib/office/convert.ts";
import { markdownToDocx, uriTarget } from "../src/lib/office/md2docx.ts";
import { lossDetail } from "../src/lib/office/export-ask.ts";
import { openZip } from "../src/lib/office/zipkit.ts";
import { runDocxProbe } from "./tt74-docx-probe.mts";
import { runMdProbe, mdCorpus } from "./tt74-md-probe.mts";
import { runPptxProbe } from "./tt74-pptx-probe.mts";
import { runCsvProbe } from "./tt74-csv-probe.mts";

const { test, finish } = makeHarness("tt74-office");
const ONLY = process.env.TT74_ONLY;
const want = (id: string) => !ONLY || ONLY.split(/[ ,]+/).includes(id);
const PY = "/home/user/tools/venv/bin/python";
const XLSX = "/home/user/tools/corpus/xlsx";
const tmp = mkdtempSync(join(tmpdir(), "tt74o-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const CONV = { "FF-02": "full" } as const;
const SHEET = { "FF-19": "full", "FF-21": "full" } as const;
const BOTH = { "FF-02": "full", "FF-21": "full" } as const;
const J = (v: unknown) => JSON.stringify(v);
const at = (a1: string) => { const m = /^([A-Z]+)(\d+)$/.exec(a1)!; let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return { col: c - 1, row: Number(m[2]) - 1 }; };
const val = (wb: Workbook, sheet: string, a1: string) => { const p = at(a1); return wb.valueAt(sheet, p.col, p.row); };
const put = (wb: Workbook, sheet: string, a1: string, input: string) => { const p = at(a1); wb.sheet(sheet).setCell(p.col, p.row, input); };
const eq = (a: unknown, b: unknown) => J(a) === J(b);
const py = (code: string, ...args: string[]) => JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", code, ...args], { encoding: "utf8", maxBuffer: 64 << 20 }));
/** evaluate one formula in a scratch workbook seeded with `cells` (A1 → input) */
const calc = (formula: string, cells: Record<string, string> = {}): Scalar => {
  const wb = new Workbook(); for (const [k, v] of Object.entries(cells)) put(wb, "Sheet1", k, v);
  put(wb, "Sheet1", "Z99", formula); wb.recalculate(); return val(wb, "Sheet1", "Z99");
};
const E = (code: string) => ({ error: code });

/* ================================================================== FF-02 corpus gates */
if (want("D1")) await test("D1 docx → Markdown: every convertible corpus docx agrees with mammoth on all 7 axes", CONV, async () => {
  const r = await runDocxProbe();
  const compared = r.files.filter((f) => f.status === "match" || f.status === "diff");
  console.log(`    converted ${r.converted}, refused ${r.refused}, oracle errors ${r.oracleErrors}, compared ${compared.length}, all-axes ${r.agree.all}`);
  ok(compared.length >= 111, `only ${compared.length} compared`);
  const bad = compared.filter((f) => f.status !== "match");
  ok(!bad.length, `${bad.length} disagree: ${bad.slice(0, 3).map((f) => `${f.name}: ${(f.detail ?? "").slice(0, 200)}`).join(" | ")}`);
});
if (want("M1")) await test("M1 Markdown → docx: every corpus Markdown file agrees with markdown-it-py on all 7 axes and python-docx opens every output", CONV, async () => {
  const r = await runMdProbe();
  const bad = r.files.filter((f) => f.status === "diff" || f.status === "error");
  console.log(`    compared ${r.compared}, python-docx opened ${r.pythonDocxOpened}, ${J(r.agree)}`);
  ok(r.compared >= 386, `only ${r.compared} compared`);
  ok(!bad.length, `${bad.length} disagree: ${bad.slice(0, 3).map((f) => `${f.name}: ${(f.detail ?? "").slice(0, 200)}`).join(" | ")}`);
  ok(r.pythonDocxOpened === r.compared, `python-docx opened ${r.pythonDocxOpened}/${r.compared}`);
});
if (want("M2")) await test("M2 every Markdown → docx output of the corpus is ECMA-376 schema-valid (transitional XSDs via lxml; a new package has no inherited errors, so 0 are allowed)", CONV, async () => {
  const files: string[] = []; let i = 0;
  for (const p of mdCorpus()) { const t = readFileSync(p, "utf8"); if (!t.trim()) continue; const r = await markdownToDocx(t); const f = join(tmp, `m2-${i++}.docx`); writeFileSync(f, r.bytes); files.push(f); }
  const bad: string[] = [];
  for (let k = 0; k < files.length; k += 30) {
    const out = JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", ...files.slice(k, k + 30)], { encoding: "utf8", maxBuffer: 256 << 20 })) as Record<string, { parts: Record<string, string[]> }>;
    for (const [f, r] of Object.entries(out)) for (const [part, es] of Object.entries(r.parts)) for (const e of es) bad.push(`${f} ${part}: ${e}`);
  }
  console.log(`    ${files.length} outputs, ${bad.length} schema errors`);
  ok(files.length >= 386 && !bad.length, bad.slice(0, 4).join("\n"));
});
if (want("K1")) await test("K1 pptx → outline: every corpus deck agrees with python-pptx slide by slide", CONV, async () => {
  const r = await runPptxProbe();
  console.log(`    decks ${r.decksAgree}/${r.decks}, slides ${r.slidesAgree}/${r.slidesCompared}, alt-text excluded ${r.altExcluded}`);
  ok(r.decks >= 83 && r.decksAgree === r.decks, `${r.decks - r.decksAgree} decks disagree`);
  ok(r.slidesCompared >= 551 && r.slidesAgree === r.slidesCompared, `${r.slidesCompared - r.slidesAgree} slides disagree`);
});

/**
 * X1 allowlist — cells where Excel's cached value cannot be reproduced by any correct engine in this runtime, each with
 * the evidence. Key "file:sheet" (whole sheet) or "file:sheet!A1".
 */
const X1_ALLOW: Record<string, string> = {
  "56574.xlsx:Func": "TODAY()-based cells: Excel cached the day the file was saved (2014); today is a different serial",
  "56688_4.xlsx:Sheet1": "TODAY()/EDATE(TODAY()) — cached 2014 dates",
  "47804.xlsx:Sheet1": "Analysis ToolPak add-in functions (no add-in in this runtime; Excel without the add-in also shows #NAME?)",
  "52575_main.xlsx:Tabelle1": "user-defined add-in functions (VBA / XLL) — not present",
  "HsGetVal.xlsx:Sheet1": "Hyperion Essbase add-in HsGetVal — not present",
  "atp.xlsx:Sheet1": "Analysis ToolPak complex-number add-in (IMSQRT etc. via _xll.) — not present",
  "49783.xlsx:Sheet1": "add-in name — not present",
  "54436.xlsx:Sheet1": "add-in function — not present",
  "56502.xlsx:Tabelle1": "add-in function — not present (Excel's cached 'pls. update' is the add-in's own text)",
  "customIndexedColors.xlsx:_TGK_HIDDEN": "add-in name — not present",
  "57535.xlsx:Sheet1": "iterative calculation (circular references with iterations enabled) — not modelled; we report #CIRCULAR!",
  "bug67784.xlsx:Sheet1!A9": "circular reference — Excel cached #VALUE! from an iterative pass; we report #CIRCULAR!",
  "duplicate-filename.xlsx:v1": "the package has two parts with the same name; openpyxl reads the second, we the first (zip ambiguity)",
  "sample-beta.xlsx:Sheet1": "openpyxl reads this beta-format sheet as empty (oracle limitation; Excel shows the values we read)",
  "clone_sheet.xlsx:Arkusz1": "cached values were written by POI after cloning without recalculation (stale cache): M6 cached 0.2 for =L6-K6 with L6-K6 = -0.1",
  "link-external-workbook-b.xlsx:Sheet0": "the externalLink part has no sheetDataSet cache; Excel's 30 is the formula's stored value — recalculating without the source book is #REF! (Excel too)",
  "bug60858.xlsx:Arbeitszeitcheck_2.3": "cached values left blank by the producing tool (no <v>); we compute 0",
};
/** cells that are still OUR bugs (disclosed, counted, not hidden): POI FormulaEvalTestData EverythingTests edge cases */
const X1_OPEN_PREFIX = "FormulaEvalTestData_Copy.xlsx:EverythingTests!";
if (want("X1") || want("X2")) await test("X1/X2 xlsx → CSV vs openpyxl on Excel's cached values (allowlist with evidence) and the CSV round trip", BOTH, async () => {
  const r = await runCsvProbe();
  const dis = (r.x1.disagree ?? []) as [string, string, string, string, string][];
  const outside: string[] = []; const open: string[] = []; let allowed = 0;
  for (const [f, s, a, ours, xl] of dis) {
    if (X1_ALLOW[`${f}:${s}`] || X1_ALLOW[`${f}:${s}!${a}`]) { allowed++; continue; }
    if (`${f}:${s}!`.startsWith(X1_OPEN_PREFIX)) { open.push(`${a} ours=${ours} Excel=${xl}`); continue; }
    outside.push(`${f}:${s}!${a} ours=${J(ours)} Excel=${J(xl)}`);
  }
  console.log(`    X1 cells ${r.x1.cells}, agree ${r.x1.agree}, allowlisted ${allowed}, open (EverythingTests) ${open.length}, other ${outside.length}`);
  console.log(`    X2a ${r.x2.rawExact}/${r.x2.sheets}, X2b ${r.x2.displayIdempotent}/${r.x2.sheets}`);
  ok(r.x1.cells >= 446_000 && r.x1.agree >= 446_489, `agree ${r.x1.agree} of ${r.x1.cells}`);
  ok(!outside.length, `${outside.length} disagreements outside the allowlist: ${outside.slice(0, 8).join(" | ")}`);
  ok(open.length <= 14, `EverythingTests open cells grew to ${open.length}: ${open.join(" | ")}`);
  ok(r.x2.rawExact === r.x2.sheets, `X2a ${r.x2.rawExact}/${r.x2.sheets}: ${r.x2.bad.slice(0, 3).join(" | ")}`);
  const idemBad = r.x2.idemBad.filter((x: string) => !/6\.3\d+E\+11|4\.6\d+E\+12/.test(x));
  ok(r.x2.displayIdempotent >= r.x2.sheets - 3 && !idemBad.length, `X2b ${r.x2.displayIdempotent}/${r.x2.sheets}: ${idemBad.slice(0, 3).join(" | ")}`);
});

/* ================================================================== units */
if (want("U1")) await test("U1 CSV: quoting, CRLF, BOM, used range, displayed text, delimiter sniffing, Excel typing, formula guard", BOTH, () => {
  const wb = new Workbook();
  put(wb, "Sheet1", "B2", "a,b"); put(wb, "Sheet1", "C2", 'say "hi"'); put(wb, "Sheet1", "D2", "line1\nline2");
  put(wb, "Sheet1", "B3", "123.456"); wb.sheet("Sheet1").get(1, 2)!.style = { numFmt: "$#,##0.00" }; put(wb, "Sheet1", "C3", "=B3*2");
  wb.recalculate();
  const r = sheetToCsv(wb, "Sheet1");
  ok(r.range === "B2:D3", `used range ${r.range}`);
  ok(r.text === 'a,b,"say ""hi""","line1\nline2"\r\n$123.46,246.912,\r\n'.replace(/^a,b/, '"a,b"'), `csv ${J(r.text)}`);
  ok(sheetToCsv(wb, "Sheet1", { bom: true }).text.startsWith("\ufeff"), "BOM");
  ok(sheetToCsv(wb, "Sheet1", { values: "raw" }).text.includes("123.456"), "raw values");
  ok(eq(parseCsvText('a,"b,c","d""e"\r\n"x\ny",2', ","), [["a", "b,c", 'd"e'], ["x\ny", "2"]]), "parser");
  ok(detectDelimiter("a;b;c\n1;2;3\n") === ";" && detectDelimiter("a\tb\n1\t2") === "\t" && detectDelimiter("a,b\n1,2") === ",", "sniff");
  const k = (s: string) => typeField(s).kind;
  ok(k("12.5") === "number" && k("1,234") === "number" && k("50%") === "number" && k("$12") === "number" && k("(7)") === "number", "numbers");
  ok(k("TRUE") === "bool" && k("#N/A") === "error" && k("1/2/2024") === "date" && k("13:45") === "time" && k("abc") === "text" && k("") === "empty", "kinds");
  ok(k("=1+1") === "guarded" && k("@SUM(A1)") === "guarded" && k("+cmd") === "guarded", "formula-like fields stay text");
  const imp = csvToWorkbook("n,when,flag\r\n007,1/2/2024,TRUE\r\n=2+2,x,\r\n");
  ok(val(imp.wb, imp.sheet, "A2") === 7 && val(imp.wb, imp.sheet, "C2") === true, `typed ${J(val(imp.wb, imp.sheet, "A2"))}`);
  ok(val(imp.wb, imp.sheet, "B2") === 45293, `date serial ${J(val(imp.wb, imp.sheet, "B2"))}`);
  ok(val(imp.wb, imp.sheet, "A3") === "=2+2", `guarded ${J(val(imp.wb, imp.sheet, "A3"))}`);
  const txt = csvToWorkbook("007,1/2/2024\r\n", { types: "text" });
  ok(val(txt.wb, txt.sheet, "A1") === "007", "text mode keeps leading zeros");
});

if (want("U2")) await test("U2 Excel semantics: ROUND decimal, A-family text, XLOOKUP modes, CSE shaping, text truncation, negative dates, SUMPRODUCT errors", SHEET, () => {
  const bad: string[] = [];
  const chk = (f: string, want: unknown, cells: Record<string, string> = {}) => { const g = calc(f, cells); if (!eq(g, want)) bad.push(`${f} → ${J(g)} (Excel ${J(want)})`); };
  chk("=ROUND(2.675,2)", 2.68); chk("=ROUND(-1.005,2)", -1.01); chk("=ROUND(1234.5678,-2)", 1200); chk("=ROUND(0.285,2)", 0.29);
  chk('=AVERAGEA("x")', E("#VALUE!")); chk("=AVERAGEA(A1:A3)", 1, { A1: "1", A2: "x", A3: "2" }); chk("=AVERAGEA(TRUE,2)", 1.5);
  const t = { A1: "1", A2: "3", A3: "5", A4: "7", B1: "a", B2: "b", B3: "c", B4: "d" };
  chk("=XLOOKUP(5,A1:A4,B1:B4)", "c", t); chk("=XLOOKUP(4,A1:A4,B1:B4)", E("#N/A"), t); chk('=XLOOKUP(4,A1:A4,B1:B4,"none")', "none", t);
  chk("=XLOOKUP(4,A1:A4,B1:B4,,-1)", "b", t); chk("=XLOOKUP(4,A1:A4,B1:B4,,1)", "c", t); chk("=XLOOKUP(6,A1:A4,B1:B4,,1,2)", "d", t);
  chk('=XLOOKUP("c*",B1:B4,A1:A4,,2)', 5, t); chk("=XLOOKUP(1,A1:A4,B1:B3)", E("#VALUE!"), t);
  chk('=REPLACE("ABCDEFG",2.3,3.9,"xx")', "AxxEFG"); chk('=REPLACE("ABCDEF",-3,4,"xx")', E("#VALUE!"));
  chk('=SUBSTITUTE("teststr","t","T",1.9)', "Teststr"); chk('=SUBSTITUTE("teststr","t","T",0)', E("#VALUE!")); chk('=SUBSTITUTE("abc","","!")', "abc");
  chk('=RIGHT("ace","2.99999")', "ce"); chk('=LEFT("abc",-1)', E("#VALUE!")); chk('=MID("abc",0,1)', E("#VALUE!"));
  chk("=DATE(1,2,1.00001)", 398); chk("=DAY(-1.1)", E("#NUM!")); chk("=YEAR(-10)", E("#NUM!")); chk("=MONTH(-10)", E("#NUM!"));
  chk("=SUMPRODUCT(A1:A2,B1:B2)", E("#REF!"), { A1: "1", A2: "2", B1: "=#REF!", B2: "3" }); chk("=SUMPRODUCT(A1:A2,B1:B3)", E("#VALUE!"), { A1: "1" });
  // CSE: a legacy array formula fills exactly its range — scalars / single rows repeat, extra cells are #N/A
  const wb = new Workbook(); const s = wb.sheet("Sheet1");
  s.setCell(0, 0, "={1,2}"); s.get(0, 0)!.cse = { rows: 2, cols: 3 }; wb.recalculate(); // as the reader marks t="array" (not legacy)
  const g = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]].map(([c, r]) => wb.valueAt("Sheet1", c, r));
  if (!eq(g, [1, 2, E("#N/A"), 1, 2, E("#N/A")])) bad.push(`CSE {1,2} into A1:C2 → ${J(g)}`);
  ok(!bad.length, bad.join("\n"));
});

/** A1 header row; A2:A6 = 10..50, B = a b a c a; row 3 hidden by hand, row 5 by the filter (B ≠ c) */
const filterBook = () => {
  const wb = new Workbook(); const S = "Sheet1";
  put(wb, S, "A1", "n"); put(wb, S, "B1", "k");
  ["10", "20", "30", "40", "50"].forEach((v, i) => put(wb, S, `A${i + 2}`, v)); ["a", "b", "a", "c", "a"].forEach((v, i) => put(wb, S, `B${i + 2}`, v));
  wb.recalculate();
  hideRows(wb.sheet(S), 2, 2);
  setAutoFilter(wb, S, { c0: 0, r0: 0, c1: 1, r1: 5 }); setFilterColumn(wb, S, 1, ["a", "b"]);
  return wb;
};
if (want("U3")) await test("U3 SUBTOTAL/AGGREGATE: 1–11 skip filtered rows, 101–111 skip all hidden rows, AGGREGATE options, hidden columns never skipped, nested subtotals, all excluded", SHEET, () => {
  const wb = filterBook(); const S = "Sheet1"; const bad: string[] = [];
  const f: Record<string, unknown> = {
    "=SUBTOTAL(9,A2:A6)": 110, "=SUBTOTAL(109,A2:A6)": 90, "=SUBTOTAL(2,A2:A6)": 4, "=SUBTOTAL(102,A2:A6)": 3, "=SUBTOTAL(1,A2:A6)": 27.5, "=SUBTOTAL(104,A2:A6)": 50,
    "=AGGREGATE(9,5,A2:A6)": 90, "=AGGREGATE(9,4,A2:A6)": 150, "=AGGREGATE(9,6,A2:A6)": 150, "=AGGREGATE(9,7,A2:A6)": 90, "=AGGREGATE(14,5,A2:A6,2)": 30,
    "=SUM(A2:A6)": 150,
  };
  let r = 10;
  for (const k of Object.keys(f)) put(wb, S, `D${r++}`, k);
  put(wb, S, "F2", "5"); put(wb, S, "G2", "7"); hideCols(wb.sheet(S), 6, 6); put(wb, S, "D30", "=SUBTOTAL(109,F2:G2)");
  put(wb, S, "H10", "=SUBTOTAL(9,A2:A6)"); put(wb, S, "H11", "1"); put(wb, S, "D31", "=SUBTOTAL(9,H10:H11)");
  wb.recalculate();
  r = 10; for (const [k, w] of Object.entries(f)) { const g = val(wb, S, `D${r++}`); if (!eq(g, w)) bad.push(`${k} → ${J(g)} (want ${J(w)})`); }
  if (val(wb, S, "D30") !== 12) bad.push(`hidden column skipped: ${J(val(wb, S, "D30"))}`);
  if (val(wb, S, "D31") !== 1) bad.push(`nested SUBTOTAL counted: ${J(val(wb, S, "D31"))}`);
  // every data row hidden
  hideRows(wb.sheet(S), 1, 5); put(wb, S, "D40", "=SUBTOTAL(101,A2:A6)"); put(wb, S, "D41", "=SUBTOTAL(109,A2:A6)"); put(wb, S, "D42", "=SUBTOTAL(1,A2:A6)"); wb.recalculate();
  if (!eq(val(wb, S, "D40"), E("#DIV/0!")) || val(wb, S, "D41") !== 0 || val(wb, S, "D42") !== 30) bad.push(`all hidden: ${J([val(wb, S, "D40"), val(wb, S, "D41"), val(wb, S, "D42")])}`);
  ok(!bad.length, bad.join("\n"));
});

if (want("U4")) await test("U4 hide/AutoFilter model: unhide keeps filter rows, criteria case-insensitive, blanks, value list, foreign criteria not re-applied, off shows all", SHEET, () => {
  const wb = filterBook(); const S = "Sheet1"; const sh = wb.sheet(S);
  ok(sh.hiddenRows.get(2) === "manual" && sh.hiddenRows.get(4) === "filter" && sh.hiddenRows.size === 2, `hidden ${J([...sh.hiddenRows])}`);
  ok(unhideRows(sh, 0, 100) === 1 && sh.hiddenRows.get(4) === "filter", "Unhide must not show filtered rows");
  ok(eq(filterValues(wb, S, 1), [{ value: "a", count: 3 }, { value: "b", count: 1 }, { value: "c", count: 1 }]), J(filterValues(wb, S, 1)));
  put(wb, S, "B7", "A"); put(wb, S, "A7", "60"); setAutoFilter(wb, S, { c0: 0, r0: 0, c1: 1, r1: 7 }); wb.recalculate();
  ok(filterValues(wb, S, 1).find((v) => v.value === "a")?.count === 4, `case variants listed once: ${J(filterValues(wb, S, 1))}`);
  setFilterColumn(wb, S, 1, ["a"]);
  ok(!sh.hiddenRows.has(6) && sh.hiddenRows.get(2) === "filter" && sh.hiddenRows.get(4) === "filter", `"A" matches criterion "a": ${J([...sh.hiddenRows])}`);
  setFilterColumn(wb, S, 1, [""]); ok(sh.hiddenRows.get(1) === "filter" && sh.hiddenRows.has(7) === false, `blank criterion: ${J([...sh.hiddenRows])}`);
  setFilterColumn(wb, S, 1, null); ok(sh.hiddenRows.size === 0, "clearing the only criterion shows all");
  hideRows(sh, 3, 3); setFilterColumn(wb, S, 1, ["b"]); setAutoFilter(wb, S, null);
  ok(eq([...sh.hiddenRows], [[3, "manual"]]) && !sh.autoFilter, `filter off keeps manual hides only: ${J([...sh.hiddenRows])}`);
  const af = readAutoFilterXml('<autoFilter ref="A1:B6"><filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="3"/></customFilters></filterColumn></autoFilter>');
  ok(af?.foreign === true, "custom filter is foreign");
  sh.autoFilter = af; sh.hiddenRows.set(5, "filter"); ok(applyAutoFilter(wb, S) === 1 && sh.hiddenRows.get(5) === "filter", "foreign criteria keep the file's hidden rows");
  sh.autoFilter = { ref: "A1:B6", cols: { 1: ['x<&"y', ""] } };
  const x = autoFilterXml(sh); const back = readAutoFilterXml(x);
  ok(x.includes('blank="1"') && x.includes("x&lt;&amp;&quot;y") && eq(back?.cols[1]?.sort(), ['x<&"y', ""].sort()), `xml ${x} → ${J(back)}`);
});

if (want("U5")) await test("U5 new-package .xlsx keeps hidden rows / columns and the AutoFilter — re-read by us and by openpyxl", SHEET, () => {
  const wb = filterBook(); hideCols(wb.sheet("Sheet1"), 3, 4);
  const p = join(tmp, "u5.xlsx"); writeFileSync(p, writeXlsxWorkbook(wb));
  const back = readXlsxWorkbook(readFileSync(p)); const bs = back.sheet("Sheet1");
  // the file has one hidden flag per row: inside an AutoFilter with criteria every hidden row reads back as filtered
  ok(bs.hiddenRows.get(2) === "filter" && bs.hiddenRows.get(4) === "filter" && bs.hiddenRows.size === 2, `re-read rows ${J([...bs.hiddenRows])}`);
  ok(eq([...bs.hiddenCols].sort(), [3, 4]) && bs.autoFilter?.ref === "A1:B6" && eq(bs.autoFilter.cols[1]?.sort(), ["a", "b"]), `re-read ${J([...bs.hiddenCols])} ${J(bs.autoFilter)}`);
  const o = py(`import openpyxl,sys,json
ws=openpyxl.load_workbook(sys.argv[1]).active
af=ws.auto_filter
print(json.dumps({"rows":[r for r,d in ws.row_dimensions.items() if d.hidden],"cols":sorted(k for k,d in ws.column_dimensions.items() if d.hidden),"ref":af.ref,"vals":[sorted(fc.filters.filter) for fc in af.filterColumn]}))`, p);
  ok(eq(o.rows, [3, 5]) && o.ref === "A1:B6" && eq(o.vals, [["a", "b"]]), `openpyxl ${J(o)}`);
  ok(o.cols.length >= 1 && o.cols.every((c: string) => /^[DE]$/.test(c)), `openpyxl columns ${J(o.cols)}`);
});

if (want("U6")) await test("U6 in-place save keeps Excel's table-filter rows and SUBTOTALs, writes hide / unhide / AutoFilter so openpyxl sees them", SHEET, async () => {
  const src = new Uint8Array(readFileSync(join(XLSX, "ConditionalFormattingSamples.xlsx")));
  const ui = () => { const w = workbookFromJson(JSON.parse(J(workbookToJson(readXlsxWorkbook(Buffer.from(src)))))); w.recalculate(); return w; };
  const w0 = ui();
  const same = await patchXlsx(src, w0, {}, loadedBaseline(src));
  ok(Buffer.compare(Buffer.from(same.bytes), Buffer.from(src)) === 0, "no-edit save is not byte-identical");
  const w1 = ui(); const sh = w1.sheet("Regional sales2");
  ok(eq([...sh.hiddenRows].filter(([, w]) => w === "filter").map(([r]) => r).sort(), [3, 5, 7, 8, 9]), `table filter rows ${J([...sh.hiddenRows])}`);
  ok(w1.valueAt("Regional sales2", 1, 11) === 1469066 && w1.valueAt("Regional sales3", 1, 12) === 9071953, "SUBTOTALs differ from Excel's cache");
  // a save whose ONLY change is hidden rows must not be mistaken for a no-edit save
  const wr = ui(); hideRows(wr.sheet("Regional sales2"), 30, 30);
  const pr = await patchXlsx(src, wr, {}, loadedBaseline(src));
  ok(Buffer.compare(Buffer.from(pr.bytes), Buffer.from(src)) !== 0 && readXlsxWorkbook(Buffer.from(pr.bytes)).sheet("Regional sales2").hiddenRows.get(30) === "manual", "hide-only save returned the original bytes");
  hideRows(sh, 20, 21); hideCols(w1.sheet("Regional sales3"), 3, 3);
  const p1 = join(tmp, "u6a.xlsx"); writeFileSync(p1, (await patchXlsx(src, w1, {}, loadedBaseline(src))).bytes);
  const o1 = py(`import openpyxl,sys,json
wb=openpyxl.load_workbook(sys.argv[1])
a=wb["Regional sales2"]; b=wb["Regional sales3"]
print(json.dumps({"rows":sorted(r for r,d in a.row_dimensions.items() if d.hidden),"cols":sorted(k for k,d in b.column_dimensions.items() if d.hidden)}))`, p1);
  ok(eq(o1.rows, [4, 6, 8, 9, 10, 21, 22]) && o1.cols.includes("D"), `openpyxl after hide ${J(o1)}`);
  const w2 = workbookFromJson(JSON.parse(J(workbookToJson(readXlsxWorkbook(readFileSync(p1)))))); w2.recalculate();
  ok(w2.valueAt("Regional sales2", 1, 11) === 1469066, "SUBTOTAL changed after the save");
  unhideRows(w2.sheet("Regional sales2"), 0, 100); const base2 = loadedBaseline(new Uint8Array(readFileSync(p1)));
  const S2 = [...w2.sheets.keys()].find((n) => !/Regional/.test(n))!;
  put(w2, S2, "AA1", "h"); put(w2, S2, "AA2", "x"); put(w2, S2, "AA3", "y"); w2.recalculate();
  setAutoFilter(w2, S2, { c0: 26, r0: 0, c1: 26, r1: 2 }); setFilterColumn(w2, S2, 26, ["x"]);
  const p2 = join(tmp, "u6b.xlsx"); writeFileSync(p2, (await patchXlsx(new Uint8Array(readFileSync(p1)), w2, {}, base2)).bytes);
  const o2 = py(`import openpyxl,sys,json
wb=openpyxl.load_workbook(sys.argv[1])
a=wb["Regional sales2"]; s=wb[sys.argv[2]]
print(json.dumps({"rows":sorted(r for r,d in a.row_dimensions.items() if d.hidden),"ref":s.auto_filter.ref,"vals":[list(fc.filters.filter) for fc in s.auto_filter.filterColumn],"srows":sorted(r for r,d in s.row_dimensions.items() if d.hidden)}))`, p2, S2);
  ok(eq(o2.rows, [4, 6, 8, 9, 10]), `unhide kept filter rows only: ${J(o2.rows)}`);
  ok(o2.ref === "AA1:AA3" && eq(o2.vals, [["x"]]) && o2.srows.includes(3), `AutoFilter written: ${J(o2)}`);
});

if (want("U7")) await test("U7 JSON persistence: hidden rows (manual/filter), hidden columns, AutoFilter, cached external links; hostile JSON sanitised", SHEET, () => {
  const wb = filterBook(); hideCols(wb.sheet("Sheet1"), 2, 2);
  const back = workbookFromJson(JSON.parse(J(workbookToJson(wb)))); const s = back.sheet("Sheet1");
  ok(eq([...s.hiddenRows].sort(), [[2, "manual"], [4, "filter"]]) && eq([...s.hiddenCols], [2]) && s.autoFilter?.ref === "A1:B6", `round trip ${J([...s.hiddenRows])} ${J(s.autoFilter)}`);
  const ext = readXlsxWorkbook(readFileSync(join(XLSX, "ref2-56737.xlsx")));
  const ej = workbookFromJson(JSON.parse(J(workbookToJson(ext)))); ej.recalculate();
  ok(ej.externals.length === ext.externals.length && ej.valueAt("Refs", 4, 2) === "Hello!" && ej.valueAt("Refs", 8, 2) === 142, `externals after JSON: ${J([ej.valueAt("Refs", 4, 2), ej.valueAt("Refs", 8, 2)])}`);
  const hostile = { sheets: [{ name: "S", cells: [], hiddenRows: { manual: [-1, 1.5, "7", 3, 1e12, null], filter: [4, 4] }, hiddenCols: [-2, 99999, 5, "x"], autoFilter: { ref: "javascript:1", cols: { "__proto__": ["x"] } } }],
    externals: [{ target: "a.xlsx", sheetNames: ["S"], sheets: [["S", [["0,0", { error: "#BOGUS" }], ["bad", 1], ["1,1", 2]]]], names: [["__proto__", "x"]] }, "junk", null] } as unknown as WorkbookJson;
  const h = workbookFromJson(hostile); const hs = h.sheet("S");
  ok(eq([...hs.hiddenRows].sort(), [[3, "manual"], [4, "filter"]]), `rows ${J([...hs.hiddenRows])}`);
  ok(eq([...hs.hiddenCols], [5]) && hs.autoFilter === null || hs.autoFilter === undefined, `cols/filter ${J([...hs.hiddenCols])} ${J(hs.autoFilter)}`);
  ok(h.externals.length === 1 && !h.externals[0].sheets.get("S")?.has("bad") && h.externals[0].sheets.get("S")?.get("1,1") === 2, `externals ${J(h.externals.map((b) => [...b.sheets]))}`);
  ok(!(Object.prototype as Record<string, unknown>).x, "prototype polluted");
});

if (want("U8")) await test("U8 insert/delete rows and columns shift hidden state and the AutoFilter; deleting the whole range removes it", SHEET, () => {
  const wb = filterBook(); const S = "Sheet1"; const s = wb.sheet(S); hideCols(s, 3, 3);
  insertDelete(wb, S, "row", 0, 2);
  ok(eq([...s.hiddenRows].sort(), [[4, "manual"], [6, "filter"]]) && s.autoFilter?.ref === "A3:B8", `insert rows ${J([...s.hiddenRows])} ${s.autoFilter?.ref}`);
  insertDelete(wb, S, "col", 0, 1);
  ok(eq([...s.hiddenCols], [4]) && s.autoFilter?.ref === "B3:C8" && eq(s.autoFilter.cols[1]?.sort(), ["a", "b"]), `insert col ${J([...s.hiddenCols])} ${J(s.autoFilter)}`);
  insertDelete(wb, S, "row", 4, -1);
  ok(eq([...s.hiddenRows].sort(), [[5, "filter"]]) && s.autoFilter?.ref === "B3:C7", `delete row ${J([...s.hiddenRows])} ${s.autoFilter?.ref}`);
  insertDelete(wb, S, "row", 0, -20);
  ok(!s.autoFilter && s.hiddenRows.size === 0, `delete all ${J(s.autoFilter)} ${J([...s.hiddenRows])}`);
});

if (want("U9")) await test("U9 keyboard stepping skips hidden rows/columns; convert refuses unsupported pairs; loss lists are surfaced", BOTH, async () => {
  const wb = new Workbook(); const s = wb.sheet("Sheet1"); hideRows(s, 2, 4); hideCols(s, 1, 1);
  ok(eq(stepCell(s, { col: 0, row: 1 }, 0, 1, 50, 99), { col: 0, row: 5 }), "down over hidden rows");
  ok(eq(stepCell(s, { col: 0, row: 5 }, 0, -1, 50, 99), { col: 0, row: 1 }), "up over hidden rows");
  ok(eq(stepCell(s, { col: 0, row: 0 }, 1, 0, 50, 99), { col: 2, row: 0 }), "right over a hidden column");
  hideRows(s, 0, 0); ok(eq(stepCell(s, { col: 0, row: 1 }, 0, -1, 50, 99), { col: 0, row: 1 }), "only hidden rows ahead: stays");
  let refused = "";
  try { await convertBytes(new TextEncoder().encode("x"), "a.md", "csv"); } catch (e) { refused = String(e); }
  ok(/no conversion from|not supported|unsupported/i.test(refused), `md → csv must be refused: ${refused}`);
  ok(CONVERSIONS.docx.includes("md") && CONVERSIONS.md.includes("docx") && CONVERSIONS.xlsx.includes("csv") && CONVERSIONS.csv.includes("xlsx"), J(CONVERSIONS));
  const md = await markdownToDocx("# T\n\n<b>raw</b>\n\n![i](http://x/y.png)\n");
  const r = await convertBytes(md.bytes, "t.docx", "md");
  ok(typeof r.text === "string" && r.text.includes("# T") && Array.isArray(r.loss), `docx → md ${J(r).slice(0, 300)}`);
  ok(md.loss.length >= 1 && lossDetail(md.loss).startsWith("This conversion drops:"), `md loss ${J(md.loss)}`);
  const c = await convertBytes(new TextEncoder().encode("a,b\r\n1,2\r\n"), "t.csv", "xlsx");
  ok(c.bytes && readXlsxWorkbook(Buffer.from(c.bytes)).valueAt([...readXlsxWorkbook(Buffer.from(c.bytes)).sheets.keys()][0], 1, 1) === 2, "csv → xlsx");
});

/* ================================================================== negative shapes */
const neg = (id: string, name: string, cov: Record<string, string>, fn: () => void | Promise<void>) => { if (want("N") || want(id)) return test(`${id} ${name}`, cov, fn); };
await neg("N1", "CSV formula injection (= + - @ tab-prefixed) is imported as text, never a formula", BOTH, () => {
  const r = csvToWorkbook('"=HYPERLINK(""http://evil"",""x"")",+1+1,-2+3,@SUM(A1),"\t=1"\r\n');
  const s = r.wb.sheet(r.sheet); ok([0, 1, 2, 3].every((c) => !s.get(c, 0)?.formula), "a field became a formula");
  ok(val(r.wb, r.sheet, "A1") === '=HYPERLINK("http://evil","x")', J(val(r.wb, r.sheet, "A1")));
  ok(r.counts.guarded === 5 && r.loss.some((l) => /formula-injection/.test(l)), `guard ${J(r.counts)} ${J(r.loss)}`);
});
await neg("N2", "unterminated quote does not hang or throw and keeps the rest of the text", BOTH, () => {
  const t0 = Date.now(); const rows = parseCsvText('a,"b\r\nc,d\r\n' + "x,".repeat(20000), ","); ok(Date.now() - t0 < 2000 && rows.length >= 1 && rows[0][1].startsWith("b"), "unterminated quote");
});
await neg("N3", "CSV cell cap: a huge CSV is refused/truncated with a loss note instead of exhausting memory", BOTH, () => {
  const big = ("1,".repeat(999) + "1\r\n").repeat(400); const r = csvToWorkbook(big, { maxCells: 100_000 });
  ok(r.wb.sheet(r.sheet).grid.size <= 100_000 && r.rows <= 101 && r.loss.some((l) => /not imported/i.test(l)), `cells ${r.rows}×${r.cols} loss ${J(r.loss)}`);
});
await neg("N4", "NUL / lone surrogate / BOM-in-the-middle bytes survive CSV import as text", BOTH, () => {
  const r = csvToWorkbook("\ufeffa\u0000b,\ud800x,c\ufeffd\r\n"); ok(typeof val(r.wb, r.sheet, "A1") === "string" && String(val(r.wb, r.sheet, "C1")).includes("d"), J([val(r.wb, r.sheet, "A1"), val(r.wb, r.sheet, "C1")]));
});
await neg("N5", "mixed / bare-CR line endings parse as rows", BOTH, () => { ok(eq(parseCsvText("a\rb\nc\r\nd", ","), [["a"], ["b"], ["c"], ["d"]]), J(parseCsvText("a\rb\nc\r\nd", ","))); });
await neg("N6", "Markdown javascript:/data: links are not written as hyperlinks", CONV, async () => {
  const r = await markdownToDocx("[x](javascript:alert(1)) [y](data:text/html,1) [w](vbscript:x) [z](https://ok.example/)");
  const z = openZip(r.bytes); let all = ""; for (const e of z.entries) all += new TextDecoder().decode(await z.read(e.name) ?? new Uint8Array());
  ok(!/javascript:|data:text|vbscript:/i.test(all.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, "")) && all.includes("https://ok.example/"), "unsafe target written to the package");
  ok(r.loss.some((l) => /unsafe/i.test(l)), `loss ${J(r.loss)}`);
});
await neg("N7", "raw HTML in Markdown is not executed or embedded; it is counted as a loss", CONV, async () => {
  const r = await markdownToDocx("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n"); ok(r.loss.some((l) => /html/i.test(l)), J(r.loss));
});
await neg("N8", "deeply nested Markdown lists / quotes do not overflow the stack", CONV, async () => {
  const deep = ">".repeat(3000) + " x\n\n" + Array.from({ length: 400 }, (_, i) => " ".repeat(i * 2) + "- y").join("\n");
  const r = await markdownToDocx(deep); ok(r.bytes.length > 0, "no output");
});
await neg("N9", "convert refuses a non-zip .docx and an empty .xlsx with an error (no crash, no partial output)", CONV, async () => {
  for (const [n, to] of [["a.docx", "md"], ["b.xlsx", "csv"], ["c.pptx", "md"]] as const) {
    let e = ""; try { await convertBytes(new TextEncoder().encode("PK not really"), n, to); } catch (x) { e = String(x); } ok(e, `${n} accepted`);
  }
});
await neg("N10", "AutoFilter XML with a bogus ref / non-integer colId / entity tricks is rejected or neutralised", SHEET, () => {
  ok(readAutoFilterXml('<autoFilter ref="ZZZZZ99999999"/>') === null, "bogus ref accepted");
  const a = readAutoFilterXml('<autoFilter ref="A1:B2"><filterColumn colId="x"><filters><filter val="a"/></filters></filterColumn><filterColumn colId="1"><filters><filter val="&#60;b&#x3e;"/></filters></filterColumn></autoFilter>');
  ok(a && !("NaN" in a.cols) && eq(a.cols[1], ["<b>"]), J(a));
});
await neg("N11", "hostile workbook JSON (prototype keys, 1e12 row numbers, wrong types) cannot pollute or blow up", SHEET, () => {
  const t0 = Date.now();
  const h = workbookFromJson({ sheets: [{ name: "S", cells: [], hiddenRows: { manual: Array.from({ length: 300_000 }, (_, i) => i) } }] } as unknown as WorkbookJson);
  ok(h.sheet("S").hiddenRows.size <= 200_000 && Date.now() - t0 < 5000, `size ${h.sheet("S").hiddenRows.size}`);
  workbookFromJson(JSON.parse('{"sheets":[{"name":"S","cells":[],"autoFilter":{"ref":"A1:B2","cols":{"__proto__":{"polluted":1}}}}]}'));
  ok(!({} as Record<string, unknown>).polluted, "prototype polluted");
});
await neg("N12", "SUBTOTAL with a bad function number / non-ref argument is an error, not a crash", SHEET, () => {
  ok(eq(calc("=SUBTOTAL(12,A1:A2)"), E("#VALUE!")) && eq(calc("=SUBTOTAL(0,A1)"), E("#VALUE!")), J([calc("=SUBTOTAL(12,A1:A2)"), calc("=SUBTOTAL(0,A1)")]));
  ok(eq(calc("=AGGREGATE(19,0,A1:A2)"), E("#VALUE!")), J(calc("=AGGREGATE(19,0,A1:A2)")));
});
await neg("N13", "setFilterColumn outside the filter range throws; hiding beyond the sheet is clamped", SHEET, () => {
  const wb = filterBook(); let e = ""; try { setFilterColumn(wb, "Sheet1", 9, ["a"]); } catch (x) { e = String(x); } ok(e, "accepted a column outside the filter");
  const s = new Workbook().sheet("Sheet1"); ok(hideRows(s, -5, 1) === 2 && hideCols(s, 16380, 20000) === 4, "clamping");
  ok(unhideCols(s, 0, 1e9) === 4, "unhide cols");
});
await neg("N14", "CSV export of text that looks like a number / formula / has leading zeros is quoted or reported as a loss", BOTH, () => {
  const wb = new Workbook(); put(wb, "Sheet1", "A1", "'007"); put(wb, "Sheet1", "B1", "'=1+1"); wb.recalculate();
  const r = sheetToCsv(wb, "Sheet1"); ok(r.loss.some((l) => /re-?typ|number|leading/i.test(l)), `loss ${J(r.loss)} text ${J(r.text)}`);
});
await neg("N15", "pathological numbers: ROUND of 1e308 / NaN-producing input / negative digits beyond range stay finite or #NUM!", SHEET, () => {
  const a = calc("=ROUND(1E+308,2)"), b = calc("=ROUND(1.5,-400)"), c = calc("=ROUND(123.456,400)");
  ok(a === 1e308 && b === 0 && c === 123.456, J([a, b, c]));
});
await neg("N16", "XLOOKUP with mismatched shapes / bad modes is #VALUE!", SHEET, () => {
  ok(eq(calc("=XLOOKUP(1,A1:B2,A1:A2)"), E("#VALUE!")) && eq(calc("=XLOOKUP(1,A1:A2,B1:B2,,5)"), E("#VALUE!")) && eq(calc("=XLOOKUP(1,A1:A2,B1:B2,,0,3)"), E("#VALUE!")), J([calc("=XLOOKUP(1,A1:B2,A1:A2)"), calc("=XLOOKUP(1,A1:A2,B1:B2,,5)"), calc("=XLOOKUP(1,A1:A2,B1:B2,,0,3)")]));
});
await neg("N17", "AutoFilter XML written with single quotes, spaces around = and a namespace prefix reads the same (found by tt72-office S1)", SHEET, () => {
  const a = readAutoFilterXml(`<x:autoFilter ref = 'A1:B6'><x:filterColumn colId='1'><x:filters blank = "1"><x:filter val='a&amp;b'/></x:filters></x:filterColumn></x:autoFilter>`);
  ok(a?.ref === "A1:B6" && eq(a.cols[1], ["a&b", ""]), J(a));
});
await neg("N18", "hyperlink relationship targets: characters a URI forbids are percent-encoded, existing %XX kept, a stray % escaped, a colon in the first relative segment gets ./ (found by M2)", CONV, () => {
  const got = [uriTarget("a b✓.md"), uriTarget("https://x.test/%41?q=1#f"), uriTarget("100%"), uriTarget("(https://x.test)"), uriTarget("mailto:a@b.c"), uriTarget("😀")];
  ok(eq(got, ["a%20b%E2%9C%93.md", "https://x.test/%41?q=1#f", "100%25", "./(https://x.test)", "mailto:a@b.c", "%F0%9F%98%80"]), J(got));
});

finish();
