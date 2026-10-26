/**
 * TT58 PivotTables on a workbook: a definition (source range + layout spec) lives on the sheet that shows the pivot;
 * Create / Refresh compute it from the source cells' current values (src/lib/formula/pivot.ts) and write the result
 * grid into cells. Writing never overwrites other data: a pivot that would grow over non-pivot cells is refused
 * (Excel asks "There's already data in … Do you want to replace it?" — here the caller chooses with `force`).
 */
import { computePivot, type PVal, type PivotResult, type PivotSpec } from "./pivot";
import { isError } from "./types";
import { Workbook, textInput, type Sheet } from "./engine";
import { parseA1Range, rangeA1, type Range } from "./sheetops";

export interface PivotDef { name: string; src: { sheet: string; ref: string }; anchor: { col: number; row: number }; spec: PivotSpec; /** cells written by the last refresh */ out?: Range }

/** the source table as values (formulas already calculated): "" → blank, error → { e: code } */
export function readTable(wb: Workbook, src: PivotDef["src"]): PVal[][] {
  const sh = wb.sheets.get(src.sheet); if (!sh) throw new Error(`The source sheet "${src.sheet}" no longer exists.`);
  const r = parseA1Range(src.ref); if (!r) throw new Error(`The source range "${src.ref}" is not valid.`);
  if (r.r1 - r.r0 < 1) throw new Error("The source needs a heading row and at least one row of data.");
  const out: PVal[][] = [];
  for (let row = r.r0; row <= r.r1; row++) {
    const line: PVal[] = [];
    for (let col = r.c0; col <= r.c1; col++) {
      const v = sh.get(col, row)?.value;
      line.push(v === undefined || v === "" ? null : isError(v) ? { e: v.error } : Array.isArray(v) ? null : (v as PVal));
    }
    out.push(line);
  }
  return out;
}

const inRange = (r: Range | undefined, col: number, row: number) => !!r && col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1;

export interface PivotWrite { ok: boolean; why?: string; result?: PivotResult; out?: Range }
/** compute `def` and write it at its anchor on `sheet`; clears what the previous refresh wrote */
export function writePivot(wb: Workbook, sheet: Sheet, def: PivotDef, force = false): PivotWrite {
  let result: PivotResult;
  try { result = computePivot(readTable(wb, def.src), def.spec); } catch (e) { return { ok: false, why: (e as Error).message }; }
  const { col, row } = def.anchor;
  const h = result.grid.length, w = Math.max(...result.grid.map((r) => r.length));
  const out: Range = { c0: col, r0: row, c1: col + w - 1, r1: row + h - 1 };
  // the source must not lie under the output (the pivot would overwrite its own data)
  const src = parseA1Range(def.src.ref);
  if (src && def.src.sheet === sheet.name && !(src.c1 < out.c0 || src.c0 > out.c1 || src.r1 < out.r0 || src.r0 > out.r1)) return { ok: false, why: "The PivotTable would overlap its own source range — choose another place." };
  // other pivots on this sheet
  for (const o of sheet.pivots) if (o !== def && o.out && !(o.out.c1 < out.c0 || o.out.c0 > out.c1 || o.out.r1 < out.r0 || o.out.r0 > out.r1)) return { ok: false, why: `A PivotTable report cannot overlap another PivotTable report (${o.name}).` };
  if (!force) {
    for (let r = out.r0; r <= out.r1; r++) for (let c = out.c0; c <= out.c1; c++) if (!inRange(def.out, c, r) && sheet.occupied(c, r)) return { ok: false, why: `There's already data in ${sheet.name}!${rangeA1(out)}.` };
  }
  if (def.out) for (let r = def.out.r0; r <= def.out.r1; r++) for (let c = def.out.c0; c <= def.out.c1; c++) { sheet.setCell(c, r, ""); sheet.setStyle(c, r, { bold: undefined }); }
  const strong = new Set([...Array(result.headerRows).keys(), ...result.totalRows, ...(result.grandRow !== undefined ? [result.grandRow] : [])]);
  result.grid.forEach((line, i) => line.forEach((v, j) => {
    const c = col + j, r = row + i;
    const input = v === null ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "#NUM!") : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "object" ? textInput(v.e) : textInput(v);
    sheet.setCell(c, r, input);
    if (strong.has(i) || (result.grandCol !== undefined && j >= result.grandCol)) sheet.setStyle(c, r, { bold: true });
  }));
  def.out = out;
  if (!sheet.pivots.includes(def)) sheet.pivots = [...sheet.pivots, def];
  return { ok: true, result, out };
}

/** a free name: PivotTable1, PivotTable2, … across the workbook */
export function nextPivotName(wb: Workbook): string {
  const used = new Set([...wb.sheets.values()].flatMap((s) => s.pivots.map((p) => p.name)));
  let i = 1; while (used.has(`PivotTable${i}`)) i++; return `PivotTable${i}`;
}

