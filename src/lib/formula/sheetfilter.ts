/**
 * TT74: hidden rows / columns and the sheet AutoFilter. Original code; pure functions over the engine model.
 *
 * Model (on Sheet):
 *   hiddenRows  Map<row, "manual" | "filter"> — "manual" = Hide rows; "filter" = hidden because the AutoFilter's
 *               criteria reject the row. The distinction matters to formulas: SUBTOTAL 1–11 skip only filtered
 *               rows, SUBTOTAL 101–111 and AGGREGATE options 1/3/5/7 skip both (Excel's documented semantics).
 *   hiddenCols  Set<col> (presentation only; SUBTOTAL never skips columns — it is designed for vertical ranges).
 *   autoFilter  { ref, cols } — ref is the whole filter range INCLUDING its header row; cols maps a column offset
 *               (0 = first column of ref) to the list of DISPLAYED texts that stay visible ("" = blanks). A column
 *               without an entry has no criteria. `foreign` marks criteria read from a file that this model does
 *               not express (custom / top-10 / dynamic / colour filters): those rows stay hidden as the file says,
 *               and re-applying is refused until the user picks values (no silent change of what is shown).
 *
 * xlsx (ECMA-376 §18.3.1.2 autoFilter, §18.3.2.x filters): values are written as <filters><filter val/> and
 * <filters blank="1"> for blanks; hidden rows carry <row hidden="1">, hidden columns <col hidden="1">.
 */
import type { Workbook, Sheet } from "./engine";
import { formatValue } from "./numfmt";
import { parseRef, rangeRef } from "./sheetlayout";

export type RowHide = "manual" | "filter";
export interface AutoFilter { ref: string; cols: Record<number, string[]>; foreign?: boolean }

export const MAX_FILTER_ROWS = 1_048_576;

const display = (wb: Workbook, sheet: string, col: number, row: number): string => {
  const v = wb.valueAt(sheet, col, row);
  if (v === undefined || v === null || v === "") return "";
  const st = wb.sheets.get(sheet)?.get(col, row)?.style;
  try { return formatValue(v, st?.numFmt).text; } catch { return String(v); }
};

const fold = (s: string) => s.toLocaleLowerCase("en-US");

/* ------------------------------------------------------------------ hide / unhide */
export function hideRows(sheet: Sheet, r0: number, r1: number): number {
  let n = 0;
  for (let r = Math.max(0, r0); r <= r1 && r < MAX_FILTER_ROWS; r++) if (sheet.hiddenRows.get(r) !== "manual") { sheet.hiddenRows.set(r, "manual"); n++; }
  return n;
}
/** Unhide shows manually hidden rows only; rows the filter hides stay hidden until its criteria change (Excel). */
export function unhideRows(sheet: Sheet, r0: number, r1: number): number {
  let n = 0;
  for (const [r, why] of [...sheet.hiddenRows]) if (r >= r0 && r <= r1 && why === "manual") { sheet.hiddenRows.delete(r); n++; }
  return n;
}
export function hideCols(sheet: Sheet, c0: number, c1: number): number {
  let n = 0; for (let c = Math.max(0, c0); c <= c1 && c < 16384; c++) if (!sheet.hiddenCols.has(c)) { sheet.hiddenCols.add(c); n++; }
  return n;
}
export function unhideCols(sheet: Sheet, c0: number, c1: number): number {
  let n = 0; for (const c of [...sheet.hiddenCols]) if (c >= c0 && c <= c1) { sheet.hiddenCols.delete(c); n++; }
  return n;
}

/* ------------------------------------------------------------------ AutoFilter */
export function filterRange(sheet: Sheet): { c0: number; r0: number; c1: number; r1: number } | null {
  return sheet.autoFilter ? parseRef(sheet.autoFilter.ref) : null;
}

/** Turn the AutoFilter on over `range` (its first row is the header) or off (null). Off shows every filtered row. */
export function setAutoFilter(wb: Workbook, sheetName: string, range: { c0: number; r0: number; c1: number; r1: number } | null): void {
  const sheet = wb.sheet(sheetName);
  for (const [r, why] of [...sheet.hiddenRows]) if (why === "filter") sheet.hiddenRows.delete(r);
  sheet.autoFilter = range ? { ref: rangeRef(range), cols: {} } : null;
}

/** Distinct displayed values of one filter column (data rows only), sorted like Excel's list: numbers-as-shown, text. */
export function filterValues(wb: Workbook, sheetName: string, col: number): { value: string; count: number }[] {
  const sheet = wb.sheet(sheetName); const r = filterRange(sheet);
  if (!r || col < r.c0 || col > r.c1) return [];
  // Excel lists case variants once (the first one met) and matches criteria case-insensitively
  const counts = new Map<string, { value: string; count: number }>();
  for (let row = r.r0 + 1; row <= r.r1; row++) { const t = display(wb, sheetName, col, row); const k = fold(t); const e = counts.get(k); if (e) e.count++; else counts.set(k, { value: t, count: 1 }); }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...counts.values()].sort((a, b) => (a.value === "" ? 1 : b.value === "" ? -1 : coll.compare(a.value, b.value)));
}

