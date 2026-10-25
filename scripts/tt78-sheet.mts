/**
 * TT78 — Spreadsheet outlines (group / ungroup / collapse / levels / Subtotal / Auto Outline) and table calculated
 * columns + auto-expansion. Models: src/lib/formula/sheetoutline.ts, src/lib/formula/sheettablecalc.ts.
 *
 *  O1  corpus outline oracle: every xlsx in the POI corpus with outlineLevel — Fusion's reader sees the same row/column
 *      levels, collapsed flags, hidden flags and summary placement as openpyxl (independent reader).
 *  O2  corpus calculated-column oracle: for every table with <calculatedColumnFormula>, (a) Fusion's calc == openpyxl's
 *      text and (b) calc shifted to each body row == the formula Excel wrote into that cell (openpyxl's cell text) —
 *      i.e. the "relative to the first body row" model reproduces Excel's own fill.
 *  M1  outline semantics (Excel behaviour, hand-derived): nested collapse survives expanding the parent; level buttons;
 *      hide/show detail; summary above; filter-hidden rows never shown by expand; ungroup keeps hidden rows hidden.
 *  M2  Subtotal vs pandas: per-group SUM / COUNT / AVERAGE / MAX and the grand total, recomputed by pandas from the raw
 *      list, equal Fusion's evaluated =SUBTOTAL rows (nested SUBTOTALs are ignored by the grand total); outline 1-2-3.
 *  M3  calculated columns: F1 fill, F2 refill, E1 exception, F3 no-fill, X1 grow down, X2 grow right, S1 structural.
 *  M4  Auto Outline from summary formulas (nested totals → nested levels), rows and columns.
 *  R1  new-package writer: ECMA-376 XSD valid; openpyxl reads the same levels / hidden / collapsed / summary placement
 *      and calculated column formulas; Fusion rereads identically.
 *  R2  in-place patcher on corpus files: collapsing a group and changing a calc formula are written; untouched sheets
 *      and table parts stay byte-identical; openpyxl agrees.
 *  R3  UI JSON round trip (undo snapshots) keeps the outline and calc.
 *  N1–N18 negative shapes.
 * Needs: /home/user/tools/venv (openpyxl, pandas, lxml), /home/user/tools/xsd, /home/user/tools/corpus/xlsx.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook, type TableDef } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx, loadedBaseline } from "../src/lib/formula/xlsx-patch.ts";
import { openZip } from "../src/lib/office/zipkit.ts";
import { workbookFromJson, workbookToJson, type WorkbookJson } from "../src/lib/formula/workbook-json.ts";
import { insertDelete, stripFuturePrefixes } from "../src/lib/formula/sheetops.ts";
import { outlineGroups, collapseGroup, expandGroup, toggleGroup, showLevel, groupLines, ungroupLines, clearOutline, hideDetail, showDetail, autoOutline, subtotal, removeSubtotals, maxLevel } from "../src/lib/formula/sheetoutline.ts";
import { afterTypedEntry, calcInputAt, firstBody, lastBody } from "../src/lib/formula/sheettablecalc.ts";

const { test, finish } = makeHarness("tt78-sheet");
const ONLY = process.env.TT78_ONLY;
const want = (id: string) => !ONLY || ONLY.split(/[ ,]+/).includes(id);
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/xlsx";
const tmp = mkdtempSync(join(tmpdir(), "tt78s-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const J = (v: unknown) => JSON.stringify(v);
// register rows: FF-19 sheet, FF-21 SpreadsheetML, FF-64 outlines (new), FF-65 calculated columns (new)
const OUT = { "FF-19": "full", "FF-21": "full", "FF-64": "full" } as const;
const CALC = { "FF-19": "full", "FF-21": "full", "FF-65": "full" } as const;
const py = <T,>(script: string, files: string[]): Record<string, T> => {
  const out: Record<string, T> = {};
  for (let k = 0; k < files.length; k += 20) Object.assign(out, JSON.parse(execFileSync(PY, [script, ...files.slice(k, k + 20)], { encoding: "utf8", maxBuffer: 256 << 20 })));
  return out;
};
type OxSheet = { rows: Record<string, [number, boolean, boolean]>; cols: Record<string, [number, boolean, boolean]>; summaryBelow: boolean; summaryRight: boolean; tables: { name: string; ref: string; cols: { name: string; calc: string | null; array: boolean }[]; formulas: Record<string, Record<string, string | null>> }[] };
type OxFile = { sheets: Record<string, OxSheet> } | { error: string };
const ox = (files: string[]) => py<OxFile>("scripts/oracle/xlsx_outline.py", files);
const xsd = (files: string[]) => py<{ parts: Record<string, string[]> }>("scripts/oracle/ooxml_xsd.py", files);
const xsdErrors = (r: { parts: Record<string, string[]> } | undefined) => r ? Object.entries(r.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e[0]}`) : ["no XSD result"];
const filesWith = (needle: string, part: RegExp) => readdirSync(CORPUS).filter((f) => f.endsWith(".xlsx")).filter((f) => {
  try { const z = execFileSync("unzip", ["-Z1", join(CORPUS, f)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter((p) => part.test(p)); return z.some((p) => execFileSync("unzip", ["-p", join(CORPUS, f), p], { maxBuffer: 256 << 20 }).includes(needle)); } catch { return false; }
}).sort();
/** Fusion's sheet → the oracle's {line: [level, hidden, collapsed]} shape */
function fusionDims(wb: Workbook, name: string) {
  const s = wb.sheet(name); const rows: Record<string, [number, boolean, boolean]> = {}; const cols: Record<string, [number, boolean, boolean]> = {};
  for (const r of new Set([...s.rowLevels.keys(), ...s.hiddenRows.keys(), ...s.rowCollapsed])) rows[r] = [s.rowLevels.get(r) ?? 0, s.hiddenRows.has(r), s.rowCollapsed.has(r)];
  for (const c of new Set([...s.colLevels.keys(), ...s.hiddenCols, ...s.colCollapsed])) cols[c] = [s.colLevels.get(c) ?? 0, s.hiddenCols.has(c), s.colCollapsed.has(c)];
  return { rows, cols };
}
const norm = (m: Record<string, [number, boolean, boolean]>) => J(Object.entries(m).filter(([, v]) => v[0] || v[1] || v[2]).map(([k, v]) => [Number(k), ...v]).sort((a, b) => (a[0] as number) - (b[0] as number)));

