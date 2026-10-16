/**
 * Sheet layout features (TT17): merged cells, cell borders, data validation, structural repair of all three.
 * Client-safe, pure, headless-testable (scripts/sheet-layout.mts; xlsx interop in scripts/oracle-xlsx.mts).
 *
 * Behaviour follows Microsoft Excel where it is documented (web-checked this turn):
 *  - Merging keeps only the "upper-left most data" (Excel's own dialog text): the first non-empty cell in
 *    reading order moves to the top-left cell; every other value in the area is deleted. Covered cells keep
 *    their formatting (it reappears on unmerge). Unmerge leaves the value in the top-left cell.
 *  - Sorting a range that contains merged cells is refused ("This operation requires the merged cells to be
 *    identically sized", Microsoft Learn). We refuse whenever a merge intersects the sort range — stricter
 *    than Excel's identically-sized exception (declared).
 *  - Pasting/clearing a block that covers only part of a merged area is refused ("We can't do that to a
 *    merged cell").
 *  - Data validation checks TYPED entries only; paste replaces cells without checking (as in Excel).
 *    Only errorStyle "stop" blocks; "warning"/"information" let the user keep the entry. A typed list source
 *    is limited to 255 characters (Excel repairs longer lists away on open), list matching is
 *    case-insensitive. OOXML `showDropDown="1"` HIDES the in-cell arrow (inverted name) — modelled as
 *    `inCellDropdown` here and inverted only at the file boundary.
 *  - Borders are stored per cell edge (ECMA-376 §18.8.4); the display of a shared edge takes the heavier of
 *    the two cells' sides.
 */
import { Sheet, Workbook, evalRaw, type BorderLine, type BorderSide, type CellBorder, type DataValidation, type EvalContext, type MergeRange, type ValidationOp, type ValidationType } from "./engine";
import { parseFormula } from "./parser";
import { colToLetters, isError, lettersToCol, type CellAddr, type RangeAddr, type Scalar } from "./types";
import { shiftFormula } from "./sheetops";

export type R = MergeRange;
const normR = (r: R): R => ({ c0: Math.min(r.c0, r.c1), r0: Math.min(r.r0, r.r1), c1: Math.max(r.c0, r.c1), r1: Math.max(r.r0, r.r1) });
export const intersects = (a: R, b: R) => a.c0 <= b.c1 && b.c0 <= a.c1 && a.r0 <= b.r1 && b.r0 <= a.r1;
export const contains = (outer: R, inner: R) => inner.c0 >= outer.c0 && inner.c1 <= outer.c1 && inner.r0 >= outer.r0 && inner.r1 <= outer.r1;
export const rangeRef = (r: R) => { const a = `${colToLetters(r.c0)}${r.r0 + 1}`, b = `${colToLetters(r.c1)}${r.r1 + 1}`; return a === b ? a : `${a}:${b}`; };
export function parseRef(s: string): R | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?$/i.exec(s.trim());
  if (!m) return null;
  const c0 = lettersToCol(m[1].toUpperCase()), r0 = Number(m[2]) - 1, c1 = m[3] ? lettersToCol(m[3].toUpperCase()) : c0, r1 = m[4] ? Number(m[4]) - 1 : r0;
  if (r0 < 0 || r1 < 0 || c0 > 16383 || c1 > 16383 || r0 > 1048575 || r1 > 1048575) return null;
  return normR({ c0, r0, c1, r1 });
}
/** sqref = space-separated list of refs (ECMA-376 ST_Sqref). Invalid parts are dropped. */
export const parseSqref = (sqref: string): R[] => sqref.trim().split(/\s+/).map(parseRef).filter((x): x is R => !!x).slice(0, 512);

