/**
 * TT50 — Excel charts in .xlsx packages (DrawingML, ECMA-376 Part 1 §21.2 "chart" + §20.5 spreadsheet drawing).
 * Written from the schema (CT_ChartSpace / CT_PlotArea / CT_*Ser / CT_Trendline / CT_CatAx / CT_ValAx and
 * xdr:wsDr anchors); no chart code was copied from any library.
 *
 *  READ  worksheet or chartsheet → <drawing r:id> → drawing part → every graphicFrame whose graphicData is a chart
 *        (also inside xdr:grpSp groups and mc:AlternateContent) → chart part → ChartSpec: type (bar/col, line, area,
 *        pie, doughnut, scatter; 3-D variants flattened; radar/stock/bubble/surface mapped to the nearest 2-D type
 *        with a note), grouping, every series' tx/cat/val (or xVal/yVal) references WITH their caches, series
 *        colour, trendlines, chart title (rich text or a cell reference), axis titles, legend, dispBlanksAs, anchor.
 *  WRITE a ChartSpec → c:chartSpace (series references + caches so a reader sees values without recalculating) and
 *        the xdr:twoCellAnchor that places it. Used by the new-workbook writer and by the lossless patch writer.
 */
import { parseXml, attr, kids, textOf, type XEl, type XDoc } from "../office/xmltree";
import { chartDataFor, parseRange, type ChartGrouping, type ChartKind, type ChartSeriesRef, type ChartSpec } from "./sheetmeta";
import type { Workbook } from "./engine";
import { colToLetters } from "./types";
import { TREND_TYPES, type TrendSpec, type TrendType } from "./trend";

export const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
export const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const NS_XDR = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";
export const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const REL_DRAWING = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing";
export const REL_CHART = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
export const CT_DRAWING = "application/vnd.openxmlformats-officedocument.drawing+xml";
export const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const MAX_SERIES = 255, MAX_PTS = 20_000;

const ln = (n: string) => n.slice(n.indexOf(":") + 1);
const kidsL = (e: XEl | undefined, name: string) => kids(e).filter((k) => ln(k.name) === name);
const kidL = (e: XEl | undefined, name: string) => kidsL(e, name)[0];
const val = (e: XEl | undefined) => attr(e, "val");
const flag = (e: XEl | undefined, dflt = true) => { if (!e) return undefined; const v = val(e); return v === undefined ? dflt : v === "1" || v === "true"; };
const numAttr = (e: XEl | undefined) => { const v = Number(val(e)); return val(e) !== undefined && Number.isFinite(v) ? v : undefined; };
/** relationship id attribute (r:id with any prefix bound to the relationships namespace) */
const rid = (e: XEl | undefined) => e?.attrs.find(([k]) => ln(k) === "id" && k.includes(":"))?.[1];

