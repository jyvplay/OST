/**
 * TT63 Spreadsheet: real PivotTable parts on .xlsx save (src/lib/formula/pivotxml.ts + xlsx-pivotpatch.ts).
 * Oracles (independent of the writer):
 *   • scripts/oracle/ooxml_xsd.py   — ECMA-376 transitional XSDs (pivotTable / pivotCacheDefinition / pivotCacheRecords);
 *   • scripts/oracle/xlsx_pivot.py  — pandas recomputation of every Fusion table from ONLY its definition XML + the
 *     source cells, compared with the saved cells; record/sharedItems integrity; openpyxl's own pivot parser
 *     load → save → load keeps rowFields / colFields / dataFields.
 *  1. fresh export: 13 pivot shapes (row / column / Σ-values / page fields, subtotals and both grand totals off,
 *     all 11 summary functions, booleans / errors / blanks / case-twins / long text / duplicate headings);
 *  2. 60 randomized pivots on random data (fresh export);
 *  3. shapes that cannot be a faithful PivotTable are saved values-only with the reason (no report-filter room,
 *     a filter hiding every item), and the package stays schema-valid;
 *  4. lossless save: source edit + Refresh regenerates ours IN PLACE (same part names / cacheId);
 *  5. lossless save: a deleted pivot's table, cache, records, rels, overrides and <pivotCache> go; a new one is added;
 *  6. lossless save on POI workbooks with native PivotTables: native parts byte-identical, ours added (new cacheId);
 *  7. a name colliding with a native PivotTable on the same sheet becomes "Name (2)";
 *  8. a table re-pivoted outside the app (fields differ from the loaded definition) is native → never overwritten;
 *  9. a cache shared with another table is not rewritten: ours moves to a cache of its own.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt63-sheet-pivotparts.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook, type Sheet } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook, readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { writePivot, refreshPivots, deletePivot, type PivotDef } from "../src/lib/formula/pivotsheet.ts";
import type { PivotFn, PivotSpec } from "../src/lib/formula/pivot.ts";
import { openZip, writeZip } from "../src/lib/office/zipkit.ts";
import type { PivotSaveNote } from "../src/lib/formula/pivotxml.ts";

const { test, finish } = makeHarness("tt63-sheet-pivotparts");
const COV = { "FF-47": "full" } as const;
const T = (name: string, fn: () => Promise<string>) => test(name, COV, async () => { const r = await fn(); console.log(`      ${r}`); });
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/xlsx";
const tmp = mkdtempSync(join(tmpdir(), "tt63p-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
let seq = 0;
const put = (b: Uint8Array, tag = "f") => { const f = join(tmp, `${tag}${seq++}.xlsx`); writeFileSync(f, b); return f; };
type XRes = { parts: Record<string, string[]>; ok: boolean };
const xsd = (files: string[]): Record<string, XRes> => JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", ...files], { encoding: "utf8", maxBuffer: 256 << 20 }));
type PRes = { ok: boolean; error?: string; tables?: { name: string; checked: number; errors: string[]; pages: number }[]; openpyxl?: number; roundtrip?: string[]; native?: number };
const piv = (files: string[], fusionOnly = true): Record<string, PRes> => JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_pivot.py", ...(fusionOnly ? ["--fusion-only"] : []), ...files], { encoding: "utf8", maxBuffer: 256 << 20 }));
const xsdBad = (r: XRes) => Object.entries(r.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e.slice(0, 2).join(" | ")}`);
const pivBad = (r: PRes) => r.error ? [r.error] : [...(r.roundtrip ?? []), ...(r.tables ?? []).flatMap((t) => t.errors.map((e) => `${t.name}: ${e}`))];
const names = async (b: Uint8Array) => openZip(b).entries.map((e) => e.name);
const text = async (b: Uint8Array, p: string) => (await openZip(b).readText(p)) ?? "";

// ---------------------------------------------------------------- data
const HEAD = ["Region", "Product", "Units", "Price", "Flag", "Note"];
function fill(sh: Sheet, rows: (string | number | boolean | null)[][]) {
  rows.forEach((r, i) => r.forEach((v, j) => { if (v !== null) sh.setCell(j, i, typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v)); }));
}
const DATA: (string | number | boolean | null)[][] = [
  HEAD,
  ["East", "Apple", 10, 1.5, true, "ok"],
  ["West", "apple", 5, 2, false, null],
  ["East", "Pear", 7, 3, true, "=NA()"],
  ["West", "Pear", null, 4, true, "x".repeat(300)],
  ["North", "Kiwi", 3, "n/a", false, "ok"],
  [null, null, null, null, null, null],
  ["East", "Kiwi", -2.25, 1.5, null, "OK"],
  ["South", null, 12, 8, true, "late"],
];
function book(): { wb: Workbook; data: Sheet } {
  const wb = new Workbook(); const data = wb.addSheet("Data"); fill(data, DATA);
  const dup = wb.addSheet("Dup"); fill(dup, [["Key", "key", "Val"], ["a", "A", 1], ["b", "B", 2], ["A", "a", 3]]);
  wb.recalculate(); return { wb, data };
}
const v = (field: number, fn: PivotFn) => ({ field, fn });
const SHAPES: { label: string; src?: string; spec: PivotSpec }[] = [
  { label: "rows+sum", spec: { rows: [0], cols: [], values: [v(2, "sum")] } },
  { label: "2 rows subtotals", spec: { rows: [0, 1], cols: [], values: [v(2, "sum")] } },
  { label: "2 rows no subtotals no grand row", spec: { rows: [0, 1], cols: [], values: [v(2, "sum")], subtotals: false, grandRows: false } },
  { label: "rows x cols", spec: { rows: [0], cols: [1], values: [v(2, "sum")] } },
  { label: "rows x cols, 3 values", spec: { rows: [0], cols: [4], values: [v(2, "sum"), v(1, "count"), v(3, "average")] } },
  { label: "cols only", spec: { rows: [], cols: [1], values: [v(2, "max")] } },
  { label: "6 functions", spec: { rows: [0], cols: [], values: [v(2, "min"), v(2, "product"), v(3, "countNums"), v(2, "stdDev"), v(2, "stdDevp"), v(2, "var")] } },
  { label: "varp + boolean rows", spec: { rows: [4], cols: [], values: [v(2, "varp"), v(5, "count")] } },
  { label: "2 col fields, no grand column", spec: { rows: [0], cols: [1, 4], values: [v(2, "sum")], grandCols: false } },
  { label: "axis filter + page filter", spec: { rows: [0], cols: [], values: [v(2, "sum")], filters: [{ field: 0, include: ["East", "West", "(blank)"] }, { field: 4, include: ["TRUE"] }] } },
  { label: "mixed-type row field", spec: { rows: [3], cols: [], values: [v(0, "count")] } },
  { label: "3 rows x col + 2 page filters", spec: { rows: [0, 1, 4], cols: [5], values: [v(2, "sum")], filters: [{ field: 3, include: ["1.5", "2", "3", "4", "8"] }, { field: 2, include: ["10", "5", "7", "-2.25", "12", "3", "(blank)"] }] } },
  { label: "duplicate headings", src: "Dup!A1:C4", spec: { rows: [0], cols: [1], values: [v(2, "sum")] } },
];
function addPivot(wb: Workbook, sheetName: string, spec: PivotSpec, src = "Data!A1:F9", anchor = { col: 1, row: 4 }, name = `PivotTable${seq++}`): PivotDef {
  const sh = wb.sheets.get(sheetName) ?? wb.addSheet(sheetName);
  const [s, ref] = src.split("!");
  const def: PivotDef = { name, src: { sheet: s, ref }, anchor, spec };
  const r = writePivot(wb, sh, def); ok(r.ok, `${sheetName}: ${r.why}`); return def;
}

await T("1. fresh export: 13 pivot shapes are schema-valid, recomputed by pandas from the XML, survive openpyxl", async () => {
  const { wb } = book();
  SHAPES.forEach((s, i) => addPivot(wb, `P${i + 1}`, s.spec, s.src));
  const rep = { pivots: [] as PivotSaveNote[] };
  const bytes = writeXlsxWorkbook(wb, "t", rep);
  ok(rep.pivots.length === SHAPES.length && rep.pivots.every((p) => p.native), `report ${JSON.stringify(rep.pivots.filter((p) => !p.native))}`);
  const f = put(bytes, "k");
  const x = xsd([f])[f]; ok(x.ok, xsdBad(x).join("\n"));
  const p = piv([f])[f]; ok(p.ok, pivBad(p).slice(0, 8).join("\n"));
  ok(p.tables!.length === SHAPES.length && p.tables!.every((t) => t.checked > 0), `tables ${p.tables!.map((t) => t.checked)}`);
  ok(p.openpyxl === SHAPES.length, `openpyxl saw ${p.openpyxl}`);
  ok(p.tables!.find((t) => t.name.length && t.pages === 2), "page fields written");
  // Tabular Form with repeated labels: every row field carries the x14 fillDownLabels ext (MS-XLSX), version 6
  const zk = openZip(bytes); let rowFields = 0, filled = 0;
  for (const n of zk.entries.map((e) => e.name).filter((n) => /pivotTables\/pivotTable\d+\.xml$/.test(n))) {
    const t = (await zk.readText(n))!; ok(/updatedVersion="6"/.test(t) && /compact="0"/.test(t), `${n}: version / compact`);
    rowFields += (t.match(/axis="axisRow"/g) ?? []).length; filled += (t.match(/fillDownLabels="1"/g) ?? []).length;
  }
  ok(rowFields > 0 && rowFields === filled, `fillDownLabels on ${filled} of ${rowFields} row fields`);
  // the reader restores the definitions; a second export is byte-for-byte the same pivot XML (deterministic)
  const back = readXlsxWorkbook(Buffer.from(bytes));
  ok([...back.sheets.values()].reduce((n, s) => n + s.pivots.length, 0) === SHAPES.length, "definitions restored");
  const again = writeXlsxWorkbook(back, "t");
  for (const n of (await names(bytes)).filter((n) => /pivot/.test(n))) ok(await text(bytes, n) === await text(again, n), `re-export differs: ${n}`);
  return `${SHAPES.length} tables · ${p.tables!.reduce((n, t) => n + t.checked, 0)} cells recomputed by pandas · XSD clean · openpyxl round trip`;
});

await T("2. 60 randomized pivots on random data (fresh export) — XSD + pandas oracle", async () => {
  let rnd = 63063; const R = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)];
  const FNS: PivotFn[] = ["sum", "count", "average", "max", "min", "product", "countNums", "stdDev", "stdDevp", "var", "varp"];
  const files: string[] = []; let made = 0;
  for (let k = 0; k < 6; k++) {
    const wb = new Workbook(); const d = wb.addSheet("Src");
    const nf = 4 + Math.floor(R() * 3), nr = 6 + Math.floor(R() * 30);
    const pool = [() => pick(["a", "B", "b", "c", "Ä"]), () => Math.floor(R() * 5), () => Math.round(R() * 1000) / 10, () => pick([true, false]), () => null, () => pick(["x", 1, 2, true])];
    const kinds = Array.from({ length: nf }, () => pick(pool));
    const rows = [Array.from({ length: nf }, (_, j) => `F${j}`), ...Array.from({ length: nr }, () => kinds.map((g) => (R() < 0.12 ? null : g())))];
    fill(d, rows as (string | number | boolean | null)[][]); wb.recalculate();
    for (let t = 0; t < 10; t++) {
      const fields = Array.from({ length: nf }, (_, i) => i).sort(() => R() - 0.5);
      const nRow = Math.floor(R() * 3), nCol = Math.floor(R() * 2.5);
      const rowsF = fields.slice(0, nRow), colsF = fields.slice(nRow, nRow + nCol);
      const values = Array.from({ length: Math.floor(R() * 3) + (rowsF.length + colsF.length ? 0 : 1) }, () => v(pick(fields), pick(FNS)));
      const filters = R() < 0.4 ? [{ field: pick(fields), include: pick([["a", "B", "0", "1", "TRUE", "x"], ["(blank)", "b", "2", "3", "FALSE", "1"]]) }] : [];
      const spec: PivotSpec = { rows: rowsF, cols: colsF, values, filters, subtotals: R() < 0.7, grandRows: R() < 0.8, grandCols: R() < 0.8 };
      const sh = wb.addSheet(`R${t}`);
      const def: PivotDef = { name: `PivotTable${t + 1}`, src: { sheet: "Src", ref: `A1:${String.fromCharCode(64 + nf)}${nr + 1}` }, anchor: { col: 0, row: 3 }, spec };
      if (writePivot(wb, sh, def).ok) made++;
    }
    const rep = { pivots: [] as PivotSaveNote[] };
    files.push(put(writeXlsxWorkbook(wb, "r", rep), "r"));
  }
  const xs = xsd(files), ps = piv(files);
  let tables = 0, cells = 0;
  for (const f of files) {
    ok(xs[f].ok, `${f}: ${xsdBad(xs[f]).join("\n")}`);
    ok(ps[f].ok, `${f}: ${pivBad(ps[f]).slice(0, 6).join("\n")}`);
    tables += ps[f].tables!.length; cells += ps[f].tables!.reduce((n, t) => n + t.checked, 0);
  }
  ok(tables >= 40, `only ${tables} tables written of ${made}`);
  return `${made} pivots computed → ${tables} PivotTable parts (rest refused with a reason) · ${cells} cells recomputed`;
});

await T("3. unfaithful shapes are saved values-only with the reason; the package stays valid", async () => {
  const { wb } = book();
  const top = addPivot(wb, "Top", { rows: [0], cols: [], values: [v(2, "sum")], filters: [{ field: 4, include: ["TRUE"] }] }, "Data!A1:F9", { col: 0, row: 0 }, "TopPivot");
  const busy = wb.addSheet("Busy"); busy.setCell(1, 2, "mine");
  addPivot(wb, "Busy", { rows: [0], cols: [], values: [v(2, "sum")], filters: [{ field: 4, include: ["TRUE"] }] }, "Data!A1:F9", { col: 1, row: 4 }, "BusyPivot");
  addPivot(wb, "None", { rows: [0], cols: [], values: [v(2, "sum")], filters: [{ field: 0, include: ["Nowhere"] }] }, "Data!A1:F9", { col: 1, row: 4 }, "EmptyPivot");
  addPivot(wb, "Fine", { rows: [0], cols: [], values: [v(2, "sum")] }, "Data!A1:F9", { col: 1, row: 4 }, "FinePivot");
  // the UI's own report-filter caption ("Flag | TRUE" two rows above) is exactly Excel's page area → accepted
  const cap = wb.addSheet("Caption"); cap.setCell(1, 2, "Flag"); cap.setCell(2, 2, "TRUE");
  addPivot(wb, "Caption", { rows: [0], cols: [], values: [v(2, "sum")], filters: [{ field: 4, include: ["TRUE"] }] }, "Data!A1:F9", { col: 1, row: 4 }, "CaptionPivot");
  // … but a wrong caption is user data
  const cap2 = wb.addSheet("Caption2"); cap2.setCell(1, 2, "Flag"); cap2.setCell(2, 2, "(All)");
  addPivot(wb, "Caption2", { rows: [0], cols: [], values: [v(2, "sum")], filters: [{ field: 4, include: ["TRUE"] }] }, "Data!A1:F9", { col: 1, row: 4 }, "WrongCaption");
  const rep = { pivots: [] as PivotSaveNote[] };
  const bytes = writeXlsxWorkbook(wb, "t", rep);
  const why = Object.fromEntries(rep.pivots.map((p) => [p.name, p.why ?? "native"]));
  ok(/empty rows above/.test(why.TopPivot) && /hold other data/.test(why.BusyPivot) && /hides every item/.test(why.EmptyPivot) && why.FinePivot === "native" && why.CaptionPivot === "native" && /hold other data/.test(why.WrongCaption), JSON.stringify(why));
  const ns = await names(bytes);
  ok(ns.filter((n) => /pivotTables\/pivotTable\d+\.xml$/.test(n)).length === 2, `parts ${ns.filter((n) => /pivot/.test(n))}`);
  ok(/_FusionPivot/.test(await text(bytes, "xl/workbook.xml")), "definition names still saved");
  const back = readXlsxWorkbook(Buffer.from(bytes)); ok(back.sheets.get("Top")!.pivots[0]?.name === top.name, "values-only pivot still editable after reload");
  const f = put(bytes); const x = xsd([f])[f]; ok(x.ok, xsdBad(x).join("\n")); const p = piv([f])[f]; ok(p.ok && p.tables!.length === 2, pivBad(p).join("\n"));
  return Object.entries(why).map(([k, w]) => `${k}: ${w.slice(0, 50)}`).join(" · ");
});

await T("4. lossless save: source edit + Refresh regenerates ours in place (same parts, same cacheId)", async () => {
  const { wb } = book();
  addPivot(wb, "Pv", { rows: [0], cols: [1], values: [v(2, "sum")] }, "Data!A1:F9", { col: 1, row: 4 }, "Sales");
  const a = writeXlsxWorkbook(wb, "t");
  const wb2 = readXlsxWorkbook(Buffer.from(a)); wb2.sheets.get("Data")!.setCell(2, 1, "100"); wb2.recalculate(); ok(!refreshPivots(wb2).length, "refresh");
  const { bytes, report } = await patchXlsx(new Uint8Array(a), wb2);
  const before = (await names(a)).filter((n) => /pivot/i.test(n)).sort(), after = (await names(bytes)).filter((n) => /pivot/i.test(n)).sort();
  ok(JSON.stringify(before) === JSON.stringify(after), `parts ${before} → ${after}`);
  ok(report.pivots?.written === 1 && report.pivots.removed === 0, JSON.stringify(report.pivots));
  const t = await text(bytes, "xl/pivotTables/pivotTable1.xml"); ok(/cacheId="1"/.test(t) && /name="Sales"/.test(t), "same cacheId / name");
  ok(/<n v="100"\/>/.test(await text(bytes, "xl/pivotCache/pivotCacheRecords1.xml")), "records carry the edit");
  const ct = await text(bytes, "[Content_Types].xml"); ok((ct.match(/pivotTable1\.xml/g) ?? []).length === 1, "one override per part");
  const f = put(bytes); const x = xsd([f])[f]; ok(x.ok, xsdBad(x).join("\n")); const p = piv([f])[f]; ok(p.ok && p.tables![0].checked > 0, pivBad(p).join("\n"));
  // nothing changed → original bytes (the TT46 identity shortcut still holds with pivot parts present)
  const same = await patchXlsx(new Uint8Array(bytes), readXlsxWorkbook(Buffer.from(bytes)));
  ok(Buffer.compare(Buffer.from(same.bytes), Buffer.from(bytes)) === 0, "unchanged save is byte-identical");
  return `${after.length} pivot parts kept in place · edit reflected in records + pandas check`;
});

await T("5. lossless save: deleting a pivot removes its parts / rels / overrides / <pivotCache>; a new one is added", async () => {
  const { wb } = book();
  addPivot(wb, "Pv", { rows: [0], cols: [], values: [v(2, "sum")] }, "Data!A1:F9", { col: 1, row: 4 }, "Gone");
  const a = writeXlsxWorkbook(wb, "t");
  const wb2 = readXlsxWorkbook(Buffer.from(a)); const pv = wb2.sheets.get("Pv")!; deletePivot(pv, pv.pivots[0]);
  const { bytes: b } = await patchXlsx(new Uint8Array(a), wb2);
  const nb = await names(b); ok(!nb.some((n) => /pivot/i.test(n)), `left over: ${nb.filter((n) => /pivot/i.test(n))}`);
  ok(!/pivot/i.test(await text(b, "[Content_Types].xml")) && !/pivotCache/.test(await text(b, "xl/workbook.xml")) && !/pivot/i.test(await text(b, "xl/_rels/workbook.xml.rels")), "workbook-level references removed");
  const sr = nb.find((n) => /worksheets\/_rels\//.test(n)); ok(!sr || !/pivotTable/.test(await text(b, sr)), "sheet rel removed");
  const fb = put(b); ok(xsd([fb])[fb].ok, "xsd after delete");
  // add a new one in a later save
  const wb3 = readXlsxWorkbook(Buffer.from(b)); addPivot(wb3, "New", { rows: [1], cols: [0], values: [v(3, "max")] }, "Data!A1:F9", { col: 1, row: 4 }, "Fresh");
  const { bytes: c, report } = await patchXlsx(new Uint8Array(b), wb3);
  ok(report.pivots?.written === 1, JSON.stringify(report.pivots));
  const fc = put(c); const x = xsd([fc])[fc]; ok(x.ok, xsdBad(x).join("\n")); const p = piv([fc])[fc]; ok(p.ok && p.tables!.length === 1 && p.tables![0].name === "Fresh", pivBad(p).join("\n"));
  return "delete → 0 pivot parts, no dangling reference · add → 1 table, oracle clean";
});

const POI = ["54436.xlsx", "64450.xlsx", "DataTableCities.xlsx", "ExcelPivotTableSample.xlsx", "WithChartSheet.xlsx"].filter((f) => existsSync(join(CORPUS, f)));
await T("6. POI workbooks with native PivotTables: native parts byte-identical, ours added with a new cacheId", async () => {
  ok(POI.length >= 4, `corpus missing (${POI.length}) — run scripts/oracle corpus fetch`);
  const lines: string[] = [];
  for (const file of POI) {
    const orig = new Uint8Array(readFileSync(join(CORPUS, file)));
    const wb = readXlsxWorkbook(Buffer.from(orig));
    const d = wb.addSheet("FusionSrc"); fill(d, DATA); wb.recalculate();
    addPivot(wb, "FusionSrc", { rows: [0], cols: [4], values: [v(2, "sum"), v(3, "average")] }, "FusionSrc!A1:F9", { col: 8, row: 4 }, "FusionPivot");
    const { bytes } = await patchXlsx(orig, wb);
    const oz = openZip(orig), nz = openZip(bytes);
    const native = oz.entries.map((e) => e.name).filter((n) => /pivot/i.test(n));
    for (const n of native) ok(Buffer.compare(Buffer.from((await oz.read(n))!), Buffer.from((await nz.read(n)) ?? new Uint8Array())) === 0, `${file}: native ${n} changed`);
    const wbx = await text(bytes, "xl/workbook.xml"); const ids = [...wbx.matchAll(/cacheId="(\d+)"/g)].map((m) => m[1]);
    ok(new Set(ids).size === ids.length, `${file}: duplicate cacheId ${ids}`);
    const f = put(bytes, "poi"), fo = join(CORPUS, file);
    const xs = xsd([f, fo]); const newErr = xsdBad(xs[f]).filter((e) => !xsdBad(xs[fo]).includes(e));
    ok(!newErr.length, `${file}: new schema errors ${newErr.join("\n")}`);
    const p = piv([f])[f]; ok(p.ok && p.tables!.length === 1 && (p.native ?? 0) >= 1, `${file}: ${pivBad(p).join("\n")} native=${p.native}`);
    lines.push(`${file}: ${native.length} native kept, cacheIds ${ids.join(",")}`);
  }
  return lines.join(" · ");
});

await T("7. a name colliding with a native PivotTable on the same sheet becomes \"Name (2)\"", async () => {
  const file = join(CORPUS, "ExcelPivotTableSample.xlsx"); ok(existsSync(file), "corpus");
  const orig = new Uint8Array(readFileSync(file)); const oz = openZip(orig);
  // the sheet that holds a native table, and that table's name
  const wbx = await oz.readText("xl/workbook.xml"); const rels = (await oz.readText("xl/_rels/workbook.xml.rels"))!;
  let host = "", nativeName = "";
  for (const m of wbx!.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`).exec(rels); const part = "xl/" + (target![1] ?? target![2]).replace(/^\/?xl\//, "");
    const sr = await oz.readText(part.replace(/([^/]+)$/, "_rels/$1.rels")); const t = sr && /Type="[^"]*\/pivotTable"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Type="[^"]*\/pivotTable"/.exec(sr);
    if (t) { const tp = "xl/pivotTables/" + (t[1] ?? t[2]).split("/").pop(); nativeName = /\sname="([^"]+)"/.exec((await oz.readText(tp))!)![1]; host = m[1]; break; }
  }
  ok(host && nativeName, "found a native table");
  const wb = readXlsxWorkbook(Buffer.from(orig)); const d = wb.addSheet("FusionSrc"); fill(d, DATA); wb.recalculate();
  addPivot(wb, host, { rows: [0], cols: [], values: [v(2, "sum")] }, "FusionSrc!A1:F9", { col: 40, row: 4 }, nativeName);
  const { bytes, report } = await patchXlsx(orig, wb);
  ok(report.pivots?.notes.some((n) => n.native && n.name === `${nativeName} (2)`), JSON.stringify(report.pivots?.notes));
  const f = put(bytes); const p = piv([f])[f]; ok(p.ok && p.tables![0].name === `${nativeName} (2)`, pivBad(p).join("\n"));
  return `native "${nativeName}" on ${host} kept · ours written as "${nativeName} (2)"`;
});

await T("8. a table re-pivoted outside the app is treated as native and never overwritten", async () => {
  const { wb } = book();
  addPivot(wb, "Pv", { rows: [0], cols: [], values: [v(2, "sum")] }, "Data!A1:F9", { col: 1, row: 4 }, "Edited");
  const a = writeXlsxWorkbook(wb, "t");
  // simulate Excel: the user moved Product to Rows (rowFields 0 → 1)
  const z = openZip(a); const files: { name: string; data: Uint8Array | string }[] = [];
  for (const e of z.entries) { let data: Uint8Array | string = (await z.read(e.name))!; if (e.name === "xl/pivotTables/pivotTable1.xml") data = (await z.readText(e.name))!.replace('<rowFields count="1"><field x="0"/>', '<rowFields count="1"><field x="1"/>'); files.push({ name: e.name, data }); }
  const edited = await writeZip(files); const mark = await text(edited, "xl/pivotTables/pivotTable1.xml"); ok(/field x="1"/.test(mark), "mutation applied");
  const wb2 = readXlsxWorkbook(Buffer.from(edited)); wb2.sheets.get("Data")!.setCell(2, 2, "50"); wb2.recalculate(); refreshPivots(wb2);
  const { bytes, report } = await patchXlsx(new Uint8Array(edited), wb2);
  ok(await text(bytes, "xl/pivotTables/pivotTable1.xml") === mark, "re-pivoted table overwritten");
  ok(report.pivots?.notes.some((n) => n.native && n.name === "Edited (2)"), `ours is written beside it: ${JSON.stringify(report.pivots?.notes)}`);
  const f = put(bytes); ok(xsd([f])[f].ok, "xsd");
  return "Excel-edited table byte-identical · the app's own view saved as \"Edited (2)\"";
});

await T("9. a cache shared with another table is not rewritten: ours moves to its own cache", async () => {
  const { wb } = book();
  addPivot(wb, "Pv", { rows: [0], cols: [], values: [v(2, "sum")] }, "Data!A1:F9", { col: 1, row: 4 }, "Mine");
  const a = writeXlsxWorkbook(wb, "t");
  // simulate a copied pivot in Excel: a second table (other name, other sheet) on the SAME cacheId
  const z = openZip(a); const files: { name: string; data: Uint8Array | string }[] = [];
  for (const e of z.entries) files.push({ name: e.name, data: (await z.read(e.name))! });
  const t1 = (await z.readText("xl/pivotTables/pivotTable1.xml"))!.replace('name="Mine"', 'name="Copy"');
  files.push({ name: "xl/pivotTables/pivotTable9.xml", data: t1 });
  files.push({ name: "xl/pivotTables/_rels/pivotTable9.xml.rels", data: (await z.readText("xl/pivotTables/_rels/pivotTable1.xml.rels"))! });
  const ct = files.find((f) => f.name === "[Content_Types].xml")!; ct.data = (await z.readText("[Content_Types].xml"))!.replace("</Types>", `<Override PartName="/xl/pivotTables/pivotTable9.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/></Types>`);
  const s1 = files.find((f) => f.name === "xl/worksheets/sheet1.xml")!; // Sheet1 is empty: host the copy there
  files.push({ name: "xl/worksheets/_rels/sheet1.xml.rels", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable9.xml"/></Relationships>` });
  ok(s1, "sheet1");
  const shared = await writeZip(files);
  const cacheBefore = await text(shared, "xl/pivotCache/pivotCacheDefinition1.xml");
  const wb2 = readXlsxWorkbook(Buffer.from(shared)); wb2.sheets.get("Data")!.setCell(2, 3, "70"); wb2.recalculate(); refreshPivots(wb2);
  const { bytes } = await patchXlsx(new Uint8Array(shared), wb2);
  ok(await text(bytes, "xl/pivotCache/pivotCacheDefinition1.xml") === cacheBefore, "shared cache rewritten");
  ok(await text(bytes, "xl/pivotTables/pivotTable9.xml") === t1, "copy changed");
  const mine = await text(bytes, "xl/pivotTables/pivotTable1.xml"); const id = /cacheId="(\d+)"/.exec(mine)![1];
  ok(id !== "1" && new RegExp(`cacheId="${id}"`).test(await text(bytes, "xl/workbook.xml")), `ours on cache ${id}`);
  const f = put(bytes); const x = xsd([f])[f]; ok(x.ok, xsdBad(x).join("\n"));
  // the hand-made "Copy" has no cells under its location (it only exists to share the cache): check ours
  const p = piv([f])[f]; const m = p.tables?.find((t) => t.name === "Mine"); ok(m && !m.errors.length && m.checked > 0 && !p.roundtrip?.length, pivBad(p).join("\n"));
  return `shared cache 1 untouched · ours moved to cache ${id}`;
});

await T("10. a part name that an existing relationship points at is never reused, even when that part is missing", async () => {
  const { wb } = book();
  addPivot(wb, "Pv", { rows: [0], cols: [], values: [v(2, "sum")] }, "Data!A1:F9", { col: 1, row: 4 }, "Native");
  const a = writeXlsxWorkbook(wb, "t");
  // make it native (re-pivoted) and give its cache a DANGLING records relationship to pivotCacheRecords2.xml
  const z = openZip(a); const files: { name: string; data: Uint8Array | string }[] = [];
  for (const e of z.entries) {
    let data: Uint8Array | string = (await z.read(e.name))!;
    if (e.name === "xl/pivotTables/pivotTable1.xml") data = (await z.readText(e.name))!.replace('<rowFields count="1"><field x="0"/>', '<rowFields count="1"><field x="1"/>');
    if (e.name === "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels") data = (await z.readText(e.name))!.replace("pivotCacheRecords1.xml", "pivotCacheRecords2.xml");
    files.push({ name: e.name, data });
  }
  const odd = await writeZip(files);
  const wb2 = readXlsxWorkbook(Buffer.from(odd)); addPivot(wb2, "Other", { rows: [1], cols: [], values: [v(2, "sum")] }, "Data!A1:F9", { col: 1, row: 4 }, "Ours");
  const { bytes } = await patchXlsx(new Uint8Array(odd), wb2);
  const ns = await names(bytes);
  ok(!ns.includes("xl/pivotCache/pivotCacheRecords2.xml"), `the dangling target was adopted: ${ns.filter((n) => /pivotCache\//.test(n))}`);
  ok(/pivotCacheRecords2\.xml/.test(await text(bytes, "xl/pivotCache/_rels/pivotCacheDefinition1.xml.rels")), "native rels untouched");
  // (openpyxl cannot load a package with a dangling cache relationship — the fixture's point — so the XSD oracle checks it)
  const f = put(bytes); const x = xsd([f])[f]; ok(x.ok, xsdBad(x).join("\n"));
  const tables = await Promise.all(ns.filter((n) => /pivotTables\/pivotTable\d+\.xml$/.test(n)).map((n) => text(bytes, n)));
  ok(tables.some((t) => /name="Ours"/.test(t)) && tables.some((t) => /name="Native \(2\)"/.test(t)), "ours (and the app's view of the re-pivoted one) written");
  return `new records part: ${ns.filter((n) => /pivotCacheRecords/.test(n)).join(", ")}`;
});

finish();