/* ================================================================== merges */
export const mergeAt = (sheet: Sheet, col: number, row: number) => sheet.merges.find((m) => col >= m.c0 && col <= m.c1 && row >= m.r0 && row <= m.r1);
/** Excel selection rule: a selection touching part of a merged area grows to include all of it (to a fixed point). */
export function expandToMerges(sheet: Sheet, r: R): R {
  let cur = normR(r);
  for (let guard = 0; guard < 64; guard++) {
    let next = cur;
    for (const m of sheet.merges) if (intersects(m, next) && !contains(next, m)) next = { c0: Math.min(next.c0, m.c0), r0: Math.min(next.r0, m.r0), c1: Math.max(next.c1, m.c1), r1: Math.max(next.r1, m.r1) };
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}
export type MergeResult = { ok: true; discarded: number; kept: string | null } | { ok: false; error: string };
export function mergeCells(sheet: Sheet, range: R): MergeResult {
  const r = normR(range);
  if (r.c0 === r.c1 && r.r0 === r.r1) return { ok: false, error: "select at least two cells to merge" };
  if ((r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1) > 1_000_000) return { ok: false, error: "merge area too large (1,000,000 cells max)" };
  if (sheet.merges.some((m) => intersects(m, r) && !contains(r, m))) return { ok: false, error: "We can't do that to a merged cell: the selection covers part of an existing merged area" };
  sheet.merges = sheet.merges.filter((m) => !contains(r, m));
  // upper-left most data, reading order
  const filled: { col: number; row: number }[] = [];
  for (const [k, cell] of sheet.grid) { if (cell.input === "") continue; const [col, row] = k.split(",").map(Number); if (col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1) filled.push({ col, row }); }
  filled.sort((a, b) => a.row - b.row || a.col - b.col);
  const keep = filled[0] ? sheet.get(filled[0].col, filled[0].row)!.input : null;
  for (const f of filled) sheet.setCell(f.col, f.row, "");
  if (keep !== null) sheet.setCell(r.c0, r.r0, keep);
  sheet.merges.push(r);
  return { ok: true, discarded: Math.max(0, filled.length - 1), kept: keep };
}
/** Merge Across: one merge per row of the selection (single-column rows are skipped). */
export function mergeAcross(sheet: Sheet, range: R): { merged: number; discarded: number; error?: string } {
  const r = normR(range); let merged = 0, discarded = 0;
  if (r.c0 === r.c1) return { merged, discarded, error: "Merge Across needs at least two columns" };
  for (let row = r.r0; row <= r.r1; row++) { const res = mergeCells(sheet, { c0: r.c0, r0: row, c1: r.c1, r1: row }); if (!res.ok) return { merged, discarded, error: res.error }; merged++; discarded += res.discarded; }
  return { merged, discarded };
}
export function unmergeCells(sheet: Sheet, range: R): number {
  const r = normR(range); const before = sheet.merges.length;
  sheet.merges = sheet.merges.filter((m) => !intersects(m, r));
  return before - sheet.merges.length;
}
/** Error text when an operation would change only part of a merged area, else null. */
export function partialMergeConflict(sheet: Sheet, range: R): string | null {
  const r = normR(range);
  return sheet.merges.some((m) => intersects(m, r) && !contains(r, m)) ? "We can't do that to a merged cell." : null;
}
export function sortConflict(sheet: Sheet, range: R): string | null {
  return sheet.merges.some((m) => intersects(m, normR(range))) ? "This operation requires the merged cells to be identically sized. Unmerge the cells in the sort range first." : null;
}
/** Keyboard step that treats a merged area as one cell (Excel): leave from the area's far edge, land on anchors. */
export function stepCell(sheet: Sheet, pos: { col: number; row: number }, dCol: number, dRow: number, maxCol: number, maxRow: number) {
  const m = mergeAt(sheet, pos.col, pos.row);
  let col = pos.col, row = pos.row;
  if (m) { if (dCol > 0) col = m.c1; if (dCol < 0) col = m.c0; if (dRow > 0) row = m.r1; if (dRow < 0) row = m.r0; }
  col = Math.max(0, Math.min(maxCol, col + dCol)); row = Math.max(0, Math.min(maxRow, row + dRow));
  const t = mergeAt(sheet, col, row);
  return t ? { col: t.c0, row: t.r0 } : { col, row };
}

/* ================================================================== structure repair (insert/delete rows/cols) */
/** Shift/shrink/grow a range for an insert (count>0) or delete (count<0) at index `at` on `axis`; null = deleted. */
export function adjustRange(r: R, axis: "row" | "col", at: number, count: number): R | null {
  const lo = axis === "row" ? r.r0 : r.c0, hi = axis === "row" ? r.r1 : r.c1;
  let nlo = lo, nhi = hi;
  if (count > 0) { if (lo >= at) { nlo += count; nhi += count; } else if (hi >= at) nhi += count; }
  else if (count < 0) {
    const n = -count, end = at + n;
    nlo = lo >= end ? lo - n : lo >= at ? at : lo;
    nhi = hi >= end ? hi - n : hi >= at ? at - 1 : hi;
    if (nhi < nlo) return null;
  }
  return axis === "row" ? { ...r, r0: nlo, r1: nhi } : { ...r, c0: nlo, c1: nhi };
}
export function adjustLayoutForStructure(sheet: Sheet, axis: "row" | "col", at: number, count: number) {
  sheet.merges = sheet.merges.map((m) => adjustRange(m, axis, at, count)).filter((m): m is R => !!m && !(m.c0 === m.c1 && m.r0 === m.r1));
  sheet.validations = sheet.validations.map((v) => {
    const parts = parseSqref(v.sqref).map((p) => adjustRange(p, axis, at, count)).filter((p): p is R => !!p);
    return parts.length ? { ...v, sqref: parts.map(rangeRef).join(" ") } : null;
  }).filter((v): v is DataValidation => !!v);
  if (axis === "row" && sheet.freezeRows > 0 && count < 0 && at < sheet.freezeRows) sheet.freezeRows = Math.max(0, sheet.freezeRows - Math.min(-count, sheet.freezeRows - at));
  if (axis === "col" && sheet.freezeCols > 0 && count < 0 && at < sheet.freezeCols) sheet.freezeCols = Math.max(0, sheet.freezeCols - Math.min(-count, sheet.freezeCols - at));
}

/* ================================================================== borders */
export type BorderPreset = "all" | "outside" | "inside" | "top" | "bottom" | "left" | "right" | "none" | "thickOutside" | "bottomDouble";
const LINES: BorderLine[] = ["thin", "medium", "thick", "dashed", "dotted", "double", "hair"];
export const isBorderLine = (x: unknown): x is BorderLine => typeof x === "string" && (LINES as string[]).includes(x);
/** Display precedence for a shared edge (heavier wins). */
const WEIGHT: Record<BorderLine, number> = { hair: 1, dotted: 2, dashed: 3, thin: 4, medium: 5, double: 6, thick: 7 };
export function applyBorders(sheet: Sheet, range: R, preset: BorderPreset, side: BorderSide = { style: "thin" }) {
  const r = normR(range);
  if ((r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1) > 200_000) throw new Error("border range too large (200,000 cells max)");
  const line = preset === "thickOutside" ? { ...side, style: "thick" as const } : preset === "bottomDouble" ? { ...side, style: "double" as const } : side;
  for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) {
    const cur: CellBorder = { ...(sheet.get(col, row)?.style?.border ?? {}) };
    if (preset === "none") { sheet.setStyle(col, row, { border: undefined }); continue; }
    const top = row === r.r0, bottom = row === r.r1, left = col === r.c0, right = col === r.c1;
    const set = (k: keyof CellBorder, on: boolean) => { if (on) cur[k] = { ...line }; };
    switch (preset) {
      case "all": set("top", true); set("bottom", true); set("left", true); set("right", true); break;
      case "outside": case "thickOutside": set("top", top); set("bottom", bottom); set("left", left); set("right", right); break;
      case "inside": set("top", !top); set("bottom", !bottom); set("left", !left); set("right", !right); break;
      case "top": set("top", top); break;
      case "bottom": case "bottomDouble": set("bottom", bottom); break;
      case "left": set("left", left); break;
      case "right": set("right", right); break;
    }
    sheet.setStyle(col, row, { border: Object.keys(cur).length ? cur : undefined });
  }
}
const heavier = (a?: BorderSide, b?: BorderSide) => (!a ? b : !b ? a : WEIGHT[b.style] > WEIGHT[a.style] ? b : a);
/** Effective display of an edge: own side vs the neighbour's facing side. */
export function edgeAt(sheet: Sheet, col: number, row: number, side: keyof CellBorder): BorderSide | undefined {
  const own = sheet.get(col, row)?.style?.border?.[side];
  const nb = side === "right" ? sheet.get(col + 1, row)?.style?.border?.left : side === "bottom" ? sheet.get(col, row + 1)?.style?.border?.top
    : side === "left" ? (col > 0 ? sheet.get(col - 1, row)?.style?.border?.right : undefined) : row > 0 ? sheet.get(col, row - 1)?.style?.border?.bottom : undefined;
  return heavier(own, nb);
}
/** CSS for one edge. */
export function borderCss(b?: BorderSide): string | undefined {
  if (!b) return undefined;
  const c = b.color ?? "#e5e7eb";
  switch (b.style) {
    case "hair": return `1px dotted ${c}`; case "dotted": return `1px dotted ${c}`; case "dashed": return `1px dashed ${c}`;
    case "thin": return `1px solid ${c}`; case "medium": return `2px solid ${c}`; case "double": return `3px double ${c}`; case "thick": return `3px solid ${c}`;
  }
}

