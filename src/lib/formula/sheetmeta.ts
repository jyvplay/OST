/**
 * Workbook metadata beyond cells (TT15): charts and conditional formatting.
 * Client-safe, pure, headless-testable.
 *
 * Charts: ported from the competitor TT14 tree (src/lib/chart.ts — single
 * series bar/line/pie SVG) and extended: multiple series from adjacent
 * columns (clustered bars, multi-line), header row → series names + legend,
 * "nice" axis ticks (1/2/5×10^k) with gridlines, tick labels through numfmt,
 * and scatter (x/y) charts. Output contains only svg/rect/circle/path/polyline/
 * line/text/g, all text XML-escaped; it is rendered via <img src="data:…">
 * so even a sanitizer bypass could not execute script.
 *
 * Conditional formatting (TT49: every ECMA-376 cfRule type): cellIs (all 8 operators, constant or formula
 * operands), expression, text (contains / not / begins / ends), blanks, errors, duplicate / unique, top/bottom
 * N and N%, above/below average (± k sample standard deviations), time periods, 2/3-colour scales, data bars
 * (2007 lengths and the x14 negative axis) and icon sets — evaluated against computed values (spill-aware via
 * Workbook.valueAt) in priority order with stopIfTrue.
 */
import { cfCompare, type Workbook, type CellBorder, type BorderSide } from "./engine";
import { parseFormula } from "./parser";
import { shiftFormula } from "./sheetops";
import { toStr } from "./functions";
import { ICON_SETS } from "./cficons";
import { err, isError, type Node } from "./types";
import { formatValue } from "./numfmt";
import { fitTrend, trendLabel, TREND_TYPES, type TrendSpec, type TrendType } from "./trend";
export type { TrendSpec, TrendType } from "./trend";
import { colToLetters, lettersToCol, type Scalar } from "./types";

/** TT50: "bar" = vertical columns (TT15 name kept), "hbar" = horizontal bars; 3-D variants in files are drawn flat. */
export type ChartKind = "bar" | "hbar" | "line" | "area" | "pie" | "doughnut" | "scatter";
export const CHART_KINDS: readonly ChartKind[] = ["bar", "hbar", "line", "area", "pie", "doughnut", "scatter"];
export type ChartGrouping = "clustered" | "stacked" | "percent";
/** TT50: one series as Excel stores it (references + the file's cached values for when a reference cannot be resolved). */
export interface ChartSeriesRef { name?: string; nameRef?: string; cat?: string; val: string; catCache?: string[]; valCache?: (number | null)[]; color?: string; trend?: TrendSpec }
export interface ChartSpec {
  id: string; sheet: string; range: string; kind: ChartKind; title: string; headerRow: boolean;
  /** TT50 (all optional) */
  grouping?: ChartGrouping; catTitle?: string; valTitle?: string; trend?: TrendSpec; legend?: boolean; blanks?: "gap" | "zero" | "span";
  /** explicit series (charts read from a file); when present `range` is informational */
  series?: ChartSeriesRef[]; numFmt?: string;
  /** cell anchor (0-based, inclusive) — where the chart sits on the sheet */
  anchor?: { c0: number; r0: number; c1: number; r1: number };
  /** package part the chart was read from (xl/charts/chartN.xml); absent for charts created in Fusion */
  src?: string;
  /** what could not be represented (e.g. "3-D drawn flat", "combo chart: first type drawn") */
  note?: string;
}
export type CondKind = "gt" | "lt" | "ge" | "le" | "eq" | "between" | "contains" | "duplicate" | "top" | "scale"
  /* TT49 */ | "ne" | "notBetween" | "expr" | "notContains" | "begins" | "ends" | "blanks" | "noBlanks" | "errors" | "noErrors" | "unique" | "aboveAvg" | "period" | "bar" | "icons";
export const COND_KINDS: readonly CondKind[] = ["gt", "lt", "ge", "le", "eq", "between", "contains", "duplicate", "top", "scale", "ne", "notBetween", "expr", "notContains", "begins", "ends", "blanks", "noBlanks", "errors", "noErrors", "unique", "aboveAvg", "period", "bar", "icons"];
/** TT49: a conditional-format value object (ECMA-376 §18.3.1.11) for data bars and icon sets; v may be a number or a formula. */
export interface Cfvo { t: "min" | "max" | "num" | "percent" | "percentile" | "formula" | "autoMin" | "autoMax"; v?: string; /** icon sets: ">" instead of "≥" (gte="0") */ gt?: boolean }
export const TIME_PERIODS = ["today", "yesterday", "tomorrow", "last7Days", "thisWeek", "lastWeek", "nextWeek", "thisMonth", "lastMonth", "nextMonth"] as const;
export interface CondRule {
  id: string; sheet: string;
  /** One or more A1 ranges separated by spaces (an xlsx sqref). Distribution rules (duplicate/unique/top/average/scale/bar/icons) evaluate over the union. */
  range: string;
  kind: CondKind; a?: string; b?: string;
  /** TT49: cellIs operands that are formulas (no leading "="), relative to the top-left cell of the first range */ af?: string; bf?: string;
  /** TT49: expression / time-period formula (no leading "="), relative to the top-left cell of the first range */ formula?: string;
  fill?: string; color?: string; bold?: boolean; /** TT49 dxf extras */ italic?: boolean; underline?: boolean; strike?: boolean; numFmt?: string; border?: CellBorder;
  /** TT49: stopIfTrue — lower-priority rules are not applied to a cell this rule matched */ stop?: boolean;
  /** TT49 top10: rank is a percent / bottom N */ pct?: boolean; bottom?: boolean;
  /** TT49 aboveAverage */ below?: boolean; equal?: boolean; stdDev?: number;
  /** TT49 timePeriod */ period?: string;
  scaleMin?: string; scaleMax?: string; /** TT47: 3-colour scale midpoint colour */ scaleMid?: string; /** TT47: cfvo thresholds "min|percentile:50|max" (min, max, num:v, percent:p, percentile:p) */ scaleAt?: string;
  /** TT49 data bars (2 cfvo) and icon sets (one cfvo per icon) */ cfvo?: Cfvo[];
  barColor?: string; /** x14 negative-bar fill */ barNeg?: string; /** x14 axis (absent = Excel 2007 bar: no axis) */ barAxis?: "auto" | "middle" | "none"; barAxisColor?: string;
  barMinLen?: number; barMaxLen?: number; /** x14 gradient="0" */ barSolid?: boolean; /** x14 border colour */ barBorder?: string;
  iconSet?: string; /** x14 custom icons per position, "3Flags:2" or "NoIcons:0" */ icons?: string[]; reverse?: boolean;
  /** showValue="0" (bars, icons) */ hideValue?: boolean;
  /** TT49: GUID of the linked x14 extension rule (deleted with this rule by the lossless writer) */ x14?: string;
  /** TT47: provenance of an imported rule — "<conditionalFormatting index>.<cfRule index>" in its sheet part ("x<n>" = n-th x14-only rule) */ src?: string;
}

const PALETTE = ["#38bdf8", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#f97316"];
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
const HEX = /^#[0-9a-f]{6}$/i;

interface Rng { c0: number; r0: number; c1: number; r1: number }
export function parseRange(s: string): Rng | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?$/i.exec(s.trim());
  if (!m) return null;
  const c0 = lettersToCol(m[1].toUpperCase()), r0 = Number(m[2]) - 1;
  const c1 = m[3] ? lettersToCol(m[3].toUpperCase()) : c0, r1 = m[4] ? Number(m[4]) - 1 : r0;
  if (r0 < 0 || r1 < 0) return null;
  return { c0: Math.min(c0, c1), r0: Math.min(r0, r1), c1: Math.max(c0, c1), r1: Math.max(r0, r1) };
}
export const rangeText = (r: Rng) => `${colToLetters(r.c0)}${r.r0 + 1}:${colToLetters(r.c1)}${r.r1 + 1}`;

