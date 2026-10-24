/**
 * TT51 — lossless PresentationML (.pptx) engine, original code written against ECMA-376 Part 1 (§13 PresentationML,
 * §20 DrawingML) and Part 2 (OPC). It replaces the TT18 text-only subset (pptx.ts, kept for the legacy .fdeck path).
 *
 * Contract (checked by scripts/tt51-slides.mts against python-pptx and an lxml package validator):
 *  - reading keeps every part's bytes; a save with no edit returns the original file byte-for-byte;
 *  - an edit re-serialises ONLY the parts it touched (slide, its rels, notes, presentation.xml, its rels,
 *    [Content_Types].xml, docProps/core.xml modified-date) — every other part stays byte-identical;
 *  - every mutation is copy-on-write: an XML tree that an undo snapshot may still hold is never modified in place;
 *  - the package stays referentially valid: every relationship target exists, every part has a content type,
 *    slide ids are unique, deleting a slide also removes its notes slide, hyperlinks/custom shows/sections that pointed
 *    at it, and media no other part uses.
 *
 * Shapes are addressed by their position in the slide's spTree ("3", or "5/2" inside a group) so an address stays valid
 * across copy-on-write clones.
 */
import { openZip, writeZip, type ZipArchive } from "./zipkit";
import { parseXml, serializeXml, attr, setAttr, kids, kid, el, textNode, clone, textOf, find, findAll, type XDoc, type XEl, type XNode } from "./xmltree";

export const NS = {
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  rel: "http://schemas.openxmlformats.org/package/2006/relationships",
  ct: "http://schemas.openxmlformats.org/package/2006/content-types",
};
const RTB = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
export const RT = {
  officeDocument: RTB + "officeDocument", slide: RTB + "slide", slideLayout: RTB + "slideLayout", slideMaster: RTB + "slideMaster",
  notesSlide: RTB + "notesSlide", notesMaster: RTB + "notesMaster", theme: RTB + "theme", image: RTB + "image", hyperlink: RTB + "hyperlink",
  chart: RTB + "chart", media: "http://schemas.microsoft.com/office/2007/relationships/media", video: RTB + "video", audio: RTB + "audio",
};
export const CTYPE = {
  slide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  notesSlide: "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml",
  notesMaster: "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
};
export const IMG_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf" };
export const MAX_PPTX = 64 * 1024 * 1024, MAX_SLIDES = 2000, MAX_PARTS = 20_000;
export const EMU_PER_PT = 12700, EMU_PER_PX = 9525;

export interface PRel { id: string; type: string; target: string; mode?: string }
export interface PSlide {
  /** stable UI key (survives reorder and clones) */ uid: string;
  sldId: string; rid: string; path: string;
  xml: XDoc; relsXml: XDoc;
}
export interface PptxDoc {
  orig: Uint8Array | null;
  zip: Map<string, Uint8Array>; order: string[];
  ct: XDoc; presPath: string; pres: XDoc; presRelsPath: string; presRels: XDoc;
  slides: PSlide[];
  size: { cx: number; cy: number };
  /** parsed, never-mutated parts (layouts, masters, themes, notes master, chart parts) */ cache: Map<string, XDoc | null>;
  /** notes slides (mutable through copy-on-write) */ notes: Map<string, { xml: XDoc; relsXml: XDoc }>;
  dirty: Set<string>; removed: Set<string>;
  warnings: string[]; title: string; seq: number;
  /** part names of the file as opened (to recognise edits that cancelled out) */ origNames?: string[];
}

const te = new TextEncoder(), td = new TextDecoder();
export const relsPathOf = (part: string) => { const i = part.lastIndexOf("/"); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; };
export function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/"); parts.pop();
  for (const seg of target.split("/")) { if (seg === "..") parts.pop(); else if (seg && seg !== ".") parts.push(seg); }
  return parts.join("/");
}
/** relative target from part `from` to part `to` (both package paths, no leading slash) */
export function relTarget(from: string, to: string): string {
  const a = from.split("/"); a.pop(); const b = to.split("/");
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
const emptyRels = () => parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rel}"></Relationships>`);
export const cloneDoc = (d: XDoc): XDoc => ({ prolog: d.prolog, root: clone(d.root), epilog: d.epilog });
export function relList(x: XDoc | null): PRel[] {
  return x ? kids(x.root, "Relationship").map((r) => ({ id: attr(r, "Id") ?? "", type: attr(r, "Type") ?? "", target: attr(r, "Target") ?? "", mode: attr(r, "TargetMode") })) : [];
}
const isExternal = (r: PRel) => r.mode === "External";

/* ================================================================ reading */

export async function readPptxDoc(bytes: Uint8Array, name = "Presentation.pptx"): Promise<PptxDoc> {
  if (bytes.length > MAX_PPTX) throw new Error("pptx: file exceeds the 64 MiB guard");
  let z: ZipArchive;
  try { z = openZip(bytes); } catch (e) { throw new Error(`pptx: not a valid zip package (${(e as Error).message})`); }
  if (z.entries.length > MAX_PARTS) throw new Error("pptx: too many parts");
  const zip = new Map<string, Uint8Array>(); const order: string[] = [];
  let total = 0;
  for (const e of z.entries) {
    if (e.name.endsWith("/")) continue;
    const d = await z.read(e.name); if (!d) continue;
    total += d.length; if (total > 512 * 1024 * 1024) throw new Error("pptx: expands beyond 512 MiB (zip bomb guard)");
    if (!zip.has(e.name)) order.push(e.name);
    zip.set(e.name, d);
  }
  canonicalNames(zip, order);
  const text = (p: string) => { const d = zip.get(p) ?? zip.get([...zip.keys()].find((k) => k.toLowerCase() === p.toLowerCase()) ?? ""); return d ? td.decode(d) : null; };
  const ctSrc = text("[Content_Types].xml"); if (!ctSrc) throw new Error("pptx: [Content_Types].xml missing (not an OOXML package)");
  const ct = parseXml(ctSrc);
  const rootRels = relList(text("_rels/.rels") ? parseXml(text("_rels/.rels")!) : null);
  const main = rootRels.find((r) => r.type === RT.officeDocument || r.type.endsWith("/officeDocument"));
  const presPath = main ? resolveTarget("", main.target) : "ppt/presentation.xml";
  const presSrc = text(presPath); if (!presSrc) throw new Error("pptx: presentation part not found (is this a PowerPoint file?)");
  const pres = parseXml(presSrc);
  if (pres.root.name !== "p:presentation") throw new Error(`pptx: main part is <${pres.root.name}>, not a presentation`);
  const presRelsPath = relsPathOf(presPath);
  const presRels = text(presRelsPath) ? parseXml(text(presRelsPath)!) : emptyRels();
  const rels = relList(presRels);
  const doc: PptxDoc = {
    orig: bytes, zip, order, ct, presPath, pres, presRelsPath, presRels, slides: [], size: { cx: 9144000, cy: 6858000 },
    cache: new Map(), notes: new Map(), dirty: new Set(), removed: new Set(), warnings: [], title: name.replace(/\.[^.]+$/, ""), seq: 0, origNames: order.slice(),
  };
  const sz = kid(pres.root, "p:sldSz");
  if (sz) { const cx = Number(attr(sz, "cx")), cy = Number(attr(sz, "cy")); if (cx > 0 && cy > 0 && cx < 51206400 * 2 && cy < 51206400 * 2) doc.size = { cx, cy }; }
  const seenPaths = new Set<string>();
  for (const s of kids(kid(pres.root, "p:sldIdLst"), "p:sldId")) {
    if (doc.slides.length >= MAX_SLIDES) { doc.warnings.push(`only the first ${MAX_SLIDES} slides are opened`); break; }
    const rid = attr(s, "r:id") ?? ""; const r = rels.find((x) => x.id === rid);
    if (!r || isExternal(r)) { doc.warnings.push(`slide id ${attr(s, "id")} has no relationship`); continue; }
    const path = realKey(zip, resolveTarget(presPath, r.target));
    if (seenPaths.has(path)) { doc.warnings.push(`slide part ${path} is listed twice; the duplicate entry is ignored`); continue; }
    const src = text(path); if (!src) { doc.warnings.push(`slide part ${path} is missing`); continue; }
    let xml: XDoc; try { xml = parseXml(src); } catch (e) { doc.warnings.push(`${path}: ${(e as Error).message}`); continue; }
    if (xml.root.name !== "p:sld") { doc.warnings.push(`${path} is not a slide`); continue; }
    seenPaths.add(path);
    const rp = relsPathOf(path);
    doc.slides.push({ uid: `s${++doc.seq}`, sldId: attr(s, "id") ?? "", rid, path, xml, relsXml: text(rp) ? parseXml(text(rp)!) : emptyRels() });
  }
  return doc;
}

/** OPC part names are case-insensitive, but everything after reading looks parts up by exact name: re-key every entry that a
 *  relationship (or the rels convention itself) names with different case to the referenced spelling — otherwise an edited
 *  save would write "slide1.xml" next to the stale "Slide1.XML" (two parts with one name). Unedited saves still return the
 *  original bytes, so the original spelling survives whenever nothing changed. */
