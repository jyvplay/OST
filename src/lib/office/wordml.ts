/**
 * TT46 — lossless WordprocessingML engine (ECMA-376 Part 1 §17), original code. Isomorphic: runs in the browser so a
 * .docx is opened, edited and saved on-device.
 *
 * Lossless strategy:
 *  - every package part that is not edited is written back byte-for-byte (re-zipped);
 *  - document.xml keeps its root, namespaces, ignorable markup and final sectPr; every body child that is not a
 *    paragraph/table/content-control becomes an opaque node serialized verbatim;
 *  - a paragraph that was not edited re-serializes its original element (xmltree is byte-exact);
 *  - an edited paragraph is regenerated from its runs, but each run keeps its original <w:rPr> and only the properties
 *    the user changed are rewritten (schema order preserved); constructs the editor does not model (bookmarks,
 *    complex-field codes, comment anchors, note references, tracked changes, equations, VML, content controls,
 *    smart tags, symbols…) are carried as opaque inline tokens in document order.
 */
import { attr, clone, el, find, findAll, kid, kids, parseXml, serializeEl, serializeXml, setAttr, textNode, textOf, decText, type XDoc, type XEl, type XNode } from "./xmltree";
import { openZip, writeZip, type ZipArchive } from "./zipkit";

/* ================================================================ model */
export interface RunFmt { b?: boolean; i?: boolean; u?: string; s?: boolean; sz?: number; font?: string; color?: string; hl?: string; va?: "superscript" | "subscript" | "baseline"; caps?: boolean; smallCaps?: boolean; rStyle?: string; shd?: string }
export interface Link { id: number; el: XEl; href?: string; anchor?: string }
export interface TextRun { t: "r"; text: string; f: RunFmt; f0?: RunFmt; rPr?: XEl; link?: Link }
export type TokKind = "image" | "fieldcode" | "field" | "bookmark" | "comment" | "commentRef" | "note" | "ins" | "del" | "page" | "column" | "math" | "sym" | "box" | "other";
export interface Tok {
  t: "k"; kind: TokKind; nodes: XNode[]; bare: boolean; rPr?: XEl; link?: Link; label: string;
  img?: { rid: string; cx: number; cy: number; descr?: string; data?: Uint8Array; mime?: string }; note?: { type: "footnote" | "endnote"; id: string }; cid?: string; mark?: "start" | "end";
}
export type Inline = TextRun | Tok;
export interface ParaProps { style?: string; align?: string; indL?: number; indR?: number; indFirst?: number; before?: number; after?: number; line?: number; lineRule?: string; num?: { id: string; lvl: number } | null; pageBreakBefore?: boolean; keepNext?: boolean; shd?: string }
export interface Para { t: "p"; id: string; p: ParaProps; p0?: ParaProps; pPr?: XEl; content: Inline[]; src?: XEl; dirty?: boolean; sect?: XEl }
export interface Cell { t: "tc"; src?: XEl; span0?: number; tcPr?: XEl; blocks: Block[]; span: number; vmerge?: "restart" | "continue"; width?: number; fill?: string }
export interface Row { t: "tr"; src?: XEl; items: (Cell | XNode)[]; header?: boolean; height?: number }
export interface Table { t: "tbl"; id: string; items: (Row | XNode)[]; grid: number[]; grid0?: string; src?: XEl; borders: boolean; style?: string }
export interface Box { t: "box"; id: string; src: XEl; content: string; blocks: Block[]; label: string }
export interface Opaque { t: "x"; node: XNode; label: string }
export type Block = Para | Table | Box | Opaque;

export interface StyleDef { id: string; name: string; type: string; basedOn?: string; next?: string; p: ParaProps; f: RunFmt; builtIn?: boolean }
export interface LvlDef { start: number; fmt: string; text: string; indL?: number; hanging?: number; font?: string; f: RunFmt }
export interface NumDef { abs: string; lvls: Record<number, LvlDef> }
export interface PageSetup { w: number; h: number; top: number; right: number; bottom: number; left: number; header: number; footer: number; landscape: boolean; headerRid?: string; footerRid?: string; firstHeaderRid?: string; firstFooterRid?: string; titlePg?: boolean; cols?: number }
export interface Comment { id: string; author: string; date?: string; initials?: string; text: string; blocks: Block[] }
export interface Note { id: string; type: "footnote" | "endnote"; blocks: Block[] }
export interface Rel { id: string; type: string; target: string; mode?: string }

export interface WordDoc {
  zip: Map<string, Uint8Array>; order: string[];
  docPath: string; docXml: XDoc; body: XEl;
  blocks: Block[]; finalSect?: XEl; page: PageSetup;
  styles: Map<string, StyleDef>; defaults: { f: RunFmt; p: ParaProps }; stylesXml?: XDoc; stylesPath?: string;
  numbering: Map<string, NumDef>; numXml?: XDoc; numPath?: string;
  rels: Rel[]; relsXml: XDoc; relsPath: string;
  media: Map<string, { data: Uint8Array; mime: string }>; // by rId
  parts: Map<string, Block[]>; // header/footer blocks by rId
  /** TT49: header/footer part XML by rId (re-serialized on save only when edited), edited rIds, rIds created in the editor */
  hf: { xml: Map<string, { path: string; xml: XDoc; rels: Map<string, Rel> }>; dirty: Set<string>; created: Set<string> };
  comments: Comment[]; commentsPath?: string; commentsXml?: XDoc;
  notes: Note[];
  theme: { major: string; minor: string };
  added: { rels: Rel[]; media: { path: string; data: Uint8Array }[]; styles: Set<string>; lists: Map<string, string>; comments: Comment[] };
  title: string; warnings: string[];
}

/* ================================================================ units / helpers */
export const twipToPx = (t: number) => t / 15;
export const emuToPx = (e: number) => e / 9525;
export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RT = { styles: R_NS + "/styles", numbering: R_NS + "/numbering", hyperlink: R_NS + "/hyperlink", image: R_NS + "/image", header: R_NS + "/header", footer: R_NS + "/footer", comments: R_NS + "/comments", footnotes: R_NS + "/footnotes", endnotes: R_NS + "/endnotes", theme: R_NS + "/theme", settings: R_NS + "/settings", officeDocument: R_NS + "/officeDocument" };
const td = new TextDecoder("utf-8", { ignoreBOM: true }), te = new TextEncoder();
const onOff = (e: XEl | undefined): boolean | undefined => { if (!e) return undefined; const v = attr(e, "w:val"); return !(v === "0" || v === "false" || v === "off" || v === "none"); };
const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
let ID = 0;
export const newId = (p = "p") => `${p}${++ID}`;
function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/"); parts.pop();
  for (const seg of target.split("/")) { if (seg === "..") parts.pop(); else if (seg !== ".") parts.push(seg); }
  return parts.join("/");
}
const relsPathOf = (part: string) => { const i = part.lastIndexOf("/"); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; };
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", emf: "image/x-emf", wmf: "image/x-wmf" };

