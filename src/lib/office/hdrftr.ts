/**
 * TT49 — Writer header / footer editing on the WordprocessingML model (ECMA-376 Part 1 §17.10).
 *
 * The editable unit is a header/footer paragraph: its text (with {PAGE} and {NUMPAGES} standing for live page
 * fields) and its alignment. A paragraph whose text and alignment are unchanged keeps its object identity — and so
 * its original XML on save; an edited paragraph keeps its own paragraph properties and the formatting of its first
 * run. Paragraphs holding anything else (pictures, text boxes, other fields such as DATE or STYLEREF, comments,
 * revisions) are LOCKED: shown, kept verbatim, never flattened. Tables and other block content are kept in place.
 *
 * New parts: word/headerN.xml / footerN.xml + relationship + content-type override + a reference in the final
 * section's <w:sectPr> (CT_SectPr: references first), and <w:titlePg/> for a different first page. Page fields are
 * written as complex fields (fldChar begin / instrText / separate / result / end) — what Word writes, and what the
 * paged view evaluates per page. Original code.
 */
import { addRel, allParas, ensureStyle, inlineText, parseBlocks, parseSect, put, REL_TYPES, R_NS, W, type Block, type Para, type WordDoc } from "./wordml";
import { attr, el, encText, kids, setAttr, parseXml, serializeEl, type XEl } from "./xmltree";

export type HfKind = "header" | "footer";
export type HfType = "default" | "first";
export type HfAlign = "left" | "center" | "right";
export interface HfLine { id?: string; text: string; align?: HfAlign; locked?: boolean; label?: string }

const MAX_LINES = 50, MAX_TEXT = 2000;
const SECT_ORDER = ["w:headerReference", "w:footerReference", "w:footnotePr", "w:endnotePr", "w:type", "w:pgSz", "w:pgMar", "w:paperSrc", "w:pgBorders", "w:lnNumType", "w:pgNumType", "w:cols", "w:formProt", "w:vAlign", "w:noEndnote", "w:titlePg", "w:textDirection", "w:bidi", "w:rtlGutter", "w:docGrid", "w:printerSettings", "w:sectPrChange"];

/** rId of the header/footer used by the final section (what the paged view draws for every page). */
export function hfRid(doc: WordDoc, kind: HfKind, type: HfType): string | undefined {
  const p = doc.page;
  return kind === "header" ? (type === "first" ? p.firstHeaderRid : p.headerRid) : (type === "first" ? p.firstFooterRid : p.footerRid);
}

const ALIGN: Record<string, HfAlign> = { left: "left", start: "left", both: "left", center: "center", right: "right", end: "right" };
/** One paragraph → editable text, or locked with a reason. */
function lineOf(p: Para): HfLine {
  let instr = "", inResult = false, field = "", out = "", locked = "";
  for (const it of p.content) {
    if (it.t === "k" && it.kind === "fieldcode") {
      const fc = it.nodes[0] as XEl | undefined; const ty = fc?.name === "w:fldChar" ? attr(fc, "w:fldCharType") : undefined;
      if (ty === "begin") { instr = ""; field = ""; }
      else if (ty === "separate") { inResult = true; field = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? ""; if (field === "PAGE") out += "{PAGE}"; else if (field === "NUMPAGES" || field === "SECTIONPAGES") out += "{NUMPAGES}"; else locked ||= `field ${field || "?"}`; }
      else if (ty === "end") { if (!inResult) { const f = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? ""; if (f === "PAGE") out += "{PAGE}"; else if (f === "NUMPAGES" || f === "SECTIONPAGES") out += "{NUMPAGES}"; else locked ||= `field ${f || "?"}`; } inResult = false; instr = ""; }
      else if (fc?.name === "w:instrText") instr += fc.kids.map((k) => (k.k === "text" ? k.raw : "")).join("");
      continue;
    }
    if (it.t === "k" && it.kind === "field") { const f = (attr(it.nodes[0] as XEl, "w:instr") ?? "").trim().split(/\s+/)[0]?.toUpperCase(); if (f === "PAGE") out += "{PAGE}"; else if (f === "NUMPAGES" || f === "SECTIONPAGES") out += "{NUMPAGES}"; else locked ||= `field ${f}`; continue; }
    if (it.t === "k" && it.kind === "bookmark") continue;
    // positional tabs (Word's built-in three-column header) read as a tab; paraXml writes the original ptab back
    if (it.t === "k" && it.kind === "other" && (it.nodes[0] as XEl | undefined)?.k === "el" && (it.nodes[0] as XEl).name === "w:ptab") { if (!inResult) out += "\t"; continue; }
    if (it.t === "k") { locked ||= it.kind === "image" ? "picture" : it.label ? it.label.slice(0, 40) : it.kind; out += inlineText(it); continue; }
    if (inResult) continue; // cached field result
    if (it.link) locked ||= "hyperlink";
    out += it.text;
  }
  if (p.sect) locked ||= "section break";
  return { id: p.id, text: out, align: ALIGN[p.p.align ?? ""] ?? "left", ...(locked ? { locked: true, label: locked } : {}) };
}

