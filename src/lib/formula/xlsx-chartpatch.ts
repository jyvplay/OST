/**
 * TT50 — lossless chart edits for the .xlsx patch writer. Charts are matched to the file by the chart part they were
 * read from (`src`). Everything the user did not change stays byte-identical. Edits are as narrow as the change:
 *
 *   deleted chart        → its frame leaves the drawing; drawing rel, chart part (+ its rels) and Override go
 *   title / axis titles  → the title's first run keeps its formatting, only the text changes (inserted if absent)
 *   grouping             → c:grouping (+ c:overlap 100 for stacked bars, as Excel writes it)
 *   trendline            → the series' c:trendline elements are replaced (inserted at the schema position)
 *   legend / blanks      → c:legend added/removed, c:dispBlanksAs set
 *   anchor               → the anchor's from/to cells (one-cell/absolute anchors become two-cell anchors)
 *   chart type / series  → the chart part is regenerated from the model (styling of that chart is lost — reported)
 *   new chart            → chart part + frame appended to the sheet's drawing (drawing, rels and <drawing> created
 *                          when the sheet had none)
 * Sheet renames also rewrite the sheet prefix of every chart series reference (as Excel does).
 */
import { parseXml, serializeXml, attr, setAttr, kids, el, textNode, textOf, type XEl, type XDoc } from "../office/xmltree";
import { renameChartRefs, type ChartSpec, type ChartSeriesRef } from "./sheetmeta";
import type { Workbook } from "./engine";
import { chartFrames, chartSpaceXml, chartAnchorXml, trendXml, titleXml, seriesOutFor, defaultAnchor, resolvePart, NS_A, NS_C, NS_R, NS_XDR, REL_CHART, REL_DRAWING, CT_CHART, CT_DRAWING } from "./chartxml";

const ln = (n: string) => n.slice(n.indexOf(":") + 1);
const pre = (n: string) => (n.includes(":") ? n.slice(0, n.indexOf(":") + 1) : "");
const kidsL = (e: XEl | undefined, name: string) => kids(e).filter((k) => ln(k.name) === name);
const kidL = (e: XEl | undefined, name: string) => kidsL(e, name)[0];
const relsPathOf = (part: string) => { const i = part.lastIndexOf("/"); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; };
const relTarget = (from: string, to: string) => { // relative path from part `from` to part `to`
  const a = from.split("/").slice(0, -1), b = to.split("/"); let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
};
const RELS_EMPTY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

export interface ChartPatchIO {
  read(part: string): Promise<string | null>; // pending output first, then the original package
  exists(part: string): boolean;
  write(part: string, xml: string): void;
  remove(part: string): void;
  override(part: string, contentType: string | null): void; // null = remove the Override
  /** package part of a sheet: current name for `after` charts, original name for `before` charts */
  sheetPartNow(name: string): string | undefined;
  sheetPartWas(name: string): string | undefined;
}
export interface ChartPatchReport { charts: number; regenerated: string[]; added: number; removed: number; parts: string[] }

/** Comparable form of a chart (no id/provenance/caches). */
const seriesKey = (s: ChartSeriesRef) => JSON.stringify([s.name ?? "", s.nameRef ?? "", s.cat ?? "", s.val, s.color ?? ""]);
export const chartKey = (c: ChartSpec) => JSON.stringify([c.kind, c.title, c.grouping ?? "clustered", c.catTitle ?? "", c.valTitle ?? "", c.trend ?? null, c.legend ?? null, c.blanks ?? "gap", c.range, c.headerRow, (c.series ?? []).map((s) => [seriesKey(s), s.trend ?? null]), c.anchor ?? null, c.numFmt ?? ""]);