/* ================================================================ property parsing */
export function parseRPr(r: XEl | undefined): RunFmt {
  const f: RunFmt = {};
  if (!r) return f;
  const b = onOff(kid(r, "w:b")); if (b !== undefined) f.b = b;
  const i = onOff(kid(r, "w:i")); if (i !== undefined) f.i = i;
  const s = onOff(kid(r, "w:strike")); if (s !== undefined) f.s = s;
  const caps = onOff(kid(r, "w:caps")); if (caps !== undefined) f.caps = caps;
  const sc = onOff(kid(r, "w:smallCaps")); if (sc !== undefined) f.smallCaps = sc;
  const u = kid(r, "w:u"); if (u) f.u = attr(u, "w:val") ?? "single";
  const sz = num(attr(kid(r, "w:sz"), "w:val")); if (sz !== undefined && isFinite(sz)) f.sz = sz;
  const rf = kid(r, "w:rFonts");
  if (rf) { const nm = attr(rf, "w:ascii") ?? attr(rf, "w:hAnsi") ?? attr(rf, "w:cs") ?? attr(rf, "w:eastAsia"); const th = attr(rf, "w:asciiTheme") ?? attr(rf, "w:hAnsiTheme"); if (nm) f.font = nm; else if (th) f.font = th.startsWith("major") ? "+major" : "+minor"; }
  const c = attr(kid(r, "w:color"), "w:val"); if (c && c !== "auto") f.color = c;
  const hl = attr(kid(r, "w:highlight"), "w:val"); if (hl && hl !== "none") f.hl = hl;
  const va = attr(kid(r, "w:vertAlign"), "w:val"); if (va === "superscript" || va === "subscript" || va === "baseline") f.va = va;
  const rs = attr(kid(r, "w:rStyle"), "w:val"); if (rs) f.rStyle = rs;
  const shd = attr(kid(r, "w:shd"), "w:fill"); if (shd && shd !== "auto") f.shd = shd;
  return f;
}
export function parsePPr(p: XEl | undefined): ParaProps {
  const o: ParaProps = {};
  if (!p) return o;
  const st = attr(kid(p, "w:pStyle"), "w:val"); if (st) o.style = st;
  const jc = attr(kid(p, "w:jc"), "w:val"); if (jc) o.align = jc === "both" || jc === "distribute" ? "justify" : jc === "start" ? "left" : jc === "end" ? "right" : jc;
  const ind = kid(p, "w:ind");
  if (ind) {
    const l = num(attr(ind, "w:left") ?? attr(ind, "w:start")); if (l !== undefined) o.indL = l;
    const r = num(attr(ind, "w:right") ?? attr(ind, "w:end")); if (r !== undefined) o.indR = r;
    const fl = num(attr(ind, "w:firstLine")), hg = num(attr(ind, "w:hanging"));
    if (hg !== undefined) o.indFirst = -hg; else if (fl !== undefined) o.indFirst = fl;
  }
  const sp = kid(p, "w:spacing");
  if (sp) { const b = num(attr(sp, "w:before")), a = num(attr(sp, "w:after")), l = num(attr(sp, "w:line")); if (b !== undefined) o.before = b; if (a !== undefined) o.after = a; if (l !== undefined) { o.line = l; o.lineRule = attr(sp, "w:lineRule") ?? "auto"; } }
  const np = kid(p, "w:numPr");
  if (np) { const id = attr(kid(np, "w:numId"), "w:val"); const lvl = Number(attr(kid(np, "w:ilvl"), "w:val") ?? 0); o.num = id && id !== "0" ? { id, lvl } : null; }
  const pb = onOff(kid(p, "w:pageBreakBefore")); if (pb !== undefined) o.pageBreakBefore = pb;
  const kn = onOff(kid(p, "w:keepNext")); if (kn !== undefined) o.keepNext = kn;
  const shd = attr(kid(p, "w:shd"), "w:fill"); if (shd && shd !== "auto") o.shd = shd;
  return o;
}

/* Schema sequences (ECMA-376 CT_RPr / CT_PPrBase) used to insert regenerated children in valid order. */
const RPR_ORDER = ["w:rStyle", "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:smallCaps", "w:strike", "w:dstrike", "w:outline", "w:shadow", "w:emboss", "w:imprint", "w:noProof", "w:snapToGrid", "w:vanish", "w:webHidden", "w:color", "w:spacing", "w:w", "w:kern", "w:position", "w:sz", "w:szCs", "w:highlight", "w:u", "w:effect", "w:bdr", "w:shd", "w:fitText", "w:vertAlign", "w:rtl", "w:cs", "w:em", "w:lang", "w:eastAsianLayout", "w:specVanish", "w:oMath", "w:rPrChange"];
const PPR_ORDER = ["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl", "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd", "w:tabs", "w:suppressAutoHyphens", "w:kinsoku", "w:wordWrap", "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents", "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange"];
export function put(parent: XEl, order: string[], name: string, node: XEl | null) {
  const at = parent.kids.findIndex((k) => k.k === "el" && k.name === name);
  if (at >= 0) parent.kids.splice(at, 1);
  if (!node) { parent.selfClose = parent.kids.length === 0; return; }
  const rank = order.indexOf(name);
  let ins = parent.kids.length;
  for (let i = 0; i < parent.kids.length; i++) { const k = parent.kids[i]; if (k.k === "el" && order.indexOf(k.name) > rank) { ins = i; break; } }
  parent.kids.splice(at >= 0 ? Math.min(at, ins) : ins, 0, node);
  parent.selfClose = false;
}
const tog = (name: string, v: boolean | undefined) => (v === undefined ? null : v ? el(name) : el(name, { "w:val": "0" }));
export function buildRPr(f: RunFmt, f0: RunFmt | undefined, base: XEl | undefined): XEl | undefined {
  const r = base ? clone(base) : el("w:rPr");
  const o = f0 ?? {};
  const ch = <K extends keyof RunFmt>(k: K) => (f[k] ?? undefined) !== (o[k] ?? undefined);
  if (ch("rStyle")) put(r, RPR_ORDER, "w:rStyle", f.rStyle ? el("w:rStyle", { "w:val": f.rStyle }) : null);
  if (ch("font")) put(r, RPR_ORDER, "w:rFonts", f.font && !f.font.startsWith("+") ? el("w:rFonts", { "w:ascii": f.font, "w:hAnsi": f.font, "w:cs": f.font, "w:eastAsia": f.font }) : null);
  if (ch("b")) { put(r, RPR_ORDER, "w:b", tog("w:b", f.b)); put(r, RPR_ORDER, "w:bCs", tog("w:bCs", f.b)); }
  if (ch("i")) { put(r, RPR_ORDER, "w:i", tog("w:i", f.i)); put(r, RPR_ORDER, "w:iCs", tog("w:iCs", f.i)); }
  if (ch("caps")) put(r, RPR_ORDER, "w:caps", tog("w:caps", f.caps));
  if (ch("smallCaps")) put(r, RPR_ORDER, "w:smallCaps", tog("w:smallCaps", f.smallCaps));
  if (ch("s")) put(r, RPR_ORDER, "w:strike", tog("w:strike", f.s));
  if (ch("color")) put(r, RPR_ORDER, "w:color", f.color ? el("w:color", { "w:val": f.color }) : null);
  if (ch("sz")) { put(r, RPR_ORDER, "w:sz", f.sz ? el("w:sz", { "w:val": String(f.sz) }) : null); put(r, RPR_ORDER, "w:szCs", f.sz ? el("w:szCs", { "w:val": String(f.sz) }) : null); }
  if (ch("hl")) put(r, RPR_ORDER, "w:highlight", f.hl ? el("w:highlight", { "w:val": f.hl }) : null);
  if (ch("u")) put(r, RPR_ORDER, "w:u", f.u ? el("w:u", { "w:val": f.u }) : null);
  if (ch("shd")) put(r, RPR_ORDER, "w:shd", f.shd ? el("w:shd", { "w:val": "clear", "w:color": "auto", "w:fill": f.shd }) : null);
  if (ch("va")) put(r, RPR_ORDER, "w:vertAlign", f.va && f.va !== "baseline" ? el("w:vertAlign", { "w:val": f.va }) : null);
  return r.kids.length ? r : undefined;
}
export function buildPPr(p: ParaProps, p0: ParaProps | undefined, base: XEl | undefined): XEl | undefined {
  const r = base ? clone(base) : el("w:pPr");
  const o = p0 ?? {};
  const ch = <K extends keyof ParaProps>(...ks: K[]) => ks.some((k) => JSON.stringify(p[k] ?? null) !== JSON.stringify(o[k] ?? null));
  if (ch("style")) put(r, PPR_ORDER, "w:pStyle", p.style ? el("w:pStyle", { "w:val": p.style }) : null);
  if (ch("keepNext")) put(r, PPR_ORDER, "w:keepNext", tog("w:keepNext", p.keepNext));
  if (ch("pageBreakBefore")) put(r, PPR_ORDER, "w:pageBreakBefore", tog("w:pageBreakBefore", p.pageBreakBefore));
  if (ch("num")) put(r, PPR_ORDER, "w:numPr", p.num === undefined ? null : el("w:numPr", {}, p.num ? [el("w:ilvl", { "w:val": String(p.num.lvl) }), el("w:numId", { "w:val": p.num.id })] : [el("w:numId", { "w:val": "0" })]));
  if (ch("shd")) put(r, PPR_ORDER, "w:shd", p.shd ? el("w:shd", { "w:val": "clear", "w:color": "auto", "w:fill": p.shd }) : null);
  if (ch("before", "after", "line", "lineRule")) {
    const e = kid(r, "w:spacing") ? clone(kid(r, "w:spacing")!) : el("w:spacing");
    setAttr(e, "w:before", p.before?.toString()); setAttr(e, "w:after", p.after?.toString());
    setAttr(e, "w:line", p.line?.toString()); setAttr(e, "w:lineRule", p.line !== undefined ? p.lineRule ?? "auto" : undefined);
    if (p.before !== undefined) setAttr(e, "w:beforeAutospacing", undefined);
    if (p.after !== undefined) setAttr(e, "w:afterAutospacing", undefined);
    put(r, PPR_ORDER, "w:spacing", e.attrs.length ? e : null);
  }
  if (ch("indL", "indR", "indFirst")) {
    const e = kid(r, "w:ind") ? clone(kid(r, "w:ind")!) : el("w:ind");
    for (const a of ["w:start", "w:end", "w:startChars", "w:endChars", "w:firstLineChars", "w:hangingChars"]) setAttr(e, a, undefined);
    setAttr(e, "w:left", p.indL?.toString()); setAttr(e, "w:right", p.indR?.toString());
    setAttr(e, "w:firstLine", p.indFirst !== undefined && p.indFirst >= 0 ? String(p.indFirst) : undefined);
    setAttr(e, "w:hanging", p.indFirst !== undefined && p.indFirst < 0 ? String(-p.indFirst) : undefined);
    put(r, PPR_ORDER, "w:ind", e.attrs.length ? e : null);
  }
  if (ch("align")) put(r, PPR_ORDER, "w:jc", p.align ? el("w:jc", { "w:val": p.align === "justify" ? "both" : p.align }) : null);
  return r.kids.length ? r : undefined;
}

