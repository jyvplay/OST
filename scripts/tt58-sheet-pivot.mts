/**
 * TT58 Spreadsheet PivotTables: engine (src/lib/formula/pivot.ts) + workbook integration (pivotsheet.ts).
 * Ground truth: an independent pandas groupby oracle (scripts/oracle/pivot_pandas.py) that computes every
 * (row-prefix × column-prefix × value) aggregate from Excel's documented summary-function definitions, plus hand cases.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt58-sheet-pivot.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { computePivot, fieldItems, itemLabel, type PVal, type PivotFn, type PivotResult, type PivotSpec } from "../src/lib/formula/pivot.ts";
import { pivotsFromNames, deletePivot, pivotAt, readTable, refreshPivots, writePivot, nextPivotName, type PivotDef } from "../src/lib/formula/pivotsheet.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { workbookToJson, workbookFromJson } from "../src/lib/formula/workbook-json.ts";
import { insertDelete } from "../src/lib/formula/sheetops.ts";
import { writeXlsxWorkbook, readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";

const { test, finish } = makeHarness("tt58-sheet-pivot");
const COV = { "FF-21": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 900)} != ${JSON.stringify(b)?.slice(0, 900)}`); };
type Cell = [string[], string[], number, PVal];
const oracle = (cases: { table: PVal[][]; spec: PivotSpec }[]): { cells: Cell[]; records: number }[] =>
  JSON.parse(execFileSync(PY, ["scripts/oracle/pivot_pandas.py"], { input: JSON.stringify({ cases }), encoding: "utf8", maxBuffer: 256 << 20 }));

/** read OUR grid back into (row labels, col labels, value index) → value, using only the documented layout */
function cellsOf(res: PivotResult, spec: PivotSpec): Map<string, PVal> {
  const nr = spec.rows.length, nc = spec.cols.length, nv = Math.max(1, spec.values.length);
  const g = res.grid, W = Math.max(nr, 1);
  const colKey: (null | { cl: string[]; vi: number })[] = [];
  const width = Math.max(...g.map((r) => r.length));
  const leafCols = nc ? (width - W - (res.grandCol !== undefined ? nv : 0)) : nv;
  for (let j = W; j < width; j++) {
    const k = j - W;
    if (nc && res.grandCol !== undefined && j >= res.grandCol) { colKey.push({ cl: [], vi: j - res.grandCol }); continue; }
    if (k >= leafCols) { colKey.push(null); continue; }
    const cl = nc ? Array.from({ length: nc }, (_, h) => String(g[res.colHeaderStart + h][j])) : [];
    colKey.push({ cl, vi: k % nv });
  }
  const out = new Map<string, PVal>();
  let last: string[] = [];
  for (let i = res.headerRows; i < g.length; i++) {
    const row = g[i]; let rl: string[];
    if (i === res.grandRow) rl = [];
    else if (res.totalRows.includes(i)) { const t = row.findIndex((v) => typeof v === "string" && v.endsWith(" Total")); rl = [...last.slice(0, t), String(row[t]).replace(/ Total$/, "")]; }
    else { rl = row.slice(0, nr).map(String); last = rl; }
    colKey.forEach((ck, j) => { if (ck) out.set(JSON.stringify([rl, ck.cl, ck.vi]), row[W + j]); });
  }
  return out;
}
const num = (v: PVal) => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v);
function compare(res: PivotResult, spec: PivotSpec, o: { cells: Cell[]; records: number }, m: string) {
  const ours = cellsOf(res, spec);
  eq(res.records, o.records, `${m}: records after filters`);
  const rowsShown = (rl: string[]) => rl.length === spec.rows.length || rl.length === 0 || (spec.subtotals !== false);
  const colsShown = (cl: string[]) => cl.length === spec.cols.length || cl.length === 0;
  let n = 0;
  for (const [rl, cl, vi, v] of o.cells) {
    if (!rowsShown(rl) || !colsShown(cl) || (cl.length === 0 && spec.cols.length && spec.grandCols === false) || (rl.length === 0 && spec.rows.length && spec.grandRows === false)) continue;
    if (rl.length > 0 && rl.length < spec.rows.length && rl.length !== spec.rows.length - 1 && spec.rows.length > 2) { /* subtotals of every outer level are shown */ }
    const k = JSON.stringify([rl, cl, vi]);
    ok(ours.has(k), `${m}: our grid has no cell for rows=${JSON.stringify(rl)} cols=${JSON.stringify(cl)} value ${vi}`);
    eq(num(ours.get(k)!), num(v), `${m}: rows=${JSON.stringify(rl)} cols=${JSON.stringify(cl)} value ${vi}`);
    n++;
  }
  // and nothing extra: every non-empty numeric cell we show is one the oracle computed
  const theirs = new Set(o.cells.map(([rl, cl, vi]) => JSON.stringify([rl, cl, vi])));
  for (const [k, v] of ours) if (v !== null) ok(theirs.has(k), `${m}: we show a value the oracle has no group for: ${k}`);
  return n;
}

