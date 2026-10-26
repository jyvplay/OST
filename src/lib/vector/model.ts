/**
 * FF-32 vector document model v2 (TT16, first-party; pure TypeScript — runs in Node tests and in the browser).
 *
 * - Shapes: rect(rx/ry) · ellipse · line · polyline · polygon · path(absolute M/L/C/Z) · text · group.
 *   Every shape carries an affine `transform` and an allowlisted `style`; groups carry only non-inherited opacity.
 * - SVG import is an allowlist translator (never DOM insertion of foreign markup): presentation attributes and the
 *   `style` attribute are parsed, inherited properties are resolved down the tree, `<use href="#…">` is expanded
 *   (cycle/depth guarded), gradients keep stops with %/number offsets (clamped + monotonic, SVG 1.1 §13.2.4).
 *   Everything not carried is REPORTED (scripts, event handlers, external refs, filters, masks, clipPaths, …).
 * - Export writes a plain SVG 1.1 document; the editor renders that same serialisation, so what you see is the export.
 */
import { childEls, escapeAttr, escapeText, localName, parseXml, textContent, type XNode } from "./xml";
import {
  IDENTITY, apply, containsPoint, distanceToPath, ellipsePath, fmt, invert, isIdentity, matrixAttr, mul, parsePath, parsePoints,
  parseTransform, pathBounds, polyPath, rectPath, rotateM, scaleM, serializePath, starPoints, transformPath, translate,
  type Box, type Matrix, type Seg,
} from "./path";

export interface Style {
  fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; fillOpacity?: number; strokeOpacity?: number;
  dash?: string; linecap?: "butt" | "round" | "square"; linejoin?: "miter" | "round" | "bevel"; fillRule?: "nonzero" | "evenodd";
  fontSize?: number; fontFamily?: string; fontWeight?: string; textAnchor?: "start" | "middle" | "end";
}
interface Base { id: string; name?: string; transform: Matrix; style: Style; hidden?: boolean; locked?: boolean }
export type Shape = Base & (
  | { kind: "rect"; x: number; y: number; w: number; h: number; rx: number; ry: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "polyline" | "polygon"; points: number[]; star?: { n: number; inner: number } }
  | { kind: "path"; segs: Seg[] }
  | { kind: "text"; x: number; y: number; text: string }
  | { kind: "group"; children: Shape[] }
);
export type Kind = Shape["kind"];
export interface Stop { offset: number; color: string; opacity: number }
export interface Gradient {
  id: string; kind: "linear" | "radial"; units: "objectBoundingBox" | "userSpaceOnUse"; transform: Matrix; spread: "pad" | "reflect" | "repeat";
  x1: number; y1: number; x2: number; y2: number; cx: number; cy: number; r: number; fx: number; fy: number; stops: Stop[];
}
export interface VDoc { version: 2; title: string; width: number; height: number; background?: string; shapes: Shape[]; gradients: Gradient[] }

export const DEFAULT_STYLE: Required<Pick<Style, "fill" | "stroke" | "strokeWidth">> = { fill: "#000000", stroke: "none", strokeWidth: 1 };

/* ================================================================ ids */
export function nextId(doc: VDoc, prefix = "s"): string {
  let max = 0;
  const walk = (ss: Shape[]) => { for (const s of ss) { const m = /^[a-z]+(\d+)$/.exec(s.id); if (m) max = Math.max(max, Number(m[1])); if (s.kind === "group") walk(s.children); } };
  walk(doc.shapes);
  for (const g of doc.gradients) { const m = /^[a-z]+(\d+)$/.exec(g.id); if (m) max = Math.max(max, Number(m[1])); }
  return `${prefix}${max + 1}`;
}

