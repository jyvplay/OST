/**
 * TT51 — what a slide LOOKS like: resolves PowerPoint's inheritance into a flat, renderable view model.
 * Original code against ECMA-376 Part 1:
 *  - placeholders: a slide placeholder inherits geometry, body properties and list styles from the layout placeholder
 *    with the same idx (absent idx = 0), which inherits from the master placeholder of the corresponding type
 *    (§19.3.1.36; the same matching python-pptx uses, so geometry can be checked against it);
 *  - text: run rPr → paragraph pPr → shape lstStyle → p:style fontRef → layout/master placeholder lstStyle → master
 *    txStyles (title / body / other) → presentation defaultTextStyle (§21.1.2); theme fonts +mj/+mn;
 *  - colours: srgb/scheme/sys/prst/hsl/scrgb with lumMod/lumOff/tint/shade/satMod/alpha, through the master clrMap and
 *    layout/slide clrMapOvr (§20.1.2.3, §19.3.1.6);
 *  - backgrounds (slide → layout → master; bgRef → theme bgFillStyleLst), master/layout decoration shapes unless
 *    showMasterSp="0", group transforms (chOff/chExt), custom and preset geometry, pictures with srcRect crops,
 *    tables with their table style, charts (drawn from their caches by the TT50 chart engine, loaded lazily).
 */
import { attr, kid, kids, find, findAll, textOf, type XDoc, type XEl } from "./xmltree";
import { altContent, layoutOf, masterOf, themeOf, partXml, partRels, phOf, readXfrm, resolveTarget, runsOf, shapeKids, spTreeOf, txBodyOf, nvPrOf, cNvPrOf, RT, IMG_MIME, type PptxDoc, type PSlide, type Xfrm } from "./pml";
import { presetPath, custPathD, type CustPath } from "./pmlgeom";

export type Fill = { kind: "none" } | { kind: "solid"; color: string } | { kind: "grad"; css: string; color: string } | { kind: "img"; part: string; mime: string };
export interface VLine { color: string; width: number /* EMU */; dash?: string; head?: string; tail?: string }
export interface VRun { text: string; kind: "r" | "br" | "fld"; sz: number; b: boolean; i: boolean; u: boolean; strike: boolean; color: string; font: string; baseline: number; caps: boolean; highlight?: string; link?: boolean }
export interface VPara { algn: string; marL: number; indent: number; lvl: number; bullet?: { text: string; font?: string; color?: string; sizePct: number }; lnPct?: number; lnPts?: number; spcBef: number; spcAft: number; spcBefPct?: number; runs: VRun[]; endSz: number }
export interface VText { anchor: string; ins: [number, number, number, number]; wrap: boolean; vert?: string; scale: number; lnReduce: number; paras: VPara[]; anchorCtr: boolean }
export interface VCell { text?: VText; fill: Fill; span: number; rowSpan: number; merged: boolean; borders: { l?: VLine; r?: VLine; t?: VLine; b?: VLine } }
export interface VShape {
  addr: string; layer: "slide" | "layout" | "master"; id: string; name: string; descr: string;
  kind: "sp" | "pic" | "table" | "chart" | "group" | "cxn" | "graphic" | "other";
  x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean;
  /** raw a:xfrm of the element itself (child-space for group members) — what python-pptx reports */ raw?: Xfrm;
  ph?: { type: string; idx: string | undefined };
  geom?: { d: (w: number, h: number) => string; open: boolean; approx: boolean; name: string };
  fill: Fill; line?: VLine;
  text?: VText;
  img?: { part: string; mime: string; crop?: { l: number; t: number; r: number; b: number }; unsupported?: string };
  table?: { cols: number[]; rows: { h: number; cells: VCell[] }[] };
  chart?: { part: string };
  children?: VShape[]; alt?: boolean; note?: string; hidden?: boolean;
}
export interface VSlide { size: { cx: number; cy: number }; bg: Fill; shapes: VShape[]; layout?: string; master?: string; layoutName?: string; hidden: boolean }

/* ================================================================ colour */

