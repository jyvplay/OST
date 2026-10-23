/**
 * TT68 — FF-52: empty cells vs empty text, error constants and *IF criteria, as Excel defines them.
 *
 * Ground truth (none of it produced by our code):
 *  - Microsoft's function reference (IS functions, COUNTA, COUNTBLANK) for the blank / "" table — values recorded in
 *    docs/DESIGN-TT68.md with the page each comes from;
 *  - the CACHED results Excel wrote into the 353-workbook Apache POI corpus (openpyxl, scripts/oracle/xlsx_cached.py);
 *  - lxml with real namespace resolution (scripts/oracle/xlsx_values_lxml.py --empty-text) for which cells of a file
 *    are constant empty-text cells; openpyxl for what our writer / patcher produce.
 * "Before" = the TT67 tree (git 8646947, extracted with git archive) run on the same inputs.
 * TT68_FAST=1 skips the 3-minute held-out corpus test (used by the mutant runner).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt68-blank.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { Workbook, textInput } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { readCentralDirectory, readEntryVerified, writeZip } from "../src/lib/server/zip.ts";

const { test, finish } = makeHarness("tt68-blank");
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/xlsx";
const dir = "/tmp/tt68blank"; mkdirSync(dir, { recursive: true });
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const J = (v: unknown) => JSON.stringify(v);

const BEFORE = "/tmp/tt68-before";
if (!existsSync(`${BEFORE}/src/lib/formula/xlsx.ts`)) { mkdirSync(BEFORE, { recursive: true }); execFileSync("bash", ["-c", `git archive 8646947 src/lib | tar -x -C ${BEFORE}`]); }
const B = (await import(`${BEFORE}/src/lib/formula/engine.ts`)) as { Workbook: typeof Workbook };
const BX = (await import(`${BEFORE}/src/lib/formula/xlsx.ts`)) as { readXlsxWorkbook: typeof readXlsxWorkbook };

type Case = [formula: string, expected: unknown];
/** evaluate formulas in column C against a column-A setup with a given Workbook class */
function evalCases(W: typeof Workbook, setup: string[], cases: Case[], colB: string[] = []) {
  const wb = new W(); const s = wb.sheet();
  setup.forEach((v, i) => { if (v !== "") s.setCell(0, i, v); });
  colB.forEach((v, i) => { if (v !== "") s.setCell(1, i, v); });
  cases.forEach(([f], i) => s.setCell(2, i, f));
  wb.recalculate();
  return cases.map(([f, e], i) => {
    const v = s.get(2, i)?.value;
    const good = J(v) === J(e) || (typeof v === "number" && typeof e === "number" && Math.abs(v - e) < 1e-9);
    return { f, e, v, good };
  });
}
const report = (rows: { f: string; e: unknown; v: unknown; good: boolean }[]) => rows.filter((r) => !r.good).map((r) => `${r.f}: got ${J(r.v)}, Excel ${J(r.e)}`);

/* ---------------------------------------------------------------- 1. the Microsoft-documented blank / "" table */
// A1 ="" (formula returning empty text) · A2 empty · A3 1 · A4 ' (constant empty text)
const SETUP1 = ['=""', "", "1", "'"];
const MS_TABLE: Case[] = [
  ["=COUNTA(A1:A4)", 3], ["=ISBLANK(A1)", false], ["=ISBLANK(A2)", true], ["=ISBLANK(A4)", false], ["=COUNTBLANK(A1:A4)", 3],
  ["=COUNTA(A1)", 1], ["=COUNTA(A2)", 0], ["=A2+0", 0], ["=LEN(A1)", 0], ['=COUNTIF(A1:A4,"")', 3], ['=COUNTIF(A1:A4,"<>")', 3],
  ['=SUMPRODUCT(--(A1:A4<>""))', 1], ["=ISTEXT(A1)", true], ["=ISTEXT(A4)", true], ["=ISTEXT(A2)", false], ["=ISNONTEXT(A2)", true],
  ["=ISNONTEXT(A1)", false], ["=TYPE(A1)", 2], ["=TYPE(A2)", 1], ['=ISBLANK("")', false], ['=COUNTA({"",1})', 2], ['=COUNTA("")', 1],
  ["=ISBLANK(OFFSET(A1,1,0))", true], ["=ISBLANK(INDEX(A1:A4,1))", false], ["=COUNTA(OFFSET(A1,0,0,4,1))", 3], ["=ISBLANK(A5)", true], ["=COUNTA(A:A)", 3],
];
await test("blank vs empty text follows Microsoft's definitions (27 cases): ISBLANK only for empty cells, COUNTA counts \"\", ISTEXT/ISNONTEXT/TYPE of an empty cell, through OFFSET/INDEX/whole columns/array constants", { "FF-52": "full", "FF-19": "partial" }, () => {
  const now = report(evalCases(Workbook, SETUP1, MS_TABLE));
  const before = report(evalCases(B.Workbook, SETUP1, MS_TABLE));
  ok(now.length === 0, `wrong: ${now.join(" | ")}`);
  ok(before.length >= 5, `before evidence: TT67 should get ≥5 wrong, got ${before.length}`);
  console.log(`    TT67 got ${before.length} wrong: ${before.join(" | ")}`);
});

