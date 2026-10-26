/**
 * TT74 (FF-02): WordprocessingML → Markdown / HTML / plain text, built on the Writer's own reader (wordml.ts), so a
 * conversion sees exactly the document the Writer shows. Client-safe (no node: imports).
 *
 * Display semantics (what Word shows with "No Markup / Final"; ECMA-376 Part 1 §17.13.5):
 *  - inserted text (w:ins, w:moveTo) is shown; deleted text (w:del, w:delText, w:moveFrom) is not;
 *  - a deleted paragraph mark joins the paragraph with the next one (§17.13.5.15);
 *  - a deleted table row is not shown (§17.13.5.14 on w:trPr);
 *  - complex fields show their result, never their code (w:instrText, the runs between begin and separate);
 *    a HYPERLINK field's result becomes a link (§17.16.5.25);
 *  - mc:AlternateContent shows its Fallback (the branch every consumer understands), else its Choice;
 *  - runs with direct w:vanish (hidden text) are not shown.
 * Structure: direct paragraph styles "Heading 1".."Heading 6" (by id or name) become headings; numbered paragraphs become
 * ordered / bullet lists from their numbering level's format; tables keep gridSpan / vMerge as colspan / rowspan;
 * footnotes and endnotes are numbered in order of first reference; text boxes follow the paragraph that anchors them.
 * Not converted (listed by lossFor in convert.ts): headers / footers, comments, page layout, fonts / colours / sizes.
 */
import { parseBlocks, effectivePara, listMarkers, rowsOf, cellsOf, type WordDoc, type Block, type Para, type Inline, type Table, type Rel, type Ctx } from "./wordml";
import { attr, kid, textOf, find, findAll, type XEl, type XNode } from "./xmltree";
import { openZip, fromUtf8 } from "./zipkit";

/* ================================================================ intermediate model */
export interface Span { text: string; b?: boolean; i?: boolean; s?: boolean; sup?: boolean; sub?: boolean; href?: string; note?: { type: "footnote" | "endnote"; n: number }; img?: { alt: string; name: string; mime?: string; data?: Uint8Array } }
export interface PBlock { k: "p"; level?: number; list?: { ordered: boolean; depth: number; marker: string; key: string }; quote?: boolean; spans: Span[] }
export interface TCell { blocks: IBlock[]; colspan: number; rowspan: number }
export interface TBlock { k: "table"; rows: TCell[][] }
export type IBlock = PBlock | TBlock;
export interface INote { type: "footnote" | "endnote"; n: number; blocks: IBlock[] }
export interface IDoc { title: string; blocks: IBlock[]; notes: INote[]; warnings: string[] }

interface Fld { instr: string; sep: boolean; href?: string }
interface Cx { doc: WordDoc; ctx: Ctx; fstack: Fld[]; noteNo: Map<string, number>; next: { footnote: number; endnote: number }; markers: Map<string, { text: string }>; depth: number }

const OFF = new Set(["false", "0", "off", "none"]);
const isOn = (e: XEl | undefined) => !!e && !OFF.has(attr(e, "w:val") ?? "true");
const HEAD = /^heading\s?([1-6])$/i;
const QUOTE = /^(quote|intense\s?quote)$/i;

