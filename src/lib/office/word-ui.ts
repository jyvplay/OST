/** Immutable display projections of the imperative WordprocessingML model.
 * Render never receives the mutable engine, paragraphs, XML trees or ZIP data.
 * Call only at model/selection events. A selection refresh can reuse the cached
 * document counts; inactive panes are not scanned. Original implementation. */
import { allParas, effectivePara, paraText, styleChain, type Block, type Para, type WordDoc } from "./wordml";
import * as E from "./wordedit";
import { hfLines, type HfLine } from "./hdrftr";
import { countWordDoc } from "./wordcount";
export type WriterPaneKind = "none" | "find" | "review" | "nav" | "page" | "hf" | "notes" | "spell";
export type WriterPop = "" | "link" | "table" | "comment" | "saveas";
export type HeaderFooterView = Record<"header" | "footer", Record<"default" | "first", HfLine[]>>;
export interface WriterDocumentView {
  title: string; page: WordDoc["page"]; track: { on: boolean };
  styles: { id: string; name: string }[]; counts: { words: number; chars: number };
}
export interface WriterToolbarView {
  fmt: ReturnType<typeof E.fmtAt> | null;
  para: { p: { style?: string; line?: number } } | undefined;
  inTable: boolean; align: string; listKind: "bullet" | "number" | null;
}
export interface WriterPaneView {
  kind: WriterPaneKind; pop: WriterPop; fidelity: string;
  headings: { id: string; level: number; text: string }[];
  changes: E.Change[]; notes: E.NoteInfo[]; comments: Pick<WordDoc["comments"][number], "id" | "author" | "date" | "initials" | "text">[];
  headers: HeaderFooterView | null;
}
export interface WriterUiView {
  identity: number; document: WriterDocumentView; toolbar: WriterToolbarView; pane: WriterPaneView;
  undoCount: number; redoCount: number; autosaveBlocked: boolean;
}
export function writerDocumentView(doc: WordDoc): WriterDocumentView {
  const counts = countWordDoc(doc);
  return { title: doc.title, page: { ...doc.page }, track: { on: doc.track.on }, styles: E.styleChoices(doc), counts: { words: counts.words, chars: counts.characters } };
}
export function writerToolbarView(doc: WordDoc, selection: E.Range | null, pending: Record<string, unknown> | null): WriterToolbarView {
  const current = selection ? E.paraById(doc, selection.a.pid) : undefined;
  const fallback = current ? [] : allParas(doc.blocks), last = fallback.at(-1);
  const range = selection ?? (last ? { a: { pid: last.id, off: E.plen(last) }, b: { pid: last.id, off: E.plen(last) } } : null);
  let fmt: WriterToolbarView["fmt"] = null;
  try { if (range) fmt = { ...E.fmtAt(doc, range), ...(pending ?? {}) } as ReturnType<typeof E.fmtAt>; } catch { /* stale position after a document replacement */ }
  const p = current ?? fallback[0];
  return { fmt, para: current ? { p: { style: current.p.style, line: current.p.line } } : undefined,
    inTable: !!(selection && E.locate(doc, selection.a.pid)?.table), align: p ? effectivePara(doc, p).align ?? "left" : "left", listKind: current ? E.listKind(doc, current) : null };
}
function headingLevel(doc: WordDoc, p: Para): number {
  for (const s of styleChain(doc, p.p.style).reverse()) { const m = /^heading\s*(\d)$/i.exec(s.name) ?? /^Heading(\d)$/.exec(s.id); if (m) return Number(m[1]); if (s.name.toLowerCase() === "title") return 1; }
  return 0;
}
export function writerPaneView(doc: WordDoc, kind: WriterPaneKind, pop: WriterPop): WriterPaneView {
  const headings: WriterPaneView["headings"] = [];
  if (kind === "nav") for (const p of allParas(doc.blocks)) {
    const level = headingLevel(doc, p); if (!level) continue;
    const text = paraText(p); if (!text.trim()) continue;
    headings.push({ id: p.id, level, text: text.slice(0, 80) }); if (headings.length === 300) break;
  }
  return { kind, pop, fidelity: pop === "saveas" ? fidelity(doc) : "",
    headings,
    changes: kind === "review" ? E.revisions(doc) : [], notes: kind === "notes" ? E.listNotes(doc) : [], comments: kind === "review" ? doc.comments.map(({ id, author, date, initials, text }) => ({ id, author, date, initials, text })) : [],
    headers: kind === "hf" ? { header: { default: hfLines(doc, "header", "default"), first: hfLines(doc, "header", "first") }, footer: { default: hfLines(doc, "footer", "default"), first: hfLines(doc, "footer", "first") } } : null };
}
/** Read-only constructs are still retained verbatim in the actual package. */
export function fidelity(doc: WordDoc): string {
  const c = new Map<string, number>();
  const add = (k: string) => c.set(k, (c.get(k) ?? 0) + 1);
  for (const p of allParas(doc.blocks)) for (const it of p.content) if (it.t === "k") {
    if (it.kind === "math") add("equation"); else if (it.kind === "box") add("inline control"); else if (it.kind === "field") add("field"); else if (it.kind === "other" && it.label) add("object"); else if (it.kind === "image" && /emf|wmf|tiff/.test(it.img?.mime ?? "")) add("EMF/WMF picture");
  }
  const walk = (bs: Block[]) => { for (const b of bs) { if (b.t === "x" && b.label) add("block object"); if (b.t === "box") walk(b.blocks); if (b.t === "tbl") for (const r of b.items) if ((r as { t?: string }).t === "tr") for (const cc of (r as { items: unknown[] }).items) if ((cc as { t?: string }).t === "tc") walk((cc as { blocks: Block[] }).blocks); } };
  walk(doc.blocks); if (doc.parts.size) add("header/footer");
  return [...c].map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ");
}