/* ------------------------------------------------------------------ charts */
export interface Series { name: string; values: (number | null)[]; /** scatter: own X values */ xs?: (number | null)[]; color?: string; trend?: TrendSpec }
export interface ChartData { categories: string[]; series: Series[]; numFmt?: string }
/** TT50 rendering options (all optional — absent options draw exactly the TT15 chart). */
export interface ChartOpts { grouping?: ChartGrouping; catTitle?: string; valTitle?: string; trend?: TrendSpec; legend?: boolean; blanks?: "gap" | "zero" | "span" }

/** First column = categories (or X for scatter), remaining columns = series. Text/blank values are gaps. */
export function chartDataFromRange(wb: Workbook, sheet: string, range: string, headerRow: boolean): ChartData {
  const r = parseRange(range); if (!r) throw new Error(`bad chart range: ${range}`);
  if ((r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1) > 20_000) throw new Error("chart range too large (20,000 cells max)");
  const v = (c: number, row: number): Scalar | undefined => wb.valueAt(sheet, c, row);
  const single = r.c0 === r.c1;
  const first = headerRow ? r.r0 + 1 : r.r0;
  const seriesCols = single ? [r.c0] : Array.from({ length: r.c1 - r.c0 }, (_, i) => r.c0 + 1 + i);
  const categories: string[] = [];
  for (let row = first; row <= r.r1; row++) categories.push(single ? String(row - first + 1) : display(v(r.c0, row)));
  const series = seriesCols.map((c, i) => ({
    name: headerRow ? display(v(c, r.r0)) || `Series ${i + 1}` : `Series ${i + 1}`,
    values: categories.map((_, k) => { const x = v(c, first + k); return typeof x === "number" && Number.isFinite(x) ? x : null; }),
  }));
  const fmt = wb.sheets.get(sheet)?.get(seriesCols[0], first)?.style?.numFmt;
  return { categories, series, numFmt: fmt };
}
const display = (x: Scalar | undefined) => (x === undefined || x === null ? "" : typeof x === "object" ? x.error : String(x));

/**
 * TT50: a chart series reference as Excel stores it — `Sheet1!$B$2:$B$9` or `'My sheet'!$B$2:$B$9` — resolved to
 * live values (so edits move the chart, as in Excel). null when the sheet is unknown or the reference is not a single
 * rectangle (defined names, multi-area unions, other workbooks): the caller then uses the file's cached values.
 */
export function resolveChartRef(wb: Workbook, ref: string | undefined): { values: (Scalar | undefined)[]; sheet: string; c0: number; r0: number } | null {
  if (!ref) return null;
  const m = /^\s*(?:'((?:[^']|'')+)'|([^'!()[\],]+))!(\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?)\s*$/.exec(ref);
  if (!m) return null;
  const want = (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]).toLowerCase();
  const sheet = [...wb.sheets.keys()].find((n) => n.toLowerCase() === want); if (!sheet) return null;
  const r = parseRange(m[3].replace(/\$/g, "").toUpperCase()); if (!r) return null;
  if ((r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1) > 20_000) return null;
  const values: (Scalar | undefined)[] = [];
  for (let row = r.r0; row <= r.r1; row++) for (let c = r.c0; c <= r.c1; c++) values.push(wb.valueAt(sheet, c, row));
  return { values, sheet, c0: r.c0, r0: r.r0 };
}
const numOrNull = (x: Scalar | undefined) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** TT50: data for any chart — range charts (TT15) or explicit per-series references (charts read from .xlsx). */
export function chartDataFor(wb: Workbook, c: ChartSpec): ChartData {
  if (!c.series?.length) {
    const d = chartDataFromRange(wb, c.sheet, c.range, c.headerRow);
    if (c.trend) for (const s of d.series) s.trend = c.trend;
    return d;
  }
  let categories: string[] | undefined; let numFmt = c.numFmt;
  const series: Series[] = c.series.map((s, i) => {
    const live = resolveChartRef(wb, s.val);
    const values = live ? live.values.map(numOrNull) : (s.valCache ?? []).slice(0, 20_000);
    if (live && !numFmt) numFmt = wb.sheets.get(live.sheet)?.get(live.c0, live.r0)?.style?.numFmt;
    const cat = resolveChartRef(wb, s.cat);
    const catText = cat ? cat.values.map(display) : s.catCache;
    if (!categories && catText) categories = catText;
    const nameLive = resolveChartRef(wb, s.nameRef);
    const name = (nameLive ? display(nameLive.values[0]) : s.name) || `Series ${i + 1}`;
    const xs = c.kind === "scatter" ? (cat ? cat.values.map(numOrNull) : s.catCache?.map((t) => (t.trim() !== "" && Number.isFinite(Number(t)) ? Number(t) : null))) : undefined;
    return { name, values, ...(xs ? { xs } : {}), ...(s.color ? { color: s.color } : {}), ...(s.trend ?? c.trend ? { trend: s.trend ?? c.trend } : {}) };
  });
  const n = Math.max(0, ...series.map((s) => s.values.length));
  categories = (categories ?? []).slice(0, n);
  while (categories.length < n) categories.push(String(categories.length + 1));
  for (const s of series) while (s.values.length < n) s.values.push(null);
  return { categories, series, numFmt };
}

/** Heckbert "nice numbers": tick step in {1,2,5}×10^k covering [lo,hi] with ~n ticks. */
export function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!(Number.isFinite(lo) && Number.isFinite(hi))) return [0, 1];
  if (lo === hi) { const d = Math.abs(lo) || 1; lo -= d / 2; hi += d / 2; }
  const nice = (x: number, round: boolean) => { const e = Math.floor(Math.log10(x)); const f = x / 10 ** e; const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return nf * 10 ** e; };
  const step = nice(nice(hi - lo, false) / (n - 1), true);
  const t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step;
  const out: number[] = []; for (let t = t0; t <= t1 + step / 2; t += step) out.push(Number(t.toPrecision(12)));
  return out;
}

/**
 * TT50 stacking (Excel semantics): stacked charts pile positive values upward and negative values downward from
 * zero, series in order; 100 % stacked charts first divide each value by its category's sum of absolute values.
 * Returns per series and category the [from, to] interval, or null for a blank point.
 */