function canonicalNames(zip: Map<string, Uint8Array>, order: string[]) {
  const lower = new Map<string, string>(); for (const k of zip.keys()) lower.set(k.toLowerCase(), k);
  // the first reference claims a part's spelling; later references with another spelling never move it again (otherwise the
  // result would depend on zip entry order), and references from the package root and the main part are read first
  const claimed = new Set<string>();
  const rename = (want: string) => {
    const lw = want.toLowerCase(); if (claimed.has(lw)) return; claimed.add(lw);
    if (zip.has(want)) return; const have = lower.get(lw); if (!have || have === want) return;
    zip.set(want, zip.get(have)!); zip.delete(have); lower.set(want.toLowerCase(), want); const i = order.indexOf(have); if (i >= 0) order[i] = want;
  };
  // every internal target first (resolution is case-blind here), then each rels part follows its part's canonical name
  const depth = (k: string) => (k === "_rels/.rels" ? 0 : /^[^/]+\/_rels\/[^/]+\.rels$/i.test(k) ? 1 : 2);
  for (const k of [...zip.keys()].sort((a, b) => depth(a) - depth(b))) {
    if (!k.toLowerCase().endsWith(".rels")) continue;
    const src = k === "_rels/.rels" ? "" : k.replace(/(^|\/)_rels\/([^/]+)\.rels$/i, "$1$2");
    let x: XDoc; try { x = parseXml(td.decode(zip.get(k)!)); } catch { continue; }
    for (const r of relList(x)) if (!isExternal(r) && r.target) rename(resolveTarget(src, r.target));
  }
  for (const k of [...zip.keys()]) if (!k.toLowerCase().endsWith(".rels")) { claimed.delete(relsPathOf(k).toLowerCase()); rename(relsPathOf(k)); }
}
/** the zip key for a part name, matched case-insensitively when the exact spelling is absent */
function realKey(zip: Map<string, Uint8Array>, p: string): string {
  if (zip.has(p)) return p; const lp = p.toLowerCase(); for (const k of zip.keys()) if (k.toLowerCase() === lp) return k; return p;
}

/** a parsed read-only part (layout, master, theme, chart…) — cached; null when absent or malformed */
export function partXml(doc: PptxDoc, path: string): XDoc | null {
  if (doc.cache.has(path)) return doc.cache.get(path)!;
  const real = doc.zip.has(path) ? path : realKey(doc.zip, path); // a second spelling of a part another reference claimed
  const d = doc.zip.get(real); let x: XDoc | null = null;
  if (d && !doc.removed.has(real)) { try { x = parseXml(td.decode(d)); } catch { x = null; } }
  doc.cache.set(path, x); return x;
}
export function partRels(doc: PptxDoc, path: string): PRel[] {
  const n = doc.notes.get(path); if (n) return relList(n.relsXml);
  const s = doc.slides.find((x) => x.path === path); if (s) return relList(s.relsXml);
  return relList(partXml(doc, relsPathOf(path)));
}
export const relTargetOf = (doc: PptxDoc, from: string, type: string): string | undefined => {
  const r = partRels(doc, from).find((x) => x.type === type && !isExternal(x)); return r ? resolveTarget(from, r.target) : undefined;
};
export const layoutOf = (doc: PptxDoc, s: PSlide) => relTargetOf(doc, s.path, RT.slideLayout);
export const masterOf = (doc: PptxDoc, layout: string | undefined) => (layout ? relTargetOf(doc, layout, RT.slideMaster) : undefined);
export const themeOf = (doc: PptxDoc, master: string | undefined) => (master ? relTargetOf(doc, master, RT.theme) : undefined);
export const notesPathOf = (doc: PptxDoc, s: PSlide) => relTargetOf(doc, s.path, RT.notesSlide);

/* ================================================================ shapes */

export const SHAPE_TAGS = new Set(["p:sp", "p:grpSp", "p:graphicFrame", "p:cxnSp", "p:pic", "p:contentPart", "mc:AlternateContent"]);
export const spTreeOf = (x: XDoc) => kid(kid(x.root, "p:cSld"), "p:spTree");
export const shapeKids = (tree: XEl | undefined) => kids(tree).filter((k) => SHAPE_TAGS.has(k.name));
export function shapeAt(tree: XEl | undefined, path: string): { el: XEl; parent: XEl; index: number } | null {
  let parent = tree; let hit: { el: XEl; parent: XEl; index: number } | null = null;
  for (const seg of path.split("/")) {
    if (!parent) return null;
    const list = shapeKids(parent); const i = Number(seg);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) return null;
    hit = { el: list[i], parent, index: i }; parent = list[i].name === "p:grpSp" ? list[i] : undefined;
  }
  return hit;
}
/** mc:AlternateContent → the branch PowerPoint 2007 would read (Fallback), else the Choice */
export function altContent(e: XEl): XEl | undefined {
  const b = kid(e, "mc:Fallback") ?? kid(e, "mc:Choice");
  return b ? kids(b).find((k) => SHAPE_TAGS.has(k.name)) : undefined;
}
export const nvPrOf = (e: XEl) => kid(kids(e).find((k) => k.name.startsWith("p:nv")), "p:nvPr");
export const cNvPrOf = (e: XEl) => kid(kids(e).find((k) => k.name.startsWith("p:nv")), "p:cNvPr");
export function phOf(e: XEl): { type: string; idx: string | undefined } | null {
  const ph = kid(nvPrOf(e), "p:ph"); if (!ph) return null;
  return { type: attr(ph, "type") ?? "obj", idx: attr(ph, "idx") };
}
export const txBodyOf = (e: XEl) => kid(e, "p:txBody");

/* ================================================================ text model */

