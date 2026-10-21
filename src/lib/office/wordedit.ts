/**
 * TT46 — editing operations over the WordprocessingML model (pure, DOM-free, unit-tested in Node; driven by Writer.tsx).
 * Positions are (paragraph id, offset) where a text run counts its UTF-16 length and every opaque token counts 1.
 * Every operation marks the paragraphs it touches `dirty`, so untouched paragraphs keep serializing byte-for-byte.
 */
import { allParas, cellsOf, ensureStyle, makeLink, newId, parseInlineNodes, rowsOf, styleChain, type Block, type Cell, type Inline, type Para, type ParaProps, type Rev, type Row, type RunFmt, type Table, type TextRun, type Tok, type WordDoc, inlineText, BUILTIN_STYLE_IDS, defaultParaStyle, effectiveRun } from "./wordml";
import { el, kid, kids, type XEl } from "./xmltree";
import { sameRev } from "./wordml";

export interface Pos { pid: string; off: number }
export interface Range { a: Pos; b: Pos }
export const ilen = (i: Inline) => (i.t === "r" ? i.text.length : 1);
export const plen = (p: Para) => p.content.reduce((s, i) => s + ilen(i), 0);

/* ---------------------------------------------------------------- location */
export interface Where { list: Block[]; index: number; para: Para; cell?: Cell; row?: Row; table?: Table; tableList?: Block[]; tableIndex?: number }
export function locate(doc: WordDoc, pid: string): Where | null {
  const walk = (list: Block[], ctx: Partial<Where>): Where | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.t === "p" && b.id === pid) return { ...ctx, list, index: i, para: b } as Where;
      if (b.t === "tbl") for (const r of rowsOf(b)) for (const c of cellsOf(r)) { const w = walk(c.blocks, { cell: c, row: r, table: b, tableList: list, tableIndex: i }); if (w) return w; }
      if (b.t === "box") { const w = walk(b.blocks, ctx); if (w) return w; }
    }
    return null;
  };
  return walk(doc.blocks, {});
}
export const paraById = (doc: WordDoc, pid: string) => locate(doc, pid)?.para;
/** Document order of all paragraphs (ids) — used to order selection endpoints. */
export function order(doc: WordDoc): Map<string, number> { const m = new Map<string, number>(); allParas(doc.blocks).forEach((p, i) => m.set(p.id, i)); return m; }
export function normRange(doc: WordDoc, r: Range): Range {
  const o = order(doc); const ia = o.get(r.a.pid) ?? 0, ib = o.get(r.b.pid) ?? 0;
  return ia < ib || (ia === ib && r.a.off <= r.b.off) ? r : { a: r.b, b: r.a };
}
export function parasIn(doc: WordDoc, r: Range): Para[] {
  const all = allParas(doc.blocks); const o = order(doc);
  return all.slice(o.get(r.a.pid) ?? 0, (o.get(r.b.pid) ?? 0) + 1);
}

/** Splits so that a run boundary exists at `off`; returns the index of the first inline at/after `off`. */
export function splitAt(p: Para, off: number): number {
  let acc = 0;
  for (let i = 0; i < p.content.length; i++) {
    const it = p.content[i], n = ilen(it);
    if (off === acc) return i;
    if (off < acc + n && it.t === "r") {
      const k = off - acc;
      const a: TextRun = { ...it, text: it.text.slice(0, k), f: { ...it.f } }, b: TextRun = { ...it, text: it.text.slice(k), f: { ...it.f } };
      p.content.splice(i, 1, a, b);
      return i + 1;
    }
    acc += n;
  }
  return p.content.length;
}
function touch(p: Para) { p.dirty = true; }
/** Merges adjacent text runs with identical formatting/source rPr/link (keeps the model compact after edits). */
export function normalize(p: Para) {
  const out: Inline[] = [];
  for (const it of p.content) {
    const prev = out[out.length - 1];
    if (it.t === "r" && !it.text) continue;
    if (it.t === "r" && prev && prev.t === "r" && prev.link === it.link && prev.rPr === it.rPr && sameRev(prev.rev, it.rev) && sameRev(prev.rev?.ins, it.rev?.ins) && JSON.stringify(prev.f) === JSON.stringify(it.f) && JSON.stringify(prev.f0 ?? {}) === JSON.stringify(it.f0 ?? {})) { out[out.length - 1] = { ...prev, text: prev.text + it.text }; continue; }
    out.push(it);
  }
  p.content = out;
}