interface Theme { colors: Record<string, string>; major: string; minor: string; fill: XEl[]; ln: XEl[]; bg: XEl[] }
interface Ctx { doc: PptxDoc; theme: Theme; map: Record<string, string>; part: string; master?: string; layout?: string; masterX?: XDoc | null; layoutX?: XDoc | null; slideX?: XDoc }
const PRESET: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", darkGray: "A9A9A9", lightGray: "D3D3D3", orange: "FFA500", purple: "800080", navy: "000080", maroon: "800000", silver: "C0C0C0", teal: "008080", cyan: "00FFFF", magenta: "FF00FF", lime: "00FF00", olive: "808000", aqua: "00FFFF", fuchsia: "FF00FF", brown: "A52A2A", pink: "FFC0CB", gold: "FFD700", darkBlue: "00008B", darkRed: "8B0000", darkGreen: "006400", ltGray: "D3D3D3", dkGray: "A9A9A9" };
function hexToRgb(h: string): [number, number, number] { const n = parseInt(h.padStart(6, "0").slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const toHex = (r: number, g: number, b: number) => [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const l = (mx + mn) / 2; let h = 0, s = 0;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const t = (x: number) => { x = (x + 1) % 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
  return [t(h + 1 / 3) * 255, t(h) * 255, t(h - 1 / 3) * 255];
}
/** one colour element (srgbClr, schemeClr, …) → "#rrggbb" or "rgba(...)" */
export function colorOf(c: XEl | undefined, ctx: Ctx, phClr?: string): string | undefined {
  if (!c) return undefined;
  let hex: string | undefined;
  switch (c.name) {
    case "a:srgbClr": hex = attr(c, "val"); break;
    case "a:sysClr": hex = attr(c, "lastClr") ?? (attr(c, "val") === "window" ? "FFFFFF" : "000000"); break;
    case "a:prstClr": hex = PRESET[attr(c, "val") ?? ""] ?? "000000"; break;
    case "a:scrgbClr": { const p = (k: string) => Math.round(255 * Math.pow(Math.max(0, Math.min(100000, Number(attr(c, k) ?? 0))) / 100000, 1 / 2.2)); hex = toHex(p("r"), p("g"), p("b")); break; }
    case "a:hslClr": { const [r, g, b] = hslToRgb(Number(attr(c, "hue") ?? 0) / 21600000, Number(attr(c, "sat") ?? 0) / 100000, Number(attr(c, "lum") ?? 0) / 100000); hex = toHex(r, g, b); break; }
    case "a:schemeClr": {
      let v = attr(c, "val") ?? "tx1";
      if (v === "phClr") { hex = phClr?.replace("#", ""); break; }
      v = ctx.map[v] ?? v; hex = ctx.theme.colors[v]; break;
    }
    default: return undefined;
  }
  if (!hex || !/^[0-9a-fA-F]{6}/.test(hex)) hex = "000000";
  let [r, g, b] = hexToRgb(hex); let alpha = 1;
  for (const m of kids(c)) {
    const v = Number(attr(m, "val") ?? 0) / 100000;
    switch (m.name) {
      case "a:lumMod": { const [h, s, l] = rgbToHsl(r, g, b); [r, g, b] = hslToRgb(h, s, Math.min(1, l * v)); break; }
      case "a:lumOff": { const [h, s, l] = rgbToHsl(r, g, b); [r, g, b] = hslToRgb(h, s, Math.max(0, Math.min(1, l + v))); break; }
      case "a:satMod": { const [h, s, l] = rgbToHsl(r, g, b); [r, g, b] = hslToRgb(h, Math.min(1, s * v), l); break; }
      case "a:tint": r = 255 - (255 - r) * v; g = 255 - (255 - g) * v; b = 255 - (255 - b) * v; break;
      case "a:shade": r *= v; g *= v; b *= v; break;
      case "a:alpha": alpha = v; break;
      case "a:inv": r = 255 - r; g = 255 - g; b = 255 - b; break;
      case "a:gray": { const y = 0.3 * r + 0.59 * g + 0.11 * b; r = g = b = y; break; }
    }
  }
  return alpha < 1 ? `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha.toFixed(3)})` : `#${toHex(r, g, b)}`;
}
const COLOR_TAGS = new Set(["a:srgbClr", "a:schemeClr", "a:sysClr", "a:prstClr", "a:scrgbClr", "a:hslClr"]);
const colorKid = (e: XEl | undefined) => kids(e).find((k) => COLOR_TAGS.has(k.name));

function relPart(ctx: Ctx, from: string, rid: string | undefined): string | undefined {
  if (!rid) return undefined; const r = partRels(ctx.doc, from).find((x) => x.id === rid); return r && r.mode !== "External" ? resolveTarget(from, r.target) : undefined;
}
const mimeOf = (p: string) => IMG_MIME[(p.split(".").pop() ?? "").toLowerCase()] ?? "application/octet-stream";
/** a fill element (solidFill/gradFill/blipFill/noFill/pattFill) → Fill */
function fillOf(e: XEl | undefined, ctx: Ctx, from: string, phClr?: string): Fill | undefined {
  if (!e) return undefined;
  switch (e.name) {
    case "a:noFill": return { kind: "none" };
    case "a:solidFill": { const c = colorOf(colorKid(e), ctx, phClr); return c ? { kind: "solid", color: c } : { kind: "none" }; }
    case "a:gradFill": {
      const stops = kids(kid(e, "a:gsLst"), "a:gs").map((g) => ({ pos: Number(attr(g, "pos") ?? 0) / 1000, c: colorOf(colorKid(g), ctx, phClr) ?? "#000" })).sort((a, b) => a.pos - b.pos);
      if (!stops.length) return undefined;
      const lin = kid(e, "a:lin"); const ang = lin ? Number(attr(lin, "ang") ?? 0) / 60000 : 90;
      const css = kid(e, "a:path") ? `radial-gradient(circle, ${stops.map((s) => `${s.c} ${s.pos}%`).join(", ")})` : `linear-gradient(${(ang + 90) % 360}deg, ${stops.map((s) => `${s.c} ${s.pos}%`).join(", ")})`;
      return { kind: "grad", css, color: stops[0].c };
    }
    case "a:blipFill": { const blip = kid(e, "a:blip"); const part = relPart(ctx, from, attr(blip, "r:embed")); return part ? { kind: "img", part, mime: mimeOf(part) } : { kind: "none" }; }
    case "a:pattFill": { const c = colorOf(colorKid(kid(e, "a:fgClr")), ctx, phClr); return c ? { kind: "solid", color: c } : undefined; }
    case "a:grpFill": return undefined;
  }
  return undefined;
}
const FILL_TAGS = new Set(["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"]);
const fillKid = (e: XEl | undefined) => kids(e).find((k) => FILL_TAGS.has(k.name));

function loadTheme(doc: PptxDoc, master: string | undefined): Theme {
  const t: Theme = { colors: { dk1: "000000", lt1: "FFFFFF", dk2: "44546A", lt2: "E7E6E6", accent1: "4472C4", accent2: "ED7D31", accent3: "A5A5A5", accent4: "FFC000", accent5: "5B9BD5", accent6: "70AD47", hlink: "0563C1", folHlink: "954F72" }, major: "Calibri Light", minor: "Calibri", fill: [], ln: [], bg: [] };
  const tp = themeOf(doc, master); const tx = tp ? partXml(doc, tp) : null; if (!tx) return t;
  const cs = find(tx.root, (x) => x.name === "a:clrScheme");
  for (const c of kids(cs)) { const k = c.name.slice(2); const v = colorKid(c); if (v) t.colors[k] = v.name === "a:sysClr" ? (attr(v, "lastClr") ?? (attr(v, "val") === "window" ? "FFFFFF" : "000000")) : v.name === "a:srgbClr" ? (attr(v, "val") ?? "000000") : t.colors[k]; }
  const fs = find(tx.root, (x) => x.name === "a:fontScheme");
  t.major = attr(kid(kid(fs, "a:majorFont"), "a:latin"), "typeface") || t.major; t.minor = attr(kid(kid(fs, "a:minorFont"), "a:latin"), "typeface") || t.minor;
  const fm = find(tx.root, (x) => x.name === "a:fmtScheme");
  t.fill = kids(kid(fm, "a:fillStyleLst")); t.ln = kids(kid(fm, "a:lnStyleLst")); t.bg = kids(kid(fm, "a:bgFillStyleLst"));
  return t;
}
function clrMapOf(x: XDoc | null | undefined, base: Record<string, string>): Record<string, string> {
  if (!x) return base;
  const m = kid(x.root, "p:clrMap") ?? kid(kid(x.root, "p:clrMapOvr"), "a:overrideClrMapping");
  if (!m) return base; const out = { ...base }; for (const [k] of m.attrs) out[k] = attr(m, k)!; return out;
}

/* ================================================================ placeholders */

const MASTER_TYPE: Record<string, string> = { body: "body", chart: "body", clipArt: "body", ctrTitle: "title", dgm: "body", dt: "dt", ftr: "ftr", media: "body", obj: "body", pic: "body", sldImg: "body", sldNum: "sldNum", subTitle: "body", tbl: "body", title: "title", hdr: "hdr" };
function phList(x: XDoc | null | undefined): { el: XEl; type: string; idx: string }[] {
  if (!x) return [];
  return shapeKids(spTreeOf(x)).map((e) => (e.name === "mc:AlternateContent" ? altContent(e) : e)).filter((e): e is XEl => !!e).flatMap((e) => { const ph = phOf(e); return ph ? [{ el: e, type: ph.type, idx: ph.idx ?? "0" }] : []; });
}
/** inheritance chain for a placeholder on a slide: [layout placeholder?, master placeholder?] */
export function phChain(ctx: Ctx, ph: { type: string; idx: string | undefined }, onLayout = false): XEl[] {
  const out: XEl[] = [];
  let lay: { el: XEl; type: string } | undefined;
  if (!onLayout) {
    const L = phList(ctx.layoutX);
    lay = L.find((p) => p.idx === (ph.idx ?? "0"));
    if (!lay) lay = L.find((p) => MASTER_TYPE[p.type] === MASTER_TYPE[ph.type] && (p.type === ph.type || MASTER_TYPE[ph.type] === "title")); // PowerPoint falls back to the type
    if (lay) out.push(lay.el);
  }
  const mt = MASTER_TYPE[(lay ?? ph).type] ?? "body";
  const m = phList(ctx.masterX).find((p) => p.type === mt); if (m) out.push(m.el);
  return out;
}
/** python-pptx's stricter rule (layout by idx only, master by mapped type) — used to compare geometry with it */
export function phChainStrict(ctx: Ctx, ph: { type: string; idx: string | undefined }): XEl[] {
  const lay = phList(ctx.layoutX).find((p) => p.idx === (ph.idx ?? "0")); if (!lay) return [];
  const m = phList(ctx.masterX).find((p) => p.type === (MASTER_TYPE[lay.type] ?? "body"));
  return m ? [lay.el, m.el] : [lay.el];
}

/* ================================================================ text */

const lvlPPr = (list: XEl | undefined, lvl: number) => kid(list, `a:lvl${lvl + 1}pPr`);
const txStyleOf = (ctx: Ctx, kind: "title" | "body" | "other") => kid(kid(ctx.masterX?.root, "p:txStyles"), `p:${kind}Style`);
const presDefault = (ctx: Ctx) => kid(ctx.doc.pres.root, "p:defaultTextStyle");
interface TextSrc { lists: (XEl | undefined)[]; fontRef?: XEl; kind: "title" | "body" | "other"; ph: boolean }
/** the ordered list-style sources for a shape's text */
function textSources(ctx: Ctx, e: XEl, chain: XEl[], onMaster = false): TextSrc {
  const ph = phOf(e); const mt = ph ? MASTER_TYPE[ph.type] ?? "body" : undefined;
  const kind = mt === "title" ? "title" : mt === "body" ? "body" : "other";
  const lists: (XEl | undefined)[] = [kid(txBodyOf(e), "a:lstStyle")];
  for (const c of chain) lists.push(kid(txBodyOf(c), "a:lstStyle"));
  if (ph || onMaster) lists.push(txStyleOf(ctx, kind));
  if (!ph) { lists.push(presDefault(ctx)); lists.push(txStyleOf(ctx, "other")); }
  else if (kind === "other") lists.push(presDefault(ctx));
  return { lists, fontRef: kid(kid(e, "p:style"), "a:fontRef"), kind, ph: !!ph };
}
const romanize = (n: number) => { const t: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]; let s = ""; for (const [v, r] of t) while (n >= v) { s += r; n -= v; } return s; };
const alpha = (n: number) => { let s = ""; while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } return s; };
export function autoNum(type: string, n: number): string {
  const base = type.startsWith("roman") ? romanize(n) : type.startsWith("alpha") ? alpha(n) : String(n);
  const v = /Uc/.test(type) ? base.toUpperCase() : base;
  if (/ParenBoth$/.test(type)) return `(${v})`; if (/ParenR$/.test(type)) return `${v})`; if (/Period$/.test(type)) return `${v}.`; if (/Minus$/.test(type)) return `- ${v} -`;
  return v;
}

function resolveText(ctx: Ctx, tx: XEl, src: TextSrc, bodyChain: XEl[], from: string): VText {
  // body properties: own → inherited placeholders' (attribute-wise)
  const bps = [kid(tx, "a:bodyPr"), ...bodyChain.map((c) => kid(txBodyOf(c), "a:bodyPr"))].filter(Boolean) as XEl[];
  const bp = (k: string) => { for (const b of bps) { const v = attr(b, k); if (v !== undefined) return v; } return undefined; };
  const autofit = bps.map((b) => kid(b, "a:normAutofit")).find(Boolean);
  const noAuto = bps.findIndex((b) => kid(b, "a:noAutofit") || kid(b, "a:spAutoFit"));
  const fitIdx = bps.findIndex((b) => kid(b, "a:normAutofit"));
  const scale = autofit && (noAuto < 0 || fitIdx < noAuto) ? Number(attr(autofit, "fontScale") ?? 100000) / 100000 : 1;
  const lnReduce = autofit && (noAuto < 0 || fitIdx < noAuto) ? Number(attr(autofit, "lnSpcReduction") ?? 0) / 100000 : 0;
  const ins = [bp("lIns") ?? "91440", bp("tIns") ?? "45720", bp("rIns") ?? "91440", bp("bIns") ?? "45720"].map(Number) as [number, number, number, number];
  const counters: number[] = []; const paras: VPara[] = [];
  const fontRefColor = src.fontRef ? colorOf(colorKid(src.fontRef), ctx) : undefined;
  const fontRefFace = src.fontRef ? (attr(src.fontRef, "idx") === "major" ? ctx.theme.major : ctx.theme.minor) : undefined;
  for (const p of kids(tx, "a:p")) {
    const pPr = kid(p, "a:pPr"); const lvl = Math.max(0, Math.min(8, Number(attr(pPr, "lvl") ?? 0)));
    const pChain = [pPr, ...src.lists.map((l) => lvlPPr(l, lvl)), ...src.lists.map((l) => kid(l, "a:defPPr"))].filter(Boolean) as XEl[];
    const pa = (k: string) => { for (const x of pChain) { const v = attr(x, k); if (v !== undefined) return v; } return undefined; };
    const pk = (names: string[]) => { for (const x of pChain) { const c = kids(x).find((k) => names.includes(k.name)); if (c) return c; } return undefined; };
    const rChain = (rPr: XEl | undefined) => [rPr, ...pChain.map((x) => kid(x, "a:defRPr"))].filter(Boolean) as XEl[];
    const runOf = (rPr: XEl | undefined, text: string, kind: VRun["kind"]): VRun => {
      const rc = rChain(rPr);
      const ra = (k: string) => { for (const x of rc) { const v = attr(x, k); if (v !== undefined) return v; } return undefined; };
      // explicit own fill first, then the shape style's font colour, then inherited list styles
      const ownFill = rPr ? fillKid(rPr) : undefined;
      const listFill = rc.slice(rPr ? 1 : 0).map((x) => fillKid(x)).find(Boolean);
      const fill = ownFill ? fillOf(ownFill, ctx, from) : fontRefColor ? { kind: "solid" as const, color: fontRefColor } : listFill ? fillOf(listFill, ctx, from) : undefined;
      let face = (() => { for (const x of rc) { const l = kid(x, "a:latin"); const t = attr(l, "typeface"); if (t) return t; } return undefined; })();
      if (!face && fontRefFace) face = fontRefFace;
      if (!face || face === "+mn-lt") face = ctx.theme.minor; else if (face === "+mj-lt") face = ctx.theme.major;
      const hl = rc.map((x) => kid(x, "a:highlight")).find(Boolean);
      const color = fill?.kind === "solid" ? fill.color : fill?.kind === "grad" ? fill.color : colorOf(el0("a:schemeClr", "tx1"), ctx) ?? "#000000";
      return {
        text, kind, sz: (Number(ra("sz") ?? 1800) / 100) * scale, b: on(ra("b")), i: on(ra("i")), u: !!ra("u") && ra("u") !== "none", strike: !!ra("strike") && ra("strike") !== "noStrike",
        color, font: face, baseline: Number(ra("baseline") ?? 0) / 1000, caps: ra("cap") === "all", highlight: hl ? colorOf(colorKid(hl), ctx) : undefined, link: !!(rPr && kid(rPr, "a:hlinkClick")),
      };
    };
    const runs: VRun[] = runsOf(p).map((r) => runOf(kid(r.el, "a:rPr"), r.text, r.kind));
    const end = runOf(kid(p, "a:endParaRPr"), "", "r");
    // bullets
    const bu = pk(["a:buNone", "a:buAutoNum", "a:buChar", "a:buBlip"]);
    let bullet: VPara["bullet"]; const hasText = runs.some((r) => r.kind !== "br" && r.text.length);
    for (let k = lvl + 1; k < counters.length; k++) counters[k] = 0;
    if (bu && bu.name === "a:buAutoNum") {
      const start = Number(attr(bu, "startAt") ?? 1); if (hasText) { counters[lvl] = counters[lvl] ? counters[lvl] + 1 : start; }
      if (hasText) bullet = { text: autoNum(attr(bu, "type") ?? "arabicPeriod", counters[lvl]), sizePct: 1 };
    } else { counters[lvl] = 0; if (bu && bu.name === "a:buChar" && hasText) bullet = { text: attr(bu, "char") ?? "•", sizePct: 1 }; }
    if (bullet) {
      const bf = pk(["a:buFont", "a:buFontTx"]); if (bf?.name === "a:buFont") bullet.font = attr(bf, "typeface");
      const bc = pk(["a:buClr", "a:buClrTx"]); if (bc?.name === "a:buClr") bullet.color = colorOf(colorKid(bc), ctx);
      const bs = pk(["a:buSzPct", "a:buSzPts", "a:buSzTx"]); if (bs?.name === "a:buSzPct") bullet.sizePct = Number(attr(bs, "val") ?? 100000) / 100000;
    }
    const sp = (name: string) => { const x = pk([name]); const pct = kid(x, "a:spcPct"), pts = kid(x, "a:spcPts"); return { pct: pct ? Number(attr(pct, "val")) / 100000 : undefined, pts: pts ? Number(attr(pts, "val")) / 100 : undefined }; };
    const ln = sp("a:lnSpc"), bef = sp("a:spcBef"), aft = sp("a:spcAft");
    paras.push({
      algn: pa("algn") ?? "l", marL: Number(pa("marL") ?? 0), indent: Number(pa("indent") ?? 0), lvl, bullet,
      lnPct: ln.pct !== undefined ? Math.max(0.1, ln.pct - lnReduce) : lnReduce ? 1 - lnReduce : undefined, lnPts: ln.pts,
      spcBef: bef.pts ?? 0, spcBefPct: bef.pct, spcAft: aft.pts ?? 0, runs, endSz: end.sz,
    });
  }
  return { anchor: bp("anchor") ?? (src.kind === "title" ? "ctr" : "t"), anchorCtr: bp("anchorCtr") === "1", ins, wrap: bp("wrap") !== "none", vert: bp("vert"), scale, lnReduce, paras };
}
const on = (v: string | undefined) => v === "1" || v === "true";
const el0 = (name: string, val: string): XEl => ({ k: "el", name, attrs: [["val", val]], quote: ['"'], kids: [], selfClose: true });

/* ================================================================ shapes */

interface Frame { ox: number; oy: number; sx: number; sy: number; cx0: number; cy0: number }
const ID: Frame = { ox: 0, oy: 0, sx: 1, sy: 1, cx0: 0, cy0: 0 };
const mapX = (f: Frame, x: number) => f.ox + (x - f.cx0) * f.sx;
const mapY = (f: Frame, y: number) => f.oy + (y - f.cy0) * f.sy;

function lineOf(ln: XEl | undefined, styleLn: XEl | undefined, ctx: Ctx, from: string): VLine | undefined {
  // a:ln on the shape overrides the style's line (lnRef → theme lnStyleLst[idx-1] with phClr = the ref's colour)
  let width = 9525, color: string | undefined, dash: string | undefined, none = false;
  if (styleLn) {
    const idx = Number(attr(styleLn, "idx") ?? 0);
    if (idx > 0) { const base = ctx.theme.ln[idx - 1]; const ref = colorOf(colorKid(styleLn), ctx); width = Number(attr(base, "w") ?? 9525); const bf = fillOf(fillKid(base), ctx, from, ref); color = bf?.kind === "solid" ? bf.color : ref; }
  }
  if (ln) {
    if (attr(ln, "w")) width = Number(attr(ln, "w"));
    const fk = fillKid(ln); if (fk) { const fl = fillOf(fk, ctx, from); if (fl?.kind === "none") none = true; else if (fl?.kind === "solid" || fl?.kind === "grad") color = fl.color; }
    const pd = attr(kid(ln, "a:prstDash"), "val"); if (pd && pd !== "solid") dash = pd;
  }
  if (none || !color) return undefined;
  return { color, width, dash, head: attr(kid(ln, "a:headEnd"), "type"), tail: attr(kid(ln, "a:tailEnd"), "type") };
}

function geomOf(spPr: XEl | undefined, chainSpPr: (XEl | undefined)[]): VShape["geom"] {
  const all = [spPr, ...chainSpPr];
  const pg = all.map((x) => kid(x, "a:prstGeom")).find(Boolean); const cg = all.map((x) => kid(x, "a:custGeom")).find(Boolean);
  if (cg && (!pg || kid(spPr, "a:custGeom"))) {
    const guides: Record<string, number> = {};
    for (const g of kids(kid(cg, "a:gdLst"), "a:gd")) { const m = /^val (-?\d+)$/.exec(attr(g, "fmla") ?? ""); if (m) guides[attr(g, "name") ?? ""] = Number(m[1]); }
    for (const g of kids(kid(cg, "a:avLst"), "a:gd")) { const m = /^val (-?\d+)$/.exec(attr(g, "fmla") ?? ""); if (m) guides[attr(g, "name") ?? ""] = Number(m[1]); }
    const paths: CustPath[] = kids(kid(cg, "a:pathLst"), "a:path").map((p) => ({
      w: Number(attr(p, "w") ?? 0), h: Number(attr(p, "h") ?? 0), fill: attr(p, "fill") !== "none", stroke: attr(p, "stroke") !== "0",
      cmds: kids(p).map((c) => ({ op: c.name.slice(2), pts: kids(c, "a:pt").map((pt) => [attr(pt, "x") ?? "0", attr(pt, "y") ?? "0"] as [string, string]), arc: c.name === "a:arcTo" ? [attr(c, "wR") ?? "0", attr(c, "hR") ?? "0", attr(c, "stAng") ?? "0", attr(c, "swAng") ?? "0"] as [string, string, string, string] : undefined })),
    }));
    const probe = custPathD(paths, 100, 100, guides);
    return { d: (w, h) => custPathD(paths, w, h, guides).d, open: probe.open, approx: probe.approx, name: "custom" };
  }
  if (!pg) return undefined;
  const prst = attr(pg, "prst") ?? "rect"; const adj: Record<string, number> = {};
  for (const g of kids(kid(pg, "a:avLst"), "a:gd")) { const m = /^val (-?\d+)$/.exec(attr(g, "fmla") ?? ""); if (m) adj[attr(g, "name") ?? ""] = Number(m[1]); }
  const probe = presetPath(prst, 100, 100, adj);
  return { d: (w, h) => presetPath(prst, w, h, adj).d, open: !!probe.open, approx: !!probe.approx, name: prst };
}

function shapeView(ctx: Ctx, e: XEl, addr: string, frame: Frame, layer: VShape["layer"], from: string, alt = false): VShape | null {
  if (e.name === "mc:AlternateContent") { const a = altContent(e); return a ? shapeView(ctx, a, addr, frame, layer, from, true) : null; }
  const c = cNvPrOf(e); const ph = phOf(e);
  const chain = ph && layer === "slide" ? phChain(ctx, ph) : ph && layer === "layout" ? phChain(ctx, ph, true) : [];
  const own = readXfrm(e); const inh = own ?? chain.map(readXfrm).find(Boolean) ?? null;
  const xf = inh ?? { x: 0, y: 0, cx: 0, cy: 0, rot: 0 };
  const v: VShape = {
    addr, layer, id: attr(c, "id") ?? "", name: attr(c, "name") ?? "", descr: attr(c, "descr") ?? "", kind: "other",
    x: mapX(frame, xf.x), y: mapY(frame, xf.y), w: xf.cx * frame.sx, h: xf.cy * frame.sy, rot: xf.rot ?? 0, flipH: !!xf.flipH, flipV: !!xf.flipV,
    raw: own ?? undefined, ph: ph ?? undefined, fill: { kind: "none" }, alt, hidden: attr(c, "hidden") === "1",
  };
  const style = kid(e, "p:style");
  switch (e.name) {
    case "p:grpSp": {
      v.kind = "group"; const x = kid(kid(e, "p:grpSpPr"), "a:xfrm");
      const chOff = kid(x, "a:chOff"), chExt = kid(x, "a:chExt");
      const cx0 = Number(attr(chOff, "x") ?? xf.x), cy0 = Number(attr(chOff, "y") ?? xf.y);
      const cw = Number(attr(chExt, "cx") ?? xf.cx), ch = Number(attr(chExt, "cy") ?? xf.cy);
      const f: Frame = { ox: v.x, oy: v.y, sx: frame.sx * (cw ? xf.cx / cw : 1), sy: frame.sy * (ch ? xf.cy / ch : 1), cx0, cy0 };
      v.children = shapeKids(e).map((k, i) => shapeView(ctx, k, `${addr}/${i}`, f, layer, from)).filter((s): s is VShape => !!s);
      return v;
    }
    case "p:sp": case "p:cxnSp": {
      v.kind = e.name === "p:cxnSp" ? "cxn" : "sp";
      const spPr = kid(e, "p:spPr"); const chainSpPr = chain.map((x) => kid(x, "p:spPr"));
      v.geom = geomOf(spPr, chainSpPr);
      const fk = [spPr, ...chainSpPr].map((x) => fillKid(x)).find(Boolean);
      const fr = kid(style, "a:fillRef");
      if (fk) v.fill = fillOf(fk, ctx, from) ?? { kind: "none" };
      else if (fr && Number(attr(fr, "idx") ?? 0) > 0) { const ref = colorOf(colorKid(fr), ctx); const base = ctx.theme.fill[Math.min(ctx.theme.fill.length, Number(attr(fr, "idx"))) - 1]; v.fill = (base ? fillOf(base, ctx, from, ref) : undefined) ?? (ref ? { kind: "solid", color: ref } : { kind: "none" }); }
      const ln = [spPr, ...chainSpPr].map((x) => kid(x, "a:ln")).find(Boolean);
      v.line = lineOf(ln, kid(style, "a:lnRef"), ctx, from);
      if (v.geom?.open && v.fill.kind !== "none" && !fk) v.fill = { kind: "none" };
      const tx = txBodyOf(e);
      if (tx) v.text = resolveText(ctx, tx, textSources(ctx, e, chain, layer === "master"), chain, from);
      if (v.geom?.approx) v.note = `${v.geom.name} drawn approximately`;
      return v;
    }
    case "p:pic": {
      v.kind = "pic"; const bf = kid(e, "p:blipFill"); const blip = kid(bf, "a:blip");
      const svg = find(blip ?? el0("x", ""), (x) => x.name === "asvg:svgBlip");
      let part = relPart(ctx, from, attr(svg, "r:embed")) ?? relPart(ctx, from, attr(blip, "r:embed"));
      const linked = !part && attr(blip, "r:link");
      if (part && !ctx.doc.zip.has(part)) part = undefined;
      const sr = kid(bf, "a:srcRect");
      const crop = sr ? { l: Number(attr(sr, "l") ?? 0) / 100000, t: Number(attr(sr, "t") ?? 0) / 100000, r: Number(attr(sr, "r") ?? 0) / 100000, b: Number(attr(sr, "b") ?? 0) / 100000 } : undefined;
      if (part) {
        const mime = mimeOf(part);
        v.img = { part, mime, crop, unsupported: /emf|wmf|tiff/.test(mime) ? `${part.split(".").pop()!.toUpperCase()} picture (kept in the file; this browser cannot draw it)` : undefined };
      } else v.img = { part: "", mime: "", unsupported: linked ? "linked picture (not embedded)" : "picture data missing" };
      const spPr = kid(e, "p:spPr"); v.geom = geomOf(spPr, []); v.line = lineOf(kid(spPr, "a:ln"), kid(style, "a:lnRef"), ctx, from);
      if (find(e, (x) => x.name === "a:videoFile" || x.name === "a:audioFile" || x.name === "p14:media")) v.note = "media (kept; playback not supported)";
      return v;
    }
    case "p:graphicFrame": {
      const gd = find(e, (x) => x.name === "a:graphicData"); const uri = attr(gd, "uri") ?? "";
      if (uri.endsWith("/table")) { v.kind = "table"; v.table = tableView(ctx, find(gd!, (x) => x.name === "a:tbl")!, from); return v; }
      if (uri.endsWith("/chart")) { const cc = find(gd!, (x) => x.name === "c:chart"); const part = relPart(ctx, from, attr(cc, "r:id")); v.kind = "chart"; if (part) v.chart = { part }; else v.note = "chart part missing"; return v; }
      v.kind = "graphic";
      // OLE objects / SmartArt: draw the fallback picture when the file carries one
      const pic = find(e, (x) => x.name === "p:pic"); const blip = pic ? find(pic, (x) => x.name === "a:blip") : undefined;
      const part = relPart(ctx, from, attr(blip, "r:embed"));
      if (part && ctx.doc.zip.has(part)) { const mime = mimeOf(part); v.img = { part, mime, unsupported: /emf|wmf|tiff/.test(mime) ? "object preview is EMF/WMF (kept; not drawable in a browser)" : undefined }; }
      v.note = uri.includes("diagram") ? "SmartArt (kept; drawn from its saved drawing when present)" : uri.includes("ole") ? "embedded object (kept)" : `graphic ${uri.split("/").pop()} (kept)`;
      if (uri.includes("diagram")) v.children = diagramShapes(ctx, e, addr, v, from);
      return v;
    }
    default: v.note = `${e.name} (kept)`; return v;
  }
}

/** SmartArt: PowerPoint stores the laid-out drawing (dsp:) beside the data; draw it like a group */
function diagramShapes(ctx: Ctx, e: XEl, addr: string, v: VShape, from: string): VShape[] | undefined {
  const rels = partRels(ctx.doc, from); const relIds = find(e, (x) => x.name === "dgm:relIds"); if (!relIds) return undefined;
  const dm = attr(relIds, "r:dm"); const dataPart = relPart(ctx, from, dm); if (!dataPart) return undefined;
  const dataX = partXml(ctx.doc, dataPart); const ext = dataX ? find(dataX.root, (x) => x.name === "dsp:dataModelExt") : undefined;
  const drawRid = attr(ext, "relId"); const drawPart = relPart(ctx, from, drawRid) ?? rels.filter((r) => r.type.endsWith("/diagramDrawing")).map((r) => resolveTarget(from, r.target))[0];
  const dx = drawPart ? partXml(ctx.doc, drawPart) : null; if (!dx) return undefined;
  const tree = find(dx.root, (x) => x.name === "dsp:spTree"); if (!tree) return undefined;
  const sub: Ctx = { ...ctx };
  const f: Frame = { ox: v.x, oy: v.y, sx: 1, sy: 1, cx0: 0, cy0: 0 };
  return kids(tree, "dsp:sp").map((s, i) => shapeView(sub, renameNs(s), `${addr}~${i}`, f, v.layer, drawPart!)).filter((s): s is VShape => !!s).map((s) => ({ ...s, addr: `${addr}~`, note: undefined }));
}
function renameNs(e: XEl): XEl { return { ...e, name: e.name.replace(/^dsp:/, "p:").replace(/^p:txXfrm$/, "dsp:txXfrm"), kids: e.kids.map((k) => (k.k === "el" ? renameNs(k) : k)) }; }

function tableView(ctx: Ctx, tbl: XEl, from: string): NonNullable<VShape["table"]> {
  const pr = kid(tbl, "a:tblPr"); const flag = (k: string) => attr(pr, k) === "1";
  const styleId = textOf(kid(pr, "a:tableStyleId") ?? el0("x", "")).trim();
  const ts = tableStyle(ctx, styleId);
  const cols = kids(kid(tbl, "a:tblGrid"), "a:gridCol").map((g) => Number(attr(g, "w") ?? 0));
  const trs = kids(tbl, "a:tr");
  const rows = trs.map((tr, ri) => ({
    h: Number(attr(tr, "h") ?? 0),
    cells: kids(tr, "a:tc").map((tc, ci): VCell => {
      const tcPr = kid(tc, "a:tcPr");
      const parts = [ts.whole];
      if (flag("bandRow") && !(flag("firstRow") && ri === 0)) parts.push(((ri - (flag("firstRow") ? 1 : 0)) % 2 === 0) ? ts.band1H : ts.band2H);
      if (flag("bandCol")) parts.push(ci % 2 === 0 ? ts.band1V : ts.band2V);
      if (flag("firstCol") && ci === 0) parts.push(ts.firstCol);
      if (flag("lastCol") && ci === cols.length - 1) parts.push(ts.lastCol);
      if (flag("lastRow") && ri === trs.length - 1) parts.push(ts.lastRow);
      if (flag("firstRow") && ri === 0) parts.push(ts.firstRow);
      let fill: Fill = { kind: "none" }; let txColor: string | undefined; let txBold: boolean | undefined;
      for (const p of parts) { if (!p) continue; if (p.fill) fill = p.fill; if (p.color) txColor = p.color; if (p.b !== undefined) txBold = p.b; }
      const own = fillKid(tcPr); if (own) fill = fillOf(own, ctx, from) ?? fill;
      const tx = kid(tc, "a:txBody");
      let text: VText | undefined;
      if (tx) {
        const lists: (XEl | undefined)[] = [kid(tx, "a:lstStyle"), presDefault(ctx), txStyleOf(ctx, "other")];
        text = resolveText(ctx, tx, { lists, kind: "other", ph: false }, [], from);
        for (const p of text.paras) for (const r of p.runs) { const rPr = undefined; void rPr; }
        if (txColor || txBold !== undefined) {
          const runs = kids(tx, "a:p").flatMap((p) => runsOf(p));
          let k = 0; for (const p of text.paras) for (const r of p.runs) { const src = runs[k++]; const rPr = src ? kid(src.el, "a:rPr") : undefined; if (txColor && !fillKid(rPr)) r.color = txColor; if (txBold !== undefined && attr(rPr, "b") === undefined) r.b = txBold; }
        }
        const m = (k: string, d: number) => Number(attr(tcPr, k) ?? d);
        text.ins = [m("marL", 91440), m("marT", 45720), m("marR", 91440), m("marB", 45720)]; text.anchor = attr(tcPr, "anchor") ?? "t";
      }
      const border = (n: string) => { const l = kid(tcPr, n); return l ? lineOf(l, undefined, ctx, from) : ts.border; };
      return { text, fill, span: Number(attr(tc, "gridSpan") ?? 1), rowSpan: Number(attr(tc, "rowSpan") ?? 1), merged: attr(tc, "hMerge") === "1" || attr(tc, "vMerge") === "1", borders: { l: border("a:lnL"), r: border("a:lnR"), t: border("a:lnT"), b: border("a:lnB") } };
    }),
  }));
  return { cols, rows };
}
interface TPart { fill?: Fill; color?: string; b?: boolean }
interface TStyle { whole?: TPart; band1H?: TPart; band2H?: TPart; band1V?: TPart; band2V?: TPart; firstRow?: TPart; lastRow?: TPart; firstCol?: TPart; lastCol?: TPart; border?: VLine }
/** a table style from ppt/tableStyles.xml; the default built-in "Medium Style 2 – Accent 1" when the file does not define it */
function tableStyle(ctx: Ctx, id: string): TStyle {
  const tsPart = partRels(ctx.doc, ctx.doc.presPath).find((r) => r.type.endsWith("/tableStyles"));
  const tsx = tsPart ? partXml(ctx.doc, resolveTarget(ctx.doc.presPath, tsPart.target)) : null;
  const def = id || (tsx ? attr(tsx.root, "def") ?? "" : "");
  const st = tsx ? kids(tsx.root, "a:tblStyle").find((s) => attr(s, "styleId") === def) : undefined;
  if (st) {
    const part = (n: string): TPart | undefined => {
      const x = kid(st, `a:${n}`); if (!x) return undefined;
      const tcs = kid(x, "a:tcStyle"), txs = kid(x, "a:tcTxStyle");
      const fk = fillKid(kid(tcs, "a:fill")); const fr = kid(tcs, "a:fillRef");
      const fill = fk ? fillOf(fk, ctx, ctx.doc.presPath) : fr ? (() => { const c = colorOf(colorKid(fr), ctx); return c ? { kind: "solid" as const, color: c } : undefined; })() : undefined;
      return { fill, color: colorOf(colorKid(txs), ctx), b: attr(txs, "b") === "on" ? true : attr(txs, "b") === "off" ? false : undefined };
    };
    return { whole: part("wholeTbl"), band1H: part("band1H"), band2H: part("band2H"), band1V: part("band1V"), band2V: part("band2V"), firstRow: part("firstRow"), lastRow: part("lastRow"), firstCol: part("firstCol"), lastCol: part("lastCol"), border: { color: colorOf(el0("a:schemeClr", "lt1"), ctx) ?? "#fff", width: 12700 } };
  }
  if (!def || def === "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}") {
    const acc = (t: number) => colorOf({ ...el0("a:schemeClr", "accent1"), kids: t < 1 ? [{ ...el0("a:tint", String(t * 100000)) }] : [], selfClose: t >= 1 }, ctx)!;
    return { whole: { fill: { kind: "solid", color: acc(0.2) }, color: colorOf(el0("a:schemeClr", "dk1"), ctx) }, band1H: { fill: { kind: "solid", color: acc(0.4) } }, firstRow: { fill: { kind: "solid", color: acc(1) }, color: colorOf(el0("a:schemeClr", "lt1"), ctx), b: true }, lastRow: { fill: { kind: "solid", color: acc(1) }, color: colorOf(el0("a:schemeClr", "lt1"), ctx), b: true }, firstCol: { b: true }, lastCol: { b: true }, border: { color: colorOf(el0("a:schemeClr", "lt1"), ctx) ?? "#fff", width: 12700 } };
  }
  return { border: { color: "#9ca3af", width: 9525 } };
}

/* ================================================================ slide */

function bgOf(ctx: Ctx, x: XDoc | null | undefined, from: string): Fill | undefined {
  const bg = x ? kid(kid(x.root, "p:cSld"), "p:bg") : undefined; if (!bg) return undefined;
  const pr = kid(bg, "p:bgPr"); if (pr) return fillOf(fillKid(pr), ctx, from);
  const ref = kid(bg, "p:bgRef");
  if (ref) {
    const idx = Number(attr(ref, "idx") ?? 0); const c = colorOf(colorKid(ref), ctx);
    const base = idx >= 1001 ? ctx.theme.bg[idx - 1001] : idx > 0 ? ctx.theme.fill[idx - 1] : undefined;
    return (base ? fillOf(base, ctx, ctx.master ?? from, c) : undefined) ?? (c ? { kind: "solid", color: c } : undefined);
  }
  return undefined;
}

export function contextFor(doc: PptxDoc, s: PSlide): Ctx {
  const layout = layoutOf(doc, s); const master = masterOf(doc, layout);
  const layoutX = layout ? partXml(doc, layout) : null, masterX = master ? partXml(doc, master) : null;
  const theme = loadTheme(doc, master);
  const base = { bg1: "lt1", tx1: "dk1", bg2: "lt2", tx2: "dk2", accent1: "accent1", accent2: "accent2", accent3: "accent3", accent4: "accent4", accent5: "accent5", accent6: "accent6", hlink: "hlink", folHlink: "folHlink" };
  const map = clrMapOf(s.xml, clrMapOf(layoutX, clrMapOf(masterX, base)));
  return { doc, theme, map, part: s.path, master, layout, masterX, layoutX, slideX: s.xml };
}

export function slideView(doc: PptxDoc, s: PSlide): VSlide {
  const ctx = contextFor(doc, s);
  const slideBg = bgOf(ctx, s.xml, s.path), layBg = bgOf({ ...ctx, part: ctx.layout ?? "" }, ctx.layoutX, ctx.layout ?? ""), mBg = bgOf({ ...ctx, part: ctx.master ?? "" }, ctx.masterX, ctx.master ?? "");
  const shapes: VShape[] = [];
  const showMaster = (x: XDoc | null | undefined) => attr(x?.root, "showMasterSp") !== "0";
  if (showMaster(s.xml) && showMaster(ctx.layoutX) && ctx.masterX && ctx.master) {
    shapeKids(spTreeOf(ctx.masterX)).forEach((e, i) => { const a = e.name === "mc:AlternateContent" ? altContent(e) : e; if (a && !phOf(a)) { const v = shapeView({ ...ctx, part: ctx.master! }, a, `m${i}`, ID, "master", ctx.master!); if (v) shapes.push(v); } });
  }
  if (showMaster(s.xml) && ctx.layoutX && ctx.layout) {
    shapeKids(spTreeOf(ctx.layoutX)).forEach((e, i) => { const a = e.name === "mc:AlternateContent" ? altContent(e) : e; if (a && !phOf(a)) { const v = shapeView({ ...ctx, part: ctx.layout! }, a, `l${i}`, ID, "layout", ctx.layout!); if (v) shapes.push(v); } });
  }
  shapeKids(spTreeOf(s.xml)).forEach((e, i) => { const v = shapeView(ctx, e, String(i), ID, "slide", s.path); if (v) shapes.push(v); });
  return {
    size: doc.size, bg: slideBg ?? layBg ?? mBg ?? { kind: "solid", color: colorOf(el0("a:schemeClr", "bg1"), ctx) ?? "#ffffff" },
    shapes, layout: ctx.layout, master: ctx.master, layoutName: ctx.layoutX ? attr(kid(ctx.layoutX.root, "p:cSld"), "name") : undefined, hidden: attr(s.xml.root, "show") === "0",
  };
}

/** geometry python-pptx would report for a slide shape (own xfrm, else the idx-matched layout / type-matched master) */
export function oracleGeometry(doc: PptxDoc, s: PSlide, e: XEl): Xfrm | null {
  const own = readXfrm(e); if (own) return own;
  const ph = phOf(e); if (!ph) return null;
  const ctx = contextFor(doc, s);
  for (const c of phChainStrict(ctx, ph)) { const x = readXfrm(c); if (x) return x; }
  return null;
}
export { nvPrOf, RT };
export const _test = { colorOf, autoNum, phChain, loadTheme, findAll };