/* ================================================================ reading */
export interface Ctx { doc: WordDoc; part: string; rels: Map<string, Rel>; linkSeq: number; fld: boolean[] }
function relMap(xml: XDoc | null): Rel[] {
  if (!xml) return [];
  return kids(xml.root, "Relationship").map((r) => ({ id: attr(r, "Id") ?? "", type: attr(r, "Type") ?? "", target: attr(r, "Target") ?? "", mode: attr(r, "TargetMode") }));
}
function tokLabel(n: XEl): string { return textOf(n).replace(/\s+/g, " ").trim(); }

function parseInlines(ctx: Ctx, nodes: XNode[], out: Inline[], link?: Link) {
  for (const n of nodes) {
    if (n.k !== "el") { if (n.k === "raw") out.push({ t: "k", kind: "other", nodes: [n], bare: true, label: "" }); continue; }
    switch (n.name) {
      case "w:r": parseRun(ctx, n, out, link); break;
      case "w:hyperlink": {
        const shell: XEl = { ...n, kids: [] };
        const rid = attr(n, "r:id");
        const lk: Link = { id: ++ctx.linkSeq, el: shell, href: rid ? ctx.rels.get(rid)?.target : undefined, anchor: attr(n, "w:anchor") };
        parseInlines(ctx, n.kids, out, lk);
        break;
      }
      case "w:bookmarkStart": case "w:bookmarkEnd": out.push({ t: "k", kind: "bookmark", nodes: [n], bare: true, label: "", link }); break;
      case "w:commentRangeStart": case "w:commentRangeEnd": out.push({ t: "k", kind: "comment", nodes: [n], bare: true, label: "", cid: attr(n, "w:id"), mark: n.name.endsWith("Start") ? "start" : "end", link }); break;
      case "w:ins": case "w:moveTo": out.push({ t: "k", kind: "ins", nodes: [n], bare: true, label: tokLabel(n), link }); break;
      case "w:del": case "w:moveFrom": out.push({ t: "k", kind: "del", nodes: [n], bare: true, label: findAll(n, (x) => x.name === "w:delText" || x.name === "w:t").map(textOf).join(""), link }); break;
      case "w:fldSimple": out.push({ t: "k", kind: "field", nodes: [n], bare: true, label: tokLabel(n), link }); break;
      case "m:oMath": case "m:oMathPara": out.push({ t: "k", kind: "math", nodes: [n], bare: true, label: tokLabel(n) || "equation", link }); break;
      case "w:sdt": case "w:smartTag": case "w:customXml": case "w:dir": case "w:bdo": out.push({ t: "k", kind: "box", nodes: [n], bare: true, label: tokLabel(n), link }); break;
      case "w:proofErr": case "w:permStart": case "w:permEnd": case "w:moveFromRangeStart": case "w:moveFromRangeEnd": case "w:moveToRangeStart": case "w:moveToRangeEnd":
        out.push({ t: "k", kind: "other", nodes: [n], bare: true, label: "", link }); break;
      default: out.push({ t: "k", kind: "other", nodes: [n], bare: true, label: tokLabel(n), link });
    }
  }
}
function parseRun(ctx: Ctx, r: XEl, out: Inline[], link?: Link) {
  const rPr = kid(r, "w:rPr");
  const f = parseRPr(rPr);
  let buf = "";
  const flush = () => { if (buf) { out.push({ t: "r", text: buf, f: { ...f }, f0: { ...f }, rPr, link }); buf = ""; } };
  const tok = (kind: TokKind, n: XNode, label = "", extra: Partial<Tok> = {}) => { flush(); out.push({ t: "k", kind, nodes: [n], bare: false, rPr, link, label, ...extra }); };
  for (const c of r.kids) {
    if (c.k !== "el") continue;
    if (ctx.fld.some(Boolean) && c.name !== "w:fldChar") { tok("fieldcode", c); continue; }
    switch (c.name) {
      case "w:rPr": break;
      case "w:t": buf += textOf(c); break;
      case "w:tab": buf += "\t"; break;
      case "w:cr": buf += "\n"; break;
      case "w:noBreakHyphen": buf += "\u2011"; break;
      case "w:softHyphen": buf += "\u00ad"; break;
      case "w:br": {
        const ty = attr(c, "w:type");
        if (ty === "page") tok("page", c, "page break"); else if (ty === "column") tok("column", c, "column break");
        else if (!attr(c, "w:clear") || attr(c, "w:clear") === "none") buf += "\n"; else tok("other", c, "");
        break;
      }
      case "w:fldChar": {
        const ty = attr(c, "w:fldCharType");
        if (ty === "begin") ctx.fld.push(true);
        else if (ty === "separate") { if (ctx.fld.length) ctx.fld[ctx.fld.length - 1] = false; }
        else if (ty === "end") ctx.fld.pop();
        tok("fieldcode", c);
        break;
      }
      case "w:instrText": tok("fieldcode", c); break;
      case "w:footnoteReference": case "w:endnoteReference": tok("note", c, "", { note: { type: c.name === "w:footnoteReference" ? "footnote" : "endnote", id: attr(c, "w:id") ?? "" } }); break;
      case "w:commentReference": tok("commentRef", c, "", { cid: attr(c, "w:id") }); break;
      case "w:drawing": {
        const blip = find(c, (x) => x.name === "a:blip");
        const ext = find(c, (x) => x.name === "wp:extent");
        const dp = find(c, (x) => x.name === "wp:docPr");
        const rid = blip ? attr(blip, "r:embed") ?? attr(blip, "r:link") : undefined;
        if (rid) {
          const m = ctx.doc.media.get(rid) ?? loadMediaSync(ctx, rid);
          tok("image", c, attr(dp, "descr") ?? attr(dp, "name") ?? "image", { img: { rid, cx: Number(attr(ext, "cx") ?? 0), cy: Number(attr(ext, "cy") ?? 0), descr: attr(dp, "descr"), data: m?.data, mime: m?.mime } });
        } else tok("other", c, "drawing");
        break;
      }
      case "w:sym": tok("sym", c, String.fromCharCode(parseInt(attr(c, "w:char") ?? "25A1", 16) & 0xffff)); break;
      case "w:lastRenderedPageBreak": break; // layout cache; Word regenerates it
      default: tok("other", c, tokLabel(c));
    }
  }
  flush();
}
function loadMediaSync(ctx: Ctx, rid: string) {
  const rel = ctx.rels.get(rid);
  if (!rel || rel.mode === "External") return undefined;
  const path = resolveTarget(ctx.part, rel.target);
  const data = ctx.doc.zip.get(path);
  if (!data) return undefined;
  const m = { data, mime: MIME[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream" };
  if (ctx.part === ctx.doc.docPath) ctx.doc.media.set(rid, m);
  return m;
}

export function parseBlocks(ctx: Ctx, nodes: XNode[]): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    if (n.k !== "el") { out.push({ t: "x", node: n, label: "" }); continue; }
    if (n.name === "w:p") out.push(parsePara(ctx, n));
    else if (n.name === "w:tbl") out.push(parseTable(ctx, n));
    else if ((n.name === "w:sdt" || n.name === "w:customXml") && (n.name === "w:customXml" || kid(n, "w:sdtContent"))) {
      const content = n.name === "w:sdt" ? "w:sdtContent" : "";
      const host = content ? kid(n, content)! : n;
      out.push({ t: "box", id: newId("b"), src: n, content, blocks: parseBlocks(ctx, host.kids.filter((k) => !(k.k === "el" && k.name === "w:customXmlPr"))), label: attr(find(n, (x) => x.name === "w:alias"), "w:val") ?? "" });
    } else if (n.name === "w:sectPr") out.push({ t: "x", node: n, label: "" });
    else out.push({ t: "x", node: n, label: n.name === "w:bookmarkStart" || n.name === "w:bookmarkEnd" ? "" : tokLabel(n) });
  }
  return out;
}
function parsePara(ctx: Ctx, n: XEl): Para {
  const pPr = kid(n, "w:pPr");
  const p = parsePPr(pPr);
  const content: Inline[] = [];
  parseInlines(ctx, n.kids.filter((k) => !(k.k === "el" && k.name === "w:pPr")), content);
  return { t: "p", id: newId(), p, p0: { ...p }, pPr, content, src: n, sect: kid(pPr, "w:sectPr") };
}
function parseTable(ctx: Ctx, n: XEl): Table {
  const tblPr = kid(n, "w:tblPr");
  const grid = kids(kid(n, "w:tblGrid"), "w:gridCol").map((g) => Number(attr(g, "w:w") ?? 0));
  const b = kid(tblPr, "w:tblBorders");
  const style = attr(kid(tblPr, "w:tblStyle"), "w:val");
  const borders = b ? kids(b).some((x) => attr(x, "w:val") && attr(x, "w:val") !== "nil" && attr(x, "w:val") !== "none") : !!style && /grid|table/i.test(style);
  const items: (Row | XNode)[] = n.kids.map((k) => {
    if (k.k !== "el" || k.name !== "w:tr") return k;
    const trPr = kid(k, "w:trPr");
    const row: Row = { t: "tr", src: k, items: k.kids.map((c) => (c.k === "el" && c.name === "w:tc" ? parseCell(ctx, c) : c)), header: onOff(kid(trPr, "w:tblHeader")) ?? false, height: num(attr(kid(trPr, "w:trHeight"), "w:val")) };
    return row;
  });
  return { t: "tbl", id: newId("t"), items, grid, grid0: grid.join(","), src: n, borders, style };
}
function parseCell(ctx: Ctx, c: XEl): Cell {
  const tcPr = kid(c, "w:tcPr");
  const vm = kid(tcPr, "w:vMerge");
  return {
    t: "tc", src: c, tcPr, span0: Number(attr(kid(tcPr, "w:gridSpan"), "w:val") ?? 1) || 1, span: Number(attr(kid(tcPr, "w:gridSpan"), "w:val") ?? 1) || 1,
    vmerge: vm ? (attr(vm, "w:val") === "restart" ? "restart" : "continue") : undefined,
    width: num(attr(kid(tcPr, "w:tcW"), "w:w")), fill: attr(kid(tcPr, "w:shd"), "w:fill"),
    blocks: parseBlocks(ctx, c.kids.filter((k) => !(k.k === "el" && k.name === "w:tcPr"))),
  };
}
export const rowsOf = (t: Table) => t.items.filter((i): i is Row => (i as Row).t === "tr");
export const cellsOf = (r: Row) => r.items.filter((i): i is Cell => (i as Cell).t === "tc");

