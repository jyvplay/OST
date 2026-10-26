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
 *               without an entry has no criteria. `raw` holds every other criterion (custom / top-10 / dynamic /
 *               colour / icon / date groups) as sanitised <filterColumn> XML; TT76 evaluates them (filtereval.ts).
 *               `foreign` now marks only criteria that cannot be evaluated (e.g. a non-Gregorian calendar): those
 *               rows stay hidden as the file says and re-applying changes nothing (no silent change of what is shown).
 *
 * xlsx (ECMA-376 §18.3.1.2 autoFilter, §18.3.2.x filters): values are written as <filters><filter val/> and
 * <filters blank="1"> for blanks; hidden rows carry <row hidden="1">, hidden columns <col hidden="1">.
 */
import type { Workbook, Sheet } from "./engine";
import { formatValue } from "./numfmt";
import { parseRef, rangeRef } from "./sheetlayout";
import { colorDxfXml, critXml, evaluateFilter, parseCrit, type ColumnCrit, type FilterColors } from "./filtereval";

export type RowHide = "manual" | "filter";
export interface AutoFilter { ref: string; cols: Record<number, string[]>; foreign?: boolean;
  /** TT75: criteria this app does not evaluate (custom / top-10 / dynamic / colour / icon / date groups), kept as sanitised
   *  <filterColumn> XML per column offset so a new package writes them back (the rows they hid stay "filtered") */
  raw?: Record<number, string>;
  /** TT76: resolved colour of each colorFilter column's dxf ("#RRGGBB" | null = no fill / automatic), so the criterion
   *  is evaluated and a new package can re-create its dxf */
  fx?: FilterColors }

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
  // TT76: a value list replaces any condition criterion on the column (Excel: one criterion kind per column)
  const raw = { ...(sheet.autoFilter.raw ?? {}) }; delete raw[col - r.c0];
  const fx = { ...(sheet.autoFilter.fx ?? {}) }; delete fx[col - r.c0];
  sheet.autoFilter = { ref: sheet.autoFilter.ref, cols, ...(Object.keys(raw).length ? { raw } : {}), ...(Object.keys(fx).length ? { fx } : {}) };
  applyAutoFilter(wb, sheetName);
}

/**
 * Recompute which data rows the filter hides. Manual hides are kept. Returns the number of rows hidden by the filter.
 * TT76: every criterion type is evaluated (filtereval.ts); recomputed cut-offs (top10 filterVal, dynamic val/maxVal)
 * are written back into `raw`. If any column's criteria cannot be evaluated, nothing changes (the file's state stays).
 */
export function applyAutoFilter(wb: Workbook, sheetName: string, opts: { today?: number } = {}): number {
  const sheet = wb.sheet(sheetName); const r = filterRange(sheet); const af = sheet.autoFilter;
  const filtered = () => [...sheet.hiddenRows.values()].filter((w) => w === "filter").length;
  if (!r || !af) return filtered();
  const res = evaluateFilter(wb, sheetName, r, af.cols, af.raw, { today: opts.today, colors: af.fx });
  if (res.unsupported.length) { af.foreign = true; return filtered(); }
  if (af.raw) for (const [k, x] of Object.entries(res.raw)) af.raw[Number(k)] = x;
  delete af.foreign;
  for (const [row, why] of [...sheet.hiddenRows]) if (why === "filter") sheet.hiddenRows.delete(row);
  let n = 0;
  for (const row of res.hidden) if (!sheet.hiddenRows.has(row)) { sheet.hiddenRows.set(row, "filter"); n++; }
  return n;
}

/**
 * TT76: set (or clear with null) a condition criterion on one filter column — custom, top-10, dynamic, colour, icon or
 * values with date groups — then re-apply. `color` is required for a colour criterion ("#RRGGBB" or null = no fill).
 */
export function setFilterCriteria(wb: Workbook, sheetName: string, col: number, crit: ColumnCrit | null, color?: string | null, opts: { today?: number } = {}): number {
  const sheet = wb.sheet(sheetName); const r = filterRange(sheet);
  if (!r || !sheet.autoFilter || col < r.c0 || col > r.c1) throw new Error("no AutoFilter column there");
  const k = col - r.c0; const af = sheet.autoFilter;
  const cols = { ...af.cols }; delete cols[k];
  const raw = { ...(af.raw ?? {}) }; delete raw[k];
  const fx = { ...(af.fx ?? {}) }; delete fx[k];
  if (crit) {
    if (crit.kind === "color") { if (color === undefined) throw new Error("a colour criterion needs its colour"); fx[k] = color; }
    const x = critXml(crit, k); if (!parseCrit(x)) throw new Error("criterion not expressible"); raw[k] = x;
  }
  sheet.autoFilter = { ref: af.ref, cols, ...(Object.keys(raw).length ? { raw } : {}), ...(Object.keys(fx).length ? { fx } : {}) };
  return applyAutoFilter(wb, sheetName, opts);
}