function headingLevel(doc: WordDoc, p: Para): number | undefined {
  const id = p.p.style; if (!id) return undefined;
  const name = doc.styles.get(id)?.name ?? "";
  const m = HEAD.exec(id) ?? HEAD.exec(name);
  if (m) return Number(m[1]);
  // "Heading" (no number) is the parent heading style of LibreOffice and Apple Pages documents
  return id === "Heading" || name === "Heading" ? 1 : undefined;
}
/** HYPERLINK "url" / HYPERLINK \l "bookmark" (field switches per §17.16.5.25) */
export function hyperlinkOfField(instr: string): string | undefined {
  const m = /^\s*HYPERLINK\s+((?:\\[a-z]\s+(?:"[^"]*"\s+)?)*)(?:"([^"]*)"|(\S+))/i.exec(instr);
  if (!m) return undefined;
  const target = m[2] ?? m[3] ?? "";
  const local = /\\l\s*$/i.test(m[1].trim()) || /(^|\s)\\l(\s|$)/i.test(m[1]);
  return local ? `#${target}` : target;
}

/* ================================================================ raw-XML display walker (opaque tokens) */
function symChar(n: XEl): string {
  const code = parseInt(attr(n, "w:char") ?? "", 16);
  if (!Number.isFinite(code)) return "";
  const c = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code; // Word stores symbol-font characters at F0xx
  const table = SYMBOL_FONT[(attr(n, "w:font") ?? "").toLowerCase()];
  if (table) return table[c] ?? ""; // a code the Symbol encoding leaves undefined has no glyph
  return String.fromCharCode(code); // other symbol fonts (Wingdings…): the private-use code point, which renders with that font
}
/** Symbol font (Adobe Symbol encoding → Unicode, the printable Greek / math range) — the only symbol font with a
 *  standard Unicode mapping; Wingdings glyphs stay as their private-use code points. */
const SYMBOL_GREEK = "ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ"; // 0x41..0x5A
const SYMBOL_greek = "αβχδεφγηιϕκλμνοπθρστυϖωξψζ"; // 0x61..0x7A
const SYMBOL_FONT: Record<string, Record<number, string>> = { symbol: (() => {
  const m: Record<number, string> = { 0x20: " ", 0x21: "!", 0x22: "∀", 0x23: "#", 0x24: "∃", 0x25: "%", 0x26: "&", 0x27: "∋", 0x28: "(", 0x29: ")", 0x2a: "∗", 0x2b: "+", 0x2c: ",", 0x2d: "−", 0x2e: ".", 0x2f: "/",
    0x3a: ":", 0x3b: ";", 0x3c: "<", 0x3d: "=", 0x3e: ">", 0x3f: "?", 0x40: "≅", 0x5b: "[", 0x5c: "∴", 0x5d: "]", 0x5e: "⊥", 0x5f: "_", 0x60: "\uf8e5", 0x7b: "{", 0x7c: "|", 0x7d: "}", 0x7e: "∼",
    0xa1: "ϒ", 0xa2: "′", 0xa3: "≤", 0xa4: "⁄", 0xa5: "∞", 0xa6: "ƒ", 0xa7: "♣", 0xa8: "♦", 0xa9: "♥", 0xaa: "♠", 0xab: "↔", 0xac: "←", 0xad: "↑", 0xae: "→", 0xaf: "↓",
    0xb0: "°", 0xb1: "±", 0xb2: "″", 0xb3: "≥", 0xb4: "×", 0xb5: "∝", 0xb6: "∂", 0xb7: "•", 0xb8: "÷", 0xb9: "≠", 0xba: "≡", 0xbb: "≈", 0xbc: "…",
    0xc4: "⊗", 0xc5: "⊕", 0xc6: "∅", 0xc7: "∩", 0xc8: "∪", 0xc9: "⊃", 0xca: "⊇", 0xcb: "⊄", 0xcc: "⊂", 0xcd: "⊆", 0xce: "∈", 0xcf: "∉", 0xd0: "∠", 0xd1: "∇", 0xd5: "∏", 0xd6: "√", 0xd7: "⋅", 0xd8: "¬", 0xd9: "∧", 0xda: "∨",
    0xdb: "⇔", 0xdc: "⇐", 0xdd: "⇑", 0xde: "⇒", 0xdf: "⇓", 0xe0: "◊", 0xe1: "〈", 0xe5: "∑", 0xf1: "〉", 0xf2: "∫" };
  for (let i = 0; i < 10; i++) m[0x30 + i] = String(i);
  [...SYMBOL_GREEK].forEach((ch, i) => { m[0x41 + i] = ch; });
  [...SYMBOL_greek].forEach((ch, i) => { m[0x61 + i] = ch; });
  return m;
})() };

interface Fmt { b?: boolean; i?: boolean; s?: boolean; sup?: boolean; sub?: boolean; href?: string }
/** bold / italic / strike a character style (w:rStyle, with its basedOn chain) gives a run: Word shows a run in the
 *  "Strong" or "Emphasis" style — or any custom bold character style — as bold / italic (§17.7.2 style hierarchy:
 *  direct formatting overrides the character style). Paragraph-style formatting (headings…) stays implicit. */
function charStyleFmt(doc: WordDoc, id: string | undefined): { b?: boolean; i?: boolean; s?: boolean } {
  const out: { b?: boolean; i?: boolean; s?: boolean } = {};
  const seen = new Set<string>();
  for (let st = id ? doc.styles.get(id) : undefined; st && !seen.has(st.id) && st.type === "character"; st = st.basedOn ? doc.styles.get(st.basedOn) : undefined) {
    seen.add(st.id);
    if (out.b === undefined && st.f.b !== undefined) out.b = st.f.b;
    if (out.i === undefined && st.f.i !== undefined) out.i = st.f.i;
    if (out.s === undefined && st.f.s !== undefined) out.s = st.f.s;
  }
  return out;
}
function fmtOfRPr(doc: WordDoc, rPr: XEl | undefined, base: Fmt): Fmt | null {
  if (!rPr) return base;
  if (isOn(kid(rPr, "w:vanish"))) return null;
  const f: Fmt = { ...base };
  { const cs = charStyleFmt(doc, attr(kid(rPr, "w:rStyle"), "w:val")); if (cs.b !== undefined) f.b = cs.b; if (cs.i !== undefined) f.i = cs.i; if (cs.s !== undefined) f.s = cs.s; }
  const b = kid(rPr, "w:b"); if (b) f.b = isOn(b);
  const i = kid(rPr, "w:i"); if (i) f.i = isOn(i);
  const s = kid(rPr, "w:strike"); if (s) f.s = isOn(s);
  const va = attr(kid(rPr, "w:vertAlign"), "w:val"); if (va === "superscript") f.sup = true; else if (va === "subscript") f.sub = true;
  return f;
}
function pushText(out: Span[], text: string, f: Fmt) { if (text) out.push({ text, ...clean(f) }); }
function clean(f: Fmt): Fmt { const o: Fmt = {}; if (f.b) o.b = true; if (f.i) o.i = true; if (f.s) o.s = true; if (f.sup) o.sup = true; if (f.sub) o.sub = true; if (f.href) o.href = f.href; return o; }
const inCode = (cx: Cx) => cx.fstack.length > 0 && !cx.fstack[cx.fstack.length - 1].sep;
const fieldHref = (cx: Cx) => { for (let k = cx.fstack.length - 1; k >= 0; k--) if (cx.fstack[k].sep && cx.fstack[k].href) return cx.fstack[k].href; return undefined; };

function fldChar(cx: Cx, n: XEl) {
  const ty = attr(n, "w:fldCharType");
  if (ty === "begin") cx.fstack.push({ instr: "", sep: false });
  else if (ty === "separate") { const f = cx.fstack[cx.fstack.length - 1]; if (f) { f.sep = true; f.href = hyperlinkOfField(f.instr); } }
  else if (ty === "end") cx.fstack.pop();
}
/** w:hyperlink target: the relationship target, plus "#anchor" when both are given (§17.16.22: the anchor is a location in the target) */
function linkHref(target: string | undefined, anchor: string | undefined): string | undefined {
  if (target) return anchor && !target.includes("#") ? `${target}#${anchor}` : target;
  return anchor ? `#${anchor}` : undefined;
}
function imageSpan(cx: Cx, rid: string | undefined, alt: string, rels: Map<string, Rel>, holder?: XNode[]): Span | null {
  if (!rid) return null;
  const rel = rels.get(rid); const name = rel ? rel.target.split("/").pop() ?? rid : rid;
  const m = cx.doc.media.get(rid);
  const sp: Span = { text: "", img: { alt, name, mime: m?.mime, data: m?.data } };
  // a picture that is itself a hyperlink: <wp:docPr><a:hlinkClick r:id/></wp:docPr> (DrawingML §20.1.2.2.23)
  for (const h of holder ?? []) if (h.k === "el") { const hl = find(h, (x) => x.name === "a:hlinkClick" && !!attr(x, "r:id")); if (hl) { const t = rels.get(attr(hl, "r:id")!)?.target; if (t) sp.href = t; break; } }
  return sp;
}
/** Walks raw XML the reader kept opaque (revisions it does not edit, content controls, VML, AlternateContent…). */
function walkX(cx: Cx, nodes: XNode[], out: Span[], floats: IBlock[], f: Fmt, rels: Map<string, Rel>) {
  for (const n of nodes) {
    if (n.k !== "el") continue;
    switch (n.name) {
      case "w:t": if (!inCode(cx)) pushText(out, textOf(n), { ...f, href: f.href ?? fieldHref(cx) }); break;
      case "w:tab": case "w:ptab": if (!inCode(cx)) pushText(out, "\t", f); break;
      case "w:cr": if (!inCode(cx)) pushText(out, "\n", f); break;
      case "w:br": { const t = attr(n, "w:type"); if (!inCode(cx) && (!t || t === "textWrapping")) pushText(out, "\n", f); break; }
      case "w:noBreakHyphen": if (!inCode(cx)) pushText(out, "\u2011", f); break;
      case "w:softHyphen": if (!inCode(cx)) pushText(out, "\u00ad", f); break;
      case "w:sym": if (!inCode(cx)) pushText(out, symChar(n), f); break;
      case "w:fldChar": fldChar(cx, n); break;
      case "w:instrText": if (cx.fstack.length) cx.fstack[cx.fstack.length - 1].instr += textOf(n); break;
      case "w:del": case "w:moveFrom": case "w:delText": case "w:delInstrText": case "w:rPr": case "w:pPr": case "w:sdtPr": case "w:sdtEndPr":
      case "w:customXmlPr": case "w:smartTagPr": case "w:fldData": case "w:commentReference": case "w:annotationRef": case "w:footnoteRef": case "w:endnoteRef": break;
      case "w:r": { const g = fmtOfRPr(cx.doc, kid(n, "w:rPr"), f); if (g) walkX(cx, n.kids, out, floats, g, rels); break; }
      case "w:hyperlink": {
        const rid = attr(n, "r:id"); const anchor = attr(n, "w:anchor");
        const href = linkHref(rid ? rels.get(rid)?.target : undefined, anchor);
        walkX(cx, n.kids, out, floats, { ...f, href: href ?? f.href }, rels); break;
      }
      case "w:footnoteReference": case "w:endnoteReference": {
        const type = n.name === "w:footnoteReference" ? "footnote" : "endnote";
        out.push({ text: "", note: { type, n: noteNumber(cx, type, attr(n, "w:id") ?? "") } }); break;
      }
      case "mc:AlternateContent": { const b = kid(n, "mc:Fallback") ?? kid(n, "mc:Choice"); if (b) walkX(cx, b.kids, out, floats, f, rels); break; }
      case "w:txbxContent": floats.push(...convertBlocks(cx, parseBlocks(cx.ctx, n.kids))); break;
      case "w:drawing": {
        const blip = find(n, (x) => x.name === "a:blip"); const dp = find(n, (x) => x.name === "wp:docPr");
        const sp = blip ? imageSpan(cx, attr(blip, "r:embed") ?? attr(blip, "r:link"), (attr(dp, "descr") ?? "").trim() || attr(dp, "title") || attr(dp, "name") || "image", rels, [n]) : null;
        if (sp) out.push(sp);
        for (const tb of findAll(n, (x) => x.name === "w:txbxContent")) floats.push(...convertBlocks(cx, parseBlocks(cx.ctx, tb.kids)));
        break;
      }
      case "v:imagedata": { const sp = imageSpan(cx, attr(n, "r:id"), attr(n, "o:title") ?? "image", rels); if (sp) out.push(sp); break; }
      case "w:ruby": { const base = kid(n, "w:rubyBase"); if (base) walkX(cx, base.kids, out, floats, f, rels); break; } // the w:rt annotation is not body text
      case "m:oMath": case "m:oMathPara": if (!inCode(cx)) pushText(out, findAll(n, (x) => x.name === "m:t").map(textOf).join(""), f); break;
      default: walkX(cx, n.kids, out, floats, f, rels); // w:ins, w:moveTo, w:smartTag, w:customXml, w:sdt(Content), w:fldSimple, w:pict, v:*, w:object, w:dir, w:bdo, w:ruby…
    }
  }
}
function noteNumber(cx: Cx, type: "footnote" | "endnote", id: string): number {
  const key = `${type}:${id}`; let n = cx.noteNo.get(key);
  if (n === undefined) { n = ++cx.next[type]; cx.noteNo.set(key, n); }
  return n;
}

/* ================================================================ model → IR */
function paraSpans(cx: Cx, p: Para, floats: IBlock[]): Span[] {
  const out: Span[] = [];
  const rels = cx.ctx.rels;
  for (const it of p.content) spansOfInline(cx, it, out, floats, rels);
  return out;
}
function spansOfInline(cx: Cx, it: Inline, out: Span[], floats: IBlock[], rels: Map<string, Rel>) {
  if (it.t === "r") {
    if (it.rev?.kind === "del") return;
    if (isOn(kid(it.rPr, "w:vanish"))) return;
    if (inCode(cx)) return;
    const href = it.link ? linkHref(it.link.href, it.link.anchor) : fieldHref(cx);
    const va = it.f.va;
    const cs = charStyleFmt(cx.doc, it.f.rStyle);
    pushText(out, it.text, { b: it.f.b ?? cs.b, i: it.f.i ?? cs.i, s: it.f.s ?? cs.s, sup: va === "superscript", sub: va === "subscript", href });
    return;
  }
  if (it.rev?.kind === "del") return;
  const base: Fmt = it.link ? { href: linkHref(it.link.href, it.link.anchor) } : {};
  switch (it.kind) {
    case "fieldcode": for (const n of it.nodes) if (n.k === "el") { if (n.name === "w:fldChar") fldChar(cx, n); else if (n.name === "w:instrText" && cx.fstack.length) cx.fstack[cx.fstack.length - 1].instr += textOf(n); } return;
    case "bookmark": case "comment": case "commentRef": case "del": case "page": case "column": return;
    case "note": if (it.note) out.push({ text: "", note: { type: it.note.type, n: noteNumber(cx, it.note.type, it.note.id) } }); return;
    case "image": if (it.img) { const sp = imageSpan(cx, it.img.rid, (it.img.descr ?? "").trim() || it.label || "image", rels, it.nodes); if (sp) { if (it.img.data && sp.img) { sp.img.data = it.img.data; sp.img.mime = it.img.mime; } out.push(sp); } }
      for (const n of it.nodes) if (n.k === "el") for (const tb of findAll(n, (x) => x.name === "w:txbxContent")) floats.push(...convertBlocks(cx, parseBlocks(cx.ctx, tb.kids)));
      return;
    case "sym": if (!inCode(cx)) { const n = it.nodes[0]; pushText(out, n && n.k === "el" ? symChar(n) : it.label, fmtOfRPr(cx.doc, it.rPr, base) ?? base); } return;
    default: {
      // ins / field / box / math / other: walk the raw XML; a run-level token's formatting comes from its run
      const f = it.bare ? base : fmtOfRPr(cx.doc, it.rPr, base); if (!f) return;
      walkX(cx, it.nodes, out, floats, f, rels);
    }
  }
}
function convertBlocks(cx: Cx, blocks: Block[]): IBlock[] {
  const out: IBlock[] = [];
  let carry: Span[] = []; // a deleted paragraph mark joins this paragraph's content to the next one
  for (const b of blocks) {
    if (b.t === "p") {
      const floats: IBlock[] = [];
      const spans = [...carry, ...paraSpans(cx, b, floats)]; carry = [];
      if (b.markRev?.kind === "del" && !b.markRev.ins) { carry = spans; out.push(...floats); continue; }
      const pb: PBlock = { k: "p", spans };
      const lv = headingLevel(cx.doc, b); if (lv) pb.level = lv;
      const e = effectivePara(cx.doc, b);
      if (!lv && e.num && e.num.id !== "0") {
        const def = cx.doc.numbering.get(e.num.id);
        const L = def?.lvls[Math.min(8, Math.max(0, e.num.lvl))];
        if (L) pb.list = { ordered: L.fmt !== "bullet" && L.fmt !== "none", depth: Math.min(8, Math.max(0, e.num.lvl)), marker: cx.markers.get(b.id)?.text ?? "", key: def!.abs ? `a${def!.abs}` : e.num.id };
      }
      const sid = b.p.style; if (sid && (QUOTE.test(sid) || QUOTE.test(cx.doc.styles.get(sid)?.name ?? ""))) pb.quote = true;
      out.push(pb, ...floats);
    } else if (b.t === "tbl") out.push(convertTable(cx, b));
    else if (b.t === "box") out.push(...convertBlocks(cx, b.blocks));
    else if (b.t === "x" && b.node.k === "el") {
      const n = b.node;
      if (n.name === "mc:AlternateContent") { const br = kid(n, "mc:Fallback") ?? kid(n, "mc:Choice"); if (br) out.push(...convertBlocks(cx, parseBlocks(cx.ctx, br.kids))); }
      else if (n.name === "w:ins" || n.name === "w:moveTo") out.push(...convertBlocks(cx, parseBlocks(cx.ctx, n.kids)));
      else if (n.name === "w:sdt") { const c = kid(n, "w:sdtContent"); if (c) out.push(...convertBlocks(cx, parseBlocks(cx.ctx, c.kids))); }
    }
  }
  if (carry.length) out.push({ k: "p", spans: carry });
  return out;
}
/** cells / rows wrapped in content controls (w:sdt), custom XML or insertions are unwrapped in place (§17.5.2.29 / .30) */
function wrapped(e: XEl, tag: string, out: XEl[] = []): XEl[] {
  for (const k of e.kids) {
    if (k.k !== "el") continue;
    if (k.name === tag) out.push(k);
    else if (k.name === "w:sdt") { const c = kid(k, "w:sdtContent"); if (c) wrapped(c, tag, out); }
    else if (k.name === "w:customXml" || k.name === "w:ins" || k.name === "w:moveTo") wrapped(k, tag, out);
  }
  return out;
}
interface RawCell { blocks: Block[]; span: number; vmerge?: "restart" | "continue" }
function rawCell(cx: Cx, tc: XEl): RawCell {
  const tcPr = kid(tc, "w:tcPr"); const vm = kid(tcPr, "w:vMerge");
  return { blocks: parseBlocks(cx.ctx, tc.kids.filter((k) => !(k.k === "el" && k.name === "w:tcPr"))), span: Number(attr(kid(tcPr, "w:gridSpan"), "w:val") ?? 1) || 1, vmerge: vm ? (attr(vm, "w:val") === "restart" ? "restart" : "continue") : undefined };
}
const rowDeleted = (tr: XEl) => !!kid(kid(tr, "w:trPr"), "w:del");
function convertTable(cx: Cx, t: Table): TBlock {
  // model rows (as edited in the Writer) and rows the model kept opaque because a content control wraps them
  const rowList: RawCell[][] = [];
  for (const it of t.items) {
    if ((it as { t?: string }).t === "tr") {
      const r = it as import("./wordml").Row;
      if (r.rev?.kind === "del") continue;
      const cells: RawCell[] = [];
      for (const c of r.items) {
        if ((c as { t?: string }).t === "tc") { const m = c as import("./wordml").Cell; cells.push({ blocks: m.blocks, span: m.span, vmerge: m.vmerge }); }
        else if ((c as XNode).k === "el") for (const tc of wrapped({ k: "el", name: "#", attrs: [], quote: [], kids: [c as XNode], selfClose: false } as XEl, "w:tc")) cells.push(rawCell(cx, tc));
      }
      rowList.push(cells);
    } else if ((it as XNode).k === "el") {
      for (const tr of wrapped({ k: "el", name: "#", attrs: [], quote: [], kids: [it as XNode], selfClose: false } as XEl, "w:tr")) {
        if (rowDeleted(tr)) continue;
        rowList.push(wrapped(tr, "w:tc").map((tc) => rawCell(cx, tc)));
      }
    }
  }
  const rows: TCell[][] = [];
  const open = new Map<number, TCell>(); // grid column → the cell a vMerge "continue" extends
  for (const r of rowList) {
    const row: TCell[] = []; let col = 0;
    for (const c of r) {
      const span = Math.max(1, c.span || 1);
      if (c.vmerge === "continue" && open.has(col)) { open.get(col)!.rowspan++; col += span; continue; }
      const cell: TCell = { blocks: convertBlocks(cx, c.blocks), colspan: span, rowspan: 1 };
      if (c.vmerge === "restart") open.set(col, cell); else open.delete(col);
      row.push(cell); col += span;
    }
    rows.push(row);
  }
  return { k: "table", rows };
}

export function wordToIR(doc: WordDoc): IDoc {
  const rels = new Map(doc.rels.map((r) => [r.id, r] as const));
  const ctx: Ctx = { doc, part: doc.docPath, rels, linkSeq: 0, fld: [] };
  const paras: Para[] = []; collectParas(doc.blocks, paras);
  const markers = listMarkers(doc, paras);
  const cx: Cx = { doc, ctx, fstack: [], noteNo: new Map(), next: { footnote: 0, endnote: 0 }, markers, depth: 0 };
  const blocks = convertBlocks(cx, doc.blocks);
  const notes: INote[] = [];
  // notes in order of their numbers; a note referenced from inside a note is numbered when its parent is converted
  for (let pass = 0; pass < 4; pass++) {
    let added = false;
    for (const [key, n] of [...cx.noteNo.entries()].sort((a, b) => a[1] - b[1])) {
      const cut = key.indexOf(":"); const type = key.slice(0, cut) as "footnote" | "endnote", id = key.slice(cut + 1);
      if (notes.some((x) => x.type === type && x.n === n)) continue;
      const note = doc.notes.find((x) => x.type === type && x.id === id);
      cx.fstack = [];
      notes.push({ type, n, blocks: note ? convertBlocks(cx, note.blocks) : [] }); added = true;
    }
    if (!added) break;
  }
  notes.sort((a, b) => (a.type === b.type ? a.n - b.n : a.type === "footnote" ? -1 : 1));
  return { title: doc.title, blocks, notes, warnings: [...doc.warnings] };
}
function collectParas(blocks: Block[], out: Para[]) {
  for (const b of blocks) {
    if (b.t === "p") out.push(b);
    else if (b.t === "tbl") for (const r of rowsOf(b)) for (const c of cellsOf(r)) collectParas(c.blocks, out);
    else if (b.t === "box") collectParas(b.blocks, out);
  }
}

/* ================================================================ text of IR (shared) */
export const spanText = (spans: Span[]) => spans.map((s) => s.text).join("");
/** block texts in reading order (paragraphs; table cells' paragraphs) — what the oracle comparison uses */
export function blockTexts(blocks: IBlock[], out: string[] = []): string[] {
  for (const b of blocks) {
    if (b.k === "p") out.push(spanText(b.spans));
    else for (const r of b.rows) for (const c of r) blockTexts(c.blocks, out);
  }
  return out;
}

/* ================================================================ merge adjacent spans with the same formatting */
const sameFmt = (a: Span, b: Span) => !a.img && !b.img && !a.note && !b.note && !!a.b === !!b.b && !!a.i === !!b.i && !!a.s === !!b.s && !!a.sup === !!b.sup && !!a.sub === !!b.sub && a.href === b.href;
function merged(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) { const l = out[out.length - 1]; if (l && sameFmt(l, s)) out[out.length - 1] = { ...l, text: l.text + s.text }; else out.push({ ...s }); }
  return out;
}

/* ================================================================ link / image safety */
/** Only navigable, non-script URL schemes survive into Markdown / HTML (javascript:, vbscript:, data:, file: are dropped). */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const h = href.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (h.startsWith("#")) return h;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(h)?.[1]?.toLowerCase();
  if (!scheme) return /^[^\\]*$/.test(h) ? h : undefined; // relative reference
  return ["http", "https", "mailto", "ftp", "tel"].includes(scheme) ? h : undefined;
}
const SAFE_IMG = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
function b64(data: Uint8Array): string {
  let s = ""; for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

/* ================================================================ Markdown */
export interface MdOpts { images?: "link" | "embed" | "alt" }
const MD_SPECIAL = /[\\`*_[\]<>|~]/g;
function mdText(t: string): string {
  let s = t.replace(MD_SPECIAL, (c) => `\\${c}`).replace(/\u00ad/g, "");
  s = s.replace(/&(?=[#a-zA-Z0-9]+;)/g, "&amp;");
  return s;
}
/** line-start constructs that would turn a paragraph into a heading / list / quote / code block / rule */
function mdLineStart(line: string): string {
  let s = line.replace(/^[ \t]+/, (ws) => ws.replace(/ /g, "&#32;").replace(/\t/g, "&#9;"));
  s = s.replace(/^(#{1,6})(?=\s|$)/, "\\$1").replace(/^([-+=])(?=\s|$)/, "\\$1").replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2").replace(/^(-{3,}|_{3,}|\*{3,})\s*$/, "\\$1");
  return s;
}
/** consecutive spans with the same link target form ONE link, whatever their formatting (a w:hyperlink holds many runs) */
function linkGroups(spans: Span[]): { href?: string; spans: Span[] }[] {
  const out: { href?: string; spans: Span[] }[] = [];
  for (const s of merged(spans)) {
    const href = s.note ? undefined : safeHref(s.href);
    const last = out[out.length - 1];
    if (last && href && last.href === href) last.spans.push(s); else out.push({ href, spans: [s] });
  }
  return out;
}
function mdSpan(s: Span, o: MdOpts, inTable: boolean): string {
  if (s.note) return `[^${s.note.type === "endnote" ? "e" : ""}${s.note.n}]`;
  if (s.img) {
    const alt = mdText(s.img.alt);
    if (o.images === "alt") return alt ? `[${alt}]` : "";
    if (o.images === "embed" && s.img.data && s.img.mime && SAFE_IMG.has(s.img.mime)) return `![${alt}](data:${s.img.mime};base64,${b64(s.img.data)})`;
    return `![${alt}](${encodeURI(`media/${s.img.name}`)})`;
  }
  let text = s.text;
  if (inTable) text = text.replace(/\n/g, " ");
  const body = text.split("\n").map((l) => mdText(l)).join("\\\n");
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(body)!;
  let core = m[2];
  if (core) {
    if (s.sup) core = `<sup>${core}</sup>`; else if (s.sub) core = `<sub>${core}</sub>`;
    if (s.s) core = `~~${core}~~`;
    if (s.i) core = `*${core}*`;
    if (s.b) core = `**${core}**`;
  }
  return m[1] + core + m[3];
}
function mdInline(spans: Span[], o: MdOpts, inTable = false): string {
  let out = "";
  for (const g of linkGroups(spans)) {
    const inner = g.spans.map((s) => mdSpan(s, o, inTable)).join("");
    if (!g.href) { out += inner; continue; }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
    out += m[2] ? `${m[1]}[${m[2]}](${/[\s()<>]/.test(g.href) ? `<${g.href.replace(/[<>]/g, encodeURIComponent)}>` : g.href})${m[3]}` : inner;
  }
  return out;
}
function mdParagraphBody(spans: Span[], o: MdOpts): string {
  const raw = mdInline(spans, o);
  return raw.split("\n").map((l, i) => (i === 0 || raw.split("\n")[i - 1].endsWith("\\") ? mdLineStart(l) : l)).join("\n");
}
function simpleTable(t: TBlock): boolean {
  return t.rows.length > 0 && t.rows.every((r) => r.every((c) => c.colspan === 1 && c.rowspan === 1 && c.blocks.every((b) => b.k === "p" && !b.list && !b.level))) && new Set(t.rows.map((r) => r.length)).size === 1;
}
function mdBlocks(blocks: IBlock[], o: MdOpts, indent = ""): string {
  const parts: string[] = [];
  const counters = new Map<string, number>();
  let prevList = false;
  for (const b of blocks) {
    if (b.k === "table") {
      prevList = false; counters.clear();
      if (simpleTable(b)) {
        const cell = (c: TCell) => c.blocks.map((x) => mdInline((x as PBlock).spans, o, true).trim()).filter(Boolean).join("<br>") || " ";
        const lines = b.rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
        lines.splice(1, 0, `|${b.rows[0].map(() => " --- ").join("|")}|`);
        parts.push(lines.map((l) => indent + l).join("\n"));
      } else parts.push(indent + htmlTable(b, { images: o.images === "embed" ? "embed" : "alt" }).replace(/\n/g, ""));
      continue;
    }
    const body = mdParagraphBody(b.spans, o);
    if (!body.trim()) continue; // empty paragraphs (numbered or not) carry no content
    if (b.level) { prevList = false; counters.clear(); parts.push(`${indent}${"#".repeat(b.level)} ${body.replace(/\\\n/g, " ")}`); continue; }
    if (b.list) {
      const key = `${b.list.key}:${b.list.depth}`;
      const fromMarker = /(\d+)\D*$/.exec(b.list.marker)?.[1];
      const n = fromMarker !== undefined ? Number(fromMarker) : (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      for (const k of [...counters.keys()]) if (k.startsWith(`${b.list.key}:`) && Number(k.split(":").pop()) > b.list.depth) counters.delete(k);
      const pad = "    ".repeat(b.list.depth);
      const marker = b.list.ordered ? `${n}.` : "-";
      const text = body.replace(/\n/g, `\n${pad}${" ".repeat(marker.length + 1)}`);
      const line = `${indent}${pad}${marker} ${text}`;
      if (prevList) parts[parts.length - 1] += `\n${line}`; else parts.push(line);
      prevList = true; continue;
    }
    prevList = false; counters.clear();
    parts.push(b.quote ? body.split("\n").map((l) => `${indent}> ${l}`).join("\n") : body.split("\n").map((l) => indent + l).join("\n"));
  }
  return parts.join("\n\n");
}
export function irToMarkdown(d: IDoc, o: MdOpts = {}): string {
  let md = mdBlocks(d.blocks, o);
  if (d.notes.length) {
    md += "\n\n" + d.notes.map((n) => {
      const body = mdBlocks(n.blocks, o).split("\n");
      return `[^${n.type === "endnote" ? "e" : ""}${n.n}]: ${body[0] ?? ""}${body.slice(1).map((l) => `\n    ${l}`).join("")}`;
    }).join("\n\n");
  }
  return md.trim() + "\n";
}

/* ================================================================ HTML */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function htmlSpan(s: Span, o: { images?: "embed" | "alt" }): string {
  if (s.note) { const id = `${s.note.type === "endnote" ? "en" : "fn"}${s.note.n}`; return `<sup><a href="#${id}" id="${id}-ref">${s.note.type === "endnote" ? "e" : ""}${s.note.n}</a></sup>`; }
  if (s.img) return o.images !== "alt" && s.img.data && s.img.mime && SAFE_IMG.has(s.img.mime) ? `<img alt="${esc(s.img.alt)}" src="data:${s.img.mime};base64,${b64(s.img.data)}">` : s.img.alt ? `<span class="img-alt">[${esc(s.img.alt)}]</span>` : "";
  let core = esc(s.text.replace(/\u00ad/g, "")).replace(/\n/g, "<br>");
  if (s.sup) core = `<sup>${core}</sup>`; else if (s.sub) core = `<sub>${core}</sub>`;
  if (s.s) core = `<s>${core}</s>`;
  if (s.i) core = `<em>${core}</em>`;
  if (s.b) core = `<strong>${core}</strong>`;
  return core;
}
function htmlInline(spans: Span[], o: { images?: "embed" | "alt" }): string {
  let out = "";
  for (const g of linkGroups(spans)) {
    const inner = g.spans.map((s) => htmlSpan(s, o)).join("");
    out += g.href && inner ? `<a href="${esc(g.href)}"${g.href.startsWith("#") ? "" : ` rel="noopener noreferrer"`}>${inner}</a>` : inner;
  }
  return out;
}
function htmlTable(t: TBlock, o: { images?: "embed" | "alt" }): string {
  return `<table>\n${t.rows.map((r) => `<tr>${r.map((c) => `<td${c.colspan > 1 ? ` colspan="${c.colspan}"` : ""}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ""}>${htmlBlocks(c.blocks, o)}</td>`).join("")}</tr>`).join("\n")}\n</table>`;
}
function htmlBlocks(blocks: IBlock[], o: { images?: "embed" | "alt" }): string {
  let out = "";
  const stack: { tag: "ul" | "ol"; depth: number }[] = [];
  const pop = () => { out += `</li></${stack.pop()!.tag}>`; };
  for (const b of blocks) {
    if (b.k === "p" && b.list) {
      const tag = b.list.ordered ? "ol" : "ul", d = b.list.depth;
      while (stack.length && stack[stack.length - 1].depth > d) pop();
      const top = stack[stack.length - 1];
      const inner = htmlInline(b.spans, o);
      if (!inner.trim()) continue; // an empty numbered paragraph carries no content
      if (top && top.depth === d && top.tag === tag) out += "</li><li>";
      else {
        if (top && top.depth === d) pop();
        // a level-n item with no parent item: open the missing levels (an item may hold a list only inside an item)
        for (let k = (stack.length ? stack[stack.length - 1].depth + 1 : 0); k < d; k++) { stack.push({ tag: "ul", depth: k }); out += "<ul><li>"; }
        stack.push({ tag, depth: d }); out += `<${tag}><li>`;
      }
      out += inner;
      continue;
    }
    while (stack.length) pop();
    if (b.k === "table") { out += htmlTable(b, o) + "\n"; continue; }
    const inner = htmlInline(b.spans, o);
    if (!inner.trim()) continue;
    if (b.level) out += `<h${b.level}>${inner}</h${b.level}>\n`;
    else if (b.quote) out += `<blockquote><p>${inner}</p></blockquote>\n`;
    else out += `<p>${inner}</p>\n`;
  }
  while (stack.length) pop();
  return out;
}
export function irToHtml(d: IDoc, o: { images?: "embed" | "alt"; standalone?: boolean } = {}): string {
  let body = htmlBlocks(d.blocks, o);
  for (const type of ["footnote", "endnote"] as const) {
    const ns = d.notes.filter((n) => n.type === type); if (!ns.length) continue;
    body += `<section class="${type}s"><hr><ol>${ns.map((n) => { const id = `${type === "endnote" ? "en" : "fn"}${n.n}`; return `<li id="${id}">${htmlBlocks(n.blocks, o)} <a href="#${id}-ref" aria-label="back to text">↩</a></li>`; }).join("")}</ol></section>\n`;
  }
  if (o.standalone === false) return body;
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${esc(d.title)}</title><meta name="generator" content="Fusion Writer"></head>\n<body style="max-width:48rem;margin:2rem auto;font-family:system-ui,sans-serif;line-height:1.5">\n${body}</body></html>\n`;
}

/* ================================================================ plain text */
function textBlocks(blocks: IBlock[], lines: string[]) {
  for (const b of blocks) {
    if (b.k === "table") {
      for (const r of b.rows) lines.push(r.map((c) => { const t: string[] = []; textBlocks(c.blocks, t); return t.join(" ").replace(/\s*\n\s*/g, " ").trim(); }).join("\t"));
      continue;
    }
    const text = b.spans.map((s) => (s.note ? `[${s.note.type === "endnote" ? "e" : ""}${s.note.n}]` : s.text)).join("").replace(/\u00ad/g, "");
    lines.push(b.list ? `${"  ".repeat(b.list.depth)}${b.list.marker || (b.list.ordered ? "1." : "•")} ${text}` : text);
  }
}
export function irToText(d: IDoc): string {
  const lines: string[] = []; textBlocks(d.blocks, lines);
  if (d.notes.length) {
    lines.push("", "________________");
    for (const n of d.notes) { const t: string[] = []; textBlocks(n.blocks, t); lines.push(`[${n.type === "endnote" ? "e" : ""}${n.n}] ${t.join("\n")}`); }
  }
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

export function wordToMarkdown(doc: WordDoc, o: MdOpts = {}): string { return irToMarkdown(wordToIR(doc), o); }
export function wordToHtml(doc: WordDoc, o: { images?: "embed" | "alt" } = {}): string { return irToHtml(wordToIR(doc), o); }
export function wordToText(doc: WordDoc): string { return irToText(wordToIR(doc)); }

/** What a Word → Markdown/HTML/text conversion drops, counted from the package (shared by the Forge API and Writer). */
export async function wordConversionLoss(bytes: Uint8Array, to: "md" | "html" | "txt", images: "embed" | "alt" = "embed"): Promise<string[]> {
  const z = openZip(bytes);
  const read = async (p: string) => { try { const b = await z.read(p); return b ? fromUtf8(b) : ""; } catch { return ""; } };
  const doc = await read("word/document.xml");
  const count = (re: RegExp, s = doc) => (s.match(re) ?? []).length;
  const out: string[] = [];
  const add = (n: number, what: string) => { if (n > 0) out.push(`${n} ${what}`); };
  add(count(/<m:oMath[\s>]/g), "equations (dropped; their text is not linear)");
  add(count(/<w:del\b/g) + count(/<w:moveFrom\b/g), "tracked deletions / moves (the converted text shows changes as accepted)");
  add(count(/<w:ins\b/g), "tracked insertions (kept as plain text, revision marks dropped)");
  const comments = await read("word/comments.xml"); add(count(/<w:comment\b/g, comments), "comments (dropped)");
  add(z.entries.filter((e) => /^word\/header\d*\.xml$/.test(e.name)).length, "headers (dropped)");
  add(z.entries.filter((e) => /^word\/footer\d*\.xml$/.test(e.name)).length, "footers (dropped)");
  add(count(/<c:chart\b/g), "charts (dropped)");
  add(count(/<w:object\b/g), "embedded objects (dropped)");
  add(count(/<wps:txbx\b|<v:textbox\b/g), "text boxes (their text follows the anchoring paragraph; position dropped)");
  const pics = count(/<pic:pic\b|<v:imagedata\b/g);
  if (to === "txt") add(pics, "pictures (replaced by their alt text)");
  else if (images === "alt") add(pics, "pictures (replaced by their alt text)");
  else add(pics, "pictures (PNG/JPEG/GIF/WebP/BMP embedded as data: URIs; other formats replaced by their alt text)");
  add(count(/<w:fldChar\b[^>]*w:fldCharType="begin"/g) + count(/<w:fldSimple\b/g), "fields (their current result is kept, the field code dropped)");
  add(count(/<w:sectPr\b/g), "section / page-layout settings (dropped)");
  out.push(to === "txt" ? "all character and paragraph formatting (plain text)" : "fonts, sizes, colours, spacing and alignment (only headings, lists, bold/italic/strike, super/subscript, links, tables, notes are kept)");
  return out;
}