/* ---------------------------------------------------------------- 2. *IF criteria */
// A: 1 | =1/0 | (empty) | ="" | apple | '5 (text) | TRUE | a*b | -3 ;  C: 10..90
const SETUP2 = ["1", "=1/0", "", '=""', "apple", "'5", "TRUE", "a*b", "-3"];
const COLB2: string[] = [];
const CRIT: Case[] = [
  ['=COUNTIF(A1:A9,"#DIV/0!")', 1], ["=COUNTIF(A1:A9,1/0)", 1], ['=COUNTIF(A1:A9,"<>#DIV/0!")', 8], ['=COUNTIF(A1:A9,"x")', 0],
  ['=COUNTIF(A1:A9,"*")', 4], ['=COUNTIF(A1:A9,"<>*")', 5], ['=COUNTIF(A1:A9,"=")', 1], ['=COUNTIF(A1:A9,"")', 2], ['=COUNTIF(A1:A9,"<>")', 8],
  ['=COUNTIF(A1:A9,"a~*b")', 1], ['=COUNTIF(A1:A9,"a*")', 2], ['=COUNTIF(A1:A9,"<>5")', 8], ['=COUNTIF(A1:A9,">0")', 2], ['=COUNTIF(A1:A9,"<>apple")', 8],
  ['=SUMIF(A1:A9,"<>",C1:C9)', 420], ['=SUMIFS(C1:C9,A1:A9,"*")', 230], ['=AVERAGEIFS(C1:C9,A1:A9,"*")', 57.5], ['=MAXIFS(C1:C9,A1:A9,"<0")', 90],
  ['=MINIFS(C1:C9,A1:A9,"<>#DIV/0!")', 10], ['=COUNTIFS(A1:A9,"<>",C1:C9,">40")', 5], ['=COUNTIFS(A1:A9,"<>",C1:C8,">40")', { error: "#VALUE!" }],
  ['=AVERAGEIFS(C1:C9,A1:A9,"zzz")', { error: "#DIV/0!" }], ['=MAXIFS(C1:C9,A1:A9,"zzz")', 0], ['=AVERAGEIF(A1:A9,"<>#DIV/0!",C1:C9)', 53.75], ['=SUMIFS(C1:C8,A1:A9,"<>")', { error: "#VALUE!" }],
  ['=COUNTIF(A3:A9,"<>0")', 7], ['=COUNTIF(A3:A4,"<=0")', 0],
];
await test("*IF / *IFS criteria (27 cases): an error cell never fails the function and matches its own error literal; \"=\" = empty cells only, \"\" = empty + empty text, \"<>\" = non-empty; wildcards see text only, ~ escapes; size mismatch → #VALUE!", { "FF-52": "full", "FF-27": "partial" }, () => {
  const run = (W: typeof Workbook) => { const wb = new W(); const s = wb.sheet(); SETUP2.forEach((v, i) => { if (v) s.setCell(0, i, v); }); for (let i = 0; i < 9; i++) s.setCell(2, i, String((i + 1) * 10)); CRIT.forEach(([f], i) => s.setCell(4, i, f)); wb.recalculate(); return report(CRIT.map(([f, e], i) => { const v = s.get(4, i)?.value; return { f, e, v, good: J(v) === J(e) || (typeof v === "number" && typeof e === "number" && Math.abs(v - e) < 1e-9) }; })); };
  void COLB2;
  const now = run(Workbook), before = run(B.Workbook);
  ok(now.length === 0, `wrong: ${now.join(" | ")}`);
  ok(before.length >= 10, `before evidence: TT67 should get ≥10 wrong, got ${before.length}`);
  console.log(`    TT67 got ${before.length}/27 wrong, e.g. ${before.slice(0, 4).join(" | ")}`);
});