/**
 * TT76: re-apply an Excel table's own AutoFilter (its data rows, above the totals row). Same evaluation and the same
 * refusal as the sheet filter: unsupported criteria leave the file's hidden rows alone. Returns rows hidden by it.
 */
export function applyTableFilter(wb: Workbook, tableName: string, opts: { today?: number } = {}): number {
  const t = wb.tables.get(tableName.toUpperCase()); if (!t || !t.filter || !t.headerRows) return 0;
  const sheet = wb.sheet(t.sheet); const rng = { c0: t.c0, r0: t.r0, c1: t.c1, r1: t.r1 - t.totalsRows };
  const res = evaluateFilter(wb, t.sheet, rng, t.filter.cols, t.filter.raw, { today: opts.today, colors: t.filter.fx });
  if (res.unsupported.length) { t.filter.foreign = true; return 0; }
  if (t.filter.raw) for (const [k, x] of Object.entries(res.raw)) t.filter.raw[Number(k)] = x;
  delete t.filter.foreign;
  for (const [row, why] of [...sheet.hiddenRows]) if (why === "filter" && row > rng.r0 && row <= rng.r1) sheet.hiddenRows.delete(row);
  let n = 0; for (const row of res.hidden) if (!sheet.hiddenRows.has(row)) { sheet.hiddenRows.set(row, "filter"); n++; }
  return n;
}

/** TT76: the typed criterion currently on a filter column (null = none or a plain value list). */
export function filterCriteria(sheet: Sheet, col: number): ColumnCrit | null {
  const r = filterRange(sheet); const af = sheet.autoFilter; if (!r || !af) return null;
  const x = af.raw?.[col - r.c0]; return x ? parseCrit(x) : null;
}

/* ------------------------------------------------------------------ xlsx */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** <autoFilter> element for the sheet (no namespace prefix), or "" when the sheet has none. */
export function autoFilterXml(sheet: Sheet, dxf?: (xml: string) => number, fresh = false): string {
  const af = sheet.autoFilter; if (!af || !parseRef(af.ref)) return "";
  const body = filterColumnsXml(af.cols, af.raw, "", dxf ? { fx: af.fx, dxf, fresh } : undefined);
  return body ? `<autoFilter ref="${af.ref}">${body}</autoFilter>` : `<autoFilter ref="${af.ref}"/>`;
}

/** <filterColumn> elements for value lists + kept foreign criteria, in colId order (one element per column). */
/**
 * `colour.fresh` = writing a NEW package (Fusion's own styles.xml): a colour criterion's dxfId from the source file means
 * nothing there, so it is re-created from the resolved colour — and a colour criterion whose colour never resolved
 * (dangling dxfId in the source) is dropped rather than pointed at an unrelated dxf. In-place patches (fresh = false)
 * keep the source's dxf table, so an unresolved criterion stays byte-faithful.
 */
export function filterColumnsXml(cols: Record<number, string[]>, raw?: Record<number, string>, prefix = "", colour?: { fx?: FilterColors; dxf: (xml: string) => number; fresh?: boolean }): string {
  const p = prefix; const ids = new Set<number>();
  for (const k of [...Object.keys(cols), ...Object.keys(raw ?? {})]) { const n = Number(k); if (Number.isInteger(n) && n >= 0 && n <= 16383) ids.add(n); }
  return [...ids].sort((a, b) => a - b).map((k) => {
    const r = raw?.[k];
    if (r && !(k in cols)) {
      let clean = sanitizeFilterColumnXml(r);
      // TT76: a colour criterion's dxfId indexes THIS package's styles — re-create the dxf from the resolved colour
      if (clean && colour) {
        const c = parseCrit(clean);
        if (c?.kind === "color") {
          if (colour.fx && k in colour.fx) clean = critXml({ ...c, dxfId: colour.dxf(colorDxfXml(colour.fx[k], c.cell)) }, k);
          else if (colour.fresh) clean = null;
        }
      }
      return clean ? (p ? clean.replace(/<(\/?)(?=[A-Za-z])/g, `<$1${p}`) : clean).replace(/colId="\d+"/, `colId="${k}"`) : ""; }
    const vals = cols[k]; const blank = vals.includes(""); const v = vals.filter((x) => x !== "");
    return `<${p}filterColumn colId="${k}"><${p}filters${blank ? ' blank="1"' : ""}${v.length ? `>${v.map((x) => `<${p}filter val="${esc(x)}"/>`).join("")}</${p}filters>` : "/>"}</${p}filterColumn>`;
  }).join("");
}