export interface TRun { kind: "r" | "br" | "fld"; text: string; el: XEl }
export const runsOf = (p: XEl): TRun[] => kids(p).flatMap((k): TRun[] => {
  if (k.name === "a:r") return [{ kind: "r", text: textOf(kid(k, "a:t") ?? el("a:t")), el: k }];
  if (k.name === "a:br") return [{ kind: "br", text: "\v", el: k }];
  if (k.name === "a:fld") return [{ kind: "fld", text: textOf(kid(k, "a:t") ?? el("a:t")), el: k }];
  return [];
});
export const paraText = (p: XEl) => runsOf(p).map((r) => r.text).join("");
export const paragraphsOf = (tx: XEl | undefined) => kids(tx, "a:p");
const XML_BAD = /[\u0000-\u0008\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const cleanText = (s: string) => s.replace(/\r\n?/g, "\n").replace(XML_BAD, "").replace(/\t/g, "\t");

function runEl(rPr: XEl | undefined, text: string): XEl {
  const r = el("a:r", {}, [...(rPr ? [rPr] : []), el("a:t", {}, [textNode(text)])]);
  const t = kid(r, "a:t")!; t.selfClose = false; return r;
}
function withText(run: TRun, text: string): XEl {
  if (run.kind === "br") return run.el;
  const c = clone(run.el); const t = kid(c, "a:t");
  if (t) { t.kids = [textNode(text)]; t.selfClose = false; } else { c.kids.push(el("a:t", {}, [textNode(text)])); kid(c, "a:t")!.selfClose = false; }
  c.selfClose = false; return c;
}
const rPrOfRun = (r: TRun | undefined): XEl | undefined => { const x = r ? kid(r.el, "a:rPr") : undefined; return x ? clone(x) : undefined; };
function rPrFromEnd(p: XEl): XEl | undefined { const e = kid(p, "a:endParaRPr"); if (!e) return undefined; const c = clone(e); c.name = "a:rPr"; return c; }
/** a run element sequence for `text` ("\v" = line break) */
function makeRuns(text: string, rPr: XEl | undefined): XEl[] {
  const out: XEl[] = []; const parts = text.split("\v");
  parts.forEach((s, i) => {
    if (i > 0) out.push(el("a:br", {}, rPr ? [clone(rPr)] : []));
    if (s) out.push(runEl(rPr ? clone(rPr) : undefined, s));
  });
  return out;
}
function rebuildPara(p: XEl, runEls: XEl[]) {
  const pPr = kid(p, "a:pPr"), end = kid(p, "a:endParaRPr");
  const other = kids(p).filter((k) => !["a:pPr", "a:r", "a:br", "a:fld", "a:endParaRPr"].includes(k.name)); // e.g. extLst-like vendor nodes
  p.kids = [...(pPr ? [pPr] : []), ...runEls, ...other, ...(end ? [end] : [])]; p.selfClose = p.kids.length === 0;
}

/**
 * Replace a paragraph's text, keeping the formatting of every character that did not change: the runs before the
 * common prefix end and after the common suffix start keep their exact XML; a run cut by the edit keeps its rPr; inserted
 * text joins the run it is typed into (the run holding the character before the caret, else the one after it).
 */
export function setParaText(p: XEl, next: string) {
  next = cleanText(next).replace(/\n/g, "\v");
  const runs = runsOf(p); const old = runs.map((r) => r.text).join("");
  if (old === next) return;
  let pre = 0; while (pre < old.length && pre < next.length && old[pre] === next[pre]) pre++;
  let suf = 0; while (suf < old.length - pre && suf < next.length - pre && old[old.length - 1 - suf] === next[next.length - 1 - suf]) suf++;
  // a pure insertion/deletion may slide left without changing the result ("Hello| world" + "there " ≡ "Hello |world" +
  // " there"); prefer the position that sits on a run end so typed text joins the run the caret was in
  {
    const ends = new Set<number>(); let q = 0; for (const r of runs) { q += r.text.length; if (r.kind !== "br") ends.add(q); }
    const insLen = next.length - suf - pre, delLen = old.length - suf - pre;
    if ((insLen === 0) !== (delLen === 0)) {
      const src = insLen ? next : old, len = insLen || delLen; let k = pre;
      while (k > 0 && !ends.has(k) && src[k - 1] === src[k - 1 + len]) k--;
      if (ends.has(k) && k !== pre) { suf += pre - k; pre = k; }
    }
  }
  const ins = next.slice(pre, next.length - suf), cutEnd = old.length - suf;
  type Piece = { run: TRun; text: string; whole: boolean };
  const left: Piece[] = [], right: Piece[] = []; let pos = 0;
  for (const r of runs) {
    const a = pos, b = pos + r.text.length; pos = b;
    if (a === b) { if (a <= pre) left.push({ run: r, text: "", whole: true }); else if (a >= cutEnd) right.push({ run: r, text: "", whole: true }); continue; }
    if (b <= pre) left.push({ run: r, text: r.text, whole: true });
    else if (a < pre) left.push({ run: r, text: r.text.slice(0, pre - a), whole: false });
    if (a >= cutEnd) right.push({ run: r, text: r.text, whole: true });
    else if (b > cutEnd && r.kind !== "br") right.push({ run: r, text: r.text.slice(cutEnd - a), whole: false });
  }
  const textRun = (x: Piece | undefined) => (x && x.run.kind !== "br" ? x : undefined);
  const anchor = textRun(left[left.length - 1]) ?? textRun(right[0]);
  const out: XEl[] = [];
  const emit = (x: Piece) => out.push(x.whole ? x.run.el : withText(x.run, x.text));
  const L = left.slice(), R = right.slice();
  if (ins && !ins.includes("\v") && anchor) {
    // the insertion joins the anchor run; if the edit sits inside one run, that run absorbs both sides
    const li = L.length && L[L.length - 1].run === anchor.run ? L.pop()! : undefined;
    const ri = R.length && R[0].run === anchor.run ? R.shift()! : undefined;
    L.forEach(emit);
    out.push(withText(anchor.run, (li?.text ?? "") + ins + (ri?.text ?? "")));
    R.forEach(emit);
  } else {
    const li = L.length && R.length && L[L.length - 1].run === R[0].run && !ins ? L.pop()! : undefined; // pure deletion inside one run → one run
    L.forEach(emit);
    if (li) { const ri = R.shift()!; out.push(withText(li.run, li.text + ri.text)); }
    if (ins) out.push(...makeRuns(ins, anchor ? rPrOfRun(anchor.run) : rPrFromEnd(p)));
    R.forEach(emit);
  }
  rebuildPara(p, out);
}

/** new paragraph modelled on `tpl` (paragraph properties and the formatting of its last run / end mark) */
export function newParaLike(tpl: XEl | undefined, text: string): XEl {
  const pPr = tpl ? kid(tpl, "a:pPr") : undefined; const runs = tpl ? runsOf(tpl).filter((r) => r.kind !== "br") : [];
  const rPr = runs.length ? rPrOfRun(runs[runs.length - 1]) : tpl ? rPrFromEnd(tpl) : undefined;
  const end = tpl ? kid(tpl, "a:endParaRPr") : undefined;
  const p = el("a:p", {}, [...(pPr ? [clone(pPr)] : []), ...makeRuns(cleanText(text).replace(/\n/g, "\v"), rPr), ...(end ? [clone(end)] : rPr ? [{ ...clone(rPr), name: "a:endParaRPr" }] : [])]);
  p.selfClose = p.kids.length === 0; return p;
}

/** replace the paragraphs of a txBody: unchanged paragraphs keep their exact XML, edited ones keep their runs' formatting */
export function setBodyParagraphs(tx: XEl, texts: string[]) {
  if (!texts.length) texts = [""];
  const ps = paragraphsOf(tx); const old = ps.map(paraText);
  let pre = 0; while (pre < ps.length && pre < texts.length && old[pre] === cleanText(texts[pre]).replace(/\n/g, "\v")) pre++;
  let suf = 0; while (suf < ps.length - pre && suf < texts.length - pre && old[ps.length - 1 - suf] === cleanText(texts[texts.length - 1 - suf]).replace(/\n/g, "\v")) suf++;
  const oldMid = ps.slice(pre, ps.length - suf), newMid = texts.slice(pre, texts.length - suf);
  const midOut: XEl[] = [];
  newMid.forEach((t, i) => {
    if (i < oldMid.length) { const c = clone(oldMid[i]); setParaText(c, t); midOut.push(c); }
    else midOut.push(newParaLike(midOut[midOut.length - 1] ?? oldMid[oldMid.length - 1] ?? ps[pre - 1] ?? ps[ps.length - suf] ?? ps[0], t));
  });
  const keepHead = ps.slice(0, pre), keepTail = ps.slice(ps.length - suf);
  const bodyPr = kid(tx, "a:bodyPr"), lst = kid(tx, "a:lstStyle");
  const other = kids(tx).filter((k) => !["a:bodyPr", "a:lstStyle", "a:p"].includes(k.name));
  tx.kids = [...(bodyPr ? [bodyPr] : [el("a:bodyPr")]), ...(lst ? [lst] : []), ...keepHead, ...midOut, ...keepTail, ...other]; tx.selfClose = false;
}

/* ---------------------------------------------------------------- character / paragraph formatting */

export interface RunFmt { b?: boolean; i?: boolean; u?: boolean; strike?: boolean; sz?: number /* pt */; color?: string | null /* #rrggbb, null = inherit */; font?: string | null; baseline?: number }
const RPR_ORDER = ["a:ln", "a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill", "a:effectLst", "a:effectDag", "a:highlight", "a:uLnTx", "a:uLn", "a:uFillTx", "a:uFill", "a:latin", "a:ea", "a:cs", "a:sym", "a:hlinkClick", "a:hlinkMouseOver", "a:rtl", "a:extLst"];
const PPR_ORDER = ["a:lnSpc", "a:spcBef", "a:spcAft", "a:buClrTx", "a:buClr", "a:buSzTx", "a:buSzPct", "a:buSzPts", "a:buFontTx", "a:buFont", "a:buNone", "a:buAutoNum", "a:buChar", "a:buBlip", "a:tabLst", "a:defRPr", "a:extLst"];
const FILLS = ["a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill"];
/** insert/replace child `name` keeping schema order; node null removes it (and, for fills, every fill sibling) */
export function putOrdered(parent: XEl, order: string[], name: string, node: XEl | null, group?: string[]) {
  const drop = new Set(group ?? [name]);
  parent.kids = parent.kids.filter((k) => !(k.k === "el" && drop.has(k.name)));
  if (node) {
    const rank = order.indexOf(name);
    const i = parent.kids.findIndex((k) => k.k === "el" && order.indexOf(k.name) > rank);
    if (i < 0) parent.kids.push(node); else parent.kids.splice(i, 0, node);
  }
  parent.selfClose = parent.kids.length === 0;
}
export function applyRunFmt(rPr: XEl, f: RunFmt) {
  if (f.b !== undefined) setAttr(rPr, "b", f.b ? "1" : "0");
  if (f.i !== undefined) setAttr(rPr, "i", f.i ? "1" : "0");
  if (f.u !== undefined) setAttr(rPr, "u", f.u ? "sng" : "none");
  if (f.strike !== undefined) setAttr(rPr, "strike", f.strike ? "sngStrike" : "noStrike");
  if (f.sz !== undefined) setAttr(rPr, "sz", String(Math.round(Math.min(4000, Math.max(1, f.sz)) * 100)));
  if (f.baseline !== undefined) setAttr(rPr, "baseline", f.baseline ? String(Math.round(f.baseline * 1000)) : undefined);
  if (f.color !== undefined) putOrdered(rPr, RPR_ORDER, "a:solidFill", f.color ? el("a:solidFill", {}, [el("a:srgbClr", { val: f.color.replace("#", "").toUpperCase() })]) : null, FILLS);
  if (f.font !== undefined) putOrdered(rPr, RPR_ORDER, "a:latin", f.font ? el("a:latin", { typeface: f.font }) : null);
}
/** ensure a run (or a:br / a:fld) has an a:rPr as its first child and return it */
function ensureRPr(r: XEl): XEl {
  let x = kid(r, "a:rPr"); if (x) return x;
  x = el("a:rPr", { lang: "en-US", dirty: "0" }); r.kids = [x, ...r.kids]; r.selfClose = false; return x;
}
/** split runs so that [from, to) of the paragraph text is covered by whole runs; returns those runs */
function isolate(p: XEl, from: number, to: number): XEl[] {
  const runs = runsOf(p); const out: XEl[] = []; const hit: XEl[] = []; let pos = 0;
  for (const r of runs) {
    const a = pos, b = pos + r.text.length; pos = b;
    if (b <= from || a >= to || r.kind === "br") { out.push(r.el); if (r.kind === "br" && a >= from && b <= to) hit.push(r.el); continue; }
    const s = Math.max(from, a) - a, e = Math.min(to, b) - a;
    if (r.kind === "fld" || (s === 0 && e === r.text.length)) { out.push(r.el); hit.push(r.el); continue; }
    if (s > 0) out.push(withText(r, r.text.slice(0, s)));
    const m = withText(r, r.text.slice(s, e)); out.push(m); hit.push(m);
    if (e < r.text.length) out.push(withText(r, r.text.slice(e)));
  }
  rebuildPara(p, out); return hit;
}
export interface TextPos { p: number; o: number }
/** apply character formatting to [from, to) (paragraph/offset positions); an empty range formats the whole body */
export function formatRange(tx: XEl, from: TextPos | null, to: TextPos | null, f: RunFmt) {
  const ps = paragraphsOf(tx);
  const a = from ?? { p: 0, o: 0 }, b = to ?? { p: ps.length - 1, o: Number.MAX_SAFE_INTEGER };
  const whole = !from || !to || (a.p === b.p && a.o === b.o);
  ps.forEach((p, i) => {
    if (!whole && (i < a.p || i > b.p)) return;
    const len = paraText(p).length;
    const s = whole || i > a.p ? 0 : a.o, e = whole || i < b.p ? len : Math.min(len, b.o);
    for (const r of isolate(p, s, e)) applyRunFmt(ensureRPr(r), f);
    if (whole || i < b.p || e >= len) { const end = kid(p, "a:endParaRPr") ?? (() => { const x = el("a:endParaRPr", { lang: "en-US", dirty: "0" }); p.kids.push(x); p.selfClose = false; return x; })(); applyRunFmt(end, f); }
  });
}
export interface ParaFmt { algn?: "l" | "ctr" | "r" | "just"; bullet?: "none" | "char" | "num" | "inherit"; lvl?: number }
export function formatParas(tx: XEl, pFrom: number, pTo: number, f: ParaFmt) {
  paragraphsOf(tx).forEach((p, i) => {
    if (i < pFrom || i > pTo) return;
    let pPr = kid(p, "a:pPr"); if (!pPr) { pPr = el("a:pPr"); p.kids = [pPr, ...p.kids]; p.selfClose = false; }
    if (f.algn) setAttr(pPr, "algn", f.algn);
    if (f.lvl !== undefined) setAttr(pPr, "lvl", f.lvl > 0 ? String(Math.min(8, f.lvl)) : undefined);
    if (f.bullet) {
      const BU = ["a:buNone", "a:buAutoNum", "a:buChar", "a:buBlip"];
      if (f.bullet === "inherit") putOrdered(pPr, PPR_ORDER, "a:buNone", null, BU);
      else if (f.bullet === "none") putOrdered(pPr, PPR_ORDER, "a:buNone", el("a:buNone"), BU);
      else if (f.bullet === "char") { putOrdered(pPr, PPR_ORDER, "a:buFont", el("a:buFont", { typeface: "Arial" })); putOrdered(pPr, PPR_ORDER, "a:buChar", el("a:buChar", { char: "•" }), BU); if (!attr(pPr, "marL")) { setAttr(pPr, "marL", "342900"); setAttr(pPr, "indent", "-342900"); } }
      else { putOrdered(pPr, PPR_ORDER, "a:buAutoNum", el("a:buAutoNum", { type: "arabicPeriod" }), BU); if (!attr(pPr, "marL")) { setAttr(pPr, "marL", "457200"); setAttr(pPr, "indent", "-457200"); } }
    }
  });
}

/* ================================================================ copy-on-write mutation */

export interface Snapshot { slides: PSlide[]; pres: XDoc; presRels: XDoc; ct: XDoc; notes: Map<string, { xml: XDoc; relsXml: XDoc }>; zip: Map<string, Uint8Array>; order: string[]; dirty: Set<string>; removed: Set<string>; seq: number }
export const snapshot = (d: PptxDoc): Snapshot => ({ slides: d.slides.map((s) => ({ ...s })), pres: d.pres, presRels: d.presRels, ct: d.ct, notes: new Map(d.notes), zip: new Map(d.zip), order: d.order.slice(), dirty: new Set(d.dirty), removed: new Set(d.removed), seq: d.seq });
export function restore(d: PptxDoc, s: Snapshot) {
  d.slides = s.slides.map((x) => ({ ...x })); d.pres = s.pres; d.presRels = s.presRels; d.ct = s.ct; d.notes = new Map(s.notes);
  d.zip = new Map(s.zip); d.order = s.order.slice(); d.removed = new Set(s.removed); d.seq = Math.max(d.seq, s.seq);
  // parts dirty at any point stay dirty: their bytes in `zip` are the ORIGINAL ones, so they must be re-serialised
  for (const p of s.dirty) d.dirty.add(p);
  d.cache.clear();
}
function mutPres(d: PptxDoc) { d.pres = cloneDoc(d.pres); d.dirty.add(d.presPath); return d.pres; }
function mutPresRels(d: PptxDoc) { d.presRels = cloneDoc(d.presRels); d.dirty.add(d.presRelsPath); return d.presRels; }
function mutCt(d: PptxDoc) { d.ct = cloneDoc(d.ct); d.dirty.add("[Content_Types].xml"); return d.ct; }
export function mutSlide(d: PptxDoc, i: number): PSlide {
  const s = d.slides[i]; if (!s) throw new Error(`no slide ${i + 1}`);
  const n: PSlide = { ...s, xml: cloneDoc(s.xml), relsXml: cloneDoc(s.relsXml) };
  d.slides[i] = n; d.dirty.add(n.path); d.dirty.add(relsPathOf(n.path)); return n;
}
function mutNotes(d: PptxDoc, path: string) {
  const n = d.notes.get(path)!; const c = { xml: cloneDoc(n.xml), relsXml: cloneDoc(n.relsXml) };
  d.notes.set(path, c); d.dirty.add(path); d.dirty.add(relsPathOf(path)); return c;
}
function ensureCt(d: PptxDoc, kind: "Default" | "Override", key: string, value: string) {
  const a = kind === "Default" ? "Extension" : "PartName";
  if (kids(d.ct.root, kind).some((e) => (attr(e, a) ?? "").toLowerCase() === key.toLowerCase())) return;
  const ct = mutCt(d); ct.root.kids.push(el(kind, { [a]: key, ContentType: value })); ct.root.selfClose = false;
}
function dropCtOverride(d: PptxDoc, part: string) {
  if (!kids(d.ct.root, "Override").some((e) => (attr(e, "PartName") ?? "").toLowerCase() === ("/" + part).toLowerCase())) return;
  const ct = mutCt(d); ct.root.kids = ct.root.kids.filter((k) => !(k.k === "el" && k.name === "Override" && (attr(k, "PartName") ?? "").toLowerCase() === ("/" + part).toLowerCase()));
}
function addRel(relsXml: XDoc, type: string, target: string, mode?: string): string {
  const ids = new Set(kids(relsXml.root, "Relationship").map((r) => attr(r, "Id")));
  let n = ids.size + 1; while (ids.has(`rId${n}`)) n++;
  relsXml.root.kids.push(el("Relationship", { Id: `rId${n}`, Type: type, Target: target, TargetMode: mode })); relsXml.root.selfClose = false;
  return `rId${n}`;
}
function partExists(d: PptxDoc, p: string) { return !d.removed.has(p) && (d.zip.has(p) || d.slides.some((s) => s.path === p) || d.notes.has(p)); }
function freePart(d: PptxDoc, dir: string, stem: string, ext: string) {
  const taken = new Set([...d.zip.keys(), ...d.slides.map((s) => s.path), ...d.notes.keys()].map((k) => k.toLowerCase()));
  let n = 1; while (taken.has(`${dir}/${stem}${n}.${ext}`.toLowerCase())) n++;
  return `${dir}/${stem}${n}.${ext}`;
}
function putPart(d: PptxDoc, path: string, data: Uint8Array) { if (!d.order.includes(path)) d.order.push(path); d.zip.set(path, data); d.removed.delete(path); d.dirty.add(path); d.cache.delete(path); }
function removePart(d: PptxDoc, path: string) { d.removed.add(path); d.dirty.delete(path); d.cache.delete(path); dropCtOverride(d, path); const rp = relsPathOf(path); if (d.zip.has(rp)) { d.removed.add(rp); d.dirty.delete(rp); } }

/* ================================================================ slide operations */

export function setHidden(d: PptxDoc, i: number, hidden: boolean) { const s = mutSlide(d, i); setAttr(s.xml.root, "show", hidden ? "0" : undefined); }
export const isHidden = (s: PSlide) => attr(s.xml.root, "show") === "0" || attr(s.xml.root, "show") === "false";

export function moveSlide(d: PptxDoc, from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= d.slides.length || to >= d.slides.length) return;
  const [s] = d.slides.splice(from, 1); d.slides.splice(to, 0, s); syncSldIdLst(d);
}
/** rewrite p:sldIdLst in the model order, keeping each entry's original element (and any extension attributes) */
function syncSldIdLst(d: PptxDoc) {
  const pres = mutPres(d); let lst = kid(pres.root, "p:sldIdLst");
  const byId = new Map(kids(lst, "p:sldId").map((e) => [attr(e, "id"), e]));
  const items = d.slides.map((s) => byId.get(s.sldId) ?? el("p:sldId", { id: s.sldId, "r:id": s.rid }));
  if (!items.length) { if (lst) pres.root.kids = pres.root.kids.filter((k) => k !== lst); return; }
  if (!lst) { lst = el("p:sldIdLst"); const after = ["p:sldMasterIdLst", "p:notesMasterIdLst", "p:handoutMasterIdLst"]; const i = pres.root.kids.findLastIndex((k) => k.k === "el" && after.includes(k.name)); pres.root.kids.splice(i + 1, 0, lst); }
  lst.kids = items; lst.selfClose = false;
}