/* ---------------------------------------------------------------- 3. error constants */
await test("error literals are error CONSTANTS (ECMA-376 ST_CellError), case-insensitive; '#N/A stays text; #bogus / #SPILL! typed stay text; textInput quotes an error-looking text so it round-trips as text", { "FF-52": "full", "FF-19": "partial" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  const inputs = ["#DIV/0!", "#n/a", " #NUM! ", "#bogus", textInput("#N/A"), "#SPILL!", "#NULL!", "#REF!", "#NAME?", "#VALUE!"];
  inputs.forEach((v, i) => { s.setCell(0, i, v); s.setCell(1, i, `=ISERROR(A${i + 1})`); s.setCell(2, i, `=ISTEXT(A${i + 1})`); });
  wb.recalculate();
  const got = inputs.map((_v, i) => [s.get(1, i)?.value, s.get(2, i)?.value]);
  const want = [[true, false], [true, false], [true, false], [false, true], [false, true], [false, true], [true, false], [true, false], [true, false], [true, false]];
  ok(J(got) === J(want), `${J(got)} != ${J(want)}`);
  ok(J(s.get(0, 1)?.value) === J({ error: "#N/A" }), "#n/a → #N/A");
  ok(textInput("#N/A") === "'#N/A" && textInput("#bogus") === "#bogus", "textInput quoting");
});

/* ---------------------------------------------------------------- 4. reader: constant empty text kept, per lxml */
const EMPTY_FILES = ["47737.xlsx", "54288-ref.xlsx", "54288.xlsx", "56278.xlsx", "FormulaEvalTestData_Copy.xlsx", "LIBRE_OFFICE-116306-0.xlsx", "bug60858.xlsx", "bug66675.xlsx"];
const quoteCells = (wb: ReturnType<typeof readXlsxWorkbook>) => { const o: Record<string, string[]> = {}; for (const [n, sh] of wb.sheets) { const l: string[] = []; for (const [k, c] of sh.grid) if (c.input === "'") { const [col, row] = k.split(",").map(Number); let s = "", x = col + 1; while (x) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); } l.push(`${s}${row + 1}`); } o[n] = l.sort(); } return o; };
await test("reader: every constant empty-text cell of the 8 corpus workbooks that have them is kept as non-blank empty text — the SAME cells lxml finds (6 190 cells); TT67 dropped them all", { "FF-52": "full", "FF-21": "partial" }, () => {
  let total = 0; const bad: string[] = [];
  for (const f of EMPTY_FILES) {
    const buf = readFileSync(`${CORPUS}/${f}`);
    const ours = quoteCells(readXlsxWorkbook(buf));
    const lx = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", `${CORPUS}/${f}`, "--empty-text"], { encoding: "utf8", maxBuffer: 1 << 28 })) as Record<string, string[]>;
    for (const s of new Set([...Object.keys(lx), ...Object.keys(ours)])) { lx[s] ??= []; const a = J(ours[s] ?? []), b = J([...lx[s]].sort()); if (a !== b) bad.push(`${f}!${s}: ours ${a.slice(0, 200)} lxml ${b.slice(0, 200)}`); total += lx[s].length; }
    const before = quoteCells(BX.readXlsxWorkbook(buf));
    ok(Object.values(before).every((l) => l.length === 0), `${f}: TT67 kept empty text?`);
  }
  ok(!bad.length, bad.join(" | "));
  ok(total === 6190, `cells ${total}`);
  console.log(`    ${total} empty-text cells, all equal to lxml; TT67 kept 0`);
});