/* ================================================================ colours / values */
const NAMED_COLORS = new Set("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent".split(" "));
/** Accepts #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba()/hsl()/hsla() with numeric args, CSS named colours, none. */
export function safeColor(v: string | undefined): string | undefined {
  if (v == null) return undefined;
  const s = v.trim().toLowerCase();
  if (s === "none" || NAMED_COLORS.has(s)) return s;
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) return s;
  if (/^(rgb|rgba|hsl|hsla)\(\s*[-+0-9.%\s,/deg]+\)$/.test(s)) return s;
  return undefined;
}
/** Paint = colour | url(#localId) (only references to imported gradients survive). */
function safePaint(v: string | undefined, gradIds: Set<string>, current: string | undefined): string | undefined {
  if (v == null) return undefined;
  const s = v.trim();
  const u = /^url\(\s*['"]?#([\w.:-]+)['"]?\s*\)\s*(.*)$/i.exec(s);
  if (u) return gradIds.has(u[1]) ? `url(#${u[1]})` : safeColor(u[2]) ?? undefined;
  if (s.toLowerCase() === "currentcolor") return current ?? "#000000";
  return safeColor(s);
}
const LEN_UNITS: Record<string, number> = { "": 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };
export function parseLength(v: string | undefined, ref = 0, dflt = 0): number {
  if (v == null) return dflt;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|ex|%)?\s*$/i.exec(v);
  if (!m) return dflt;
  const n = Number(m[1]), u = (m[2] ?? "").toLowerCase();
  return u === "%" ? n / 100 * ref : n * (LEN_UNITS[u] ?? 1);
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
function parseOpacity(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const t = v.trim();
  const n = t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t);
  return Number.isFinite(n) ? clamp01(n) : undefined;
}

/* ================================================================ import */
export interface ImportReport { doc: VDoc; dropped: string[]; warnings: string[] }
const STYLE_PROPS = ["fill", "stroke", "stroke-width", "opacity", "fill-opacity", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "fill-rule", "font-size", "font-family", "font-weight", "text-anchor", "color", "display", "visibility"];
const DROP_ELEMENTS: Record<string, string> = {
  script: "script", foreignObject: "foreignObject (HTML)", image: "raster <image>", filter: "filters", mask: "masks", clipPath: "clip paths",
  pattern: "patterns", marker: "markers", animate: "animation", animateTransform: "animation", animateMotion: "animation", set: "animation",
  style: "CSS <style> sheets", switch: "<switch>", symbol: "<symbol> (only reachable through <use>)", a: "hyperlinks (<a> content kept)", textPath: "textPath",
  iframe: "iframe", video: "video", audio: "audio", feGaussianBlur: "filters",
};
const DROP_ATTRS = new Set(["filter", "mask", "clip-path", "marker-start", "marker-mid", "marker-end"]);
type Inh = { fill?: string; stroke?: string; strokeWidth?: number; fillOpacity?: number; strokeOpacity?: number; dash?: string; linecap?: Style["linecap"]; linejoin?: Style["linejoin"]; fillRule?: Style["fillRule"]; fontSize?: number; fontFamily?: string; fontWeight?: string; textAnchor?: Style["textAnchor"]; color?: string };

export function importSvg(src: string, title = "Imported vector"): ImportReport {
  const dropped = new Map<string, number>(), warnings: string[] = [];
  const drop = (what: string) => dropped.set(what, (dropped.get(what) ?? 0) + 1);
  const root = parseXml(src);
  if (localName(root.tag) !== "svg") throw new Error("not an SVG document (no <svg> root element)");
  const vb = (root.attrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const width = hasVb ? vb[2] : parseLength(root.attrs.width, 0, 0) || 300;
  const height = hasVb ? vb[3] : parseLength(root.attrs.height, 0, 0) || 150;
  if (hasVb && root.attrs.width && root.attrs.height && Math.abs(parseLength(root.attrs.width) / parseLength(root.attrs.height) - vb[2] / vb[3]) > 1e-3)
    warnings.push("viewBox aspect differs from width/height: imported in viewBox units (preserveAspectRatio letterboxing not reproduced)");
  const rootM: Matrix = hasVb && (vb[0] || vb[1]) ? translate(-vb[0], -vb[1]) : IDENTITY;

  // index ids (for <use> and gradients)
  const byId = new Map<string, XNode>();
  const index = (n: XNode) => { if (n.attrs.id) byId.set(n.attrs.id, n); for (const c of childEls(n)) index(c); };
  index(root);
  const gradients: Gradient[] = [];
  const gradIds = new Set<string>();
  for (const [id, n] of byId) { const t = localName(n.tag); if (t === "linearGradient" || t === "radialGradient") gradIds.add(id); }
  for (const id of gradIds) { const g = readGradient(byId.get(id)!, byId); if (g) gradients.push(g); else { gradIds.delete(id); drop("gradient without stops"); } }

  let n = 0;
  const id = () => `s${++n}`;
  const readStyle = (el: XNode): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of STYLE_PROPS) if (el.attrs[p] != null) out[p] = el.attrs[p];
    if (el.attrs.style) for (const decl of el.attrs.style.split(";")) {
      const k = decl.slice(0, decl.indexOf(":")).trim().toLowerCase(), v = decl.slice(decl.indexOf(":") + 1).replace(/!important/i, "").trim();
      if (decl.includes(":") && STYLE_PROPS.includes(k)) out[k] = v; else if (decl.trim() && decl.includes(":") && !STYLE_PROPS.includes(k)) drop(`style property '${k}'`);
    }
    return out;
  };
  const inherit = (parent: Inh, raw: Record<string, string>): Inh => {
    const o: Inh = { ...parent };
    const color = safeColor(raw.color); if (color) o.color = color;
    const f = safePaint(raw.fill, gradIds, o.color); if (raw.fill != null) { if (f) o.fill = f; else drop(`unsupported paint '${raw.fill.slice(0, 40)}'`); }
    const s = safePaint(raw.stroke, gradIds, o.color); if (raw.stroke != null) { if (s) o.stroke = s; else drop(`unsupported paint '${raw.stroke.slice(0, 40)}'`); }
    if (raw["stroke-width"] != null) o.strokeWidth = Math.max(0, parseLength(raw["stroke-width"], Math.hypot(width, height) / Math.SQRT2, o.strokeWidth ?? 1));
    const fo = parseOpacity(raw["fill-opacity"]); if (fo != null) o.fillOpacity = fo;
    const so = parseOpacity(raw["stroke-opacity"]); if (so != null) o.strokeOpacity = so;
    if (raw["stroke-dasharray"] != null) o.dash = /^(none|[\d.\s,eE+-]+)$/.test(raw["stroke-dasharray"].trim()) ? raw["stroke-dasharray"].trim() : o.dash;
    if (/^(butt|round|square)$/.test(raw["stroke-linecap"] ?? "")) o.linecap = raw["stroke-linecap"] as Style["linecap"];
    if (/^(miter|round|bevel)$/.test(raw["stroke-linejoin"] ?? "")) o.linejoin = raw["stroke-linejoin"] as Style["linejoin"];
    if (/^(nonzero|evenodd)$/.test(raw["fill-rule"] ?? "")) o.fillRule = raw["fill-rule"] as Style["fillRule"];
    if (raw["font-size"] != null) o.fontSize = parseLength(raw["font-size"], o.fontSize ?? 16, o.fontSize ?? 16);
    if (raw["font-family"] != null && /^[\w\s,'"-]+$/.test(raw["font-family"])) o.fontFamily = raw["font-family"].replace(/"/g, "'");
    if (/^(normal|bold|bolder|lighter|[1-9]00)$/.test(raw["font-weight"] ?? "")) o.fontWeight = raw["font-weight"];
    if (/^(start|middle|end)$/.test(raw["text-anchor"] ?? "")) o.textAnchor = raw["text-anchor"] as Style["textAnchor"];
    return o;
  };
  const toStyle = (inh: Inh, opacity: number | undefined): Style => {
    const s: Style = { fill: inh.fill ?? "#000000", stroke: inh.stroke ?? "none", strokeWidth: inh.strokeWidth ?? 1 };
    if (opacity != null && opacity < 1) s.opacity = opacity;
    if (inh.fillOpacity != null && inh.fillOpacity < 1) s.fillOpacity = inh.fillOpacity;
    if (inh.strokeOpacity != null && inh.strokeOpacity < 1) s.strokeOpacity = inh.strokeOpacity;
    if (inh.dash && inh.dash !== "none") s.dash = inh.dash;
    if (inh.linecap) s.linecap = inh.linecap; if (inh.linejoin) s.linejoin = inh.linejoin; if (inh.fillRule) s.fillRule = inh.fillRule;
    return s;
  };

  const walk = (el: XNode, inh: Inh, useDepth: number, useStack: string[]): Shape[] => {
    const out: Shape[] = [];
    for (const c of childEls(el)) {
      const tag = localName(c.tag);
      for (const a of Object.keys(c.attrs)) {
        if (/^on/i.test(a)) drop("event-handler attributes (on*)");
        else if (DROP_ATTRS.has(a)) drop(`'${a}' attribute`);
      }
      if (tag === "defs" || tag === "linearGradient" || tag === "radialGradient" || tag === "title" || tag === "desc" || tag === "metadata") continue;
      if (DROP_ELEMENTS[tag] && tag !== "a") { drop(DROP_ELEMENTS[tag]); continue; }
      const raw = readStyle(c);
      if (raw.display?.trim() === "none") { drop("display:none elements"); continue; }
      const me = inherit(inh, raw);
      const opacity = parseOpacity(raw.opacity);
      const m = parseTransform(c.attrs.transform);
      const base = { transform: m, style: toStyle(me, opacity) };
      const L = (k: string, ref: number, d = 0) => parseLength(c.attrs[k], ref, d);
      switch (tag) {
        case "g": case "a": case "svg": {
          if (tag === "a") drop(DROP_ELEMENTS.a);
          const nested = tag === "svg" ? mul(m, translate(L("x", width), L("y", height))) : m;
          if (tag === "svg") warnings.push("nested <svg> flattened (its viewport clipping/viewBox scaling is not reproduced)");
          const kids = walk(c, me, useDepth, useStack);
          if (kids.length) out.push({ id: id(), kind: "group", transform: nested, style: opacity != null && opacity < 1 ? { opacity } : {}, children: kids, name: c.attrs.id });
          break;
        }
        case "rect": {
          const w = L("width", width), h = L("height", height);
          if (w <= 0 || h <= 0) { drop("zero-size rect (not rendered per SVG)"); break; }
          let rx = c.attrs.rx != null ? L("rx", width) : NaN, ry = c.attrs.ry != null ? L("ry", height) : NaN;
          if (Number.isNaN(rx)) rx = Number.isNaN(ry) ? 0 : ry; if (Number.isNaN(ry)) ry = rx;
          out.push({ id: id(), kind: "rect", ...base, x: L("x", width), y: L("y", height), w, h, rx: Math.min(rx, w / 2), ry: Math.min(ry, h / 2), name: c.attrs.id });
          break;
        }
        case "circle": case "ellipse": {
          const diag = Math.hypot(width, height) / Math.SQRT2;
          const rx = tag === "circle" ? L("r", diag) : L("rx", width, NaN), ry = tag === "circle" ? rx : L("ry", height, NaN);
          const RX = Number.isNaN(rx) ? ry : rx, RY = Number.isNaN(ry) ? rx : ry;
          if (!(RX > 0) || !(RY > 0)) { drop(`zero-radius ${tag}`); break; }
          out.push({ id: id(), kind: "ellipse", ...base, cx: L("cx", width), cy: L("cy", height), rx: RX, ry: RY, name: c.attrs.id });
          break;
        }
        case "line": out.push({ id: id(), kind: "line", ...base, x1: L("x1", width), y1: L("y1", height), x2: L("x2", width), y2: L("y2", height), name: c.attrs.id }); break;
        case "polyline": case "polygon": {
          const pts = parsePoints(c.attrs.points);
          if (pts.length < 4) { drop(`${tag} with < 2 points`); break; }
          out.push({ id: id(), kind: tag, ...base, points: pts, name: c.attrs.id });
          break;
        }
        case "path": {
          const r = parsePath(c.attrs.d ?? "");
          if (r.error) warnings.push(`path ${c.attrs.id ?? "#" + (n + 1)}: ${r.error} — rendered up to the last valid segment (SVG error handling)`);
          if (r.segs.length > 1) out.push({ id: id(), kind: "path", ...base, segs: r.segs, name: c.attrs.id });
          break;
        }
        case "text": {
          const kids = childEls(c);
          if (kids.some((k) => localName(k.tag) === "tspan" && ["x", "y", "dx", "dy", "rotate"].some((a) => k.attrs[a] != null))) drop("tspan positioning (text flattened to one run)");
          const text = textContent(c).replace(/\s+/g, " ").trim();
          if (!text) break;
          const st = base.style;
          st.fontSize = me.fontSize ?? 16; if (me.fontFamily) st.fontFamily = me.fontFamily; if (me.fontWeight) st.fontWeight = me.fontWeight; if (me.textAnchor) st.textAnchor = me.textAnchor;
          const xs = parsePoints(`${c.attrs.x ?? 0} ${c.attrs.y ?? 0}`);
          out.push({ id: id(), kind: "text", ...base, x: xs[0] ?? 0, y: xs[1] ?? 0, text, name: c.attrs.id });
          break;
        }
        case "use": {
          const href = c.attrs.href ?? c.attrs["xlink:href"] ?? "";
          if (!href.startsWith("#")) { drop("external <use> references"); break; }
          const target = byId.get(href.slice(1));
          if (!target) { drop("<use> to a missing id"); break; }
          if (useStack.includes(href) || useDepth >= 8) { drop("recursive/too-deep <use>"); break; }
          const tt = localName(target.tag);
          const holder: XNode = { tag: "g", attrs: {}, children: [tt === "symbol" ? { tag: "g", attrs: { ...target.attrs, id: "" }, children: target.children } : { ...target, attrs: { ...target.attrs, id: "" } }] };
          const kids = walk(holder, me, useDepth + 1, [...useStack, href]);
          if (kids.length) out.push({ id: id(), kind: "group", transform: mul(m, translate(L("x", width), L("y", height))), style: opacity != null && opacity < 1 ? { opacity } : {}, children: kids, name: `use ${href}` });
          break;
        }
        default: drop(`<${tag}>`);
      }
    }
    return out;
  };
  let shapes = walk(root, { fill: "#000000", stroke: "none", strokeWidth: 1, fontSize: 16 }, 0, []);
  if (!isIdentity(rootM)) shapes = shapes.map((s) => ({ ...s, transform: mul(rootM, s.transform) }));
  const usedGrad = new Set<string>();
  const scan = (ss: Shape[]) => { for (const s of ss) { for (const p of [s.style.fill, s.style.stroke]) { const u = /^url\(#(.+)\)$/.exec(p ?? ""); if (u) usedGrad.add(u[1]); } if (s.kind === "group") scan(s.children); } };
  scan(shapes);
  return {
    doc: { version: 2, title, width: round3(width), height: round3(height), shapes, gradients: gradients.filter((g) => usedGrad.has(g.id)) },
    dropped: [...dropped].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)),
    warnings,
  };
}
const round3 = (v: number) => Number(v.toFixed(3));

function readGradient(el: XNode, byId: Map<string, XNode>): Gradient | null {
  // xlink:href inheritance (attributes + stops) per SVG 1.1 §13.2.2/§13.2.3, cycle-guarded
  const chain: XNode[] = [];
  for (let cur: XNode | undefined = el; cur && chain.length < 8 && !chain.includes(cur);) {
    chain.push(cur);
    const h: string | undefined = cur.attrs.href ?? cur.attrs["xlink:href"];
    cur = h?.startsWith("#") ? byId.get(h.slice(1)) : undefined;
  }
  const attr = (k: string) => { for (const c of chain) if (c.attrs[k] != null) return c.attrs[k]; return undefined; };
  const stopsEl = chain.find((c) => childEls(c).some((k) => localName(k.tag) === "stop"));
  if (!stopsEl) return null;
  const stops: Stop[] = [];
  let prev = 0;
  for (const s of childEls(stopsEl).filter((k) => localName(k.tag) === "stop")) {
    const style: Record<string, string> = {};
    for (const d of (s.attrs.style ?? "").split(";")) if (d.includes(":")) style[d.slice(0, d.indexOf(":")).trim()] = d.slice(d.indexOf(":") + 1).trim();
    const offRaw = (s.attrs.offset ?? "0").trim();
    let off = offRaw.endsWith("%") ? Number(offRaw.slice(0, -1)) / 100 : Number(offRaw);
    off = Number.isFinite(off) ? clamp01(off) : 0;
    off = Math.max(prev, off); prev = off;
    stops.push({ offset: off, color: safeColor(style["stop-color"] ?? s.attrs["stop-color"]) ?? "#000000", opacity: parseOpacity(style["stop-opacity"] ?? s.attrs["stop-opacity"]) ?? 1 });
  }
  const linear = localName(el.tag) === "linearGradient";
  const units = attr("gradientUnits") === "userSpaceOnUse" ? "userSpaceOnUse" : "objectBoundingBox";
  const L = (k: string, d: number) => { const v = attr(k); if (v == null) return d; const t = v.trim(); return t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : parseLength(t, 1, d); }; // userSpaceOnUse % is taken as a fraction (viewport-relative % not resolved)
  const cx = L("cx", 0.5), cy = L("cy", 0.5);
  const spread = attr("spreadMethod");
  return {
    id: el.attrs.id, kind: linear ? "linear" : "radial", units, transform: parseTransform(attr("gradientTransform")),
    spread: spread === "reflect" || spread === "repeat" ? spread : "pad",
    x1: L("x1", 0), y1: L("y1", 0), x2: L("x2", 1), y2: L("y2", 0), cx, cy, r: L("r", 0.5), fx: L("fx", cx), fy: L("fy", cy), stops,
  };
}

/* ================================================================ export */
const STYLE_ATTR: [keyof Style, string][] = [
  ["fill", "fill"], ["stroke", "stroke"], ["strokeWidth", "stroke-width"], ["opacity", "opacity"], ["fillOpacity", "fill-opacity"],
  ["strokeOpacity", "stroke-opacity"], ["dash", "stroke-dasharray"], ["linecap", "stroke-linecap"], ["linejoin", "stroke-linejoin"],
  ["fillRule", "fill-rule"], ["fontSize", "font-size"], ["fontFamily", "font-family"], ["fontWeight", "font-weight"], ["textAnchor", "text-anchor"],
];
function styleAttrs(s: Style): string {
  let o = "";
  for (const [k, a] of STYLE_ATTR) { const v = s[k]; if (v !== undefined && v !== "") o += ` ${a}="${escapeAttr(typeof v === "number" ? fmt(v, 4) : String(v))}"`; }
  return o;
}
export function shapeToSvg(s: Shape, opts: { ids?: boolean } = {}): string {
  if (s.hidden) return "";
  const t = matrixAttr(s.transform);
  const common = `${opts.ids ? ` data-sid="${escapeAttr(s.id)}"` : ""}${t ? ` transform="${t}"` : ""}${styleAttrs(s.style)}`;
  switch (s.kind) {
    case "rect": return `<rect x="${fmt(s.x)}" y="${fmt(s.y)}" width="${fmt(s.w)}" height="${fmt(s.h)}"${s.rx ? ` rx="${fmt(s.rx)}"` : ""}${s.ry && s.ry !== s.rx ? ` ry="${fmt(s.ry)}"` : ""}${common}/>`;
    case "ellipse": return s.rx === s.ry ? `<circle cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" r="${fmt(s.rx)}"${common}/>` : `<ellipse cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" rx="${fmt(s.rx)}" ry="${fmt(s.ry)}"${common}/>`;
    case "line": return `<line x1="${fmt(s.x1)}" y1="${fmt(s.y1)}" x2="${fmt(s.x2)}" y2="${fmt(s.y2)}"${common}/>`;
    case "polyline": case "polygon": return `<${s.kind} points="${s.points.map((v) => fmt(v)).join(" ")}"${common}/>`;
    case "path": return `<path d="${serializePath(s.segs)}"${common}/>`;
    case "text": return `<text x="${fmt(s.x)}" y="${fmt(s.y)}"${common}>${escapeText(s.text)}</text>`;
    case "group": return `<g${common}>${s.children.map((c) => shapeToSvg(c, { ids: false })).join("")}</g>`;
  }
}
export function gradientToSvg(g: Gradient): string {
  const t = matrixAttr(g.transform);
  const head = g.kind === "linear"
    ? `<linearGradient id="${escapeAttr(g.id)}" x1="${fmt(g.x1, 4)}" y1="${fmt(g.y1, 4)}" x2="${fmt(g.x2, 4)}" y2="${fmt(g.y2, 4)}"`
    : `<radialGradient id="${escapeAttr(g.id)}" cx="${fmt(g.cx, 4)}" cy="${fmt(g.cy, 4)}" r="${fmt(g.r, 4)}" fx="${fmt(g.fx, 4)}" fy="${fmt(g.fy, 4)}"`;
  const stops = g.stops.map((s) => `<stop offset="${fmt(s.offset, 4)}" stop-color="${escapeAttr(s.color)}"${s.opacity < 1 ? ` stop-opacity="${fmt(s.opacity, 4)}"` : ""}/>`).join("");
  return `${head} gradientUnits="${g.units}"${t ? ` gradientTransform="${t}"` : ""}${g.spread !== "pad" ? ` spreadMethod="${g.spread}"` : ""}>${stops}</${g.kind === "linear" ? "linearGradient" : "radialGradient"}>`;
}
export function defsToSvg(doc: VDoc): string { return doc.gradients.length ? `<defs>${doc.gradients.map(gradientToSvg).join("")}</defs>` : ""; }
export function exportSvg(doc: VDoc): string {
  const bg = doc.background ? `<rect width="100%" height="100%" fill="${escapeAttr(doc.background)}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(doc.width)}" height="${fmt(doc.height)}" viewBox="0 0 ${fmt(doc.width)} ${fmt(doc.height)}"><title>${escapeText(doc.title)}</title>${defsToSvg(doc)}${bg}${doc.shapes.map((s) => shapeToSvg(s)).join("")}</svg>\n`;
}

/* ================================================================ geometry of shapes */
/** Approximate text box (no font metrics in pure code): advance 0.6em/char, ascent 0.8em, descent 0.2em. Declared approximation. */
export function textBox(s: Extract<Shape, { kind: "text" }>): Box {
  const fs = s.style.fontSize ?? 16, w = s.text.length * fs * 0.6;
  const x = s.style.textAnchor === "middle" ? s.x - w / 2 : s.style.textAnchor === "end" ? s.x - w : s.x;
  return { x, y: s.y - fs * 0.8, w, h: fs };
}
/** Geometry in the shape's local coordinates (before its own transform). */
export function localSegs(s: Shape): Seg[] {
  switch (s.kind) {
    case "rect": return rectPath(s.x, s.y, s.w, s.h, s.rx, s.ry);
    case "ellipse": return ellipsePath(s.cx, s.cy, s.rx, s.ry);
    case "line": return [{ t: "M", x: s.x1, y: s.y1 }, { t: "L", x: s.x2, y: s.y2 }];
    case "polyline": return polyPath(s.points, false);
    case "polygon": return polyPath(s.points, true);
    case "path": return s.segs;
    case "text": { const b = textBox(s); return rectPath(b.x, b.y, b.w, b.h); }
    case "group": return s.children.flatMap((c) => transformPath(localSegs(c), c.transform));
  }
}
export const unionBox = (bs: (Box | null)[]): Box | null => {
  const v = bs.filter((b): b is Box => !!b);
  if (!v.length) return null;
  const x = Math.min(...v.map((b) => b.x)), y = Math.min(...v.map((b) => b.y));
  return { x, y, w: Math.max(...v.map((b) => b.x + b.w)) - x, h: Math.max(...v.map((b) => b.y + b.h)) - y };
};
/** Exact geometric bounds in document coordinates (fill geometry, like getBBox() mapped through the CTM). */
export function shapeBounds(s: Shape, parent: Matrix = IDENTITY): Box | null {
  const m = mul(parent, s.transform);
  if (s.kind === "group") return unionBox(s.children.map((c) => shapeBounds(c, m)));
  return pathBounds(localSegs(s), m);
}
export function selectionBounds(doc: VDoc, ids: string[]): Box | null { return unionBox(doc.shapes.filter((s) => ids.includes(s.id)).map((s) => shapeBounds(s))); }

/** Topmost top-level shape under (x, y): fill containment (fill-rule aware) or within the stroke half-width (min 3 px). */
export function hitTest(doc: VDoc, x: number, y: number, tol = 3): string | null {
  const hit = (s: Shape, parent: Matrix): boolean => {
    if (s.hidden) return false;
    const m = mul(parent, s.transform);
    if (s.kind === "group") return [...s.children].reverse().some((c) => hit(c, m));
    let inv: Matrix; try { inv = invert(m); } catch { return false; }
    const [lx, ly] = apply(inv, x, y), segs = localSegs(s);
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    if (s.kind === "text") return containsPoint(segs, lx, ly);
    const filled = s.kind !== "line" && s.style.fill !== "none";
    if (filled && containsPoint(segs, lx, ly, s.style.fillRule ?? "nonzero")) return true;
    const sw = s.style.stroke && s.style.stroke !== "none" ? (s.style.strokeWidth ?? 1) / 2 : 0;
    return distanceToPath(segs, lx, ly) * scale <= Math.max(sw * scale, tol);
  };
  for (const s of [...doc.shapes].reverse()) if (!s.locked && hit(s, IDENTITY)) return s.id;
  return null;
}
export function shapesInRect(doc: VDoc, r: Box): string[] {
  return doc.shapes.filter((s) => { if (s.hidden || s.locked) return false; const b = shapeBounds(s); return !!b && b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h; }).map((s) => s.id);
}

/* ================================================================ operations (pure: return a new doc) */
const mapTop = (doc: VDoc, ids: string[], f: (s: Shape) => Shape): VDoc => ({ ...doc, shapes: doc.shapes.map((s) => (ids.includes(s.id) ? f(s) : s)) });

/** Apply an affine to a shape. Point-based shapes (line/poly/path) are baked exactly into coordinates; rect/ellipse are
 *  baked only for axis-aligned scale+translate; otherwise (rotation/skew, text, groups) the matrix is pre-multiplied. */
export function transformShape(s: Shape, m: Matrix, bake = true): Shape {
  const full = mul(m, s.transform);
  if (!bake || !isIdentity(s.transform)) return { ...s, transform: full };
  const axis = Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12;
  switch (s.kind) {
    case "line": { const [x1, y1] = apply(m, s.x1, s.y1), [x2, y2] = apply(m, s.x2, s.y2); return { ...s, x1, y1, x2, y2 }; }
    case "polyline": case "polygon": { const p: number[] = []; for (let i = 0; i < s.points.length; i += 2) p.push(...apply(m, s.points[i], s.points[i + 1])); return { ...s, points: p }; }
    case "path": return { ...s, segs: transformPath(s.segs, m) };
    case "rect": if (axis) { const [ax, ay] = apply(m, s.x, s.y), [bx, by] = apply(m, s.x + s.w, s.y + s.h); return { ...s, x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay), rx: s.rx * Math.abs(m[0]), ry: s.ry * Math.abs(m[3]) }; } break;
    case "ellipse": if (axis) { const [cx, cy] = apply(m, s.cx, s.cy); return { ...s, cx, cy, rx: s.rx * Math.abs(m[0]), ry: s.ry * Math.abs(m[3]) }; } break;
    case "text": if (axis && Math.abs(m[0] - 1) < 1e-12 && Math.abs(m[3] - 1) < 1e-12) { return { ...s, x: s.x + m[4], y: s.y + m[5] }; } break;
  }
  return { ...s, transform: full };
}
export const moveShapes = (doc: VDoc, ids: string[], dx: number, dy: number) => mapTop(doc, ids, (s) => transformShape(s, translate(dx, dy)));
export function resizeShapes(doc: VDoc, ids: string[], from: Box, to: Box): VDoc {
  const sx = from.w ? to.w / from.w : 1, sy = from.h ? to.h / from.h : 1;
  const m = mul(translate(to.x, to.y), mul(scaleM(sx, sy), translate(-from.x, -from.y)));
  return mapTop(doc, ids, (s) => transformShape(s, m));
}
export function rotateShapes(doc: VDoc, ids: string[], deg: number, cx?: number, cy?: number): VDoc {
  const b = selectionBounds(doc, ids); if (!b) return doc;
  const m = rotateM(deg, cx ?? b.x + b.w / 2, cy ?? b.y + b.h / 2);
  return mapTop(doc, ids, (s) => transformShape(s, m, s.kind === "path" || s.kind === "polygon" || s.kind === "polyline" || s.kind === "line"));
}
export function flipShapes(doc: VDoc, ids: string[], axis: "h" | "v"): VDoc {
  const b = selectionBounds(doc, ids); if (!b) return doc;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const m = mul(translate(cx, cy), mul(axis === "h" ? scaleM(-1, 1) : scaleM(1, -1), translate(-cx, -cy)));
  return mapTop(doc, ids, (s) => transformShape(s, m));
}
export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
/** Align to the selection bounds (or to the page when a single shape is selected — Illustrator "align to artboard"). */
export function alignShapes(doc: VDoc, ids: string[], mode: AlignMode): VDoc {
  const ref = ids.length > 1 ? selectionBounds(doc, ids) : { x: 0, y: 0, w: doc.width, h: doc.height };
  if (!ref) return doc;
  return mapTop(doc, ids, (s) => {
    const b = shapeBounds(s); if (!b) return s;
    const dx = mode === "left" ? ref.x - b.x : mode === "hcenter" ? ref.x + ref.w / 2 - (b.x + b.w / 2) : mode === "right" ? ref.x + ref.w - (b.x + b.w) : 0;
    const dy = mode === "top" ? ref.y - b.y : mode === "vcenter" ? ref.y + ref.h / 2 - (b.y + b.h / 2) : mode === "bottom" ? ref.y + ref.h - (b.y + b.h) : 0;
    return transformShape(s, translate(dx, dy));
  });
}
/** Equal gaps between neighbouring bounds along an axis; the two extreme shapes stay put. */
export function distributeShapes(doc: VDoc, ids: string[], axis: "h" | "v"): VDoc {
  const items = doc.shapes.filter((s) => ids.includes(s.id)).map((s) => ({ s, b: shapeBounds(s)! })).filter((i) => i.b);
  if (items.length < 3) return doc;
  const lo = (b: Box) => (axis === "h" ? b.x : b.y), size = (b: Box) => (axis === "h" ? b.w : b.h);
  items.sort((p, q) => lo(p.b) - lo(q.b));
  const first = items[0].b, last = items[items.length - 1].b;
  const total = lo(last) + size(last) - lo(first), used = items.reduce((a, i) => a + size(i.b), 0);
  const gap = (total - used) / (items.length - 1);
  const moves = new Map<string, number>();
  let pos = lo(first);
  for (const i of items) { moves.set(i.s.id, pos - lo(i.b)); pos += size(i.b) + gap; }
  return { ...doc, shapes: doc.shapes.map((s) => { const d = moves.get(s.id); return d ? transformShape(s, axis === "h" ? translate(d, 0) : translate(0, d)) : s; }) };
}
export type ZMove = "front" | "back" | "forward" | "backward";
export function reorder(doc: VDoc, ids: string[], how: ZMove): VDoc {
  const sel = doc.shapes.filter((s) => ids.includes(s.id)), rest = doc.shapes.filter((s) => !ids.includes(s.id));
  if (how === "front") return { ...doc, shapes: [...rest, ...sel] };
  if (how === "back") return { ...doc, shapes: [...sel, ...rest] };
  const a = [...doc.shapes];
  if (how === "forward") { for (let i = a.length - 2; i >= 0; i--) if (ids.includes(a[i].id) && !ids.includes(a[i + 1].id)) [a[i], a[i + 1]] = [a[i + 1], a[i]]; }
  else { for (let i = 1; i < a.length; i++) if (ids.includes(a[i].id) && !ids.includes(a[i - 1].id)) [a[i], a[i - 1]] = [a[i - 1], a[i]]; }
  return { ...doc, shapes: a };
}
export function groupShapes(doc: VDoc, ids: string[]): { doc: VDoc; id: string | null } {
  const sel = doc.shapes.filter((s) => ids.includes(s.id));
  if (sel.length < 2) return { doc, id: null };
  const gid = nextId(doc, "g");
  const top = Math.max(...sel.map((s) => doc.shapes.indexOf(s)));
  const shapes: Shape[] = [];
  doc.shapes.forEach((s, i) => { if (i === top) shapes.push({ id: gid, kind: "group", transform: IDENTITY, style: {}, children: sel }); if (!ids.includes(s.id)) shapes.push(s); });
  return { doc: { ...doc, shapes }, id: gid };
}
/** Ungroup: the group matrix is pushed into each child; group opacity multiplies into child opacity
 *  (exact unless children overlap — group opacity composites as one layer; reported via `approx`). */
export function ungroup(doc: VDoc, gid: string): { doc: VDoc; ids: string[]; approx: boolean } {
  const g = doc.shapes.find((s) => s.id === gid);
  if (!g || g.kind !== "group") return { doc, ids: [], approx: false };
  const op = g.style.opacity ?? 1;
  const kids = g.children.map((c) => ({ ...c, transform: mul(g.transform, c.transform), style: op < 1 ? { ...c.style, opacity: (c.style.opacity ?? 1) * op } : c.style }));
  let d: VDoc = { ...doc, shapes: doc.shapes.flatMap((s) => (s.id === gid ? kids : [s])) };
  // re-id children that collide with top-level ids
  const seen = new Set<string>(); const ids: string[] = [];
  d = { ...d, shapes: d.shapes.map((s) => { if (seen.has(s.id)) { const nid = nextId({ ...d, shapes: [...d.shapes, ...[...seen].map((x) => ({ id: x } as Shape))] }); seen.add(nid); if (kids.includes(s)) ids.push(nid); return { ...s, id: nid }; } seen.add(s.id); if (kids.includes(s)) ids.push(s.id); return s; }) };
  return { doc: d, ids, approx: op < 1 && kids.length > 1 };
}
export function toPath(s: Shape): Shape {
  if (s.kind === "path" || s.kind === "group") return s;
  if (s.kind === "text") throw new Error("text cannot be converted to outlines without font glyph data");
  const { id, name, transform, style, hidden, locked } = s;
  return { id, name, transform, style: s.kind === "line" || s.kind === "polyline" ? { ...style, fill: "none" } : style, hidden, locked, kind: "path", segs: localSegs(s) };
}
export function duplicateShapes(doc: VDoc, ids: string[], dx = 10, dy = 10): { doc: VDoc; ids: string[] } {
  let d = doc; const out: string[] = [];
  const reid = (s: Shape): Shape => { const nid = nextId(d); d = { ...d, shapes: [...d.shapes, { ...s, id: nid } as Shape] }; return s.kind === "group" ? { ...s, id: nid, children: s.children.map(reid) } : { ...s, id: nid }; };
  const copies: Shape[] = [];
  for (const s of doc.shapes.filter((x) => ids.includes(x.id))) { const c = transformShape(reid(structuredClone(s)), translate(dx, dy)); copies.push(c); out.push(c.id); }
  return { doc: { ...doc, shapes: [...doc.shapes, ...copies] }, ids: out };
}
export const deleteShapes = (doc: VDoc, ids: string[]): VDoc => ({ ...doc, shapes: doc.shapes.filter((s) => !ids.includes(s.id)) });
export function findShape(doc: VDoc, id: string): Shape | undefined { return doc.shapes.find((s) => s.id === id); }
export const updateShape = (doc: VDoc, id: string, f: (s: Shape) => Shape): VDoc => mapTop(doc, [id], f);

/* ================================================================ parametric helpers (competitor parity: arrow, star) */
/** Arrow as plain path data (shaft + open V head) — exports without <marker>, which many consumers drop. */
export function arrowSegs(x1: number, y1: number, x2: number, y2: number, head = 12): Seg[] {
  const a = Math.atan2(y2 - y1, x2 - x1), s = Math.PI / 6;
  return [
    { t: "M", x: x1, y: y1 }, { t: "L", x: x2, y: y2 },
    { t: "M", x: x2 - head * Math.cos(a - s), y: y2 - head * Math.sin(a - s) }, { t: "L", x: x2, y: y2 },
    { t: "L", x: x2 - head * Math.cos(a + s), y: y2 - head * Math.sin(a + s) },
  ];
}
/** Re-generate a star/regular polygon with new parameters, keeping its centre, outer radius and rotation
 *  (derived from the current points, so moves/uniform scales/rotations made since creation are preserved). */
export function restar(s: Shape, n: number, inner: number): Shape {
  if (s.kind !== "polygon" || !s.star || s.points.length < 6) return s;
  const k = s.points.length / 2;
  const outerIdx = s.star.inner > 0 ? Array.from({ length: k / 2 }, (_, i) => i * 2) : Array.from({ length: k }, (_, i) => i);
  let cx = 0, cy = 0; for (const i of outerIdx) { cx += s.points[2 * i]; cy += s.points[2 * i + 1]; } cx /= outerIdx.length; cy /= outerIdx.length;
  const R = Math.hypot(s.points[0] - cx, s.points[1] - cy), a0 = Math.atan2(s.points[1] - cy, s.points[0] - cx);
  n = Math.max(3, Math.min(64, Math.round(n))); inner = Math.max(0, Math.min(1, inner));
  const pts = starPoints(0, 0, R, inner > 0 ? R * inner : 0, n), rot = a0 + Math.PI / 2, c = Math.cos(rot), sn = Math.sin(rot);
  const out: number[] = []; for (let i = 0; i < pts.length; i += 2) out.push(cx + pts[i] * c - pts[i + 1] * sn, cy + pts[i] * sn + pts[i + 1] * c);
  return { ...s, points: out, star: { n, inner } };
}

/* ================================================================ path node editing */
export interface PathNode { seg: number; role: "anchor" | "in" | "out"; x: number; y: number }
/** Anchors and Bézier handles of a path (local coordinates). `in` = segment's 2nd control, `out` = next segment's 1st. */
export function pathNodes(segs: Seg[]): PathNode[] {
  const out: PathNode[] = [];
  segs.forEach((s, i) => {
    if (s.t === "Z") return;
    if (s.t === "C") { out.push({ seg: i, role: "in", x: s.x2, y: s.y2 }); }
    out.push({ seg: i, role: "anchor", x: s.x, y: s.y });
    const nx = segs[i + 1]; if (nx?.t === "C") out.push({ seg: i, role: "out", x: nx.x1, y: nx.y1 });
  });
  return out;
}
/** Move an anchor (its two handles travel with it) or a single handle. */
export function moveNode(segs: Seg[], node: Pick<PathNode, "seg" | "role">, x: number, y: number): Seg[] {
  const a = segs.map((s) => ({ ...s })) as Seg[];
  const s = a[node.seg]; if (!s || s.t === "Z") return segs;
  if (node.role === "anchor") {
    const dx = x - s.x, dy = y - s.y;
    // a closed subpath whose last anchor coincides with its M: move both
    s.x = x; s.y = y;
    if (s.t === "C") { s.x2 += dx; s.y2 += dy; }
    const nx = a[node.seg + 1]; if (nx?.t === "C") { nx.x1 += dx; nx.y1 += dy; }
  } else if (node.role === "in" && s.t === "C") { s.x2 = x; s.y2 = y; }
  else if (node.role === "out") { const nx = a[node.seg + 1]; if (nx?.t === "C") { nx.x1 = x; nx.y1 = y; } }
  return a;
}

/* ================================================================ documents, migration, persistence */
export function blankDoc(title = "Untitled vector"): VDoc {
  return {
    version: 2, title, width: 800, height: 600, background: "#ffffff",
    gradients: [{ id: "gr1", kind: "linear", units: "objectBoundingBox", transform: IDENTITY, spread: "pad", x1: 0, y1: 0, x2: 1, y2: 1, cx: 0.5, cy: 0.5, r: 0.5, fx: 0.5, fy: 0.5, stops: [{ offset: 0, color: "#5b8cff", opacity: 1 }, { offset: 1, color: "#9b5bff", opacity: 1 }] }],
    shapes: [
      { id: "s1", kind: "rect", transform: IDENTITY, style: { fill: "url(#gr1)", stroke: "#1e293b", strokeWidth: 2 }, x: 80, y: 80, w: 220, h: 150, rx: 16, ry: 16 },
      { id: "s2", kind: "ellipse", transform: IDENTITY, style: { fill: "#39d98a", stroke: "#1e293b", strokeWidth: 2 }, cx: 430, cy: 180, rx: 90, ry: 90 },
      { id: "s3", kind: "path", transform: IDENTITY, style: { fill: "none", stroke: "#f97316", strokeWidth: 4, linecap: "round" }, segs: parsePath("M90 420 C 200 320 300 520 420 400 S 600 330 700 430").segs },
      { id: "s4", kind: "text", transform: IDENTITY, style: { fill: "#0f172a", stroke: "none", strokeWidth: 1, fontSize: 28, fontFamily: "sans-serif" }, x: 90, y: 300, text: "Edit vector shapes" },
    ],
  };
}
/** v1 .fsvg ({title,width,height,shapes:[{kind:rect|circle|line|text, x,y,…, fill, stroke}]}) → v2. */
export function migrate(json: unknown): VDoc {
  const o = json as Record<string, unknown>;
  if (!o || typeof o !== "object" || !Array.isArray(o.shapes)) throw new Error("not a vector document");
  if (o.version === 2) return validateDoc(o as unknown as VDoc);
  const shapes: Shape[] = [];
  let k = 0;
  for (const raw of o.shapes as Record<string, unknown>[]) {
    const N = (key: string, d = 0) => (typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : d);
    const style: Style = { fill: safeColor(String(raw.fill ?? "")) ?? "none", stroke: safeColor(String(raw.stroke ?? "")) ?? "none", strokeWidth: 2 };
    const id = `s${++k}`;
    if (raw.kind === "rect") shapes.push({ id, kind: "rect", transform: IDENTITY, style, x: N("x"), y: N("y"), w: N("w", 100), h: N("h", 80), rx: 0, ry: 0 });
    else if (raw.kind === "circle") shapes.push({ id, kind: "ellipse", transform: IDENTITY, style, cx: N("x"), cy: N("y"), rx: N("r", 40), ry: N("r", 40) });
    else if (raw.kind === "line") shapes.push({ id, kind: "line", transform: IDENTITY, style, x1: N("x"), y1: N("y"), x2: N("x2", 100), y2: N("y2", 100) });
    else if (raw.kind === "text") shapes.push({ id, kind: "text", transform: IDENTITY, style: { ...style, strokeWidth: 1, fontSize: 24 }, x: N("x"), y: N("y", 20), text: String(raw.text ?? "") });
  }
  return { version: 2, title: String(o.title ?? "Untitled vector"), width: Number(o.width) || 800, height: Number(o.height) || 600, shapes, gradients: [] };
}
/** Re-validate a loaded v2 doc: drop unknown kinds and unsafe paints, coerce numbers (files are untrusted input). */
export function validateDoc(d: VDoc): VDoc {
  const gradIds = new Set((d.gradients ?? []).map((g) => g.id).filter((x) => /^[\w.:-]+$/.test(x)));
  const st = (s: Style): Style => ({
    ...s,
    fill: s.fill === undefined ? undefined : safePaint(s.fill, gradIds, undefined) ?? "none",
    stroke: s.stroke === undefined ? undefined : safePaint(s.stroke, gradIds, undefined) ?? "none",
    fontFamily: s.fontFamily && /^[\w\s,'-]+$/.test(s.fontFamily) ? s.fontFamily : undefined,
    dash: s.dash && /^[\d.\s,eE+-]+$/.test(s.dash) ? s.dash : undefined,
  });
  const ok = (s: Shape): Shape | null => {
    if (!s || typeof s.id !== "string" || !["rect", "ellipse", "line", "polyline", "polygon", "path", "text", "group"].includes(s.kind)) return null;
    const transform = Array.isArray(s.transform) && s.transform.length === 6 && s.transform.every(Number.isFinite) ? s.transform : IDENTITY;
    const base = { ...s, transform, style: st(s.style ?? {}) } as Shape;
    if (base.kind === "polygon" && base.star) base.star = Number.isFinite(base.star.n) && Number.isFinite(base.star.inner) ? { n: Math.max(3, Math.min(64, Math.round(base.star.n))), inner: Math.max(0, Math.min(1, base.star.inner)) } : undefined;
    if (base.kind === "group") return { ...base, children: base.children.map(ok).filter((c): c is Shape => !!c) };
    return base;
  };
  return { version: 2, title: String(d.title ?? "Untitled vector"), width: Number(d.width) || 800, height: Number(d.height) || 600, background: safeColor(d.background), shapes: (d.shapes ?? []).map(ok).filter((s): s is Shape => !!s), gradients: (d.gradients ?? []).filter((g) => gradIds.has(g.id)).map((g) => ({ ...g, stops: g.stops.map((s) => ({ ...s, color: safeColor(s.color) ?? "#000000" })) })) };
}
export function countShapes(ss: Shape[]): number { return ss.reduce((a, s) => a + 1 + (s.kind === "group" ? countShapes(s.children) : 0), 0); }
export { IDENTITY };