/** a:p paragraphs of a rich text body → one line (runs and fields concatenated, paragraphs joined by a space) */
function richText(tx: XEl | undefined): string | undefined {
  const rich = kidL(tx, "rich"); if (!rich) return undefined;
  return kidsL(rich, "p").map((p) => kids(p).filter((k) => ln(k.name) === "r" || ln(k.name) === "fld").map((r) => textOf(kidL(r, "t") ?? r)).join("")).join(" ").trim();
}
/** c:strCache / c:numCache / c:strLit / c:numLit → values by point index (missing points = null) */
function cache(e: XEl | undefined): { pts: (string | null)[]; fmt?: string } | undefined {
  if (!e) return undefined;
  const count = Math.min(MAX_PTS, Math.max(0, numAttr(kidL(e, "ptCount")) ?? 0));
  const pts = new Array<string | null>(count).fill(null);
  for (const p of kidsL(e, "pt")) { const i = Number(attr(p, "idx")); if (Number.isInteger(i) && i >= 0 && i < MAX_PTS) { while (pts.length <= i) pts.push(null); pts[i] = textOf(kidL(p, "v") ?? p); } }
  const fmt = kidL(e, "formatCode"); return { pts, fmt: fmt ? textOf(fmt) : undefined };
}
/** c:tx / c:cat / c:val / c:xVal / c:yVal → reference formula + cached points */
function dataRef(e: XEl | undefined): { f?: string; pts?: (string | null)[]; fmt?: string } {
  if (!e) return {};
  for (const k of kids(e)) {
    const n = ln(k.name);
    if (n === "strRef" || n === "numRef" || n === "multiLvlStrRef") {
      const f = kidL(k, "f"); const c = cache(kidL(k, n === "strRef" ? "strCache" : n === "numRef" ? "numCache" : "multiLvlStrCache"));
      // multi-level categories: use the innermost level (what the axis shows next to the plot)
      const lvl = n === "multiLvlStrRef" ? cache(kidsL(kidL(k, "multiLvlStrCache"), "lvl")[0]) : undefined;
      return { f: f ? textOf(f).trim() : undefined, pts: (lvl ?? c)?.pts, fmt: c?.fmt };
    }
    if (n === "strLit" || n === "numLit") { const c = cache(k); return { pts: c?.pts, fmt: c?.fmt }; }
    if (n === "v") return { pts: [textOf(k)] };
  }
  return {};
}
const toNum = (s: string | null) => { if (s === null || s.trim() === "") return null; const v = Number(s); return Number.isFinite(v) ? v : null; };
function solidColor(spPr: XEl | undefined): string | undefined {
  if (!spPr) return undefined;
  const fill = kidL(spPr, "solidFill") ?? kidL(kidL(spPr, "ln"), "solidFill");
  const rgb = kidL(fill, "srgbClr"); const v = val(rgb);
  return v && /^[0-9A-Fa-f]{6}$/.test(v) ? `#${v.toLowerCase()}` : undefined;
}
function readTrend(t: XEl): TrendSpec | undefined {
  const type = val(kidL(t, "trendlineType")) as TrendType | undefined; if (!type || !TREND_TYPES.includes(type)) return undefined;
  const out: TrendSpec = { type };
  const order = numAttr(kidL(t, "order")), period = numAttr(kidL(t, "period")), fw = numAttr(kidL(t, "forward")), bw = numAttr(kidL(t, "backward")), ic = numAttr(kidL(t, "intercept"));
  if (type === "poly") out.order = Math.max(2, Math.min(6, Math.round(order ?? 2)));
  if (type === "movingAvg") out.period = Math.max(2, Math.min(255, Math.round(period ?? 2)));
  if (fw) out.forward = fw; if (bw) out.backward = bw; if (ic !== undefined) out.intercept = ic;
  if (flag(kidL(t, "dispEq"))) out.dispEq = true; if (flag(kidL(t, "dispRSqr"))) out.dispRSqr = true;
  const nm = kidL(t, "name"); if (nm) out.name = textOf(nm).slice(0, 255);
  return out;
}

const KIND: Record<string, { kind: ChartKind; note?: string }> = {
  barChart: { kind: "bar" }, bar3DChart: { kind: "bar", note: "3-D chart drawn flat" },
  lineChart: { kind: "line" }, line3DChart: { kind: "line", note: "3-D chart drawn flat" },
  areaChart: { kind: "area" }, area3DChart: { kind: "area", note: "3-D chart drawn flat" },
  pieChart: { kind: "pie" }, pie3DChart: { kind: "pie", note: "3-D chart drawn flat" }, ofPieChart: { kind: "pie", note: "pie-of-pie drawn as one pie" },
  doughnutChart: { kind: "doughnut" }, scatterChart: { kind: "scatter" },
  radarChart: { kind: "line", note: "radar chart drawn as a line chart" }, stockChart: { kind: "line", note: "stock chart drawn as a line chart" },
  bubbleChart: { kind: "scatter", note: "bubble chart drawn as a scatter chart (bubble sizes not shown)" },
  surfaceChart: { kind: "line", note: "surface chart drawn as a line chart" }, surface3DChart: { kind: "line", note: "surface chart drawn as a line chart" },
};