export function stackSeries(series: Series[], grouping: ChartGrouping, blanksAsZero: boolean): ([number, number] | null)[][] {
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const out = series.map(() => new Array<[number, number] | null>(n).fill(null));
  for (let i = 0; i < n; i++) {
    const tot = series.reduce((a, s) => a + Math.abs(s.values[i] ?? 0), 0);
    let pos = 0, neg = 0;
    series.forEach((s, si) => {
      let v = s.values[i]; if (v === null || v === undefined) { if (!blanksAsZero) return; v = 0; }
      if (grouping === "percent") v = tot > 0 ? (v / tot) * 100 : 0;
      if (grouping === "clustered") { out[si][i] = [0, v]; return; }
      if (v >= 0) { out[si][i] = [pos, pos + v]; pos += v; } else { out[si][i] = [neg, neg + v]; neg += v; }
    });
  }
  return out;
}
const TREND_NAME: Record<TrendType, string> = { linear: "Linear", exp: "Expon.", log: "Log.", power: "Power", poly: "Poly.", movingAvg: "Mov. Avg." };
/** Excel's default legend text for a trendline: "Linear (Sales)", "2 per. Mov. Avg. (Sales)". */
/** TT50: a sheet rename rewrites the sheet prefix of chart series references (Excel keeps them live). */
export function renameChartRefs(c: ChartSpec, from: string, to: string): ChartSpec {
  if (!c.series?.length) return c;
  const quote = (s: string) => (/^[A-Za-z_][\w.]*$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
  const fix = (r: string | undefined) => {
    if (!r) return r;
    const m = /^\s*(?:'((?:[^']|'')+)'|([^'!()[\],]+))!(.*)$/.exec(r); if (!m) return r;
    const name = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
    return name.toLowerCase() === from.toLowerCase() ? `${quote(to)}!${m[3]}` : r;
  };
  return { ...c, range: fix(c.range) ?? c.range, series: c.series.map((s) => ({ ...s, val: fix(s.val) ?? s.val, cat: fix(s.cat), nameRef: fix(s.nameRef) })) };
}
export const trendLegend = (t: TrendSpec, series: string) => t.name || `${t.type === "movingAvg" ? `${Math.max(2, t.period ?? 2)} per. ` : ""}${TREND_NAME[t.type]} (${series})`;