/**
 * TT75: canonical, allowlisted <filterColumn> (prefix stripped). The ONLY path by which kept criteria reach an output
 * package — file and workbook-JSON input both pass through it. Unknown element / attribute / text → null (not kept).
 */
const FILTER_SCHEMA: Record<string, { attrs: string[]; kids: string[] }> = {
  filterColumn: { attrs: ["colId", "hiddenButton", "showButton"], kids: ["filters", "top10", "customFilters", "dynamicFilter", "colorFilter", "iconFilter"] },
  filters: { attrs: ["blank", "calendarType"], kids: ["filter", "dateGroupItem"] },
  filter: { attrs: ["val"], kids: [] },
  dateGroupItem: { attrs: ["year", "month", "day", "hour", "minute", "second", "dateTimeGrouping"], kids: [] },
  top10: { attrs: ["top", "percent", "val", "filterVal"], kids: [] },
  customFilters: { attrs: ["and"], kids: ["customFilter"] },
  customFilter: { attrs: ["operator", "val"], kids: [] },
  dynamicFilter: { attrs: ["type", "val", "valIso", "maxVal", "maxValIso"], kids: [] },
  colorFilter: { attrs: ["dxfId", "cellColor"], kids: [] },
  iconFilter: { attrs: ["iconSet", "iconId"], kids: [] },
};
export function sanitizeFilterColumnXml(xml: string): string | null {
  try { return sanitizeFc(xml); } catch { return null; } // e.g. &#99999999; → RangeError → not kept
}
function sanitizeFc(xml: string): string | null {
  if (typeof xml !== "string" || xml.length > 65536) return null;
  const re = /<(\/?)(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  const stack: string[] = []; let out = ""; let m: RegExpExecArray | null; let roots = 0;
  while ((m = re.exec(xml))) {
    if (m[6]) return null; // a stray "<" (comment, PI, CDATA, malformed)
    if (m[5] !== undefined) { if (m[5].trim()) return null; continue; }
    const [, close, name, attrs, selfClose] = m;
    const spec = FILTER_SCHEMA[name]; if (!spec) return null;
    if (close) { if (stack.pop() !== name) return null; out += `</${name}>`; continue; }
    const parent = stack[stack.length - 1];
    if (parent ? !FILTER_SCHEMA[parent].kids.includes(name) : name !== "filterColumn" || roots++ > 0) return null;
    let a = "";
    for (const am of (attrs ?? "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const an = am[1].replace(/^[A-Za-z_][\w.-]*:/, ""); if (!spec.attrs.includes(an)) return null;
      a += ` ${an}="${esc(unesc(am[2] ?? am[3] ?? ""))}"`;
    }
    if (selfClose) out += `<${name}${a}/>`; else { out += `<${name}${a}>`; stack.push(name); }
  }
  return stack.length || roots !== 1 ? null : out;
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
  const cols: Record<number, string[]> = {}; let foreign = false; let raw: Record<number, string> | undefined;
  for (const fc of (m[2] ?? "").matchAll(/<(?:\w+:)?filterColumn\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?filterColumn>)/g)) {
    const idS = xmlAttr(fc[1], "colId"); const id = idS !== undefined && /^\d+$/.test(idS) ? Number(idS) : NaN; const body = fc[2] ?? "";
    if (!Number.isInteger(id)) continue;
    const f = /<(?:\w+:)?filters\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?filters>)/.exec(body);
    if (!f || /<(?:\w+:)?dateGroupItem\b/.test(f[2] ?? "") || /<(?:\w+:)?(customFilters|top10|dynamicFilter|colorFilter|iconFilter)\b/.test(body)) {
      const keep = sanitizeFilterColumnXml(fc[0]); if (keep) (raw ??= {})[id] = keep;
      if (!keep || !parseCrit(keep)) foreign = true; // TT76: only criteria filtereval cannot evaluate stay "foreign"
      continue;
    }
    const vals = [...(f[2] ?? "").matchAll(/<(?:\w+:)?filter\b([^>]*?)\/?>/g)].map((x) => xmlAttr(x[1], "val")).filter((v): v is string => v !== undefined).map(unesc);
    const bl = xmlAttr(f[1], "blank"); if (bl === "1" || bl === "true") vals.push("");
    cols[id] = vals;
  }
  return { ref, cols, ...(foreign ? { foreign: true } : {}), ...(raw ? { raw } : {}) };
}