function parseStyles(doc: WordDoc, xml: XDoc) {
  const dd = kid(xml.root, "w:docDefaults");
  doc.defaults = { f: parseRPr(kid(kid(dd, "w:rPrDefault"), "w:rPr")), p: parsePPr(kid(kid(dd, "w:pPrDefault"), "w:pPr")) };
  for (const s of kids(xml.root, "w:style")) {
    const id = attr(s, "w:styleId") ?? "";
    doc.styles.set(id, { id, name: attr(kid(s, "w:name"), "w:val") ?? id, type: attr(s, "w:type") ?? "paragraph", basedOn: attr(kid(s, "w:basedOn"), "w:val"), next: attr(kid(s, "w:next"), "w:val"), p: parsePPr(kid(s, "w:pPr")), f: parseRPr(kid(s, "w:rPr")), builtIn: attr(s, "w:customStyle") !== "1" });
  }
}
function parseNumbering(doc: WordDoc, xml: XDoc) {
  const abs = new Map<string, Record<number, LvlDef>>();
  for (const a of kids(xml.root, "w:abstractNum")) {
    const lv: Record<number, LvlDef> = {};
    for (const l of kids(a, "w:lvl")) {
      const ind = kid(kid(l, "w:pPr"), "w:ind");
      const rPr = kid(l, "w:rPr");
      lv[Number(attr(l, "w:ilvl") ?? 0)] = { start: Number(attr(kid(l, "w:start"), "w:val") ?? 1), fmt: attr(kid(l, "w:numFmt"), "w:val") ?? "decimal", text: attr(kid(l, "w:lvlText"), "w:val") ?? "", indL: num(attr(ind, "w:left") ?? attr(ind, "w:start")), hanging: num(attr(ind, "w:hanging")), font: attr(kid(rPr, "w:rFonts"), "w:ascii"), f: parseRPr(rPr) };
    }
    abs.set(attr(a, "w:abstractNumId") ?? "", lv);
  }
  for (const nm of kids(xml.root, "w:num")) {
    const a = attr(kid(nm, "w:abstractNumId"), "w:val") ?? "";
    const lvls: Record<number, LvlDef> = {};
    for (const [k, v] of Object.entries(abs.get(a) ?? {})) lvls[Number(k)] = { ...v };
    for (const o of kids(nm, "w:lvlOverride")) { const il = Number(attr(o, "w:ilvl") ?? 0); const so = attr(kid(o, "w:startOverride"), "w:val"); if (so && lvls[il]) lvls[il].start = Number(so); }
    doc.numbering.set(attr(nm, "w:numId") ?? "", { abs: a, lvls });
  }
}
export function parseSect(s: XEl | undefined): PageSetup {
  const pg = kid(s, "w:pgSz"), m = kid(s, "w:pgMar");
  const ref = (name: string, ty: string) => attr(kids(s, name).find((h) => (attr(h, "w:type") ?? "default") === ty), "r:id");
  return {
    w: num(attr(pg, "w:w")) ?? 12240, h: num(attr(pg, "w:h")) ?? 15840, landscape: attr(pg, "w:orient") === "landscape",
    top: Math.abs(num(attr(m, "w:top")) ?? 1440), right: num(attr(m, "w:right")) ?? 1440, bottom: Math.abs(num(attr(m, "w:bottom")) ?? 1440), left: num(attr(m, "w:left")) ?? 1440,
    header: num(attr(m, "w:header")) ?? 720, footer: num(attr(m, "w:footer")) ?? 720,
    headerRid: ref("w:headerReference", "default"), footerRid: ref("w:footerReference", "default"), firstHeaderRid: ref("w:headerReference", "first"), firstFooterRid: ref("w:footerReference", "first"),
    titlePg: onOff(kid(s, "w:titlePg")) ?? false, cols: Number(attr(kid(s, "w:cols"), "w:num") ?? 1),
  };
}