/* ---------------------------------------------------------------- text */
/** Run whose formatting new text at `off` should inherit (the preceding text run, else the following one). */
export function runAt(p: Para, off: number): TextRun | undefined {
  let acc = 0; let prev: TextRun | undefined;
  for (const it of p.content) {
    const n = ilen(it);
    if (it.t === "r" && acc < off && off <= acc + n) return it;
    if (it.t === "r") { if (acc + n <= off) prev = it; else if (!prev && acc >= off) return it; }
    acc += n;
  }
  return prev;
}
export function insertText(doc: WordDoc, pos: Pos, text: string, fmt?: Partial<RunFmt>): Pos {
  const p = paraById(doc, pos.pid); if (!p || !text) return pos;
  const base = runAt(p, pos.off);
  const i = splitAt(p, pos.off);
  const f = { ...(base?.f ?? {}), ...(fmt ?? {}) };
  for (const k of Object.keys(f) as (keyof RunFmt)[]) if (f[k] === undefined || f[k] === null) delete f[k];
  const prev = p.content[i - 1];
  // TT56: under Track Changes the text is an insertion — it extends the author's insertion it touches, else starts a new one
  const rev: Rev | undefined = doc.track?.on ? (prev && prev.rev?.kind === "ins" && isMine(doc, prev.rev) ? prev.rev : newRev(doc, "ins")) : undefined;
  if (!fmt && prev && prev.t === "r" && prev === base && prev.rev === rev) prev.text += text;
  else p.content.splice(i, 0, { t: "r", text, f, f0: base?.f0 ?? {}, rPr: base?.rPr, link: base && base.link && (prev === base || i === 0) ? base.link : undefined, ...(rev ? { rev } : {}) });
  normalize(p); touch(p);
  return { pid: p.id, off: pos.off + text.length };
}
/** Deletes [a, b). Paragraphs in the same container are merged; across containers each paragraph is trimmed. */
export function deleteRange(doc: WordDoc, r0: Range): Pos {
  const r = normRange(doc, r0);
  const wa = locate(doc, r.a.pid), wb = locate(doc, r.b.pid);
  if (!wa || !wb) return r.a;
  if (doc.track?.on) return trackedDelete(doc, r);
  const cut = (p: Para, from: number, to: number) => { const i = splitAt(p, from); const j = splitAt(p, to); p.content.splice(i, j - i); normalize(p); touch(p); };
  if (wa.para === wb.para) { cut(wa.para, r.a.off, r.b.off); return r.a; }
  if (wa.list === wb.list) {
    cut(wa.para, r.a.off, plen(wa.para));
    cut(wb.para, 0, r.b.off);
    wa.para.content.push(...wb.para.content);
    if (wb.para.sect && !wa.para.sect) { wa.para.sect = wb.para.sect; wa.para.pPr = wb.para.pPr; }
    wa.para.markRev = wb.para.markRev; // the surviving paragraph mark is the last one

    wa.list.splice(wa.index + 1, wb.index - wa.index);
    normalize(wa.para); touch(wa.para);
    return r.a;
  }
  for (const p of parasIn(doc, r)) {
    if (p === wa.para) cut(p, r.a.off, plen(p)); else if (p === wb.para) cut(p, 0, r.b.off); else cut(p, 0, plen(p));
  }
  return r.a;
}
export function textInRange(doc: WordDoc, r0: Range): string {
  const r = normRange(doc, r0);
  return parasIn(doc, r).map((p) => {
    const from = p.id === r.a.pid ? r.a.off : 0, to = p.id === r.b.pid ? r.b.off : plen(p);
    let acc = 0, s = "";
    for (const it of p.content) { const n = ilen(it); const lo = Math.max(from, acc), hi = Math.min(to, acc + n); if (hi > lo) s += it.t === "r" ? it.text.slice(lo - acc, hi - acc) : inlineText(it); acc += n; }
    return s;
  }).join("\n");
}
/** Splits the paragraph at `pos` (Enter). The new paragraph keeps the properties; at the end of a heading it gets the style's `next`. */
export function splitParagraph(doc: WordDoc, pos: Pos): Pos {
  const w = locate(doc, pos.pid); if (!w) return pos;
  const p = w.para;
  const i = splitAt(p, pos.off);
  const tail = p.content.splice(i);
  const atEnd = tail.every((t) => ilen(t) === 0 || (t.t === "k" && (t.kind === "bookmark" || t.kind === "comment" || t.kind === "other")));
  const np: Para = { t: "p", id: newId(), p: { ...p.p }, p0: p.p0 ? { ...p.p0 } : undefined, pPr: p.pPr, content: tail, dirty: true, sect: p.sect };
  // the section break (if any) belongs to the paragraph mark, which moves with the second half
  if (p.sect && p.pPr) { const c = { ...p.pPr, kids: p.pPr.kids.filter((k) => !(k.k === "el" && k.name === "w:sectPr")) }; p.pPr = c; p.sect = undefined; }
  if (atEnd && p.p.style) { const st = doc.styles.get(p.p.style); if (st?.next && st.next !== p.p.style) np.p.style = st.next === defaultParaStyle(doc) ? undefined : st.next; }
  if (atEnd && p.p.num && plen(p) === 0) { /* Enter on an empty list item ends the list (Word behaviour) */ p.p = { ...p.p, num: null }; np.content = []; touch(p); return { pid: p.id, off: 0 }; }
  // TT56: the original paragraph mark moves with the second half; the first half ends in the new mark (tracked → inserted)
  np.markRev = p.markRev;
  p.markRev = doc.track?.on ? newRev(doc, "ins") : undefined;
  touch(p);
  w.list.splice(w.index + 1, 0, np);
  return { pid: np.id, off: 0 };
}
/** Backspace at offset 0: merges with the previous paragraph in the same container (or removes list/indent first). */
export function joinBackward(doc: WordDoc, pid: string): Pos | null {
  const w = locate(doc, pid); if (!w) return null;
  if (w.para.p.num) { w.para.p = { ...w.para.p, num: null }; touch(w.para); return { pid, off: 0 }; }
  let k = w.index - 1;
  while (k >= 0 && w.list[k].t === "x" && (w.list[k] as { label: string }).label === "") k--;
  const prev = w.list[k];
  if (!prev || prev.t !== "p") return null;
  const off = plen(prev);
  // TT56: under Track Changes the previous paragraph mark is marked deleted (its own pending insertion really goes)
  if (doc.track?.on && !(prev.markRev?.kind === "ins" && isMine(doc, prev.markRev))) {
    if (!prev.markRev) { prev.markRev = newRev(doc, "del"); touch(prev); }
    return { pid: prev.id, off };
  }
  prev.markRev = w.para.markRev;
  prev.content.push(...w.para.content);
  if (w.para.sect) { prev.sect = w.para.sect; prev.pPr = w.para.pPr; prev.p = { ...w.para.p, style: prev.p.style }; }
  w.list.splice(w.index, 1);
  normalize(prev); touch(prev);
  return { pid: prev.id, off };
}