/** Parses one chart part. `sheet` = the sheet the chart sits on; series references keep their own sheet names. */
export function parseChartXml(xml: string, opts: { id: string; sheet: string; src: string; anchor?: ChartSpec["anchor"] }): ChartSpec | null {
  const doc = parseXml(xml);
  const chart = kidL(doc.root, "chart"); const plot = kidL(chart, "plotArea"); if (!plot) return null;
  const types = kids(plot).filter((k) => KIND[ln(k.name)]);
  if (!types.length) return null;
  const main = types[0]; const tn = ln(main.name); const k = KIND[tn];
  let kind = k.kind; const notes: string[] = k.note ? [k.note] : [];
  if (types.length > 1) notes.push(`combo chart: ${types.length} chart types, drawn as the first (${tn.replace(/Chart$/, "")})`);
  if (kind === "bar" && val(kidL(main, "barDir")) === "bar") kind = "hbar";
  const g = val(kidL(main, "grouping"));
  const grouping: ChartGrouping | undefined = g === "stacked" ? "stacked" : g === "percentStacked" ? "percent" : undefined;
  const series: ChartSeriesRef[] = [];
  let numFmt: string | undefined;
  for (const t of types) for (const s of kidsL(t, "ser")) {
    if (series.length >= MAX_SERIES) break;
    const tx = kidL(s, "tx"); const name = dataRef(tx); const nameRich = richText(tx);
    const cat = dataRef(kidL(s, "cat") ?? kidL(s, "xVal")); const v = dataRef(kidL(s, "val") ?? kidL(s, "yVal"));
    if (!v.f && !v.pts) continue;
    numFmt ??= v.fmt && v.fmt !== "General" ? v.fmt : undefined;
    const ref: ChartSeriesRef = { val: v.f ?? "" };
    if (v.pts) ref.valCache = v.pts.map(toNum);
    if (name.f) ref.nameRef = name.f;
    const nm = name.pts?.[0] ?? nameRich; if (nm) ref.name = nm.slice(0, 255);
    if (cat.f) ref.cat = cat.f;
    if (cat.pts) ref.catCache = cat.pts.map((p) => p ?? "");
    const color = solidColor(kidL(s, "spPr")); if (color) ref.color = color;
    const tr = kidsL(s, "trendline").map(readTrend).find(Boolean); if (tr) ref.trend = tr;
    if (kidsL(s, "trendline").length > 1) notes.push("only the first trendline of a series is drawn");
    series.push(ref);
  }
  if (!series.length) return null;
  // axis titles: category axis = horizontal on column/line/area charts; scatter X = the value axis at the bottom/top
  let catTitle: string | undefined, valTitle: string | undefined;
  for (const ax of kids(plot)) {
    const an = ln(ax.name); if (!["catAx", "valAx", "dateAx", "serAx"].includes(an)) continue;
    const title = kidL(ax, "title"); if (!title || flag(kidL(ax, "delete"), true)) continue;
    const text = richText(kidL(title, "tx")) ?? dataRef(kidL(title, "tx")).pts?.[0] ?? "Axis Title";
    const pos = val(kidL(ax, "axPos"));
    const isCat = kind === "scatter" ? pos === "b" || pos === "t" : an !== "valAx";
    if (isCat) catTitle ??= text; else valTitle ??= text;
  }
  // chart title: explicit text / reference cache; a title element without text, or no title on a one-series chart
  // that did not delete its automatic title, shows the series name (Excel's automatic title)
  const te = kidL(chart, "title");
  const deleted = flag(kidL(chart, "autoTitleDeleted"), true) ?? false;
  let title = "";
  if (te) title = richText(kidL(te, "tx")) ?? dataRef(kidL(te, "tx")).pts?.[0] ?? (series.length === 1 ? series[0].name ?? "" : "Chart Title");
  else if (!deleted && series.length === 1) title = series[0].name ?? "";
  const legendEl = kidL(chart, "legend");
  const blanks = val(kidL(chart, "dispBlanksAs"));
  const spec: ChartSpec = { id: opts.id, sheet: opts.sheet, range: series[0].val, kind, title: title.slice(0, 255), headerRow: false, series, src: opts.src };
  if (grouping && (kind === "bar" || kind === "hbar" || kind === "line" || kind === "area")) spec.grouping = grouping;
  if (catTitle) spec.catTitle = catTitle.slice(0, 255); if (valTitle) spec.valTitle = valTitle.slice(0, 255);
  spec.legend = !!legendEl && !flag(kidL(legendEl, "delete"), true);
  if (blanks === "zero" || blanks === "span") spec.blanks = blanks;
  if (numFmt) spec.numFmt = numFmt;
  if (opts.anchor) spec.anchor = opts.anchor;
  if (notes.length) spec.note = [...new Set(notes)].join("; ");
  return spec;
}

/** One chart frame in a drawing part: its relationship id, cell anchor, top-level anchor element (`el`), the
 * graphicFrame itself and the element that directly contains it (the anchor, a group, or an mc:Choice). */