const MAX_INPUT = 64 * 1024 * 1024;
export async function readWord(bytes: Uint8Array, name = "Document.docx"): Promise<WordDoc> {
  if (bytes.length > MAX_INPUT) throw new Error("docx: file exceeds the 64 MiB guard");
  const z: ZipArchive = openZip(bytes);
  const zip = new Map<string, Uint8Array>();
  const order: string[] = [];
  for (const e of z.entries) { if (e.name.endsWith("/")) continue; const d = await z.read(e.name); if (d) { zip.set(e.name, d); order.push(e.name); } }
  const text = (p: string) => { const d = zip.get(p); return d ? td.decode(d) : null; };
  const rootRels = relMap(text("_rels/.rels") ? parseXml(text("_rels/.rels")!) : null);
  const main = rootRels.find((r) => r.type === RT.officeDocument || r.type.endsWith("/officeDocument"));
  const docPath = main ? resolveTarget("", main.target) : "word/document.xml";
  const docSrc = text(docPath);
  if (!docSrc) throw new Error("docx: main document part not found (is this a Word document?)");
  const docXml = parseXml(docSrc);
  const body = kid(docXml.root, "w:body");
  if (!body) throw new Error("docx: document has no <w:body>");
  const relsPath = relsPathOf(docPath);
  const relsXml = parseXml(text(relsPath) ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  const rels = relMap(relsXml);
  const doc: WordDoc = {
    zip, order, docPath, docXml, body, blocks: [], page: parseSect(undefined), styles: new Map(), defaults: { f: {}, p: {} }, numbering: new Map(),
    rels, relsXml, relsPath, media: new Map(), parts: new Map(), hf: { xml: new Map(), dirty: new Set(), created: new Set() }, comments: [], notes: [], theme: { major: "Calibri Light", minor: "Calibri" },
    added: { rels: [], media: [], styles: new Set(), lists: new Map(), comments: [] }, title: name.replace(/\.[^.]+$/, ""), warnings: [],
  };
  const relById = new Map(rels.map((r) => [r.id, r]));
  const partOf = (type: string) => { const r = rels.find((x) => x.type === type); return r ? resolveTarget(docPath, r.target) : undefined; };
  const sp = partOf(RT.styles); if (sp && text(sp)) { doc.stylesPath = sp; doc.stylesXml = parseXml(text(sp)!); parseStyles(doc, doc.stylesXml); }
  const np = partOf(RT.numbering); if (np && text(np)) { doc.numPath = np; doc.numXml = parseXml(text(np)!); parseNumbering(doc, doc.numXml); }
  const tp = partOf(RT.theme);
  if (tp && text(tp)) { const th = parseXml(text(tp)!); const maj = find(th.root, (x) => x.name === "a:majorFont"), min = find(th.root, (x) => x.name === "a:minorFont"); doc.theme = { major: attr(kid(maj, "a:latin"), "typeface") || "Calibri Light", minor: attr(kid(min, "a:latin"), "typeface") || "Calibri" }; }
  const ctx: Ctx = { doc, part: docPath, rels: relById, linkSeq: 0, fld: [] };
  doc.blocks = parseBlocks(ctx, body.kids);
  doc.finalSect = kid(body, "w:sectPr");
  doc.page = parseSect(doc.finalSect);
  // headers / footers (rendered on pages; preserved verbatim)
  for (const r of rels) if (r.type === RT.header || r.type === RT.footer) {
    const p = resolveTarget(docPath, r.target); const s = text(p); if (!s) continue;
    try { const x = parseXml(s); const pr = new Map(relMap(text(relsPathOf(p)) ? parseXml(text(relsPathOf(p))!) : null).map((q) => [q.id, q])); doc.parts.set(r.id, parseBlocks({ doc, part: p, rels: pr, linkSeq: 1000, fld: [] }, x.root.kids)); doc.hf.xml.set(r.id, { path: p, xml: x, rels: pr }); } catch (e) { doc.warnings.push(`header/footer ${p}: ${(e as Error).message}`); }
  }
  for (const [type, kind] of [[RT.footnotes, "footnote"], [RT.endnotes, "endnote"]] as const) {
    const p = partOf(type); const s = p && text(p); if (!s) continue;
    const x = parseXml(s);
    for (const n of kids(x.root, `w:${kind}`)) { const t = attr(n, "w:type"); if (t === "separator" || t === "continuationSeparator" || t === "continuationNotice") continue; doc.notes.push({ id: attr(n, "w:id") ?? "", type: kind, blocks: parseBlocks({ doc, part: p!, rels: relById, linkSeq: 2000, fld: [] }, n.kids) }); }
  }
  const cp = partOf(RT.comments);
  if (cp && text(cp)) {
    doc.commentsPath = cp; doc.commentsXml = parseXml(text(cp)!);
    for (const c of kids(doc.commentsXml.root, "w:comment")) doc.comments.push({ id: attr(c, "w:id") ?? "", author: attr(c, "w:author") ?? "", date: attr(c, "w:date"), initials: attr(c, "w:initials"), text: kids(c, "w:p").map(textOf).join("\n"), blocks: parseBlocks({ doc, part: cp, rels: relById, linkSeq: 3000, fld: [] }, c.kids) });
  }
  const core = text("docProps/core.xml");
  if (core) { const t = /<dc:title>([^<]*)<\/dc:title>/.exec(core); if (t && t[1].trim()) doc.title = decText(t[1]); }
  return doc;
}

/* ================================================================ style resolution (rendering) */
export function styleChain(doc: WordDoc, id: string | undefined): StyleDef[] {
  const out: StyleDef[] = []; const seen = new Set<string>();
  let s = id ? doc.styles.get(id) : undefined;
  while (s && !seen.has(s.id)) { out.unshift(s); seen.add(s.id); s = s.basedOn ? doc.styles.get(s.basedOn) : undefined; }
  return out;
}
export const defaultParaStyle = (doc: WordDoc) => [...doc.styles.values()].find((s) => s.type === "paragraph" && (s.id === "Normal" || s.name.toLowerCase() === "normal"))?.id;
export function effectivePara(doc: WordDoc, p: Para): ParaProps {
  const o: ParaProps = { ...doc.defaults.p };
  for (const s of styleChain(doc, p.p.style ?? defaultParaStyle(doc))) Object.assign(o, strip(s.p));
  Object.assign(o, strip(p.p));
  return o;
}
export function effectiveRun(doc: WordDoc, p: Para | undefined, f: RunFmt): RunFmt {
  const o: RunFmt = { ...doc.defaults.f };
  if (p) for (const s of styleChain(doc, p.p.style ?? defaultParaStyle(doc))) Object.assign(o, strip(s.f));
  if (f.rStyle) for (const s of styleChain(doc, f.rStyle)) Object.assign(o, strip(s.f));
  Object.assign(o, strip(f));
  if (o.font === "+major") o.font = doc.theme.major; else if (!o.font || o.font === "+minor") o.font = doc.theme.minor;
  return o;
}
function strip<T extends object>(o: T): Partial<T> { const r: Partial<T> = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) (r as Record<string, unknown>)[k] = v; return r; }