if (!existsSync(PY)) { console.log("python venv missing — run scripts/sandbox/bootstrap.sh"); process.exit(1); }

const SALES: PVal[][] = [
  ["Region", "Rep", "Product", "Units", "Price"],
  ["East", "Ann", "Pens", 10, 1.5], ["West", "Bo", "Pens", 4, 1.5], ["East", "Ann", "Ink", 2, 7], ["east", "Cy", "Pens", 6, 1.25],
  ["West", "Bo", "Paper", 20, 0.5], ["North", "Di", "Ink", null, 7], ["West", "Cy", "Ink", 3, 6.5], ["East", "Di", "Paper", "n/a", 0.5],
];

await test("hand case (Excel tabular form): Region × Product, Sum of Units — item order, case-insensitive grouping (east = East), text ignored by Sum, blank intersection empty, Grand Totals", COV, async () => {
  const r = computePivot(SALES, { rows: [0], cols: [2], values: [{ field: 3, fn: "sum" }] });
  eq(r.grid[0], ["Sum of Units", "Product", null, null, null], "caption row: value name + column field");
  eq(r.grid[1], ["Region", "Ink", "Paper", "Pens", "Grand Total"], "header: row field + column items (ascending) + Grand Total");
  eq(r.grid.slice(2).map((x) => x[0]), ["East", "North", "West", "Grand Total"], "rows: East (absorbs 'east'), North, West");
  eq(r.grid[2], ["East", 2, 0, 16, 18], "East: Ink 2, Paper 0 ('n/a' is text, Sum of no numbers = 0), Pens 10+6");
  eq(r.grid[3], ["North", 0, null, null, 0], "North: Ink blank cell → 0; no Paper / Pens records → empty");
  eq(r.grid[5], ["Grand Total", 5, 20, 20, 45], "grand totals");
  const c = computePivot(SALES, { rows: [0, 1], cols: [], values: [{ field: 3, fn: "count" }, { field: 4, fn: "average" }] });
  eq(c.grid[0], ["Region", "Rep", "Count of Units", "Average of Price"], "two value fields become columns");
  eq(c.grid[1], ["East", "Ann", 2, 4.25], "East/Ann"); eq(c.grid.find((x) => x[0] === "East Total"), ["East Total", null, 4, (1.5 + 7 + 1.25 + 0.5) / 4], "subtotal row: Count counts 'n/a' (non-empty), Average of 4 prices");
  eq(c.grid[c.grid.length - 1], ["Grand Total", null, 7, (1.5 + 1.5 + 7 + 1.25 + 0.5 + 7 + 6.5 + 0.5) / 8], "grand total: 7 non-empty Units, average of all 8 prices");
  const f = computePivot(SALES, { rows: [2], cols: [], values: [{ field: 3, fn: "sum" }], filters: [{ field: 0, include: ["West"] }] });
  eq(f.grid.slice(1), [["Ink", 3], ["Paper", 20], ["Pens", 4], ["Grand Total", 27]], "filter Region = West");
  eq(fieldItems(SALES, 0), ["East", "North", "West"], "filter checklist items");
  eq(computePivot(SALES, { rows: [0], cols: [], values: [{ field: 3, fn: "average" }], filters: [{ field: 0, include: ["North"] }] }).grid[1], ["North", "#DIV/0!"], "Average of no numbers = #DIV/0!");
});