export function buildChartSvg(kind: ChartKind, title: string, data: ChartData, width = 520, height = 300, opts: ChartOpts = {}): string {
  const pts = data.series.flatMap((s) => s.values).filter((x): x is number => x !== null);
  if (!pts.length) throw new Error("a chart needs at least one numeric point");
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="0" y="0" width="${width}" height="${height}" fill="#0f172a"/>`;
  const titleEl = `<text x="${width / 2}" y="20" font-size="14" font-family="sans-serif" text-anchor="middle" fill="#e2e8f0">${xml(title)}</text>`;
  if (kind === "pie" || kind === "doughnut") return head + titleEl + piePart(data, width, height, kind === "doughnut") + "</svg>";
  const grouping: ChartGrouping = kind === "scatter" ? "clustered" : opts.grouping ?? "clustered";
  const blanks = opts.blanks ?? "gap";
  const color = (si: number, s: Series) => s.color ?? PALETTE[si % PALETTE.length];
  // trendlines: Excel offers them only on unstacked 2-D bar/column/line/area/scatter charts
  const trendOk = grouping === "clustered";
  const trends = trendOk ? data.series.flatMap((s, si) => (s.trend ? [{ s, si, t: s.trend }] : [])) : [];
  const multi = data.series.length > 1;
  // Excel: an explicit legend setting wins (false = no legend at all); default = several series or any trendline
  const showLegend = opts.legend ?? (multi || trends.length > 0);
  const legendItems = showLegend ? data.series.length + trends.length : 0;
  const left = 56 + (opts.valTitle ? 18 : 0), right = showLegend && legendItems ? 120 : 16, top = 34, bottom = 44 + (opts.catTitle ? 16 : 0);
  const pw = width - left - right, ph = height - top - bottom;
  const pct = grouping === "percent";
  const tick = (n: number) => (pct ? `${n}%` : formatValue(n, data.numFmt && !/[dmyhs]/i.test(data.numFmt) ? data.numFmt : "General").text);
  const n = data.categories.length;
  const horiz = kind === "hbar";
  // value range
  const stacks = kind === "scatter" ? null : stackSeries(data.series, grouping, blanks === "zero" || kind === "area");
  let vals = pts;
  if (stacks && grouping !== "clustered") vals = stacks.flat().filter((x): x is [number, number] => !!x).flatMap((x) => x);
  if (blanks === "zero") vals = [...vals, 0];
  let xs: number[] | null = null;
  if (kind === "scatter") {
    xs = data.categories.map(Number);
    const anyOwn = data.series.some((s) => s.xs);
    if (!anyOwn && xs.some((x) => !Number.isFinite(x))) throw new Error("scatter X values must be numeric");
    if (anyOwn) xs = data.series.flatMap((s) => (s.xs ?? data.categories.map(Number)).filter((x): x is number => x !== null && Number.isFinite(x)));
    if (!xs.length) throw new Error("scatter X values must be numeric");
  }
  // trend values extend the axis like Excel (forecast forward/backward included)
  const fits = trends.flatMap(({ s, si, t }) => {
    try {
      const xv = kind === "scatter" ? (s.xs ?? data.categories.map(Number)) : s.values.map((_, i) => i + 1);
      const f = fitTrend(t, xv, s.values);
      const finite = xv.filter((x): x is number => x !== null && Number.isFinite(x));
      const x0 = Math.min(...finite) - (t.backward ?? 0), x1 = Math.max(...finite) + (t.forward ?? 0);
      const curve: [number, number][] = f.points ?? Array.from({ length: 41 }, (_, k) => { const x = x0 + ((x1 - x0) * k) / 40; return [x, f.predict(x)] as [number, number]; }).filter(([, y]) => Number.isFinite(y));
      return [{ s, si, t, f, curve, x0, x1 }];
    } catch { return []; }
  });
  for (const ft of fits) vals = [...vals, ...ft.curve.map(([, y]) => y)];
  let lo0 = Math.min(...vals), hi0 = Math.max(...vals);
  // Excel's automatic minimum: zero unless every value is positive and the spread is under 1/6 of the maximum
  // (applies to line/scatter value axes; bar/area always start at zero)
  if ((kind === "line" || kind === "scatter") && lo0 > 0 && (hi0 - lo0) / hi0 < 1 / 6) { /* keep lo0 */ } else { lo0 = Math.min(0, lo0); hi0 = Math.max(0, hi0); }
  const yt = pct ? niceTicks(Math.min(0, lo0), Math.max(0, hi0)).filter((t) => t >= -100 && t <= 100) : niceTicks(lo0, hi0);
  const lo = yt[0], hi = yt[yt.length - 1];
  const yOf = (v: number) => top + ((hi - v) / (hi - lo || 1)) * ph;           // vertical charts
  const vX = (v: number) => left + ((v - lo) / (hi - lo || 1)) * pw;           // horizontal bars
  const slot = (horiz ? ph : pw) / Math.max(1, n);
  let xOf = (i: number) => left + i * slot + slot / 2;
  const catY = (i: number) => top + ph - i * slot - slot / 2;                   // hbar: first category at the bottom (Excel)
  let xAxis = "";
  const T = (x: number, y: number, s: string, anchor = "middle", fill = "#cbd5e1", extra = "") => `<text x="${x}" y="${y}" font-size="10" font-family="sans-serif" text-anchor="${anchor}" fill="${fill}"${extra}>${xml(s)}</text>`;
  if (xs) {
    const xt = niceTicks(Math.min(...xs), Math.max(...xs, ...fits.map((f) => f.x1)), 5); const xl = Math.min(xt[0], ...fits.map((f) => f.x0)), xh = xt[xt.length - 1];
    const sx = (x: number) => left + ((x - xl) / (xh - xl || 1)) * pw;
    xOf = (i: number) => sx(Number(data.categories[i]));
    (xOf as unknown as { sx: typeof sx }).sx = sx;
    xAxis = xt.filter((t) => t >= xl).map((t) => T(sx(t), top + ph + 16, tick(t))).join("");
  } else if (horiz) {
    const every = Math.ceil(n / Math.max(1, Math.floor(ph / 14)));
    xAxis = data.categories.map((c, i) => (i % every ? "" : T(left - 6, catY(i) + 3, c.slice(0, 12), "end"))).join("");
  } else {
    const every = Math.ceil(n / Math.max(1, Math.floor(pw / 46)));
    xAxis = data.categories.map((c, i) => (i % every ? "" : T(xOf(i), top + ph + 16, c.slice(0, 12)))).join("");
  }
  const grid = horiz
    ? yt.map((t) => `<line x1="${vX(t)}" y1="${top}" x2="${vX(t)}" y2="${top + ph}" stroke="#1e293b" stroke-width="1"/>` + T(vX(t), top + ph + 16, tick(t), "middle", "#94a3b8")).join("")
    : yt.map((t) => `<line x1="${left}" y1="${yOf(t)}" x2="${left + pw}" y2="${yOf(t)}" stroke="#1e293b" stroke-width="1"/><text x="${left - 6}" y="${yOf(t) + 3}" font-size="10" font-family="sans-serif" text-anchor="end" fill="#94a3b8">${xml(tick(t))}</text>`).join("");
  const axis = horiz
    ? `<polyline points="${left},${top} ${left},${top + ph} ${left + pw},${top + ph}" fill="none" stroke="#64748b" stroke-width="1"/>` + (lo < 0 ? `<line x1="${vX(0)}" y1="${top}" x2="${vX(0)}" y2="${top + ph}" stroke="#94a3b8" stroke-width="1"/>` : "")
    : `<polyline points="${left},${top} ${left},${top + ph} ${left + pw},${top + ph}" fill="none" stroke="#64748b" stroke-width="1"/>` + (lo < 0 ? `<line x1="${left}" y1="${yOf(0)}" x2="${left + pw}" y2="${yOf(0)}" stroke="#94a3b8" stroke-width="1"/>` : "");
  let body = "";
  if (kind === "bar" || kind === "hbar") {
    const k = grouping === "clustered" ? data.series.length : 1; const groupW = slot * 0.75; const barW = groupW / k;
    data.series.forEach((s, si) => s.values.forEach((_, i) => {
      const iv = stacks![si][i]; if (!iv) return;
      const off = (slot - groupW) / 2 + (grouping === "clustered" ? si * barW : 0);
      const fill = multi ? color(si, s) : s.color ?? PALETTE[i % PALETTE.length];
      const attrs = grouping === "clustered" ? "" : ` data-stack="${si}"`;
      if (horiz) {
        const y = top + ph - (i + 1) * slot + off; const x = Math.min(vX(iv[0]), vX(iv[1])); const w = Math.abs(vX(iv[1]) - vX(iv[0]));
        body += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${Math.max(1, barW - 1).toFixed(2)}" fill="${fill}"${attrs}/>`;
      } else {
        const x = left + i * slot + off; const y = Math.min(yOf(iv[0]), yOf(iv[1])); const h = Math.abs(yOf(iv[1]) - yOf(iv[0]));
        body += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(1, barW - 1).toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}"${attrs}/>`;
      }
    }));
  } else if (kind === "area") {
    // series in order; stacked areas fill between the previous stack line and this one, standard areas from zero
    data.series.forEach((s, si) => {
      const iv = stacks![si]; const up: string[] = [], dn: string[] = [];
      iv.forEach((p, i) => { const q = p ?? [0, 0]; up.push(`${xOf(i).toFixed(2)},${yOf(q[1]).toFixed(2)}`); dn.unshift(`${xOf(i).toFixed(2)},${yOf(q[0]).toFixed(2)}`); });
      body += `<polygon points="${[...up, ...dn].join(" ")}" fill="${color(si, s)}" fill-opacity="${grouping === "clustered" ? 0.55 : 0.85}" stroke="${color(si, s)}" stroke-width="1"/>`;
    });
  } else {
    data.series.forEach((s, si) => {
      const c = color(si, s);
      const xOfS = (i: number) => (xs && s.xs ? (xOf as unknown as { sx: (x: number) => number }).sx(s.xs[i] ?? NaN) : xOf(i));
      const yv = (i: number): number | null => { if (kind === "line" && stacks && grouping !== "clustered") return stacks[si][i]?.[1] ?? null; const v = s.values[i]; return v === null && blanks === "zero" ? 0 : v; };
      // gaps break the line (Excel "show empty cells as gaps"); "span" connects across them
      let seg: string[] = []; const segs: string[][] = [];
      s.values.forEach((_, i) => { const v = yv(i); const x = xOfS(i); if (v === null || !Number.isFinite(x)) { if (blanks !== "span") { if (seg.length) segs.push(seg); seg = []; } } else seg.push(`${x.toFixed(2)},${yOf(v).toFixed(2)}`); });
      if (seg.length) segs.push(seg);
      if (kind === "line") for (const g of segs) body += `<polyline points="${g.join(" ")}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>`;
      s.values.forEach((_, i) => { const v = yv(i); const x = xOfS(i); if (v !== null && Number.isFinite(x)) body += `<circle cx="${x.toFixed(2)}" cy="${yOf(v).toFixed(2)}" r="${kind === "scatter" ? 3.5 : 2.5}" fill="${c}"/>`; });
    });
  }
  // trendlines (dashed, series colour) + optional equation / R² labels
  for (const ft of fits) {
    const P = (x: number, y: number): [number, number] => {
      if (kind === "scatter") return [(xOf as unknown as { sx: (x: number) => number }).sx(x), yOf(y)];
      const cat = left + (x - 1) * slot + slot / 2; // category position for x = 1..n (continuous)
      return horiz ? [vX(y), top + ph - (x - 1) * slot - slot / 2] : [cat, yOf(y)];
    };
    const ptsT = ft.curve.map(([x, y]) => P(x, y)).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (ptsT.length < 2) continue;
    body += `<polyline points="${ptsT.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(" ")}" fill="none" stroke="${color(ft.si, ft.s)}" stroke-width="1.5" stroke-dasharray="5 3" data-trend="${ft.t.type}"/>`;
    const label = trendLabel(ft.f, !!ft.t.dispEq, !!ft.t.dispRSqr);
    const [lx, ly] = ptsT[ptsT.length - 1];
    label.forEach((l, i) => { body += T(Math.min(lx, left + pw - 4), Math.max(top + 10, ly - 6 - (label.length - 1 - i) * 12), l, "end", "#e2e8f0", ' data-trend-label="1"'); });
  }
  const titles = ((horiz ? opts.valTitle : opts.catTitle) ? `<text x="${left + pw / 2}" y="${height - 8}" font-size="11" font-family="sans-serif" text-anchor="middle" fill="#cbd5e1" data-axis-title="${horiz ? "val" : "cat"}">${xml((horiz ? opts.valTitle : opts.catTitle) ?? "")}</text>` : "")
    + ((horiz ? opts.catTitle : opts.valTitle) ? `<text x="14" y="${top + ph / 2}" font-size="11" font-family="sans-serif" text-anchor="middle" fill="#cbd5e1" transform="rotate(-90 14 ${top + ph / 2})" data-axis-title="${horiz ? "cat" : "val"}">${xml((horiz ? opts.catTitle : opts.valTitle) ?? "")}</text>` : "");
  const entries: { name: string; color: string; dashed: boolean }[] = [];
  if (showLegend) data.series.forEach((s, i) => entries.push({ name: s.name, color: color(i, s), dashed: false }));
  for (const ft of fits) entries.push({ name: trendLegend(ft.t, ft.s.name), color: color(ft.si, ft.s), dashed: true });
  const legend = showLegend ? entries.map((e, i) => (e.dashed
    ? `<line x1="${width - right + 10}" y1="${top + i * 18 + 5}" x2="${width - right + 24}" y2="${top + i * 18 + 5}" stroke="${e.color}" stroke-width="2" stroke-dasharray="3 2"/>`
    : `<rect x="${width - right + 12}" y="${top + i * 18}" width="10" height="10" fill="${e.color}"/>`) + `<text x="${width - right + 27}" y="${top + i * 18 + 9}" font-size="11" font-family="sans-serif" fill="#e2e8f0">${xml(e.name.slice(0, 14))}</text>`).join("") : "";
  return head + titleEl + grid + axis + body + xAxis + titles + legend + "</svg>";
}