/* ---------------------------------------------------------------- formatting */
export function applyFmt(doc: WordDoc, r0: Range, patch: Partial<Record<keyof RunFmt, unknown>>) {
  const r = normRange(doc, r0);
  for (const p of parasIn(doc, r)) {
    const from = p.id === r.a.pid ? r.a.off : 0, to = p.id === r.b.pid ? r.b.off : plen(p);
    if (to <= from) continue;
    const i = splitAt(p, from), j = splitAt(p, to);
    for (let k = i; k < j; k++) {
      const it = p.content[k];
      if (it.t !== "r") continue;
      const f = { ...it.f } as Record<string, unknown>;
      for (const [key, v] of Object.entries(patch)) { if (v === null || v === undefined) delete f[key]; else f[key] = v; }
      p.content[k] = { ...it, f: f as RunFmt };
    }
    normalize(p); touch(p);
  }
}
/** Effective formatting at a range start (for toolbar state); `mixed` keys differ across the range. */
export function fmtAt(doc: WordDoc, r0: Range): RunFmt & { mixed: Set<string> } {
  const r = normRange(doc, r0);
  const mixed = new Set<string>();
  let first: RunFmt | undefined;
  for (const p of parasIn(doc, r)) {
    const from = p.id === r.a.pid ? r.a.off : 0, to = p.id === r.b.pid ? r.b.off : plen(p);
    let acc = 0;
    const consider = (f: RunFmt) => { const e = effectiveRun(doc, p, f); if (!first) first = e; else for (const k of ["b", "i", "u", "s", "sz", "font", "color", "hl", "va"] as const) if ((e[k] ?? null) !== (first[k] ?? null)) mixed.add(k); };
    if (from === to) { const run = runAt(p, from); consider(run?.f ?? {}); continue; }
    for (const it of p.content) { const n = ilen(it); if (it.t === "r" && acc + n > from && acc < to) consider(it.f); acc += n; }
  }
  return { ...(first ?? effectiveRun(doc, undefined, {})), mixed };
}
export function setParaProps(doc: WordDoc, r: Range, patch: Partial<ParaProps>) {
  for (const p of parasIn(doc, normRange(doc, r))) { p.p = { ...p.p, ...patch }; for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (p.p as Record<string, unknown>)[k]; touch(p); }
}
export function setStyle(doc: WordDoc, r: Range, styleId: string) {
  ensureStyle(doc, styleId);
  const def = defaultParaStyle(doc);
  setParaProps(doc, r, { style: styleId === def ? undefined : styleId });
}
export function listKind(doc: WordDoc, p: Para): "bullet" | "number" | null {
  const n = p.p.num ?? (p.p.num === null ? null : styleChain(doc, p.p.style).reverse().find((s) => s.p.num)?.p.num);
  if (!n) return null;
  const def = doc.numbering.get(n.id);
  if (n.id === "~bullet" || def?.lvls[n.lvl]?.fmt === "bullet") return "bullet";
  return "number";
}
export function toggleList(doc: WordDoc, r: Range, kind: "bullet" | "number") {
  const ps = parasIn(doc, normRange(doc, r));
  const allOn = ps.every((p) => listKind(doc, p) === kind);
  // continue an adjacent list of the same kind instead of starting a new one
  const all = allParas(doc.blocks); const at = all.indexOf(ps[0]);
  const neighbour = at > 0 && listKind(doc, all[at - 1]) === kind ? all[at - 1].p.num : undefined;
  const id = neighbour?.id ?? (kind === "bullet" ? "~bullet" : "~decimal");
  for (const p of ps) { p.p = { ...p.p, num: allOn ? null : { id, lvl: p.p.num?.lvl ?? 0 } }; touch(p); }
}
export function indent(doc: WordDoc, r: Range, dir: 1 | -1) {
  for (const p of parasIn(doc, normRange(doc, r))) {
    if (p.p.num) p.p = { ...p.p, num: { ...p.p.num, lvl: Math.max(0, Math.min(8, p.p.num.lvl + dir)) } };
    else p.p = { ...p.p, indL: Math.max(0, (p.p.indL ?? 0) + dir * 720) };
    touch(p);
  }
}

