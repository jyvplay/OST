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
import { colToLetters, lettersToCol, type Scalar } from "./types";

export type ChartKind = "bar" | "line" | "pie" | "scatter";
export interface ChartSpec { id: string; sheet: string; range: string; kind: ChartKind; title: string; headerRow: boolean }
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
export interface Series { name: string; values: (number | null)[] }
export interface ChartData { categories: string[]; series: Series[]; numFmt?: string }

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

export function buildChartSvg(kind: ChartKind, title: string, data: ChartData, width = 520, height = 300): string {
  const pts = data.series.flatMap((s) => s.values).filter((x): x is number => x !== null);
  if (!pts.length) throw new Error("a chart needs at least one numeric point");
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="0" y="0" width="${width}" height="${height}" fill="#0f172a"/>`;
  const titleEl = `<text x="${width / 2}" y="20" font-size="14" font-family="sans-serif" text-anchor="middle" fill="#e2e8f0">${xml(title)}</text>`;
  if (kind === "pie") return head + titleEl + piePart(data, width, height) + "</svg>";
  const multi = data.series.length > 1;
  const left = 56, right = multi ? 120 : 16, top = 34, bottom = 44;
  const pw = width - left - right, ph = height - top - bottom;
  const tick = (n: number) => formatValue(n, data.numFmt && !/[dmyhs]/i.test(data.numFmt) ? data.numFmt : "General").text;
  let xs: number[] | null = null;
  if (kind === "scatter") { xs = data.categories.map(Number); if (xs.some((x) => !Number.isFinite(x))) throw new Error("scatter X values must be numeric"); }
  const yt = niceTicks(Math.min(0, ...pts), Math.max(0, ...pts));
  const lo = yt[0], hi = yt[yt.length - 1];
  const yOf = (v: number) => top + ((hi - v) / (hi - lo || 1)) * ph;
  const n = data.categories.length; const slot = pw / Math.max(1, n);
  let xOf = (i: number) => left + i * slot + slot / 2;
  let xAxis = "";
  if (xs) {
    const xt = niceTicks(Math.min(...xs), Math.max(...xs)); const xl = xt[0], xh = xt[xt.length - 1];
    const sx = (x: number) => left + ((x - xl) / (xh - xl || 1)) * pw;
    xOf = (i: number) => sx(xs![i]);
    xAxis = xt.map((t) => `<text x="${sx(t)}" y="${top + ph + 16}" font-size="10" font-family="sans-serif" text-anchor="middle" fill="#cbd5e1">${xml(tick(t))}</text>`).join("");
  } else {
    const every = Math.ceil(n / Math.max(1, Math.floor(pw / 46)));
    xAxis = data.categories.map((c, i) => (i % every ? "" : `<text x="${xOf(i)}" y="${top + ph + 16}" font-size="10" font-family="sans-serif" text-anchor="middle" fill="#cbd5e1">${xml(c.slice(0, 12))}</text>`)).join("");
  }
  const grid = yt.map((t) => `<line x1="${left}" y1="${yOf(t)}" x2="${left + pw}" y2="${yOf(t)}" stroke="#1e293b" stroke-width="1"/><text x="${left - 6}" y="${yOf(t) + 3}" font-size="10" font-family="sans-serif" text-anchor="end" fill="#94a3b8">${xml(tick(t))}</text>`).join("");
  const axis = `<polyline points="${left},${top} ${left},${top + ph} ${left + pw},${top + ph}" fill="none" stroke="#64748b" stroke-width="1"/>` + (lo < 0 ? `<line x1="${left}" y1="${yOf(0)}" x2="${left + pw}" y2="${yOf(0)}" stroke="#94a3b8" stroke-width="1"/>` : "");
  let body = "";
  if (kind === "bar") {
    const k = data.series.length; const groupW = slot * 0.75; const barW = groupW / k;
    data.series.forEach((s, si) => s.values.forEach((v, i) => {
      if (v === null) return;
      const x = left + i * slot + (slot - groupW) / 2 + si * barW; const y = Math.min(yOf(v), yOf(0)); const h = Math.abs(yOf(v) - yOf(0));
      body += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(1, barW - 1).toFixed(2)}" height="${h.toFixed(2)}" fill="${multi ? PALETTE[si % PALETTE.length] : PALETTE[i % PALETTE.length]}"/>`;
    }));
  } else {
    data.series.forEach((s, si) => {
      const color = PALETTE[si % PALETTE.length];
      // gaps break the line (Excel "show empty cells as gaps")
      let seg: string[] = []; const segs: string[][] = [];
      s.values.forEach((v, i) => { if (v === null) { if (seg.length) segs.push(seg); seg = []; } else seg.push(`${xOf(i).toFixed(2)},${yOf(v).toFixed(2)}`); });
      if (seg.length) segs.push(seg);
      if (kind === "line") for (const g of segs) body += `<polyline points="${g.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
      s.values.forEach((v, i) => { if (v !== null) body += `<circle cx="${xOf(i).toFixed(2)}" cy="${yOf(v).toFixed(2)}" r="${kind === "scatter" ? 3.5 : 2.5}" fill="${color}"/>`; });
    });
  }
  const legend = multi ? data.series.map((s, i) => `<rect x="${width - right + 12}" y="${top + i * 18}" width="10" height="10" fill="${PALETTE[i % PALETTE.length]}"/><text x="${width - right + 27}" y="${top + i * 18 + 9}" font-size="11" font-family="sans-serif" fill="#e2e8f0">${xml(s.name.slice(0, 14))}</text>`).join("") : "";
  return head + titleEl + grid + axis + body + xAxis + legend + "</svg>";
}

function piePart(data: ChartData, width: number, height: number): string {
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
export function sanitizeCharts(raw: unknown): ChartSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.sheet !== "string" || !o.sheet || o.sheet.length > 255 || typeof o.range !== "string" || !parseRange(o.range)) return [];
    if (!["bar", "line", "pie", "scatter"].includes(o.kind as string)) return [];
    return [{ id: o.id, sheet: o.sheet /* TT49: never truncate — a file may carry a longer name and the rule must keep pointing at it */, range: o.range, kind: o.kind as ChartKind, title: typeof o.title === "string" ? o.title.slice(0, 120) : "", headerRow: o.headerRow !== false }];
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