await test("negative shapes: a field on Rows and Columns, an out-of-range field, a source without headings, too many fields / columns, unknown function — each refused with a reason", COV, async () => {
  const bad: [PivotSpec, RegExp][] = [
    [{ rows: [0], cols: [0], values: [] }, /only one of Rows/],
    [{ rows: [9], cols: [], values: [] }, /outside/],
    [{ rows: [0, 1, 2, 3], cols: [], values: [] }, /At most 3 row/],
    [{ rows: [], cols: [0, 1, 2], values: [] }, /At most 2 column/],
    [{ rows: [0], cols: [], values: [{ field: 3, fn: "median" as PivotFn }] }, /Unknown summary/],
    [{ rows: [], cols: [], values: [] }, /at least one/],
  ];
  for (const [spec, re] of bad) { let msg = ""; try { computePivot(SALES, spec); } catch (e) { msg = (e as Error).message; } ok(re.test(msg), `${JSON.stringify(spec)} → ${msg}`); }
  let m = ""; try { computePivot([["A", null], [1, 2]], { rows: [0], cols: [], values: [{ field: 1, fn: "sum" }] }); } catch (e) { m = (e as Error).message; } ok(/heading/.test(m), "missing heading refused");
  const wide: PVal[][] = [["k", "v"], ...Array.from({ length: 600 }, (_, i) => [`c${i}`, i])];
  m = ""; try { computePivot(wide, { rows: [], cols: [0], values: [{ field: 1, fn: "sum" }] }); } catch (e) { m = (e as Error).message; } ok(/More than 500 columns/.test(m), "too many columns refused");
});

await test("300 random tables × specs (1–3 row fields, 0–2 column fields, 1–3 of 11 summary functions, blanks, errors, mixed text/number items, case variants, filters, totals on/off) — every shown cell equals the pandas oracle and nothing extra is shown", COV, async () => {
  let rnd = 0x9170;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 2 ** 32; };
  const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
  const fns: PivotFn[] = ["sum", "count", "average", "max", "min", "product", "countNums", "stdDev", "stdDevp", "var", "varp"];
  const cases: { table: PVal[][]; spec: PivotSpec }[] = [];
  for (let t = 0; t < 300; t++) {
    const nf = 5 + Math.floor(rand() * 3);
    const header = Array.from({ length: nf }, (_, i) => `F${i}`);
    const cat = (i: number): PVal => { const x = rand(); return x < 0.06 ? null : x < 0.1 ? Math.floor(rand() * 3) : x < 0.13 ? (rand() < 0.5) : x < 0.15 ? { e: "#N/A" } : pick(["a", "B", "b", "c", "Delta", "a", "e"]) + (i % 2 ? "" : ""); };
    const val = (): PVal => { const x = rand(); return x < 0.08 ? null : x < 0.12 ? "txt" : x < 0.14 ? true : x < 0.15 ? { e: "#DIV/0!" } : Math.round((rand() * 200 - 50) * 4) / 4; };
    const rows = 1 + Math.floor(rand() * 60);
    const table: PVal[][] = [header, ...Array.from({ length: rows }, () => header.map((_, i) => (i < 3 ? cat(i) : val())))];
    const axes = [0, 1, 2].sort(() => rand() - 0.5);
    const nrows = 1 + Math.floor(rand() * 3), ncols = Math.min(3 - nrows, Math.floor(rand() * 3));
    const spec: PivotSpec = {
      rows: axes.slice(0, nrows), cols: axes.slice(nrows, nrows + ncols),
      values: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ field: 3 + Math.floor(rand() * (nf - 3)), fn: pick(fns) })),
      grandRows: rand() < 0.85, grandCols: rand() < 0.85, subtotals: rand() < 0.8,
    };
    if (rand() < 0.3) { const ff = Math.floor(rand() * 3); const items = fieldItems(table, ff); spec.filters = [{ field: ff, include: items.filter(() => rand() < 0.6) }]; }
    cases.push({ table, spec });
  }
  const os = oracle(cases);
  let compared = 0, skipped = 0;
  cases.forEach((c, t) => {
    let res: PivotResult;
    try { res = computePivot(c.table, c.spec); } catch (e) { if (/More than/.test((e as Error).message)) { skipped++; return; } throw e; }
    compared += compare(res, c.spec, os[t], `case ${t}`);
  });
  ok(compared > 20000 && skipped < 10, `compared ${compared} cells, skipped ${skipped} cases`);
});

