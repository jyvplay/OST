/**
 * TT59 Excel 2010 (x14) conditional-format rules that are NOT data bars / icon sets — the form Excel 2010+ uses when a
 * rule's formula refers to another worksheet (cellIs / expression / containsText … with <xm:f> operands and an inline
 * <x14:dxf>, MS-XLSX ConditionalFormattingRule). Before TT59 they were kept verbatim on save but never drawn.
 * Ground truth: values typed into the fixture by hand + the rule semantics (ECMA-376 §18.3.1.10); openpyxl (independent
 * reader) builds the base file and must still open every file we write; lxml checks well-formedness.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt59-x14-cf.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { evalCondFormats } from "../src/lib/formula/sheetmeta.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { openZip } from "../src/lib/office/zipkit.ts";

const { test, finish } = makeHarness("tt59-x14-cf");
const COV = { "FF-29": "full", "FF-20": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const dir = "/tmp/tt59x14"; mkdirSync(dir, { recursive: true });
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 900)} != ${JSON.stringify(b)?.slice(0, 900)}`); };

// Sheet1 A1:A6 = 5, 12, 20, 8, "apple pie", "pear"; Limits!A1 = 10, Limits!B1 = "apple", Limits!C1 = 15
const X14 = (rules: string) => `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:conditionalFormattings>${rules}</x14:conditionalFormattings></ext></extLst>`;
const RULES =
  // 1) cellIs greaterThan another sheet's cell: red fill + bold dark-red font
  `<x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:cfRule type="cellIs" priority="2" operator="greaterThan" id="{00000000-0000-4000-8000-000000000001}"><xm:f>Limits!$A$1</xm:f><x14:dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></x14:dxf></x14:cfRule><xm:sqref>A1:A4</xm:sqref></x14:conditionalFormatting>` +
  // 2) cellIs between two other-sheet cells (higher priority: 1) with stopIfTrue: green fill
  `<x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:cfRule type="cellIs" priority="1" stopIfTrue="1" operator="between" id="{00000000-0000-4000-8000-000000000002}"><xm:f>Limits!$A$1+1</xm:f><xm:f>Limits!$C$1</xm:f><x14:dxf><fill><patternFill><bgColor rgb="FFC6EFCE"/></patternFill></fill></x14:dxf></x14:cfRule><xm:sqref>A1:A4</xm:sqref></x14:conditionalFormatting>` +
  // 3) expression with a relative ref + another-sheet ref: italic blue text
  `<x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main"><x14:cfRule type="expression" priority="3" id="{00000000-0000-4000-8000-000000000003}"><xm:f>ISNUMBER(SEARCH(Limits!$B$1,A5))</xm:f><x14:dxf><font><i/><color rgb="FF0000FF"/></font></x14:dxf></x14:cfRule><xm:sqref>A5:A6</xm:sqref></x14:conditionalFormatting>`;

function fixture(): Buffer {
  execFileSync(PY, ["-c", `
import openpyxl, zipfile, shutil
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Sheet1"
for i, v in enumerate([5, 12, 20, 8, "apple pie", "pear"], 1): ws.cell(i, 1, v)
lim = wb.create_sheet("Limits"); lim["A1"] = 10; lim["B1"] = "apple"; lim["C1"] = 15
wb.save("${dir}/base.xlsx")
zin = zipfile.ZipFile("${dir}/base.xlsx"); zout = zipfile.ZipFile("${dir}/x14.xlsx", "w", zipfile.ZIP_DEFLATED)
for it in zin.infolist():
    data = zin.read(it.filename)
    if it.filename == "xl/worksheets/sheet1.xml":
        s = data.decode(); s = s.replace("</worksheet>", open("${dir}/ext.xml").read() + "</worksheet>"); data = s.encode()
    zout.writestr(it, data)
zout.close()
`]);
  return readFileSync(`${dir}/x14.xlsx`);
}
writeFileSync(`${dir}/ext.xml`, X14(RULES));

const EXPECT = {
  // A1 5: none · A2 12: between 11..15 → green, stop (rule 1 never applies) · A3 20: > 10 → red+bold · A4 8: none
  "0,1": { fill: "#c6efce" }, "0,2": { fill: "#ffc7ce", color: "#9c0006", bold: true },
  // A5 "apple pie" contains Limits!B1 → italic blue · A6 "pear" no
  "0,4": { color: "#0000ff", italic: true },
};
const styles = (wb: ReturnType<typeof readXlsxWorkbook>) => {
  wb.recalculate();
  const m = evalCondFormats(wb, "Sheet1", wb.condFormats.filter((r) => r.sheet === "Sheet1"));
  return Object.fromEntries([...m].filter(([, v]) => Object.keys(v).length).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, typeof b === "string" ? b.toLowerCase() : b]))]).sort());
};

await test("x14-only cellIs / between / expression rules with other-sheet references are read with their inline x14:dxf and drawn in priority order (stopIfTrue honoured)", COV, () => {
  const wb = readXlsxWorkbook(fixture());
  eq(wb.condFormats.map((r) => [r.kind, r.af ?? r.formula, r.bf ?? null, r.src, !!r.stop]), [["between", "Limits!$A$1+1", "Limits!$C$1", "x1", true], ["gt", "Limits!$A$1", null, "x0", false], ["expr", "ISNUMBER(SEARCH(Limits!$B$1,A5))", null, "x2", false]], "rules");
  eq(styles(wb), EXPECT, "drawn styles");
  // the formulas really are live: change Limits!A1 to 3 → A1 5 (> 3) and A4 8 (between 4..15)
  wb.sheet("Limits").setCell(0, 0, "3");
  const s2 = styles(wb);
  eq([s2["0,0"]?.fill, s2["0,3"]?.fill, s2["0,2"]?.fill], ["#c6efce", "#c6efce", "#ffc7ce"], "after editing the other sheet");
});

await test("new-file writer: cross-sheet formula rules are emitted as x14-only rules (xm:f + inline x14:dxf), round-trip to the same drawing, and openpyxl/lxml still open the file", COV, async () => {
  const wb = readXlsxWorkbook(fixture());
  const out = writeXlsxWorkbook(wb); writeFileSync(`${dir}/out.xlsx`, out);
  const zip = await openZip(new Uint8Array(out)); const xml = new TextDecoder().decode(await zip.read("xl/worksheets/sheet1.xml"));
  const main = xml.slice(0, xml.indexOf("<extLst>") < 0 ? xml.length : xml.indexOf("<extLst>"));
  ok(!/Limits!/.test(main), "no cross-sheet formula in the 2007 <conditionalFormatting>");
  eq((xml.match(/<x14:cfRule type="(cellIs|expression)"/g) ?? []).length, 3, "three x14 formula rules");
  ok(/<xm:f>Limits!\$A\$1\+1<\/xm:f><xm:f>Limits!\$C\$1<\/xm:f><x14:dxf>/.test(xml), "xm:f operands then x14:dxf (schema order)");
  const back = readXlsxWorkbook(out);
  eq(styles(back), EXPECT, "re-read draws the same");
  const r = execFileSync(PY, ["-c", `
import openpyxl, zipfile; from lxml import etree
wb = openpyxl.load_workbook("${dir}/out.xlsx"); z = zipfile.ZipFile("${dir}/out.xlsx")
[etree.fromstring(z.read(n)) for n in z.namelist() if n.endswith(".xml")]
print(wb["Limits"]["A1"].value, wb["Sheet1"]["A5"].value, len(wb["Sheet1"].conditional_formatting))`], { encoding: "utf8" }).trim();
  eq(r, "10 apple pie 0", "openpyxl opens it (sees no 2007 rules — the cross-sheet ones are x14-only, as in Excel's own files)");
});

await test("same-sheet formula rules stay in the 2007 schema (no x14 duplication); a lossless save of the original keeps the x14 rules byte-identical", COV, async () => {
  const wb = readXlsxWorkbook(fixture());
  wb.condFormats.push({ id: "n1", sheet: "Sheet1", range: "B1:B3", kind: "gt", af: "$A$1", fill: "#ffff00" } as never);
  const out = writeXlsxWorkbook(wb);
  const zip = await openZip(new Uint8Array(out)); const xml = new TextDecoder().decode(await zip.read("xl/worksheets/sheet1.xml"));
  ok(/<conditionalFormatting sqref="B1:B3"><cfRule type="cellIs"[^>]*operator="greaterThan"><formula>\$A\$1<\/formula>/.test(xml), "same-sheet rule in the main schema");
  eq((xml.match(/<x14:cfRule/g) ?? []).length, 3, "only the three cross-sheet rules are x14");
  const orig = fixture(); const wb2 = readXlsxWorkbook(orig); wb2.sheet("Sheet1").setCell(1, 0, "edited");
  const { bytes } = await patchXlsx(new Uint8Array(orig), wb2);
  const z2 = await openZip(bytes); const x2 = new TextDecoder().decode(await z2.read("xl/worksheets/sheet1.xml"));
  const pick = (s: string) => s.slice(s.indexOf("<x14:conditionalFormattings>"), s.indexOf("</x14:conditionalFormattings>"));
  eq(pick(x2), pick(X14(RULES)), "x14 part verbatim after a patch save");
  ok(x2.includes("edited"), "the edit landed");
});

finish();
