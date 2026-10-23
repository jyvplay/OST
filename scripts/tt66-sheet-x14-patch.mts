/**
 * TT66 Excel 2010 (x14) conditional formatting on LOSSLESS save (patchXlsx) and export (writeXlsxWorkbook).
 * Before TT66 the patch writer emitted only a 2007 <cfRule> for a rule added in the app: x14-only icon sets (3Stars,
 * 3Triangles, 5Boxes, custom icon mixes) were silently dropped, data bars lost their x14 properties (negative colour,
 * axis, border, solid fill) and cross-sheet formula rules were written where the 2007 schema cannot carry them.
 *
 * Independent oracles (share no code with src/):
 *   * scripts/oracle/xlsx_x14.py — lxml + Microsoft's published [MS-XLSX] Appendix A schemas (x14 / xm) for every
 *     <x14:conditionalFormattings>, plus structural rules a schema cannot state (extLst last, every <x14:id> resolves to
 *     exactly one x14 rule, unique ids, unique priorities, no cross-sheet formula in a 2007 rule);
 *     positive control: the x14 blocks Excel itself wrote in two corpus files validate with no problems;
 *   * scripts/oracle/ooxml_xsd.py — the ECMA-376 transitional XSDs for the whole worksheet part;
 *   * openpyxl must still open every written file.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt66-sheet-x14-patch.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { evalCondFormats, type CondRule } from "../src/lib/formula/sheetmeta.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { openZip } from "../src/lib/office/zipkit.ts";

const { test, finish } = makeHarness("tt66-sheet-x14-patch");
const COV = { "FF-50": "full", "FF-29": "full", "FF-46": "full", "FF-21": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const dir = "/tmp/tt66x14"; mkdirSync(dir, { recursive: true });
const CORPUS = "/home/user/tools/corpus/xlsx/NewStyleConditionalFormattings.xlsx";
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 1400)} != ${JSON.stringify(b)?.slice(0, 1400)}`); };

type X14Rule = { type: string; id: string; priority: string | null; sqref: string; f: string[]; attrs: Record<string, string>; bar: null | { attrs: Record<string, string>; cfvo: (string | null)[][]; border: string | null; neg: string | null; axis: string | null; fill: string | null }; icons: null | { attrs: Record<string, string>; cfvo: (string | null)[][]; custom: string[][] }; dxf: boolean };
type MainRule = { type: string; priority: string; sqref: string; formulas: string[]; link: string | null };
type Rep = { x14_valid: boolean[]; x14_errors: string[]; main: MainRule[]; x14: X14Rule[]; problems: string[] };
const oracle = (path: string, part = "xl/worksheets/sheet1.xml"): Rep => (JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_x14.py", path], { encoding: "utf8", maxBuffer: 1 << 26 }))[path] as Record<string, Rep>)[part];
const xsd = (path: string) => JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", path], { encoding: "utf8", maxBuffer: 1 << 26 }))[path] as { ok: boolean; parts: Record<string, string[]> };
const clean = (r: Rep, m: string) => { ok(r.x14_valid.length > 0 && r.x14_valid.every(Boolean), `${m}: x14 schema: ${r.x14_errors.join(" | ")}`); eq(r.problems, [], `${m}: structural problems`); };
const sheetXml = async (b: Uint8Array, part = "xl/worksheets/sheet1.xml") => new TextDecoder().decode(await (await openZip(b)).read(part));

// Data!A1:F8 numbers (with negatives), Limits!A1 = 10, Limits!B1 = 2
function fixture(): Buffer {
  execFileSync(PY, ["-c", `
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Data"
vals = [-5, -2, 0, 3, 7, 12, 20, 8]
for i, v in enumerate(vals, 1):
    for c in range(1, 7): ws.cell(i, c, v * c)
lim = wb.create_sheet("Limits"); lim["A1"] = 10; lim["B1"] = 2
wb.save("${dir}/base.xlsx")`]);
  return readFileSync(`${dir}/base.xlsx`);
}
const pct = (ps: number[]) => ps.map((p) => ({ t: "percent" as const, v: String(p) }));
/** the rules a user can add in the CF panel (TT66 UI) plus the cross-sheet forms a sheet rename produces */
const NEW: Omit<CondRule, "id" | "sheet">[] = [
  { range: "A1:A8", kind: "bar", barColor: "#638ec6", barNeg: "#ff0000", barAxis: "middle", barAxisColor: "#000000", barBorder: "#1f4e79", barSolid: true, cfvo: [{ t: "autoMin" }, { t: "autoMax" }], barMinLen: 0, barMaxLen: 100 },
  { range: "B1:B8", kind: "icons", iconSet: "3Stars", cfvo: pct([0, 33, 67]) },
  { range: "C1:C8", kind: "icons", iconSet: "5Boxes", cfvo: pct([0, 20, 40, 60, 80]), reverse: true, hideValue: true },
  { range: "D1:D8", kind: "icons", iconSet: "3Arrows", cfvo: pct([0, 33, 67]), icons: ["3Flags:0", "NoIcons:0", "3Symbols:2"] },
  { range: "E1:E8", kind: "expr", formula: "E1>Limits!$A$1", fill: "#ffc7ce", bold: true },
  { range: "F1:F8", kind: "gt", af: "Limits!$A$1", fill: "#c6efce" },
  { range: "F1:F8", kind: "lt", a: "0", fill: "#ffeb9c" },
  { range: "A1:A8", kind: "icons", iconSet: "3Arrows", cfvo: [{ t: "percent", v: "0" }, { t: "formula", v: "Limits!$B$1" }, { t: "num", v: "7", gt: true }] },
  { range: "B1:B8", kind: "bar", barColor: "#5a8a3a", barBorder: "#333333", cfvo: [{ t: "num", v: "0" }, { t: "formula", v: "Limits!$A$1*4" }] },
];
const withNew = (wb: ReturnType<typeof readXlsxWorkbook>, sheet = "Data", rules = NEW) => { rules.forEach((r, i) => wb.condFormats.push({ id: `n${i}`, sheet, ...r } as CondRule)); return wb; };
/** model fields only (no ids, provenance, link GUIDs), so a re-read can be compared with what was added */
const norm = (rs: CondRule[]) => rs.map(({ id: _i, src: _s, x14: _x, sheet: _sh, ...r }) => JSON.stringify(r, Object.keys(r).sort())).sort();
const draw = (wb: ReturnType<typeof readXlsxWorkbook>, sheet = "Data") => { wb.recalculate(); return JSON.stringify([...evalCondFormats(wb, sheet, wb.condFormats.filter((r) => r.sheet === sheet))].sort()); };