await test("workbook: create on a new sheet, source formulas are calculated values, refresh after the source changes (output grows / shrinks, stale cells cleared), refuse to overwrite data or overlap the source, save/reload keeps the definition, delete clears", COV, async () => {
  const wb = new Workbook(); const s = wb.sheet();
  SALES.forEach((r, i) => r.forEach((v, j) => s.setCell(j, i, v === null ? "" : String(v))));
  s.setCell(3, 9, "=2*3"); s.setCell(0, 9, "South"); s.setCell(1, 9, "Ed"); s.setCell(2, 9, "Pens"); s.setCell(4, 9, "1");
  wb.recalculate();
  const out = wb.addSheet("Pivot");
  const def: PivotDef = { name: nextPivotName(wb), src: { sheet: "Sheet1", ref: "A1:E10" }, anchor: { col: 0, row: 2 }, spec: { rows: [0], cols: [], values: [{ field: 3, fn: "sum" }] } };
  eq(readTable(wb, def.src)[9], ["South", "Ed", "Pens", 6, 1], "formula cell read as its value");
  let w = writePivot(wb, out, def); ok(w.ok, `create: ${w.why}`); wb.recalculate();
  eq(def.name, "PivotTable1", "name"); eq(w.out, { c0: 0, r0: 2, c1: 1, r1: 7 }, "output range A3:B8");
  eq(out.get(0, 7)?.value, "Grand Total", "grand total label"); eq(out.get(1, 7)?.value, 51, "sum incl. the formula's 6"); ok(out.get(0, 7)?.style?.bold, "totals bold");
  eq(pivotAt(out, 1, 4)?.name, "PivotTable1", "pivotAt finds it");
  // source shrinks: a region disappears → output shrinks, the old last row is cleared
  s.setCell(0, 9, "East"); wb.recalculate(); ok(refreshPivots(wb).length === 0, "refresh");
  eq(out.get(0, 6)?.value, "Grand Total", "one row fewer"); eq(out.get(0, 7), undefined, "stale cell cleared");
  // would grow onto data → refused without force
  out.setCell(0, 7, "keep me"); s.setCell(0, 8, "Mars"); wb.recalculate();
  w = writePivot(wb, out, def); ok(!w.ok && /already data/.test(w.why!), `refused over data: ${w.why}`); eq(out.get(0, 7)?.value, "keep me", "user data untouched");
  // overlap the source → refused even with force
  const d2: PivotDef = { name: "P2", src: { sheet: "Sheet1", ref: "A1:E10" }, anchor: { col: 2, row: 3 }, spec: def.spec };
  w = writePivot(wb, s, d2, true); ok(!w.ok && /overlap its own source/.test(w.why!), "overlap refused");
  // save / reload keeps the definition; refresh still works after reload
  const back = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(wb))));
  const def2 = back.sheet("Pivot").pivots[0]; eq([def2.name, def2.src, def2.spec.values], [def.name, def.src, def.spec.values], "definition survives .fworkbook");
  back.sheet("Pivot").setCell(0, 7, ""); ok(refreshPivots(back).length === 0, "refresh after reload");
  eq(back.sheet("Pivot").get(0, 7)?.value, "Grand Total", "grows by the Mars row");
  // a broken source reports, not crashes
  back.sheets.delete("Sheet1"); const bad = refreshPivots(back); eq(bad.map((b) => b.name), ["PivotTable1"], "missing source reported"); ok(/no longer exists/.test(bad[0].why), bad[0].why);
  // structural edits: a row inserted inside the source grows it; rows inserted above the pivot move it
  {
    const w2 = new Workbook(); const a = w2.sheet(); SALES.forEach((r, i) => r.forEach((v, j) => a.setCell(j, i, v === null ? "" : String(v)))); w2.recalculate();
    const host = w2.addSheet("P"); const d3: PivotDef = { name: "PivotTable1", src: { sheet: "Sheet1", ref: "A1:E9" }, anchor: { col: 0, row: 2 }, spec: { rows: [0], cols: [], values: [{ field: 3, fn: "sum" }] } };
    ok(writePivot(w2, host, d3).ok, "create d3");
    insertDelete(w2, "Sheet1", "row", 4, 2); eq(d3.src.ref, "A1:E11", "insert inside the source grows it");
    insertDelete(w2, "Sheet1", "row", 0, 1); eq(d3.src.ref, "A2:E12", "insert above the source moves it");
    insertDelete(w2, "Sheet1", "col", 1, -1); eq(d3.src.ref, "A2:D12", "a deleted column shrinks it");
    eq(d3.spec.values, [{ field: 2, fn: "sum" }], "Units moved from field 3 to field 2 with the deleted Rep column");
    insertDelete(w2, "Sheet1", "col", 0, 1); eq([d3.src.ref, d3.spec.rows, d3.spec.values[0].field], ["B2:E12", [0], 2], "a column inserted left of the source moves it, fields unchanged");
    insertDelete(w2, "Sheet1", "col", 2, 1); eq([d3.src.ref, d3.spec.rows, d3.spec.values[0].field], ["B2:F12", [0], 3], "a column inserted inside shifts later fields");
    a.setCell(2, 1, ""); w2.recalculate(); ok(/needs a heading/.test(refreshPivots(w2)[0]?.why ?? ""), "a blank heading inside the source is refused (Excel: field name not valid)");
    a.setCell(2, 1, "Note");
    insertDelete(w2, "Sheet1", "col", 1, -1); eq([d3.spec.rows, d3.spec.values[0].field], [[], 2], "deleting the Region column removes that row field");
    d3.spec = { ...d3.spec, rows: [1] };
    insertDelete(w2, "P", "row", 0, 3); eq([d3.anchor.row, d3.out?.r0, d3.out?.r1], [5, 5, 9], "pivot moved down with its cells");
    w2.recalculate(); const bad = refreshPivots(w2); eq(bad, [], "refresh after structure edits");
    eq(host.get(0, 5)?.value, "Product", "header at the moved place"); eq(host.get(1, 9)?.value, 45, "Sum of Units by Product, grand total (10+4+2+6+20+3)"); eq(host.get(0, 2), undefined, "nothing written at the old place");
  }
  deletePivot(out, def); eq([out.pivots.length, out.get(1, 6)?.value], [0, undefined], "delete clears cells and definition");
  eq(itemLabel(null), "(blank)", "blank label");
});