/** delete a slide and everything only it used; references from other slides/custom shows/sections are removed too */
export function deleteSlide(d: PptxDoc, i: number) {
  const s = d.slides[i]; if (!s) return;
  const notes = notesPathOf(d, s);
  d.slides.splice(i, 1);
  // presentation: sldId + relationship + custom shows + sections
  syncSldIdLst(d);
  const pr = mutPresRels(d); pr.root.kids = pr.root.kids.filter((k) => !(k.k === "el" && attr(k, "Id") === s.rid));
  const pres = d.pres;
  for (const cs of findAll(pres.root, (x) => x.name === "p:custShow")) { const l = kid(cs, "p:sldLst"); if (l) l.kids = l.kids.filter((k) => !(k.k === "el" && attr(k, "r:id") === s.rid)); }
  for (const sec of findAll(pres.root, (x) => x.name === "p14:sldIdLst")) sec.kids = sec.kids.filter((k) => !(k.k === "el" && attr(k, "id") === s.sldId));
  removePart(d, s.path);
  if (notes && partExists(d, notes)) { removePart(d, notes); d.notes.delete(notes); }
  // other slides that link to the deleted one (action buttons / hyperlinks to a slide)
  d.slides.forEach((o, j) => {
    const dead = relList(o.relsXml).filter((r) => !isExternal(r) && resolveTarget(o.path, r.target) === s.path).map((r) => r.id);
    if (!dead.length) return;
    const m = mutSlide(d, j);
    m.relsXml.root.kids = m.relsXml.root.kids.filter((k) => !(k.k === "el" && dead.includes(attr(k, "Id") ?? "")));
    const isDead = (x: XNode) => x.k === "el" && (x.name === "a:hlinkClick" || x.name === "a:hlinkMouseOver") && dead.includes(attr(x, "r:id") ?? "");
    for (const holder of findAll(m.xml.root, (x) => x.kids.some(isDead))) { holder.kids = holder.kids.filter((k) => !isDead(k)); holder.selfClose = holder.kids.length === 0; }
  });
  gcMedia(d);
}