await test("lossless save of a file with no extLst: every added x14 rule lands in a new worksheet extLst, validates against the MS-XLSX schema, and nothing x14-only is written as a 2007 rule", COV, async () => {
  const orig = fixture();
  const wb = withNew(readXlsxWorkbook(orig));
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb); writeFileSync(`${dir}/p1.xlsx`, bytes);
  const r = oracle(`${dir}/p1.xlsx`); clean(r, "p1");
  // 2007 part: the linked bar (fallback) and the plain lessThan only
  eq(r.main.map((m) => [m.type, m.sqref, m.formulas, !!m.link]), [["dataBar", "A1:A8", [], true], ["cellIs", "F1:F8", ["0"], false]], "2007 rules");
  eq(r.x14.map((x) => [x.type, x.sqref, x.priority !== null]), [["dataBar", "A1:A8", false], ["iconSet", "B1:B8", true], ["iconSet", "C1:C8", true], ["iconSet", "D1:D8", true], ["expression", "E1:E8", true], ["cellIs", "F1:F8", true], ["iconSet", "A1:A8", true], ["dataBar", "B1:B8", true]], "x14 rules");
  const bar = r.x14[0].bar!;
  eq([bar.attrs, bar.cfvo, bar.border, bar.neg, bar.axis, bar.fill], [{ minLength: "0", maxLength: "100", gradient: "0", border: "1", negativeBarColorSameAsPositive: "0", axisPosition: "middle" }, [["autoMin", null, null], ["autoMax", null, null]], "FF1F4E79", "FFFF0000", "FF000000", null], "data bar x14 properties");
  eq(r.main[0].link, r.x14[0].id, "the 2007 bar links to its x14 half");
  eq([r.x14[1].icons!.attrs, r.x14[2].icons!.attrs], [{ iconSet: "3Stars" }, { iconSet: "5Boxes", showValue: "0", reverse: "1" }], "x14-only icon sets");
  eq(r.x14[3].icons!.custom, [["3Flags", "0"], ["NoIcons", "0"], ["3Symbols", "2"]], "custom icons");
  eq([r.x14[4].f, r.x14[4].dxf, r.x14[5].f, r.x14[5].attrs], [["E1>Limits!$A$1"], true, ["Limits!$A$1"], { operator: "greaterThan" }], "cross-sheet formula rules (xm:f + inline dxf)");
  eq(r.x14[6].icons!.cfvo, [["percent", "0", null], ["formula", "Limits!$B$1", null], ["num", "7", "0"]], "cross-sheet icon threshold → x14 (gte=0 kept)");
  eq([r.x14[7].bar!.fill, r.x14[7].bar!.border, r.x14[7].bar!.cfvo], ["FF5A8A3A", "FF333333", [["num", "0", null], ["formula", "Limits!$A$1*4", null]]], "cross-sheet bar threshold → x14-only bar with its own fillColor");
  const prios = [...r.main.map((m) => Number(m.priority)), ...r.x14.filter((x) => x.priority).map((x) => Number(x.priority))].sort((a, b) => a - b);
  eq(prios, [1, 2, 3, 4, 5, 6, 7, 8, 9], "priorities 1..9, one per rule");
  const v = xsd(`${dir}/p1.xlsx`); ok(v.ok, `ECMA-376 XSD: ${JSON.stringify(v.parts).slice(0, 600)}`);
  const op = execFileSync(PY, ["-c", `import openpyxl; wb = openpyxl.load_workbook("${dir}/p1.xlsx"); print(wb["Data"]["F7"].value, len(wb["Data"].conditional_formatting))`], { encoding: "utf8" }).trim();
  eq(op, "120 2", "openpyxl opens it and sees exactly the two 2007 rules");
});

