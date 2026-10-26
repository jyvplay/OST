/**
 * TT79 — Spreadsheet: OOXML Strict workbooks and ISO 8601 date cells (src/lib/formula/xlsx.ts).
 * Oracle: openpyxl 3 (MIT, test-only) cannot open Strict files, so the oracle first maps every Strict namespace
 * (purl.oclc.org/ooxml/…) and Strict relationship type to its Transitional twin — the same mapping POI applies —
 * then reads the copy; Fusion reads the ORIGINAL Strict bytes.
 *  X1  the three Strict workbooks of the Apache POI corpus: every sheet, every cell — constants, formulas (text) and
 *      ISO date cells (as serials via openpyxl.utils.datetime.to_excel) — equal openpyxl's reading; computed formula
 *      results equal the cached <v> values the Strict writer stored
 *  X2  t="d" cells written into a Transitional workbook (1900 and 1904 date systems): date, date-time, fractional
 *      seconds, a zone designator, 1900-01-01 / 1900-02-28 / 1900-03-01 around Lotus' phantom 1900-02-29 — serial ==
 *      openpyxl (from_ISO8601 + to_excel with the workbook's epoch)
 *  X3  edges (no oracle; ECMA-376 Part 1 §18.2.28 / §18.18.11 as read): dateCompatibility="0" drops the phantom-day
 *      offset before 1900-03-01; bare times are day fractions; impossible dates (2023-02-30, month 13) stay TEXT and
 *      are never silently turned into numbers
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook, isoDateToSerial } from "../src/lib/formula/xlsx.ts";
import { colToLetters } from "../src/lib/formula/index.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { numericText } from "../src/lib/formula/numtext.ts";

const { test, finish } = makeHarness("tt79-sheet");
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/xlsx";
const T = mkdtempSync(join(tmpdir(), "tt79sheet-"));
const COV = { "FF-76": "full" as const };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ORACLE = `
import zipfile, sys, json, openpyxl, datetime
from openpyxl.utils.datetime import to_excel
M = [("http://purl.oclc.org/ooxml/spreadsheetml/main","http://schemas.openxmlformats.org/spreadsheetml/2006/main"),
     ("http://purl.oclc.org/ooxml/officeDocument/relationships","http://schemas.openxmlformats.org/officeDocument/2006/relationships"),
     ("http://purl.oclc.org/ooxml/drawingml/main","http://schemas.openxmlformats.org/drawingml/2006/main"),
     ("http://purl.oclc.org/ooxml/officeDocument/extendedProperties","http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"),
     ("http://purl.oclc.org/ooxml/officeDocument/docPropsVTypes","http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes")]
src, dst = sys.argv[1], sys.argv[2]
zi = zipfile.ZipFile(src); zo = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for n in zi.namelist():
    b = zi.read(n)
    if n.endswith(".xml") or n.endswith(".rels"):
        s = b.decode("utf8")
        for a, t in M: s = s.replace(a, t)
        b = s.encode()
    zo.writestr(n, b)
zo.close()
out = {}
for data_only in (False, True):
    wb = openpyxl.load_workbook(dst, data_only=data_only)
    for ws in wb.worksheets:
        d = out.setdefault(ws.title, {})
        for row in ws.iter_rows():
            for c in row:
                v = c.value
                if v is None: continue
                if isinstance(v, (datetime.datetime, datetime.date, datetime.time)):
                    v = to_excel(v, wb.epoch) if not isinstance(v, datetime.time) else (v.hour * 3600 + v.minute * 60 + v.second + v.microsecond / 1e6) / 86400
                d.setdefault(c.coordinate, {})["cached" if data_only else "input"] = v
print(json.dumps(out))
`;
writeFileSync(join(T, "oracle.py"), ORACLE);
const oracle = (file: string) => JSON.parse(execFileSync(PY, [join(T, "oracle.py"), file, join(T, "mapped.xlsx")], { encoding: "utf8" })) as Record<string, Record<string, { input: unknown; cached?: unknown }>>;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

await test("X1 POI Strict workbooks: every cell == openpyxl on the namespace-mapped copy; formulas recompute to the cached values", COV, () => {
  let cells = 0, formulas = 0;
  for (const f of ["SampleSS.strict.xlsx", "SimpleStrict.xlsx", "sample.strict.xlsx"]) {
    const bytes = readFileSync(join(CORPUS, f)); ok(/purl\.oclc\.org\/ooxml\/spreadsheetml\/main/.test(execFileSync("unzip", ["-p", join(CORPUS, f), "xl/workbook.xml"], { encoding: "utf8" })), `${f} is not Strict`);
    const want = oracle(join(CORPUS, f)); const wb = readXlsxWorkbook(bytes);
    ok(JSON.stringify([...wb.sheets.keys()]) === JSON.stringify(Object.keys(want)), `${f}: sheets ${[...wb.sheets.keys()]} vs ${Object.keys(want)}`);
    for (const [name, cellsWant] of Object.entries(want)) {
      const sh = wb.sheets.get(name)!; const got = new Map<string, { input: string; value: unknown }>();
      for (const [k, c] of sh.grid) { const [col, row] = k.split(",").map(Number); if (c.input !== "") got.set(`${colToLetters(col)}${row + 1}`, { input: c.input, value: c.value }); }
      ok(got.size === Object.keys(cellsWant).length, `${f}/${name}: ${got.size} cells vs ${Object.keys(cellsWant).length}`);
      for (const [ref, w] of Object.entries(cellsWant)) {
        const g = got.get(ref); ok(g, `${f}/${name}!${ref}: missing`); cells++;
        if (typeof w.input === "string" && w.input.startsWith("=")) {
          formulas++; ok(g!.input === w.input, `${f}/${name}!${ref}: formula ${g!.input} vs ${w.input}`);
          ok(typeof w.cached === "number" ? close(Number(g!.value), w.cached) : g!.value === w.cached, `${f}/${name}!${ref}: computed ${g!.value} vs cached ${w.cached}`);
        } else if (typeof w.input === "number") {
          ok(typeof g!.value === "number" && close(g!.value, w.input), `${f}/${name}!${ref}: ${JSON.stringify(g)} vs ${w.input}`);
        } else ok(g!.value === w.input, `${f}/${name}!${ref}: ${JSON.stringify(g!.value)} vs ${JSON.stringify(w.input)}`);
      }
    }
  }
  ok(cells >= 63 && formulas >= 4, `coverage: ${cells} cells, ${formulas} formulas`);
  // the Strict ISO date cell (SimpleStrict "Sheet Number 2"!A4, t="d" 1990-01-01) is the serial 32874
  const a4 = readXlsxWorkbook(readFileSync(join(CORPUS, "SimpleStrict.xlsx"))).sheets.get("Sheet Number 2")!.get(0, 3);
  ok(a4?.value === 32874, `SimpleStrict A4 = ${a4?.value}`);
});

await test("X2 t=\"d\" cells in 1900 and 1904 workbooks == openpyxl (from_ISO8601 + to_excel)", COV, () => {
  const ISO = ["2024-02-29", "2024-02-29T18:30:00", "2001-09-09T01:46:40.250", "1999-12-31T23:59:59Z", "1900-01-01", "1900-02-28", "1900-03-01", "1904-01-02", "2099-12-31T12:00"];
  for (const epoch1904 of [false, true]) {
    const iso = epoch1904 ? ISO.filter((x) => x >= "1904-01-02") : ISO;
    const file = join(T, `d${epoch1904 ? 1904 : 1900}.xlsx`);
    execFileSync(PY, ["-c", `
import openpyxl, sys, zipfile, re
wb = openpyxl.Workbook(); ws = wb.active
for i in range(${iso.length}): ws.cell(row=i + 1, column=1, value=0)
if ${epoch1904 ? "True" : "False"}:
    from openpyxl.utils.datetime import CALENDAR_MAC_1904; wb.epoch = CALENDAR_MAC_1904
wb.save(sys.argv[1] + ".tmp.xlsx")
iso = sys.argv[2].split("|")
zi = zipfile.ZipFile(sys.argv[1] + ".tmp.xlsx"); zo = zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED)
for n in zi.namelist():
    b = zi.read(n)
    if n == "xl/worksheets/sheet1.xml":
        s = b.decode()
        for i, v in enumerate(iso):
            s = re.sub(r'<c r="A%d"([^>]*?)(?: t="n")?><v>0</v></c>' % (i + 1), lambda m: '<c r="A%d"%s t="d"><v>%s</v></c>' % (i + 1, m.group(1), v), s)
        assert s.count('t="d"') == len(iso), s
        b = s.encode()
    zo.writestr(n, b)
zo.close()`, file, iso.join("|")]);
    const want = oracle(file)["Sheet"]; const sh = readXlsxWorkbook(readFileSync(file)).sheets.get("Sheet")!;
    ok(readXlsxWorkbook(readFileSync(file)).date1904 === epoch1904, "date system not read");
    iso.forEach((v, i) => {
      const w = want[`A${i + 1}`]?.input as number; const g = sh.get(0, i)?.value;
      ok(typeof w === "number", `oracle A${i + 1} (${v}) = ${JSON.stringify(want[`A${i + 1}`])}`);
      ok(typeof g === "number" && close(g, w), `${epoch1904 ? 1904 : 1900} ${v}: Fusion ${g} vs openpyxl ${w}`);
    });
  }
});

await test("X3 edges: dateCompatibility=0, bare times, impossible dates stay text", COV, () => {
  ok(isoDateToSerial("1900-01-01") === 1 && isoDateToSerial("1900-02-28") === 59 && isoDateToSerial("1900-03-01") === 61, "1900 compatibility serials");
  ok(isoDateToSerial("1900-01-01", false, false) === 2 && isoDateToSerial("1900-02-28", false, false) === 60 && isoDateToSerial("1900-03-01", false, false) === 61, "dateCompatibility=0 serials");
  ok(isoDateToSerial("1904-01-01", true) === 0 && isoDateToSerial("2024-01-01", true) === isoDateToSerial("2024-01-01")! - 1462, "1904 system");
  ok(isoDateToSerial("12:00") === 0.5 && isoDateToSerial("06:00:00") === 0.25, "bare times");
  for (const bad of ["2023-02-30", "2023-13-01", "2023-1-1", "yesterday", "1899-12-01"]) ok(isoDateToSerial(bad) === null, `${bad} accepted`);
  // an impossible t="d" value is kept as TEXT, not dropped and not coerced
  const file = join(T, "bad.xlsx");
  execFileSync(PY, ["-c", `
import openpyxl, sys, zipfile
wb = openpyxl.Workbook(); wb.active["A1"] = 0; wb.save(sys.argv[1] + ".t")
zi = zipfile.ZipFile(sys.argv[1] + ".t"); zo = zipfile.ZipFile(sys.argv[1], "w")
for n in zi.namelist():
    b = zi.read(n)
    if n == "xl/worksheets/sheet1.xml": b = b.decode().replace('<c r="A1" t="n"><v>0</v></c>', '<c r="A1" t="d"><v>2023-02-30</v></c>').encode(); assert b"2023-02-30" in b
    zo.writestr(n, b)
zo.close()`, file]);
  const c = readXlsxWorkbook(readFileSync(file)).sheets.get("Sheet")!.get(0, 0); ok(c?.value === "2023-02-30", `impossible date became ${JSON.stringify(c?.value)}`);
});
const COV77 = { "FF-77": "full" as const };
await test("X4 text → number coercion (numtext.ts): en-US currency, groups, %, parentheses, exponent; hex / Infinity / dates refused", COV77, () => {
  const yes: [string, number][] = [["$1.00", 1], [" 1,234.50 ", 1234.5], ["-$5", -5], ["$-5", -5], ["(1,000)", -1000], ["50%", 0.5],
    ["1e3", 1000], ["-2.5E-1", -0.25], [".5", 0.5], ["1.", 1], ["+7", 7], ["1,234,567", 1234567]];
  const no = ["", "  ", "abc", "0x10", "Infinity", "NaN", "1/2/2020", "12:30", "$", ".", "--1", "-$-1", "(-1)", "1 2", "5%%"];
  for (const [t, n] of yes) ok(numericText(t) === n, `${JSON.stringify(t)} → ${numericText(t)}, want ${n}`);
  for (const t of no) ok(numericText(t) === null, `${JSON.stringify(t)} → ${numericText(t)}, want null`);
});
await test("X5 the 10 EverythingTests shapes fixed in TT79, rebuilt in a fresh workbook, with negative controls", COV77, () => {
  const wb = new Workbook(); const s = wb.sheet();
  // A1 ="" · B1 text · C1 '4 (text) · C2 5 · D1 2 · D2 3 · E1/E2 blank · F1 TRUE
  s.setCell(0, 0, '=""'); s.setCell(1, 0, "text"); s.setCell(2, 0, "'4"); s.setCell(3, 0, "2"); s.setCell(3, 1, "3"); s.setCell(2, 1, "5"); s.setCell(5, 0, "TRUE");
  const cases: [string, unknown][] = [
    ["=+B1", "text"], ["=+E1", 0], ["=-E1", 0], ["=B1/E1", "#VALUE!"], ["=D1/E1", "#DIV/0!"], ["=CHOOSE(#REF!,1)", "#REF!"],
    ['=DOLLAR("$1.00")', "$1.00"], ['="$1,234.50"*2', 2469], ['="(5)"+0', -5], ['="0x10"+0', "#VALUE!"], ["=B1+1", "#VALUE!"],
    ["=IF(E1,1/0,3)", 3], ["=IF(D1,4,5)", 4], ["=LARGE(TRUE,1)", 1], ["=LARGE(D1:F1,1)", 2], ["=SMALL(TRUE,1)", 1],
    ["=ROUND(E1,E2)", 0], ["=ROUND(2.567,E1)", 3], ["=SUMPRODUCT(C1:C1,D1:D1)", "#VALUE!"], ["=SUMPRODUCT(C1:C2,D1:D2)", 15],
    ["=SUMPRODUCT(D1:D1,D2:D2)", 6], ["=OFFSET(D1,1,0)", 3],
  ];
  cases.forEach(([f], i) => s.setCell(8, i, f)); wb.recalculate();
  const got = (i: number) => { const v = s.get(8, i)?.value as unknown; return v && typeof v === "object" && "error" in (v as object) ? (v as { error: string }).error : v; };
  const bad = cases.map(([f, want], i) => [f, want, got(i)] as const).filter(([, w, g]) => w !== g);
  ok(!bad.length, bad.map(([f, w, g]) => `${f} → ${JSON.stringify(g)}, want ${JSON.stringify(w)}`).join(" | "));
});
finish();