/** The header/footer as lines (top-level paragraphs, in order). Empty array when the slot has no part. */
export function hfLines(doc: WordDoc, kind: HfKind, type: HfType): HfLine[] {
  const rid = hfRid(doc, kind, type); const blocks = rid ? doc.parts.get(rid) : undefined;
  return blocks ? blocks.filter((b): b is Para => b.t === "p").map(lineOf) : [];
}
/** Plain text of a slot as the page shows it (fields as {PAGE}/{NUMPAGES}) — for tests and the panel summary. */
export const hfText = (doc: WordDoc, kind: HfKind, type: HfType) => hfLines(doc, kind, type).map((l) => l.text).join("\n");

function newPart(doc: WordDoc, kind: HfKind): string {
  const dir = doc.docPath.replace(/[^/]+$/, "");
  const used = new Set([...doc.zip.keys(), ...[...doc.hf.xml.values()].map((h) => h.path)]);
  let n = 1; while (used.has(`${dir}${kind}${n}.xml`)) n++;
  const path = `${dir}${kind}${n}.xml`;
  const rid = addRel(doc, kind === "header" ? REL_TYPES.header : REL_TYPES.footer, `${kind}${n}.xml`);
  const tag = kind === "header" ? "w:hdr" : "w:ftr";
  doc.hf.xml.set(rid, { path, xml: parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${tag} xmlns:w="${W}" xmlns:r="${R_NS}"></${tag}>`), rels: new Map() });
  doc.hf.created.add(rid); doc.parts.set(rid, []);
  return rid;
}
function finalSect(doc: WordDoc): XEl {
  if (!doc.finalSect) doc.finalSect = el("w:sectPr");
  return doc.finalSect;
}
function setRef(doc: WordDoc, kind: HfKind, type: HfType, rid: string | null) {
  const s = finalSect(doc);
  // r:id needs the relationships namespace in scope; some producers never declare it on <w:document> (POI corpus)
  if (rid && !attr(doc.docXml.root, "xmlns:r") && !attr(s, "xmlns:r")) setAttr(doc.docXml.root, "xmlns:r", R_NS); const name = kind === "header" ? "w:headerReference" : "w:footerReference";
  s.kids = s.kids.filter((k) => !(k.k === "el" && k.name === name && (attr(k, "w:type") ?? "default") === type));
  if (rid) {
    const ref = el(name, { "w:type": type, "r:id": rid });
    // CT_SectPr: header/footer references come first; keep existing references' order and add after them
    let at = 0; s.kids.forEach((k, i) => { if (k.k === "el" && (k.name === "w:headerReference" || k.name === "w:footerReference")) at = i + 1; });
    s.kids.splice(at, 0, ref);
  }
  s.selfClose = s.kids.length === 0;
  const keepCols = doc.page.cols; doc.page = { ...parseSect(s), cols: keepCols };
}

const runXml = (rPr: string, inner: string) => `<w:r>${rPr}${inner}</w:r>`;
function paraXml(line: HfLine, pPr: string, rPr: string, ptabs: string[] = []): string {
  let tabN = 0; // the n-th tab reuses the paragraph's n-th original <w:ptab/> so centre/right columns keep their alignment
  // XML 1.0 forbids C0 controls other than tab/LF/CR (and lone surrogates): drop them rather than write an unreadable part
  const clean = line.text.slice(0, MAX_TEXT).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").replace(/[\r\n]+/g, " ");
  const parts = clean.split(/(\{PAGE\}|\{NUMPAGES\})/);
  const body = parts.map((seg) => {
    if (seg === "{PAGE}" || seg === "{NUMPAGES}") {
      const f = seg === "{PAGE}" ? "PAGE" : "NUMPAGES";
      return runXml(rPr, '<w:fldChar w:fldCharType="begin"/>') + runXml(rPr, `<w:instrText xml:space="preserve"> ${f} </w:instrText>`) + runXml(rPr, '<w:fldChar w:fldCharType="separate"/>') + runXml(rPr, "<w:t>1</w:t>") + runXml(rPr, '<w:fldChar w:fldCharType="end"/>');
    }
    return seg ? seg.split("\t").map((t, i) => (i ? runXml(rPr, ptabs[tabN++] ?? "<w:tab/>") : "") + (t ? runXml(rPr, `<w:t xml:space="preserve">${encText(t)}</w:t>`) : "")).join("") : "";
  }).join("");
  return `<w:p>${pPr}${body}</w:p>`;
}
function pPrXml(doc: WordDoc, kind: HfKind, old: Para | undefined, align: HfAlign): string {
  const base = old?.src ? kids(old.src, "w:pPr")[0] : undefined;
  const pPr: XEl = base ? JSON.parse(JSON.stringify(base)) as XEl : el("w:pPr");
  // new paragraphs only get the Header/Footer style — an edited one keeps its own
  if (!old) { const style = kind === "header" ? "Header" : "Footer"; ensureStyle(doc, style); if (doc.styles.has(style)) put(pPr, ["w:pStyle"], "w:pStyle", el("w:pStyle", { "w:val": style })); }
  // CT_PPrBase order (jc is late); put() keeps the schema order
  const ORDER = ["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl", "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd", "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange"];
  put(pPr, ORDER, "w:jc", align === "left" ? null : el("w:jc", { "w:val": align }));
  return pPr.kids.length ? serializeEl(pPr) : "";
}
function findPtabs(e: XEl, out: string[] = []): string[] {
  for (const k of e.kids) if (k.k === "el") { if (k.name === "w:ptab") out.push(serializeEl(k)); else if (k.name !== "w:pPr") findPtabs(k, out); }
  return out;
}
function firstRPr(old: Para | undefined): string {
  const r = old?.src ? kids(old.src, "w:r").find((x) => kids(x, "w:t").length) ?? kids(old.src, "w:r")[0] : undefined;
  const rPr = r ? kids(r, "w:rPr")[0] : undefined;
  return rPr ? serializeEl(rPr) : "";
}

/**
 * Replace a header/footer with `lines`. Lines carrying the id of an existing paragraph reuse it when unchanged
 * (or locked); others are (re)built. An empty list keeps one empty paragraph (a part must hold a block).
 */
export function setHf(doc: WordDoc, kind: HfKind, type: HfType, lines: HfLine[]): string {
  let rid = hfRid(doc, kind, type);
  if (!rid || !doc.hf.xml.has(rid)) { rid = newPart(doc, kind); setRef(doc, kind, type, rid); }
  if (type === "first") setDifferentFirst(doc, true);
  const old = doc.parts.get(rid) ?? [];
  const byId = new Map(old.filter((b): b is Para => b.t === "p").map((p) => [p.id, p]));
  const h = doc.hf.xml.get(rid)!;
  const ctx = { doc, part: h.path, rels: h.rels, linkSeq: 5000, fld: [] as boolean[] };
  const wrap = (xml: string): Block[] => parseBlocks(ctx, parseXml(`<w:hdr xmlns:w="${W}" xmlns:r="${R_NS}">${xml}</w:hdr>`).root.kids);
  const out: Block[] = [];
  const keptIds = new Set<string>();
  for (const line of (lines.length ? lines : [{ text: "" }]).slice(0, MAX_LINES)) {
    const prev = line.id ? byId.get(line.id) : undefined;
    if (prev) {
      const was = lineOf(prev);
      if (was.locked || (was.text === line.text && was.align === (line.align ?? "left"))) { out.push(prev); keptIds.add(prev.id); continue; }
    }
    out.push(...wrap(paraXml(line, pPrXml(doc, kind, prev, line.align ?? "left"), firstRPr(prev), prev?.src ? findPtabs(prev.src) : [])));
  }
  // block content that is not a paragraph (tables, text boxes, unknown elements) stays, after the paragraph it followed
  let lastPara: string | undefined;
  for (const b of old) {
    if (b.t === "p") { lastPara = b.id; continue; }
    const at = lastPara && keptIds.has(lastPara) ? out.findIndex((x) => x.t === "p" && x.id === lastPara) + 1 : out.length;
    out.splice(at, 0, b);
  }
  doc.parts.set(rid, out); doc.hf.dirty.add(rid);
  return rid;
}

/** Remove the header/footer from the final section (the part itself is left in the package, unreferenced). */
export function removeHf(doc: WordDoc, kind: HfKind, type: HfType) { setRef(doc, kind, type, null); }

/** <w:titlePg/>: the first page uses the "first" header/footer (an absent one shows nothing, as in Word). */
export function setDifferentFirst(doc: WordDoc, on: boolean) {
  const s = finalSect(doc);
  put(s, SECT_ORDER, "w:titlePg", on ? el("w:titlePg") : null);
  doc.page = { ...doc.page, titlePg: on };
}

/** All header/footer paragraphs (for search / word count callers). */
export const hfParas = (doc: WordDoc) => [...doc.parts.values()].flatMap((b) => allParas(b));
export const hfSummary = (doc: WordDoc, kind: HfKind, type: HfType) => hfLines(doc, kind, type).map((l) => (l.locked ? `[${l.label}] ` : "") + l.text).join(" / ");
