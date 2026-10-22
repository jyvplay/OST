/**
 * TT58 PivotTable engine (original code; Excel semantics written from Microsoft's documentation, no code borrowed).
 *
 * A pivot summarises a source table (first row = field names) by up to 3 row fields and up to 2 column fields:
 *   - item order: ascending — numbers, then text (case-insensitive, then binary), then FALSE / TRUE, then "(blank)" last
 *   - filters keep only records whose field value (as its item label) is in the include list
 *   - summary functions: Sum, Count (non-empty cells, Excel's default for text fields), Average, Max, Min, Product,
 *     Count Numbers, StdDev / StdDevp, Var / Varp — numeric functions ignore text, logicals and blanks
 *   - an empty intersection shows as blank (not 0); Average / StdDev / Var of no numbers show "#DIV/0!" like Excel
 *   - layout = Excel's Tabular Form: one column per row field, subtotal rows for every outer row field
 *     ("<item> Total"), a Grand Total row and (with column fields) a Grand Total column. Several value fields become
 *     the innermost column level ("Sum of Sales", "Count of Region"), as with Excel's Σ Values field.
 * The output is a plain grid of values: it is written into cells and recomputed on Refresh from the definition.
 */
export type PVal = number | string | boolean | null | { e: string };
const isErr = (v: PVal): v is { e: string } => typeof v === "object" && v !== null;
export type PivotFn = "sum" | "count" | "average" | "max" | "min" | "product" | "countNums" | "stdDev" | "stdDevp" | "var" | "varp";
export interface PivotValue { field: number; fn: PivotFn }
export interface PivotSpec { rows: number[]; cols: number[]; values: PivotValue[]; filters?: { field: number; include: string[] }[]; grandRows?: boolean; grandCols?: boolean; subtotals?: boolean }
export interface PivotResult { grid: PVal[][]; /** rows of the grid that are headers / subtotals / grand totals (for styling) */ headerRows: number; /** first header row holding column items */ colHeaderStart: number; totalRows: number[]; grandRow?: number; grandCol?: number; records: number }

export const FN_LABEL: Record<PivotFn, string> = { sum: "Sum", count: "Count", average: "Average", max: "Max", min: "Min", product: "Product", countNums: "Count Numbers", stdDev: "StdDev", stdDevp: "StdDevp", var: "Var", varp: "Varp" };
export const PIVOT_LIMITS = { maxSourceRows: 200_000, maxRowItems: 20_000, maxColItems: 500, maxRowFields: 3, maxColFields: 2, maxValues: 6 };