/* ================================================================== data validation */
export const VALIDATION_TYPES: ValidationType[] = ["list", "whole", "decimal", "textLength", "date", "custom"];
export const VALIDATION_OPS: ValidationOp[] = ["between", "notBetween", "equal", "notEqual", "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"];
export const LIST_LITERAL_MAX = 255;
export const ruleAt = (sheet: Sheet, col: number, row: number) => sheet.validations.find((v) => parseSqref(v.sqref).some((r) => col >= r.c0 && col <= r.c1 && row >= r.r0 && row <= r.r1));

/** Evaluate a formula body (no "=") against current workbook values. */
export function evalExpr(wb: Workbook, sheetName: string, body: string, cursor?: { col: number; row: number }): Scalar | Scalar[][] {
  const node = parseFormula(`=${body}`);
  const sheetOf = (a: CellAddr) => a.sheet ?? sheetName;
  const ctx: EvalContext = {
    resolveRef: (a: CellAddr) => wb.valueAt(sheetOf(a), a.col, a.row) ?? "",
    resolveRange: (rg: RangeAddr) => {
      const s = sheetOf(rg.from), r0 = Math.min(rg.from.row, rg.to.row), r1 = Math.max(rg.from.row, rg.to.row), c0 = Math.min(rg.from.col, rg.to.col), c1 = Math.max(rg.from.col, rg.to.col);
      if ((r1 - r0 + 1) * (c1 - c0 + 1) > 100_000) throw new Error("range too large");
      return Array.from({ length: r1 - r0 + 1 }, (_, i) => Array.from({ length: c1 - c0 + 1 }, (_, j) => wb.valueAt(s, c0 + j, r0 + i) ?? ""));
    },
    cursor: cursor ? { sheet: sheetName, ...cursor } : undefined,
  };
  return evalRaw(node, ctx) as Scalar | Scalar[][];
}
const scalarOf = (v: Scalar | Scalar[][]): Scalar => (Array.isArray(v) ? (v[0]?.[0] ?? "") : v);
const numOf = (v: Scalar): number | null => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : typeof v === "boolean" ? null : null);
const shown = (v: Scalar) => (isError(v) ? v.error : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));