await test(".xlsx round trip of the definition (hidden sheet-scoped string names, ≤255 characters each): fresh export and lossless patch of a POI workbook with its own names; openpyxl opens both, sees the names hidden; reopened pivots refresh; deleting the pivot removes the names", COV, async () => {
  const mk = () => { const wb = new Workbook(); const s = wb.sheet(); SALES.forEach((r, i) => r.forEach((v, j) => s.setCell(j, i, v === null ? "" : String(v)))); wb.recalculate(); return wb; };
  const wb = mk(); const host = wb.addSheet("Pivot \"Q1\"");
  const def: PivotDef = { name: "PivotTable1", src: { sheet: "Sheet1", ref: "A1:E9" }, anchor: { col: 0, row: 2 }, spec: { rows: [0, 1], cols: [2], values: [{ field: 3, fn: "sum" }, { field: 4, fn: "average" }], filters: [{ field: 2, include: ["Pens", "Ink", 'say "hi"'] }], subtotals: true, grandRows: true, grandCols: false } };
  ok(writePivot(wb, host, def).ok, "create");
  const py = (f: string) => JSON.parse(execFileSync(PY, ["-c", `import json,sys,openpyxl
wb=openpyxl.load_workbook(sys.argv[1])
out=[]
for ws in wb.worksheets:
  for n,d in ws.defined_names.items(): out.append([ws.title,n,d.hidden,len(d.attr_text)])
print(json.dumps({"names":out,"sheets":wb.sheetnames}))`, f], { encoding: "utf8" }));
  const { mkdtempSync, writeFileSync: wf, readFileSync } = await import("node:fs"); const dir = mkdtempSync("/tmp/pv58-");
  const bytes = writeXlsxWorkbook(wb); wf(`${dir}/a.xlsx`, bytes);
  const o = py(`${dir}/a.xlsx`);
  ok(o.names.length >= 3 && o.names.every((n: [string, string, boolean, number]) => n[0] === 'Pivot "Q1"' && /^_FusionPivot1_\d+$/.test(n[1]) && n[2] === true && n[3] <= 257), `openpyxl names: ${JSON.stringify(o.names)}`);
  const back = readXlsxWorkbook(Buffer.from(bytes));
  const d2 = back.sheet('Pivot "Q1"').pivots[0];
  const srt = (o: object) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
  eq([d2.name, d2.src, srt(d2.spec), d2.out], [def.name, def.src, srt(def.spec), def.out], "definition read back from the export");
  ok(back.listNames().every((n) => !n.name.startsWith("_FusionPivot")), "not listed as user names");
  back.sheet("Sheet1").setCell(3, 1, "1000"); back.recalculate(); eq(refreshPivots(back), [], "refresh after reopening");
  // lossless patch of a POI workbook that has its own defined names
  const poi = readFileSync("/home/user/tools/corpus/xlsx/45430.xlsx");
  const pw = readXlsxWorkbook(poi); const names0 = pw.listNames().map((n) => n.name).sort();
  const src = [...pw.sheets.keys()][0]; const ps = pw.sheet(src);
  ps.setCell(20, 0, "K"); ps.setCell(21, 0, "V"); ps.setCell(20, 1, "a"); ps.setCell(21, 1, "2"); ps.setCell(20, 2, "a"); ps.setCell(21, 2, "3"); pw.recalculate();
  const ph = pw.addSheet("PivotOut");
  const pd: PivotDef = { name: "PivotTable1", src: { sheet: src, ref: "U1:V3" }, anchor: { col: 0, row: 2 }, spec: { rows: [0], cols: [], values: [{ field: 1, fn: "sum" }] } };
  ok(writePivot(pw, ph, pd).ok, "pivot in the POI workbook");
  const r = await patchXlsx(new Uint8Array(poi), pw); wf(`${dir}/b.xlsx`, r.bytes);
  const po = py(`${dir}/b.xlsx`); ok(po.names.some((n: [string, string]) => n[0] === "PivotOut" && n[1] === "_FusionPivot1_1"), `patched names: ${JSON.stringify(po.names)}`);
  const pb = readXlsxWorkbook(Buffer.from(r.bytes));
  eq(pb.listNames().map((n) => n.name).sort(), names0, "the workbook's own names are untouched");
  eq(pb.sheet("PivotOut").pivots.map((p) => [p.name, p.src.ref]), [["PivotTable1", "U1:V3"]], "definition read back from the patched file");
  eq(pb.sheet("PivotOut").get(1, 4)?.value, 5, "pivot values in the patched file");
  // delete → patch again → names gone
  deletePivot(pb.sheet("PivotOut"), pb.sheet("PivotOut").pivots[0]);
  const r2 = await patchXlsx(r.bytes, pb); wf(`${dir}/c.xlsx`, r2.bytes);
  eq(py(`${dir}/c.xlsx`).names.filter((n: [string, string]) => n[1].startsWith("_FusionPivot")), [], "names removed with the pivot");
  eq(pivotsFromNames([{ name: "_FusionPivot1_2", text: '"x"' }]), [], "a definition with a missing chunk is dropped, not misread");
});

finish();