export interface ChartFrame { rid: string; anchor?: ChartSpec["anchor"]; el: XEl; frame: XEl; parent: XEl }
const DEF_COL_PX = 64, DEF_ROW_PX = 20, EMU_PX = 9525;
/** Every chart graphicFrame in a drawing part (inside groups and mc:AlternateContent too), in document order. */
export function chartFrames(drawingXml: string | XDoc): ChartFrame[] {
  const doc = typeof drawingXml === "string" ? parseXml(drawingXml) : drawingXml; const out: ChartFrame[] = [];
  const cell = (e: XEl | undefined) => e ? { c: Number(textOf(kidL(e, "col") ?? e)) || 0, r: Number(textOf(kidL(e, "row") ?? e)) || 0 } : undefined;
  const visit = (e: XEl, anchor: ChartSpec["anchor"] | undefined, top: XEl) => {
    for (const k of kids(e)) {
      const n = ln(k.name);
      if (n === "graphicFrame") {
        const gd = kidL(kidL(k, "graphic"), "graphicData");
        const c = kids(gd).find((x) => ln(x.name) === "chart");
        const id = rid(c); if (id) out.push({ rid: id, anchor, el: top, frame: k, parent: e });
      } else if (n === "grpSp" || n === "AlternateContent") visit(k, anchor, top);
      else if (n === "Choice") { visit(k, anchor, top); return; } // first Choice wins; Fallback is the same object
    }
  };
  for (const a of kids(doc.root)) {
    const n = ln(a.name); let anchor: ChartSpec["anchor"] | undefined;
    const from = cell(kidL(a, "from"));
    if (n === "twoCellAnchor") { const to = cell(kidL(a, "to")); if (from && to) anchor = { c0: from.c, r0: from.r, c1: Math.max(from.c, to.c), r1: Math.max(from.r, to.r) }; }
    else if (n === "oneCellAnchor" && from) {
      const ext = kidL(a, "ext"); const cx = Number(attr(ext, "cx")) / EMU_PX || 480, cy = Number(attr(ext, "cy")) / EMU_PX || 288;
      anchor = { c0: from.c, r0: from.r, c1: from.c + Math.max(1, Math.round(cx / DEF_COL_PX)), r1: from.r + Math.max(1, Math.round(cy / DEF_ROW_PX)) };
    } else if (n === "absoluteAnchor") {
      const pos = kidL(a, "pos"), ext = kidL(a, "ext");
      const x = Number(attr(pos, "x")) / EMU_PX || 0, y = Number(attr(pos, "y")) / EMU_PX || 0, cx = Number(attr(ext, "cx")) / EMU_PX || 480, cy = Number(attr(ext, "cy")) / EMU_PX || 288;
      anchor = { c0: Math.floor(x / DEF_COL_PX), r0: Math.floor(y / DEF_ROW_PX), c1: Math.floor((x + cx) / DEF_COL_PX), r1: Math.floor((y + cy) / DEF_ROW_PX) };
    }
    if (n === "AlternateContent") visit(a, undefined, a); else visit(a, anchor, a);
  }
  return out;
}

const relsPathOf = (part: string) => { const i = part.lastIndexOf("/"); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; };
export function resolvePart(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); }
  return parts.join("/");
}
function relTargets(get: (p: string) => string | null, part: string): Map<string, { target: string; type: string; external: boolean }> {
  const m = new Map<string, { target: string; type: string; external: boolean }>();
  const x = get(relsPathOf(part)); if (!x) return m;
  for (const r of kids(parseXml(x).root)) { const id = attr(r, "Id"), t = attr(r, "Target"); if (id && t) m.set(id, { target: resolvePart(part, t), type: attr(r, "Type") ?? "", external: attr(r, "TargetMode") === "External" }); }
  return m;
}

/** Charts of one worksheet or chartsheet part. `next()` yields unique ids. Unreadable charts are skipped. */
export function readSheetCharts(get: (p: string) => string | null, sheetPart: string, sheetXml: string, sheetName: string, next: () => string): ChartSpec[] {
  const m = /<(?:\w+:)?drawing\b([^>]*)\/?>/.exec(sheetXml); if (!m) return [];
  const id = /\b[\w]+:id\s*=\s*"([^"]*)"/.exec(m[1])?.[1]; if (!id) return [];
  const drawRel = relTargets(get, sheetPart).get(id); if (!drawRel || drawRel.external) return [];
  const dx = get(drawRel.target); if (!dx) return [];
  const rels = relTargets(get, drawRel.target);
  const out: ChartSpec[] = [];
  const chartsheet = /^\s*(<\?xml[^>]*>\s*)?<(\w+:)?chartsheet\b/.test(sheetXml);
  let frames: ChartFrame[] = [];
  try { frames = chartFrames(dx); } catch { return []; }
  for (const f of frames.slice(0, 200)) {
    const rel = rels.get(f.rid); if (!rel || rel.external || !/\/chart$/.test(rel.type)) continue;
    const cx = get(rel.target); if (!cx) continue;
    try { const spec = parseChartXml(cx, { id: next(), sheet: sheetName, src: rel.target, anchor: chartsheet ? undefined : f.anchor }); if (spec) out.push(spec); } catch { /* malformed chart part: skipped (kept verbatim by the patch writer) */ }
  }
  return out;
}

