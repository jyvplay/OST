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
import { addRel, allParas, ensureStyle, inlineText, parseBlocks, parseSect, put, REL_TYPES, R_NS, W, type Block, type Para, type Rev, type WordDoc } from "./wordml";
import { attr, el, encText, kids, setAttr, parseXml, serializeEl, type XEl } from "./xmltree";
import { cloneBlocks, deleteForward, insertText, insertToken, isMine, newRev, plen, storyDoc, trackParaProps, viewEdit, type ParaView, type Pos } from "./wordedit";

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
/** One paragraph → editable text, or locked with a reason. TT65: the text is the reader's view — tracked deletions are not in
 *  it (they were: an edited line brought struck text back as plain text), and every visible unit maps to its model offset
 *  (null for field / tab tokens, which an edit may not cut into) so a line can be edited in place as tracked changes. */
function lineView(p: Para): { line: HfLine; view: ParaView } {
  let instr = "", inResult = false, field = "", out = "", locked = "", off = 0, fieldAt = 0;
  const offs: (number | null)[] = [], before: (number | null)[] = [];
  const frozen = (t: string, at: number) => { for (let u = 0; u < t.length; u++) { offs.push(null); before.push(u === 0 ? at : null); } out += t; };
  for (const it of p.content) {
    const here = off; off += it.t === "r" ? it.text.length : 1;
    if (it.rev?.kind === "del") continue; // struck text: not what the reader sees
    if (it.t === "k" && it.kind === "fieldcode") {
      const fc = it.nodes[0] as XEl | undefined; const ty = fc?.name === "w:fldChar" ? attr(fc, "w:fldCharType") : undefined;
      if (ty === "begin") { instr = ""; field = ""; fieldAt = here; }
      else if (ty === "separate") { inResult = true; field = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? ""; if (field === "PAGE") frozen("{PAGE}", fieldAt); else if (field === "NUMPAGES" || field === "SECTIONPAGES") frozen("{NUMPAGES}", fieldAt); else locked ||= `field ${field || "?"}`; }
      else if (ty === "end") { if (!inResult) { const f = instr.trim().split(/\s+/)[0]?.toUpperCase() ?? ""; if (f === "PAGE") frozen("{PAGE}", fieldAt); else if (f === "NUMPAGES" || f === "SECTIONPAGES") frozen("{NUMPAGES}", fieldAt); else locked ||= `field ${f || "?"}`; } inResult = false; instr = ""; }
      else if (fc?.name === "w:instrText") instr += fc.kids.map((k) => (k.k === "text" ? k.raw : "")).join("");
      continue;
    }
    if (it.t === "k" && it.kind === "field") { const f = (attr(it.nodes[0] as XEl, "w:instr") ?? "").trim().split(/\s+/)[0]?.toUpperCase(); if (f === "PAGE") frozen("{PAGE}", here); else if (f === "NUMPAGES" || f === "SECTIONPAGES") frozen("{NUMPAGES}", here); else locked ||= `field ${f}`; continue; }
    if (it.t === "k" && it.kind === "bookmark") continue;
    // positional tabs (Word's built-in three-column header) read as a tab; paraXml writes the original ptab back
    if (it.t === "k" && it.kind === "other" && (it.nodes[0] as XEl | undefined)?.k === "el" && (it.nodes[0] as XEl).name === "w:ptab") { if (!inResult) frozen("\t", here); continue; }
    if (it.t === "k") { locked ||= it.kind === "image" ? "picture" : it.label ? it.label.slice(0, 40) : it.kind; frozen(inlineText(it), here); continue; }
    if (inResult) continue; // cached field result
    if (it.link) locked ||= "hyperlink";
    for (let u = 0; u < it.text.length; u++) { offs.push(here + u); before.push(here + u); }
    out += it.text;
  }
  if (p.sect) locked ||= "section break";
  return { line: { id: p.id, text: out, align: ALIGN[p.p.align ?? ""] ?? "left", ...(locked ? { locked: true, label: locked } : {}) }, view: { text: out, offs, before } };
}
const lineOf = (p: Para): HfLine => lineView(p).line;
/** the message when a header / footer edit cannot be recorded as tracked changes (nothing is applied) */
export const HF_TRACK_REFUSAL = "This header / footer edit can't be recorded as tracked changes — it cuts into a page field or tab. Edit around the field, or turn off Track Changes.";

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
/**
 * Copy-on-write edit of the final <w:sectPr>: the old element is never mutated (undo snapshots and the body block
 * list hold it by reference); the new one replaces it in doc.blocks and doc.finalSect, as setPageSetup does.
 */