/* ---------------------------------------------------------------- links, breaks, images, comments */
export function setLink(doc: WordDoc, r0: Range, target: string | null) {
  const r = normRange(doc, r0);
  const link = target ? makeLink(doc, target) : undefined;
  if (link) ensureStyle(doc, "Hyperlink");
  for (const p of parasIn(doc, r)) {
    const from = p.id === r.a.pid ? r.a.off : 0, to = p.id === r.b.pid ? r.b.off : plen(p);
    if (to <= from) continue;
    const i = splitAt(p, from), j = splitAt(p, to);
    for (let k = i; k < j; k++) { const it = p.content[k]; p.content[k] = it.t === "r" ? { ...it, link, f: link ? { ...it.f, rStyle: doc.styles.has("Hyperlink") ? "Hyperlink" : it.f.rStyle } : { ...it.f, rStyle: it.f.rStyle === "Hyperlink" ? undefined : it.f.rStyle } } : { ...it, link }; }
    normalize(p); touch(p);
  }
}
export function insertToken(doc: WordDoc, pos: Pos, tok: Tok): Pos {
  const p = paraById(doc, pos.pid); if (!p) return pos;
  const i = splitAt(p, pos.off);
  const base = runAt(p, pos.off);
  // TT56: a run-level object (picture, break, symbol) inserted under Track Changes is an insertion like text
  p.content.splice(i, 0, tok.bare ? tok : { ...tok, rPr: tok.rPr ?? base?.rPr, ...(doc.track?.on ? { rev: newRev(doc, "ins") } : {}) });
  touch(p);
  return { pid: p.id, off: pos.off + 1 };
}
export function insertPageBreak(doc: WordDoc, pos: Pos): Pos {
  const after = insertToken(doc, pos, { t: "k", kind: "page", nodes: [el("w:br", { "w:type": "page" })], bare: false, label: "page break" });
  return splitParagraph(doc, after);
}
export function addComment(doc: WordDoc, r0: Range, text: string, author: string): string {
  const r = normRange(doc, r0);
  const ids = [...doc.comments.map((c) => Number(c.id)), ...doc.added.comments.map((c) => Number(c.id))].filter((n) => isFinite(n));
  const id = String(ids.length ? Math.max(...ids) + 1 : 0);
  const initials = author.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 4).toUpperCase();
  const c = { id, author, initials, date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), text, blocks: [] };
  doc.added.comments.push(c); doc.comments.push(c);
  // end first so the start offset stays valid when both are in one paragraph
  const pe = paraById(doc, r.b.pid)!;
  let k = splitAt(pe, r.b.off);
  pe.content.splice(k, 0, { t: "k", kind: "comment", nodes: [el("w:commentRangeEnd", { "w:id": id })], bare: true, label: "", cid: id, mark: "end" },
    { t: "k", kind: "commentRef", nodes: [el("w:commentReference", { "w:id": id })], bare: false, rPr: el("w:rPr", {}, [el("w:rStyle", { "w:val": "CommentReference" })]), label: "", cid: id });
  touch(pe);
  const ps = paraById(doc, r.a.pid)!;
  k = splitAt(ps, r.a.off);
  ps.content.splice(k, 0, { t: "k", kind: "comment", nodes: [el("w:commentRangeStart", { "w:id": id })], bare: true, label: "", cid: id, mark: "start" });
  touch(ps);
  return id;
}

/* ---------------------------------------------------------------- tracked changes */
function delToIns(nodes: XEl[]): XEl[] {
  // rejecting a deletion restores its runs: <w:delText> → <w:t>, <w:delInstrText> → <w:instrText>
  const conv = (e: XEl): XEl => ({ ...e, name: e.name === "w:delText" ? "w:t" : e.name === "w:delInstrText" ? "w:instrText" : e.name, kids: e.kids.map((k) => (k.k === "el" ? conv(k) : k)) });
  return nodes.map(conv);
}
export function trackedChanges(doc: WordDoc): { pid: string; kind: "ins" | "del"; author?: string; date?: string; text: string }[] {
  return revisions(doc).map((c) => ({ pid: c.pid, kind: c.kind, author: c.author, date: c.date, text: c.text }));
}
/** Accept (true) or reject (false) every insertion/deletion; also clears formatting-change records on accept. */
export function resolveChanges(doc: WordDoc, accept: boolean): number {
  let n = 0;
  for (const c of revisions(doc)) if (c.editable && resolveOne(doc, c.key, accept)) n++;
  for (const p of allParas(doc.blocks)) {
    let changed = false;
    const next: Inline[] = [];
    for (const it of p.content) {
      if (it.t === "k" && (it.kind === "ins" || it.kind === "del")) {
        n++; changed = true;
        const host = it.nodes[0] as XEl;
        const keep = (it.kind === "ins") === accept;
        if (keep) next.push(...parseInlineNodes(doc, it.kind === "del" ? delToIns(host.kids.filter((k): k is XEl => k.k === "el")) : host.kids));
        continue;
      }
      next.push(it);
    }
    if (accept && p.pPr && (kid(p.pPr, "w:pPrChange") || kid(kid(p.pPr, "w:rPr"), "w:ins") || kid(kid(p.pPr, "w:rPr"), "w:del"))) {
      const c = { ...p.pPr, kids: p.pPr.kids.filter((k) => !(k.k === "el" && k.name === "w:pPrChange")) };
      const rp = kid(c, "w:rPr"); if (rp) { const idx = c.kids.indexOf(rp); c.kids[idx] = { ...rp, kids: rp.kids.filter((k) => !(k.k === "el" && (k.name === "w:ins" || k.name === "w:del" || k.name === "w:rPrChange"))) }; }
      p.pPr = c; changed = true; n++;
    }
    for (let i = 0; i < next.length; i++) { const it = next[i]; if (accept && it.t === "r" && it.rPr && kid(it.rPr, "w:rPrChange")) { next[i] = { ...it, rPr: { ...it.rPr, kids: it.rPr.kids.filter((k) => !(k.k === "el" && k.name === "w:rPrChange")) } }; changed = true; n++; } }
    if (changed) { p.content = next; normalize(p); touch(p); }
  }
  return n;
}

