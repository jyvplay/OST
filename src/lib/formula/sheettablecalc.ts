/**
 * TT78 — Excel table calculated columns and table auto-expansion (Excel "AutoCorrect ▸ AutoFormat As You Type":
 * "Include new rows and columns in table" and "Fill formulas in tables to create calculated columns").
 *
 * Model. A table T keeps calc: column → formula f (file <tableColumn><calculatedColumnFormula>, ECMA-376 §18.5.1.1),
 * written as the formula of T's FIRST BODY ROW (verified on the POI corpus: ConditionalFormattingSamples table4
 * A3:G9 stores AVERAGE(B4:F4), ExcelTables G1:I4 stores INT(H2/10)). The formula a body row R should hold is f shifted
 * by R − firstBody (relative refs move, $ refs and structured refs do not). Rules, applied after ONE cell edit (Enter
 * or the formula bar; paste / fill / sort are not "as you type" and never trigger them, as in Excel):
 *   F1  a formula typed into a body cell of column k whose other body cells are all empty fills every body row and
 *       records calc[k];
 *   F2  a formula typed into a column that is a consistent calculated column (every other body cell holds calc[k]
 *       shifted) refills the column and replaces calc[k];
 *   F3  a formula typed into a column holding other data fills nothing (Excel shows the AutoCorrect "Overwrite all
 *       cells in this column" option instead — reported as a note here);
 *   E1  a constant typed into a calculated column is an exception: calc[k] is kept, the other rows are untouched;
 *       clearing the last non-empty body cell of the column drops calc[k];
 *   X1  a non-empty entry directly below a table without a totals row (inside its columns, not inside another table)
 *       grows the table by that row; calculated columns fill the new row;
 *   X2  a non-empty entry directly right of a table (header … last row) grows it by a column, named from the header
 *       text (made unique) or ColumnK, with the header cell written;
 *   S1  rows inserted inside the body are filled from calc (Excel), structural moves keep calc anchored at the first
 *       body row (repaired like a cell formula located there).
 */
import { type Workbook, type TableDef } from "./engine";
import { shiftFormula, adjustForStructure } from "./sheetops";
import { tableColumnNames, defaultColumnName } from "./sheettables";

export const firstBody = (t: TableDef) => t.r0 + t.headerRows;
export const lastBody = (t: TableDef) => t.r1 - t.totalsRows;
const nameAt = (t: TableDef, col: number) => tableColumnNames(t)[col - t.c0]?.toLowerCase();
/** the formula (with "=") row `row` of column `col` should hold, or null when the column is not calculated */
export function calcInputAt(t: TableDef, col: number, row: number): string | null {
  const k = nameAt(t, col); const f = k ? t.calc?.[k] : undefined; if (!f) return null;
  return shiftFormula("=" + f, 0, row - firstBody(t));
}
const empty = (wb: Workbook, sheet: string, c: number, r: number) => { const x = wb.sheets.get(sheet)?.get(c, r); return !x || x.input === ""; };
const inputOf = (wb: Workbook, sheet: string, c: number, r: number) => wb.sheets.get(sheet)?.get(c, r)?.input ?? "";
function tableAt(wb: Workbook, sheet: string, c: number, r: number): TableDef | undefined {
  for (const t of wb.tables.values()) if (t.sheet === sheet && c >= t.c0 && c <= t.c1 && r >= t.r0 && r <= t.r1) return t;
  return undefined;
}
const MAX_FILL = 200_000;

/** fill rows of every calculated column of t (skipping `except` = the cell the user just typed) */
export function fillCalcRows(wb: Workbook, t: TableDef, rows: number[], except?: { c: number; r: number }): number {
  if (!t.calc || !Object.keys(t.calc).length) return 0;
  const s = wb.sheets.get(t.sheet); if (!s) return 0; let n = 0;
  for (let c = t.c0; c <= t.c1; c++) {
    if (!calcInputAt(t, c, firstBody(t))) continue;
    for (const r of rows) {
      if (r < firstBody(t) || r > lastBody(t) || (except && except.c === c && except.r === r)) continue;
      const style = s.get(c, r)?.style; s.setCell(c, r, calcInputAt(t, c, r)!); if (style) s.setStyle(c, r, style); n++;
    }
  }
  return n;
}

export interface CalcOutcome { changed: boolean; note?: string }