/* ------------------------------------------------------------------ writing */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
const richXml = (text: string) => `<c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx>`;
export const titleXml = (text: string) => `<c:title>${richXml(text)}<c:overlay val="0"/></c:title>`;
const numStr = (v: number) => String(v); // shortest round-trip form (17 significant digits at most), no precision loss
function strData(tag: "tx" | "cat", f: string | undefined, pts: string[]): string {
  const c = `<c:ptCount val="${pts.length}"/>${pts.map((p, i) => `<c:pt idx="${i}"><c:v>${esc(p)}</c:v></c:pt>`).join("")}`;
  return f ? `<c:${tag}><c:strRef><c:f>${esc(f)}</c:f><c:strCache>${c}</c:strCache></c:strRef></c:${tag}>` : tag === "tx" ? `<c:tx><c:v>${esc(pts[0] ?? "")}</c:v></c:tx>` : `<c:cat><c:strLit>${c}</c:strLit></c:cat>`;
}
function numData(tag: "val" | "cat" | "xVal" | "yVal", f: string | undefined, pts: (number | null)[], fmt = "General"): string {
  const c = `<c:formatCode>${esc(fmt)}</c:formatCode><c:ptCount val="${pts.length}"/>${pts.map((p, i) => (p === null ? "" : `<c:pt idx="${i}"><c:v>${numStr(p)}</c:v></c:pt>`)).join("")}`;
  return f ? `<c:${tag}><c:numRef><c:f>${esc(f)}</c:f><c:numCache>${c}</c:numCache></c:numRef></c:${tag}>` : `<c:${tag}><c:numLit>${c}</c:numLit></c:${tag}>`;
}
export function trendXml(t: TrendSpec): string {
  return `<c:trendline>${t.name ? `<c:name>${esc(t.name)}</c:name>` : ""}<c:trendlineType val="${t.type}"/>`
    + (t.type === "poly" ? `<c:order val="${Math.max(2, Math.min(6, t.order ?? 2))}"/>` : "")
    + (t.type === "movingAvg" ? `<c:period val="${Math.max(2, Math.min(255, t.period ?? 2))}"/>` : "")
    + (t.forward ? `<c:forward val="${numStr(t.forward)}"/>` : "") + (t.backward ? `<c:backward val="${numStr(t.backward)}"/>` : "")
    + (t.intercept !== undefined && (t.type === "linear" || t.type === "exp") ? `<c:intercept val="${numStr(t.intercept)}"/>` : "")
    + `<c:dispRSqr val="${t.dispRSqr ? 1 : 0}"/><c:dispEq val="${t.dispEq ? 1 : 0}"/></c:trendline>`;
}
/** Resolved series to write: references (may be empty → literal caches) plus the current values. */
export interface SeriesOut { name: string; /** no c:tx (series without a name in the source) */ noName?: boolean; nameRef?: string; cat?: string; val?: string; categories: string[]; values: (number | null)[]; xs?: (number | null)[]; color?: string; trend?: TrendSpec }
const PALETTE_HEX = ["38BDF8", "F472B6", "34D399", "FBBF24", "A78BFA", "FB7185", "22D3EE", "F97316"];
function axTitle(t: string | undefined) { return t ? titleXml(t) : ""; }