await test("reopen: the reader gets back every added rule with its x14 properties, and the reopened workbook draws exactly what the edited one drew", COV, async () => {
  const orig = fixture();
  const wb = withNew(readXlsxWorkbook(orig));
  const before = draw(wb);
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb);
  const back = readXlsxWorkbook(Buffer.from(bytes));
  eq(norm(back.condFormats), norm(wb.condFormats), "rules round-trip");
  eq(draw(back), before, "same drawing");
  // keys are "col,row": A1 −5 → red negative bar left of a middle axis + red down arrow (−5 < Limits!B1 = 2);
  // D1 −20 → custom 3Flags:0 (red flag); D8 32 → middle band = NoIcons (no icon); B2 −4 → 3Stars empty star
  const m = JSON.parse(before) as [string, Record<string, unknown>][]; const at = (k: string) => m.find(([kk]) => kk === k)?.[1];
  eq([(at("0,0")?.bar as { color: string; axis: number }).color, (at("0,0")?.bar as { axis: number }).axis, at("0,0")?.icon, at("0,6")?.icon, at("3,0")?.icon, at("3,7"), at("1,1")?.icon], ["#ff0000", 0.5, "arrowDown:red", "arrowUp:green", "flag:red", undefined, "star0:gold"], "drawn x14 effects");
});