/** apply F1–F3 / E1 / X1 / X2 after `input` was stored at (col,row) by a single typed edit */
export function afterTypedEntry(wb: Workbook, sheet: string, col: number, row: number, input: string): CalcOutcome {
  const isFormula = input.startsWith("=") && input.length > 1;
  let t = tableAt(wb, sheet, col, row);
  let note: string | undefined; let grown = false;
  if (!t && input !== "") {
    // X1: directly below
    for (const u of wb.tables.values()) {
      if (u.sheet !== sheet || u.totalsRows || row !== u.r1 + 1 || col < u.c0 || col > u.c1 || row >= 1048576) continue;
      if ([...wb.tables.values()].some((o) => o !== u && o.sheet === sheet && o.c0 <= u.c1 && u.c0 <= o.c1 && o.r0 <= row && row <= o.r1)) continue;
      u.r1 = row; t = u; grown = true;
      fillCalcRows(wb, u, [row], isFormula ? undefined : { c: col, r: row });
      note = `table ${u.name} grew to include row ${row + 1}`; break;
    }
    // X2: directly right
    if (!t) for (const u of wb.tables.values()) {
      if (u.sheet !== sheet || col !== u.c1 + 1 || row < u.r0 || row > u.r1 || col >= 16384) continue;
      if ([...wb.tables.values()].some((o) => o !== u && o.sheet === sheet && o.c0 <= col && col <= o.c1 && o.r0 <= u.r1 && u.r0 <= o.r1)) continue;
      const taken = tableColumnNames(u);
      let nm = u.headerRows && row === u.r0 && !isFormula ? String(wb.sheets.get(sheet)?.get(col, row)?.value ?? input).trim() : "";
      if (!nm) nm = defaultColumnName(taken);
      const base = nm; for (let k = 2; taken.some((x) => x.toLowerCase() === nm.toLowerCase()); k++) nm = `${base}${k}`;
      u.c1 = col; u.columns = [...u.columns, nm];
      const s = wb.sheets.get(sheet)!;
      if (u.headerRows && (row !== u.r0 || nm !== input)) s.setCell(col, u.r0, nm);
      t = u; grown = true; note = `table ${u.name} grew to include column ${nm}`; break;
    }
    if (!t) return { changed: false };
  }
  if (!t || row < firstBody(t) || row > lastBody(t)) return { changed: grown, ...(note ? { note } : {}) };
  const k = nameAt(t, col)!; const fb = firstBody(t), lb = lastBody(t);
  if (lb - fb + 1 > MAX_FILL) return { changed: grown, note: "table too long for automatic calculated columns" };
  const others: number[] = []; for (let r = fb; r <= lb; r++) if (r !== row) others.push(r);
  if (isFormula) {
    const allEmpty = others.every((r) => empty(wb, sheet, col, r));
    const consistent = !!t.calc?.[k] && others.every((r) => inputOf(wb, sheet, col, r) === calcInputAt(t!, col, r));
    if (allEmpty || consistent) {
      t.calc = { ...(t.calc ?? {}), [k]: shiftFormula(input, 0, fb - row).slice(1) };
      const s = wb.sheets.get(sheet)!;
      for (const r of others) { const style = s.get(col, r)?.style; s.setCell(col, r, calcInputAt(t, col, r)!); if (style) s.setStyle(col, r, style); }
      return { changed: true, note: `calculated column ${tableColumnNames(t)[col - t.c0]} filled (${others.length + 1} rows)` };
    }
    return { changed: grown, note: `formula not filled down: other cells in column ${tableColumnNames(t)[col - t.c0]} already hold data` };
  }
  if (t.calc?.[k]) {
    if (input === "" && others.every((r) => empty(wb, sheet, col, r))) { const c = { ...t.calc }; delete c[k]; if (Object.keys(c).length) t.calc = c; else delete t.calc; return { changed: true }; }
    if (input !== "") return { changed: grown, note: `exception in calculated column ${tableColumnNames(t)[col - t.c0]}` };
  }
  return { changed: grown, ...(note ? { note } : {}) };
}

/** S1, before the grid moves: where each table's calc is anchored (a body row that survives the edit) */
export interface CalcAnchor { t: TableDef; anchor: number; fb: number }
export function calcAnchors(wb: Workbook, sheet: string, axis: "row" | "col", at: number, count: number): CalcAnchor[] {
  const out: CalcAnchor[] = [];
  for (const t of wb.tables.values()) {
    if (t.sheet !== sheet || !t.calc) continue;
    const fb = firstBody(t); let a = fb;
    if (axis === "row" && count < 0) { const end = at - count; while (a >= at && a < end && a <= lastBody(t)) a++; if (a >= at && a < end) a = fb; }
    out.push({ t, anchor: a, fb });
  }
  return out;
}
/** S1, after the grid and tables moved: repair each calc formula like a cell formula at its anchor, re-anchor it at the
 *  new first body row, drop calc entries of deleted columns, and fill inserted body rows */
export function adjustCalcForStructure(wb: Workbook, sheet: string, axis: "row" | "col", at: number, count: number, anchors: CalcAnchor[]): void {
  const live = new Set(wb.tables.values());
  for (const { t, anchor, fb } of anchors) {
    if (!live.has(t) || !t.calc) continue;
    const names = new Set(tableColumnNames(t).map((x) => x.toLowerCase()));
    const mv = (v: number) => (count > 0 ? (v >= at ? v + count : v) : v >= at - count ? v + count : v);
    const newAnchor = axis === "row" ? mv(anchor) : anchor;
    const next: Record<string, string> = {};
    for (const [k, f] of Object.entries(t.calc)) {
      if (!names.has(k)) continue;
      const fixed = adjustForStructure(shiftFormula("=" + f, 0, anchor - fb), sheet, sheet, axis, at, count);
      next[k] = shiftFormula(fixed, 0, firstBody(t) - newAnchor).slice(1);
    }
    if (Object.keys(next).length) t.calc = next; else delete t.calc;
    if (axis === "row" && count > 0) { const rows: number[] = []; for (let r = at; r < at + count; r++) rows.push(r); fillCalcRows(wb, t, rows); }
  }
}