/** Refresh All: every pivot of the workbook (or of one sheet); returns the failures */
export function refreshPivots(wb: Workbook, only?: string): { name: string; why: string }[] {
  const bad: { name: string; why: string }[] = [];
  for (const sh of wb.sheets.values()) {
    if (only && sh.name !== only) continue;
    for (const d of sh.pivots) { const r = writePivot(wb, sh, d, true); if (!r.ok) bad.push({ name: d.name, why: r.why! }); }
  }
  if (bad.length < [...wb.sheets.values()].reduce((n, s) => n + s.pivots.length, 0)) wb.recalculate();
  return bad;
}

/** the pivot whose output covers a cell (for the "PivotTable" context: Refresh / Edit / Delete) */
export function pivotAt(sheet: Sheet, col: number, row: number): PivotDef | undefined { return sheet.pivots.find((p) => inRange(p.out, col, row)); }

/** Delete a PivotTable: its cells are cleared and the definition removed */
export function deletePivot(sheet: Sheet, def: PivotDef) {
  if (def.out) for (let r = def.out.r0; r <= def.out.r1; r++) for (let c = def.out.c0; c <= def.out.c1; c++) { sheet.setCell(c, r, ""); sheet.setStyle(c, r, { bold: undefined }); }
  sheet.pivots = sheet.pivots.filter((p) => p !== def);
}

/** structural sanitiser for definitions read from a .fworkbook */
export function sanitizePivot(x: unknown): PivotDef | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const src = o.src as Record<string, unknown> | undefined, anc = o.anchor as Record<string, unknown> | undefined, sp = o.spec as Record<string, unknown> | undefined;
  if (typeof o.name !== "string" || !src || typeof src.sheet !== "string" || typeof src.ref !== "string" || !parseA1Range(src.ref) || !anc || !sp) return null;
  const int = (v: unknown, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : null);
  const col = int(anc.col, 16383), row = int(anc.row, 1048575); if (col === null || row === null) return null;
  const ints = (a: unknown) => (Array.isArray(a) ? a.map((v) => int(v, 16383)).filter((v): v is number => v !== null).slice(0, 3) : []);
  const values = (Array.isArray(sp.values) ? sp.values : []).slice(0, 6).map((v) => v as Record<string, unknown>).filter((v) => int(v.field, 16383) !== null && typeof v.fn === "string").map((v) => ({ field: v.field as number, fn: v.fn as PivotSpec["values"][number]["fn"] }));
  const filters = (Array.isArray(sp.filters) ? sp.filters : []).slice(0, 8).map((f) => f as Record<string, unknown>).filter((f) => int(f.field, 16383) !== null && Array.isArray(f.include)).map((f) => ({ field: f.field as number, include: (f.include as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 20000) }));
  const out = o.out as Range | undefined;
  return { name: o.name.slice(0, 64), src: { sheet: src.sheet, ref: src.ref }, anchor: { col, row }, spec: { rows: ints(sp.rows), cols: ints(sp.cols).slice(0, 2), values, filters, grandRows: sp.grandRows !== false, grandCols: sp.grandCols !== false, subtotals: sp.subtotals !== false }, out: out && [out.c0, out.r0, out.c1, out.r1].every((v) => Number.isInteger(v) && v >= 0) ? { c0: out.c0, r0: out.r0, c1: out.c1, r1: out.r1 } : undefined };
}

/**
 * .xlsx persistence of the definitions: hidden, sheet-scoped defined names whose value is a string constant
 * (`_FusionPivot<i>_<j>` = chunk j of definition i's JSON). Excel keeps hidden names untouched; a string constant in a
 * name is limited to 255 characters, so the JSON is cut into 120-character chunks (quotes doubled on write).
 */
export const PIVOT_NAME_RE = /^_FusionPivot(\d+)_(\d+)$/;
const CHUNK = 120;
export function pivotNames(defs: PivotDef[]): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  defs.forEach((d, i) => {
    const json = JSON.stringify(d);
    for (let j = 0, k = 1; j < json.length; j += CHUNK, k++) out.push({ name: `_FusionPivot${i + 1}_${k}`, text: `"${json.slice(j, j + CHUNK).replace(/"/g, '""')}"` });
  });
  return out;
}
export function pivotsFromNames(items: { name: string; text: string }[]): PivotDef[] {
  const by = new Map<number, Map<number, string>>();
  for (const it of items) {
    const m = PIVOT_NAME_RE.exec(it.name); const t = /^"([\s\S]*)"$/.exec(it.text.trim());
    if (!m || !t) continue;
    const i = Number(m[1]), j = Number(m[2]); if (!by.has(i)) by.set(i, new Map()); by.get(i)!.set(j, t[1].replace(/""/g, '"'));
  }
  const defs: PivotDef[] = [];
  for (const i of [...by.keys()].sort((a, b) => a - b)) {
    const parts = by.get(i)!; const js = [...parts.keys()].sort((a, b) => a - b);
    if (js.some((j, n) => j !== n + 1)) continue;
    try { const d = sanitizePivot(JSON.parse(js.map((j) => parts.get(j)).join(""))); if (d) defs.push(d); } catch { /* a damaged definition is dropped; its cells stay */ }
  }
  return defs.slice(0, 100);
}