const BLANK = "(blank)";
const isBlank = (v: PVal) => v === null || v === undefined || v === "";
/** the item label Excel shows for a cell value */
export function itemLabel(v: PVal): string {
  if (isBlank(v)) return BLANK;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (isErr(v)) return v.e;
  return String(v);
}
/** a stable key for grouping that keeps 1 and "1" apart (Excel does too) */
const keyOf = (v: PVal) => (isBlank(v) ? "b:" : isErr(v) ? `e:${v.e}` : typeof v === "number" ? `n:${v}` : typeof v === "boolean" ? `l:${v}` : `s:${String(v).toLowerCase()}`);
const rank = (v: PVal) => (isBlank(v) ? 4 : isErr(v) ? 3 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
export function compareItems(a: PVal, b: PVal): number {
  const ra = rank(a), rb = rank(b); if (ra !== rb) return ra - rb;
  if (ra === 0) return (a as number) - (b as number);
  if (ra === 1) { const x = String(a).toLowerCase(), y = String(b).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  if (ra === 2) return Number(a) - Number(b);
  if (ra === 3) { const x = (a as { e: string }).e, y = (b as { e: string }).e; return x < y ? -1 : x > y ? 1 : 0; }
  return 0;
}

class Acc {
  /** the first error value seen: numeric summaries of a range holding an error show that error (Excel) */
  err?: string;
  n = 0; nonEmpty = 0; sum = 0; prod = 1; min = Infinity; max = -Infinity; m = 0; s = 0; // Welford for variance
  add(v: PVal) {
    if (!isBlank(v)) this.nonEmpty++;
    if (isErr(v)) { this.err ??= v.e; return; }
    if (typeof v !== "number" || !Number.isFinite(v)) return;
    this.n++; this.sum += v; this.prod *= v; if (v < this.min) this.min = v; if (v > this.max) this.max = v;
    const d = v - this.m; this.m += d / this.n; this.s += d * (v - this.m);
  }
  get(fn: PivotFn): PVal {
    if (this.err !== undefined && fn !== "count") return { e: this.err };
    switch (fn) {
      case "count": return this.nonEmpty;
      case "countNums": return this.n;
      case "sum": return this.n ? this.sum : 0;
      case "product": return this.n ? this.prod : 0;
      case "max": return this.n ? this.max : 0;
      case "min": return this.n ? this.min : 0;
      case "average": return this.n ? this.sum / this.n : "#DIV/0!";
      case "var": return this.n > 1 ? this.s / (this.n - 1) : "#DIV/0!";
      case "varp": return this.n ? this.s / this.n : "#DIV/0!";
      case "stdDev": return this.n > 1 ? Math.sqrt(this.s / (this.n - 1)) : "#DIV/0!";
      case "stdDevp": return this.n ? Math.sqrt(this.s / this.n) : "#DIV/0!";
    }
  }
}

interface Node { key: string; value: PVal; kids: Map<string, Node>; }
const node = (value: PVal): Node => ({ key: keyOf(value), value, kids: new Map() });
function insertPath(root: Node, path: PVal[]) { let n = root; for (const v of path) { const k = keyOf(v); let c = n.kids.get(k); if (!c) { c = node(v); n.kids.set(k, c); } n = c; } }
const sortedKids = (n: Node) => [...n.kids.values()].sort((a, b) => compareItems(a.value, b.value));
/** depth-first leaves of a tree as value paths */
function leaves(n: Node, depth: number, prefix: PVal[] = []): PVal[][] {
  if (depth === 0) return [prefix];
  return sortedKids(n).flatMap((c) => leaves(c, depth - 1, [...prefix, c.value]));
}

export function validateSpec(header: PVal[], spec: PivotSpec): string | null {
  const nf = header.length;
  const bad = (i: number) => !Number.isInteger(i) || i < 0 || i >= nf;
  if (!spec.values.length && !spec.rows.length && !spec.cols.length) return "Choose at least one field.";
  if (spec.rows.length > PIVOT_LIMITS.maxRowFields) return `At most ${PIVOT_LIMITS.maxRowFields} row fields.`;
  if (spec.cols.length > PIVOT_LIMITS.maxColFields) return `At most ${PIVOT_LIMITS.maxColFields} column fields.`;
  if (spec.values.length > PIVOT_LIMITS.maxValues) return `At most ${PIVOT_LIMITS.maxValues} value fields.`;
  if ([...spec.rows, ...spec.cols, ...spec.values.map((v) => v.field), ...(spec.filters ?? []).map((f) => f.field)].some(bad)) return "A field is outside the source range.";
  const axis = [...spec.rows, ...spec.cols];
  if (new Set(axis).size !== axis.length) return "A field can be on only one of Rows / Columns.";
  if (spec.values.some((v) => !(v.fn in FN_LABEL))) return "Unknown summary function.";
  if (header.some((h) => isBlank(h))) return "Every column of the source needs a heading (the PivotTable field name).";
  return null;
}

/** compute a pivot over `table` (row 0 = field names). Throws on an invalid spec or a source over the limits. */
export function computePivot(table: PVal[][], spec: PivotSpec): PivotResult {
  const header = table[0] ?? [];
  const err = validateSpec(header, spec); if (err) throw new Error(err);
  if (table.length - 1 > PIVOT_LIMITS.maxSourceRows) throw new Error(`The source has more than ${PIVOT_LIMITS.maxSourceRows} records.`);
  const grandRows = spec.grandRows !== false, grandCols = spec.grandCols !== false, subtotals = spec.subtotals !== false;
  const filters = (spec.filters ?? []).map((f) => ({ field: f.field, inc: new Set(f.include) }));
  let recs = table.slice(1).filter((r) => r.some((v) => !isBlank(v)));
  // the pivot cache holds ONE item per (case-insensitive) value, captioned by its first occurrence in the source
  const axis = new Set([...spec.rows, ...spec.cols, ...filters.map((f) => f.field)]);
  const canon = new Map<number, Map<string, PVal>>();
  for (const f of axis) { const m = new Map<string, PVal>(); for (const r of recs) { const v = r[f] ?? null; const k = keyOf(v); if (!m.has(k)) m.set(k, v); } canon.set(f, m); }
  const cv = (r: PVal[], f: number): PVal => canon.get(f)!.get(keyOf(r[f] ?? null)) ?? null;
  recs = recs.filter((r) => filters.every((f) => f.inc.has(itemLabel(cv(r, f.field)))));
  const vals = spec.values.length ? spec.values : [{ field: spec.rows[0] ?? spec.cols[0], fn: "count" as PivotFn }];
  const nv = vals.length;
  // trees of row / column items, and accumulators per (row path prefix, col path prefix, value)
  const rowRoot = node(null), colRoot = node(null);
  const acc = new Map<string, Acc>();
  const A = (rk: string, ck: string, vi: number) => { const k = `${rk}\u0001${ck}\u0001${vi}`; let a = acc.get(k); if (!a) { a = new Acc(); acc.set(k, a); } return a; };
  for (const r of recs) {
    const rp = spec.rows.map((f) => cv(r, f)), cp = spec.cols.map((f) => cv(r, f));
    insertPath(rowRoot, rp); insertPath(colRoot, cp);
    // every prefix of the row path × every prefix of the column path (prefix [] = total)
    const rks: string[] = [""]; for (let i = 0; i < rp.length; i++) rks.push(rks[i] + "|" + keyOf(rp[i]));
    const cks: string[] = [""]; for (let i = 0; i < cp.length; i++) cks.push(cks[i] + "|" + keyOf(cp[i]));
    for (const rk of rks) for (const ck of cks) for (let vi = 0; vi < nv; vi++) A(rk, ck, vi).add(r[vals[vi].field] ?? null);
  }
  const pathKey = (p: PVal[]) => p.map((v) => "|" + keyOf(v)).join("");
  const colLeaves = spec.cols.length ? leaves(colRoot, spec.cols.length) : [[]];
  if (colLeaves.length * nv > PIVOT_LIMITS.maxColItems) throw new Error(`More than ${PIVOT_LIMITS.maxColItems} columns — move a field to Rows or add a filter.`);
  const value = (rp: PVal[], cp: PVal[], vi: number): PVal => { const a = acc.get(`${pathKey(rp)}\u0001${pathKey(cp)}\u0001${vi}`); return a ? a.get(vals[vi].fn) : null; };
  const vName = (v: PivotValue) => `${FN_LABEL[v.fn]} of ${itemLabel(header[v.field])}`;
  // columns: (col leaf × value) then grand total columns (one per value)
  type ColDef = { cp: PVal[]; vi: number; grand: boolean };
  const cols: ColDef[] = [];
  for (const cp of colLeaves) for (let vi = 0; vi < nv; vi++) cols.push({ cp, vi, grand: false });
  if (spec.cols.length && grandCols) for (let vi = 0; vi < nv; vi++) cols.push({ cp: [], vi, grand: true });
  const nr = spec.rows.length;
  const grid: PVal[][] = [];
  // header rows: one per column field (+1 when several values or no column field), Excel tabular style
  const headLevels = spec.cols.length + (nv > 1 || !spec.cols.length ? 1 : 0);
  for (let h = 0; h < headLevels; h++) {
    const row: PVal[] = [];
    for (let i = 0; i < Math.max(nr, 1); i++) row.push(h === headLevels - 1 ? (nr ? itemLabel(header[spec.rows[i]]) : null) : null);
    for (const c of cols) {
      if (h < spec.cols.length) row.push(c.grand ? (h === 0 ? (nv > 1 ? `Total ${vName(vals[c.vi])}` : "Grand Total") : null) : itemLabel(c.cp[h]));
      else row.push(c.grand ? `Total ${vName(vals[c.vi])}` : nv > 1 || !spec.cols.length ? vName(vals[c.vi]) : null);
    }
    grid.push(row);
  }
  // one value field + column fields: Excel's caption row above the column items ("Sum of Units | Product")
  let colHeaderStart = 0;
  if (spec.cols.length && nv === 1) { grid.unshift([vName(vals[0]), ...Array(Math.max(nr, 1) - 1).fill(null), spec.cols.map((c) => itemLabel(header[c])).join(" / "), ...Array(cols.length - 1).fill(null)]); colHeaderStart = 1; }
  const totalRows: number[] = [];
  let rowCount = 0;
  const emit = (labels: PVal[], rp: PVal[]) => { grid.push([...labels, ...cols.map((c) => value(rp, c.grand ? [] : c.cp, c.vi))]); };
  const walk = (n: Node, depth: number, prefix: PVal[]) => {
    for (const c of sortedKids(n)) {
      const path = [...prefix, c.value];
      if (depth === nr - 1) {
        if (++rowCount > PIVOT_LIMITS.maxRowItems) throw new Error(`More than ${PIVOT_LIMITS.maxRowItems} row items — add a filter.`);
        emit(path.map(itemLabel).concat(Array(nr - path.length).fill(null)), path);
      } else {
        walk(c, depth + 1, path);
        if (subtotals) { totalRows.push(grid.length); emit([...path.slice(0, -1).map(() => null), `${itemLabel(c.value)} Total`, ...Array(nr - path.length).fill(null)], path); }
      }
    }
  };
  if (nr) walk(rowRoot, 0, []);
  let grandRow: number | undefined;
  if (grandRows || !nr) { grandRow = grid.length; emit(nr ? ["Grand Total", ...Array(nr - 1).fill(null)] : ["Total"], []); }
  return { grid, headerRows: headLevels + colHeaderStart, colHeaderStart, totalRows, grandRow, grandCol: spec.cols.length && grandCols ? Math.max(nr, 1) + colLeaves.length * nv : undefined, records: recs.length };
}

/** distinct item labels of one field, in pivot order (for the filter checklist) */
export function fieldItems(table: PVal[][], field: number): string[] {
  const seen = new Map<string, PVal>();
  for (const r of table.slice(1)) { if (!r.some((x) => !isBlank(x))) continue; const v = r[field] ?? null; const k = keyOf(v); if (!seen.has(k)) seen.set(k, v); }
  return [...seen.values()].sort(compareItems).map(itemLabel).filter((x, i, a) => a.indexOf(x) === i);
}