/* ---------------------------------------------------------------- 5. hostile / edge cell shapes (negative) */
const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
function pkg(cells: string, sst: string[] = ["", "x"]): Buffer {
  const ws = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${SML}"><sheetData><row r="1">${cells}</row></sheetData></worksheet>`;
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="${SML}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="${SML}">${sst.map((t) => (t === "<rich-empty>" ? "<si><r><t/></r></si>" : `<si><t>${t}</t></si>`)).join("")}</sst>`],
    ["xl/worksheets/sheet1.xml", ws],
  ];
  return writeZip(files.map(([name, s]) => ({ name, data: Buffer.from(s, "utf8") })));
}
// [name, cell XML, expected input of A1 ("" = no cell / blank), expected lxml empty-text verdict]
const SHAPES: [string, string, string, boolean][] = [
  ["sst \"\"", `<c r="A1" t="s"><v>0</v></c>`, "'", true],
  ["sst rich run empty", `<c r="A1" t="s"><v>2</v></c>`, "'", true],
  ["sst index with spaces", `<c r="A1" t="s"><v> 0 </v></c>`, "'", true],
  ["sst <v></v>", `<c r="A1" t="s"><v></v></c>`, "", false],
  ["sst negative index", `<c r="A1" t="s"><v>-1</v></c>`, "", false],
  ["sst index out of range", `<c r="A1" t="s"><v>99</v></c>`, "", false],
  ["sst fractional index", `<c r="A1" t="s"><v>0.5</v></c>`, "", false],
  ["inlineStr <is/>", `<c r="A1" t="inlineStr"><is/></c>`, "'", true],
  ["inlineStr <is><t/></is>", `<c r="A1" t="inlineStr"><is><t/></is></c>`, "'", true],
  ["inlineStr empty rich run", `<c r="A1" t="inlineStr"><is><r><t></t></r></is></c>`, "'", true],
  ["inlineStr without <is>", `<c r="A1" t="inlineStr"/>`, "", false],
  ["str constant <v></v>", `<c r="A1" t="str"><v></v></c>`, "", false],
  ["str constant without <v>", `<c r="A1" t="str"/>`, "", false],
  ["styled blank", `<c r="A1" s="0"/>`, "", false],
  ["formula with cached \"\"", `<c r="A1" t="str"><f>""</f><v></v></c>`, '=""', false],
  ["error constant", `<c r="A1" t="e"><v>#N/A</v></c>`, "#N/A", false],
  ["number", `<c r="A1"><v>0</v></c>`, "0", false],
  ["text that looks like an error", `<c r="A1" t="s"><v>1</v></c>`, "'#N/A", false],
];
await test(`hostile / edge cell shapes (${SHAPES.length}): which XML is empty text, which is no value — sst "" / rich-empty / spaced index → empty text; empty, negative, fractional or out-of-range index, inlineStr without <is>, str without <v> → no value; lxml agrees on every empty-text verdict; text "#N/A" stays text`, { "FF-52": "full", "FF-21": "partial" }, () => {
  const bad: string[] = [];
  for (const [name, xml, want, lxWant] of SHAPES) {
    const buf = pkg(xml, name === "text that looks like an error" ? ["", "#N/A"] : ["", "x", "<rich-empty>"]);
    let got = "?";
    try { got = readXlsxWorkbook(buf).sheet().get(0, 0)?.input ?? ""; } catch (e) { got = `throw ${(e as Error).message}`; }
    const p = `${dir}/shape.xlsx`; writeFileSync(p, buf);
    const lx = (JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", p, "--empty-text"], { encoding: "utf8" })) as Record<string, string[]>).S ?? [];
    if (got !== want) bad.push(`${name}: input ${J(got)} want ${J(want)}`);
    if (lx.includes("A1") !== lxWant) bad.push(`${name}: lxml empty-text=${lx.includes("A1")}`);
  }
  ok(!bad.length, bad.join(" | "));
});

/* ---------------------------------------------------------------- 6. writer */
await test("writer: a constant empty-text cell is saved (shared string \"\"), a blank is not; openpyxl sees '' vs no cell; re-read keeps ISBLANK FALSE / COUNTA 1; styled blank stays blank", { "FF-52": "full", "FF-20": "partial" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(0, 0, "'"); s.setCell(0, 2, "x"); s.setStyle(0, 3, { bold: true });
  s.setCell(1, 0, "=ISBLANK(A1)"); s.setCell(1, 1, "=ISBLANK(A2)"); s.setCell(1, 2, "=COUNTA(A1:A4)"); wb.recalculate();
  const p = `${dir}/w.xlsx`; writeFileSync(p, writeXlsxWorkbook(wb));
  const py = JSON.parse(execFileSync(PY, ["-c", `import openpyxl,json,sys
ws=openpyxl.load_workbook(sys.argv[1]).active
print(json.dumps({k:[ws[k].value, ws[k].data_type] for k in ["A1","A2","A3","A4"]}))`, p], { encoding: "utf8" })) as Record<string, [unknown, string]>;
  ok(py.A1[0] === "" && py.A1[1] === "s", `openpyxl A1 ${J(py.A1)}`);
  ok(py.A2[0] === null && py.A4[0] === null, `blank / styled blank ${J(py.A2)} ${J(py.A4)}`);
  const back = readXlsxWorkbook(readFileSync(p)); back.recalculate(); const t = back.sheet();
  ok(t.get(0, 0)?.input === "'" && t.get(1, 0)?.value === false && t.get(1, 1)?.value === true && t.get(1, 2)?.value === 2, `re-read ${J([t.get(0, 0)?.input, t.get(1, 0)?.value, t.get(1, 1)?.value, t.get(1, 2)?.value])}`);
  const lx = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", p, "--empty-text"], { encoding: "utf8" })) as Record<string, string[]>;
  ok(J(Object.values(lx)[0]) === J(["A1"]), `lxml ${J(lx)}`);
});

/* ---------------------------------------------------------------- 7. lossless patch */
await test("lossless save: untouched empty-text cells keep their original <c> byte-for-byte; a cell edited to empty text is written as an empty inline string; openpyxl opens it and lxml lists exactly the original empty-text cells plus the new one", { "FF-52": "full", "FF-21": "partial" }, async () => {
  const f = "54288-ref.xlsx"; const orig = readFileSync(`${CORPUS}/${f}`);
  const wb = readXlsxWorkbook(orig); const sh = wb.sheet("MIDCON-PJM");
  sh.setCell(0, 0, "'"); // A1 → empty text
  wb.recalculate();
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb);
  const p = `${dir}/patched.xlsx`; writeFileSync(p, bytes);
  const before = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", `${CORPUS}/${f}`, "--empty-text"], { encoding: "utf8" })) as Record<string, string[]>;
  const after = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_values_lxml.py", p, "--empty-text"], { encoding: "utf8" })) as Record<string, string[]>;
  ok(J([...after["MIDCON-PJM"]].sort()) === J([...before["MIDCON-PJM"], "A1"].sort()), `MIDCON ${J(after["MIDCON-PJM"])}`);
  ok(J(after["SOCO-ENT"]) === J(before["SOCO-ENT"]), "other sheet unchanged");
  // original <c> elements of the untouched empty-text cells survive verbatim
  const sheetXml = (buf: Buffer, n: string) => readEntryVerified(buf, readCentralDirectory(buf).find((e) => e.name === n)!).toString("utf8");
  const o = sheetXml(orig, "xl/worksheets/sheet1.xml"), q = sheetXml(Buffer.from(bytes), "xl/worksheets/sheet1.xml");
  const cellXml = (x: string, r: string) => new RegExp(`<c r="${r}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(x)?.[0];
  for (const r of before["MIDCON-PJM"]) ok(cellXml(o, r) && cellXml(o, r) === cellXml(q, r), `${r}: ${cellXml(o, r)} → ${cellXml(q, r)}`);
  ok(/<c r="A1"[^>]*t="inlineStr"[^>]*><is><t\/><\/is><\/c>/.test(q), `new A1: ${cellXml(q, "A1")}`);
  execFileSync(PY, ["-c", "import openpyxl,sys; openpyxl.load_workbook(sys.argv[1])", p]);
  const back = readXlsxWorkbook(Buffer.from(bytes)).sheet("MIDCON-PJM");
  ok(back.get(0, 0)?.input === "'", "re-read A1");
});

/* ---------------------------------------------------------------- 8. held-out: Excel's cached results */
if (!process.env.TT68_FAST) {
  await test("held-out: Excel's CACHED results for all 26 946 formula cells of the corpus — the TT68 engine agrees with Excel on every cell TT67 did, plus 7 more (ISBLANK/ISTEXT of empty text, error constants, COUNTIF of an error); 0 regressions", { "FF-52": "full", "FF-19": "partial", "FF-21": "partial" }, async () => {
    const { heldOut } = await import("./tt68-heldout.mts");
    const files = readdirSync(CORPUS).filter((f) => /\.xlsx$/i.test(f)).map((f) => `${CORPUS}/${f}`);
    const r = heldOut(files);
    const regress = r.flips.filter((x) => J(x.before) === J(x.cached) || (typeof x.before === "number" && typeof x.cached === "number" && Math.abs(x.before - x.cached) < 1e-9 * Math.max(1, Math.abs(x.cached)))).filter((x) => J(x.after) !== J(x.cached));
    ok(regress.length === 0, `regressions: ${J(regress.slice(0, 5))}`);
    ok(r.okAfter - r.okBefore >= 7, `gain ${r.okAfter - r.okBefore}`);
    console.log(`    ${r.cells} cells: TT67 ${r.okBefore} agree, TT68 ${r.okAfter} agree (+${r.okAfter - r.okBefore}), 0 regressions`);
  });
}

finish();