/** Element factory for a chart part: parses a snippet written with c:/a: prefixes and renames them to the part's own. */
function fragFactory(doc: XDoc) {
  const root = doc.root; const CP = pre(root.name);
  const bound = (ns: string) => root.attrs.find(([k, v]) => k.startsWith("xmlns:") && v === ns)?.[0].slice(6);
  let AP = bound(NS_A);
  if (AP === undefined) { AP = "a"; let i = 0; while (root.attrs.some(([k]) => k === `xmlns:${AP}`)) AP = `a${++i}`; root.attrs.push([`xmlns:${AP}`, NS_A]); root.quote.push("\""); }
  const ap = `${AP}:`;
  return (xml: string): XEl[] => {
    const f = parseXml(`<c:x xmlns:c="${NS_C}" xmlns:a="${NS_A}">${xml}</c:x>`).root;
    const fix = (e: XEl) => { e.name = e.name.startsWith("c:") ? CP + e.name.slice(2) : e.name.startsWith("a:") ? ap + e.name.slice(2) : e.name; kids(e).forEach(fix); };
    const out = kids(f); out.forEach(fix); return out;
  };
}
/** Inserts `node` into `parent` after the last child whose local name is in `after` (else first). */
function insertAfter(parent: XEl, node: XEl, after: string[]) {
  let at = -1; parent.kids.forEach((k, i) => { if (k.k === "el" && after.includes(ln(k.name))) at = i; });
  parent.kids.splice(at + 1, 0, node); parent.selfClose = false;
}
function setVal(parent: XEl, name: string, v: string, after: string[], make: (x: string) => XEl[]) {
  const e = kidL(parent, name); if (e) setAttr(e, "val", v); else insertAfter(parent, make(`<c:${name} val="${v}"/>`)[0], after);
}
/** Sets a title's text keeping the first run's formatting; creates the title when absent; removes it for "". */
function setTitle(owner: XEl, text: string, after: string[], make: (x: string) => XEl[]) {
  const t = kidL(owner, "title");
  if (!text) { if (t) owner.kids = owner.kids.filter((k) => k !== t); return; }
  if (!t) { insertAfter(owner, make(titleXml(text))[0], after); return; }
  const tx = kidL(t, "tx"); const rich = kidL(tx, "rich");
  if (rich && kidL(rich, "p")) {
    const p = kidL(rich, "p")!;
    rich.kids = rich.kids.filter((k) => !(k.k === "el" && ln(k.name) === "p" && k !== p));
    let r = kidL(p, "r");
    if (!r) { r = make(`<a:r><a:t></a:t></a:r>`)[0]; const endAt = p.kids.findIndex((k) => k.k === "el" && ln(k.name) === "endParaRPr"); if (endAt < 0) p.kids.push(r); else p.kids.splice(endAt, 0, r); p.selfClose = false; }
    p.kids = p.kids.filter((k) => !(k.k === "el" && (ln(k.name) === "r" || ln(k.name) === "fld" || ln(k.name) === "br") && k !== r));
    let at = kidL(r, "t"); if (!at) { at = make(`<a:t></a:t>`)[0]; r.kids.push(at); r.selfClose = false; }
    at.kids = [textNode(text)]; at.selfClose = false;
    return;
  }
  // automatic title or a cell-reference title the user overrode → rich text (tx is CT_Title's first child)
  const fresh = make(titleXml(text))[0]; const ftx = kidL(fresh, "tx")!;
  if (tx) t.kids[t.kids.indexOf(tx)] = ftx; else { t.kids.unshift(ftx); t.selfClose = false; }
}
const AXIS = ["catAx", "valAx", "dateAx", "serAx"];
function axisFor(plot: XEl, kind: ChartSpec["kind"], which: "cat" | "val"): XEl | undefined {
  const axes = kids(plot).filter((k) => AXIS.includes(ln(k.name)));
  if (kind === "scatter") return axes.find((a) => ln(a.name) === "valAx" && ["b", "t"].includes(attr(kidL(a, "axPos"), "val") ?? "") === (which === "cat"));
  return axes.find((a) => (which === "cat" ? ln(a.name) !== "valAx" && ln(a.name) !== "serAx" : ln(a.name) === "valAx"));
}