const ROMAN: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
export function fmtNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "lowerLetter": case "upperLetter": { let s = ""; let k = n; if (k <= 0) return String(n); const ch = String.fromCharCode(97 + ((k - 1) % 26)); s = ch.repeat(Math.floor((k - 1) / 26) + 1); return fmt === "upperLetter" ? s.toUpperCase() : s; }
    case "lowerRoman": case "upperRoman": { let k = n, s = ""; for (const [v, r] of ROMAN) while (k >= v) { s += r; k -= v; } return fmt === "upperRoman" ? s.toUpperCase() : s; }
    case "decimalZero": return n < 10 ? `0${n}` : String(n);
    case "ordinal": return `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
    case "none": return "";
    default: return String(n);
  }
}
const BULLET_MAP: Record<string, string> = { "\uf0b7": "•", "\uf0a7": "▪", "\uf0d8": "➢", "\uf076": "❖", "\uf0fc": "✓", "\uf0a8": "□", o: "◦", "\uf06f": "◦", "\uf0e0": "➔" };
/** Computes list markers for every numbered paragraph in document order (counters per numId, reset of deeper levels). */
export function listMarkers(doc: WordDoc, paras: Para[]): Map<string, { text: string; indL?: number; hanging?: number; f: RunFmt }> {
  const out = new Map<string, { text: string; indL?: number; hanging?: number; f: RunFmt }>();
  const counters = new Map<string, number[]>();
  for (const p of paras) {
    const e = effectivePara(doc, p);
    if (!e.num) continue;
    const def = doc.numbering.get(e.num.id) ?? builtinList(e.num.id);
    if (!def) continue;
    const lvl = Math.min(8, Math.max(0, e.num.lvl));
    const L = def.lvls[lvl]; if (!L) continue;
    const key = def.abs ? `a${def.abs}:${e.num.id}` : e.num.id;
    const c = counters.get(key) ?? Array.from({ length: 9 }, (_, k) => (def.lvls[k]?.start ?? 1) - 1);
    c[lvl]++;
    for (let k = lvl + 1; k < 9; k++) c[k] = (def.lvls[k]?.start ?? 1) - 1;
    counters.set(key, c);
    let text: string;
    if (L.fmt === "bullet") text = [...L.text].map((ch) => BULLET_MAP[ch] ?? (ch.charCodeAt(0) >= 0xf000 ? "•" : ch)).join("") || "•";
    else text = L.text.replace(/%(\d)/g, (_, d: string) => { const k = Number(d) - 1; return fmtNumber(Math.max(c[k], def.lvls[k]?.start ?? 1), def.lvls[k]?.fmt ?? "decimal"); });
    out.set(p.id, { text, indL: L.indL, hanging: L.hanging, f: L.f });
  }
  return out;
}
/** Lists created in the editor use reserved ids "~bullet" / "~decimal" until save assigns real numIds. */
export function builtinList(id: string): NumDef | undefined {
  if (id !== "~bullet" && id !== "~decimal") return undefined;
  const lvls: Record<number, LvlDef> = {};
  const bullets = ["\uf0b7", "o", "\uf0a7"];
  const fmts = ["decimal", "lowerLetter", "lowerRoman"];
  for (let k = 0; k < 9; k++) lvls[k] = id === "~bullet" ? { start: 1, fmt: "bullet", text: bullets[k % 3], indL: 720 * (k + 1), hanging: 360, f: {} } : { start: 1, fmt: fmts[k % 3], text: `%${k + 1}.`, indL: 720 * (k + 1), hanging: 360, f: {} };
  return { abs: "", lvls };
}

/* ================================================================ text helpers */
export const inlineText = (i: Inline): string => (i.t === "r" ? i.text : i.kind === "fieldcode" || i.kind === "bookmark" || i.kind === "comment" || i.kind === "other" || i.kind === "del" ? "" : i.kind === "page" || i.kind === "column" ? "\n" : i.label);
export const paraText = (p: Para) => p.content.map(inlineText).join("");
export function allParas(blocks: Block[], out: Para[] = []): Para[] {
  for (const b of blocks) {
    if (b.t === "p") out.push(b);
    else if (b.t === "tbl") for (const r of rowsOf(b)) for (const c of cellsOf(r)) allParas(c.blocks, out);
    else if (b.t === "box") allParas(b.blocks, out);
  }
  return out;
}
export const docText = (d: WordDoc) => allParas(d.blocks).map(paraText).join("\n");

/* ================================================================ writing */
function serializeInlines(content: Inline[]): XNode[] {
  const out: XNode[] = [];
  let i = 0;
  while (i < content.length) {
    const lk = content[i].link;
    if (lk) {
      const group: Inline[] = [];
      while (i < content.length && content[i].link === lk) group.push(content[i++]);
      const h = clone(lk.el); h.kids = serializeInlines(group.map((g) => ({ ...g, link: undefined }))); h.selfClose = false;
      out.push(h);
      continue;
    }
    const it = content[i++];
    if (it.t === "k") {
      if (it.bare) out.push(...it.nodes);
      else out.push(el("w:r", {}, [...(it.rPr ? [it.rPr] : []), ...it.nodes]));
      continue;
    }
    if (!it.text) continue;
    const rPr = buildRPr(it.f, it.f0, it.rPr);
    const kidsOut: XNode[] = rPr ? [rPr] : [];
    let buf = "";
    const flushT = () => { if (buf) { kidsOut.push(el("w:t", /^\s|\s$/.test(buf) ? { "xml:space": "preserve" } : {}, [textNode(buf)])); buf = ""; } };
    for (const ch of it.text) {
      if (ch === "\t") { flushT(); kidsOut.push(el("w:tab")); }
      else if (ch === "\n") { flushT(); kidsOut.push(el("w:br")); }
      else if (ch === "\u2011") { flushT(); kidsOut.push(el("w:noBreakHyphen")); }
      else if (ch === "\u00ad") { flushT(); kidsOut.push(el("w:softHyphen")); }
      else buf += ch;
    }
    flushT();
    out.push(el("w:r", {}, kidsOut));
  }
  return out;
}
export function serializePara(p: Para): XEl {
  if (!p.dirty && p.src) return p.src;
  const base = p.src ? clone(p.src) : el("w:p");
  const pPr = buildPPr(p.p, p.p0, p.pPr);
  base.kids = [...(pPr ? [pPr] : []), ...serializeInlines(p.content)];
  base.selfClose = base.kids.length === 0;
  return base;
}
function serializeCell(c: Cell): XEl {
  const blocks = serializeBlocks(c.blocks);
  if (!blocks.some((b) => b.k === "el" && b.name === "w:p")) blocks.push(el("w:p")); // §17.4.66: a cell must end with a paragraph
  let tcPr: XEl | undefined = c.tcPr;
  if (c.span !== (c.span0 ?? 1) || !c.src) {
    tcPr = c.tcPr ? clone(c.tcPr) : el("w:tcPr");
    const at = tcPr.kids.findIndex((k) => k.k === "el" && k.name === "w:gridSpan");
    if (c.span > 1) { const g = el("w:gridSpan", { "w:val": String(c.span) }); if (at >= 0) tcPr.kids[at] = g; else tcPr.kids.splice(kid(tcPr, "w:tcW") ? tcPr.kids.indexOf(kid(tcPr, "w:tcW")!) + 1 : 0, 0, g); tcPr.selfClose = false; }
    else if (at >= 0) tcPr.kids.splice(at, 1);
    if (!tcPr.kids.length && !c.tcPr) tcPr = undefined;
  }
  // tcPr goes back where it was (after any leading whitespace the source had)
  const pos = c.src && c.tcPr ? c.src.kids.indexOf(c.tcPr) : 0;
  const out = blocks.slice();
  if (tcPr) out.splice(Math.max(0, Math.min(pos, out.length)), 0, tcPr);
  if (c.src) return { ...clone({ ...c.src, kids: [] }), kids: out, selfClose: false };
  return el("w:tc", {}, out);
}
function serializeTable(t: Table): XEl {
  const base = t.src ? clone(t.src) : el("w:tbl");
  base.kids = t.items.map((it) => {
    if ((it as Row).t === "tr") {
      const r = it as Row;
      const kidsOut = r.items.map((c) => ((c as Cell).t === "tc" ? serializeCell(c as Cell) : (c as XNode)));
      return r.src ? { ...clone({ ...r.src, kids: [] }), kids: kidsOut, selfClose: false } : el("w:tr", {}, kidsOut);
    }
    const n = it as XNode;
    if (n.k === "el" && n.name === "w:tblGrid" && t.grid.join(",") !== t.grid0) return el("w:tblGrid", {}, t.grid.map((g) => el("w:gridCol", { "w:w": String(Math.round(g)) })));
    return n;
  });
  base.selfClose = false;
  return base;
}
export function serializeBlocks(blocks: Block[]): XNode[] {
  return blocks.map((b) => {
    if (b.t === "p") return serializePara(b);
    if (b.t === "tbl") return serializeTable(b);
    if (b.t === "box") {
      const s = clone(b.src);
      const host = b.content ? kid(s, b.content)! : s;
      const keep = host.kids.filter((k) => k.k === "el" && k.name === "w:customXmlPr");
      host.kids = [...keep, ...serializeBlocks(b.blocks)]; host.selfClose = false;
      return s;
    }
    return b.node;
  });
}

/* Built-in style definitions added on save when the editor applied a style the document lacks. */
const BUILTIN_STYLES: Record<string, string> = {
  Normal: `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>`,
  Title: `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>`,
  Subtitle: `<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="5A5A5A"/><w:spacing w:val="15"/><w:sz w:val="28"/></w:rPr></w:style>`,
  Heading1: `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>`,
  Heading2: `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>`,
  Heading3: `<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="1F3763"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>`,
  Quote: `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="200"/><w:ind w:left="864" w:right="864"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>`,
  ListParagraph: `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>`,
  Code: `<w:style w:type="paragraph" w:customStyle="1" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>`,
  Header: `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/></w:tabs><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>`,
  Footer: `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/></w:tabs><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>`,
  Hyperlink: `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1" w:themeColor="hyperlink"/><w:u w:val="single"/></w:rPr></w:style>`,
};
export const BUILTIN_STYLE_IDS = Object.keys(BUILTIN_STYLES);
/** Registers a built-in style for rendering and marks it to be written if the document lacks it. */
export function ensureStyle(doc: WordDoc, id: string) {
  if (doc.styles.has(id) || !BUILTIN_STYLES[id]) return;
  const x = parseXml(BUILTIN_STYLES[id].replace("<w:style ", `<w:style xmlns:w="${W}" `)).root;
  doc.styles.set(id, { id, name: attr(kid(x, "w:name"), "w:val") ?? id, type: attr(x, "w:type") ?? "paragraph", basedOn: attr(kid(x, "w:basedOn"), "w:val"), next: attr(kid(x, "w:next"), "w:val"), p: parsePPr(kid(x, "w:pPr")), f: parseRPr(kid(x, "w:rPr")), builtIn: true });
  doc.added.styles.add(id);
  if (id !== "Normal" && !doc.styles.has("Normal") && !defaultParaStyle(doc)) ensureStyle(doc, "Normal");
}

