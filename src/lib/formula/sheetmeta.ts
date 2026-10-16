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
 * Conditional formatting: greater/less/equal/between/text-contains/duplicate/
 * 2-colour scale/data-bar-free top-N rules, evaluated against computed values
 * (spill-aware via Workbook.valueAt). Not exported to .xlsx (loss report).
 */
import type { Workbook } from "./engine";
import { formatValue } from "./numfmt";
import { colToLetters, lettersToCol, type Scalar } from "./types";

export type ChartKind = "bar" | "line" | "pie" | "scatter";
export interface ChartSpec { id: string; sheet: string; range: string; kind: ChartKind; title: string; headerRow: boolean }
export type CondKind = "gt" | "lt" | "eq" | "between" | "contains" | "duplicate" | "top" | "scale";
export interface CondRule { id: string; sheet: string; range: string; kind: CondKind; a?: string; b?: string; fill?: string; color?: string; bold?: boolean; scaleMin?: string; scaleMax?: string }

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
export interface CfStyle { fill?: string; color?: string; bold?: boolean }
const lerp = (a: string, b: string, t: number) => {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, "0")).join("");
};
/** Evaluate every rule for one sheet → per-cell overlay ("col,row" keys). Later rules win (Excel applies in priority order; first rule = highest priority, so we apply in reverse). */
export function evalCondFormats(wb: Workbook, sheet: string, rules: CondRule[]): Map<string, CfStyle> {
  const out = new Map<string, CfStyle>();
  for (const rule of [...rules].reverse()) {
    if (rule.sheet !== sheet) continue;
    const r = parseRange(rule.range); if (!r) continue;
    if ((r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1) > 100_000) continue;
    const cells: { k: string; v: Scalar | undefined }[] = [];
    for (let row = r.r0; row <= r.r1; row++) for (let c = r.c0; c <= r.c1; c++) cells.push({ k: `${c},${row}`, v: wb.valueAt(sheet, c, row) });
    const nums = cells.map((x) => x.v).filter((v): v is number => typeof v === "number");
    const a = Number(rule.a), b = Number(rule.b);
    const style: CfStyle = { fill: rule.fill, color: rule.color, bold: rule.bold };
    let test: (v: Scalar | undefined) => boolean = () => false;
    switch (rule.kind) {
      case "gt": test = (v) => typeof v === "number" && v > a; break;
      case "lt": test = (v) => typeof v === "number" && v < a; break;
      case "eq": test = (v) => (typeof v === "number" && !Number.isNaN(a) ? v === a : String(v ?? "").toLowerCase() === String(rule.a ?? "").toLowerCase()); break;
      case "between": test = (v) => typeof v === "number" && v >= Math.min(a, b) && v <= Math.max(a, b); break;
      case "contains": test = (v) => typeof v === "string" && !!rule.a && v.toLowerCase().includes(rule.a.toLowerCase()); break;
      case "duplicate": {
        const seen = new Map<string, number>(); for (const x of cells) if (x.v !== undefined && x.v !== "") { const key = typeof x.v === "string" ? "s:" + x.v.toLowerCase() : "v:" + JSON.stringify(x.v); seen.set(key, (seen.get(key) ?? 0) + 1); }
        test = (v) => v !== undefined && v !== "" && (seen.get(typeof v === "string" ? "s:" + v.toLowerCase() : "v:" + JSON.stringify(v)) ?? 0) > 1; break;
      }
      case "top": { const k = Math.max(1, Math.trunc(a) || 10); const cut = [...nums].sort((x, y) => y - x)[Math.min(k, nums.length) - 1]; test = (v) => typeof v === "number" && cut !== undefined && v >= cut; break; }
      case "scale": {
        const lo = Math.min(...nums), hi = Math.max(...nums); const c0 = HEX.test(rule.scaleMin ?? "") ? rule.scaleMin! : "#f8696b", c1 = HEX.test(rule.scaleMax ?? "") ? rule.scaleMax! : "#63be7b";
        for (const x of cells) if (typeof x.v === "number") out.set(x.k, { ...out.get(x.k), fill: lerp(c0, c1, hi > lo ? (x.v - lo) / (hi - lo) : 0.5) });
        continue;
      }
    }
    for (const x of cells) if (test(x.v)) out.set(x.k, { ...out.get(x.k), ...Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined)) });
  }
  return out;
}

/* ------------------------------------------------------------------ untrusted JSON validation */
const ID = /^[A-Za-z0-9_-]{1,40}$/;
export function sanitizeCharts(raw: unknown): ChartSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.sheet !== "string" || typeof o.range !== "string" || !parseRange(o.range)) return [];
    if (!["bar", "line", "pie", "scatter"].includes(o.kind as string)) return [];
    return [{ id: o.id, sheet: o.sheet.slice(0, 31), range: o.range, kind: o.kind as ChartKind, title: typeof o.title === "string" ? o.title.slice(0, 120) : "", headerRow: o.headerRow !== false }];
  });
}
export function sanitizeCondFormats(raw: unknown): CondRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((c) => {
    if (!c || typeof c !== "object") return [];
    const o = c as Record<string, unknown>;
    if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.sheet !== "string" || typeof o.range !== "string" || !parseRange(o.range)) return [];
    if (!["gt", "lt", "eq", "between", "contains", "duplicate", "top", "scale"].includes(o.kind as string)) return [];
    const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).slice(0, 200) : undefined);
    const col = (k: string) => (typeof o[k] === "string" && HEX.test(o[k] as string) ? (o[k] as string) : undefined);
    return [{ id: o.id, sheet: o.sheet.slice(0, 31), range: o.range, kind: o.kind as CondKind, a: str("a"), b: str("b"), fill: col("fill"), color: col("color"), bold: o.bold === true || undefined, scaleMin: col("scaleMin"), scaleMax: col("scaleMax") }];
  });
}