/* ---------------------------------------------------------------- tables */
export function newTable(doc: WordDoc, rows: number, cols: number, widthTw: number): Table {
  const hasGrid = doc.styles.has("TableGrid");
  const w = Math.floor(widthTw / cols);
  const tblPr = el("w:tblPr", {}, [
    ...(hasGrid ? [el("w:tblStyle", { "w:val": "TableGrid" })] : []),
    el("w:tblW", { "w:w": "0", "w:type": "auto" }),
    ...(hasGrid ? [] : [el("w:tblBorders", {}, ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => el(`w:${s}`, { "w:val": "single", "w:sz": "4", "w:space": "0", "w:color": "auto" })))]),
    el("w:tblLook", { "w:val": "04A0", "w:firstRow": "1", "w:lastRow": "0", "w:firstColumn": "1", "w:lastColumn": "0", "w:noHBand": "0", "w:noVBand": "1" }),
  ]);
  const mkRow = (): Row => ({ t: "tr", items: Array.from({ length: cols }, () => newCell(w)) });
  return { t: "tbl", id: newId("t"), items: [tblPr, el("w:tblGrid"), ...Array.from({ length: rows }, mkRow)], grid: Array(cols).fill(w), borders: true, style: hasGrid ? "TableGrid" : undefined };
}
export function newCell(wTw: number, from?: Cell): Cell {
  const tcPr = el("w:tcPr", {}, [el("w:tcW", { "w:w": String(Math.round(wTw)), "w:type": "dxa" }), ...(from?.fill ? [el("w:shd", { "w:val": "clear", "w:color": "auto", "w:fill": from.fill })] : [])]);
  return { t: "tc", tcPr, span: 1, span0: 1, blocks: [{ t: "p", id: newId(), p: {}, p0: {}, content: [], dirty: true }], width: wTw, fill: from?.fill };
}
export function insertTableAfter(doc: WordDoc, pid: string, rows: number, cols: number): Table | null {
  const w = locate(doc, pid); if (!w) return null;
  const width = doc.page.w - doc.page.left - doc.page.right;
  const t = newTable(doc, rows, cols, width);
  const after: Para = { t: "p", id: newId(), p: {}, p0: {}, content: [], dirty: true };
  w.list.splice(w.index + 1, 0, t, after);
  return t;
}
/** Logical grid column of a cell (sums gridSpans before it). */
export function colOf(row: Row, cell: Cell): number { let c = 0; for (const x of cellsOf(row)) { if (x === cell) return c; c += x.span; } return c; }
export function cellAtCol(row: Row, col: number): Cell | undefined { let c = 0; for (const x of cellsOf(row)) { if (col >= c && col < c + x.span) return x; c += x.span; } return undefined; }
/** Remove the whole table; keeps at least one paragraph in the containing block list. */
function removeTable(w: NonNullable<ReturnType<typeof locate>>): boolean {
  w.tableList!.splice(w.tableIndex!, 1);
  if (!w.tableList!.some((b) => b.t === "p")) w.tableList!.push({ t: "p", id: newId(), p: {}, p0: {}, content: [], dirty: true });
  return true;
}
export function tableRowOp(doc: WordDoc, pid: string, op: "above" | "below" | "delete"): boolean {
  const w = locate(doc, pid); if (!w?.table || !w.row) return false;
  const t = w.table; const at = t.items.indexOf(w.row);
  if (op === "delete") {
    if (rowsOf(t).length === 1) return removeTable(w);
    t.items.splice(at, 1); return true;
  }
  const nr: Row = { t: "tr", items: cellsOf(w.row).map((c) => { const n = newCell(c.width ?? 2000, c); n.span = c.span; n.span0 = -1; return n; }) };
  t.items.splice(op === "above" ? at : at + 1, 0, nr);
  return true;
}
export function tableColOp(doc: WordDoc, pid: string, op: "left" | "right" | "delete"): boolean {
  const w = locate(doc, pid); if (!w?.table || !w.row || !w.cell) return false;
  const t = w.table; const col = colOf(w.row, w.cell) + (op === "right" ? w.cell.span - 1 : 0);
  if (op === "delete") {
    if (t.grid.length <= 1) return removeTable(w); // TT47: deleting the only column deletes the table (was: deleted one row, reported no change)
    for (const r of rowsOf(t)) { const c = cellAtCol(r, col); if (!c) continue; if (c.span > 1) c.span--; else r.items.splice(r.items.indexOf(c), 1); }
    t.grid.splice(col, 1);
    return true;
  }
  const gw = t.grid[col] ?? 1500;
  for (const r of rowsOf(t)) {
    const c = cellAtCol(r, col);
    const nc = newCell(gw, c);
    if (!c) { r.items.push(nc); continue; }
    const idx = r.items.indexOf(c);
    r.items.splice(op === "left" ? idx : idx + 1, 0, nc);
  }
  t.grid.splice(op === "left" ? col : col + 1, 0, gw);
  // keep the table inside the text width: scale columns proportionally
  const max = doc.page.w - doc.page.left - doc.page.right; const sum = t.grid.reduce((a, b) => a + b, 0);
  if (sum > max) { const k = max / sum; t.grid = t.grid.map((g) => Math.round(g * k)); }
  return true;
}