function piePart(data: ChartData, width: number, height: number, hole = false): string {
  const s = data.series[0];
  const parts = data.categories.map((label, i) => ({ label, value: s.values[i] })).filter((p): p is { label: string; value: number } => p.value !== null && p.value > 0);
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total <= 0) throw new Error("a pie chart needs a positive total");
  const cx = Math.min(160, width / 3), cy = height / 2 + 8, r = Math.min(height / 2 - 36, 110);
  let angle = -Math.PI / 2; let out = "";
  parts.forEach((p, i) => {
    const frac = p.value / total; const color = PALETTE[i % PALETTE.length];
    if (frac >= 0.9999) out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
    else {
      const a2 = angle + frac * 2 * Math.PI;
      out += `<path d="M${cx} ${cy}L${(cx + r * Math.cos(angle)).toFixed(2)} ${(cy + r * Math.sin(angle)).toFixed(2)}A${r} ${r} 0 ${frac > 0.5 ? 1 : 0} 1 ${(cx + r * Math.cos(a2)).toFixed(2)} ${(cy + r * Math.sin(a2)).toFixed(2)}Z" fill="${color}" stroke="#0f172a" stroke-width="1"/>`;
      angle = a2;
    }
    if (i < 12) out += `<rect x="${width - 190}" y="${48 + i * 19}" width="10" height="10" fill="${color}"/><text x="${width - 174}" y="${57 + i * 19}" font-size="11" font-family="sans-serif" fill="#e2e8f0">${xml(`${p.label.slice(0, 16)} (${Math.round(frac * 1000) / 10}%)`)}</text>`;
  });
  if (hole) out += `<circle cx="${cx}" cy="${cy}" r="${(r * 0.5).toFixed(2)}" fill="#0f172a" data-hole="1"/>`; // doughnut: Excel's default 50 % hole
  return out;
}
export const svgDataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/* ------------------------------------------------------------------ conditional formatting */
/** TT49: a data bar as fractions of the cell width (from ≤ to); axis = position of the zero axis when drawn. */
export interface CfBar { from: number; to: number; color: string; solid?: boolean; border?: string; axis?: number; axisColor?: string; negative?: boolean }
export interface CfStyle { fill?: string; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; numFmt?: string; border?: CellBorder; bar?: CfBar; /** icon glyph (cficons) */ icon?: string; hideValue?: boolean }
const lerp = (a: string, b: string, t: number) => {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, "0")).join("");
};
/** PERCENTILE.INC on sorted values (Excel's colour-scale percentile cfvo). */
const percentileInc = (sorted: number[], p: number) => {
  const r = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1), i = Math.floor(r);
  return i + 1 < sorted.length ? sorted[i] + (sorted[i + 1] - sorted[i]) * (r - i) : sorted[i];
};
/** cfvo spec → numeric thresholds (ECMA-376 §18.3.1.11). Default: min | percentile 50 | max. */
export function scaleThresholds(spec: string | undefined, nums: number[], n: number): number[] {
  const sorted = [...nums].sort((a, b) => a - b), lo = sorted[0], hi = sorted[sorted.length - 1];
  const parts = spec?.split("|") ?? [];
  const dflt = n === 3 ? ["min", "percentile:50", "max"] : ["min", "max"];
  const out = dflt.map((d, i) => {
    const [t, v] = (parts.length === n ? parts[i] : d).split(":"); const x = Number(v);
    if (t === "min") return lo; if (t === "max") return hi;
    if (t === "num" && Number.isFinite(x)) return x;
    if (t === "percent" && Number.isFinite(x)) return lo + ((hi - lo) * x) / 100;
    if (t === "percentile" && Number.isFinite(x)) return percentileInc(sorted, x);
    return i === 0 ? lo : i === n - 1 ? hi : percentileInc(sorted, 50);
  });
  for (let i = 1; i < out.length; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1]; // thresholds are monotone
  return out;
}
/** Colour for v: clamp outside [t0, tN]; linear RGB interpolation inside the containing segment. */
export function scaleColor(v: number, at: number[], colors: string[]): string {
  if (v <= at[0]) return colors[0];
  if (v >= at[at.length - 1]) return colors[colors.length - 1];
  for (let i = 1; i < at.length; i++) if (v <= at[i]) return at[i] > at[i - 1] ? lerp(colors[i - 1], colors[i], (v - at[i - 1]) / (at[i] - at[i - 1])) : colors[i];
  return colors[colors.length - 1];
}
/** TT49: one or more space-separated A1 ranges (an xlsx sqref) → rectangles; null when any part is invalid. */
export function parseRanges(s: string): Rng[] | null {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 4096) return null;
  const out = parts.map(parseRange);
  return out.every(Boolean) ? (out as Rng[]) : null;
}
/** Excel's time-period rule formulas for a cell reference (used when a file stores none and when writing). */
export function periodFormula(period: string, ref: string): string | null {
  const d = `ROUNDDOWN(${ref},0)`;
  switch (period) {
    case "today": return `FLOOR(${ref},1)=TODAY()`;
    case "yesterday": return `FLOOR(${ref},1)=TODAY()-1`;
    case "tomorrow": return `FLOOR(${ref},1)=TODAY()+1`;
    case "last7Days": return `AND(TODAY()-FLOOR(${ref},1)<=6,FLOOR(${ref},1)<=TODAY())`;
    case "thisWeek": return `AND(TODAY()-${d}<=WEEKDAY(TODAY())-1,${d}-TODAY()<=7-WEEKDAY(TODAY()))`;
    case "lastWeek": return `AND(TODAY()-${d}>=(WEEKDAY(TODAY())),TODAY()-${d}<(WEEKDAY(TODAY())+7))`;
    case "nextWeek": return `AND(${d}-TODAY()>(7-WEEKDAY(TODAY())),${d}-TODAY()<(15-WEEKDAY(TODAY())))`;
    // month rules: written with EOMONTH so January/December wrap correctly
    case "thisMonth": return `AND(${ref}>EOMONTH(TODAY(),-1),${ref}<EOMONTH(TODAY(),0)+1)`;
    case "lastMonth": return `AND(${ref}>EOMONTH(TODAY(),-2),${ref}<EOMONTH(TODAY(),-1)+1)`;
    case "nextMonth": return `AND(${ref}>EOMONTH(TODAY(),0),${ref}<EOMONTH(TODAY(),1)+1)`;
    default: return null;
  }
}
const MAX_CF_CELLS = 100_000, MAX_FORMULA_CELLS = 20_000;
const FORMAT_KEYS = ["fill", "color", "bold", "italic", "underline", "strike", "numFmt", "border"] as const;
const truthy = (v: Scalar) => v === true || (typeof v === "number" && v !== 0);
const lit = (t: string | undefined): Scalar => { const x = (t ?? "").trim(); return x !== "" && /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(x) ? Number(x) : (t ?? ""); };
const sampleStdev = (xs: number[]) => { if (xs.length < 2) return 0; const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); };