/** c:chartSpace for a chart. Axis ids 50010/50020 (any unique unsigned ints are valid). */
export function chartSpaceXml(spec: Pick<ChartSpec, "kind" | "title" | "grouping" | "catTitle" | "valTitle" | "legend" | "blanks" | "numFmt">, series: SeriesOut[]): string {
  const kind = spec.kind; const grouping = spec.grouping ?? "clustered";
  const trendOk = grouping === "clustered" && kind !== "pie" && kind !== "doughnut";
  const fmt = spec.numFmt ?? "General";
  const ser = series.slice(0, MAX_SERIES).map((s, i) => {
    const color = (s.color ?? `#${PALETTE_HEX[i % PALETTE_HEX.length]}`).slice(1).toUpperCase();
    const tx = s.noName ? "" : s.nameRef ? strData("tx", s.nameRef, [s.name]) : strData("tx", undefined, [s.name]);
    const sp = kind === "line" ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr>`
      : kind === "scatter" ? `<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr>`
      : kind === "pie" || kind === "doughnut" ? "" : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr>`;
    const marker = kind === "line" ? `<c:marker><c:symbol val="none"/></c:marker>` : kind === "scatter" ? `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></c:spPr></c:marker>` : "";
    const trend = trendOk && s.trend ? trendXml(s.trend) : "";
    const allNum = s.categories.length > 0 && s.categories.every((c) => c.trim() !== "" && Number.isFinite(Number(c)));
    const cat = kind === "scatter"
      ? numData("xVal", s.cat, s.xs ?? s.categories.map((c) => (Number.isFinite(Number(c)) ? Number(c) : null)))
      : allNum && s.cat ? numData("cat", s.cat, s.categories.map(Number)) : strData("cat", s.cat, s.categories);
    const v = numData(kind === "scatter" ? "yVal" : "val", s.val, s.values, fmt);
    const pre = `<c:idx val="${i}"/><c:order val="${i}"/>${tx}${sp}`;
    if (kind === "bar" || kind === "hbar") return `<c:ser>${pre}<c:invertIfNegative val="0"/>${trend}${cat}${v}</c:ser>`;
    if (kind === "line") return `<c:ser>${pre}${marker}${trend}${cat}${v}<c:smooth val="0"/></c:ser>`;
    if (kind === "area") return `<c:ser>${pre}${trend}${cat}${v}</c:ser>`;
    if (kind === "scatter") return `<c:ser>${pre}${marker}${trend}${cat}${v}<c:smooth val="0"/></c:ser>`;
    return `<c:ser>${pre}${cat}${v}</c:ser>`; // pie / doughnut
  }).join("");
  const G = grouping === "stacked" ? "stacked" : grouping === "percent" ? "percentStacked" : kind === "bar" || kind === "hbar" ? "clustered" : "standard";
  const ax = `<c:axId val="50010"/><c:axId val="50020"/>`;
  let type: string;
  if (kind === "bar" || kind === "hbar") type = `<c:barChart><c:barDir val="${kind === "hbar" ? "bar" : "col"}"/><c:grouping val="${G}"/><c:varyColors val="0"/>${ser}<c:gapWidth val="150"/>${grouping !== "clustered" ? `<c:overlap val="100"/>` : ""}${ax}</c:barChart>`;
  else if (kind === "line") type = `<c:lineChart><c:grouping val="${G}"/><c:varyColors val="0"/>${ser}<c:marker val="1"/>${ax}</c:lineChart>`;
  else if (kind === "area") type = `<c:areaChart><c:grouping val="${G}"/><c:varyColors val="0"/>${ser}${ax}</c:areaChart>`;
  else if (kind === "scatter") type = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser}${ax}</c:scatterChart>`;
  else if (kind === "doughnut") type = `<c:doughnutChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
  else type = `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`;
  const tick = `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>`;
  let axes = "";
  if (kind === "scatter") {
    axes = `<c:valAx><c:axId val="50010"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${axTitle(spec.catTitle)}<c:numFmt formatCode="General" sourceLinked="1"/>${tick}<c:crossAx val="50020"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`
      + `<c:valAx><c:axId val="50020"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/>${axTitle(spec.valTitle)}<c:numFmt formatCode="${esc(fmt)}" sourceLinked="1"/>${tick}<c:crossAx val="50010"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
  } else if (kind !== "pie" && kind !== "doughnut") {
    const h = kind === "hbar";
    axes = `<c:catAx><c:axId val="50010"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${h ? "l" : "b"}"/>${axTitle(spec.catTitle)}<c:numFmt formatCode="General" sourceLinked="1"/>${tick}<c:crossAx val="50020"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
      + `<c:valAx><c:axId val="50020"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${h ? "b" : "l"}"/><c:majorGridlines/>${axTitle(spec.valTitle)}<c:numFmt formatCode="${grouping === "percent" ? "0%" : esc(fmt)}" sourceLinked="${grouping === "percent" ? 0 : 1}"/>${tick}<c:crossAx val="50010"/><c:crosses val="autoZero"/><c:crossBetween val="${kind === "area" ? "midCat" : "between"}"/></c:valAx>`;
  }
  const legend = spec.legend ?? (series.length > 1 || kind === "pie" || kind === "doughnut" || series.some((s) => s.trend));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>`
    + (spec.title ? titleXml(spec.title) : "") + `<c:autoTitleDeleted val="${spec.title ? 0 : 1}"/>`
    + `<c:plotArea><c:layout/>${type}${axes}</c:plotArea>`
    + (legend ? `<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>` : "")
    + `<c:plotVisOnly val="1"/><c:dispBlanksAs val="${spec.blanks ?? "gap"}"/></c:chart></c:chartSpace>`;
}

/** One xdr:twoCellAnchor holding a chart frame (relationship id `rid`, drawing object id `id`). */
export function chartAnchorXml(a: NonNullable<ChartSpec["anchor"]>, rid: string, id: number, name: string): string {
  const pt = (tag: string, c: number, r: number) => `<xdr:${tag}><xdr:col>${c}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
  return `<xdr:twoCellAnchor editAs="oneCell">${pt("from", a.c0, a.r0)}${pt("to", Math.max(a.c1, a.c0 + 1), Math.max(a.r1, a.r0 + 1))}`
    + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${esc(name)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>`
    + `<a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="${NS_R}" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
}
export const drawingXml = (anchors: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${anchors.join("")}</xdr:wsDr>`;
/** Where a new chart goes when it has no anchor: right of its data, 8 columns × 15 rows (Excel's default size). */
export function defaultAnchor(range: string, index: number): NonNullable<ChartSpec["anchor"]> {
  const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(range.replace(/^.*!/, ""));
  const col = (s: string) => [...s.toUpperCase()].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const c1 = m ? col(m[3] ?? m[1]) : 0, r0 = m ? Number(m[2]) - 1 : 0;
  const c0 = Math.min(16383 - 8, c1 + 2), top = r0 + index * 16;
  return { c0, r0: top, c1: c0 + 8, r1: top + 15 };
}

/** Sheet-qualified absolute reference: 'My sheet'!$B$2:$B$9 (quotes only when the name needs them). */
export function sheetRef(sheet: string, c0: number, r0: number, c1 = c0, r1 = r0): string {
  const q = /^[A-Za-z_][\w.]*$/.test(sheet) && !/^[A-Za-z]{1,3}\d+$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`;
  const a = (c: number, r: number) => `$${colToLetters(c)}$${r + 1}`;
  return `${q}!${a(c0, r0)}${c1 !== c0 || r1 !== r0 ? `:${a(c1, r1)}` : ""}`;
}
/** Series to write for any chart: explicit (file) series keep their references; range charts (made in Fusion) get
 * Excel-style per-column references derived from the range. Values are the CURRENT workbook values (cache). */