function editSect(doc: WordDoc, fn: (s: XEl) => void): XEl {
  const old = doc.finalSect;
  const s: XEl = old ? { ...old, kids: old.kids.slice() } : el("w:sectPr");
  fn(s);
  const at = old ? doc.blocks.findIndex((b) => b.t === "x" && b.node === old) : -1;
  if (at >= 0) doc.blocks[at] = { ...(doc.blocks[at] as Extract<Block, { t: "x" }>), node: s };
  doc.finalSect = s; // writeWord appends doc.finalSect when it is not already in the body
  return s;
}
function setRef(doc: WordDoc, kind: HfKind, type: HfType, rid: string | null) {
  // r:id needs the relationships namespace in scope; some producers never declare it on <w:document> (POI corpus)
  if (rid && !attr(doc.docXml.root, "xmlns:r") && !(doc.finalSect && attr(doc.finalSect, "xmlns:r"))) setAttr(doc.docXml.root, "xmlns:r", R_NS);
  const name = kind === "header" ? "w:headerReference" : "w:footerReference";
  const s = editSect(doc, (s) => {
  s.kids = s.kids.filter((k) => !(k.k === "el" && k.name === name && (attr(k, "w:type") ?? "default") === type));
  if (rid) {
    const ref = el(name, { "w:type": type, "r:id": rid });
    // CT_SectPr: header/footer references come first; keep existing references' order and add after them
    let at = 0; s.kids.forEach((k, i) => { if (k.k === "el" && (k.name === "w:headerReference" || k.name === "w:footerReference")) at = i + 1; });
    s.kids.splice(at, 0, ref);
  }
  s.selfClose = s.kids.length === 0;
  });
  const keepCols = doc.page.cols; doc.page = { ...parseSect(s), cols: keepCols };
}

