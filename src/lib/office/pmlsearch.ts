/** Literal, run-preserving search for slide-owned DrawingML text (including tables
 * and groups). Never searches package XML, notes, masters, fields or relationships.
 * A paragraph, hard break, or dynamic field is a match boundary. No regex supplied
 * by the caller is executed. Replacement inherits the first matched run's style.
 */
import { mutSlide, type PptxDoc } from "./pml";
import { kids, kid, textOf, textNode, setAttr, type XEl } from "./xmltree";
export interface SlideTextHit { slide: number; segment: number; start: number; end: number; text: string }
export interface SlideSearchOptions { matchCase?: boolean; slide?: number }
const MAX_HITS = 100_000;
function segments(root: XEl): XEl[][] {
  const out: XEl[][] = [];
  const walk = (e: XEl, inBody: boolean) => {
    const body = inBody || e.name === "p:txBody" || e.name === "a:txBody";
    if (body && e.name === "a:p") {
      let run: XEl[] = [];
      const flush = () => { if (run.length) out.push(run); run = []; };
      for (const c of kids(e)) {
        if (c.name === "a:r") { const t = kid(c, "a:t"); if (t) run.push(t); }
        else if (c.name === "a:br" || c.name === "a:fld") flush();
      }
      flush(); return;
    }
    // Read only the chosen AlternateContent fallback (as the renderer does).
    if (e.name === "mc:AlternateContent") { const b = kid(e, "mc:Fallback") ?? kid(e, "mc:Choice"); if (b) walk(b, body); return; }
    for (const c of kids(e)) walk(c, body);
  };
  walk(root, false); return out;
}
function literalPattern(query: string, matchCase: boolean): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");
}
export function findSlideText(doc: PptxDoc, query: string, opts: SlideSearchOptions = {}): SlideTextHit[] {
  if (!query) return [];
  if (query.length > 4096) throw new Error("Search text exceeds 4096 characters");
  if (opts.slide !== undefined && (!Number.isInteger(opts.slide) || opts.slide < 0 || opts.slide >= doc.slides.length)) throw new Error("No such slide");
  const re = literalPattern(query, !!opts.matchCase), hits: SlideTextHit[] = [];
  doc.slides.forEach((s, slide) => {
    if (opts.slide !== undefined && opts.slide !== slide) return;
    segments(s.xml.root).forEach((nodes, segment) => {
      const text = nodes.map(textOf).join("");
      for (const m of text.matchAll(re)) {
        if (hits.length >= MAX_HITS) throw new Error(`Search exceeds ${MAX_HITS} matches; narrow the search`);
        hits.push({ slide, segment, start: m.index!, end: m.index! + m[0].length, text });
      }
    });
  });
  return hits;
}
export function replaceSlideText(doc: PptxDoc, query: string, replacement: string, opts: SlideSearchOptions = {}): number {
  // Refuse line/control injection rather than inventing paragraph/run semantics.
  if (/[\u0000-\u001f\u007f]/.test(replacement) || /[\ud800-\udfff]/u.test(replacement)) throw new Error("Replacement must be one line of valid text");
  if (replacement.length > 65536) throw new Error("Replacement exceeds 65536 characters");
  const hits = findSlideText(doc, query, opts);
  if (!hits.length) return 0;
  const growth = hits.reduce((n, h) => n + Math.max(0, replacement.length - (h.end - h.start)), 0);
  if (growth > 16 * 1024 * 1024) throw new Error("Replacement would add more than 16 MiB of text; narrow the search");
  for (const slide of new Set(hits.map((h) => h.slide))) {
    const s = mutSlide(doc, slide), segs = segments(s.xml.root);
    const bySegment = new Map<number, SlideTextHit[]>();
    for (const h of hits) if (h.slide === slide) { const a = bySegment.get(h.segment) ?? []; a.push(h); bySegment.set(h.segment, a); }
    for (const [segment, matches] of bySegment) {
      const nodes = segs[segment], strings = nodes.map(textOf); let off = 0;
      const starts = strings.map((s) => { const start = off; off += s.length; return start; });
      // Reverse order keeps earlier offsets valid, even if replacement has another length.
      for (const h of matches.slice().reverse()) {
        let first = true;
        for (let i = 0; i < nodes.length; i++) {
          const a = Math.max(0, h.start - starts[i]), b = Math.min(strings[i].length, h.end - starts[i]);
          if (a >= b) continue;
          strings[i] = strings[i].slice(0, a) + (first ? replacement : "") + strings[i].slice(b); first = false;
        }
      }
      nodes.forEach((node, i) => { if (strings[i] !== textOf(node)) { node.kids = [textNode(strings[i])]; node.selfClose = false; setAttr(node, "xml:space", /^\s|\s$/.test(strings[i]) ? "preserve" : undefined); } });
    }
  }
  return hits.length;
}