await test("a file that already has an x14 ext (Excel-written corpus file): the ext and its <x14:conditionalFormattings> are reused, Excel's own x14 rules stay byte-identical, priorities stay unique", COV, async () => {
  ok(existsSync(CORPUS), "corpus file present (scripts/oracle fetch.py)");
  const orig = readFileSync(CORPUS);
  const wb = readXlsxWorkbook(orig); const sh = [...wb.sheets.keys()][0];
  const x0 = await sheetXml(new Uint8Array(orig));
  const blocks = [...x0.matchAll(/<x14:conditionalFormatting\b[\s\S]*?<\/x14:conditionalFormatting>/g)].map((m) => m[0]);
  withNew(wb, sh, NEW.slice(0, 3).map((r) => ({ ...r, range: r.range.replace(/[A-F](\d)/g, "Z$1") })));
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb); writeFileSync(`${dir}/p3.xlsx`, bytes);
  const x1 = await sheetXml(bytes);
  eq((x1.match(/uri="\{78C0D931-6437-407d-A8EE-F0AAD7539E65\}"/gi) ?? []).length, 1, "one CF ext");
  eq((x1.match(/<x14:conditionalFormattings>/g) ?? []).length, 1, "one conditionalFormattings");
  for (const b of blocks) ok(x1.includes(b), "Excel's x14 block kept verbatim");
  const r = oracle(`${dir}/p3.xlsx`); clean(r, "p3");
  eq(r.x14.length, 3 + 3, "3 original + 3 added x14 rules");
  eq(norm(readXlsxWorkbook(Buffer.from(bytes)).condFormats.filter((c) => c.range.startsWith("Z"))), norm(wb.condFormats.filter((c) => c.range.startsWith("Z"))), "added rules read back");
  const v = xsd(`${dir}/p3.xlsx`); ok(v.ok, `ECMA-376 XSD: ${JSON.stringify(v.parts).slice(0, 600)}`);
});

await test("changing an imported x14 data bar rewrites it under the SAME id (no orphan x14 rule, no dangling link); a duplicated rule gets a fresh id", COV, async () => {
  const orig = readFileSync(CORPUS);
  const wb = readXlsxWorkbook(orig);
  const i = wb.condFormats.findIndex((c) => c.kind === "bar" && c.x14);
  ok(i >= 0, "corpus has a linked x14 bar");
  const id = wb.condFormats[i].x14!;
  wb.condFormats[i] = { ...wb.condFormats[i], barNeg: "#00b050" };
  wb.condFormats.push({ ...wb.condFormats[i], id: "dup", range: "Z1:Z9" });
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb); writeFileSync(`${dir}/p4.xlsx`, bytes);
  const r = oracle(`${dir}/p4.xlsx`); clean(r, "p4");
  eq(r.x14.length, 3 + 1, "the changed bar replaced in place of its old x14 half; the copy adds one");
  const bars = r.x14.filter((x) => x.type === "dataBar");
  const changed = bars.find((x) => x.id === id);
  ok(changed && changed.bar!.neg === "FF00B050", `changed bar kept id ${id} with the new negative colour`);
  ok(bars.some((x) => x.id !== id && x.sqref === "Z1:Z9" && x.bar!.neg === "FF00B050"), "the duplicate has its own id");
});

await test("a worksheet whose SpreadsheetML namespace is prefixed (x:worksheet) gets a prefixed x:extLst / x:ext; the x14 elements keep their own namespace", COV, async () => {
  // rewrite the fixture's sheet part to the prefixed spelling (legal XML; some generators write it)
  execFileSync(PY, ["-c", `
import zipfile, re
zin = zipfile.ZipFile("${dir}/base.xlsx"); zout = zipfile.ZipFile("${dir}/prefixed.xlsx", "w", zipfile.ZIP_DEFLATED)
for it in zin.infolist():
    d = zin.read(it.filename)
    if it.filename == "xl/worksheets/sheet1.xml":
        s = d.decode()
        s = s.replace('xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"', 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"')
        s = re.sub(r"<(/?)(?![?!])([A-Za-z]+)([ />])", r"<\\1x:\\2\\3", s)
        d = s.encode()
    zout.writestr(it, d)
zout.close()`]);
  fixture();
  const orig = readFileSync(`${dir}/prefixed.xlsx`);
  ok((await sheetXml(new Uint8Array(orig))).includes("<x:sheetData>"), "fixture is prefixed");
  const wb = withNew(readXlsxWorkbook(orig), "Data", [NEW[0], NEW[1]]);
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb); writeFileSync(`${dir}/p5.xlsx`, bytes);
  const x = await sheetXml(bytes);
  ok(/<x:extLst><x:ext uri="\{78C0D931/.test(x) && /<x:conditionalFormatting sqref="A1:A8"><x:cfRule type="dataBar"/.test(x), "prefixed main-namespace elements");
  const r = oracle(`${dir}/p5.xlsx`); clean(r, "p5");
  eq(r.x14.map((e) => e.type), ["dataBar", "iconSet"], "x14 rules");
  const v = xsd(`${dir}/p5.xlsx`); ok(v.ok, `ECMA-376 XSD: ${JSON.stringify(v.parts).slice(0, 600)}`);
});