const runXml = (rPr: string, inner: string) => `<w:r>${rPr}${inner}</w:r>`;
// XML 1.0 forbids C0 controls other than tab/LF/CR (and lone surrogates): drop them rather than write an unreadable part
const cleanLine = (t: string) => t.slice(0, MAX_TEXT).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").replace(/[\r\n]+/g, " ");
function paraXml(line: HfLine, pPr: string, rPr: string, ptabs: string[] = []): string {
  let tabN = 0; // the n-th tab reuses the paragraph's n-th original <w:ptab/> so centre/right columns keep their alignment
  const clean = cleanLine(line.text);
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
 * TT65: with Track Changes on (Word tracks header / footer edits) — and for a line that already holds revisions — an edited
 * line is changed IN PLACE through viewEdit (w:del / w:ins; an alignment change is a w:pPrChange); a new line is a tracked
 * insertion (its text and paragraph mark), a removed line a tracked deletion (kept, struck through, until reviewed). When
 * an edit cuts into a page field or tab while tracking, nothing is applied and HF_TRACK_REFUSAL is thrown.
 */
export function setHf(doc: WordDoc, kind: HfKind, type: HfType, lines: HfLine[]): string {
  const tracked = !!doc.track?.on;
  let rid = hfRid(doc, kind, type);
  const existed = !!rid && doc.hf.xml.has(rid);
  const old0 = existed ? doc.parts.get(rid!) ?? [] : [];
  // every tracked / revision-preserving line edit is computed first, on copies: a refusal leaves the document untouched
  const byId0 = new Map(old0.filter((b): b is Para => b.t === "p").map((p) => [p.id, p]));
  const edited = new Map<string, Para>();
  for (const line of lines.slice(0, MAX_LINES)) {
    const prev = line.id ? byId0.get(line.id) : undefined; if (!prev) continue;
    const was = lineOf(prev); const align = line.align ?? "left";
    if (was.locked || (was.text === line.text && was.align === align) || !(tracked || hasRev(prev))) continue;
    const text = cleanLine(line.text);
    const np = cloneBlocks([prev])[0] as Para; const d = storyDoc(doc, [np]);
    if (was.text !== text && (!viewEdit(d, [np], (q) => lineView(q).view, false, text, putHf) || d.blocks.length !== 1 || lineOf(np).text !== text)) throw new Error(HF_TRACK_REFUSAL);
    if (was.align !== align) { const before = np.p; np.p = { ...np.p }; if (align === "left") delete np.p.align; else np.p.align = align; trackParaProps(d, np, before); np.dirty = true; }
    edited.set(prev.id, np);
  }
  if (!existed) { rid = newPart(doc, kind); setRef(doc, kind, type, rid); }
  if (type === "first") setDifferentFirst(doc, true);
  const old = doc.parts.get(rid!) ?? [];
  const byId = new Map(old.filter((b): b is Para => b.t === "p").map((p) => [p.id, p]));
  const h = doc.hf.xml.get(rid!)!;
  const ctx = { doc, part: h.path, rels: h.rels, linkSeq: 5000, fld: [] as boolean[] };
  const wrap = (xml: string): Block[] => parseBlocks(ctx, parseXml(`<w:hdr xmlns:w="${W}" xmlns:r="${R_NS}">${xml}</w:hdr>`).root.kids);
  const out: Block[] = [];
  const keptIds = new Set<string>(); const fresh = new Set<Para>();
  const oldParas = old.filter((b): b is Para => b.t === "p");
  // a part created by this call holds only our empty placeholder — nothing anyone could review, so it is replaced outright
  const trackOld = tracked && existed;
  const want = lines.length ? lines : trackOld && oldParas.length ? [] : [{ text: "" }];
  for (const line of want.slice(0, MAX_LINES)) {
    const prev = line.id ? byId.get(line.id) : undefined;
    if (prev) {
      const ed = edited.get(prev.id);
      if (ed) { out.push(ed); keptIds.add(prev.id); continue; }
      const was = lineOf(prev);
      if (was.locked || (was.text === line.text && was.align === (line.align ?? "left"))) { out.push(prev); keptIds.add(prev.id); continue; }
    }
    const built = wrap(paraXml(line, pPrXml(doc, kind, prev, line.align ?? "left"), firstRPr(prev), prev?.src ? findPtabs(prev.src) : []));
    // the text and the paragraph mark are separate annotations (each its own id, §17.13.5 — as Word writes them)
    if (tracked) { const rv = newRev(doc, "ins"); for (const b of built) if (b.t === "p") { b.content = b.content.map((it) => (it.t === "k" && it.bare ? it : { ...it, rev: rv })); b.markRev = newRev(doc, "ins"); b.dirty = true; fresh.add(b); } }
    out.push(...built);
  }
  // block content that is not a paragraph (tables, text boxes, unknown elements) stays, after the paragraph it followed;
  // tracked: a removed line stays too, as a tracked deletion, where it was
  let lastPara: string | undefined; let anchor: string | undefined; let delRev: Rev | undefined;
  const removed = new Set<Para>();
  for (const b of old) {
    if (b.t === "p") {
      lastPara = b.id;
      if (keptIds.has(b.id)) { anchor = b.id; continue; }
      if (!trackOld) continue;
      const np = cloneBlocks([b])[0] as Para; const d = storyDoc(doc, [np]);
      if (plen(np)) deleteForward(d, { a: { pid: np.id, off: 0 }, b: { pid: np.id, off: plen(np) } });
      const dv = (delRev ??= newRev(doc, "del"));
      // a removed line holds only whole fields, so their codes go too (w:delInstrText) — trackedDelete keeps field codes
      // because a partial range could break a field apart; Accept would otherwise leave an empty {PAGE} behind
      np.content = np.content.flatMap((it) => (it.t !== "k" || it.kind !== "fieldcode" || it.rev?.kind === "del" ? [it] : it.rev?.kind === "ins" && isMine(doc, it.rev) ? [] : [{ ...it, rev: it.rev?.kind === "ins" ? { ...dv, ins: it.rev } : dv }]));
      if (!np.markRev) np.markRev = dv;
      np.dirty = true; removed.add(np);
      const at = anchor ? out.findIndex((x) => x.t === "p" && x.id === anchor) + 1 : 0;
      out.splice(at, 0, np); anchor = np.id;
      continue;
    }
    const at = lastPara && keptIds.has(lastPara) ? out.findIndex((x) => x.t === "p" && x.id === lastPara) + 1 : out.length;
    out.splice(at, 0, b);
  }
  // The story's final paragraph mark cannot be inserted or deleted (Word). In the trailing run of removed / new lines the
  // order of removed vs new lines is invisible in BOTH views (removed lines are hidden on Accept, new ones on Reject), so
  // the tail is normalised: removed lines first, then new ones; with both present the last removed and the last new line
  // become ONE final paragraph (old text struck, new text inserted, the original final mark kept — alignment as a tracked
  // property change), otherwise the mark change moves to the paragraph before the tail (it joins it on Reject / Accept;
  // the joined paragraph keeps that paragraph's formatting — wordedit joinNext).
  let st = out.length;
  while (st > 0 && out[st - 1].t === "p" && (fresh.has(out[st - 1] as Para) || removed.has(out[st - 1] as Para))) st--;
  if (tracked && st < out.length) {
    const tail = out.slice(st) as Para[];
    const Rs = tail.filter((p) => removed.has(p)), Fs = tail.filter((p) => fresh.has(p));
    let nt: Para[];
    if (Rs.length && Fs.length) {
      const M = Rs[Rs.length - 1], fn = Fs[Fs.length - 1];
      M.content = [...M.content, ...fn.content]; M.markRev = undefined;
      const was = M.p; M.p = { ...fn.p }; trackParaProps(storyDoc(doc, out), M, was); M.dirty = true;
      nt = [...Rs.slice(0, -1), ...Fs.slice(0, -1), M];
    } else {
      const L = tail[tail.length - 1]; const rv = L.markRev; L.markRev = undefined; L.dirty = true;
      const P = st > 0 && out[st - 1].t === "p" ? (out[st - 1] as Para) : undefined;
      if (P && rv && !P.markRev) { const pc = cloneBlocks([P])[0] as Para; pc.markRev = rv; pc.dirty = true; out[st - 1] = pc; }
      nt = tail;
    }
    out.splice(st, tail.length, ...nt);
  }
  doc.parts.set(rid!, out); doc.hf.dirty.add(rid!);
  return rid!;
}
const hasRev = (p: Para) => !!(p.markRev || p.pc || p.content.some((it) => it.rev || (it.t === "r" && it.fc)));
/** viewEdit's insert for header text: {PAGE} / {NUMPAGES} typed into a line become real page fields (as in an untracked
 *  rebuild), as tracked insertions when tracking is on */
function putHf(d: WordDoc, at0: Pos, s: string): Pos {
  let at = at0;
  for (const seg of s.split(/(\{PAGE\}|\{NUMPAGES\})/)) {
    if (!seg) continue;
    if (seg !== "{PAGE}" && seg !== "{NUMPAGES}") { at = insertText(d, at, seg); continue; }
    const fp = parseBlocks({ doc: d, part: "", rels: new Map(), linkSeq: 5000, fld: [] }, parseXml(`<w:hdr xmlns:w="${W}" xmlns:r="${R_NS}">${paraXml({ text: seg }, "", "")}</w:hdr>`).root.kids)[0] as Para;
    for (const it of fp.content) at = it.t === "r" ? insertText(d, at, it.text) : insertToken(d, at, it);
  }
  return at;
}

/** Remove the header/footer from the final section (the part itself is left in the package, unreferenced). */
/** TT65: with Track Changes on, removing a header / footer marks its text deleted (Word) — Accept leaves it empty, Reject
 *  restores it; without tracking the reference is dropped as before. */
export function removeHf(doc: WordDoc, kind: HfKind, type: HfType) {
  const rid = hfRid(doc, kind, type);
  if (doc.track?.on && rid && doc.hf.xml.has(rid)) { setHf(doc, kind, type, []); return; }
  setRef(doc, kind, type, null);
}

/** <w:titlePg/>: the first page uses the "first" header/footer (an absent one shows nothing, as in Word). */
export function setDifferentFirst(doc: WordDoc, on: boolean) {
  editSect(doc, (s) => { put(s, SECT_ORDER, "w:titlePg", on ? el("w:titlePg") : null); s.selfClose = s.kids.length === 0; });
  doc.page = { ...doc.page, titlePg: on };
}

/** All header/footer paragraphs (for search / word count callers). */
export const hfParas = (doc: WordDoc) => [...doc.parts.values()].flatMap((b) => allParas(b));
export const hfSummary = (doc: WordDoc, kind: HfKind, type: HfType) => hfLines(doc, kind, type).map((l) => (l.locked ? `[${l.label}] ` : "") + l.text).join(" / ");