const SHARED_TYPES = new Set([RT.slideLayout, RT.slideMaster, RT.theme, RT.notesMaster, RT.image, RT.media, RT.video, RT.audio, RT.hyperlink, RT.slide]);
/** copy a part and the parts it owns (charts with their workbook/style/colors, diagrams, OLE packages); shared parts are referenced */
function deepCopyPart(d: PptxDoc, src: string, seen: Map<string, string>): string {
  if (seen.has(src)) return seen.get(src)!;
  const m = /^(.*)\/([^/]*?)(\d*)\.([^./]+)$/.exec(src); const dst = m ? freePart(d, m[1], m[2] || "part", m[4]) : src + ".copy";
  seen.set(src, dst);
  const data = d.zip.get(src); if (!data) return dst;
  putPart(d, dst, data);
  const ov = kids(d.ct.root, "Override").find((e) => (attr(e, "PartName") ?? "").toLowerCase() === ("/" + src).toLowerCase());
  if (ov) ensureCt(d, "Override", "/" + dst, attr(ov, "ContentType")!);
  const rp = relsPathOf(src); const rx = partXml(d, rp);
  if (rx) {
    const c = cloneDoc(rx);
    for (const r of kids(c.root, "Relationship")) {
      if (attr(r, "TargetMode") === "External") continue;
      const t = resolveTarget(src, attr(r, "Target") ?? "");
      const typ = attr(r, "Type") ?? "";
      const nt = SHARED_TYPES.has(typ) ? t : deepCopyPart(d, t, seen);
      setAttr(r, "Target", relTarget(dst, nt));
    }
    putPart(d, relsPathOf(dst), te.encode(serializeXml(c)));
  }
  return dst;
}

function nextSldId(d: PptxDoc) { return String(Math.max(255, ...kids(kid(d.pres.root, "p:sldIdLst"), "p:sldId").map((e) => Number(attr(e, "id")) || 0), ...d.slides.map((s) => Number(s.sldId) || 0)) + 1); }
function insertSlideEntry(d: PptxDoc, at: number, path: string, xml: XDoc, relsXml: XDoc): PSlide {
  const pr = mutPresRels(d);
  const rid = addRel(pr, RT.slide, relTarget(d.presPath, path));
  const s: PSlide = { uid: `s${++d.seq}`, sldId: nextSldId(d), rid, path, xml, relsXml };
  d.slides.splice(at, 0, s); d.dirty.add(path); d.dirty.add(relsPathOf(path)); d.removed.delete(path); d.removed.delete(relsPathOf(path));
  if (!d.order.includes(path)) d.order.push(path);
  ensureCt(d, "Override", "/" + path, CTYPE.slide);
  syncSldIdLst(d);
  return s;
}

export function duplicateSlide(d: PptxDoc, i: number): number {
  const s = d.slides[i]; if (!s) return i;
  const path = freePart(d, "ppt/slides", "slide", "xml");
  const xml = cloneDoc(s.xml); const relsXml = cloneDoc(s.relsXml); const seen = new Map<string, string>();
  for (const r of kids(relsXml.root, "Relationship")) {
    if (attr(r, "TargetMode") === "External") continue;
    const typ = attr(r, "Type") ?? ""; const t = resolveTarget(s.path, attr(r, "Target") ?? "");
    if (typ === RT.notesSlide) { relsXml.root.kids = relsXml.root.kids.filter((k) => k !== r); continue; } // notes copied below
    setAttr(r, "Target", relTarget(path, SHARED_TYPES.has(typ) ? t : deepCopyPart(d, t, seen)));
  }
  insertSlideEntry(d, i + 1, path, xml, relsXml);
  const notes = notesPathOf(d, s);
  if (notes) setNotesText(d, i + 1, notesText(d, i)); // a duplicate gets its own notes slide with the same text
  return i + 1;
}