/* ---------------------------------------------------------------- find / replace */
export interface Hit { pid: string; off: number; len: number }
export function findText(doc: WordDoc, q: string, opts: { matchCase?: boolean; wholeWord?: boolean } = {}): Hit[] {
  if (!q) return [];
  const out: Hit[] = [];
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])` : esc, opts.matchCase ? "gu" : "giu");
  for (const p of allParas(doc.blocks)) {
    // build the offset-space string: tokens become U+FFFC so offsets line up with the model
    const s = p.content.map((i) => (i.t === "r" ? i.text : "\ufffc")).join("");
    for (const m of s.matchAll(re)) out.push({ pid: p.id, off: m.index!, len: m[0].length });
  }
  return out;
}
export function replaceAll(doc: WordDoc, q: string, rep: string, opts: { matchCase?: boolean; wholeWord?: boolean } = {}): number {
  const hits = findText(doc, q, opts);
  for (const h of hits.slice().reverse()) { const r = { a: { pid: h.pid, off: h.off }, b: { pid: h.pid, off: h.off + h.len } }; const at = deleteRange(doc, r); insertText(doc, at, rep); }
  return hits.length;
}

/* ---------------------------------------------------------------- undo snapshots */
function cloneInline(i: Inline): Inline { return i.t === "r" ? { ...i, f: { ...i.f } } : { ...i }; }
export function cloneBlocks(bs: Block[]): Block[] {
  return bs.map((b): Block => {
    if (b.t === "p") return { ...b, p: { ...b.p }, content: b.content.map(cloneInline) };
    if (b.t === "tbl") return { ...b, grid: b.grid.slice(), items: b.items.map((it) => ((it as Row).t === "tr" ? { ...(it as Row), items: (it as Row).items.map((c) => ((c as Cell).t === "tc" ? { ...(c as Cell), blocks: cloneBlocks((c as Cell).blocks) } : c)) } : it)) };
    if (b.t === "box") return { ...b, blocks: cloneBlocks(b.blocks) };
    return b;
  });
}
/** Paragraph style choices: document paragraph styles (non-hidden built-ins and custom) plus the common built-ins. */
export function styleChoices(doc: WordDoc): { id: string; name: string }[] {
  const seen = new Set<string>(); const out: { id: string; name: string }[] = [];
  const add = (id: string, name: string) => { if (!seen.has(id)) { seen.add(id); out.push({ id, name }); } };
  const def = defaultParaStyle(doc); add(def ?? "Normal", "Normal");
  for (const id of BUILTIN_STYLE_IDS) if (id !== "Hyperlink" && id !== "Normal") add(id, doc.styles.get(id)?.name.replace(/^heading/, "Heading") ?? id.replace(/(\d)$/, " $1").replace(/^Heading/, "Heading"));
  for (const s of doc.styles.values()) if (s.type === "paragraph" && !/^(TOC|toc|index|Index|footnote|endnote|header|footer|annotation|Balloon|caption|Caption|Body Text \d)/.test(s.name)) add(s.id, s.name.replace(/^heading/, "Heading"));
  return out.slice(0, 40);
}
export { kids };

/* ---------------------------------------------------------------- page setup */
export const PAPER: Record<string, [number, number]> = { Letter: [12240, 15840], Legal: [12240, 20160], A4: [11906, 16838], A5: [8391, 11906], Executive: [10440, 15120] };
/** Edits the final section's <w:pgSz>/<w:pgMar> in place (other sectPr children — headers, columns, grid — are kept). */
export function setPageSetup(doc: WordDoc, o: { paper?: string; landscape?: boolean; margins?: { top: number; right: number; bottom: number; left: number } }) {
  const old = doc.finalSect;
  const s: XEl = old ? { ...old, kids: old.kids.slice() } : el("w:sectPr");
  const pg = kid(s, "w:pgSz"), mar = kid(s, "w:pgMar");
  let [w, h] = [doc.page.w, doc.page.h];
  if (o.paper && PAPER[o.paper]) [w, h] = PAPER[o.paper];
  const land = o.landscape ?? doc.page.landscape;
  if (land !== (w > h)) [w, h] = [h, w];
  const npg = el("w:pgSz", { "w:w": String(w), "w:h": String(h), "w:orient": land ? "landscape" : undefined, "w:code": pg?.attrs.find((a) => a[0] === "w:code")?.[1] });
  if (pg) s.kids[s.kids.indexOf(pg)] = npg; else s.kids.splice(0, 0, npg);
  const m = o.margins ?? doc.page;
  const nm = el("w:pgMar", { "w:top": String(m.top), "w:right": String(m.right), "w:bottom": String(m.bottom), "w:left": String(m.left), "w:header": String(doc.page.header), "w:footer": String(doc.page.footer), "w:gutter": "0" });
  if (mar) s.kids[s.kids.indexOf(mar)] = nm; else s.kids.splice(s.kids.indexOf(npg) + 1, 0, nm);
  s.selfClose = false;
  // swap the node inside the body block list as well (the final sectPr is kept in place as an opaque block)
  const at = doc.blocks.findIndex((b) => b.t === "x" && b.node === old);
  if (at >= 0) doc.blocks[at] = { t: "x", node: s, label: "" }; else doc.blocks.push({ t: "x", node: s, label: "" });
  doc.finalSect = s;
  Object.assign(doc.page, { w, h, landscape: land, top: m.top, right: m.right, bottom: m.bottom, left: m.left });
}

/* ---------------------------------------------------------------- TT56 Track Changes: recording and per-change review */
const isoNow = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const authorName = (doc: WordDoc) => doc.track.author || "Author";
export function newRev(doc: WordDoc, kind: "ins" | "del"): Rev { return { kind, id: doc.track.next++, author: authorName(doc), date: isoNow() }; }
export const isMine = (doc: WordDoc, r?: Rev) => !!r && r.author === authorName(doc);
/** Turns recording on/off (persisted as settings.xml w:trackRevisions on save). */
export function setTracking(doc: WordDoc, on: boolean, author?: string) { doc.track.on = on; if (author !== undefined) doc.track.author = author; }

/** Tracked deletion of [a, b): text and run-level objects become <w:del>; the author's own pending insertions are removed
 *  outright; text already deleted is left; bookmarks / comment anchors / fields (bare tokens) are untouched; paragraph marks
 *  inside the range are marked deleted (an own inserted mark is really removed, joining the paragraphs). */
function trackedDelete(doc: WordDoc, r: Range, wantEnd = false): Pos {
  const ps = parasIn(doc, r);
  // a sentinel token marks the end of the range so the caller can type after the struck-through text even when own
  // pending insertions vanish and paragraphs join
  const sentinel: Tok = { t: "k", kind: "other", nodes: [], bare: true, label: "" };
  let rv: Rev | undefined;
  const del = () => (rv ??= newRev(doc, "del"));
  const joins: Para[] = [];
  ps.forEach((p, idx) => {
    const from = p.id === r.a.pid ? r.a.off : 0, to = p.id === r.b.pid ? r.b.off : plen(p);
    if (to > from) {
      const i = splitAt(p, from), j = splitAt(p, to);
      const mid: Inline[] = [];
      for (const it of p.content.slice(i, j)) {
        if (it.t === "k" && (it.bare || it.kind === "fieldcode")) { mid.push(it); continue; }
        if (it.rev?.kind === "del") { mid.push(it); continue; }
        if (it.rev?.kind === "ins" && isMine(doc, it.rev)) continue;
        // another reviewer's insertion is not discarded: it becomes a deletion nested in that insertion (<w:ins><w:del>)
        mid.push({ ...it, rev: it.rev?.kind === "ins" ? { ...del(), ins: it.rev } : del() });
      }
      p.content.splice(i, j - i, ...mid, ...(wantEnd && p.id === r.b.pid ? [sentinel] : []));
      normalize(p); touch(p);
    } else if (wantEnd && p.id === r.b.pid) p.content.splice(splitAt(p, to), 0, sentinel);
    if (idx < ps.length - 1) {
      const w = locate(doc, p.id), nx = ps[idx + 1];
      if (!w || w.list[w.index + 1] !== nx) return; // a cell's last paragraph mark is not deletable
      if (p.markRev?.kind === "ins" && isMine(doc, p.markRev)) joins.push(p);
      else if (!p.markRev) { p.markRev = del(); touch(p); }
    }
  });
  for (const p of joins.reverse()) joinNext(doc, p);
  if (wantEnd) for (const p of allParas(doc.blocks)) {
    const k = p.content.indexOf(sentinel); if (k < 0) continue;
    const off = p.content.slice(0, k).reduce((a, it) => a + ilen(it), 0);
    p.content.splice(k, 1); normalize(p);
    return { pid: p.id, off };
  }
  return r.a;
}
/** Deletes a selection that is about to be replaced (typing / paste over a selection). Untracked this is deleteRange; tracked,
 *  the deletion stays visible and the returned position is just after it, so the insertion follows the deleted text (Word). */
export function deleteForReplace(doc: WordDoc, r0: Range): Pos {
  if (!doc.track?.on) return deleteRange(doc, r0);
  return trackedDelete(doc, normRange(doc, r0), true);
}
/** Forward delete / Delete key: where the caret goes afterwards (tracked: past the struck text). */
export function deleteForward(doc: WordDoc, r0: Range): Pos {
  if (!doc.track?.on) return deleteRange(doc, r0);
  return trackedDelete(doc, normRange(doc, r0), true);
}
/** Physically joins `p` with the following paragraph of its container (the surviving mark is the next paragraph's). */
function joinNext(doc: WordDoc, p: Para) {
  const w = locate(doc, p.id); if (!w) return;
  const nx = w.list[w.index + 1]; if (!nx || nx.t !== "p") return;
  p.content.push(...nx.content);
  p.markRev = nx.markRev;
  if (nx.sect) { p.sect = nx.sect; p.pPr = nx.pPr; }
  w.list.splice(w.index + 1, 1);
  normalize(p); touch(p);
}

export interface Change { key: string; kind: "ins" | "del"; author?: string; date?: string; text: string; pid: string; off: number; editable: boolean }
/** Every pending revision in document order: editor/parsed revision runs grouped by id (text + paragraph marks), plus opaque
 *  file revisions (moves, revisions around fields…) one per element. */
export function revisions(doc: WordDoc): Change[] {
  const out: Change[] = []; const byId = new Map<string, Change>();
  const add = (rv: Rev, pid: string, off: number, text: string) => {
    const key = `r:${rv.kind}:${rv.id}`;
    const c = byId.get(key);
    if (c) c.text += text; else { const n: Change = { key, kind: rv.kind, author: rv.author || undefined, date: rv.date, text, pid, off, editable: true }; byId.set(key, n); out.push(n); }
  };
  for (const p of allParas(doc.blocks)) {
    let off = 0;
    p.content.forEach((it, idx) => {
      const txt = it.t === "r" ? it.text : it.t === "k" ? (it.label || `[${it.kind}]`) : "";
      if (it.t === "k" && (it.kind === "ins" || it.kind === "del")) {
        const n = it.nodes[0] as XEl; const a = (k: string) => n.attrs.find((x) => x[0] === k)?.[1];
        out.push({ key: `k:${p.id}:${idx}`, kind: it.kind, author: a("w:author"), date: a("w:date"), text: it.label, pid: p.id, off, editable: false });
      } else if (it.rev) { add(it.rev, p.id, off, txt); if (it.rev.ins) add(it.rev.ins, p.id, off, txt); }
      off += ilen(it);
    });
    if (p.markRev) add(p.markRev, p.id, off, "\u00b6");
  }
  return out;
}
/** Accept / reject one change (by `revisions()` key). Returns false when the key no longer exists. */
export function resolveOne(doc: WordDoc, key: string, accept: boolean): boolean {
  if (key.startsWith("k:")) {
    const [, pid, si] = key.split(":"); const p = paraById(doc, pid); const it = p?.content[Number(si)];
    if (!p || !it || it.t !== "k" || (it.kind !== "ins" && it.kind !== "del")) return false;
    const host = it.nodes[0] as XEl;
    const keep = (it.kind === "ins") === accept;
    p.content.splice(Number(si), 1, ...(keep ? parseInlineNodes(doc, it.kind === "del" ? delToIns(host.kids.filter((k): k is XEl => k.k === "el")) : host.kids) : []));
    normalize(p); touch(p);
    return true;
  }
  const m = /^r:(ins|del):(-?\d+)$/.exec(key); if (!m) return false;
  const kind = m[1] as "ins" | "del", id = Number(m[2]);
  const hit = (r?: Rev) => !!r && r.kind === kind && r.id === id;
  let found = false;
  const joins: Para[] = [];
  for (const p of allParas(doc.blocks)) {
    let changed = false;
    const next: Inline[] = [];
    for (const it of p.content) {
      const rv = it.rev;
      if (hit(rv)) {
        found = changed = true;
        // accepted insertion / rejected deletion stay (a rejected deletion inside an insertion is that insertion again)
        if (kind === "ins" ? accept : !accept) next.push({ ...it, rev: kind === "del" ? rv!.ins : undefined });
        continue;
      }
      if (rv?.kind === "del" && hit(rv.ins)) {
        found = changed = true;
        if (accept) next.push({ ...it, rev: { ...rv, ins: undefined } });
        continue;
      }
      next.push(it);
    }
    if (hit(p.markRev)) {
      found = changed = true;
      if (kind === "ins" ? accept : !accept) p.markRev = undefined; else joins.push(p);
    }
    if (changed) { p.content = next; normalize(p); touch(p); }
  }
  for (const p of joins.reverse()) { p.markRev = undefined; joinNext(doc, p); }
  return found;
}