await test("second-order: an existing CF ext whose x14 namespace uses another prefix (a:conditionalFormattings) is extended in place — never a second container in the same ext", COV, async () => {
  fixture();
  execFileSync(PY, ["-c", `
import zipfile
X = "http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"
ext = ('<extLst><ext uri="{78C0D931-6437-407D-A8EE-F0AAD7539E65}"><a:conditionalFormattings xmlns:a="' + X + '">'
       '<a:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><a:cfRule type="iconSet" priority="1" id="{11111111-2222-4333-8444-555555555555}">'
       '<a:iconSet iconSet="3Triangles"><a:cfvo type="percent"><xm:f>0</xm:f></a:cfvo><a:cfvo type="percent"><xm:f>33</xm:f></a:cfvo><a:cfvo type="percent"><xm:f>67</xm:f></a:cfvo></a:iconSet>'
       '</a:cfRule><xm:sqref>C1:C8</xm:sqref></a:conditionalFormatting></a:conditionalFormattings></ext></extLst>')
zin = zipfile.ZipFile("${dir}/base.xlsx"); zout = zipfile.ZipFile("${dir}/aprefix.xlsx", "w", zipfile.ZIP_DEFLATED)
for it in zin.infolist():
    d = zin.read(it.filename)
    if it.filename == "xl/worksheets/sheet1.xml": d = d.decode().replace("</worksheet>", ext + "</worksheet>").encode()
    zout.writestr(it, d)
zout.close()`]);
  const orig = readFileSync(`${dir}/aprefix.xlsx`);
  const wb = withNew(readXlsxWorkbook(orig), "Data", [NEW[1]]);
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb); writeFileSync(`${dir}/p8.xlsx`, bytes);
  const x = await sheetXml(bytes);
  eq([(x.match(/conditionalFormattings[ >]/g) ?? []).length, (x.match(/<ext /g) ?? []).length], [2, 1], "one container (open+close tag) in one ext");
  const r = oracle(`${dir}/p8.xlsx`); clean(r, "p8");
  eq(r.x14.map((e) => e.icons?.attrs.iconSet), ["3Triangles", "3Stars"], "the foreign-prefix rule kept, the new one beside it");
  ok(r.x14[0].priority !== r.x14[1].priority, "priorities differ");
});

await test("re-saving the patched file unchanged is a no-op for conditional formatting (no duplicated x14 rules), and removing an added x14-only rule removes exactly it", COV, async () => {
  const orig = fixture();
  const { bytes } = await patchXlsx(new Uint8Array(orig), withNew(readXlsxWorkbook(orig)));
  const again = await patchXlsx(bytes, readXlsxWorkbook(Buffer.from(bytes)));
  eq(await sheetXml(again.bytes), await sheetXml(bytes), "unchanged re-save keeps the sheet part");
  const wb = readXlsxWorkbook(Buffer.from(bytes));
  const n = wb.condFormats.length;
  wb.condFormats = wb.condFormats.filter((c) => c.iconSet !== "5Boxes");
  eq(wb.condFormats.length, n - 1, "one rule removed in the model");
  const out = await patchXlsx(bytes, wb); writeFileSync(`${dir}/p6.xlsx`, out.bytes);
  const r = oracle(`${dir}/p6.xlsx`); clean(r, "p6");
  eq(r.x14.map((x) => x.icons?.attrs.iconSet ?? x.type), ["dataBar", "3Stars", "iconSet", "expression", "cellIs", "3Arrows", "dataBar"].map((t) => (t === "iconSet" ? "3Arrows" : t)), "5Boxes gone, others kept");
  eq(norm(readXlsxWorkbook(Buffer.from(out.bytes)).condFormats), norm(wb.condFormats), "model after removal round-trips");
});