/**
 * Evaluate every rule for one sheet → per-cell overlay ("col,row" keys). Rules are in PRIORITY order (first =
 * highest; the xlsx reader sorts by priority). A format property is taken from the highest-priority matching rule
 * that sets it (Excel merges non-conflicting formats); stopIfTrue stops lower-priority rules for that cell.
 */
export function evalCondFormats(wb: Workbook, sheet: string, rules: CondRule[]): Map<string, CfStyle> {
  const out = new Map<string, CfStyle>();
  const stopped = new Set<string>();
  const parsed = new Map<string, Node | null>();
  const sh = wb.sheets.get(sheet);
  const isBlankCell = (c: number, r: number) => { const cell = sh?.get(c, r); return (!cell || cell.input === "") && !wb.spillAnchorOf(sheet, c, r); };
  for (const rule of rules) {
    if (rule.sheet !== sheet) continue;
    const rs = parseRanges(rule.range); if (!rs) continue;
    if (rs.reduce((n, g) => n + (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1), 0) > MAX_CF_CELLS) continue;
    const seen = new Set<string>();
    const cells: { k: string; c: number; r: number; v: Scalar | undefined; blank: boolean }[] = [];
    for (const g of rs) for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      const k = `${c},${r}`; if (seen.has(k)) continue; seen.add(k);
      cells.push({ k, c, r, v: wb.valueAt(sheet, c, r), blank: isBlankCell(c, r) });
    }
    const ac = rs[0].c0, ar = rs[0].r0;
    const F = (text: string, c: number, r: number): Scalar => {
      const src = shiftFormula("=" + text, c - ac, r - ar);
      let node = parsed.get(src);
      if (node === undefined) { try { node = parseFormula(src); } catch { node = null; } if (parsed.size > 50_000) parsed.clear(); parsed.set(src, node); }
      return node ? wb.evalFormulaAt(sheet, c, r, node) : err("#NAME?");
    };
    const nums = cells.map((x) => x.v).filter((v): v is number => typeof v === "number");
    const sorted = [...nums].sort((a, b) => a - b), lo = sorted[0], hi = sorted[sorted.length - 1];
    /** cfvo → number (null = unusable). A val that is not a number literal is a formula evaluated at the anchor. */
    const cfvoNum = (o: Cfvo): number | null => {
      const val = (): number | null => {
        if (o.v === undefined) return null;
        const n = lit(o.v); if (typeof n === "number") return n;
        const f = F(o.v.replace(/^=/, ""), ac, ar); return typeof f === "number" ? f : typeof f === "boolean" ? Number(f) : null;
      };
      switch (o.t) {
        case "min": return lo; case "max": return hi;
        case "autoMin": return Math.min(0, lo); case "autoMax": return Math.max(0, hi);
        case "num": case "formula": return val();
        case "percent": { const p = val(); return p === null ? null : lo + ((hi - lo) * p) / 100; }
        case "percentile": { const p = val(); return p === null ? null : percentileInc(sorted, p); }
      }
      return null;
    };
    const apply = (k: string, patch: CfStyle) => {
      const cur = out.get(k) ?? {};
      for (const [key, v] of Object.entries(patch)) if (v !== undefined && (cur as Record<string, unknown>)[key] === undefined) (cur as Record<string, unknown>)[key] = v;
      out.set(k, cur);
    };
    const live = cells.filter((x) => !stopped.has(x.k));
    switch (rule.kind) {
      case "scale": {
        if (!nums.length) continue;
        const c0 = HEX.test(rule.scaleMin ?? "") ? rule.scaleMin! : "#f8696b", c1 = HEX.test(rule.scaleMax ?? "") ? rule.scaleMax! : "#63be7b";
        const mid = HEX.test(rule.scaleMid ?? "") ? rule.scaleMid : undefined;
        const colors = mid ? [c0, mid, c1] : [c0, c1];
        const at = scaleThresholds(rule.scaleAt, nums, colors.length);
        for (const x of live) if (typeof x.v === "number") apply(x.k, { fill: scaleColor(x.v, at, colors) });
        continue;
      }
      case "bar": {
        if (!nums.length) continue;
        const cv = rule.cfvo ?? [{ t: "min" }, { t: "max" }];
        let a = cfvoNum(cv[0] ?? { t: "min" }) ?? lo, b = cfvoNum(cv[1] ?? { t: "max" }) ?? hi;
        if (b < a) b = a;
        const color = HEX.test(rule.barColor ?? "") ? rule.barColor! : "#638ec6";
        const minL = Math.max(0, Math.min(100, rule.barMinLen ?? 10)) / 100, maxL = Math.max(minL * 100, Math.min(100, rule.barMaxLen ?? 90)) / 100;
        const axisMode = rule.barAxis;
        const useAxis = axisMode === "middle" || (axisMode === "auto" && a < 0);
        for (const x of live) {
          if (typeof x.v !== "number") continue;
          let bar: CfBar;
          if (useAxis) {
            // x14 negative bars: the zero axis splits the cell (auto: at −min/(max−min); middle: at the centre)
            const span = axisMode === "middle" ? Math.max(Math.abs(a), Math.abs(b)) * 2 : b - Math.min(a, 0);
            const axis = axisMode === "middle" ? 0.5 : span > 0 ? -Math.min(a, 0) / span : 0;
            const len = span > 0 ? Math.min(Math.abs(x.v) / span, x.v < 0 ? axis : 1 - axis) : 0;
            bar = x.v < 0 ? { from: axis - len, to: axis, color: HEX.test(rule.barNeg ?? "") ? rule.barNeg! : "#ff0000", negative: true, axis } : { from: axis, to: axis + len, color, axis };
            if (rule.barAxisColor) bar.axisColor = rule.barAxisColor;
          } else {
            const frac = b > a ? Math.max(0, Math.min(1, (x.v - a) / (b - a))) : x.v >= b ? 1 : 0;
            bar = { from: 0, to: minL + frac * (maxL - minL), color };
          }
          if (rule.barSolid) bar.solid = true;
          if (rule.barBorder) bar.border = rule.barBorder;
          apply(x.k, { bar, ...(rule.hideValue ? { hideValue: true } : {}) });
        }
        continue;
      }
      case "icons": {
        if (!nums.length) continue;
        const set = ICON_SETS[rule.iconSet ?? "3TrafficLights1"]; if (!set) continue;
        const n = set.length;
        const cv = rule.cfvo?.length === n ? rule.cfvo : DEFAULT_PCT[n].map((p) => ({ t: "percent", v: String(p) }) as Cfvo);
        const th = cv.map((o) => cfvoNum(o));
        for (const x of live) {
          if (typeof x.v !== "number") continue;
          let idx = 0;
          for (let i = n - 1; i >= 1; i--) { const t = th[i]; if (t !== null && (cv[i].gt ? x.v > t : x.v >= t)) { idx = i; break; } }
          if (rule.reverse) idx = n - 1 - idx;
          let glyph: string | undefined = set[idx];
          const custom = rule.icons?.[idx];
          if (custom) { const [cs, id] = custom.split(":"); glyph = cs === "NoIcons" ? undefined : ICON_SETS[cs]?.[Number(id)] ?? glyph; }
          if (glyph) apply(x.k, { icon: glyph, ...(rule.hideValue ? { hideValue: true } : {}) });
        }
        continue;
      }
    }
    const style: CfStyle = {}; for (const key of FORMAT_KEYS) if (rule[key] !== undefined) (style as Record<string, unknown>)[key] = rule[key];
    let test: (x: (typeof cells)[number]) => boolean = () => false;
    const opA = rule.af ? null : lit(rule.a), opB = rule.bf ? null : lit(rule.b);
    const A = (x: (typeof cells)[number]) => (rule.af ? F(rule.af, x.c, x.r) : opA!), B = (x: (typeof cells)[number]) => (rule.bf ? F(rule.bf, x.c, x.r) : opB!);
    const cmp = (op: Parameters<typeof cfCompare>[0]) => (x: (typeof cells)[number]) => cfCompare(op, x.v, x.blank, A(x));
    const between = (x: (typeof cells)[number]) => {
      let p = A(x), q = B(x);
      if (typeof p === "number" && typeof q === "number" && p > q) [p, q] = [q, p];
      return cfCompare(">=", x.v, x.blank, p) && cfCompare("<=", x.v, x.blank, q);
    };
    const text = (x: (typeof cells)[number]) => (x.v === undefined ? "" : toStr(x.v as Scalar)).toLowerCase();
    const needle = (rule.a ?? "").toLowerCase();
    const formulaKind = rule.kind === "expr" || rule.kind === "period" || !!rule.af || !!rule.bf;
    if (formulaKind && live.length > MAX_FORMULA_CELLS) continue;
    switch (rule.kind) {
      case "gt": test = cmp(">"); break;
      case "lt": test = cmp("<"); break;
      case "ge": test = cmp(">="); break;
      case "le": test = cmp("<="); break;
      case "eq": test = cmp("="); break;
      case "ne": test = cmp("<>"); break;
      case "between": test = between; break;
      case "notBetween": test = (x) => !isError(x.v as Scalar) && !between(x); break;
      // text rules: the rule's text, case-insensitive (Excel's SEARCH/LEFT/RIGHT formulas); error cells never contain
      case "contains": test = (x) => !isError(x.v as Scalar) && text(x).includes(needle); break;
      case "notContains": test = (x) => isError(x.v as Scalar) || !text(x).includes(needle); break;
      case "begins": test = (x) => !isError(x.v as Scalar) && text(x).startsWith(needle); break;
      case "ends": test = (x) => !isError(x.v as Scalar) && text(x).endsWith(needle); break;
      // LEN(TRIM(A1))=0 / >0 — a cell of spaces is blank; an error cell is neither
      case "blanks": test = (x) => !isError(x.v as Scalar) && text(x).replace(/ /g, "") === ""; break;
      case "noBlanks": test = (x) => !isError(x.v as Scalar) && text(x).replace(/ /g, "") !== ""; break;
      case "errors": test = (x) => isError(x.v as Scalar); break;
      case "noErrors": test = (x) => !isError(x.v as Scalar); break;
      case "duplicate": case "unique": {
        const keyOf = (v: Scalar | undefined) => (v === undefined || v === "" || isError(v as Scalar) ? null : typeof v === "string" ? "s:" + v.toLowerCase() : "v:" + JSON.stringify(v));
        const count = new Map<string, number>(); for (const x of cells) { const k = keyOf(x.v); if (k) count.set(k, (count.get(k) ?? 0) + 1); }
        const want = rule.kind === "duplicate";
        test = (x) => { const k = keyOf(x.v); return !!k && ((count.get(k) ?? 0) > 1) === want; };
        break;
      }
      case "top": {
        const rank = Math.max(0, Math.trunc(Number(rule.a)) || 10);
        // Top N% counts floor(n·N/100) values (at least one); ties at the cut are included
        const k = rule.pct ? Math.max(1, Math.floor((nums.length * Math.min(rank, 100)) / 100)) : rank;
        const order = rule.bottom ? sorted : [...sorted].reverse();
        const cut = order[Math.min(k, order.length) - 1];
        test = (x) => typeof x.v === "number" && cut !== undefined && (rule.bottom ? x.v <= cut : x.v >= cut);
        break;
      }
      case "aboveAvg": {
        if (!nums.length) continue;
        const avg = nums.reduce((p, q) => p + q, 0) / nums.length;
        const sd = rule.stdDev ? sampleStdev(nums) * rule.stdDev : 0;
        const comp = rule.below ? avg - sd : avg + sd;
        test = (x) => typeof x.v === "number" && (rule.below ? (rule.equal ? x.v <= comp : x.v < comp) : (rule.equal ? x.v >= comp : x.v > comp));
        break;
      }
      case "expr": { const f = rule.formula; if (!f) continue; test = (x) => truthy(F(f, x.c, x.r)); break; }
      case "period": {
        const f = rule.formula ?? periodFormula(rule.period ?? "", `${colToLetters(ac)}${ar + 1}`); if (!f) continue;
        test = (x) => truthy(F(f, x.c, x.r)); break;
      }
      default: continue;
    }
    for (const x of live) if (test(x)) { apply(x.k, style); if (rule.stop) stopped.add(x.k); }
  }
  return out;
}
const DEFAULT_PCT: Record<number, number[]> = { 3: [0, 33, 67], 4: [0, 25, 50, 75], 5: [0, 20, 40, 60, 80] };