export function seriesOutFor(wb: Workbook, spec: ChartSpec): SeriesOut[] {
  const data = chartDataFor(wb, spec);
  if (spec.series?.length) return data.series.map((s, i) => {
    const ref = spec.series![i];
    return { name: s.name, noName: !ref?.name && !ref?.nameRef, nameRef: ref?.nameRef, cat: ref?.cat, val: ref?.val || undefined, categories: data.categories, values: s.values, xs: s.xs, color: s.color, trend: s.trend };
  });
  const r = parseRange(spec.range); if (!r) return [];
  const single = r.c0 === r.c1, first = spec.headerRow ? r.r0 + 1 : r.r0;
  if (first > r.r1) return [];
  const cat = single ? undefined : sheetRef(spec.sheet, r.c0, first, r.c0, r.r1);
  return data.series.map((s, i) => {
    const c = single ? r.c0 : r.c0 + 1 + i;
    return { name: s.name, noName: !spec.headerRow, nameRef: spec.headerRow ? sheetRef(spec.sheet, c, r.r0) : undefined, cat, val: sheetRef(spec.sheet, c, first, c, r.r1), categories: data.categories, values: s.values,
      xs: spec.kind === "scatter" ? data.categories.map((t) => (t.trim() !== "" && Number.isFinite(Number(t)) ? Number(t) : null)) : undefined, color: s.color, trend: s.trend };
  });
}