/** Set (or clear with null) the shown values of one filter column, then re-apply. */
export function setFilterColumn(wb: Workbook, sheetName: string, col: number, shown: string[] | null): void {
  const sheet = wb.sheet(sheetName); const r = filterRange(sheet);
  if (!r || !sheet.autoFilter || col < r.c0 || col > r.c1) throw new Error("no AutoFilter column there");
  const cols = { ...sheet.autoFilter.cols };
  if (shown === null) delete cols[col - r.c0]; else cols[col - r.c0] = [...new Set(shown)];
  sheet.autoFilter = { ref: sheet.autoFilter.ref, cols };
  applyAutoFilter(wb, sheetName);
}

/** Recompute which data rows the filter hides. Manual hides are kept. Returns the number of rows hidden by the filter. */
export function applyAutoFilter(wb: Workbook, sheetName: string): number {
  const sheet = wb.sheet(sheetName); const r = filterRange(sheet); const af = sheet.autoFilter;
  if (!r || !af || af.foreign) return [...sheet.hiddenRows.values()].filter((w) => w === "filter").length;
  for (const [row, why] of [...sheet.hiddenRows]) if (why === "filter") sheet.hiddenRows.delete(row);
  const crit = Object.entries(af.cols).map(([k, v]) => [r.c0 + Number(k), new Set(v.map(fold))] as const).filter(([c]) => c >= r.c0 && c <= r.c1);
  if (!crit.length) return 0;
  let n = 0;
  for (let row = r.r0 + 1; row <= r.r1; row++) {
    if (crit.every(([c, ok]) => ok.has(fold(display(wb, sheetName, c, row))))) continue;
    if (!sheet.hiddenRows.has(row)) { sheet.hiddenRows.set(row, "filter"); n++; }
  }
  return n;
}

/* ------------------------------------------------------------------ xlsx */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** <autoFilter> element for the sheet (no namespace prefix), or "" when the sheet has none. */
export function autoFilterXml(sheet: Sheet): string {
  const af = sheet.autoFilter; if (!af || !parseRef(af.ref)) return "";
  const cols = Object.entries(af.cols).map(([k, vals]) => [Number(k), vals] as const).filter(([k]) => Number.isInteger(k) && k >= 0).sort((a, b) => a[0] - b[0]);
  if (!cols.length) return `<autoFilter ref="${af.ref}"/>`;
  return `<autoFilter ref="${af.ref}">${cols.map(([k, vals]) => {
    const blank = vals.includes(""); const v = vals.filter((x) => x !== "");
    return `<filterColumn colId="${k}"><filters${blank ? ' blank="1"' : ""}${v.length ? `>${v.map((x) => `<filter val="${esc(x)}"/>`).join("")}</filters>` : "/>"}</filterColumn>`;
  }).join("")}</autoFilter>`;
}

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, "&");

/** an attribute value, single- or double-quoted, spaces allowed around "=" (XML 1.0 §3.1) */
export function xmlAttr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** Parse a worksheet's (or table's) <autoFilter>. Value-list criteria are modelled; anything else marks it `foreign`. */
export function readAutoFilterXml(xml: string): AutoFilter | null {
  const m = /<(?:\w+:)?autoFilter\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?autoFilter>)/.exec(xml);
  if (!m) return null;
  const ref = xmlAttr(m[1], "ref");
  if (!ref || !parseRef(ref)) return null;
  const cols: Record<number, string[]> = {}; let foreign = false;
  for (const fc of (m[2] ?? "").matchAll(/<(?:\w+:)?filterColumn\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?filterColumn>)/g)) {
    const idS = xmlAttr(fc[1], "colId"); const id = idS !== undefined && /^\d+$/.test(idS) ? Number(idS) : NaN; const body = fc[2] ?? "";
    if (!Number.isInteger(id)) continue;
    const f = /<(?:\w+:)?filters\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?filters>)/.exec(body);
    if (!f || /<(?:\w+:)?dateGroupItem\b/.test(f[2] ?? "") || /<(?:\w+:)?(customFilters|top10|dynamicFilter|colorFilter|iconFilter)\b/.test(body)) { foreign = true; continue; }
    const vals = [...(f[2] ?? "").matchAll(/<(?:\w+:)?filter\b([^>]*?)\/?>/g)].map((x) => xmlAttr(x[1], "val")).filter((v): v is string => v !== undefined).map(unesc);
    const bl = xmlAttr(f[1], "blank"); if (bl === "1" || bl === "true") vals.push("");
    cols[id] = vals;
  }
  return { ref, cols, ...(foreign ? { foreign: true } : {}) };
}