export function listItems(wb: Workbook, sheetName: string, rule: DataValidation): string[] {
  const f = rule.formula1.trim();
  if (f.startsWith('"')) return f.replace(/^"|"$/g, "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  try {
    const v = evalExpr(wb, sheetName, f);
    const flat = Array.isArray(v) ? v.flat() : [v];
    return flat.filter((x) => x !== "" && !isError(x)).map(shown).slice(0, 10_000);
  } catch { return []; }
}
function compare(op: ValidationOp, x: number, a: number, b: number) {
  switch (op) {
    case "between": return x >= Math.min(a, b) && x <= Math.max(a, b);
    case "notBetween": return x < Math.min(a, b) || x > Math.max(a, b);
    case "equal": return x === a; case "notEqual": return x !== a;
    case "greaterThan": return x > a; case "lessThan": return x < a;
    case "greaterThanOrEqual": return x >= a; case "lessThanOrEqual": return x <= a;
  }
}
/** Does `value` (the resulting cell value) satisfy the rule at (col,row)? */
export function satisfies(wb: Workbook, sheetName: string, rule: DataValidation, col: number, row: number, value: Scalar | undefined): boolean {
  if (value === undefined || value === "") return rule.allowBlank;
  if (isError(value)) return false;
  const bound = (f?: string) => { if (f === undefined || f === "") return NaN; try { const n = numOf(scalarOf(evalExpr(wb, sheetName, f, { col, row }))); return n ?? NaN; } catch { return NaN; } };
  const op = rule.operator ?? "between";
  const a = bound(rule.formula1), b = op === "between" || op === "notBetween" ? bound(rule.formula2) : NaN;
  if (rule.type !== "list" && rule.type !== "custom" && (Number.isNaN(a) || ((op === "between" || op === "notBetween") && Number.isNaN(b)))) return false;
  switch (rule.type) {
    case "list": { const s = shown(value).toLowerCase(); return listItems(wb, sheetName, rule).some((x) => x.toLowerCase() === s); }
    case "whole": return typeof value === "number" && Number.isInteger(value) && compare(op, value, a, b);
    case "decimal": case "date": return typeof value === "number" && compare(op, value, a, b);
    case "textLength": return compare(op, shown(value).length, a, b);
    case "custom": {
      const first = parseSqref(rule.sqref)[0]; if (!first) return false;
      try {
        const body = shiftFormula(`=${rule.formula1}`, col - first.c0, row - first.r0).slice(1);
        const v = scalarOf(evalExpr(wb, sheetName, body, { col, row }));
        return v === true || (typeof v === "number" && v !== 0);
      } catch { return false; }
    }
  }
}
export interface EntryCheck { ok: boolean; rule?: DataValidation; value?: Scalar; message?: string; title?: string }
/**
 * Excel entry semantics: set the input, recalculate, test the resulting value. Invalid entries are ROLLED BACK
 * (caller re-applies after a warning/information confirmation). A rule with showError=false never blocks.
 */