/** a new slide built from a layout: one empty shape per layout placeholder (date/footer/slide number excepted, as PowerPoint does) */
export function addSlideFromLayout(d: PptxDoc, at: number, layout: string): number {
  const lx = partXml(d, layout); if (!lx) throw new Error(`layout ${layout} not found`);
  const path = freePart(d, "ppt/slides", "slide", "xml");
  let id = 1; const shapes: string[] = [];
  for (const sp of shapeKids(spTreeOf(lx))) {
    const ph = phOf(sp); if (!ph || ["dt", "ftr", "sldNum", "hdr"].includes(ph.type)) continue;
    const phEl = kid(nvPrOf(sp), "p:ph")!; const name = attr(cNvPrOf(sp), "name") ?? `Placeholder ${id + 1}`;
    const phAttrs = phEl.attrs.map(([k, v]) => `${k}="${v}"`).join(" ");
    shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${++id}" name="${escAttr(name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${phAttrs}/></p:nvPr></p:nvSpPr><p:spPr/>`
      + (sp.name === "p:sp" ? `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody>` : "") + `</p:sp>`);
  }
  const xml = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
  const relsXml = emptyRels(); addRel(relsXml, RT.slideLayout, relTarget(path, layout));
  insertSlideEntry(d, at, path, xml, relsXml);
  return at;
}
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
/** layouts of every master, in master order: [{path, name}] */
export function layoutsOf(d: PptxDoc): { path: string; name: string; master: string }[] {
  const out: { path: string; name: string; master: string }[] = [];
  for (const m of kids(kid(d.pres.root, "p:sldMasterIdLst"), "p:sldMasterId")) {
    const r = relList(d.presRels).find((x) => x.id === attr(m, "r:id")); if (!r) continue;
    const master = resolveTarget(d.presPath, r.target); const mx = partXml(d, master); if (!mx) continue;
    const mrels = relList(partXml(d, relsPathOf(master)));
    for (const l of kids(kid(mx.root, "p:sldLayoutIdLst"), "p:sldLayoutId")) {
      const lr = mrels.find((x) => x.id === attr(l, "r:id")); if (!lr) continue;
      const path = resolveTarget(master, lr.target); const lx = partXml(d, path); if (!lx) continue;
      out.push({ path, master, name: attr(kid(lx.root, "p:cSld"), "name") ?? attr(lx.root, "type") ?? path.split("/").pop()! });
    }
  }
  return out;
}

/* ================================================================ notes */

function notesBody(x: XDoc): XEl | undefined {
  const sp = shapeKids(spTreeOf(x)).find((s) => phOf(s)?.type === "body"); return sp ? txBodyOf(sp) : undefined;
}
function loadNotes(d: PptxDoc, path: string) {
  if (d.notes.has(path)) return d.notes.get(path)!;
  const x = partXml(d, path); if (!x) return null;
  const n = { xml: x, relsXml: partXml(d, relsPathOf(path)) ?? emptyRels() }; d.notes.set(path, n); return n;
}
export function notesText(d: PptxDoc, i: number): string {
  const s = d.slides[i]; if (!s) return ""; const p = notesPathOf(d, s); if (!p) return "";
  const n = loadNotes(d, p); const b = n ? notesBody(n.xml) : undefined;
  return b ? paragraphsOf(b).map((x) => paraText(x).replace(/\v/g, "\n")).join("\n") : "";
}
/** set the speaker notes (plain text, one paragraph per line); creates the notes slide — and a notes master if the deck has none */
export function setNotesText(d: PptxDoc, i: number, text: string) {
  const s = d.slides[i]; if (!s) return;
  const lines = cleanText(text).split("\n");
  let p = notesPathOf(d, s);
  if (p && loadNotes(d, p)) {
    const n = mutNotes(d, p); let b = notesBody(n.xml);
    if (!b) { const tree = spTreeOf(n.xml)!; tree.kids.push(parseXml(notesBodySp(maxShapeId(tree) + 1)).root); b = notesBody(n.xml)!; }
    setBodyParagraphs(b, lines); return;
  }
  if (!text.trim()) return;
  const master = ensureNotesMaster(d);
  p = freePart(d, "ppt/notesSlides", "notesSlide", "xml");
  const xml = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>${notesBodySp(3)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
  const relsXml = emptyRels(); addRel(relsXml, RT.notesMaster, relTarget(p, master)); addRel(relsXml, RT.slide, relTarget(p, s.path));
  setBodyParagraphs(notesBody(xml)!, lines);
  d.notes.set(p, { xml, relsXml }); d.dirty.add(p); d.dirty.add(relsPathOf(p)); if (!d.order.includes(p)) d.order.push(p);
  ensureCt(d, "Override", "/" + p, CTYPE.notesSlide);
  const m = mutSlide(d, i); addRel(m.relsXml, RT.notesSlide, relTarget(m.path, p));
}
const notesBodySp = (id: number) => `<p:sp xmlns:a="${NS.a}" xmlns:p="${NS.p}"><p:nvSpPr><p:cNvPr id="${id}" name="Notes Placeholder ${id - 1}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp>`;
export function maxShapeId(tree: XEl): number { return Math.max(1, ...findAll(tree, (x) => x.name === "p:cNvPr").map((e) => Number(attr(e, "id")) || 0)); }
function ensureNotesMaster(d: PptxDoc): string {
  const have = relList(d.presRels).find((r) => r.type === RT.notesMaster);
  if (have) { const p = resolveTarget(d.presPath, have.target); if (partExists(d, p)) return p; }
  const path = freePart(d, "ppt/notesMasters", "notesMaster", "xml"); const theme = freePart(d, "ppt/theme", "theme", "xml");
  putPart(d, theme, te.encode(DEFAULT_THEME("Office Theme"))); ensureCt(d, "Override", "/" + theme, CTYPE.theme);
  putPart(d, path, te.encode(NOTES_MASTER_XML)); ensureCt(d, "Override", "/" + path, CTYPE.notesMaster);
  const rels = emptyRels(); addRel(rels, RT.theme, relTarget(path, theme)); putPart(d, relsPathOf(path), te.encode(serializeXml(rels)));
  const rid = addRel(mutPresRels(d), RT.notesMaster, relTarget(d.presPath, path));
  const pres = mutPres(d);
  let lst = kid(pres.root, "p:notesMasterIdLst");
  if (!lst) { lst = el("p:notesMasterIdLst"); const i = pres.root.kids.findIndex((k) => k.k === "el" && k.name === "p:sldMasterIdLst"); pres.root.kids.splice(i + 1, 0, lst); }
  lst.kids = [el("p:notesMasterId", { "r:id": rid })]; lst.selfClose = false;
  return path;
}

/* ================================================================ shape operations */

export interface Xfrm { x: number; y: number; cx: number; cy: number; rot?: number; flipH?: boolean; flipV?: boolean }
export function readXfrm(e: XEl): Xfrm | null {
  const pr = e.name === "p:grpSp" ? kid(e, "p:grpSpPr") : e.name === "p:graphicFrame" ? e : kid(e, "p:spPr");
  const x = e.name === "p:graphicFrame" ? kid(pr, "p:xfrm") : kid(pr, "a:xfrm"); if (!x) return null;
  const off = kid(x, "a:off"), ext = kid(x, "a:ext"); if (!off || !ext) return null;
  const n = (v: string | undefined) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return { x: n(attr(off, "x")), y: n(attr(off, "y")), cx: n(attr(ext, "cx")), cy: n(attr(ext, "cy")), rot: n(attr(x, "rot")) / 60000 || 0, flipH: attr(x, "flipH") === "1", flipV: attr(x, "flipV") === "1" };
}
const SPPR_ORDER = ["a:xfrm", "a:custGeom", "a:prstGeom", "a:noFill", "a:solidFill", "a:gradFill", "a:blipFill", "a:pattFill", "a:grpFill", "a:ln", "a:effectLst", "a:effectDag", "a:scene3d", "a:sp3d", "a:extLst"];
/** write a shape's position/size (creating its own a:xfrm when it inherited one from its layout placeholder) */
export function setXfrm(d: PptxDoc, i: number, path: string, f: Xfrm) {
  const s = mutSlide(d, i); const hit = shapeAt(spTreeOf(s.xml), path); if (!hit) throw new Error(`no shape ${path}`);
  const e = hit.el.name === "mc:AlternateContent" ? altContent(hit.el) : hit.el; if (!e) return;
  const r = (v: number) => String(Math.round(v));
  if (e.name === "p:graphicFrame") {
    let x = kid(e, "p:xfrm"); if (!x) { x = el("p:xfrm"); const i2 = e.kids.findIndex((k) => k.k === "el" && k.name === "a:graphic"); e.kids.splice(i2 < 0 ? e.kids.length : i2, 0, x); }
    writeXfrmEl(x, f, r, false); return;
  }
  const prName = e.name === "p:grpSp" ? "p:grpSpPr" : "p:spPr";
  let pr = kid(e, prName); if (!pr) { pr = el(prName); const at = e.kids.findIndex((k) => k.k === "el" && !k.name.startsWith("p:nv")); e.kids.splice(at < 0 ? e.kids.length : at, 0, pr); }
  let x = kid(pr, "a:xfrm");
  if (!x) { x = el("a:xfrm"); putOrdered(pr, SPPR_ORDER, "a:xfrm", x); }
  if (e.name === "p:grpSp") {
    // moving/resizing a group: children keep their own coordinates; chOff/chExt map them into the new frame
    const old = readXfrm(e); if (!kid(x, "a:chOff") && old) { x.kids.push(el("a:chOff", { x: r(old.x), y: r(old.y) }), el("a:chExt", { cx: r(old.cx), cy: r(old.cy) })); }
  }
  writeXfrmEl(x, f, r, e.name === "p:grpSp");
}
function writeXfrmEl(x: XEl, f: Xfrm, r: (v: number) => string, group: boolean) {
  let off = kid(x, "a:off"), ext = kid(x, "a:ext");
  if (!off) { off = el("a:off"); x.kids = [off, ...x.kids.filter((k) => k !== off)]; }
  if (!ext) { ext = el("a:ext"); const i = x.kids.indexOf(off); x.kids.splice(i + 1, 0, ext); }
  setAttr(off, "x", r(f.x)); setAttr(off, "y", r(f.y)); setAttr(ext, "cx", r(Math.max(0, f.cx))); setAttr(ext, "cy", r(Math.max(0, f.cy)));
  if (f.rot !== undefined) setAttr(x, "rot", f.rot ? r((((f.rot % 360) + 360) % 360) * 60000) : undefined);
  if (f.flipH !== undefined) setAttr(x, "flipH", f.flipH ? "1" : undefined);
  if (f.flipV !== undefined) setAttr(x, "flipV", f.flipV ? "1" : undefined);
  x.selfClose = false; void group;
}

export function deleteShape(d: PptxDoc, i: number, path: string) {
  const s = mutSlide(d, i); const hit = shapeAt(spTreeOf(s.xml), path); if (!hit) return;
  hit.parent.kids = hit.parent.kids.filter((k) => k !== hit.el);
  // relationships no other element of this slide still uses (pictures, charts, media, links)
  const used = new Set(findAll(s.xml.root, () => true).flatMap((x) => x.attrs.filter(([k]) => k.startsWith("r:") || k === "r:embed" || k === "r:link" || k === "r:id").map(([, v]) => v)));
  const removable = relList(s.relsXml).filter((r) => [RT.image, RT.chart, RT.media, RT.video, RT.audio, RT.hyperlink].includes(r.type) || r.type.endsWith("/oleObject") || r.type.endsWith("/package") || r.type.includes("diagram"));
  const dead = removable.filter((r) => !used.has(r.id));
  if (dead.length) {
    s.relsXml.root.kids = s.relsXml.root.kids.filter((k) => !(k.k === "el" && dead.some((r) => r.id === attr(k, "Id"))));
    for (const r of dead) if (!isExternal(r) && ![RT.image, RT.media, RT.video, RT.audio].includes(r.type)) { const t = resolveTarget(s.path, r.target); if (!targetsInUse(d).has(t)) removeOwned(d, t); }
  }
  gcMedia(d);
}
function removeOwned(d: PptxDoc, p: string) {
  const rels = relList(partXml(d, relsPathOf(p)));
  removePart(d, p);
  for (const r of rels) if (!isExternal(r) && !SHARED_TYPES.has(r.type)) { const t = resolveTarget(p, r.target); if (!targetsInUse(d).has(t)) removeOwned(d, t); }
}
/** every internal relationship target in the current package */
export function targetsInUse(d: PptxDoc): Set<string> {
  const out = new Set<string>();
  const add = (from: string, rels: PRel[]) => { for (const r of rels) if (!isExternal(r)) out.add(resolveTarget(from, r.target)); };
  add("", relList(partXml(d, "_rels/.rels"))); add(d.presPath, relList(d.presRels));
  for (const s of d.slides) add(s.path, relList(s.relsXml));
  for (const [p, n] of d.notes) if (!d.removed.has(p)) add(p, relList(n.relsXml));
  const slidePaths = new Set(d.slides.map((s) => s.path));
  for (const k of d.zip.keys()) {
    if (!k.endsWith(".rels") || d.removed.has(k)) continue;
    const owner = k.replace(/_rels\/([^/]+)\.rels$/, "$1"); if (slidePaths.has(owner) || d.notes.has(owner) || owner === d.presPath || k === "_rels/.rels") continue;
    if (d.removed.has(owner)) continue;
    add(owner, relList(partXml(d, k)));
  }
  return out;
}
/** drop media parts (images, audio, video) that no relationship uses any more */
function gcMedia(d: PptxDoc) {
  const used = targetsInUse(d);
  for (const k of [...d.zip.keys()]) if (/^ppt\/media\//i.test(k) && !used.has(k) && !d.removed.has(k)) { d.removed.add(k); dropCtOverride(d, k); }
}

export function zOrder(d: PptxDoc, i: number, path: string, how: "front" | "back" | "forward" | "backward"): string {
  const s = mutSlide(d, i); const hit = shapeAt(spTreeOf(s.xml), path); if (!hit) return path;
  const list = shapeKids(hit.parent); const at = list.indexOf(hit.el);
  const to = how === "front" ? list.length - 1 : how === "back" ? 0 : how === "forward" ? Math.min(list.length - 1, at + 1) : Math.max(0, at - 1);
  if (to === at) return path;
  const target = list[to]; hit.parent.kids = hit.parent.kids.filter((k) => k !== hit.el);
  const ti = hit.parent.kids.indexOf(target); hit.parent.kids.splice(to > at ? ti + 1 : ti, 0, hit.el);
  const segs = path.split("/"); segs[segs.length - 1] = String(to); return segs.join("/");
}

export type NewShapeKind = "textbox" | "rect" | "roundRect" | "ellipse" | "triangle" | "rightArrow" | "diamond" | "star5" | "line";
/** add a text box / preset shape; returns its address */
export function addShape(d: PptxDoc, i: number, kind: NewShapeKind, f: Xfrm, text = ""): string {
  const s = mutSlide(d, i); const tree = spTreeOf(s.xml)!; const id = maxShapeId(tree) + 1;
  const xf = `<a:xfrm><a:off x="${Math.round(f.x)}" y="${Math.round(f.y)}"/><a:ext cx="${Math.round(f.cx)}" cy="${Math.round(f.cy)}"/></a:xfrm>`;
  const body = (anchor: string) => `<p:txBody><a:bodyPr wrap="square" rtlCol="0"${anchor}><a:spAutoFit/></a:bodyPr><a:lstStyle/>${(text || "").split("\n").map((t) => t ? `<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escText(t)}</a:t></a:r></a:p>` : `<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>`).join("")}</p:txBody>`;
  let x: string;
  if (kind === "textbox") x = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id - 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xf}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>${body("")}</p:sp>`;
  else if (kind === "line") x = `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Straight Connector ${id - 1}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xf}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="28575"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`;
  else x = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${SHAPE_NAME[kind]} ${id - 1}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xf}<a:prstGeom prst="${kind}"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>`
    + body(` anchor="ctr"`).replace("<a:spAutoFit/>", "").replace(/<a:p>/g, `<a:p><a:pPr algn="ctr"/>`) + `</p:sp>`;
  tree.kids.push(parseXml(`<r xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}">${x}</r>`).root.kids.find((k) => k.k === "el") as XEl);
  return String(shapeKids(tree).length - 1);
}
const SHAPE_NAME: Record<string, string> = { rect: "Rectangle", roundRect: "Rounded Rectangle", ellipse: "Oval", triangle: "Isosceles Triangle", rightArrow: "Right Arrow", diamond: "Diamond", star5: "5-Point Star" };
const escText = (s: string) => cleanText(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function addPicture(d: PptxDoc, i: number, data: Uint8Array, ext: string, f: Xfrm, descr = "Picture"): string {
  ext = ext.toLowerCase().replace("jpeg", "jpg"); if (!IMG_MIME[ext]) throw new Error(`unsupported picture type .${ext}`);
  const media = freePart(d, "ppt/media", "image", ext); putPart(d, media, data); ensureCt(d, "Default", ext, IMG_MIME[ext]);
  const s = mutSlide(d, i); const rid = addRel(s.relsXml, RT.image, relTarget(s.path, media));
  const tree = spTreeOf(s.xml)!; const id = maxShapeId(tree) + 1;
  const x = `<p:pic xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}"><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id - 1}" descr="${escAttr(descr)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(f.x)}" y="${Math.round(f.y)}"/><a:ext cx="${Math.round(f.cx)}" cy="${Math.round(f.cy)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  const pic = parseXml(x).root; pic.attrs = []; pic.quote = []; tree.kids.push(pic);
  return String(shapeKids(tree).length - 1);
}

/** solid fill / outline colour of a shape (#rrggbb, "none", or null = back to the theme style) */
export function setShapeFill(d: PptxDoc, i: number, path: string, color: string | null) {
  const s = mutSlide(d, i); const hit = shapeAt(spTreeOf(s.xml), path); const e = hit?.el; if (!e || e.name !== "p:sp") return;
  let pr = kid(e, "p:spPr"); if (!pr) { pr = el("p:spPr"); e.kids.splice(1, 0, pr); }
  putOrdered(pr, SPPR_ORDER, "a:solidFill", color === null ? null : color === "none" ? el("a:noFill") : el("a:solidFill", {}, [el("a:srgbClr", { val: color.replace("#", "").toUpperCase() })]), FILLS);
}
export function setShapeLine(d: PptxDoc, i: number, path: string, color: string | null, widthPt?: number) {
  const s = mutSlide(d, i); const hit = shapeAt(spTreeOf(s.xml), path); const e = hit?.el; if (!e || (e.name !== "p:sp" && e.name !== "p:cxnSp")) return;
  let pr = kid(e, "p:spPr"); if (!pr) { pr = el("p:spPr"); e.kids.splice(1, 0, pr); }
  if (color === null) { putOrdered(pr, SPPR_ORDER, "a:ln", null); return; }
  let ln = kid(pr, "a:ln"); if (!ln) { ln = el("a:ln"); putOrdered(pr, SPPR_ORDER, "a:ln", ln); }
  if (widthPt !== undefined) setAttr(ln, "w", String(Math.round(widthPt * EMU_PER_PT)));
  putOrdered(ln, ["a:noFill", "a:solidFill", "a:gradFill", "a:pattFill", "a:prstDash", "a:custDash", "a:round", "a:bevel", "a:miter", "a:headEnd", "a:tailEnd", "a:extLst"], "a:solidFill", color === "none" ? el("a:noFill") : el("a:solidFill", {}, [el("a:srgbClr", { val: color.replace("#", "").toUpperCase() })]), ["a:noFill", "a:solidFill", "a:gradFill", "a:pattFill"]);
}

/** the txBody an editor works on: a shape's own, or a table cell's ("3#r,c") */
export function bodyAt(x: XDoc, addr: string): XEl | undefined {
  const [path, cell] = addr.split("#"); const hit = shapeAt(spTreeOf(x), path); if (!hit) return undefined;
  const e = hit.el.name === "mc:AlternateContent" ? altContent(hit.el) : hit.el; if (!e) return undefined;
  if (cell) {
    const [r, c] = cell.split(",").map(Number); const tbl = find(e, (q) => q.name === "a:tbl");
    const tc = kids(kids(tbl, "a:tr")[r], "a:tc")[c]; if (!tc) return undefined;
    let tx = kid(tc, "a:txBody"); if (!tx) { tx = el("a:txBody", {}, [el("a:bodyPr"), el("a:lstStyle"), el("a:p")]); tc.kids = [tx, ...tc.kids]; tc.selfClose = false; }
    return tx;
  }
  if (e.name !== "p:sp") return undefined;
  let tx = txBodyOf(e);
  if (!tx) { tx = el("p:txBody", {}, [el("a:bodyPr"), el("a:lstStyle"), el("a:p", {}, [el("a:endParaRPr", { lang: "en-US", dirty: "0" })])]); const at = e.kids.findIndex((k) => k.k === "el" && k.name === "p:extLst"); e.kids.splice(at < 0 ? e.kids.length : at, 0, tx); }
  return tx;
}
export function setShapeText(d: PptxDoc, i: number, addr: string, paragraphs: string[]) {
  const s = mutSlide(d, i); const tx = bodyAt(s.xml, addr); if (!tx) throw new Error(`shape ${addr} has no text`);
  setBodyParagraphs(tx, paragraphs);
}
export function shapeParagraphs(x: XDoc, addr: string): string[] { const tx = bodyAt(cloneDoc(x), addr); return tx ? paragraphsOf(tx).map(paraText) : []; }

/* ================================================================ writing */

export function isEdited(d: PptxDoc) { return d.dirty.size > 0 || d.removed.size > 0; }
export async function writePptxDoc(d: PptxDoc): Promise<Uint8Array> {
  if (!isEdited(d) && d.orig) return d.orig;
  const slidePaths = new Set(d.slides.map((s) => s.path));
  // every part we write must have a content type (old decks list .rels parts one by one instead of a Default)
  const live = [...[...d.zip.keys()].filter((k) => !d.removed.has(k)), ...d.slides.flatMap((s) => [s.path, relsPathOf(s.path)]), ...[...d.notes.keys()].filter((k) => !d.removed.has(k)).flatMap((k) => [k, relsPathOf(k)])];
  const defaults = new Set(kids(d.ct.root, "Default").map((e) => (attr(e, "Extension") ?? "").toLowerCase()));
  const overrides = new Set(kids(d.ct.root, "Override").map((e) => (attr(e, "PartName") ?? "").toLowerCase()));
  for (const p of live) {
    const ext = (p.split(".").pop() ?? "").toLowerCase(); if (p === "[Content_Types].xml" || defaults.has(ext) || overrides.has("/" + p.toLowerCase())) continue;
    if (ext === "rels") { ensureCt(d, "Default", "rels", "application/vnd.openxmlformats-package.relationships+xml"); defaults.add("rels"); }
    else if (IMG_MIME[ext]) { ensureCt(d, "Default", ext, IMG_MIME[ext]); defaults.add(ext); }
  }
  const out = new Map(d.zip); let changed = false;
  /** re-serialise a part — but keep the original bytes when its content did not actually change (and keep a UTF-8 BOM) */
  const set = (p: string, x: XDoc) => {
    const s = serializeXml(x); const orig = d.zip.get(p);
    if (orig) {
      let same = false; try { same = serializeXml(parseXml(td.decode(orig))) === s; } catch { same = false; }
      if (same) { out.set(p, orig); return; }
      changed = true;
      if (orig[0] === 0xef && orig[1] === 0xbb && orig[2] === 0xbf) { const b = te.encode(s); const o = new Uint8Array(b.length + 3); o.set([0xef, 0xbb, 0xbf]); o.set(b, 3); out.set(p, o); return; }
    } else changed = true;
    out.set(p, te.encode(s));
  };
  for (const s of d.slides) { if (d.dirty.has(s.path)) set(s.path, s.xml); if (d.dirty.has(relsPathOf(s.path))) set(relsPathOf(s.path), s.relsXml); }
  for (const [p, n] of d.notes) { if (d.removed.has(p)) continue; if (d.dirty.has(p)) set(p, n.xml); if (d.dirty.has(relsPathOf(p))) set(relsPathOf(p), n.relsXml); }
  if (d.dirty.has(d.presPath)) set(d.presPath, d.pres);
  if (d.dirty.has(d.presRelsPath)) set(d.presRelsPath, d.presRels);
  if (d.dirty.has("[Content_Types].xml")) set("[Content_Types].xml", d.ct);
  for (const p of d.removed) if (!slidePaths.has(p) && out.delete(p)) changed = true;
  // parts written through putPart (media, copied charts, notes masters) count as changes; so does any added/removed name
  const SERIALISED = (p: string) => p === "[Content_Types].xml" || slidePaths.has(p) || d.notes.has(p) || p === d.presPath || p === d.presRelsPath || slidePaths.has(p.replace(/_rels\/([^/]+)\.rels$/, "$1")) || d.notes.has(p.replace(/_rels\/([^/]+)\.rels$/, "$1"));
  for (const p of out.keys()) if (d.dirty.has(p) && !SERIALISED(p)) changed = true;
  const names0 = new Set(d.origNames ?? []); if (out.size !== names0.size || [...out.keys()].some((k) => !names0.has(k))) changed = true;
  // edits that cancelled out (e.g. undo back to the opened state) give back the original file byte for byte
  if (!changed && d.orig) return d.orig;
  const core = out.get("docProps/core.xml");
  if (core) { const s = td.decode(core); const now = new Date().toISOString().replace(/\.\d+Z$/, "Z"); const t = s.replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${now}$2`); if (t !== s) out.set("docProps/core.xml", te.encode(t)); }
  const names = ["[Content_Types].xml", ...d.order.filter((p) => p !== "[Content_Types].xml")].filter((p, i, a) => out.has(p) && a.indexOf(p) === i);
  for (const p of out.keys()) if (!names.includes(p)) names.push(p);
  return writeZip(names.map((name) => ({ name, data: out.get(name)! })));
}

/* ================================================================ new presentation */

const DEFAULT_THEME = (name: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<a:theme xmlns:a="${NS.a}" name="${name}"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F3B57"/></a:dk2><a:lt2><a:srgbClr val="E7ECEF"/></a:lt2><a:accent1><a:srgbClr val="0E9AA7"/></a:accent1><a:accent2><a:srgbClr val="F46A4E"/></a:accent2><a:accent3><a:srgbClr val="F6C445"/></a:accent3><a:accent4><a:srgbClr val="3DA35D"/></a:accent4><a:accent5><a:srgbClr val="5B6CF0"/></a:accent5><a:accent6><a:srgbClr val="B05FD9"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="60000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
const NOTES_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notesMaster xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1143000" y="685800"/><a:ext cx="4572000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Click to edit Master text styles</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

function phSp(id: number, name: string, ph: string, x: number, y: number, cx: number, cy: number, bodyPr = "<a:bodyPr/>", text = ""): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody>${bodyPr}<a:lstStyle/><a:p>${text ? `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>` : `<a:endParaRPr lang="en-US"/>`}</a:p></p:txBody></p:sp>`;
}
const TREE_HEAD = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;
const lvlStyle = (sz: number[], bullets: boolean) => sz.map((s, i) => `<a:lvl${i + 1}pPr marL="${bullets ? 228600 + i * 457200 : 0}" indent="${bullets ? -228600 : 0}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="${bullets ? 1000 : 0}"/></a:spcBef>${bullets ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : "<a:buNone/>"}<a:defRPr sz="${s}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`).join("");

/** a new 16:9 presentation (theme, one master, Title Slide / Title and Content / Title Only / Blank layouts, one title slide) */
export async function blankPptx(title = "Untitled presentation"): Promise<Uint8Array> {
  const W = 12192000, H = 6858000; const t = escText(title);
  const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldMaster xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${TREE_HEAD}`
    + phSp(2, "Title Placeholder 1", 'type="title"', 838200, 365125, 10515600, 1325563, '<a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0" anchor="ctr"><a:normAutofit/></a:bodyPr>', "Click to edit Master title style")
    + phSp(3, "Text Placeholder 2", 'type="body" idx="1"', 838200, 1825625, 10515600, 4351338, undefined, "Click to edit Master text styles")
    + phSp(4, "Date Placeholder 3", 'type="dt" sz="half" idx="2"', 838200, 6356350, 2743200, 365125, '<a:bodyPr anchor="ctr"/>')
    + phSp(5, "Footer Placeholder 4", 'type="ftr" sz="quarter" idx="3"', 4038600, 6356350, 4114800, 365125, '<a:bodyPr anchor="ctr"/>')
    + phSp(6, "Slide Number Placeholder 5", 'type="sldNum" sz="quarter" idx="4"', 8610600, 6356350, 2743200, 365125, '<a:bodyPr anchor="ctr"/>')
    + `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/><p:sldLayoutId id="2147483651" r:id="rId3"/><p:sldLayoutId id="2147483652" r:id="rId4"/></p:sldLayoutIdLst>`
    + `<p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${lvlStyle([2800, 2400, 2000, 1800, 1800], true)}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${lvlStyle([1800, 1800, 1800], false)}</p:otherStyle></p:txStyles></p:sldMaster>`;
  const layout = (name: string, type: string, shapes: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${TREE_HEAD}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const lph = (id: number, name: string, ph: string, xf = "") => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr>${xf}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${name.replace(/ \d+$/, "")}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const L1 = layout("Title Slide", "title", lph(2, "Title 1", 'type="ctrTitle"', `<a:xfrm><a:off x="1524000" y="1122363"/><a:ext cx="9144000" cy="2387600"/></a:xfrm>`).replace("<a:bodyPr/><a:lstStyle/>", '<a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr></a:lstStyle>')
    + lph(3, "Subtitle 2", 'type="subTitle" idx="1"', `<a:xfrm><a:off x="1524000" y="3602038"/><a:ext cx="9144000" cy="1655762"/></a:xfrm>`).replace("<a:bodyPr/><a:lstStyle/>", '<a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>'));
  const L2 = layout("Title and Content", "obj", lph(2, "Title 1", 'type="title"') + lph(3, "Content Placeholder 2", 'idx="1"'));
  const L3 = layout("Title Only", "titleOnly", lph(2, "Title 1", 'type="title"'));
  const L4 = layout("Blank", "blank", "");
  const slide = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:spTree>${TREE_HEAD}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Subtitle 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="subTitle" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  const rels = (items: [string, string][]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS.rel}">${items.map(([t, tg], i) => `<Relationship Id="rId${i + 1}" Type="${t}" Target="${tg}"/>`).join("")}</Relationships>`;
  const pres = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:presentation xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${lvlStyle([1800, 1800, 1800], false)}</p:defaultTextStyle></p:presentation>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const LT = "application/vnd.openxmlformats-officedocument.presentationml.";
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/>`
    + `<Override PartName="/ppt/presentation.xml" ContentType="${LT}presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${LT}slideMaster+xml"/>`
    + [1, 2, 3, 4].map((n) => `<Override PartName="/ppt/slideLayouts/slideLayout${n}.xml" ContentType="${LT}slideLayout+xml"/>`).join("")
    + `<Override PartName="/ppt/slides/slide1.xml" ContentType="${LT}slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="${CTYPE.theme}"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const files: { name: string; data: string }[] = [
    { name: "[Content_Types].xml", data: ct },
    { name: "_rels/.rels", data: rels([[RT.officeDocument, "ppt/presentation.xml"], ["http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"], [RTB + "extended-properties", "docProps/app.xml"]]) },
    { name: "docProps/core.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${t}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: "docProps/app.xml", data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Fusion Slides</Application></Properties>` },
    { name: "ppt/presentation.xml", data: pres },
    { name: "ppt/_rels/presentation.xml.rels", data: rels([[RT.slideMaster, "slideMasters/slideMaster1.xml"], [RT.slide, "slides/slide1.xml"], [RT.theme, "theme/theme1.xml"]]) },
    { name: "ppt/slideMasters/slideMaster1.xml", data: master },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([1, 2, 3, 4].map((n) => [RT.slideLayout, `../slideLayouts/slideLayout${n}.xml`] as [string, string]).concat([[RT.theme, "../theme/theme1.xml"]])) },
    ...[L1, L2, L3, L4].flatMap((x, i) => [{ name: `ppt/slideLayouts/slideLayout${i + 1}.xml`, data: x }, { name: `ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`, data: rels([[RT.slideMaster, "../slideMasters/slideMaster1.xml"]]) }]),
    { name: "ppt/slides/slide1.xml", data: slide },
    { name: "ppt/slides/_rels/slide1.xml.rels", data: rels([[RT.slideLayout, "../slideLayouts/slideLayout1.xml"]]) },
    { name: "ppt/theme/theme1.xml", data: DEFAULT_THEME("Fusion") },
  ];
  return writeZip(files);
}

/** plain-text outline of the deck (search index, accessibility, the legacy .fdeck bridge) */
export function deckOutline(d: PptxDoc): { title: string; body: string[]; notes: string }[] {
  return d.slides.map((s, i) => {
    const texts: { ph: string; t: string[] }[] = [];
    const walk = (tree: XEl | undefined) => { for (const k of shapeKids(tree)) { const e = k.name === "mc:AlternateContent" ? altContent(k) : k; if (!e) continue; if (e.name === "p:grpSp") walk(e); else { const tx = txBodyOf(e); if (tx) texts.push({ ph: phOf(e)?.type ?? "", t: paragraphsOf(tx).map((p) => paraText(p).replace(/\v/g, " ")) }); } } };
    walk(spTreeOf(s.xml));
    const ti = texts.findIndex((x) => x.ph === "title" || x.ph === "ctrTitle");
    const title = ti >= 0 ? texts[ti].t.join(" ") : "";
    return { title, body: texts.filter((_, j) => j !== ti).flatMap((x) => x.t).filter((x) => x.trim()), notes: notesText(d, i) };
  });
}
/** build a real .pptx from a plain outline (used to open legacy .fdeck decks and outline imports) */
export async function pptxFromOutline(title: string, slides: { title: string; body: string[]; notes?: string }[]): Promise<Uint8Array> {
  const d = await readPptxDoc(await blankPptx(title), `${title}.pptx`);
  const lays = layoutsOf(d); const tc = lays.find((l) => /title and content/i.test(l.name)) ?? lays[0];
  for (const sl of slides) {
    const i = addSlideFromLayout(d, d.slides.length, tc.path);
    const tree = spTreeOf(d.slides[i].xml);
    shapeKids(tree).forEach((e, k) => { const ph = phOf(e); if (!ph) return; if (ph.type === "title" || ph.type === "ctrTitle") setShapeText(d, i, String(k), [sl.title]); else if (ph.type === "body" || ph.type === "obj") setShapeText(d, i, String(k), sl.body.length ? sl.body : [""]); });
    if (sl.notes) setNotesText(d, i, sl.notes);
  }
  if (slides.length) deleteSlide(d, 0);
  return writePptxDoc(d);
}
export const _internal = { isolate, runsOf, XML_BAD };
export type { XNode };