await test("new-file export (writeXlsxWorkbook): cross-sheet thresholds go x14-only too, and the reader reads an x14-only data bar back", COV, async () => {
  const wb = withNew(readXlsxWorkbook(fixture()), "Data", [NEW[7], NEW[8]]);
  const out = writeXlsxWorkbook(wb); writeFileSync(`${dir}/w7.xlsx`, out);
  const r = oracle(`${dir}/w7.xlsx`); clean(r, "w7");
  eq([r.main.length, r.x14.map((x) => x.type)], [0, ["iconSet", "dataBar"]], "no 2007 rules; both x14-only");
  eq(norm(readXlsxWorkbook(out).condFormats), norm(wb.condFormats), "round-trip");
  const v = xsd(`${dir}/w7.xlsx`); ok(v.ok, `ECMA-376 XSD: ${JSON.stringify(v.parts).slice(0, 600)}`);
});

await test("oracle negative controls: the checker rejects each defect it claims to catch (wrong x14 child order, missing xm:sqref, duplicate id, dangling link, cross-sheet 2007 formula, extLst not last)", COV, async () => {
  const src = await sheetXml(new Uint8Array(readFileSync(`${dir}/p1.xlsx`)));
  const ext = src.slice(src.lastIndexOf("<extLst>"), src.lastIndexOf("</worksheet>")); // the worksheet-level one (the linked bar carries an inner extLst)
  const cases: [string, (s: string) => string, (r: Rep) => boolean][] = [
    ["child order", (s) => s.replace(/(<x14:borderColor [^>]*\/>)(<x14:negativeFillColor [^>]*\/>)/, "$2$1"), (r) => r.x14_valid.includes(false)],
    ["no sqref", (s) => s.replace("<xm:sqref>B1:B8</xm:sqref>", ""), (r) => r.x14_valid.includes(false) || r.problems.some((p) => p.includes("sqref"))],
    ["duplicate id", (s) => { const ids = [...s.matchAll(/<x14:cfRule [^>]*id="(\{[^"]+\})"/g)].map((m) => m[1]); return s.split(ids[2]).join(ids[1]); }, (r) => r.problems.some((p) => p.includes("duplicate x14 rule ids"))],
    ["dangling link", (s) => s.replace(/<x14:id>\{[0-9A-F]/, "<x14:id>{G"), (r) => r.problems.some((p) => p.includes("resolves to 0"))],
    ["cross-sheet 2007", (s) => s.replace("<formula>0</formula>", "<formula>Limits!$A$1</formula>"), (r) => r.problems.some((p) => p.includes("cross-sheet"))],
    ["extLst not last", (s) => s.replace(ext, "").replace("<conditionalFormatting", ext + "<conditionalFormatting"), (r) => r.problems.some((p) => p.includes("last child"))],
  ];
  for (const [name, f, caught] of cases) {
    const s = f(src); ok(s !== src, `${name}: mutation applied`);
    writeFileSync(`${dir}/neg.xml`, s);
    execFileSync(PY, ["-c", `
import zipfile
zin = zipfile.ZipFile("${dir}/p1.xlsx"); zout = zipfile.ZipFile("${dir}/neg.xlsx", "w", zipfile.ZIP_DEFLATED)
for it in zin.infolist():
    d = open("${dir}/neg.xml", "rb").read() if it.filename == "xl/worksheets/sheet1.xml" else zin.read(it.filename)
    zout.writestr(it, d)
zout.close()`]);
    const r = oracle(`${dir}/neg.xlsx`);
    ok(caught(r), `${name}: not caught — ${JSON.stringify({ v: r.x14_valid, p: r.problems })}`);
  }
});

finish();