/** rows 1..8 grouped: outer 1..7 (summary 8), A 1..3 (summary 4), B 5..6 (summary 7) */
function nested(): Workbook {
  const wb = new Workbook(); const s = wb.sheet("Sheet1");
  for (let r = 0; r <= 9; r++) s.setCell(0, r, String(r));
  groupLines(s, "row", 1, 7); groupLines(s, "row", 1, 3); groupLines(s, "row", 5, 6);
  return wb;
}
const hid = (wb: Workbook) => [...wb.sheet("Sheet1").hiddenRows.keys()].sort((a, b) => a - b).join(",");
const K = (wb: Workbook) => [...wb.sheet("Sheet1").rowCollapsed].sort((a, b) => a - b).join(",");

/* ================================================================== O1 */
if (want("O1")) await test("O1 corpus outline oracle: levels / collapsed / hidden / summary placement == openpyxl", OUT, () => {
  ok(existsSync(CORPUS), `${CORPUS} missing`);
  const files = filesWith("outlineLevel=", /^xl\/worksheets\/[^/]+\.xml$/);
  ok(files.length >= 20, `expected ≥20 corpus files with outlines, found ${files.length}`);
  const o = ox(files.map((f) => join(CORPUS, f))); const fails: string[] = []; const refused: string[] = []; let sheets = 0, withOutline = 0, oracleErr = 0;
  for (const f of files) {
    const want = o[join(CORPUS, f)]; if (!want || "error" in want) { oracleErr++; continue; }
    let wb: Workbook; try { wb = readXlsxWorkbook(readFileSync(join(CORPUS, f))); } catch (e) {
      // declared: hostile files Fusion refuses on purpose (limits enforced before any outline is read)
      if (/exceeds Excel's|too large|limit/i.test((e as Error).message)) { refused.push(f); continue; }
      fails.push(`${f}: Fusion read failed ${(e as Error).message}`); continue;
    }
    for (const [name, ws] of Object.entries(want.sheets)) {
      if (!wb.sheets.has(name)) { fails.push(`${f}/${name}: sheet missing`); continue; }
      sheets++; const got = fusionDims(wb, name); const s = wb.sheet(name);
      if (Object.values(ws.rows).some((v) => v[0]) || Object.values(ws.cols).some((v) => v[0])) withOutline++;
      if (norm(got.rows) !== norm(ws.rows)) fails.push(`${f}/${name} rows: fusion ${norm(got.rows).slice(0, 160)} vs openpyxl ${norm(ws.rows).slice(0, 160)}`);
      if (norm(got.cols) !== norm(ws.cols)) fails.push(`${f}/${name} cols: fusion ${norm(got.cols).slice(0, 160)} vs openpyxl ${norm(ws.cols).slice(0, 160)}`);
      if (s.summaryBelow !== ws.summaryBelow || s.summaryRight !== ws.summaryRight) fails.push(`${f}/${name} outlinePr`);
    }
  }
  ok(!fails.length, `${fails.length} disagreements:\n${fails.slice(0, 12).join("\n")}`);
  ok(withOutline >= 4, `only ${withOutline} sheets carry an outline`); // most corpus hits are outlineLevelRow="0"
  return `${files.length} files, ${sheets} sheets (${withOutline} with outline levels) agree with openpyxl; oracle could not open ${oracleErr}; Fusion refused (hostile limits) ${refused.join(", ") || "none"}`;
});

/* ================================================================== O3 */
if (want("O3")) await test("O3 openpyxl-WRITTEN outlines (independent writer) read identically; Fusion's patch is read back by openpyxl", OUT, async () => {
  const f = join(tmp, "o3.xlsx");
  execFileSync(PY, ["-c", `
import openpyxl, sys
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "A"
for r in range(1, 21): ws.cell(row=r, column=1, value=r)
ws.row_dimensions.group(2, 9, outline_level=1, hidden=False)
ws.row_dimensions.group(3, 5, outline_level=2, hidden=True)
ws.row_dimensions[6].collapsed = True
ws.column_dimensions.group("C", "F", outline_level=1, hidden=True)
ws.column_dimensions["G"].collapsed = True
b = wb.create_sheet("B"); b.sheet_properties.outlinePr.summaryBelow = False; b.sheet_properties.outlinePr.summaryRight = False
b.row_dimensions.group(4, 6, outline_level=3)
wb.save(sys.argv[1])`, f]);
  const o = ox([f])[f] as { sheets: Record<string, OxSheet> }; const bytes = new Uint8Array(readFileSync(f)); const wb = readXlsxWorkbook(Buffer.from(bytes));
  for (const n of ["A", "B"]) {
    const g = fusionDims(wb, n); ok(norm(g.rows) === norm(o.sheets[n].rows) && norm(g.cols) === norm(o.sheets[n].cols), `${n}: ${norm(g.rows)} ${norm(g.cols)} vs ${norm(o.sheets[n].rows)} ${norm(o.sheets[n].cols)}`);
    ok(wb.sheet(n).summaryBelow === o.sheets[n].summaryBelow && wb.sheet(n).summaryRight === o.sheets[n].summaryRight, n + " outlinePr");
  }
  const A = wb.sheet("A"); ok(outlineGroups(A, "row").some((x) => x.level === 2 && x.start === 2 && x.end === 4 && x.summary === 5 && x.collapsed), "collapsed level-2 group recognised");
  expandGroup(A, "row", 2, 5); expandGroup(A, "col", 1, 6); ungroupLines(wb.sheet("B"), "row", 3, 5);
  const out = (await patchXlsx(bytes, wb, {}, loadedBaseline(bytes))).bytes; const f2 = join(tmp, "o3b.xlsx"); writeFileSync(f2, out);
  const o2 = ox([f2])[f2] as { sheets: Record<string, OxSheet> };
  for (const n of ["A", "B"]) { const g = fusionDims(wb, n); ok(norm(g.rows) === norm(o2.sheets[n].rows) && norm(g.cols) === norm(o2.sheets[n].cols), `patched ${n}: ${norm(o2.sheets[n].rows)} ${norm(o2.sheets[n].cols)} vs ${norm(g.rows)} ${norm(g.cols)}`); }
  ok(o2.sheets.B.summaryBelow === false && o2.sheets.B.summaryRight === false, "outlinePr kept");
  ok(!xsdErrors(xsd([f2])[f2]).length, "XSD " + xsdErrors(xsd([f2])[f2]).join(";"));
  return "openpyxl writer → Fusion reader agree; Fusion patcher → openpyxl reader agree (expand, ungroup, summary placement)";
});

/* ================================================================== O2 */
if (want("O2")) await test("O2 corpus calculated columns: calc == openpyxl, and calc shifted per body row == Excel's cell formulas", CALC, () => {
  const files = filesWith("calculatedColumnFormula", /^xl\/tables\/[^/]+\.xml$/);
  ok(files.length >= 6, `expected ≥6 corpus files with calculated columns, found ${files.length}`);
  const o = ox(files.map((f) => join(CORPUS, f))); const fails: string[] = []; let cols = 0, cells = 0, exceptions = 0;
  const sq = (x: string) => stripFuturePrefixes(x.replace(/^=/, "")).replace(/\s+/g, "");
  for (const f of files) {
    const want = o[join(CORPUS, f)]; if (!want || "error" in want) { fails.push(`${f}: oracle ${want && "error" in want ? want.error : "missing"}`); continue; }
    const wb = readXlsxWorkbook(readFileSync(join(CORPUS, f)));
    for (const [sheetName, ws] of Object.entries(want.sheets)) for (const ot of ws.tables) {
      const t = wb.tables.get(ot.name.toUpperCase()); if (!t) { fails.push(`${f}: table ${ot.name} not read`); continue; }
      ot.cols.forEach((oc, i) => {
        if (!oc.calc || oc.array) return; cols++;
        const mine = t.calc?.[oc.name.toLowerCase()];
        if (!mine || sq(mine) !== sq(oc.calc)) { fails.push(`${f}/${ot.name}/${oc.name}: calc ${mine} vs openpyxl ${oc.calc}`); return; }
        for (const [r, cellF] of Object.entries(ot.formulas[i] ?? {})) {
          const exp = calcInputAt(t, t.c0 + i, Number(r));
          if (typeof cellF !== "string" || !cellF.startsWith("=")) { exceptions++; continue; } // a constant exception Excel kept
          cells++;
          if (!exp || sq(exp) !== sq(cellF)) fails.push(`${f}/${sheetName}/${ot.name}/${oc.name} row ${Number(r) + 1}: model ${exp} vs Excel ${cellF}`);
        }
      });
    }
  }
  ok(!fails.length, `${fails.length} disagreements:\n${fails.slice(0, 12).join("\n")}`);
  ok(cols >= 8 && cells >= 40, `too little evidence: ${cols} columns, ${cells} cells`);
  return `${files.length} files, ${cols} calculated columns, ${cells} body cells reproduce Excel's fill exactly (${exceptions} constant exceptions)`;
});

/* ================================================================== M1 */
if (want("M1")) await test("M1 outline semantics: nested collapse, level buttons, detail, summary above, filter rows, ungroup", OUT, () => {
  const wb = nested(); const s = wb.sheet("Sheet1");
  ok(J(outlineGroups(s, "row").map((g) => [g.level, g.start, g.end, g.summary])) === J([[1, 1, 7, 8], [2, 1, 3, 4], [2, 5, 6, 7]]), "groups " + J(outlineGroups(s, "row")));
  ok(maxLevel(s, "row") === 2, "max level");
  collapseGroup(s, "row", 2, 4); ok(hid(wb) === "1,2,3" && K(wb) === "4", "collapse A");
  collapseGroup(s, "row", 1, 8); ok(hid(wb) === "1,2,3,4,5,6,7" && K(wb) === "4,8", "collapse outer");
  expandGroup(s, "row", 1, 8); ok(hid(wb) === "1,2,3" && K(wb) === "4", `expand outer keeps nested A collapsed: ${hid(wb)} K=${K(wb)}`);
  ok(toggleGroup(s, "row", 2, 4) === "expanded" && hid(wb) === "", "toggle A open");
  showLevel(s, "row", 1); ok(hid(wb) === "1,2,3,4,5,6,7" && K(wb) === "4,7,8", `level 1: ${hid(wb)} K=${K(wb)}`);
  showLevel(s, "row", 2); ok(hid(wb) === "1,2,3,5,6" && K(wb) === "4,7", `level 2: ${hid(wb)} K=${K(wb)}`);
  showLevel(s, "row", 3); ok(hid(wb) === "" && K(wb) === "", "level 3 shows all");
  ok(hideDetail(s, "row", 2).ok && hid(wb) === "1,2,3", "hide detail at row 3 collapses the deepest group");
  ok(showDetail(s, "row", 4).ok && hid(wb) === "", "show detail on the summary row");
  // filter-hidden rows stay hidden through expand / level buttons
  s.hiddenRows.set(2, "filter"); showLevel(s, "row", 1); showLevel(s, "row", 3); ok(s.hiddenRows.get(2) === "filter", "filter row shown by an outline");
  s.hiddenRows.delete(2);
  // ungroup while collapsed: rows stay hidden; stale flags dropped
  collapseGroup(s, "row", 1, 8); ok(ungroupLines(s, "row", 1, 7).ok, "ungroup");
  ok(hid(wb) === "1,2,3,4,5,6,7", "ungroup keeps hidden rows hidden (Microsoft)");
  ok(J(outlineGroups(s, "row").map((g) => [g.level, g.start, g.end])) === J([[1, 1, 3], [1, 5, 6]]), "levels after ungroup");
  ok(!s.rowCollapsed.has(8), "stale collapsed flag on old summary row dropped");
  // summary above: summary line is start-1
  const w2 = new Workbook(); const s2 = w2.sheet("Sheet1"); s2.summaryBelow = false; groupLines(s2, "row", 3, 5);
  ok(outlineGroups(s2, "row")[0].summary === 2, "summary above");
  collapseGroup(s2, "row", 1, 2); ok([...s2.rowCollapsed].join() === "2" && [3, 4, 5].every((r) => s2.hiddenRows.has(r)), "collapse with summary above");
  // columns
  groupLines(s2, "col", 2, 4); collapseGroup(s2, "col", 1, 5); ok([2, 3, 4].every((c) => s2.hiddenCols.has(c)) && s2.colCollapsed.has(5), "column collapse");
  expandGroup(s2, "col", 1, 5); ok(!s2.hiddenCols.size && !s2.colCollapsed.size, "column expand");
  ok(clearOutline(s2).ok && !s2.rowLevels.size && !s2.colLevels.size, "clear");
  return "nested / levels / detail / summary-above / filter / ungroup / columns hold";
});

/* ================================================================== M2 */
if (want("M2")) await test("M2 Subtotal == pandas groupby (Sum / Count / Average / Max) + grand total + 1-2-3 outline + Remove All", OUT, () => {
  const data: [string, string, number, number][] = [["East", "a", 10, 1], ["East", "b", 20.5, 2], ["East", "c", -3, 3], ["North", "d", 7, 4], ["North", "e", 8, 5], ["West", "f", 1, 6], ["West", "g", 2, 7], ["West", "h", 3, 8], ["West", "i", 4.25, 9], ["east", "j", 100, 10]];
  const csv = join(tmp, "m2.csv"); writeFileSync(csv, "Region,Item,Sales,Units\n" + data.map((r) => r.join(",")).join("\n"));
  // pandas: groups of CONSECUTIVE equal keys (Excel compares case-insensitively: "east" after West is a new group)
  const pyOut = JSON.parse(execFileSync(PY, ["-c", `
import pandas as pd, json, sys
df = pd.read_csv(sys.argv[1]); k = df.Region.str.lower(); run = (k != k.shift()).cumsum()
g = df.groupby(run)
out = {f: {"groups": [[str(df.Region[ix[0]]), float(getattr(g.get_group(n).Sales, m)()), float(getattr(g.get_group(n).Units, m)())] for n, ix in g.groups.items()], "grand": [float(getattr(df.Sales, m)()), float(getattr(df.Units, m)())]} for f, m in [("Sum","sum"),("Count","count"),("Average","mean"),("Max","max")]}
print(json.dumps(out))`, csv], { encoding: "utf8" }));
  const fails: string[] = [];
  for (const fn of ["Sum", "Count", "Average", "Max"] as const) {
    const wb = new Workbook(); const s = wb.sheet("Sheet1"); ["Region", "Item", "Sales", "Units"].forEach((h, c) => s.setCell(c, 0, h));
    data.forEach((r, i) => r.forEach((v, c) => s.setCell(c, i + 1, String(v))));
    const res = subtotal(wb, "Sheet1", { c0: 0, r0: 0, c1: 3, r1: data.length, groupCol: 0, fn, totalCols: [2, 3] }); wb.recalculate();
    if (!res.ok) { fails.push(`${fn}: ${res.error}`); continue; }
    const exp = pyOut[fn] as { groups: [string, number, number][]; grand: [number, number] };
    const label = fn === "Sum" ? "Total" : fn;
    const totals: [string, number, number][] = []; let grand: [number, number] | null = null;
    for (let r = 1; r <= res.r1!; r++) {
      const lab = String(s.get(0, r)?.value ?? "");
      if (lab === `Grand ${label}`) grand = [Number(s.get(2, r)?.value), Number(s.get(3, r)?.value)];
      else if (lab.endsWith(` ${label}`)) totals.push([lab.slice(0, -label.length - 1), Number(s.get(2, r)?.value), Number(s.get(3, r)?.value)]);
    }
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    if (totals.length !== exp.groups.length || totals.some((t, i) => t[0] !== exp.groups[i][0] || !close(t[1], exp.groups[i][1]) || !close(t[2], exp.groups[i][2]))) fails.push(`${fn} groups: ${J(totals)} vs pandas ${J(exp.groups)}`);
    if (!grand || !close(grand[0], exp.grand[0]) || !close(grand[1], exp.grand[1])) fails.push(`${fn} grand: ${J(grand)} vs pandas ${J(exp.grand)}`);
    if (fn === "Sum") {
      ok(/^=SUBTOTAL\(9,C2:C4\)$/i.test(s.get(2, 4)?.input ?? ""), "East subtotal formula " + s.get(2, 4)?.input);
      ok(s.get(0, 4)?.style?.bold === true, "subtotal label bold");
      ok(maxLevel(s, "row") === 2 && s.rowLevels.get(1) === 2 && s.rowLevels.get(4) === 1 && !s.rowLevels.has(res.r1!), "1-2-3 outline levels");
      showLevel(s, "row", 2); const vis = []; for (let r = 1; r <= res.r1!; r++) if (!s.hiddenRows.has(r)) vis.push(String(s.get(0, r)?.value));
      ok(J(vis) === J(["East Total", "North Total", "West Total", "east Total", "Grand Total"]), "level 2 shows only totals: " + J(vis));
      showLevel(s, "row", 3);
      const rm = removeSubtotals(wb, "Sheet1", { c0: 0, r0: 0, c1: 3, r1: res.r1! }); wb.recalculate();
      ok(rm.removed === 5 && rm.r1 === data.length && !s.rowLevels.size, `remove all: ${J(rm)}`);
      ok(data.every((r, i) => String(s.get(0, i + 1)?.value) === r[0] && Number(s.get(2, i + 1)?.value) === r[2]), "data intact after Remove All");
    }
  }
  ok(!fails.length, fails.join("\n"));
  return "4 functions × (4 groups + grand total) equal pandas; 1-2-3 outline; Remove All restores the list";
});

/* ================================================================== M3 */
function calcBook(totals = false): { wb: Workbook; t: TableDef } {
  const wb = new Workbook(); const s = wb.sheet("Sheet1");
  ["Price", "Qty", "Total"].forEach((h, c) => s.setCell(c, 0, h));
  [[2, 3], [4, 5], [6, 7]].forEach(([p, q], i) => { s.setCell(0, i + 1, String(p)); s.setCell(1, i + 1, String(q)); });
  const t: TableDef = { name: "Tab", sheet: "Sheet1", c0: 0, r0: 0, c1: 2, r1: totals ? 4 : 3, headerRows: 1, totalsRows: totals ? 1 : 0, columns: ["Price", "Qty", "Total"] };
  wb.tables.set("TAB", t); wb.recalculate(); return { wb, t };
}
const type = (wb: Workbook, c: number, r: number, input: string) => { wb.sheet("Sheet1").setCell(c, r, input); const o = afterTypedEntry(wb, "Sheet1", c, r, input); wb.recalculate(); return o; };
const inp = (wb: Workbook, c: number, r: number) => wb.sheet("Sheet1").get(c, r)?.input ?? "";
const consistent = (wb: Workbook, t: TableDef, c: number) => { for (let r = firstBody(t); r <= lastBody(t); r++) if (inp(wb, c, r) !== calcInputAt(t, c, r)) return `row ${r + 1}: ${inp(wb, c, r)} vs ${calcInputAt(t, c, r)}`; return ""; };
if (want("M3")) await test("M3 calculated columns: F1 fill, F2 refill, E1 exception, F3 no fill, X1/X2 grow, S1 structure", CALC, () => {
  const { wb, t } = calcBook(); const s = wb.sheet("Sheet1");
  let o = type(wb, 2, 2, "=A3*B3"); // typed in the MIDDLE row
  ok(o.changed && t.calc?.total === "A2*B2", "F1 calc anchored at first body row: " + J(t.calc));
  ok(inp(wb, 2, 1) === "=A2*B2" && inp(wb, 2, 3) === "=A4*B4" && s.get(2, 3)?.value === 42, "F1 filled");
  o = type(wb, 2, 1, "=A2*B2*2"); ok(t.calc?.total === "A2*B2*2" && inp(wb, 2, 3) === "=A4*B4*2", "F2 refill");
  o = type(wb, 2, 3, "5"); ok(t.calc?.total === "A2*B2*2" && /exception/.test(o.note ?? "") && inp(wb, 2, 1) === "=A2*B2*2", "E1 exception keeps calc");
  o = type(wb, 2, 2, "=A3+B3"); ok(inp(wb, 2, 1) === "=A2*B2*2" && inp(wb, 2, 3) === "5" && /not filled/.test(o.note ?? ""), "F3 no fill over data");
  type(wb, 2, 2, "=A3*B3*2"); type(wb, 2, 3, "=A4*B4*2"); ok(!consistent(wb, t, 2), "repaired consistent");
  o = type(wb, 0, 4, "8"); ok(t.r1 === 4 && inp(wb, 2, 4) === "=A5*B5*2", "X1 grew + filled: " + J(t) + inp(wb, 2, 4));
  o = type(wb, 3, 0, "Tax"); ok(t.c1 === 3 && t.columns[3] === "Tax", "X2 header grow");
  o = type(wb, 4, 2, "=C3*0.1"); ok(t.c1 === 4 && t.columns[4] === "Column1" && inp(wb, 4, 0) === "Column1" && inp(wb, 4, 1) === "=C2*0.1" && inp(wb, 4, 4) === "=C5*0.1", "X2 body grow + F1: " + J(t.columns));
  // S1: insert inside body (filled), insert above table (re-anchored), delete first body row (re-anchored)
  insertDelete(wb, "Sheet1", "row", 2, 1); ok(inp(wb, 2, 2) === "=A3*B3*2" && !consistent(wb, t, 2) && !consistent(wb, t, 4), "S1 inserted body row filled: " + consistent(wb, t, 2));
  insertDelete(wb, "Sheet1", "row", 0, 2); ok(firstBody(t) === 3 && t.calc?.total === "A4*B4*2" && !consistent(wb, t, 2), "S1 above: " + J(t.calc));
  insertDelete(wb, "Sheet1", "row", 3, -1); ok(firstBody(t) === 3 && t.calc?.total === "A4*B4*2" && !consistent(wb, t, 2) && !consistent(wb, t, 4), "S1 delete first body row: " + J(t.calc) + consistent(wb, t, 2));
  insertDelete(wb, "Sheet1", "col", 0, 1); ok(t.calc?.total === "B4*C4*2" && !consistent(wb, t, 3), "S1 column insert left: " + J(t.calc));
  insertDelete(wb, "Sheet1", "col", 4, -1); ok(!t.calc?.tax && t.calc?.total, "S1 deleted column drops its calc only");
  // structured references survive unchanged
  const b = calcBook(); type(b.wb, 2, 1, "=[@Price]*2"); ok(b.t.calc?.total === "[@Price]*2" && inp(b.wb, 2, 3) === "=[@Price]*2" && b.wb.sheet("Sheet1").get(2, 3)?.value === 12, "structured refs");
  // clearing the last body cell drops calc
  const c = calcBook(); type(c.wb, 2, 1, "=A2"); for (const r of [2, 3]) c.wb.sheet("Sheet1").setCell(2, r, ""); type(c.wb, 2, 1, ""); ok(!c.t.calc, "E1 clearing the column drops calc");
  return "F1 F2 E1 F3 X1 X2 S1 (insert inside / above / delete first row / columns) + structured refs";
});

/* ================================================================== M4 */
if (want("M4")) await test("M4 Auto Outline: nested summary formulas → nested levels (rows and columns)", OUT, () => {
  const wb = new Workbook(); const s = wb.sheet("Sheet1");
  // rows 1-2 → total row 3; rows 4-5 → total row 6; grand total row 7 = SUM(B4,B7)? use SUBTOTAL over 1..6
  ["1", "2", "=SUM(B2:B3)", "4", "5", "=SUM(B5:B6)", "=SUBTOTAL(9,B2:B7)"].forEach((v, i) => s.setCell(1, i + 1, v));
  const r = autoOutline(s, "row"); ok(r.ok, r.ok ? "" : r.error);
  ok(J([1, 2, 3, 4, 5, 6, 7].map((i) => s.rowLevels.get(i) ?? 0)) === J([2, 2, 1, 2, 2, 1, 0]), "levels " + J([...s.rowLevels]));
  // columns: C..D → E
  const w2 = new Workbook(); const s2 = w2.sheet("Sheet1"); s2.setCell(2, 0, "1"); s2.setCell(3, 0, "2"); s2.setCell(4, 0, "=SUM(C1:D1)");
  ok(autoOutline(s2, "col").ok && s2.colLevels.get(2) === 1 && s2.colLevels.get(3) === 1 && !s2.colLevels.has(4), "column auto outline");
  return "rows 2-level nesting + columns";
});

/* ================================================================== R1 */
if (want("R1")) await test("R1 new-package writer: XSD valid; openpyxl sees levels / hidden / collapsed / summary / calc; Fusion rereads", { ...OUT, ...CALC }, () => {
  const wb = nested(); const s = wb.sheet("Sheet1"); collapseGroup(s, "row", 2, 4); s.summaryRight = false;
  groupLines(s, "col", 3, 5); groupLines(s, "col", 3, 4); collapseGroup(s, "col", 2, 2);
  const w2 = calcBook().wb; const t2 = w2.tables.get("TAB")!; type(w2, 2, 1, "=A2*B2&\"<&>\""); // XML-special characters
  const tb = wb.addSheet("Tbl"); for (const [k, cell] of w2.sheet("Sheet1").grid) { const [c, r] = k.split(",").map(Number); tb.setCell(c, r, cell.input); }
  wb.tables.set("TAB", { ...t2, sheet: "Tbl" }); wb.recalculate();
  const f = join(tmp, "r1.xlsx"); writeFileSync(f, writeXlsxWorkbook(wb, "r1"));
  const e = xsdErrors(xsd([f])[f]); ok(!e.length, "XSD: " + e.join("; "));
  const o = ox([f])[f]; ok(o && !("error" in o), "openpyxl: " + J(o));
  const ws = (o as { sheets: Record<string, OxSheet> }).sheets;
  const mine = fusionDims(wb, "Sheet1");
  ok(norm(ws.Sheet1.rows) === norm(mine.rows), `rows ${norm(ws.Sheet1.rows)} vs ${norm(mine.rows)}`);
  ok(norm(ws.Sheet1.cols) === norm(mine.cols), `cols ${norm(ws.Sheet1.cols)} vs ${norm(mine.cols)}`);
  ok(ws.Sheet1.summaryBelow === true && ws.Sheet1.summaryRight === false, "outlinePr");
  ok(ws.Tbl.tables[0].cols[2].calc === "A2*B2&\"<&>\"", "openpyxl calc " + J(ws.Tbl.tables[0].cols));
  const back = readXlsxWorkbook(readFileSync(f)); const bd = fusionDims(back, "Sheet1");
  ok(norm(bd.rows) === norm(mine.rows) && norm(bd.cols) === norm(mine.cols) && back.sheet("Sheet1").summaryRight === false, "Fusion reread outline");
  ok(back.tables.get("TAB")?.calc?.total === "A2*B2&\"<&>\"", "Fusion reread calc");
  return "XSD + openpyxl + reread agree (rows, cols, outlinePr, escaped calc)";
});

/* ================================================================== R2 */
if (want("R2")) await test("R2 patcher on corpus files: outline + calc edits written, untouched parts byte-identical", { ...OUT, ...CALC }, async () => {
  // a) 55640.xlsx: rows 1-4 levels 1/2/3/3 hidden, row 5 collapsed → expand everything via the level buttons
  const p1 = join(CORPUS, "55640.xlsx"); const bytes = new Uint8Array(readFileSync(p1)); const wb = readXlsxWorkbook(Buffer.from(bytes)); const sn = [...wb.sheets.keys()][0]; const s = wb.sheet(sn);
  const same = (await patchXlsx(bytes, readXlsxWorkbook(Buffer.from(bytes)), {}, loadedBaseline(bytes))).bytes;
  const zA = openZip(bytes), zB = openZip(same);
  for (const part of zA.entries.map((e) => e.name).filter((n: string) => n.startsWith("xl/worksheets/"))) ok((await zA.readText(part)) === (await zB.readText(part)), `untouched ${part} changed`);
  showLevel(s, "row", maxLevel(s, "row") + 1);
  const out = (await patchXlsx(bytes, wb, {}, loadedBaseline(bytes))).bytes; const f = join(tmp, "r2a.xlsx"); writeFileSync(f, out);
  const o = ox([f])[f] as { sheets: Record<string, OxSheet> }; const rows = o.sheets[sn].rows;
  ok(Object.values(rows).every((v) => !v[1] && !v[2]) && Object.values(rows).filter((v) => v[0]).length === 4, "expanded on disk: " + J(rows));
  ok(!xsdErrors(xsd([f])[f]).length, "XSD r2a " + xsdErrors(xsd([f])[f]).join(";"));
  // b) ExcelTables.xlsx: AgeGroup = INT(H2/10) → retype as INT(H2/5) in a body row → refilled, written, other tables verbatim
  const p2 = join(CORPUS, "ExcelTables.xlsx"); const b2 = new Uint8Array(readFileSync(p2)); const w2 = readXlsxWorkbook(Buffer.from(b2));
  const t = [...w2.tables.values()].find((x) => x.calc?.agegroup); ok(t, "AgeGroup table"); const col = t!.c0 + t!.columns.findIndex((c) => c.toLowerCase() === "agegroup");
  w2.sheet(t!.sheet).setCell(col, firstBody(t!) + 1, "=INT(H3/5)"); const res = afterTypedEntry(w2, t!.sheet, col, firstBody(t!) + 1, "=INT(H3/5)"); w2.recalculate();
  ok(res.changed && t!.calc?.agegroup === "INT(H2/5)", "refill " + J(t!.calc));
  const out2 = (await patchXlsx(b2, w2, {}, loadedBaseline(b2))).bytes; const f2 = join(tmp, "r2b.xlsx"); writeFileSync(f2, out2);
  const o2 = ox([f2])[f2] as { sheets: Record<string, OxSheet> }; const ot = Object.values(o2.sheets).flatMap((x) => x.tables).find((x) => x.name === t!.name)!;
  ok(ot.cols.find((c) => c.name.toLowerCase() === "agegroup")?.calc === "INT(H2/5)", "openpyxl calc after patch " + J(ot.cols));
  ok(Object.values(ot.formulas[String(col - t!.c0)] ?? {}).every((v, i) => v === `=INT(H${firstBody(t!) + 1 + i}/5)`), "cells refilled on disk " + J(ot.formulas));
  ok(!xsdErrors(xsd([f2])[f2]).length, "XSD r2b " + xsdErrors(xsd([f2])[f2]).join(";"));
  return "55640 expand written; ExcelTables calc refill written; untouched sheets identical";
});

/* ================================================================== R3 */
if (want("R3")) await test("R3 JSON round trip (undo snapshots) keeps outline and calc", { ...OUT, ...CALC }, () => {
  const wb = nested(); const s = wb.sheet("Sheet1"); collapseGroup(s, "row", 2, 4); s.summaryBelow = false; groupLines(s, "col", 1, 2);
  const { wb: w2 } = calcBook(); type(w2, 2, 1, "=A2*B2"); const t = w2.tables.get("TAB")!; wb.tables.set("TAB", { ...t, sheet: "Sheet1" });
  const j = JSON.parse(JSON.stringify(workbookToJson(wb))) as WorkbookJson; const back = workbookFromJson(j); const b = back.sheet("Sheet1");
  ok(J([...b.rowLevels].sort()) === J([...s.rowLevels].sort()) && J([...b.colLevels].sort()) === J([...s.colLevels].sort()), "levels");
  ok([...b.rowCollapsed].join() === "4" && b.summaryBelow === false && b.summaryRight === true, "flags / placement");
  ok(back.tables.get("TAB")?.calc?.total === "A2*B2", "calc");
  // the copy is deep: mutating the snapshot's source does not change the restored workbook
  t.calc!.total = "X"; ok(back.tables.get("TAB")?.calc?.total === "A2*B2", "deep copy");
  return "outline + calc survive JSON";
});

/* ================================================================== N */
if (want("N")) await test("N1-N18 negative shapes", { ...OUT, ...CALC }, async () => {
  const out: string[] = []; const fails: string[] = [];
  const t = async (id: string, fn: () => unknown) => { try { await fn(); out.push(`${id} ok`); } catch (e) { fails.push(`${id}: ${(e as Error).message}`); } };
  const xlsxWith = async (sheetXml: string, tableXml?: string) => {
    const wb = new Workbook(); wb.sheet("Sheet1").setCell(0, 0, "x"); if (tableXml) { const s = wb.sheet("Sheet1"); ["A", "B"].forEach((h, c) => s.setCell(c, 0, h)); s.setCell(0, 1, "1"); s.setCell(1, 1, "2"); wb.tables.set("T", { name: "T", sheet: "Sheet1", c0: 0, r0: 0, c1: 1, r1: 1, headerRows: 1, totalsRows: 0, columns: ["A", "B"] }); }
    const z = openZip(writeXlsxWorkbook(wb, "n")); const files: Record<string, Uint8Array> = {};
    for (const n of z.entries.map((e) => e.name)) files[n] = (await z.read(n))!;
    const ws = new TextDecoder().decode(files["xl/worksheets/sheet1.xml"]); files["xl/worksheets/sheet1.xml"] = new TextEncoder().encode(ws.replace(/<sheetData>[\s\S]*<\/sheetData>/, (sheetXml.match(/<sheetData>[\s\S]*<\/sheetData>|<sheetData\/>/)?.[0] ?? "<sheetData/>")).replace(/<cols>[\s\S]*?<\/cols>/, "").replace("<sheetData", (sheetXml.match(/<cols>[\s\S]*?<\/cols>/)?.[0] ?? "") + "<sheetData"));
    if (tableXml) { const tn = Object.keys(files).find((n) => /xl\/tables\/table\d+\.xml/.test(n))!; files[tn] = new TextEncoder().encode(tableXml); }
    const { writeZip } = await import("../src/lib/office/zipkit.ts");
    return readXlsxWorkbook(Buffer.from(await writeZip(Object.entries(files).map(([name, data]) => ({ name, data })))));
  };
  await t("N1 group past 7 levels refused", () => { const s = new Workbook().addSheet("S"); for (let i = 0; i < 7; i++) ok(groupLines(s, "row", 1, 2).ok, "level " + i); const r = groupLines(s, "row", 1, 2); ok(!r.ok && s.rowLevels.get(1) === 7, "8th"); });
  await t("N2 ungroup / show level / clear without an outline", () => { const s = new Workbook().addSheet("S"); ok(!ungroupLines(s, "row", 0, 3).ok && !showLevel(s, "row", 1).ok && !clearOutline(s).ok && !hideDetail(s, "row", 1).ok && !showDetail(s, "row", 1).ok, "errors"); });
  await t("N3 hostile outlineLevel / collapsed attribute values ignored", async () => {
    const wb = await xlsxWith(`<sheetData><row r="1" outlineLevel="99"/><row r="2" outlineLevel="-1"/><row r="3" outlineLevel="abc"/><row r="4" outlineLevel="1e0" collapsed="yes"/><row r="5" outlineLevel="2.5"/><row r="6" outlineLevel="7"/></sheetData>`);
    const s = wb.sheet("Sheet1"); ok(J([...s.rowLevels]) === J([[3, 1], [5, 7]]) && !s.rowCollapsed.size, J([...s.rowLevels]));
  });
  await t("N4 a <col> spanning 16384 columns with an outline level is bounded and fast", async () => {
    const t0 = performance.now(); const wb = await xlsxWith(`<cols><col min="1" max="16384" outlineLevel="1" collapsed="1"/><col min="20000" max="99999999" outlineLevel="2"/></cols><sheetData/>`);
    const s = wb.sheet("Sheet1"); ok(s.colLevels.size === 16384 && Math.max(...s.colLevels.keys()) === 16383 && performance.now() - t0 < 3000, `${s.colLevels.size} in ${performance.now() - t0}ms`);
  });
  await t("N5 untrusted JSON outline: bad levels / lines / types / huge lists filtered", () => {
    const j = { sheets: [{ name: "S", cells: [], outline: { rows: [[1, 8], [2, 0], [-1, 1], [3, "2"], [4, 3], "x", [1048576, 1]], cols: [[16384, 1], [5, 7]], rowCollapsed: [-5, 2, 1.5, "a"], colCollapsed: [16384, 3], summaryBelow: "no", summaryRight: false } }] } as unknown as WorkbookJson;
    const s = workbookFromJson(j).sheet("S"); ok(J([...s.rowLevels]) === J([[4, 3]]) && J([...s.colLevels]) === J([[5, 7]]) && J([...s.rowCollapsed]) === "[2]" && J([...s.colCollapsed]) === "[3]" && s.summaryBelow && !s.summaryRight, J([...s.rowLevels]));
  });
  await t("N6 untrusted JSON calc: unknown columns / '=' prefix / non-strings / oversize dropped", () => {
    const j = { sheets: [{ name: "S", cells: [] }], tables: [{ name: "T", sheet: "S", c0: 0, r0: 0, c1: 1, r1: 2, headerRows: 1, totalsRows: 0, columns: ["A", "B"], calc: { a: "B2*2", nope: "1", b: "=A2", __proto__: "x" } }] } as unknown as WorkbookJson;
    const tb = workbookFromJson(j).tables.get("T")!; ok(J(tb.calc) === J({ a: "B2*2" }), J(tb.calc));
    const j2 = { sheets: [{ name: "S", cells: [] }], tables: [{ name: "T", sheet: "S", c0: 0, r0: 0, c1: 1, r1: 2, headerRows: 1, totalsRows: 0, columns: ["A", "B"], calc: { a: "x".repeat(9000), b: 5 } }] } as unknown as WorkbookJson;
    ok(!workbookFromJson(j2).tables.get("T")!.calc, "oversize / number");
  });
  await t("N7 array calculated column formula is not modelled (no fill) and survives a patch verbatim", async () => {
    const tx = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:B2" totalsRowShown="0"><autoFilter ref="A1:B2"/><tableColumns count="2"><tableColumn id="1" name="A"/><tableColumn id="2" name="B"><calculatedColumnFormula array="1">A2:A2*2</calculatedColumnFormula></tableColumn></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`;
    const wb = await xlsxWith(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c><c r="B1" t="inlineStr"><is><t>B</t></is></c></row><row r="2"><c r="A2"><v>1</v></c></row></sheetData>`, tx);
    ok(!wb.tables.get("T")?.calc, "array calc not modelled");
  });
  await t("N8 expand never shows rows the AutoFilter hid", () => { const wb = nested(); const s = wb.sheet("Sheet1"); collapseGroup(s, "row", 1, 8); s.hiddenRows.set(5, "filter"); expandGroup(s, "row", 1, 8); ok(s.hiddenRows.get(5) === "filter", "filter row"); });
  await t("N9 Subtotal inside an Excel table refused (Excel refuses too)", () => { const { wb } = calcBook(); const r = subtotal(wb, "Sheet1", { c0: 0, r0: 0, c1: 2, r1: 3, groupCol: 0, fn: "Sum", totalCols: [1] }); ok(!r.ok && /table/.test(r.error), J(r)); });
  await t("N10 Subtotal argument errors leave the sheet unchanged", () => {
    const wb = new Workbook(); const s = wb.addSheet("S"); s.setCell(0, 0, "H"); s.setCell(0, 1, "a"); s.setCell(1, 0, "V"); s.setCell(1, 1, "1"); const before = J(workbookToJson(wb));
    ok(!subtotal(wb, "S", { c0: 0, r0: 0, c1: 1, r1: 1, groupCol: 5, fn: "Sum", totalCols: [1] }).ok, "group col outside");
    ok(!subtotal(wb, "S", { c0: 0, r0: 0, c1: 1, r1: 1, groupCol: 0, fn: "Sum", totalCols: [] }).ok, "no total columns");
    ok(!subtotal(wb, "S", { c0: 0, r0: 0, c1: 1, r1: 0, groupCol: 0, fn: "Sum", totalCols: [1] }).ok, "header only");
    ok(J(workbookToJson(wb)) === before, "unchanged");
  });
  await t("N11 no grow below a table with a totals row, or into another table", () => {
    const { wb, t } = calcBook(true); type(wb, 0, 5, "9"); ok(t.r1 === 4, "totals row blocks X1");
    const b = calcBook(); b.wb.tables.set("TB2", { name: "Tb2", sheet: "Sheet1", c0: 0, r0: 4, c1: 1, r1: 6, headerRows: 1, totalsRows: 0, columns: ["X", "Y"] }); type(b.wb, 0, 4, "X"); ok(b.t.r1 === 3, "other table blocks X1");
  });
  await t("N12 entries away from tables / empty entries change nothing", () => { const { wb, t } = calcBook(); const before = J(t); type(wb, 0, 6, "1"); type(wb, 6, 0, "x"); type(wb, 0, 4, ""); ok(J(t) === before, "no change"); });
  await t("N13 F3 leaves every other cell untouched", () => { const { wb, t } = calcBook(); type(wb, 2, 1, "x"); type(wb, 2, 2, "=A3"); ok(inp(wb, 2, 1) === "x" && inp(wb, 2, 3) === "" && !t.calc, "untouched"); });
  await t("N14 Auto Outline without summary formulas errors; non-adjacent / other-column refs ignored", () => {
    const s = new Workbook().addSheet("S"); ok(!autoOutline(s, "row").ok, "empty");
    s.setCell(0, 0, "1"); s.setCell(0, 1, "2"); s.setCell(0, 5, "=SUM(A1:A2)"); s.setCell(1, 3, "=SUM(A1:A2)"); s.setCell(2, 2, "=A1+A2"); ok(!autoOutline(s, "row").ok && !s.rowLevels.size, "nothing adjacent");
  });
  await t("N15 showLevel clamps out-of-range buttons", () => { const wb = nested(); const s = wb.sheet("Sheet1"); ok(showLevel(s, "row", 99).ok && hid(wb) === "", "99 → max+1"); ok(showLevel(s, "row", -3).ok && hid(wb) === "1,2,3,4,5,6,7", "-3 → 1"); });
  await t("N16 Remove All on a list without subtotals removes nothing", () => { const wb = new Workbook(); const s = wb.addSheet("S"); s.setCell(0, 0, "H"); s.setCell(0, 1, "a"); s.setCell(0, 2, "=SUM(1,2)"); const r = removeSubtotals(wb, "S", { c0: 0, r0: 0, c1: 0, r1: 2 }); ok(r.removed === 0 && s.get(0, 2)?.input === "=SUM(1,2)", J(r)); });
  await t("N17 deleting outlined rows drops their levels / flags; insert at a group edge does not extend it", () => {
    const wb = nested(); const s = wb.sheet("Sheet1"); collapseGroup(s, "row", 2, 4); insertDelete(wb, "Sheet1", "row", 1, -4);
    ok(!s.rowCollapsed.has(4) && !s.rowCollapsed.has(0) && J([...s.rowLevels].sort((a, b) => a[0] - b[0])) === J([[1, 2], [2, 2], [3, 1]]), "delete: " + J([...s.rowLevels]) + J([...s.rowCollapsed]));
    const w2 = new Workbook(); const s2 = w2.addSheet("S"); groupLines(s2, "row", 2, 3); insertDelete(w2, "S", "row", 2, 1); ok(!s2.rowLevels.has(2) && s2.rowLevels.get(3) === 1 && s2.rowLevels.get(4) === 1, "edge " + J([...s2.rowLevels]));
    insertDelete(w2, "S", "row", 4, 1); ok(s2.rowLevels.get(4) === 1 && s2.rowLevels.get(5) === 1, "inside joins " + J([...s2.rowLevels]));
  });
  await t("N18 a deleted body row does not orphan calc: delete EVERY body row but one, then type below", () => {
    const { wb, t } = calcBook(); type(wb, 2, 1, "=A2*B2"); insertDelete(wb, "Sheet1", "row", 1, -2); ok(lastBody(t) === 1 && t.calc?.total === "A2*B2" && inp(wb, 2, 1) === "=A2*B2", J(t));
    type(wb, 0, 2, "3"); ok(t.r1 === 2 && inp(wb, 2, 2) === "=A3*B3", "fill after shrink");
  });
  console.log("  " + out.join("\n  "));
  ok(!fails.length, fails.join("\n"));
  return `${out.length} negative shapes hold`;
});

finish();