/** Targeted edits of one chart part. Returns false when the change needs a regenerated part. */
function editChart(doc: XDoc, a: ChartSpec, b: ChartSpec): boolean {
  if (a.kind !== b.kind) return false;
  const bs = b.series ?? [], as = a.series ?? [];
  if (bs.length !== as.length || bs.some((s, i) => seriesKey(s) !== seriesKey(as[i]))) return false;
  const make = fragFactory(doc);
  const chart = kidL(doc.root, "chart"); const plot = kidL(chart, "plotArea"); if (!chart || !plot) return false;
  const types = kids(plot).filter((k) => /Chart$/.test(ln(k.name)));
  if (a.title !== b.title) {
    setTitle(chart, a.title, [], make);
    setVal(chart, "autoTitleDeleted", a.title ? "0" : "1", ["title"], make);
  }
  for (const [which, now, was] of [["cat", a.catTitle ?? "", b.catTitle ?? ""], ["val", a.valTitle ?? "", b.valTitle ?? ""]] as const) {
    if (now === was || a.kind === "pie" || a.kind === "doughnut") continue; // pies have no axes (Excel offers no axis titles)
    const ax = axisFor(plot, a.kind, which); if (!ax) return false;
    setTitle(ax, now, ["axId", "scaling", "delete", "axPos", "majorGridlines", "minorGridlines"], make);
  }
  if ((a.grouping ?? "clustered") !== (b.grouping ?? "clustered")) {
    const g = a.grouping ?? "clustered";
    for (const t of types) {
      const tn = ln(t.name); if (!/^(bar|bar3D|line|line3D|area|area3D)Chart$/.test(tn)) continue;
      const isBar = tn.startsWith("bar");
      setVal(t, "grouping", g === "stacked" ? "stacked" : g === "percent" ? "percentStacked" : isBar ? "clustered" : "standard", ["barDir"], make);
      if (isBar) {
        const ov = kidL(t, "overlap");
        if (g !== "clustered") setVal(t, "overlap", "100", ["barDir", "grouping", "varyColors", "ser", "dLbls", "gapWidth"], make);
        else if (ov && attr(ov, "val") === "100") t.kids = t.kids.filter((k) => k !== ov);
      }
    }
  }
  const sers = types.flatMap((t) => kidsL(t, "ser"));
  const trendNow = (i: number) => as[i]?.trend ?? a.trend, trendWas = (i: number) => bs[i]?.trend ?? b.trend;
  sers.forEach((s, i) => {
    if (JSON.stringify(trendNow(i) ?? null) === JSON.stringify(trendWas(i) ?? null)) return;
    s.kids = s.kids.filter((k) => !(k.k === "el" && ln(k.name) === "trendline"));
    const t = trendNow(i);
    if (t && (a.grouping ?? "clustered") === "clustered") insertAfter(s, make(trendXml(t))[0], ["idx", "order", "tx", "spPr", "invertIfNegative", "pictureOptions", "marker", "dPt", "dLbls"]);
  });
  if ((a.legend ?? null) !== (b.legend ?? null) && a.legend !== undefined) {
    const lg = kidL(chart, "legend");
    if (!a.legend && lg) chart.kids = chart.kids.filter((k) => k !== lg);
    if (a.legend && !lg) insertAfter(chart, make(`<c:legend><c:legendPos val="r"/><c:overlay val="0"/></c:legend>`)[0], ["title", "autoTitleDeleted", "pivotFmts", "view3D", "floor", "sideWall", "backWall", "plotArea"]);
  }
  if ((a.blanks ?? "gap") !== (b.blanks ?? "gap")) setVal(chart, "dispBlanksAs", a.blanks ?? "gap", ["title", "autoTitleDeleted", "pivotFmts", "view3D", "floor", "sideWall", "backWall", "plotArea", "legend", "plotVisOnly"], make);
  return true;
}

/** Rewrites `'Old name'!` → `'New name'!` in every c:f of a chart part (Excel keeps chart references live across renames). */
export function renameInChart(xml: string, renames: [string, string][]): string {
  const quote = (s: string) => (/^[A-Za-z_][\w.]*$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);
  const doc = parseXml(xml); let hit = false;
  const walk = (e: XEl) => { if (ln(e.name) === "f") { let t = textOf(e); const t0 = t; for (const [from, to] of renames) t = t.split(`${quote(from)}!`).join(`${quote(to)}!`); if (t !== t0) { e.kids = [textNode(t)]; hit = true; } } kids(e).forEach(walk); };
  walk(doc.root); return hit ? serializeXml(doc) : xml;
}