function nextRid(doc: WordDoc): string {
  const used = new Set([...doc.rels, ...doc.added.rels].map((r) => r.id));
  let n = used.size + 1; while (used.has(`rId${n}`)) n++;
  return `rId${n}`;
}
export function addRel(doc: WordDoc, type: string, target: string, external = false): string {
  const hit = [...doc.rels, ...doc.added.rels].find((r) => r.type === type && r.target === target && (r.mode === "External") === external);
  if (hit) return hit.id;
  const id = nextRid(doc);
  const r: Rel = { id, type, target, mode: external ? "External" : undefined };
  doc.added.rels.push(r); doc.rels.push(r);
  return id;
}
export const REL_TYPES = RT;

/** Builds the hyperlink shell element for a URL (external) or a bookmark (#anchor). */
export function makeLink(doc: WordDoc, target: string): Link {
  if (target.startsWith("#")) return { id: Math.floor(Math.random() * 1e9), el: el("w:hyperlink", { "w:anchor": target.slice(1), "w:history": "1" }), anchor: target.slice(1) };
  const rid = addRel(doc, RT.hyperlink, target, true);
  return { id: Math.floor(Math.random() * 1e9), el: el("w:hyperlink", { "r:id": rid, "w:history": "1" }), href: target };
}
/** Creates an inline picture token (DrawingML wp:inline, ECMA-376 §20.4.2.8) with a new media part. */
export function makeImage(doc: WordDoc, data: Uint8Array, mime: string, wPx: number, hPx: number, descr = "Picture"): Tok {
  const ext = mime === "image/png" ? "png" : mime === "image/gif" ? "gif" : mime === "image/svg+xml" ? "svg" : "jpeg";
  let k = 1; const dir = doc.docPath.replace(/[^/]+$/, "");
  while (doc.zip.has(`${dir}media/image${k}.${ext}`) || doc.added.media.some((m) => m.path === `${dir}media/image${k}.${ext}`)) k++;
  const path = `${dir}media/image${k}.${ext}`;
  doc.added.media.push({ path, data });
  const rid = addRel(doc, RT.image, `media/image${k}.${ext}`);
  doc.media.set(rid, { data, mime });
  const cx = Math.round(wPx * 9525), cy = Math.round(hPx * 9525);
  const id = 1000 + doc.added.media.length;
  const xml = `<w:drawing xmlns:w="${W}"><wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="Picture ${id}" descr="${descr.replace(/[<>&"]/g, "")}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${id}" name="image${k}.${ext}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}" xmlns:r="${R_NS}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  const node = parseXml(xml).root;
  node.attrs = []; node.quote = []; // namespace already declared on the document root
  return { t: "k", kind: "image", nodes: [node], bare: false, label: descr, img: { rid, cx, cy, descr, data, mime } };
}
/** Resizes an image token in place (wp:extent + a:ext). */
export function resizeImage(t: Tok, wPx: number, hPx: number) {
  if (!t.img) return;
  const cx = Math.round(wPx * 9525), cy = Math.round(hPx * 9525);
  t.nodes = t.nodes.map((n) => clone(n));
  for (const n of t.nodes) if (n.k === "el") for (const e of findAll(n, (x) => x.name === "wp:extent" || (x.name === "a:ext" && !!attr(x, "cx")))) { setAttr(e, "cx", String(cx)); setAttr(e, "cy", String(cy)); }
  t.img = { ...t.img, cx, cy };
}

function ensureContentType(ct: XDoc, kind: "Default" | "Override", key: string, value: string) {
  const a = kind === "Default" ? "Extension" : "PartName";
  if (kids(ct.root, kind).some((e) => (attr(e, a) ?? "").toLowerCase() === key.toLowerCase())) return;
  ct.root.kids.push(el(kind, { [a]: key, ContentType: value })); ct.root.selfClose = false;
}

export async function writeWord(doc: WordDoc): Promise<Uint8Array> {
  const out = new Map(doc.zip);
  const order = doc.order.slice();
  const setPart = (p: string, data: Uint8Array) => { if (!out.has(p)) order.push(p); out.set(p, data); };
  const ctSrc = out.get("[Content_Types].xml");
  const ct = parseXml(ctSrc ? td.decode(ctSrc) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`);
  let ctDirty = false;
  // resolve editor list ids (~bullet / ~decimal) to real numbering definitions
  const usesList = new Set<string>();
  for (const p of allParas(doc.blocks)) if (p.p.num && p.p.num.id.startsWith("~")) usesList.add(p.p.num.id);
  if (usesList.size) {
    if (!doc.numXml) {
      doc.numPath = doc.docPath.replace(/[^/]+$/, "") + "numbering.xml";
      doc.numXml = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}"></w:numbering>`);
      addRel(doc, RT.numbering, "numbering.xml");
      ensureContentType(ct, "Override", "/" + doc.numPath, "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"); ctDirty = true;
    }
    const root = doc.numXml.root;
    const ids = (tag: string, a: string) => kids(root, tag).map((e) => Number(attr(e, a) ?? 0));
    for (const key of usesList) {
      if (doc.added.lists.has(key)) continue;
      const absId = Math.max(-1, ...ids("w:abstractNum", "w:abstractNumId")) + 1, numId = Math.max(0, ...ids("w:num", "w:numId")) + 1;
      const def = builtinList(key)!;
      const lvls = Object.entries(def.lvls).map(([k, L]) => `<w:lvl w:ilvl="${k}"><w:start w:val="1"/><w:numFmt w:val="${L.fmt}"/><w:lvlText w:val="${L.text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${L.indL}" w:hanging="${L.hanging}"/></w:pPr>${L.fmt === "bullet" ? `<w:rPr><w:rFonts w:ascii="${L.text === "o" ? "Courier New" : L.text === "\uf0a7" ? "Wingdings" : "Symbol"}" w:hAnsi="${L.text === "o" ? "Courier New" : L.text === "\uf0a7" ? "Wingdings" : "Symbol"}" w:hint="default"/></w:rPr>` : ""}</w:lvl>`).join("");
      const absEl = parseXml(`<w:abstractNum xmlns:w="${W}" w:abstractNumId="${absId}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`).root;
      absEl.attrs = absEl.attrs.filter((a) => a[0] !== "xmlns:w"); absEl.quote = absEl.attrs.map(() => '"');
      const firstNum = root.kids.findIndex((k) => k.k === "el" && k.name === "w:num");
      root.kids.splice(firstNum >= 0 ? firstNum : root.kids.length, 0, absEl);
      root.kids.push(el("w:num", { "w:numId": String(numId) }, [el("w:abstractNumId", { "w:val": String(absId) })]));
      root.selfClose = false;
      doc.added.lists.set(key, String(numId));
    }
  }
  const remapLists = (blocks: Block[]) => { for (const p of allParas(blocks)) if (p.p.num && p.p.num.id.startsWith("~")) { p.p = { ...p.p, num: { id: doc.added.lists.get(p.p.num.id)!, lvl: p.p.num.lvl } }; p.dirty = true; } };
  remapLists(doc.blocks);
  if (doc.numXml && doc.numPath && doc.added.lists.size) setPart(doc.numPath, te.encode(serializeXml(doc.numXml)));
  // styles
  if (doc.added.styles.size) {
    if (!doc.stylesXml) {
      doc.stylesPath = doc.docPath.replace(/[^/]+$/, "") + "styles.xml";
      doc.stylesXml = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="minorHAnsi" w:cstheme="minorBidi"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults></w:styles>`);
      addRel(doc, RT.styles, "styles.xml");
    }
    // [Content_Types] is re-read from the original on every save, so a part created by an earlier save needs its Override again
    if (!doc.zip.has(doc.stylesPath!)) { ensureContentType(ct, "Override", "/" + doc.stylesPath, "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"); ctDirty = true; }
    const have = new Set(kids(doc.stylesXml.root, "w:style").map((s) => attr(s, "w:styleId")));
    for (const id of doc.added.styles) if (!have.has(id) && BUILTIN_STYLES[id]) { const x = parseXml(BUILTIN_STYLES[id].replace("<w:style ", `<w:style xmlns:w="${W}" `)).root; x.attrs = x.attrs.filter((a) => a[0] !== "xmlns:w"); x.quote = x.attrs.map(() => '"'); x.ws = undefined; doc.stylesXml.root.kids.push(x); }
    setPart(doc.stylesPath!, te.encode(serializeXml(doc.stylesXml)));
  }
  // comments added in the editor
  if (doc.added.comments.length) {
    if (!doc.commentsXml) {
      doc.commentsPath = doc.docPath.replace(/[^/]+$/, "") + "comments.xml";
      doc.commentsXml = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W}"></w:comments>`);
      addRel(doc, RT.comments, "comments.xml");
    }
    if (!doc.zip.has(doc.commentsPath!)) { ensureContentType(ct, "Override", "/" + doc.commentsPath, "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"); ctDirty = true; }
    const root = doc.commentsXml.root;
    const have = new Set(kids(root, "w:comment").map((c) => attr(c, "w:id")));
    for (const c of doc.added.comments) if (!have.has(c.id)) {
      root.kids.push(el("w:comment", { "w:id": c.id, "w:author": c.author, "w:date": c.date, "w:initials": c.initials }, c.text.split("\n").map((line) => el("w:p", {}, [el("w:r", {}, [el("w:t", { "xml:space": "preserve" }, [textNode(line)])])]))));
      root.selfClose = false;
    }
    setPart(doc.commentsPath!, te.encode(serializeXml(doc.commentsXml)));
  }
  // TT49: edited / created header and footer parts (untouched parts keep their original bytes)
  // a part created in the editor is always written — undo may have dropped it from doc.parts, but its relationship
  // (added by addRel) stays, and a relationship to a missing part makes the package unreadable (python-docx KeyError)
  for (const rid of new Set([...doc.hf.dirty, ...doc.hf.created])) {
    const h = doc.hf.xml.get(rid); if (!h) continue;
    const blocks = doc.parts.get(rid) ?? (doc.hf.created.has(rid) ? parseBlocks({ doc, part: h.path, rels: h.rels, linkSeq: 0, fld: [] }, [el("w:p")]) : undefined);
    if (!blocks) continue;
    const keep = h.xml.root.kids; h.xml.root.kids = serializeBlocks(blocks); h.xml.root.selfClose = false;
    setPart(h.path, te.encode(serializeXml(h.xml))); h.xml.root.kids = keep;
    if (doc.hf.created.has(rid)) { ensureContentType(ct, "Override", "/" + h.path, `application/vnd.openxmlformats-officedocument.wordprocessingml.${h.xml.root.name === "w:ftr" ? "footer" : "header"}+xml`); ctDirty = true; }
  }
  // media
  for (const m of doc.added.media) {
    setPart(m.path, m.data);
    const ext = m.path.split(".").pop()!;
    ensureContentType(ct, "Default", ext, MIME[ext] ?? "application/octet-stream"); ctDirty = true;
  }
  // relationships
  if (doc.added.rels.length) {
    const have = new Set(kids(doc.relsXml.root, "Relationship").map((r) => attr(r, "Id")));
    for (const r of doc.added.rels) if (!have.has(r.id)) { doc.relsXml.root.kids.push(el("Relationship", { Id: r.id, Type: r.type, Target: r.target, TargetMode: r.mode })); doc.relsXml.root.selfClose = false; }
    setPart(doc.relsPath, te.encode(serializeXml(doc.relsXml)));
  }
  // main document
  const body = doc.body;
  const before = body.kids;
  body.kids = serializeBlocks(doc.blocks);
  if (doc.finalSect && !body.kids.includes(doc.finalSect)) body.kids.push(doc.finalSect);
  body.selfClose = false;
  const docBytes = te.encode(serializeXml(doc.docXml));
  body.kids = before;
  setPart(doc.docPath, docBytes);
  if (ctDirty) setPart("[Content_Types].xml", te.encode(serializeXml(ct)));
  // core properties: bump dcterms:modified when present (Word does the same)
  const core = out.get("docProps/core.xml");
  if (core) {
    const s = td.decode(core);
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const t = s.replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${now}$2`);
    if (t !== s) out.set("docProps/core.xml", te.encode(t));
  }
  const files = ["[Content_Types].xml", ...order.filter((p) => p !== "[Content_Types].xml")].filter((p) => out.has(p)).map((p) => ({ name: p, data: out.get(p)! }));
  return writeZip(files);
}

/** A blank, valid package (Word 2016+ conventions) used for "New document". */
export async function blankWord(title = "Untitled"): Promise<WordDoc> {
  const ns = `xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:r="${R_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"`;
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId1" Type="${RT.officeDocument}" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RT.styles}" Target="styles.xml"/><Relationship Id="rId2" Type="${RT.settings}" Target="settings.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${ns}><w:body><w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${BUILTIN_STYLES.Normal.replace(/<w:pPr>.*?<\/w:pPr><w:rPr>.*?<\/w:rPr>/, "")}<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style></w:styles>`,
    "word/settings.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="${W}"><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${title.replace(/[<>&]/g, "")}</dc:title><dc:creator>Fusion Writer</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Fusion Writer</Application></Properties>`,
  };
  const zipped = await writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
  return readWord(zipped, `${title}.docx`);
}
export { serializeEl };

/** Parses inline XML (e.g. the children of an accepted <w:ins>) into editor inlines. */
export function parseInlineNodes(doc: WordDoc, nodes: XNode[]): Inline[] {
  const out: Inline[] = [];
  parseInlines({ doc, part: doc.docPath, rels: new Map(doc.rels.map((r) => [r.id, r])), linkSeq: 5000 + Math.floor(Math.random() * 1e6), fld: [] }, nodes, out);
  return out;
}
