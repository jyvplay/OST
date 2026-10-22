/**
 * TT62 Spreadsheet schema conformance — workbooks written by the Spreadsheet (fresh export writeXlsxWorkbook and the
 * lossless patch writer patchXlsx) are validated against the ECMA-376 transitional XSDs by the INDEPENDENT oracle
 * scripts/oracle/ooxml_xsd.py (lxml after Markup-Compatibility processing).
 *  1. oracle sanity on SpreadsheetML: wrong worksheet child order, a bad enumeration, an unknown element are rejected;
 *  2. kitchen sink: every cell style property and border line, merges, every validation type, external + internal
 *     links, freeze panes, column widths, workbook / sheet names, all 25 conditional-format kinds, every chart kind and
 *     grouping (+ trendline), a PivotTable, formulas / errors / booleans / spills, awkward sheet names;
 *  3. 20 randomized workbooks of random features (fresh export);
 *  4. the same feature set added through patchXlsx to POI corpus workbooks: no schema error the input lacked.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt62-sheet-schema.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook, type BorderLine, type CellStyle } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook, readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { COND_KINDS, CHART_KINDS, type CondKind, type CondRule, type ChartSpec } from "../src/lib/formula/sheetmeta.ts";
import { writePivot, type PivotDef } from "../src/lib/formula/pivotsheet.ts";

const { test, finish } = makeHarness("tt62-sheet-schema");
const COV = { "FF-46": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt62s-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
type Res = { parts: Record<string, string[]>; checked: number; skipped: string[]; ok: boolean };
let seq = 0;
const put = (b: Uint8Array, tag = "f") => { const f = join(tmp, `${tag}${seq++}.xlsx`); writeFileSync(f, b); return f; };
const validate = (files: string[]): Record<string, Res> => {
  const out: Record<string, Res> = {};
  for (let i = 0; i < files.length; i += 40) Object.assign(out, JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", ...files.slice(i, i + 40)], { encoding: "utf8", maxBuffer: 256 << 20 })));
  return out;
};
const bad = (r: Res) => Object.entries(r.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e.slice(0, 3).join(" | ")}`);
const LINES: BorderLine[] = ["thin", "medium", "thick", "dashed", "dotted", "double", "hair"];

function rule(kind: CondKind, sheet: string, range: string, i: number): CondRule {
  const r: CondRule = { id: `k${i}`, sheet, range, kind, fill: "#ffeb9c", color: "#9c5700" };
  switch (kind) {
    case "between": case "notBetween": r.a = "2"; r.b = "8"; break;
    case "contains": case "notContains": case "begins": case "ends": r.a = "a&b<c"; break;
    case "expr": r.formula = "MOD(ROW(),2)=0"; break;
    case "top": r.a = "3"; r.pct = i % 2 === 0; r.bottom = i % 3 === 0; break;
    case "aboveAvg": r.below = i % 2 === 1; r.stdDev = i % 4 === 0 ? 1 : undefined; break;
    case "period": r.period = "last7Days"; break;
    case "scale": r.scaleMin = "#f8696b"; r.scaleMax = "#63be7b"; r.scaleMid = "#ffeb84"; r.scaleAt = "min|percentile:50|max"; r.fill = undefined; r.color = undefined; break;
    case "bar": r.barColor = "#638ec6"; r.cfvo = [{ t: "min" }, { t: "max" }]; r.barNeg = "#ff0000"; r.barAxis = "auto"; r.fill = undefined; r.color = undefined; break;
    case "icons": r.iconSet = "3Arrows"; r.cfvo = [{ t: "percent", v: "0" }, { t: "percent", v: "33" }, { t: "percent", v: "67", gt: true }]; r.fill = undefined; r.color = undefined; break;
    default: r.a = "5";
  }
  if (i % 5 === 0) { r.bold = true; r.italic = true; r.underline = true; r.strike = true; r.numFmt = "0.00%"; r.border = { top: { style: "thin", color: "#ff0000" }, bottom: { style: "double" } }; r.stop = true; }
  return r;
}

function kitchenSink(wb: Workbook, prefix: string) {
  const a = wb.addSheet(`${prefix} Data`); const b = wb.addSheet(`${prefix}'s "Q2"`);
  for (let r = 0; r < 12; r++) { a.setCell(0, r, r === 0 ? "Name" : `Item ${r} & <co>`); a.setCell(1, r, r === 0 ? "Qty" : String((r * 37) % 11)); a.setCell(2, r, r === 0 ? "When" : `=DATE(2026,${1 + (r % 12)},${r})`); }
  a.setCell(3, 1, "=SUM(B2:B12)"); a.setCell(3, 2, "=1/0"); a.setCell(3, 3, "TRUE"); a.setCell(3, 4, "=SEQUENCE(3)"); a.setCell(4, 1, "=VLOOKUP(\"x\",A1:B3,2,FALSE)"); a.setCell(4, 2, "line1\nline2 ☃ 𝄞");
  const styles: Partial<CellStyle>[] = [{ bold: true }, { italic: true }, { underline: true }, { align: "center" }, { align: "right" }, { valign: "top" }, { valign: "center" }, { fill: "#ddebf7" }, { color: "#c00000" }, { numFmt: "0.00" }, { numFmt: "yyyy-mm-dd" }, { numFmt: "#,##0;[Red]-#,##0" }, { wrap: true }];
  styles.forEach((s, i) => a.setStyle(i % 5, 13 + Math.floor(i / 5), s));
  LINES.forEach((l, i) => a.setStyle(6, i, { border: { top: { style: l, color: "#1f4e79" }, bottom: { style: l }, left: { style: l }, right: { style: l, color: "#00b050" } } }));
  a.setStyle(7, 0, { bold: true, italic: true, underline: true, align: "center", valign: "bottom", fill: "#fff2cc", color: "#0070c0", numFmt: "0%", wrap: true, border: { top: { style: "medium" } } });
  a.merges.push({ c0: 8, r0: 0, c1: 9, r1: 1 }, { c0: 8, r0: 3, c1: 8, r1: 5 });
  const vt = [["list", "\"Red,Green,Blue\""], ["whole", "1"], ["decimal", "0.5"], ["textLength", "10"], ["date", "DATE(2026,1,1)"], ["custom", "ISNUMBER(A1)"]] as const;
  vt.forEach(([type, f1], i) => a.validations.push({ id: `v${i}`, sqref: `K${i + 1}`, type, operator: type === "list" || type === "custom" ? undefined : (["between", "greaterThan", "lessThanOrEqual", "notEqual"] as const)[i % 4], formula1: f1, formula2: i % 4 === 0 && type !== "list" && type !== "custom" ? "100" : undefined, allowBlank: i % 2 === 0, errorStyle: (["stop", "warning", "information"] as const)[i % 3], showError: true, inCellDropdown: type === "list", errorTitle: "Oops", error: "Bad & <value>", promptTitle: "Hint", prompt: "Pick one" }));
  a.links.push({ ref: "A2", target: "https://example.org/?a=1&b=2", tooltip: "Example & co" } as never, { ref: "A3", location: `'${b.name.replace(/'/g, "''")}'!A1`, display: "Jump" } as never);
  a.freezeRows = 1; a.freezeCols = 1; a.colWidths = { 0: 140, 1: 60, 4: 200 };
  b.freezeRows = 2;
  wb.defineName(`${prefix.replace(/\W/g, "")}Total`, `'${a.name}'!$B$2:$B$12`);
  wb.defineName("LocalRate", "0.07", b.name, "a local name");
  COND_KINDS.forEach((k, i) => wb.condFormats.push(rule(k, a.name, i % 3 === 0 ? "B2:B12 D2:D6" : "B2:B12", i)));
  CHART_KINDS.forEach((k, i) => wb.charts.push({ id: `c${i}`, sheet: a.name, range: "A1:B12", headerRow: true, kind: k, title: `Chart ${k} & <t>`, grouping: (["clustered", "stacked", "percent"] as const)[i % 3], catTitle: "Items", valTitle: "Qty", legend: i % 2 === 0, blanks: (["gap", "zero", "span"] as const)[i % 3], trend: k === "scatter" || k === "line" ? { type: "linear", dispEq: true, dispRSqr: true } as never : undefined, anchor: { c0: 12, r0: i * 16, c1: 20, r1: i * 16 + 14 } } as ChartSpec));
  wb.recalculate();
  const pd: PivotDef = { name: `${prefix}Pivot`, src: { sheet: a.name, ref: "A1:B12" }, anchor: { col: 0, row: 3 }, spec: { rows: [0], cols: [], values: [{ field: 1, fn: "sum" }, { field: 1, fn: "count" }] } };
  ok(writePivot(wb, b, pd).ok, "pivot");
  wb.recalculate();
}

await test("oracle sanity on SpreadsheetML: mergeCells before sheetData, a bad cell type enumeration and an unknown element are rejected; our fresh export of an empty workbook is valid", COV, async () => {
  const wb = new Workbook(); wb.sheets.clear(); wb.addSheet("S"); wb.sheet("S").setCell(0, 0, "x");
  const base = put(new Uint8Array(writeXlsxWorkbook(wb)), "base");
  const fx = (name: string, edit: string) => {
    const dst = join(tmp, `${name}.xlsx`);
    execFileSync(PY, ["-c", `import zipfile,sys,re
zi=zipfile.ZipFile(sys.argv[1]); zo=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)
for it in zi.infolist():
    d=zi.read(it.filename)
    if re.match(r'xl/worksheets/sheet\\d+\\.xml$', it.filename):
        s=d.decode(); n=s; ${edit}; assert s!=n; d=s.encode()
    zo.writestr(it,d)
zo.close()`, base, dst]);
    return dst;
  };
  const f = {
    order: fx("order", `s=re.sub(r'(<sheetData)', r'<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>\\1', s, 1)`),
    enum: fx("enum", `s=re.sub(r'(<c r="A1"[^>]*?) t="[a-z]+"', r'\\1 t="banana"', s, 1)`),
    unknown: fx("unknown", `s=s.replace('<sheetData>','<sheetData><bogus/>',1)`),
  };
  const r = validate([base, ...Object.values(f)]);
  ok(r[base].ok, "empty workbook valid: " + bad(r[base]));
  const sheetErr = (x: string) => Object.entries(r[x].parts).filter(([p]) => /worksheets/.test(p)).flatMap(([, e]) => e).join(" ");
  ok(/mergeCells.*not expected|sheetData.*expected/.test(sheetErr(f.order)), "order rejected: " + sheetErr(f.order));
  ok(/banana/.test(sheetErr(f.enum)), "enum rejected: " + sheetErr(f.enum));
  ok(/bogus/.test(sheetErr(f.unknown)), "unknown rejected: " + sheetErr(f.unknown));
});

await test("kitchen sink (fresh export): every style / border line, merges, 6 validation types, links, freeze panes, widths, names, all 25 CF kinds, 7 chart kinds × groupings + trendlines, a PivotTable, awkward sheet names — every part schema-valid, and it reads back", COV, async () => {
  const wb = new Workbook(); wb.sheets.clear();
  kitchenSink(wb, "KS");
  const f = put(new Uint8Array(writeXlsxWorkbook(wb)), "sink");
  const r = validate([f])[f];
  ok(r.ok, bad(r).join("\n").slice(0, 2500));
  ok(r.checked >= 10, `parts checked ${r.checked}: ${Object.keys(r.parts)}`);
  ok(Object.keys(r.parts).some((p) => /charts\/chart/.test(p)) && Object.keys(r.parts).some((p) => /drawings\/drawing/.test(p)), "chart + drawing parts validated: " + Object.keys(r.parts));
  const back = readXlsxWorkbook(readFileSync(f));
  ok(back.condFormats.length >= 25 && back.charts.length >= 7, `read back ${back.condFormats.length} rules, ${back.charts.length} charts`);
});

await test("20 randomized workbooks (random subsets of every feature, random sizes) — every fresh export is schema-valid", COV, async () => {
  const files: string[] = [];
  for (let t = 0; t < 20; t++) {
    let rnd = 0x5eed62 + t * 104729;
    const rand = (n: number) => { rnd = (rnd * 1103515245 + 12345) >>> 0; return Math.floor((rnd / 2 ** 32) * n); };
    const wb = new Workbook(); wb.sheets.clear();
    const s = wb.addSheet(`R${t} data`);
    const rows = 2 + rand(30), cols = 1 + rand(6);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) s.setCell(c, r, [String(rand(1000) - 300), `t${rand(50)}`, "=A1*2", "", "=IFERROR(1/0,\"e\")", "FALSE", "3.5e-7"][rand(7)]);
    for (let k = rand(6); k > 0; k--) s.setStyle(rand(cols), rand(rows), [{ bold: true }, { fill: "#ffcc00" }, { border: { left: { style: LINES[rand(7)] } } }, { numFmt: "0.0" }, { align: "right" as const }, { wrap: true }][rand(6)]);
    if (rand(2)) s.merges.push({ c0: cols + 1, r0: 0, c1: cols + 2, r1: rand(3) });
    if (rand(2)) { s.freezeRows = rand(3); s.freezeCols = rand(2); }
    for (let k = rand(4); k > 0; k--) wb.condFormats.push(rule(COND_KINDS[rand(COND_KINDS.length)], s.name, `A1:A${rows}`, rand(100)));
    for (let k = rand(3); k > 0; k--) wb.charts.push({ id: `c${k}`, sheet: s.name, range: `A1:B${rows}`, headerRow: rand(2) === 0, kind: CHART_KINDS[rand(7)], title: `T${k}` } as ChartSpec);
    if (rand(2)) s.links.push({ ref: "A1", target: `https://example.org/${t}` } as never);
    if (rand(3) === 0) s.validations.push({ id: "v", sqref: "C1:C5", type: "whole", operator: "between", formula1: "1", formula2: "9", allowBlank: true, errorStyle: "stop", showError: true, inCellDropdown: false });
    if (rand(2)) wb.addSheet(`Extra ${t}`).setCell(0, 0, "x");
    wb.recalculate();
    files.push(put(new Uint8Array(writeXlsxWorkbook(wb)), `rnd${t}-`));
  }
  const r = validate(files);
  const fails = files.filter((f) => !r[f].ok).map((f) => `${f.split("/").pop()}: ${bad(r[f]).join(" ;; ").slice(0, 600)}`);
  ok(!fails.length, `${fails.length} invalid:\n${fails.slice(0, 5).join("\n")}`);
});

await test("lossless patch: the kitchen-sink feature set added through patchXlsx to 4 POI workbooks (plus a cell edit on every original sheet) adds no schema error the input lacked", COV, async () => {
  const names = ["45430.xlsx", "50096.xlsx", "50867_with_table.xlsx", "123233_charts.xlsx"];
  const pairs: [string, string][] = [];
  for (const n of names) {
    const src = readFileSync(`/home/user/tools/corpus/xlsx/${n}`);
    const wb = readXlsxWorkbook(src);
    for (const sh of wb.sheets.values()) sh.setCell(0, 0, "edited & <ok>");
    // in-place additions to an EXISTING sheet (exercises the patch writer's child splicing, not the fresh writer)
    const s0 = [...wb.sheets.values()][0];
    s0.merges.push({ c0: 30, r0: 0, c1: 31, r1: 1 });
    s0.validations.push({ id: "pv", sqref: "AH1:AH4", type: "list", formula1: "\"a,b\"", allowBlank: true, errorStyle: "warning", showError: true, inCellDropdown: true });
    s0.links.push({ ref: "AI1", target: "https://example.org/p?x=1&y=2" } as never);
    s0.freezeRows = 1; s0.setStyle(30, 0, { bold: true, fill: "#e2efda", border: { bottom: { style: "double" } } });
    COND_KINDS.forEach((k, i) => wb.condFormats.push(rule(k, s0.name, "AJ1:AJ9", 100 + i)));
    wb.charts.push({ id: "pc", sheet: s0.name, range: "AJ1:AK9", headerRow: false, kind: "line", title: "Patched in", anchor: { c0: 40, r0: 0, c1: 48, r1: 14 } } as ChartSpec);
    kitchenSink(wb, "P");
    const out = await patchXlsx(new Uint8Array(src), wb);
    pairs.push([`/home/user/tools/corpus/xlsx/${n}`, put(out.bytes, "patch")]);
  }
  const r = validate(pairs.flat());
  const norm = (e: string) => e.replace(/^line \d+: /, "");
  const fails: string[] = [];
  for (const [i, o] of pairs) {
    const before = new Set(Object.values(r[i].parts).flat().map(norm));
    for (const [p, es] of Object.entries(r[o].parts)) for (const e of es) if (!before.has(norm(e))) fails.push(`${o.split("/").pop()} (${i.split("/").pop()}) ${p}: ${e}`);
  }
  ok(!fails.length, `${fails.length} new errors:\n${fails.slice(0, 8).join("\n")}`);
});

await test("OPC part names are case-insensitive: POI 123233_charts.xlsx stores Sheet1.xml with _rels/sheet1.xml.rels — a hyperlink + a chart + a new sheet patched in keep ONE rels part (with the original drawing relationship), ONE <drawing>, no two entries equal ignoring case, and openpyxl loads it", COV, async () => {
  const src = readFileSync("/home/user/tools/corpus/xlsx/123233_charts.xlsx");
  const wb = readXlsxWorkbook(src); const s0 = [...wb.sheets.values()][0]; const nOrig = wb.sheets.size;
  s0.links.push({ ref: "Z1", target: "https://example.org/" } as never);
  wb.charts.push({ id: "x", sheet: s0.name, range: "A1:B5", headerRow: false, kind: "bar", title: "new", anchor: { c0: 20, r0: 0, c1: 26, r1: 10 } } as ChartSpec);
  wb.addSheet("New one").setCell(0, 0, "1");
  const f = put((await patchXlsx(new Uint8Array(src), wb)).bytes, "case");
  const out = execFileSync(PY, ["-c", `import zipfile,sys,json,re,openpyxl
z=zipfile.ZipFile(sys.argv[1]); n=z.namelist(); low=[x.lower() for x in n]
dup=sorted({x for x in low if low.count(x)>1})
rels=[x for x in n if x.lower()=='xl/worksheets/_rels/sheet1.xml.rels']
sx=z.read('xl/worksheets/Sheet1.xml').decode()
wbk=openpyxl.load_workbook(sys.argv[1])
print(json.dumps({"dup":dup,"rels":rels,"relxml":z.read(rels[0]).decode() if rels else "","drawings":len(re.findall(r'<drawing ',sx)),"sheets":wbk.sheetnames}))`, f], { encoding: "utf8" });
  const j = JSON.parse(out);
  ok(j.dup.length === 0, "case-colliding entries: " + j.dup);
  ok(j.rels.length === 1 && /drawings\/drawing1\.xml/.test(j.relxml) && /hyperlink/.test(j.relxml), "one rels part keeping drawing1 + the hyperlink: " + JSON.stringify(j));
  ok(j.drawings === 1, "one <drawing>: " + j.drawings);
  ok(j.sheets.includes("New one") && j.sheets.length === nOrig + 1, "openpyxl sheets " + j.sheets);
  ok(validate([f])[f].parts["xl/worksheets/Sheet1.xml"].length === 0, "Sheet1 schema-valid");
});

await finish();
