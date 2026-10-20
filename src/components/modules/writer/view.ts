/**
 * TT46 Writer view: renders the WordprocessingML model to DOM (manual DOM, not React, so the contentEditable surface is
 * fully owned by us), maps DOM selections ↔ model positions, and paginates (page boxes, forced breaks, table-row
 * breaks, headers/footers with PAGE / NUMPAGES fields). Original code.
 */
import { allParas, cellsOf, effectivePara, effectiveRun, emuToPx, listMarkers, rowsOf, twipToPx, type Block, type Inline, type Para, type RunFmt, type WordDoc } from "@/lib/office/wordml";
import type { Pos } from "@/lib/office/wordedit";
import type { XEl } from "@/lib/office/xmltree";

const FONT_FALLBACK: Record<string, string> = {
  calibri: '"Calibri", "Carlito", "Liberation Sans", Arial, sans-serif', "calibri light": '"Calibri Light", "Carlito", "Liberation Sans", Arial, sans-serif',
  cambria: '"Cambria", "Caladea", "Liberation Serif", "Times New Roman", serif', "times new roman": '"Times New Roman", "Liberation Serif", Tinos, serif',
  arial: 'Arial, "Liberation Sans", Arimo, sans-serif', "courier new": '"Courier New", "Liberation Mono", Cousine, monospace', consolas: 'Consolas, "Liberation Mono", monospace',
  georgia: 'Georgia, "Gelasio", serif', verdana: 'Verdana, "DejaVu Sans", sans-serif', "segoe ui": '"Segoe UI", system-ui, sans-serif', aptos: 'Aptos, "Carlito", system-ui, sans-serif',
};
export const cssFont = (f?: string) => (f ? FONT_FALLBACK[f.toLowerCase()] ?? `"${f.replace(/"/g, "")}", system-ui, sans-serif` : FONT_FALLBACK.calibri);
const HL: Record<string, string> = { yellow: "#ffff00", green: "#00ff00", cyan: "#00ffff", magenta: "#ff00ff", blue: "#0000ff", red: "#ff0000", darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000", darkYellow: "#808000", darkGray: "#808080", lightGray: "#c0c0c0", black: "#000000", white: "#ffffff" };

export function runCss(e: RunFmt): Partial<CSSStyleDeclaration> {
  const s: Partial<CSSStyleDeclaration> = {};
  if (e.b) s.fontWeight = "700";
  if (e.i) s.fontStyle = "italic";
  const deco = [e.u && e.u !== "none" ? "underline" : "", e.s ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) s.textDecoration = deco + (e.u === "double" ? " double" : e.u === "dotted" ? " dotted" : e.u === "wave" ? " wavy" : "");
  if (e.sz) s.fontSize = `${e.sz / 2}pt`;
  s.fontFamily = cssFont(e.font);
  if (e.color && /^[0-9a-f]{6}$/i.test(e.color)) s.color = `#${e.color}`;
  if (e.hl) s.backgroundColor = HL[e.hl] ?? "";
  else if (e.shd && /^[0-9a-f]{6}$/i.test(e.shd)) s.backgroundColor = `#${e.shd}`;
  if (e.va === "superscript" || e.va === "subscript") { s.verticalAlign = e.va === "superscript" ? "super" : "sub"; s.fontSize = `${(e.sz ?? 22) / 2 * 0.65}pt`; }
  if (e.caps) s.textTransform = "uppercase";
  if (e.smallCaps) s.fontVariant = "small-caps";
  return s;
}

export interface RenderState { doc: WordDoc; markers: ReturnType<typeof listMarkers>; noteNo: Map<string, number>; commentOpen: Set<string>; page?: { n: number; total: number }; editable: boolean }
export function makeState(doc: WordDoc, blocks: Block[], editable = true): RenderState {
  const paras = allParas(blocks);
  const noteNo = new Map<string, number>(); let fn = 0, en = 0;
  for (const p of paras) for (const it of p.content) if (it.t === "k" && it.kind === "note" && it.note) noteNo.set(`${it.note.type}:${it.note.id}`, it.note.type === "footnote" ? ++fn : ++en);
  return { doc, markers: listMarkers(doc, paras), noteNo, commentOpen: new Set(), editable };
}

const instrOf = (it: Inline) => (it.t === "k" && it.kind === "fieldcode" ? it.nodes.map((n) => (n.k === "el" && n.name === "w:instrText" ? n.kids.map((k) => (k.k === "text" ? k.raw : "")).join("") : "")).join("") : "");

export function renderPara(st: RenderState, p: Para): HTMLElement {
  const doc = st.doc;
  const e = effectivePara(doc, p);
  const pe = document.createElement("p");
  pe.className = "wp";
  pe.dataset.pid = p.id;
  const mk = st.markers.get(p.id);
  const indL = mk?.indL ?? e.indL ?? 0, first = mk?.hanging !== undefined ? -mk.hanging : e.indFirst ?? 0;
  const ps = pe.style;
  ps.margin = "0"; ps.marginLeft = `${twipToPx(indL)}px`; ps.marginRight = `${twipToPx(e.indR ?? 0)}px`; ps.textIndent = `${twipToPx(first)}px`;
  ps.paddingTop = `${twipToPx(e.before ?? 0)}px`; ps.paddingBottom = `${twipToPx(e.after ?? 0)}px`;
  if (e.line) ps.lineHeight = e.lineRule === "exact" || e.lineRule === "atLeast" ? `${twipToPx(e.line)}px` : String((e.line / 240) * 1.17);
  else ps.lineHeight = "1.17";
  ps.textAlign = e.align === "justify" ? "justify" : e.align === "center" ? "center" : e.align === "right" ? "right" : "left";
  ps.whiteSpace = "pre-wrap"; ps.overflowWrap = "break-word"; ps.tabSize = "48px";
  if (e.shd && /^[0-9a-f]{6}$/i.test(e.shd)) ps.backgroundColor = `#${e.shd}`;
  const baseRun = effectiveRun(doc, p, {});
  Object.assign(ps, { fontFamily: cssFont(baseRun.font), fontSize: `${(baseRun.sz ?? 22) / 2}pt` });
  if (e.pageBreakBefore) pe.dataset.break = "page";
  if (p.sect) pe.dataset.sect = "1";
  if (mk) {
    const m = document.createElement("span");
    m.className = "wmark"; m.contentEditable = "false"; m.dataset.marker = "1";
    m.textContent = mk.text;
    Object.assign(m.style, runCss(effectiveRun(doc, p, mk.f)), { display: "inline-block", minWidth: `${twipToPx(mk.hanging ?? 360)}px`, textIndent: "0", textDecoration: "none" });
    pe.appendChild(m);
  }
  let off = 0;
  let fieldInstr = ""; let inResult = false;
  p.content.forEach((it, ri) => {
    const node = renderInline(st, p, it, ri, off);
    if (it.t === "k" && it.kind === "fieldcode") {
      const fc = it.nodes[0] as XEl | undefined;
      const ty = fc?.attrs.find((a) => a[0] === "w:fldCharType")?.[1];
      if (ty === "begin") fieldInstr = ""; if (ty === "separate") inResult = true; if (ty === "end") { inResult = false; fieldInstr = ""; }
      fieldInstr += instrOf(it);
    } else if (inResult && st.page && it.t === "r") {
      const f = fieldInstr.trim().split(/\s+/)[0]?.toUpperCase();
      if (f === "PAGE") node.textContent = String(st.page.n); else if (f === "NUMPAGES" || f === "SECTIONPAGES") node.textContent = String(st.page.total);
    }
    if (it.t === "k" && it.kind === "comment" && it.cid) { if (it.mark === "start") st.commentOpen.add(it.cid); else st.commentOpen.delete(it.cid); }
    pe.appendChild(node);
    off += it.t === "r" ? it.text.length : 1;
  });
  // positional tabs (Word's three-column header/footer): the paragraph becomes a row and each ptab a flexible gap,
  // so text after a "center" ptab sits mid-line and text after a "right" ptab ends at the margin
  if (p.content.some(isPtab)) { pe.style.display = "flex"; pe.style.whiteSpace = "pre"; pe.dataset.ptab = "1"; }
  if (!p.content.some((i) => (i.t === "r" && i.text) || (i.t === "k" && (i.kind === "image" || i.label)))) { const br = document.createElement("br"); br.dataset.empty = "1"; pe.appendChild(br); }
  else if (p.content.length && p.content[p.content.length - 1].t === "r" && (p.content[p.content.length - 1] as { text: string }).text.endsWith("\n")) { const br = document.createElement("br"); br.dataset.empty = "1"; pe.appendChild(br); }
  return pe;
}

function renderInline(st: RenderState, p: Para, it: Inline, ri: number, off: number): HTMLElement {
  const doc = st.doc;
  if (it.t === "r") {
    const s = document.createElement("span");
    s.dataset.ri = String(ri); s.dataset.o = String(off);
    Object.assign(s.style, runCss(effectiveRun(doc, p, it.f)));
    if (it.link) { s.dataset.href = it.link.href ?? (it.link.anchor ? `#${it.link.anchor}` : ""); s.classList.add("wlink"); s.title = `${s.dataset.href} — Ctrl+click to open`; }
    if (st.commentOpen.size) { s.classList.add("wcmt"); s.dataset.cids = [...st.commentOpen].join(","); }
    s.textContent = it.text;
    return s;
  }
  const t = document.createElement(it.kind === "image" && it.img?.data ? "img" : "span") as HTMLElement;
  t.contentEditable = "false"; t.dataset.ti = String(ri); t.dataset.o = String(off); t.dataset.kind = it.kind;
  t.className = `wtok wtok-${it.kind}`;
  if (it.link) t.dataset.href = it.link.href ?? "";
  switch (it.kind) {
    case "image": {
      if (it.img?.data && t instanceof HTMLImageElement) {
        const blob = new Blob([it.img.data as Uint8Array<ArrayBuffer>], { type: it.img.mime });
        t.src = URL.createObjectURL(blob); t.alt = it.img.descr ?? it.label; t.draggable = false;
        t.style.width = `${emuToPx(it.img.cx)}px`; t.style.height = `${emuToPx(it.img.cy)}px`; t.style.maxWidth = "100%"; t.style.objectFit = "contain"; t.style.verticalAlign = "bottom";
        if (/emf|wmf|tiff/.test(it.img.mime ?? "")) { const s = document.createElement("span"); s.contentEditable = "false"; s.dataset.ti = String(ri); s.dataset.o = String(off); s.dataset.kind = "image"; s.className = "wtok wtok-image wtok-noprev"; s.textContent = `[${it.img.mime?.split("/")[1]} picture: ${it.label}]`; s.style.width = `${emuToPx(it.img.cx)}px`; s.style.minHeight = `${Math.min(emuToPx(it.img.cy), 80)}px`; return s; }
      } else t.textContent = `[picture: ${it.label}]`;
      break;
    }
    case "note": { const n = st.noteNo.get(`${it.note!.type}:${it.note!.id}`) ?? "?"; t.textContent = it.note!.type === "endnote" ? toRoman(Number(n)) : String(n); t.title = noteText(doc, it.note!.type, it.note!.id); break; }
    case "page": t.textContent = ""; t.title = "Page break"; break;
    case "column": t.textContent = ""; t.title = "Column break"; break;
    case "ins": t.textContent = it.label; t.title = `Inserted${authorOf(it.nodes[0] as XEl)} — accept or reject in the Review panel`; break;
    case "del": t.textContent = it.label; t.title = `Deleted${authorOf(it.nodes[0] as XEl)} — accept or reject in the Review panel`; break;
    case "commentRef": t.textContent = ""; t.title = doc.comments.find((c) => c.id === it.cid)?.text ?? "comment"; break;
    case "fieldcode": case "bookmark": case "comment": t.textContent = ""; break;
    case "other": if (isPtab(it)) { t.textContent = ""; t.dataset.kind = "ptab"; t.style.flex = "1 1 0"; t.style.minWidth = "1em"; t.title = "Positional tab"; } else t.textContent = it.label; break;
    default: t.textContent = it.label;
  }
  return t;
}
function isPtab(i: Inline): boolean { const n = i.t === "k" && i.kind === "other" ? i.nodes[0] : undefined; return !!n && n.k === "el" && n.name === "w:ptab"; }
const authorOf = (e: XEl) => { const a = e.attrs.find((x) => x[0] === "w:author")?.[1]; return a ? ` by ${a}` : ""; };
const toRoman = (n: number) => { const m: [number, string][] = [[10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]]; let s = ""; for (const [v, r] of m) while (n >= v) { s += r; n -= v; } return s; };
function noteText(doc: WordDoc, type: string, id: string) { const n = doc.notes.find((x) => x.type === type && x.id === id); return n ? allParas(n.blocks).map((p) => p.content.map((i) => (i.t === "r" ? i.text : "")).join("")).join(" ").trim() : ""; }

export function renderBlocks(st: RenderState, blocks: Block[], into: HTMLElement) {
  for (const b of blocks) {
    if (b.t === "p") into.appendChild(renderPara(st, b));
    else if (b.t === "tbl") into.appendChild(renderTable(st, b));
    else if (b.t === "box") {
      const d = document.createElement("div"); d.className = "wbox"; d.dataset.bid = b.id; if (b.label) d.title = `Content control: ${b.label}`;
      renderBlocks(st, b.blocks, d); into.appendChild(d);
    } else if (b.label) {
      const d = document.createElement("div"); d.className = "wopq"; d.contentEditable = "false"; d.textContent = b.label; d.title = "Preserved content (kept exactly on save)"; into.appendChild(d);
    }
  }
}
function renderTable(st: RenderState, t: Extract<Block, { t: "tbl" }>): HTMLElement {
  const tb = document.createElement("table");
  tb.className = "wtbl" + (t.borders ? " wtbl-b" : ""); tb.dataset.tid = t.id;
  const total = t.grid.reduce((a, b) => a + b, 0);
  if (total > 0) tb.style.width = `${twipToPx(total)}px`;
  const cg = document.createElement("colgroup");
  for (const g of t.grid) { const c = document.createElement("col"); c.style.width = `${twipToPx(g)}px`; cg.appendChild(c); }
  tb.appendChild(cg);
  const body = document.createElement("tbody");
  const rows = rowsOf(t);
  // vertical merges: a "restart" cell spans down over following "continue" cells in the same grid column
  const spanDown = new Map<object, number>();
  const colStart = (r: number, cell: object) => { let c = 0; for (const x of cellsOf(rows[r])) { if (x === cell) return c; c += x.span; } return -1; };
  rows.forEach((r, ri) => {
    for (const c of cellsOf(r)) if (c.vmerge === "restart") {
      const col = colStart(ri, c); let n = 1;
      for (let k = ri + 1; k < rows.length; k++) { let cc = 0; const below = cellsOf(rows[k]).find((x) => { const hit = cc === col; cc += x.span; return hit; }); if (below?.vmerge === "continue") n++; else break; }
      spanDown.set(c, n);
    }
  });
  rows.forEach((r) => {
    const tr = document.createElement("tr"); tr.className = "wtr";
    if (r.height) tr.style.height = `${twipToPx(r.height)}px`;
    for (const c of cellsOf(r)) {
      if (c.vmerge === "continue") continue;
      const td = document.createElement("td");
      if (c.span > 1) td.colSpan = c.span;
      const sd = spanDown.get(c); if (sd && sd > 1) td.rowSpan = sd;
      if (c.fill && /^[0-9a-f]{6}$/i.test(c.fill)) td.style.backgroundColor = `#${c.fill}`;
      renderBlocks(st, c.blocks, td);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  });
  tb.appendChild(body);
  return tb;
}

/* ---------------------------------------------------------------- selection mapping */
const lenOf = (n: Node): number => {
  if (n.nodeType === 3) return (n.parentElement?.dataset.ri !== undefined ? (n as Text).data.length : 0);
  const e = n as HTMLElement;
  if (e.dataset?.ti !== undefined) return 1;
  if (e.dataset?.ri !== undefined) return e.textContent?.length ?? 0;
  if (e.dataset?.marker || e.dataset?.empty) return 0;
  let s = 0; e.childNodes?.forEach((c) => { s += lenOf(c); }); return s;
};
export function domToPos(node: Node, offset: number): Pos | null {
  let el: Node | null = node;
  while (el && !(el instanceof HTMLElement && el.dataset.pid)) el = el.parentNode;
  if (!el) {
    // caret in a table cell / container element between paragraphs: snap to the nearest paragraph
    const host = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
    const child = host?.childNodes[Math.min(offset, (host?.childNodes.length ?? 1) - 1)] as HTMLElement | undefined;
    const p = child?.closest?.("[data-pid]") ?? child?.querySelector?.("[data-pid]") ?? host?.querySelector?.("[data-pid]");
    return p instanceof HTMLElement ? { pid: p.dataset.pid!, off: offset >= (host?.childNodes.length ?? 0) ? lenOf(p) : 0 } : null;
  }
  const pe = el as HTMLElement;
  // inside a token: before it (offset 0) or after it
  let tok: Node | null = node;
  while (tok && tok !== pe && !(tok instanceof HTMLElement && tok.dataset.ti !== undefined)) tok = tok.parentNode;
  if (tok && tok !== pe) return { pid: pe.dataset.pid!, off: Number((tok as HTMLElement).dataset.o) + (offset > 0 ? 1 : 0) };
  if (node.nodeType === 3) {
    const span = node.parentElement!;
    if (span.dataset.ri !== undefined) return { pid: pe.dataset.pid!, off: Number(span.dataset.o) + offset };
    return { pid: pe.dataset.pid!, off: 0 };
  }
  const host = node as HTMLElement;
  if (host.dataset.ri !== undefined) return { pid: pe.dataset.pid!, off: Number(host.dataset.o) + lenOf2(host, offset) };
  let s = 0;
  for (let i = 0; i < Math.min(offset, host.childNodes.length); i++) s += lenOf(host.childNodes[i]);
  return { pid: pe.dataset.pid!, off: s + (host === pe ? 0 : Number(host.dataset.o ?? 0)) };
}
function lenOf2(span: HTMLElement, childOffset: number) { let s = 0; for (let i = 0; i < childOffset && i < span.childNodes.length; i++) s += (span.childNodes[i].textContent ?? "").length; return s; }
export function posToDom(root: HTMLElement, pos: Pos): { node: Node; offset: number } | null {
  const pe = root.querySelector(`[data-pid="${pos.pid}"]`) as HTMLElement | null;
  if (!pe) return null;
  const kids = Array.from(pe.children) as HTMLElement[];
  let last: HTMLElement | null = null;
  for (const k of kids) {
    if (k.dataset.o === undefined) continue;
    const o = Number(k.dataset.o);
    if (k.dataset.ri !== undefined) {
      const n = k.textContent?.length ?? 0;
      if (pos.off >= o && pos.off <= o + n) { const tn = k.firstChild ?? k; return { node: tn, offset: tn.nodeType === 3 ? pos.off - o : 0 }; }
    } else if (pos.off <= o) { return { node: pe, offset: Array.prototype.indexOf.call(pe.childNodes, k) }; }
    last = k;
  }
  if (last) return { node: pe, offset: Array.prototype.indexOf.call(pe.childNodes, last) + 1 };
  const empty = pe.querySelector("[data-empty]");
  return { node: pe, offset: empty ? Array.prototype.indexOf.call(pe.childNodes, empty) : pe.childNodes.length };
}

/* ---------------------------------------------------------------- pagination */
export interface PageGeom { pageW: number; pageH: number; top: number; bottom: number; left: number; right: number; gap: number }
export function geomOf(doc: WordDoc, gap = 24): PageGeom {
  const p = doc.page;
  return { pageW: twipToPx(p.w), pageH: twipToPx(p.h), top: twipToPx(p.top), bottom: twipToPx(p.bottom), left: twipToPx(p.left), right: twipToPx(p.right), gap };
}
/** Pushes blocks (and top-level table rows) that cross a page boundary onto the next page. Returns the page count. */
export const MAX_PAGES = 2000;
export function paginate(root: HTMLElement, g: PageGeom): number {
  root.querySelectorAll(".wpg-sp").forEach((e) => e.remove());
  for (const e of Array.from(root.children) as HTMLElement[]) e.style.marginTop = "";
  const contentH = g.pageH - g.top - g.bottom, stride = g.pageH + g.gap;
  let page = 0;
  const pageEnd = () => page * stride + contentH;
  // root is positioned, so a block's offsetTop is already relative to it; a <tr>'s offsetParent is its table
  const push = (e: HTMLElement, absTop: number, isRow: boolean) => {
    if (page >= MAX_PAGES - 1) return;
    page++;
    const need = page * stride - absTop;
    if (need <= 0) return;
    if (isRow) { const sp = document.createElement("tr"); sp.className = "wpg-sp"; sp.contentEditable = "false"; const td = document.createElement("td"); td.colSpan = 99; td.style.cssText = `height:${need}px;padding:0;border:none;background:transparent`; sp.appendChild(td); e.parentElement!.insertBefore(sp, e); }
    else e.style.marginTop = `${need}px`;
  };
  /** moves the page cursor to the page whose content area contains (or follows) y */
  const advancePast = (y: number) => { while (y >= (page + 1) * stride && page < MAX_PAGES - 1) page++; };
  for (const e of Array.from(root.children) as HTMLElement[]) {
    const prev = e.previousElementSibling as HTMLElement | null;
    let lastKid = prev?.lastElementChild as HTMLElement | null | undefined;
    if (lastKid?.dataset.empty) lastKid = lastKid.previousElementSibling as HTMLElement | null;
    const forced = e.dataset.break === "page" || !!lastKid?.classList.contains("wtok-page") || prev?.dataset?.sect === "1";
    if (forced && e.offsetTop > page * stride) push(e, e.offsetTop, false);
    if (e.tagName === "TABLE") {
      const rows = Array.from(e.querySelectorAll(":scope > tbody > tr.wtr")) as HTMLElement[];
      for (const r of rows) {
        const rt = e.offsetTop + r.offsetTop;
        advancePast(rt);
        if (rt + r.offsetHeight > pageEnd() && rt > page * stride + 1 && r.offsetHeight <= contentH) push(r, rt, true);
        advancePast(e.offsetTop + r.offsetTop + r.offsetHeight);
      }
      continue;
    }
    advancePast(e.offsetTop);
    const t = e.offsetTop;
    if (t + e.offsetHeight > pageEnd() && t > page * stride + 1 && e.offsetHeight <= contentH) push(e, t, false);
    advancePast(e.offsetTop + e.offsetHeight); // an over-tall block flows across the gap
  }
  return page + 1;
}