export function validateEntry(wb: Workbook, sheetName: string, col: number, row: number, input: string): EntryCheck {
  const sheet = wb.sheet(sheetName); const rule = ruleAt(sheet, col, row);
  const prev = sheet.get(col, row)?.input ?? "";
  sheet.setCell(col, row, input); wb.recalculate();
  if (!rule || !rule.showError) return { ok: true, rule, value: wb.valueAt(sheetName, col, row) };
  const value = wb.valueAt(sheetName, col, row);
  if (satisfies(wb, sheetName, rule, col, row, value)) return { ok: true, rule, value };
  sheet.setCell(col, row, prev); wb.recalculate();
  return { ok: false, rule, value, title: rule.errorTitle || "Invalid entry", message: rule.error || "This value doesn't match the data validation restrictions defined for this cell." };
}
/** "Circle Invalid Data": existing cells (within the used area) that violate their rule. */
export function invalidCells(wb: Workbook, sheetName: string, limit = 5000): { col: number; row: number }[] {
  const sheet = wb.sheet(sheetName); const out: { col: number; row: number }[] = [];
  for (const rule of sheet.validations) for (const r of parseSqref(rule.sqref)) {
    if ((r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1) > 100_000) continue;
    for (let row = r.r0; row <= r.r1; row++) for (let col = r.c0; col <= r.c1; col++) {
      const v = wb.valueAt(sheetName, col, row);
      if ((v === undefined || v === "") && rule.allowBlank) continue;
      if (!satisfies(wb, sheetName, rule, col, row, v)) { out.push({ col, row }); if (out.length >= limit) return out; }
    }
  }
  return out;
}
/** Untrusted → valid rule (or null). Enforces the 255-char typed-list limit. */
export function sanitizeValidation(raw: unknown, idHint = "v"): DataValidation | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof o[k] === "string" ? (o[k] as string).slice(0, max) : undefined);
  const type = o.type as ValidationType; if (!VALIDATION_TYPES.includes(type)) return null;
  const sq = parseSqref(str("sqref", 2000) ?? ""); if (!sq.length) return null;
  const formula1 = (str("formula1", 1024) ?? "").replace(/^=/, ""); if (!formula1) return null;
  if (type === "list" && formula1.startsWith('"') && formula1.length - 2 > LIST_LITERAL_MAX) return null;
  const operator = VALIDATION_OPS.includes(o.operator as ValidationOp) ? (o.operator as ValidationOp) : undefined;
  const es = o.errorStyle === "warning" || o.errorStyle === "information" ? o.errorStyle : "stop";
  const v: DataValidation = {
    id: (str("id", 40) ?? idHint).replace(/[^\w-]/g, "") || idHint, sqref: sq.map(rangeRef).join(" "), type, formula1,
    allowBlank: o.allowBlank !== false, errorStyle: es, showError: o.showError !== false, inCellDropdown: o.inCellDropdown !== false,
  };
  if (operator && type !== "list" && type !== "custom") v.operator = operator;
  const f2 = str("formula2", 1024); if (f2) v.formula2 = f2.replace(/^=/, "");
  for (const k of ["errorTitle", "promptTitle"] as const) { const x = str(k, 32); if (x) v[k] = x; }
  for (const k of ["error", "prompt"] as const) { const x = str(k, 255); if (x) v[k] = x; }
  return v;
}
/** Build a typed list rule from items; throws if the joined source exceeds Excel's 255-character limit or contains a comma/quote. */
export function listFormula(items: string[]): string {
  const clean = items.map((x) => x.trim()).filter(Boolean);
  if (clean.some((x) => x.includes(",") || x.includes('"'))) throw new Error("list items cannot contain commas or quotes (use a cell range source instead)");
  const joined = clean.join(",");
  if (joined.length > LIST_LITERAL_MAX) throw new Error(`typed list is ${joined.length} characters; Excel's limit is ${LIST_LITERAL_MAX} (use a cell range source instead)`);
  return `"${joined}"`;
}