/* ------------------------------------------------------------------ untrusted JSON validation */
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const CFVO = "(?:min|max|(?:num|percent|percentile):-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)";
const SCALE_AT = new RegExp(`^${CFVO}(?:\\|${CFVO}){1,2}$`);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
const finite = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
/** TT50: trendline spec from untrusted JSON (type allow-list, numeric ranges clamped as Excel's dialog does). */
export function sanitizeTrend(raw: unknown): TrendSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (!TREND_TYPES.includes(o.type as TrendType)) return undefined;
  const t: TrendSpec = { type: o.type as TrendType };
  if (t.type === "poly") t.order = Math.round(finite(o.order, 2, 6) ?? 2);
  if (t.type === "movingAvg") t.period = Math.round(finite(o.period, 2, 255) ?? 2);
  const fw = finite(o.forward, 0, 1e9), bw = finite(o.backward, 0, 1e9), ic = finite(o.intercept, -1e300, 1e300);
  if (fw) t.forward = fw; if (bw) t.backward = bw; if (ic !== undefined && (t.type === "linear" || t.type === "exp")) t.intercept = ic;
  if (o.dispEq === true) t.dispEq = true; if (o.dispRSqr === true) t.dispRSqr = true;
  const nm = str(o.name, 255); if (nm) t.name = nm;
  return t;
}
const REF_MAX = 600;
export function sanitizeCharts(raw: unknown): ChartSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    const series = Array.isArray(o.series) ? o.series.slice(0, 255).flatMap((x): ChartSeriesRef[] => {
      if (!x || typeof x !== "object") return [];
      const r = x as Record<string, unknown>;
      // an over-long reference is dropped, never truncated (a cut reference would point somewhere else)
      const ref = (v: unknown) => (typeof v === "string" && v.length <= REF_MAX ? v : undefined);
      if (typeof r.val === "string" && r.val.length > REF_MAX) return [];
      const val = ref(r.val) ?? ""; const valCache = Array.isArray(r.valCache) ? r.valCache.slice(0, 20_000).map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null)) : undefined;
      if (!val && !valCache) return [];
      const out: ChartSeriesRef = { val };
      const name = str(r.name, 255), nameRef = ref(r.nameRef), cat = ref(r.cat), trend = sanitizeTrend(r.trend);
      if (name !== undefined) out.name = name; if (nameRef) out.nameRef = nameRef; if (cat) out.cat = cat; if (valCache) out.valCache = valCache;
      if (Array.isArray(r.catCache)) out.catCache = r.catCache.slice(0, 20_000).map((v) => (typeof v === "string" ? v.slice(0, 255) : typeof v === "number" ? String(v) : ""));
      if (typeof r.color === "string" && /^#[0-9a-fA-F]{6}$/.test(r.color)) out.color = r.color; if (trend) out.trend = trend;
      return [out];
    }) : undefined;
    const hasSeries = !!series?.length;
    if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.sheet !== "string" || !o.sheet || o.sheet.length > 255 || typeof o.range !== "string" || (!hasSeries && !parseRange(o.range))) return [];
    if (!CHART_KINDS.includes(o.kind as ChartKind)) return [];
    const spec: ChartSpec = { id: o.id, sheet: o.sheet /* TT49: never truncate — a file may carry a longer name and the rule must keep pointing at it */, range: hasSeries ? o.range.slice(0, REF_MAX) : o.range, kind: o.kind as ChartKind, title: typeof o.title === "string" ? o.title.slice(0, 255) : "", headerRow: o.headerRow !== false };
    if (o.grouping === "stacked" || o.grouping === "percent") spec.grouping = o.grouping; else if (o.grouping === "clustered") spec.grouping = "clustered";
    const ct = str(o.catTitle, 255), vt = str(o.valTitle, 255), tr = sanitizeTrend(o.trend), nf = str(o.numFmt, 255), src = str(o.src, 255), note = str(o.note, 500);
    if (ct) spec.catTitle = ct; if (vt) spec.valTitle = vt; if (tr) spec.trend = tr; if (nf) spec.numFmt = nf;
    if (src && /^[\w./-]+\.xml$/.test(src) && !src.includes("..")) spec.src = src; if (note) spec.note = note;
    if (typeof o.legend === "boolean") spec.legend = o.legend;
    if (o.blanks === "zero" || o.blanks === "span" || o.blanks === "gap") spec.blanks = o.blanks;
    if (hasSeries) spec.series = series;
    if (o.anchor && typeof o.anchor === "object") {
      const a = o.anchor as Record<string, unknown>; const v = [a.c0, a.r0, a.c1, a.r1].map((x) => finite(x, 0, 1_048_575));
      if (v.every((x) => x !== undefined)) spec.anchor = { c0: Math.min(v[0]!, 16383), r0: v[1]!, c1: Math.min(Math.max(v[2]!, v[0]!), 16383), r1: Math.max(v[3]!, v[1]!) };
    }
    return [spec];
  });
}
const CFVO_T = ["min", "max", "num", "percent", "percentile", "formula", "autoMin", "autoMax"];
const NUMFMT_MAX = 255;
export function sanitizeCondFormats(raw: unknown): CondRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 2000).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.sheet !== "string" || !o.sheet || o.sheet.length > 255 || typeof o.range !== "string" || o.range.length > 65_536 || !parseRanges(o.range)) return [];
    if (!(COND_KINDS as readonly string[]).includes(o.kind as string)) return [];
    // a formula is never truncated (that would silently change what it means): over-long → the rule is rejected
    if ((typeof o.formula === "string" && o.formula.length > 4000) || (typeof o.af === "string" && o.af.length > 2000) || (typeof o.bf === "string" && o.bf.length > 2000)) return [];
    const str = (k: string, max = 200) => (typeof o[k] === "string" ? (o[k] as string).slice(0, max) : undefined);
    const col = (k: string) => (typeof o[k] === "string" && HEX.test(o[k] as string) ? (o[k] as string) : undefined);
    const flag = (k: string) => (o[k] === true ? true : undefined);
    const int = (k: string, lo: number, hi: number) => (typeof o[k] === "number" && Number.isInteger(o[k]) && (o[k] as number) >= lo && (o[k] as number) <= hi ? (o[k] as number) : undefined);
    const cfvo = Array.isArray(o.cfvo) ? (o.cfvo as unknown[]).slice(0, 5).flatMap((x) => {
      if (!x || typeof x !== "object") return [];
      const v = x as Record<string, unknown>; if (!CFVO_T.includes(v.t as string)) return [];
      return [{ t: v.t as Cfvo["t"], ...(typeof v.v === "string" ? { v: v.v.slice(0, 1000) } : {}), ...(v.gt === true ? { gt: true } : {}) }];
    }) : undefined;
    const LINES = ["thin", "medium", "thick", "dashed", "dotted", "double", "hair"];
    const side = (x: unknown): BorderSide | undefined => { if (!x || typeof x !== "object") return undefined; const v = x as Record<string, unknown>; if (!LINES.includes(v.style as string)) return undefined; return typeof v.color === "string" && HEX.test(v.color) ? { style: v.style as BorderSide["style"], color: v.color } : { style: v.style as BorderSide["style"] }; };
    let border: CellBorder | undefined;
    if (o.border && typeof o.border === "object") { const bo = o.border as Record<string, unknown>; const b: CellBorder = {}; for (const k of ["top", "right", "bottom", "left"] as const) { const sd = side(bo[k]); if (sd) b[k] = sd; } if (Object.keys(b).length) border = b; }
    const icons = Array.isArray(o.icons) ? (o.icons as unknown[]).slice(0, 5).filter((x): x is string => typeof x === "string" && /^[0-9A-Za-z]{1,20}:\d$/.test(x)) : undefined;
    const r: CondRule = {
      id: o.id, sheet: o.sheet /* TT49: never truncate — a file may carry a longer name and the rule must keep pointing at it */, range: o.range, kind: o.kind as CondKind, a: str("a"), b: str("b"), af: str("af", 2000), bf: str("bf", 2000), formula: str("formula", 4000),
      fill: col("fill"), color: col("color"), bold: flag("bold"), italic: flag("italic"), underline: flag("underline"), strike: flag("strike"), numFmt: str("numFmt", NUMFMT_MAX), border, stop: flag("stop"),
      pct: flag("pct"), bottom: flag("bottom"), below: flag("below"), equal: flag("equal"), stdDev: int("stdDev", 1, 3),
      period: (TIME_PERIODS as readonly string[]).includes(o.period as string) ? (o.period as string) : undefined,
      scaleMin: col("scaleMin"), scaleMax: col("scaleMax"), scaleMid: col("scaleMid"), scaleAt: typeof o.scaleAt === "string" && SCALE_AT.test(o.scaleAt) ? o.scaleAt : undefined,
      cfvo: cfvo?.length ? cfvo : undefined, barColor: col("barColor"), barNeg: col("barNeg"), barAxis: ["auto", "middle", "none"].includes(o.barAxis as string) ? (o.barAxis as CondRule["barAxis"]) : undefined,
      barAxisColor: col("barAxisColor"), barMinLen: int("barMinLen", 0, 100), barMaxLen: int("barMaxLen", 0, 100), barSolid: flag("barSolid"), barBorder: col("barBorder"),
      iconSet: typeof o.iconSet === "string" && ICON_SETS[o.iconSet] ? o.iconSet : undefined, icons: icons?.length ? icons : undefined, reverse: flag("reverse"), hideValue: flag("hideValue"),
      x14: typeof o.x14 === "string" && /^\{[0-9A-Fa-f-]{36}\}$/.test(o.x14) ? o.x14 : undefined,
      src: typeof o.src === "string" && /^(\d{1,6}\.\d{1,4}|x\d{1,5})$/.test(o.src) ? o.src : undefined,
    };
    for (const k of Object.keys(r) as (keyof CondRule)[]) if (r[k] === undefined) delete r[k];
    return [r];
  });
}
