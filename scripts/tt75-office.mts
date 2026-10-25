/**
 * TT75 Spreadsheet class-A gates — Excel tables survive a NEW package (TT74 blocker) and structural edits.
 * Oracles independent of src/lib/formula: openpyxl (MIT) reading the written table parts / header cells / formula text;
 * the ECMA-376 transitional XSDs (lxml); and metamorphic invariants that follow from the definition of a table
 * (inserting an empty body row adds one row and changes no sum; deleting it again restores every probe).
 *
 *  T1  corpus → new package: every corpus table is written (openpyxl sees the same name / ref / header / totals / column
 *      names / filter), every structured-reference formula keeps its value after reopening (no #REF!), table parts are
 *      schema-valid, formulas are stored in file form (no "[@")
 *  T2  corpus structural edits (every table): insert a body row / column inside it, delete it again, delete the whole
 *      table, try to delete only its header — probes follow the invariants; new package AND in-place save carry the new
 *      geometry (openpyxl)
 *  T3  units: refusals (header row, two tables), totals row, last body row, removed column → #REF!, file form, strings
 *  T4  numeric header cells are written as text; header / column-name mismatch is reported
 *  T5  column names with control characters / "_xHHHH_" / XML specials round-trip (ST_Xstring)
 *  N1… negative shapes
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt75-office.mts
 *      TT75_ONLY="T1 T3" runs a subset.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook, type Scalar, type TableDef } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx, loadedBaseline } from "../src/lib/formula/xlsx-patch.ts";
import { workbookFromJson, workbookToJson, tableNameOk, type WorkbookJson } from "../src/lib/formula/workbook-json.ts";
import { insertDelete } from "../src/lib/formula/sheetops.ts";
import { sanitizeFilterColumnXml } from "../src/lib/formula/sheetfilter.ts";
import { adjustTablesForStructure, tableStructureConflict, TableEditError, rewriteStructuredRefs, structuredRefsToFileForm, xstring, unXstring, tableColumnNames, defaultColumnName } from "../src/lib/formula/sheettables.ts";

const { test, finish } = makeHarness("tt75-office");
const ONLY = process.env.TT75_ONLY;
const want = (id: string) => !ONLY || ONLY.split(/[ ,]+/).includes(id);
const PY = "/home/user/tools/venv/bin/python";
const XLSX = "/home/user/tools/corpus/xlsx";
const tmp = mkdtempSync(join(tmpdir(), "tt75o-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const SHEET = { "FF-19": "full", "FF-21": "full" } as const;
// TT75 register rows: FF-58 Excel tables, FF-59 the range memo
const TABLES = { ...SHEET, "FF-58": "full" } as const;
const MEMO = { ...SHEET, "FF-59": "full" } as const;
const J = (v: unknown) => JSON.stringify(v);
const colL = (c: number) => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const refOf = (t: { c0: number; r0: number; c1: number; r1: number }) => `${colL(t.c0)}${t.r0 + 1}:${colL(t.c1)}${t.r1 + 1}`;
const at = (a1: string) => { const m = /^([A-Z]+)(\d+)$/.exec(a1)!; let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return { col: c - 1, row: Number(m[2]) - 1 }; };
const val = (wb: Workbook, sheet: string, a1: string) => { const p = at(a1); return wb.valueAt(sheet, p.col, p.row); };
const put = (wb: Workbook, sheet: string, a1: string, input: string) => { const p = at(a1); wb.sheet(sheet).setCell(p.col, p.row, input); };
const inp = (wb: Workbook, sheet: string, a1: string) => { const p = at(a1); return wb.sheet(sheet).get(p.col, p.row)?.input; };
type OxTable = { sheet: string; name: string; ref: string; header: number; totals: number; columns: string[]; autoFilter: string | null; filter: Record<string, string[]>; id: number };
type OxFile = { tables: OxTable[]; formulas: Record<string, string>; headers: Record<string, [string, unknown]> } | { error: string };
const openpyxl = (files: string[]): Record<string, OxFile> => {
  const out: Record<string, OxFile> = {};
  for (let k = 0; k < files.length; k += 20) Object.assign(out, JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_tables.py", ...files.slice(k, k + 20)], { encoding: "utf8", maxBuffer: 256 << 20 })));
  return out;
};
const xsd = (files: string[]): Record<string, { parts: Record<string, string[]> }> => {
  const out: Record<string, { parts: Record<string, string[]> }> = {};
  for (let k = 0; k < files.length; k += 20) Object.assign(out, JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", ...files.slice(k, k + 20)], { encoding: "utf8", maxBuffer: 256 << 20 })));
  return out;
};
const clone = (wb: Workbook) => { const w = workbookFromJson(JSON.parse(J(workbookToJson(wb))) as WorkbookJson); w.recalculate(); return w; };
const same = (a: unknown, b: unknown) => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return J(a) === J(b);
};
const tdefKey = (t: TableDef) => J([t.name, t.sheet, t.c0, t.r0, t.c1, t.r1, t.headerRows, t.totalsRows, t.columns, t.filter ?? null]);

/** corpus workbooks with at least one table (read once) */
const corpus: { file: string; bytes: Buffer; wb: Workbook }[] = [];
if (want("T1") || want("T2")) {
  for (const f of readdirSync(XLSX).sort()) {
    let wb: Workbook; const bytes = readFileSync(join(XLSX, f));
    try { wb = readXlsxWorkbook(bytes); } catch { continue; }
    if (wb.tables.size) corpus.push({ file: f, bytes, wb });
  }
}
/** probe formulas for one table, placed on a separate sheet so row/column edits on the table's sheet do not move them */
const PROBES = ["ROWS({T}[#All])", "COLUMNS({T}[#All])", "COUNTA({T}[#Data])", "COUNT({T}[#Data])", "SUM({T}[#Data])", "COUNTA({T}[#Headers])", "ROWS({T}[#Data])"];
const PROBE_SHEET = "TT75probe";
function addProbes(wb: Workbook, t: TableDef): string[] {
  if (!wb.sheets.has(PROBE_SHEET)) wb.addSheet(PROBE_SHEET);
  const cells: string[] = [];
  PROBES.forEach((p, i) => { const a1 = `${colL(i)}${[...wb.tables.keys()].indexOf(t.name.toUpperCase()) + 1}`; put(wb, PROBE_SHEET, a1, `=${p.replace(/\{T\}/g, t.name)}`); cells.push(a1); });
  return cells;
}
/** does any formula in the table body read its own position (INDIRECT / OFFSET / ROW / COLUMN)? */
function tableReadsPosition(wb: Workbook, t: TableDef, sh: string): boolean {
  const s = wb.sheet(sh);
  for (let r = t.r0; r <= t.r1; r++) for (let c = t.c0; c <= t.c1; c++) { const i = s.get(c, r)?.input ?? ""; if (i.startsWith("=") && /\b(INDIRECT|OFFSET|ROW|COLUMN)\s*\(/i.test(i)) return true; }
  return false;
}
const probeVals = (wb: Workbook, cells: string[]) => { wb.recalculate(); return cells.map((c) => val(wb, PROBE_SHEET, c)); };

/* ================================================================== T1 corpus → new package */
if (want("T1")) await test("T1 corpus → new package: every table written (openpyxl agrees on name / ref / header / totals / columns / filter), structured formulas keep their values after reopening, table parts schema-valid, file-form formulas", TABLES, async () => {
  ok(corpus.length >= 29, `only ${corpus.length} corpus workbooks with tables`);
  const written: { file: string; path: string; wb: Workbook; probes: Map<string, { cells: string[]; vals: Scalar[] }>; formulas: Map<string, Scalar> }[] = [];
  let nTables = 0, nFormulas = 0;
  const bad: string[] = [];
  for (const c of corpus) {
    const wb = clone(c.wb);
    // the Spreadsheet UI holds workbooks as JSON: every table must survive that round trip first
    for (const t of c.wb.tables.values()) if (!wb.tables.has(t.name.toUpperCase())) bad.push(`${c.file}: table ${t.name} lost in the workbook JSON round trip`);
    const probes = new Map<string, { cells: string[]; vals: Scalar[] }>();
    for (const t of wb.tables.values()) { const cells = addProbes(wb, t); probes.set(t.name, { cells, vals: [] }); }
    wb.recalculate();
    for (const [n, p] of probes) p.vals = probeVals(wb, p.cells), void n;
    const formulas = new Map<string, Scalar>();
    for (const s of wb.sheets.values()) for (const [k, cell] of s.grid) if (cell.formula && cell.input.includes("[") && s.name !== PROBE_SHEET) { const [col, row] = k.split(",").map(Number); formulas.set(`${s.name}!${colL(col)}${row + 1}`, wb.valueAt(s.name, col, row)); }
    const bytes = writeXlsxWorkbook(wb, c.file);
    const path = join(tmp, `t1-${written.length}.xlsx`); writeFileSync(path, bytes);
    written.push({ file: c.file, path, wb, probes, formulas }); nTables += wb.tables.size; nFormulas += formulas.size;
  }
  // (a) our reader: same tables, same probe values, same structured-formula values
  for (const w of written) {
    const back = readXlsxWorkbook(readFileSync(w.path)); back.recalculate();
    for (const t of w.wb.tables.values()) {
      const b = back.tables.get(t.name.toUpperCase());
      if (!b) { bad.push(`${w.file}: table ${t.name} missing after reopen`); continue; }
      const want2 = { ...t, columns: tableColumnNames(t) };
      if (tdefKey(b) !== tdefKey(want2)) bad.push(`${w.file}: ${t.name} reopened as ${tdefKey(b)} want ${tdefKey(want2)}`);
      const p = w.probes.get(t.name)!; const now = p.cells.map((cc) => val(back, PROBE_SHEET, cc));
      if (!now.every((v, i) => same(v, p.vals[i]))) bad.push(`${w.file}: ${t.name} probes ${J(now)} want ${J(p.vals)}`);
    }
    for (const [k, v] of w.formulas) {
      const [sh, a1] = [k.slice(0, k.lastIndexOf("!")), k.slice(k.lastIndexOf("!") + 1)];
      const now = val(back, sh, a1);
      if (!same(now, v)) bad.push(`${w.file}: ${k} = ${J(now)} after reopen, was ${J(v)} (${inp(w.wb, sh, a1)})`);
    }
  }
  // (b) openpyxl: the written table parts as an independent reader sees them
  const ox = openpyxl(written.map((w) => w.path));
  let oxTables = 0;
  for (const w of written) {
    const o = ox[w.path];
    if (!o || "error" in o) { bad.push(`${w.file}: openpyxl ${o && "error" in o ? o.error : "no result"}`); continue; }
    const ids = new Set<number>();
    for (const t of w.wb.tables.values()) {
      const x = o.tables.find((q) => q.name === t.name);
      if (!x) { bad.push(`${w.file}: openpyxl does not see table ${t.name}`); continue; }
      oxTables++; ids.add(x.id);
      const expAf = t.headerRows ? refOf({ ...t, r1: Math.max(t.r0, t.r1 - t.totalsRows) }) : null;
      const expF = Object.fromEntries(Object.entries(t.filter?.cols ?? {}).map(([k, v]) => [k, v]));
      const got = { sheet: x.sheet, ref: x.ref, header: x.header, totals: x.totals, columns: x.columns, autoFilter: x.autoFilter, filter: x.filter };
      const exp = { sheet: t.sheet, ref: refOf(t), header: t.headerRows, totals: t.totalsRows, columns: tableColumnNames(t) /* openpyxl decodes ST_Xstring escapes */, autoFilter: expAf, filter: t.filter?.foreign ? got.filter : expF };
      if (J(got) !== J(exp)) bad.push(`${w.file}: openpyxl ${t.name} ${J(got)} want ${J(exp)}`);
    }
    if (ids.size !== o.tables.length) bad.push(`${w.file}: table ids not unique (${[...ids]})`);
    for (const [k, f] of Object.entries(o.formulas)) if (/\[@/.test(f.replace(/"[^"]*"/g, ""))) bad.push(`${w.file}: ${k} stored with "@" shorthand: ${f}`);
    for (const [k, [ty, v]] of Object.entries(o.headers)) if (ty !== "str" && !(ty === "NoneType" && v === null)) bad.push(`${w.file}: header ${k} stored as ${ty}`);
  }
  // (c) schema: every table part and every sheet that references one validates
  const xs = xsd(written.map((w) => w.path)); let tableParts = 0;
  for (const w of written) for (const [part, es] of Object.entries(xs[w.path]?.parts ?? {})) {
    if (/xl\/tables\//.test(part)) tableParts++;
    if (es.length) bad.push(`${w.file} ${part}: ${es[0]}`);
  }
  console.log(`    workbooks ${written.length}, tables ${nTables} (openpyxl saw ${oxTables}), structured formulas ${nFormulas}, table parts validated ${tableParts}, problems ${bad.length}`);
  if (process.env.TT75_PROGRESS && bad.length) process.stderr.write(bad.join("\n") + "\n");
  ok(!bad.length, bad.slice(0, 8).join("\n"));
  ok(nTables >= 61 && oxTables === nTables && tableParts >= nTables, `tables ${nTables} / openpyxl ${oxTables} / parts ${tableParts}`);
});

/* ================================================================== T2 corpus structural edits */
if (want("T2")) await test("T2 corpus structural edits on every table: insert / delete a body row and a column inside it, delete the whole table, refuse a header-only delete — probes follow the invariants; new package and in-place save carry the geometry (openpyxl)", TABLES, async () => {
  const bad: string[] = []; let edits = 0, refusedOk = 0, checked = 0, positionDependent = 0, oracleUnreadable = 0; const files: { path: string; expect: Record<string, string>; cols: Record<string, string[]>; label: string }[] = [];
  for (const c of corpus) {
    for (const t0 of c.wb.tables.values()) {
      const tt = Date.now(); if (process.env.TT75_PROGRESS) process.stderr.write(`  T2 ${c.file} ${t0.name} … `);
      const wb = clone(c.wb); const t = wb.tables.get(t0.name.toUpperCase())!;
      const cells = addProbes(wb, t); const p0 = probeVals(wb, cells);
      const sh = t.sheet; const body = t.r1 - t.r0 + 1 - t.headerRows - t.totalsRows;
      const others = [...wb.tables.values()].filter((x) => x !== t && x.sheet === sh);
      // (a) insert one row inside the body
      const rAt = t.r0 + t.headerRows + (body > 1 ? 1 : 0) + (t.headerRows ? 0 : 1);
      if (rAt > t.r0 && rAt <= t.r1) {
        const conflict = tableStructureConflict(wb, sh, "row", rAt, 1);
        const otherInside = others.some((x) => x.r0 < rAt && rAt <= x.r1);
        if (conflict) { if (otherInside) refusedOk++; else bad.push(`${c.file} ${t.name}: insert row refused without a second table: ${conflict}`); }
        else {
          insertDelete(wb, sh, "row", rAt, 1); edits++;
          const p1 = probeVals(wb, cells);
          const exp = [Number(p0[0]) + 1, p0[1], p0[2], p0[3], p0[4], p0[5], Number(p0[6]) + 1];
          // a body whose formulas read their own position (INDIRECT / OFFSET / ROW(): e.g. a running counter
          // =INDIRECT("A"&ROW(…)-1)+1) legitimately changes value when an empty row is inserted: compare shape only
          const posDep = tableReadsPosition(c.wb, t0, sh);
          if (posDep) positionDependent++;
          if (!exp.every((v, i) => (posDep && i >= 2 && i <= 4) || same(p1[i], v))) bad.push(`${c.file} ${t.name}: after row insert at ${rAt + 1} probes ${J(p1)} want ${J(exp)}`);
          // written geometry, new package + in-place save
          const tn = wb.tables.get(t.name.toUpperCase())!;
          const np = join(tmp, `t2-${files.length}.xlsx`); writeFileSync(np, writeXlsxWorkbook(wb, c.file)); files.push({ path: np, expect: { [t.name]: refOf(tn) }, cols: {}, label: `${c.file} ${t.name} new package after row insert` });
          try {
            const pp = join(tmp, `t2-${files.length}.xlsx`); const r = await patchXlsx(new Uint8Array(c.bytes), wb, {}, loadedBaseline(new Uint8Array(c.bytes)));
            writeFileSync(pp, r.bytes); files.push({ path: pp, expect: Object.fromEntries([...wb.tables.values()].filter((x) => c.wb.tables.has(x.name.toUpperCase())).map((x) => [x.name, refOf(x)])), cols: {}, label: `${c.file} ${t.name} in-place save after row insert` });
          } catch (e) { bad.push(`${c.file} ${t.name}: in-place save threw ${(e as Error).message}`); }
          insertDelete(wb, sh, "row", rAt, -1); edits++;
          const p2 = probeVals(wb, cells);
          if (!p2.every((v, i) => same(v, p0[i]))) bad.push(`${c.file} ${t.name}: after deleting the inserted row probes ${J(p2)} want ${J(p0)}`);
          if (tdefKey(wb.tables.get(t.name.toUpperCase())!) !== tdefKey(t0)) bad.push(`${c.file} ${t.name}: insert+delete row changed the table`);
        }
      }
      // (b) insert one column inside the table
      if (t.c1 > t.c0) {
        const cAt = t.c0 + 1; const conflict = tableStructureConflict(wb, sh, "col", cAt, 1);
        const otherInside = others.some((x) => x.c0 < cAt && cAt <= x.c1);
        if (conflict) { if (otherInside) refusedOk++; else bad.push(`${c.file} ${t.name}: insert column refused without a second table: ${conflict}`); }
        else {
          const before = [...wb.tables.get(t.name.toUpperCase())!.columns];
          insertDelete(wb, sh, "col", cAt, 1); edits++;
          const tn = wb.tables.get(t.name.toUpperCase())!; const nm = defaultColumnName(before);
          const p1 = probeVals(wb, cells);
          const exp = [p0[0], Number(p0[1]) + 1, p0[2], p0[3], p0[4], t.headerRows ? Number(p0[5]) + 1 : p0[5], p0[6]];
          if (!exp.every((v, i) => same(p1[i], v))) bad.push(`${c.file} ${t.name}: after column insert probes ${J(p1)} want ${J(exp)}`);
          if (tn.columns[1] !== nm || J([tn.columns[0], ...tn.columns.slice(2)]) !== J(before)) bad.push(`${c.file} ${t.name}: columns ${J(tn.columns)} (want ${nm} at 2)`);
          if (t.headerRows && val(wb, sh, `${colL(cAt)}${tn.r0 + 1}`) !== nm) bad.push(`${c.file} ${t.name}: header cell of the new column is ${J(val(wb, sh, `${colL(cAt)}${tn.r0 + 1}`))}`);
          const np = join(tmp, `t2-${files.length}.xlsx`); writeFileSync(np, writeXlsxWorkbook(wb, c.file)); files.push({ path: np, expect: { [t.name]: refOf(tn) }, cols: { [t.name]: tableColumnNames(tn) } /* openpyxl decodes _xHHHH_ */, label: `${c.file} ${t.name} new package after column insert` });
          try {
            const pp = join(tmp, `t2-${files.length}.xlsx`); const r = await patchXlsx(new Uint8Array(c.bytes), wb, {}, loadedBaseline(new Uint8Array(c.bytes)));
            writeFileSync(pp, r.bytes); files.push({ path: pp, expect: { [t.name]: refOf(tn) }, cols: { [t.name]: [...tn.columns] }, label: `${c.file} ${t.name} in-place save after column insert` });
          } catch (e) { bad.push(`${c.file} ${t.name}: in-place save threw ${(e as Error).message}`); }
          insertDelete(wb, sh, "col", cAt, -1); edits++;
          const p2 = probeVals(wb, cells);
          if (!p2.every((v, i) => same(v, p0[i]))) bad.push(`${c.file} ${t.name}: after deleting the inserted column probes ${J(p2)} want ${J(p0)}`);
        }
      }
      // (c) header-only delete is refused (when the table has a header and a body)
      if (t.headerRows && body >= 1) {
        const tn = wb.tables.get(t.name.toUpperCase())!;
        let threw = false; try { insertDelete(wb, sh, "row", tn.r0, -1); } catch (e) { threw = e instanceof TableEditError; }
        if (threw) refusedOk++; else bad.push(`${c.file} ${t.name}: header row delete was not refused`);
        checked++;
      }
      // (d) delete every row of the table → it is removed and its probes are #REF!
      {
        const tn = wb.tables.get(t.name.toUpperCase())!;
        const conflict = tableStructureConflict(wb, sh, "row", tn.r0, -(tn.r1 - tn.r0 + 1));
        if (!conflict) {
          insertDelete(wb, sh, "row", tn.r0, -(tn.r1 - tn.r0 + 1)); edits++;
          const p3 = probeVals(wb, cells);
          if (wb.tables.has(t.name.toUpperCase())) bad.push(`${c.file} ${t.name}: still defined after deleting all its rows`);
          // Excel: the probes now read ROWS(#REF!) … — ROWS / COLUMNS / SUM propagate the error; COUNTA counts an error
          // argument (1) and COUNT ignores it (0) (Microsoft's COUNTA / COUNT reference pages)
          const R = { error: "#REF!" }, want3 = [R, R, 1, 0, R, 1, R];
          if (!p3.every((v, i) => J(v) === J(want3[i]))) bad.push(`${c.file} ${t.name}: probes after removal ${J(p3)} want ${J(want3)}`);
          const probeInput = inp(wb, PROBE_SHEET, cells[0]) ?? "";
          if (probeInput.includes(`${t.name}[`)) bad.push(`${c.file} ${t.name}: probe formula not rewritten: ${probeInput}`);
        } else if (!others.some((x) => x.r0 <= tn.r1 && x.r1 >= tn.r0)) bad.push(`${c.file} ${t.name}: whole-table delete refused: ${conflict}`);
        else refusedOk++;
      }      if (process.env.TT75_PROGRESS) process.stderr.write(`${Date.now() - tt} ms\n`);
    }
  }
  const ox = openpyxl(files.map((f) => f.path));
  // originals openpyxl itself cannot load (LIBRE_OFFICE-128382-0: openpyxl's Fill TypeError) — an in-place save keeps
  // those parts verbatim, so the oracle cannot read the result either; such saves are still schema-checked below
  const origPaths = corpus.map((c, i) => { const p = join(tmp, `orig-${i}.xlsx`); writeFileSync(p, c.bytes); return { p, file: c.file }; });
  const ox0 = openpyxl(origPaths.map((o) => o.p));
  const unreadable = new Set(origPaths.filter((o) => !ox0[o.p] || "error" in ox0[o.p]).map((o) => o.file));
  for (const f of files) {
    const o = ox[f.path];
    if ((!o || "error" in o) && / in-place save /.test(f.label) && [...unreadable].some((u) => f.label.startsWith(`${u} `))) { oracleUnreadable++; continue; }
    if (!o || "error" in o) { bad.push(`${f.label}: openpyxl ${o && "error" in o ? o.error : "no result"}`); continue; }
    for (const [name, ref] of Object.entries(f.expect)) { const x = o.tables.find((q) => q.name === name); if (!x || x.ref !== ref) bad.push(`${f.label}: openpyxl ref of ${name} = ${x?.ref} want ${ref}`); }
    for (const [name, cols] of Object.entries(f.cols)) { const x = o.tables.find((q) => q.name === name); if (!x || J(x.columns) !== J(cols)) bad.push(`${f.label}: openpyxl columns of ${name} = ${J(x?.columns)} want ${J(cols)}`); }
  }
  const xs = xsd(files.map((f) => f.path));
  for (const f of files) for (const [part, es] of Object.entries(xs[f.path]?.parts ?? {})) if (/xl\/tables\//.test(part) && es.length) bad.push(`${f.label} ${part}: ${es[0]}`);
  console.log(`    edits ${edits}, justified refusals ${refusedOk}, header deletes refused ${checked}, packages checked by openpyxl ${files.length} (original unreadable by openpyxl: ${oracleUnreadable}), position-dependent bodies ${positionDependent}, problems ${bad.length}`);
  ok(edits >= 150 && files.length >= 100, `edits ${edits}, files ${files.length}`);
  if (process.env.TT75_PROGRESS && bad.length) process.stderr.write(bad.join("\n") + "\n");
  ok(!bad.length, bad.slice(0, 6).join("\n"));
});

/* ================================================================== T3 units */
function twoTables(): Workbook {
  const wb = new Workbook();
  const rows = [["Item", "Qty", "", "Name", "Score"], ["a", "1", "", "x", "10"], ["b", "2", "", "y", "20"], ["c", "3", "", "z", "30"], ["Total", "=SUBTOTAL(109,T1[Qty])", "", "", ""]];
  rows.forEach((r, i) => r.forEach((v, j) => { if (v) wb.sheet("Sheet1").setCell(j, i, v); }));
  wb.tables.set("T1", { name: "T1", sheet: "Sheet1", c0: 0, r0: 0, c1: 1, r1: 4, headerRows: 1, totalsRows: 1, columns: ["Item", "Qty"] });
  wb.tables.set("T2", { name: "T2", sheet: "Sheet1", c0: 3, r0: 0, c1: 4, r1: 3, headerRows: 1, totalsRows: 0, columns: ["Name", "Score"] });
  put(wb, "Sheet1", "G1", "=SUM(T1[Qty])"); put(wb, "Sheet1", "G2", "=SUM(T2[Score])"); put(wb, "Sheet1", "G3", '=IF(1,"T2[Score]",T2[[#Headers],[Name]])');
  wb.recalculate(); return wb;
}
if (want("T3")) await test("T3 table rules: refusals (header row, two tables), totals row, last body row kept, removed column / table → #REF!, file form of [@Col] / name-less refs, strings untouched", TABLES, () => {
  // two side-by-side tables: inserting a row through both is refused; above both is fine
  let wb = twoTables();
  ok(tableStructureConflict(wb, "Sheet1", "row", 2, 1)?.includes("2 tables"), "insert through two tables not refused");
  ok(tableStructureConflict(wb, "Sheet1", "row", 0, 1) === null, "insert above both refused");
  insertDelete(wb, "Sheet1", "row", 0, 1);
  ok(wb.tables.get("T1")!.r0 === 1 && wb.tables.get("T2")!.r1 === 4 && val(wb, "Sheet1", "G3") === 60 && inp(wb, "Sheet1", "G3") === "=SUM(T2[Score])", J([...wb.tables.values()]));
  // header row refusal (only T1 spans row 6 → totals row delete is allowed; header delete is refused)
  wb = twoTables();
  let threw = ""; try { insertDelete(wb, "Sheet1", "row", 0, -1); } catch (e) { threw = (e as Error).message; }
  ok(/header row/.test(threw) || /2 tables/.test(threw), `header delete: ${threw}`);
  // totals row deleted → totalsRows 0, SUBTOTAL cell gone, SUM unchanged
  wb = twoTables(); insertDelete(wb, "Sheet1", "row", 4, -1);
  ok(wb.tables.get("T1")!.totalsRows === 0 && wb.tables.get("T1")!.r1 === 3 && val(wb, "Sheet1", "G1") === 6, J(wb.tables.get("T1")));
  // a column of T1 deleted → T1[Qty] becomes #REF! (text rewritten like Excel), T2 untouched; strings untouched
  wb = twoTables(); insertDelete(wb, "Sheet1", "col", 1, -1);
  ok(inp(wb, "Sheet1", "F1") === "=SUM(#REF!)", `F1 ${inp(wb, "Sheet1", "F1")}`);
  ok(inp(wb, "Sheet1", "F2") === "=SUM(T2[Score])" && val(wb, "Sheet1", "F2") === 60, `F2 ${inp(wb, "Sheet1", "F2")}`);
  ok(inp(wb, "Sheet1", "F3") === '=IF(1,"T2[Score]",T2[[#Headers],[Name]])', `F3 ${inp(wb, "Sheet1", "F3")}`);
  ok(J(wb.tables.get("T1")!.columns) === J(["Item"]) && wb.tables.get("T2")!.c0 === 2, J([...wb.tables.values()]));
  // delete every body row of T2 (rows 2–4) — refused because T1 is also cut; on a lone table the last body row is kept
  const lone = new Workbook(); ["H", "1", "2"].forEach((v, i) => lone.sheet("Sheet1").setCell(0, i, v));
  lone.tables.set("L", { name: "L", sheet: "Sheet1", c0: 0, r0: 0, c1: 0, r1: 2, headerRows: 1, totalsRows: 0, columns: ["H"] });
  insertDelete(lone, "Sheet1", "row", 1, -2);
  ok(lone.tables.get("L")!.r1 === 1, `lone table after deleting all body rows: ${J(lone.tables.get("L"))}`);
  // inserting a column inside: default name, header cell written, unique against existing ColumnK
  const w3 = new Workbook(); ["A", "Column1"].forEach((v, i) => w3.sheet("Sheet1").setCell(i, 0, v));
  w3.tables.set("W", { name: "W", sheet: "Sheet1", c0: 0, r0: 0, c1: 1, r1: 1, headerRows: 1, totalsRows: 0, columns: ["A", "Column1"] });
  insertDelete(w3, "Sheet1", "col", 1, 1);
  ok(J(w3.tables.get("W")!.columns) === J(["A", "Column2", "Column1"]) && val(w3, "Sheet1", "B1") === "Column2", J(w3.tables.get("W")));
  // file form
  const ff = twoTables();
  ok(structuredRefsToFileForm("=[@Qty]*2", ff, "Sheet1", 1, 2) === "=T1[[#This Row],[Qty]]*2", structuredRefsToFileForm("=[@Qty]*2", ff, "Sheet1", 1, 2));
  ok(structuredRefsToFileForm("=T2[@[Score]]+T2[@Name]", ff, "Sheet1", 6, 2) === "=T2[[#This Row],[Score]]+T2[[#This Row],[Name]]", structuredRefsToFileForm("=T2[@[Score]]+T2[@Name]", ff, "Sheet1", 6, 2));
  ok(structuredRefsToFileForm("=SUM([Qty])", ff, "Sheet1", 1, 4) === "=SUM(T1[Qty])", structuredRefsToFileForm("=SUM([Qty])", ff, "Sheet1", 1, 4));
  ok(structuredRefsToFileForm('="[@Qty]"&\'My [x]\'!A1', ff, "Sheet1", 1, 2) === '="[@Qty]"&\'My [x]\'!A1', "strings / quoted sheet names must be untouched");
  ok(structuredRefsToFileForm("=T1[@]", ff, "Sheet1", 1, 2) === "=T1[#This Row]", structuredRefsToFileForm("=T1[@]", ff, "Sheet1", 1, 2));
  // [@Col] written by the new package evaluates the same after reopening
  const cw = new Workbook(); [["Qty", "Price", "Total"], ["2", "5", "=[@Qty]*[@Price]"], ["3", "7", "=[@Qty]*[@Price]"]].forEach((r, i) => r.forEach((v, j) => cw.sheet("Sheet1").setCell(j, i, v)));
  cw.tables.set("Calc", { name: "Calc", sheet: "Sheet1", c0: 0, r0: 0, c1: 2, r1: 2, headerRows: 1, totalsRows: 0, columns: ["Qty", "Price", "Total"] }); cw.recalculate();
  const v0 = [val(cw, "Sheet1", "C2"), val(cw, "Sheet1", "C3")];
  const back = readXlsxWorkbook(writeXlsxWorkbook(cw)); back.recalculate();
  ok(J(v0) === J([10, 21]) && J([val(back, "Sheet1", "C2"), val(back, "Sheet1", "C3")]) === J([10, 21]) && inp(back, "Sheet1", "C2") === "=Calc[[#This Row],[Qty]]*Calc[[#This Row],[Price]]", `${J(v0)} / ${J(val(back, "Sheet1", "C2"))} / ${inp(back, "Sheet1", "C2")}`);
  // rewriteStructuredRefs leaves untouched text identical
  ok(rewriteStructuredRefs("=SUM(T2[Score])", ff, "Sheet1", 0, 0, { tables: new Set(["T1"]), cols: new Map() }) === "=SUM(T2[Score])", "unrelated table rewritten");
});

/* ================================================================== T4 header cells */
if (want("T4")) await test("T4 numeric header cells are written as text (openpyxl sees str); a header cell that differs from its column name is reported", TABLES, () => {
  const wb = new Workbook(); [2010, 2011].forEach((y, i) => wb.sheet("Sheet1").setCell(i, 0, String(y))); wb.sheet("Sheet1").setCell(0, 1, "5"); wb.sheet("Sheet1").setCell(1, 1, "6");
  wb.tables.set("Y", { name: "Y", sheet: "Sheet1", c0: 0, r0: 0, c1: 1, r1: 1, headerRows: 1, totalsRows: 0, columns: ["2010", "2011"] });
  put(wb, "Sheet1", "D1", "=SUM(Y[2011])"); wb.recalculate();
  const report = { pivots: [], tables: [] as string[] };
  const p = join(tmp, "t4.xlsx"); writeFileSync(p, writeXlsxWorkbook(wb, "t4", report));
  const o = openpyxl([p])[p]; ok(o && !("error" in o), J(o));
  ok(J(o.headers) === J({ "Sheet1!A1": ["str", "2010"], "Sheet1!B1": ["str", "2011"] }), J(o.headers));
  const back = readXlsxWorkbook(readFileSync(p)); back.recalculate(); ok(val(back, "Sheet1", "D1") === 6, J(val(back, "Sheet1", "D1")));
  ok(!report.tables.length, J(report.tables));
  put(wb, "Sheet1", "A1", "Renamed"); wb.recalculate(); writeXlsxWorkbook(wb, "t4", report);
  ok(report.tables.length === 1 && /A1/.test(report.tables[0]), J(report.tables));
});

/* ================================================================== T5 ST_Xstring */
if (want("T5")) await test("T5 column names with a line break, a tab, a literal _x0041_ and XML specials round-trip through the table part (ST_Xstring) and stay schema-valid", TABLES, () => {
  const names = ["Line\nbreak", "Tab\there", "_x0041_ literal", `<&"'>`];
  ok(names.every((n) => unXstring(xstring(n)) === n), J(names.map((n) => [xstring(n), unXstring(xstring(n))])));
  const wb = new Workbook(); names.forEach((n, i) => { wb.sheet("Sheet1").setCell(i, 0, n); wb.sheet("Sheet1").setCell(i, 1, String(i + 1)); });
  wb.tables.set("X", { name: "X", sheet: "Sheet1", c0: 0, r0: 0, c1: 3, r1: 1, headerRows: 1, totalsRows: 0, columns: names });
  const p = join(tmp, "t5.xlsx"); writeFileSync(p, writeXlsxWorkbook(wb));
  const back = readXlsxWorkbook(readFileSync(p));
  ok(J(back.tables.get("X")!.columns) === J(names), J(back.tables.get("X")!.columns));
  const xs = xsd([p])[p]; const errs = Object.entries(xs.parts).flatMap(([k, es]) => es.map((e) => `${k}: ${e}`));
  ok(!errs.length, errs.slice(0, 3).join("\n"));
});

/* ================================================================== negative shapes */
const neg = (id: string, name: string, fn: () => void | Promise<void>) => (want(id) ? test(`${id} ${name}`, id === "N9" ? MEMO : id === "N10" ? SHEET : TABLES, fn) : Promise.resolve());
await neg("N1", "hostile workbook JSON table filters (bad offsets, non-strings, huge lists, prototype keys) are dropped or capped", () => {
  const wb = new Workbook(); wb.sheet("Sheet1").setCell(0, 0, "A"); wb.sheet("Sheet1").setCell(1, 0, "B");
  const j = workbookToJson(wb) as WorkbookJson & { tables?: unknown[] };
  j.tables = [{ name: "T", sheet: "Sheet1", c0: 0, r0: 0, c1: 1, r1: 3, headerRows: 1, totalsRows: 0, columns: ["A", "B"], filter: { cols: { "0": ["x", 5, { a: 1 }, ...Array(2000).fill("y")], "7": ["z"], "-1": ["q"], "__proto__": ["p"], "1e0": ["w"] }, foreign: "yes" } }];
  const back = workbookFromJson(JSON.parse(J(j)) as WorkbookJson); const t = back.tables.get("T")!;
  ok(t && J(Object.keys(t.filter!.cols)) === J(["0"]) && t.filter!.cols[0].length === 1000 && t.filter!.cols[0][0] === "x" && t.filter!.foreign === undefined, J(t?.filter && { keys: Object.keys(t.filter.cols), n: t.filter.cols[0]?.length, f: t.filter.foreign }));
});
await neg("N2", "a table name or column name cannot inject XML into the table part (names are escaped; the part stays schema-valid)", () => {
  const wb = new Workbook(); wb.sheet("Sheet1").setCell(0, 0, `a"/><evil x="`); wb.sheet("Sheet1").setCell(0, 1, "1");
  wb.tables.set("T", { name: "T", sheet: "Sheet1", c0: 0, r0: 0, c1: 0, r1: 1, headerRows: 1, totalsRows: 0, columns: [`a"/><evil x="`] });
  const p = join(tmp, "n2.xlsx"); writeFileSync(p, writeXlsxWorkbook(wb));
  const xs = xsd([p])[p]; const errs = Object.entries(xs.parts).flatMap(([k, es]) => es.map((e) => `${k}: ${e}`)); ok(!errs.length, errs.join("\n"));
  ok(readXlsxWorkbook(readFileSync(p)).tables.get("T")!.columns[0] === `a"/><evil x="`, "name changed");
});
await neg("N3", "duplicate / empty column names are made unique for Excel (Excel refuses duplicates) without touching the model", () => {
  const t: TableDef = { name: "D", sheet: "Sheet1", c0: 0, r0: 0, c1: 3, r1: 1, headerRows: 1, totalsRows: 0, columns: ["Qty", "qty", "", "Qty2"] };
  ok(J(tableColumnNames(t)) === J(["Qty", "qty2", "Column1", "Qty22"]), J(tableColumnNames(t)));
  ok(J(t.columns) === J(["Qty", "qty", "", "Qty2"]), "model mutated");
});
await neg("N4", "structured-reference rewriting is not fooled by look-alikes: a defined name, a function call, a string, an external [1] index", () => {
  const wb = twoTables(); const dead = { tables: new Set<string>(), cols: new Map([["T1", new Set(["qty"])]]) };
  const cases: [string, string][] = [["=SUM(T1[Qty])", "=SUM(#REF!)"], ['="T1[Qty]"', '="T1[Qty]"'], ["=[1]Sheet1!A1", "=[1]Sheet1!A1"], ["=T1Qty+SUM(T1[Item])", "=T1Qty+SUM(T1[Item])"], ["=T1[[#Totals],[Qty]]", "=#REF!"], ["=T1[[Item]:[Qty]]", "=#REF!"]];
  const got = cases.map(([a]) => rewriteStructuredRefs(a, wb, "Sheet1", 9, 9, dead));
  ok(J(got) === J(cases.map((c) => c[1])), J(got));
});
await neg("N5", "an insert / delete that Excel refuses changes nothing (cells, tables, formulas)", () => {
  const wb = twoTables(); const before = J(workbookToJson(wb));
  let threw = false; try { insertDelete(wb, "Sheet1", "row", 2, 1); } catch (e) { threw = e instanceof TableEditError; }
  ok(threw && J(workbookToJson(wb)) === before, "refused edit mutated the workbook");
});
await neg("N6", "in-place save: a table removed by deleting its rows loses its part, relationship, <tablePart> and content-type override (openpyxl opens it; no dangling part)", async () => {
  const f = join(XLSX, "WithTable.xlsx"); const bytes = readFileSync(f); const wb = readXlsxWorkbook(bytes); wb.recalculate();
  const t = [...wb.tables.values()][0];
  insertDelete(wb, t.sheet, "row", t.r0, -(t.r1 - t.r0 + 1));
  const r = await patchXlsx(new Uint8Array(bytes), wb, {}, loadedBaseline(new Uint8Array(bytes)));
  const p = join(tmp, "n6.xlsx"); writeFileSync(p, r.bytes);
  const o = openpyxl([p])[p]; ok(o && !("error" in o) && o.tables.length === 0, J(o));
  const names = JSON.parse(execFileSync(PY, ["-c", "import zipfile,sys,json; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps([n for n in z.namelist()]+[z.read('[Content_Types].xml').decode()]))", p], { encoding: "utf8" })) as string[];
  const ct = names.pop()!;
  ok(!names.some((n) => /xl\/tables\//.test(n)) && !/tables\/table/.test(ct), `${names.filter((n) => /tables/.test(n))} ${/tables\/table/.test(ct)}`);
  const xs = xsd([p])[p]; const errs = Object.entries(xs.parts).flatMap(([k, es]) => es.map((e) => `${k}: ${e}`)); ok(!errs.some((e) => /tablePart/.test(e)), errs.join("\n"));
});

await neg("N7", "kept foreign filter criteria pass an allowlist sanitiser (file AND workbook JSON): injected elements, attributes, text, comments, entities, prefixes", () => {
  const S = sanitizeFilterColumnXml;
  const good = `<x:filterColumn colId='2' x:hiddenButton="0"><x:customFilters and="1"><x:customFilter operator="greaterThan" val="a&amp;b&lt;"/><x:customFilter val="&#65;"/></x:customFilters></x:filterColumn>`;
  ok(S(good) === `<filterColumn colId="2" hiddenButton="0"><customFilters and="1"><customFilter operator="greaterThan" val="a&amp;b&lt;"/><customFilter val="A"/></customFilters></filterColumn>`, String(S(good)));
  ok(S(S(good)!) === S(good), "not idempotent");
  const bad = [
    `<filterColumn colId="0"><customFilters><evil/></customFilters></filterColumn>`,
    `<filterColumn colId="0" onload="x"><top10 val="3"/></filterColumn>`,
    `<filterColumn colId="0"><top10 val="3"/>text</filterColumn>`,
    `<filterColumn colId="0"><!-- c --><top10 val="3"/></filterColumn>`,
    `<filterColumn colId="0"><top10 val="&#99999999;"/></filterColumn>`,
    `<filterColumn colId="0"><top10 val="3"/></filterColumn><filterColumn colId="1"/>`,
    `<filterColumn colId="0"><top10 val="3"></filterColumn>`,
    `<filterColumn colId="0"><filter val="1"/></filterColumn>`,
    `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><filterColumn colId="0"/>`,
    `<filterColumn colId="0"><extLst><ext uri="x"/></extLst></filterColumn>`,
  ];
  const got = bad.map((b) => S(b)); ok(got.every((g) => g === null), J(got));
  // the JSON boundary: hostile raw strings are dropped, a valid one is kept (re-canonicalised)
  const wb = new Workbook(); wb.sheet("Sheet1").setCell(0, 0, "A");
  const j = workbookToJson(wb) as WorkbookJson & { tables?: unknown[] };
  (j.sheets[0] as unknown as { autoFilter: unknown }).autoFilter = { ref: "A1:B9", cols: {}, foreign: true, raw: { "0": bad[0], "1": good, "x": good, "99999": good } };
  j.tables = [{ name: "T", sheet: "Sheet1", c0: 0, r0: 0, c1: 1, r1: 3, headerRows: 1, totalsRows: 0, columns: ["A", "B"], filter: { cols: {}, foreign: true, raw: { "0": `<filterColumn colId="0"><top10 val="3" evil="1"/></filterColumn>`, "1": good, "5": good } } }];
  const back = workbookFromJson(JSON.parse(J(j)) as WorkbookJson);
  ok(J(back.sheet("Sheet1").autoFilter?.raw) === J({ 1: S(good) }) && J(back.tables.get("T")!.filter?.raw) === J({ 1: S(good) }), J([back.sheet("Sheet1").autoFilter?.raw, back.tables.get("T")!.filter?.raw]));
});
await neg("N8", "kept foreign criteria reach the new package (sheet AutoFilter and table), follow a column insert, and the parts stay schema-valid", () => {
  const wb = twoTables(); const t1 = wb.tables.get("T1")!;
  t1.filter = { cols: { 0: ["a"] }, foreign: true, raw: { 1: `<filterColumn colId="1"><top10 val="2"/></filterColumn>` } };
  wb.sheet("Sheet1").autoFilter = null;
  const w2 = new Workbook(); for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) w2.sheet("Sheet1").setCell(c, r, r ? String(r * 10 + c) : `H${c}`);
  w2.sheet("Sheet1").autoFilter = { ref: "A1:C4", cols: {}, foreign: true, raw: { 2: `<filterColumn colId="2"><customFilters><customFilter operator="greaterThan" val="15"/></customFilters></filterColumn>` } };
  insertDelete(w2, "Sheet1", "col", 1, 1); // the criterion column moves from offset 2 to 3
  insertDelete(wb, "Sheet1", "col", 1, 1); // T1 gains a column before Qty: top10 moves to offset 2
  const p1 = join(tmp, "n8a.xlsx"), p2 = join(tmp, "n8b.xlsx"); writeFileSync(p1, writeXlsxWorkbook(wb)); writeFileSync(p2, writeXlsxWorkbook(w2));
  const r1 = readXlsxWorkbook(readFileSync(p1)), r2 = readXlsxWorkbook(readFileSync(p2));
  ok(J(r1.tables.get("T1")!.filter) === J({ cols: { 0: ["a"] }, foreign: true, raw: { 2: `<filterColumn colId="2"><top10 val="2"/></filterColumn>` } }), J(r1.tables.get("T1")!.filter));
  ok(J(r2.sheet("Sheet1").autoFilter) === J({ ref: "A1:D4", cols: {}, foreign: true, raw: { 3: `<filterColumn colId="3"><customFilters><customFilter operator="greaterThan" val="15"/></customFilters></filterColumn>` } }), J(r2.sheet("Sheet1").autoFilter));
  const xs = xsd([p1, p2]); const errs = Object.values(xs).flatMap((x) => Object.entries(x.parts).flatMap(([k, es]) => es.map((e) => `${k}: ${e}`))); ok(!errs.length, errs.slice(0, 4).join("\n"));
});

/* N9: the per-pass range / blank-mask memo is invisible — random workbooks (ranges, lookups, blank-sensitive functions,
 * spills, cycles through ranges, INDIRECT) give identical values with the memo on and off. A memo that froze a range
 * read while one of its cells was still being evaluated (a cycle) would differ here. */
await neg("N9", "range memo is invisible: 300 random workbooks with lookups, COUNTBLANK / COUNTA, spills, INDIRECT and cycles through ranges evaluate identically with the memo on and off", () => {
  let seed = 75; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  let cycles = 0, cells = 0;
  for (let k = 0; k < 300; k++) {
    const H = 70 + Math.floor(rnd() * 60); const inputs: [number, number, string][] = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < 3; c++) { const x = rnd(); inputs.push([c, r, x < 0.15 ? "" : x < 0.25 ? `=""` : x < 0.35 ? pick(["a", "b", "x"]) : String(Math.floor(rnd() * 50))]); }
    const R = () => { const a = Math.floor(rnd() * H), b = Math.min(H - 1, a + 64 + Math.floor(rnd() * H)); const c = pick(["A", "B", "C"]); return `$${c}$${a + 1}:$${c}$${b + 1}`; };
    const F = [() => `=SUM(${R()})`, () => `=COUNTBLANK(${R()})`, () => `=COUNTA(${R()})`, () => `=IFERROR(VLOOKUP(${Math.floor(rnd() * 50)},$A$1:$C$${H},2,FALSE),"-")`,
      () => `=MATCH(${Math.floor(rnd() * 50)},${R()},0)`, () => `=SUMIF(${R()},">10")`, () => `=SUM(INDIRECT("A1:A${1 + Math.floor(rnd() * H)}"))`,
      () => `=SUM($D$1:$D$${H})`, () => `=COUNTIF(${R()},"")`, () => `=SEQUENCE(${1 + Math.floor(rnd() * 3)})`, () => `=MAX(${R()})+ROWS(${R()})`];
    for (let r = 0; r < H; r++) inputs.push([3, r, rnd() < 0.7 ? pick(F)() : ""]);
    // a cycle through a range: C<k> reads D:D, which contains a SUM of D:D
    // error-ignoring cycle members (COUNT / AGGREGATE option 6) so a range read frozen mid-cycle would surface
    if (rnd() < 0.5) { inputs.push([2, Math.floor(rnd() * H), `=SUM($D$1:$D$${H})`]); inputs.push([3, Math.floor(rnd() * H), pick([`=COUNT($D$1:$D$${H})`, `=AGGREGATE(9,6,$D$1:$D$${H})`])]); cycles++; }
    // readers outside the cycle that ignore errors, and blank masks over the same rows in different columns
    const top = Math.floor(rnd() * 5);
    for (const [j, f] of [`=COUNT($D$1:$D$${H})`, `=AGGREGATE(9,6,$D$1:$D$${H})`, `=COUNTBLANK($A$${top + 1}:$A$${H})`, `=COUNTBLANK($B$${top + 1}:$B$${H})`, `=COUNTBLANK($C$${top + 1}:$C$${H})`, `=COUNTA($B$${top + 1}:$B$${H})`].entries()) inputs.push([4, j, f]);
    const run = (memo: boolean) => {
      Workbook.memoRanges = memo; const wb = new Workbook(); const s = wb.sheet("Sheet1");
      for (const [c, r, v] of inputs) if (v !== "") s.setCell(c, r, v);
      wb.recalculate(); const out: string[] = [];
      for (let r = 0; r < H + 4; r++) for (let c = 0; c < 5; c++) out.push(J(s.get(c, r)?.value ?? null));
      return out;
    };
    try {
      const a = run(true), b = run(false); cells += a.length;
      const i = a.findIndex((x, j) => x !== b[j]);
      ok(i < 0, `seed ${k}: cell ${i} memo ${a[i]} vs no memo ${b[i]}`);
    } finally { Workbook.memoRanges = true; }
  }
  console.log(`    workbooks 300, cells compared ${cells}, with a cycle through a range ${cycles}`);
  ok(cycles >= 60, `cycles ${cycles}`);
});
/* N10: ROWS / COLUMNS of a non-reference error propagate it (Excel); a reference to an error cell is still a 1×1 area */
await neg("N10", "ROWS / COLUMNS: a non-reference error argument propagates (=ROWS(#REF!), =COLUMNS(1/0)), a reference to an error cell counts as 1, arrays keep their shape", () => {
  const wb = new Workbook(); const s = wb.sheet("Sheet1");
  s.setCell(0, 0, "=NA()");
  const fs: [string, unknown][] = [["=ROWS(#REF!)", { error: "#REF!" }], ["=COLUMNS(#REF!)", { error: "#REF!" }], ["=COLUMNS(1/0)", { error: "#DIV/0!" }], ["=ROWS(A1)", 1], ["=COLUMNS(A1:C1)", 3], ["=ROWS({1;2;3})", 3], ["=COLUMNS({1,#N/A})", 2], ["=COUNTA(#REF!)", 1], ["=COUNT(#REF!)", 0]];
  fs.forEach(([f], i) => s.setCell(5, i, f)); wb.recalculate();
  const got = fs.map((_, i) => s.get(5, i)?.value);
  ok(J(got) === J(fs.map((x) => x[1])), `got ${J(got)}`);
});

/* N11: table names Excel forbids (cell / R1C1 look-alikes, C, R, bad characters) are refused when a workbook JSON
 * brings them; ordinary names, Unicode names and backslash / dot names are accepted */
await neg("N11", "table names: cell-reference and R1C1 look-alikes, C / R, spaces, a leading digit are refused; Unicode, _ / \\ starts and dots are accepted", () => {
  const bad = ["A1", "XFD1048576", "ab12", "R1C1", "r2c", "RC", "R", "c", "1Table", "Has space", "T-1", ""];
  const good = ["Table1", "表23", "Таблица1", "_t", "\\x", "Sales.2024", "RC_", "R1C1x", "ABCD1", "Contrôle"];
  const wrong = [...bad.filter((n) => tableNameOk(n)).map((n) => `accepted ${J(n)}`), ...good.filter((n) => !tableNameOk(n)).map((n) => `refused ${J(n)}`)];
  ok(!wrong.length, wrong.join(", "));
});
/* N12: the table model refuses on its own (defence in depth) — a caller that skips sheetops' check still cannot delete
 * a header row alone or move two tables' cells */
await neg("N12", "adjustTablesForStructure refuses a header-only delete and a two-table insert even when called directly (not through insertDelete)", () => {
  const wb = twoTables();
  let e1 = ""; try { adjustTablesForStructure(wb, "Sheet1", "row", 0, -1); } catch (e) { e1 = e instanceof TableEditError ? "refused" : String(e); }
  let e2 = ""; try { adjustTablesForStructure(wb, "Sheet1", "row", 2, 1); } catch (e) { e2 = e instanceof TableEditError ? "refused" : String(e); }
  ok(e1 === "refused" && e2 === "refused", J([e1, e2]));
  ok(J([wb.tables.get("T1")!.r1, wb.tables.get("T2")!.r1]) === J([4, 3]), "a refused call changed a table");
});

finish();