export async function patchCharts(io: ChartPatchIO, wb: Workbook, before: ChartSpec[], after: ChartSpec[], renames: [string, string][]): Promise<ChartPatchReport> {
  const rep: ChartPatchReport = { charts: 0, regenerated: [], added: 0, removed: 0, parts: [] };
  // the model already rewrote references of renamed sheets; compare against the original with the same renames
  for (const [from, to] of renames) before = before.map((c) => renameChartRefs(c, from, to));
  const docs = new Map<string, XDoc>(); // parsed parts we are editing (drawings, drawing rels, sheets)
  const load = async (p: string, fallback?: string) => { let d = docs.get(p); if (!d) { const x = (await io.read(p)) ?? fallback; if (x === undefined) return undefined; d = parseXml(x); docs.set(p, d); } return d; };
  const touched = new Set<string>();
  const bySrc = new Map(after.filter((c) => c.src).map((c) => [c.src!, c]));
  // drawing of a sheet part: [drawing part, sheet rel id]
  const drawingOf = async (sheetPart: string): Promise<string | undefined> => {
    const sx = await load(sheetPart); if (!sx) return undefined;
    const d = kidL(sx.root, "drawing"); const id = d?.attrs.find(([k]) => ln(k) === "id" && k.includes(":"))?.[1]; if (!id) return undefined;
    const rels = await load(relsPathOf(sheetPart), RELS_EMPTY);
    const r = kids(rels!.root).find((x) => attr(x, "Id") === id); return r && attr(r, "TargetMode") !== "External" ? resolvePart(sheetPart, attr(r, "Target") ?? "") : undefined;
  };
  const relOf = async (drawing: string, chartPart: string) => {
    const rels = await load(relsPathOf(drawing), RELS_EMPTY);
    return kids(rels!.root).find((x) => resolvePart(drawing, attr(x, "Target") ?? "") === chartPart);
  };

  // 1. renamed sheets: chart references follow (every chart part in the package that the reader saw)
  if (renames.length) for (const c of before) if (c.src) {
    const x = await io.read(c.src); if (!x) continue; const y = renameInChart(x, renames); if (y !== x) { io.write(c.src, y); rep.parts.push(c.src); }
  }
  // 2. deleted and edited imported charts
  for (const b of before) {
    if (!b.src) continue;
    const a = bySrc.get(b.src);
    const sheetPart = io.sheetPartWas(b.sheet); if (!sheetPart) continue;
    const drawing = await drawingOf(sheetPart); if (!drawing) continue;
    const ddoc = await load(drawing); if (!ddoc) continue;
    const rel = await relOf(drawing, b.src); if (!rel) continue;
    const frame = chartFrames(ddoc).find((f) => f.rid === attr(rel, "Id"));
    if (!a) {
      if (frame) {
        if (frame.parent === frame.el || ln(frame.parent.name) === "Choice") ddoc.root.kids = ddoc.root.kids.filter((k) => k !== frame.el);
        else frame.parent.kids = frame.parent.kids.filter((k) => k !== frame.frame);
        touched.add(drawing);
      }
      const rels = await load(relsPathOf(drawing)); if (rels) { rels.root.kids = rels.root.kids.filter((k) => k !== rel); touched.add(relsPathOf(drawing)); }
      io.remove(b.src); io.override(b.src, null); if (io.exists(relsPathOf(b.src))) io.remove(relsPathOf(b.src));
      rep.removed++; continue;
    }
    if (chartKey(a) === chartKey(b)) continue;
    rep.charts++;
    const anchorChanged = JSON.stringify(a.anchor ?? null) !== JSON.stringify(b.anchor ?? null);
    const rest = { ...a, anchor: b.anchor }, restB = { ...b };
    if (chartKey(rest) !== chartKey(restB)) {
      const cdoc = parseXml((await io.read(b.src)) ?? "<x/>");
      if (editChart(cdoc, a, b)) io.write(b.src, serializeXml(cdoc));
      else { io.write(b.src, chartSpaceXml(a, seriesOutFor(wb, a))); rep.regenerated.push(a.title || b.src); }
      rep.parts.push(b.src);
    }
    if (anchorChanged && a.anchor && frame) {
      const an = a.anchor; const top = frame.el;
      const X = pre(top.name) || "xdr:";
      const pt = (tag: string, c: number, r: number) => el(X + tag, {}, [el(X + "col", {}, [textNode(String(c))]), el(X + "colOff", {}, [textNode("0")]), el(X + "row", {}, [textNode(String(r))]), el(X + "rowOff", {}, [textNode("0")])]);
      if (ln(top.name) === "twoCellAnchor") {
        const from = kidL(top, "from"), to = kidL(top, "to");
        if (from && to) { top.kids[top.kids.indexOf(from)] = pt("from", an.c0, an.r0); top.kids[top.kids.indexOf(to)] = pt("to", Math.max(an.c1, an.c0 + 1), Math.max(an.r1, an.r0 + 1)); touched.add(drawing); }
      } else if (ln(top.name) === "oneCellAnchor" || ln(top.name) === "absoluteAnchor") {
        const keep = kids(top).filter((k) => !["from", "to", "pos", "ext"].includes(ln(k.name)));
        const two = el(X + "twoCellAnchor", { editAs: "oneCell" }, [pt("from", an.c0, an.r0), pt("to", Math.max(an.c1, an.c0 + 1), Math.max(an.r1, an.r0 + 1)), ...keep]);
        ddoc.root.kids[ddoc.root.kids.indexOf(top)] = two; touched.add(drawing);
      }
    }
  }
  // 3. new charts (no provenance): append to the sheet's drawing, creating the drawing when needed
  const fresh = after.filter((c) => !c.src || !before.some((b) => b.src === c.src));
  const perSheet = new Map<string, ChartSpec[]>(); for (const c of fresh) perSheet.set(c.sheet, [...(perSheet.get(c.sheet) ?? []), c]);
  for (const [sheet, list] of perSheet) {
    const sheetPart = io.sheetPartNow(sheet); if (!sheetPart) continue;
    let drawing = await drawingOf(sheetPart);
    if (!drawing) {
      let n = 1; while (io.exists(`xl/drawings/drawing${n}.xml`) || docs.has(`xl/drawings/drawing${n}.xml`)) n++;
      drawing = `xl/drawings/drawing${n}.xml`;
      docs.set(drawing, parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}"/>`)); touched.add(drawing);
      io.override(drawing, CT_DRAWING);
      const srels = (await load(relsPathOf(sheetPart), RELS_EMPTY))!;
      let id = 1; while (kids(srels.root).some((r) => attr(r, "Id") === `rId${id}`)) id++;
      srels.root.kids.push(el(srels.root.name.replace(/Relationships$/, "Relationship"), { Id: `rId${id}`, Type: REL_DRAWING, Target: relTarget(sheetPart, drawing) })); srels.root.selfClose = false;
      touched.add(relsPathOf(sheetPart));
      const sx = (await load(sheetPart))!; const SP = pre(sx.root.name);
      let rp = sx.root.attrs.find(([k, v]) => k.startsWith("xmlns:") && v === NS_R)?.[0].slice(6);
      if (!rp) { rp = "r"; let i = 0; while (sx.root.attrs.some(([k]) => k === `xmlns:${rp}`)) rp = `r${++i}`; sx.root.attrs.push([`xmlns:${rp}`, NS_R]); sx.root.quote.push("\""); }
      const d = el(SP + "drawing", { [`${rp}:id`]: `rId${id}` });
      insertAfter(sx.root, d, ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags"]);
      touched.add(sheetPart);
    }
    const ddoc = (await load(drawing))!; const drels = (await load(relsPathOf(drawing), RELS_EMPTY))!;
    let maxId = 1; const walk = (e: XEl) => { if (ln(e.name) === "cNvPr") maxId = Math.max(maxId, Number(attr(e, "id")) || 0); kids(e).forEach(walk); }; walk(ddoc.root);
    const X = pre(ddoc.root.name) || "xdr:";
    list.forEach((c, k) => {
      let series; try { series = seriesOutFor(wb, c); } catch { return; }
      if (!series.length) return;
      let n = 1; while (io.exists(`xl/charts/chart${n}.xml`) || rep.parts.includes(`xl/charts/chart${n}.xml`)) n++;
      const part = `xl/charts/chart${n}.xml`;
      io.write(part, chartSpaceXml(c, series)); io.override(part, CT_CHART); rep.parts.push(part);
      let id = 1; while (kids(drels.root).some((r) => attr(r, "Id") === `rId${id}`)) id++;
      drels.root.kids.push(el(drels.root.name.replace(/Relationships$/, "Relationship"), { Id: `rId${id}`, Type: REL_CHART, Target: relTarget(drawing!, part) })); drels.root.selfClose = false;
      const anchorXml = chartAnchorXml(c.anchor ?? defaultAnchor(c.range, k), `rId${id}`, ++maxId, c.title || `Chart ${n}`);
      const node = parseXml(`<xdr:wsDr xmlns:xdr="${NS_XDR}" xmlns:a="${NS_A}">${anchorXml}</xdr:wsDr>`).root;
      const ap = ddoc.root.attrs.find(([kk, v]) => kk.startsWith("xmlns:") && v === NS_A)?.[0].slice(6);
      if (!ap) { ddoc.root.attrs.push(["xmlns:a", NS_A]); ddoc.root.quote.push("\""); }
      const fix = (e: XEl) => { e.name = e.name.startsWith("xdr:") ? X + e.name.slice(4) : e.name.startsWith("a:") && ap ? `${ap}:${e.name.slice(2)}` : e.name; kids(e).forEach(fix); };
      for (const a of kids(node)) { fix(a); ddoc.root.kids.push(a); }
      ddoc.root.selfClose = false;
      rep.added++;
    });
    touched.add(drawing); touched.add(relsPathOf(drawing));
  }
  for (const p of touched) { const d = docs.get(p); if (d) { io.write(p, serializeXml(d)); rep.parts.push(p); } }
  return rep;
}
