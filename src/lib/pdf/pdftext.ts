/**
 * TT52 — text extraction device + layout: positioned glyphs → words → lines (reading order), page text, search hits,
 * and the selectable text layer. Original code. Geometry is in the page's default user space (PDF points, y up).
 */
import { Interpreter, IDENT, apply, type Device, type GState, type M, type Path, type PdfImage, type Shading } from "./pdfinterp";
import type { Glyph, PdfFont } from "./pdffont";
import type { PdfDoc, PdfPage } from "./pdfdoc";
import { hiddenOCGs, runAnnotations } from "./pdfinterp";

export interface TChar { u: string; x: number; y: number; w: number; size: number; angle: number; /** baseline direction unit vector */ dx: number; dy: number; font: string }
export interface TLine { text: string; chars: TChar[]; x0: number; y0: number; x1: number; y1: number; angle: number }

class TextDevice implements Device {
  wantsImages = false; wantsPaths = false;
  chars: TChar[] = [];
  save() {} restore() {} fill() {} stroke() {} clip() {} image(_i: PdfImage) {} shade(_s: Shading) {}
  glyph(g: Glyph, font: PdfFont, trm: M, _gs: GState, wUser: number) { this.add(g, font, trm, wUser); }
  type3Glyph(g: Glyph, font: PdfFont, trm: M, _gs: GState, wUser: number) {
    // Type 3: trm maps text space; the glyph's height comes from the font matrix × size
    this.add(g, font, trm, wUser);
  }
  private add(g: Glyph, font: PdfFont, trm: M, wUser: number) {
    if (this.chars.length > 2_000_000) return;
    const [x, y] = apply(trm, 0, 0);
    const dxv = font.vertical ? trm[2] : trm[0], dyv = font.vertical ? trm[3] : trm[1];
    const len = Math.hypot(dxv, dyv) || 1;
    const size = font.vertical ? Math.hypot(trm[0], trm[1]) : Math.hypot(trm[2], trm[3]);
    let u = g.unicode;
    if (u === "\u0000") u = "";
    this.chars.push({ u, x, y, w: wUser, size: size || 1, angle: Math.atan2(dyv, dxv), dx: dxv / len, dy: dyv / len, font: font.baseFont });
  }
}

/** extract positioned characters of a page (page content + annotation appearances are NOT included: text only) */
export function pageChars(doc: PdfDoc, page: PdfPage, opts: { annotations?: boolean; deadline?: number; includeHiddenOC?: boolean } = {}): TChar[] {
  const dev = new TextDevice(); const warnings: string[] = [];
  // the viewer extracts visible text only; includeHiddenOC mirrors PDFium's FPDFText (which ignores OC visibility)
  const it = new Interpreter(doc, dev, IDENT, { hiddenOCGs: opts.includeHiddenOC ? new Set() : hiddenOCGs(doc), warnings, deadline: opts.deadline });
  it.runPage(page);
  if (opts.annotations) runAnnotations(doc, page, it, dev);
  return dev.chars;
}

/** group characters into lines (same baseline direction, overlapping vertical extent) in content order, then sort */
export function layout(chars: TChar[]): TLine[] {
  const lines: TLine[] = []; let cur: TChar[] = [];
  const flush = () => { if (cur.length) lines.push(makeLine(cur)); cur = []; };
  for (const c of chars) {
    if (!cur.length) { cur.push(c); continue; }
    const p = cur[cur.length - 1];
    const sameDir = Math.abs(angleDiff(c.angle, p.angle)) < 0.05;
    // project onto the previous char's baseline frame
    const rx = (c.x - p.x) * p.dx + (c.y - p.y) * p.dy, ry = -(c.x - p.x) * p.dy + (c.y - p.y) * p.dx;
    const h = Math.max(p.size, c.size);
    const sameLine = sameDir && Math.abs(ry) < h * 0.5 && rx > -h * 1.5 && rx < p.w + h * 12;
    if (sameLine) cur.push(c); else { flush(); cur.push(c); }
  }
  flush();
  // merge fragments that lie on the same baseline (content order may be interleaved), then reading order
  lines.sort((a, b) => (Math.abs(a.y0 - b.y0) > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5 || Math.abs(angleDiff(a.angle, b.angle)) > 0.05 ? b.y0 - a.y0 : a.x0 - b.x0));
  const merged: TLine[] = [];
  for (const l of lines) {
    const m = merged[merged.length - 1];
    if (m && Math.abs(l.angle) < 0.05 && Math.abs(m.angle) < 0.05 && Math.abs(l.y0 - m.y0) < Math.min(l.y1 - l.y0, m.y1 - m.y0) * 0.35 && l.x0 >= m.x1 - 1) merged[merged.length - 1] = makeLine([...m.chars, ...l.chars]);
    else merged.push(l);
  }
  return merged;
}
const angleDiff = (a: number, b: number) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
function makeLine(cs: TChar[]): TLine {
  let text = ""; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (i > 0) {
      const p = cs[i - 1];
      const gap = (c.x - p.x) * p.dx + (c.y - p.y) * p.dy - p.w;
      // a gap wider than ~a quarter em reads as a word break (unless a space glyph already provides it)
      if (gap > Math.max(p.size, c.size) * 0.22 && !/\s$/.test(text) && !/^\s/.test(c.u)) text += " ";
    }
    text += c.u;
    const ex = c.x + c.dx * c.w, ey = c.y + c.dy * c.w;
    x0 = Math.min(x0, c.x, ex); x1 = Math.max(x1, c.x, ex);
    y0 = Math.min(y0, c.y - c.size * 0.22); y1 = Math.max(y1, c.y + c.size * 0.8);
  }
  return { text, chars: cs, x0, y0, x1, y1, angle: cs[0]?.angle ?? 0 };
}
export function pageText(doc: PdfDoc, page: PdfPage, opts: { includeHiddenOC?: boolean } = {}): string { return layout(pageChars(doc, page, opts)).map((l) => l.text).join("\n"); }

export interface Hit { page: number; line: number; start: number; end: number; rects: number[][] }
/** case-insensitive search across the layout; returns per-hit rectangles in user space */
export function search(lines: TLine[], query: string, page: number): Hit[] {
  const q = norm(query); if (!q) return [];
  const out: Hit[] = [];
  lines.forEach((l, li) => {
    // map normalised text positions back to chars (a char may contribute several code units)
    const { text, owner } = normLine(l);
    for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
      const cs = new Set<number>(); for (let k = i; k < i + q.length; k++) if (owner[k] >= 0) cs.add(owner[k]);
      const rects = [...cs].sort((a, b) => a - b).map((ci) => { const c = l.chars[ci]; return [Math.min(c.x, c.x + c.dx * c.w), c.y - c.size * 0.22, Math.max(c.x, c.x + c.dx * c.w), c.y + c.size * 0.8]; });
      out.push({ page, line: li, start: i, end: i + q.length, rects: mergeRects(rects) });
      if (out.length > 10000) return;
    }
  });
  return out;
}
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
function normLine(l: TLine): { text: string; owner: number[] } {
  let text = ""; const owner: number[] = [];
  l.chars.forEach((c, i) => {
    if (i > 0) { const p = l.chars[i - 1]; const gap = (c.x - p.x) * p.dx + (c.y - p.y) * p.dy - p.w; if (gap > Math.max(p.size, c.size) * 0.22 && !text.endsWith(" ")) { text += " "; owner.push(-1); } }
    const n = c.u.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
    for (const ch of n) { if (ch === " " && text.endsWith(" ")) continue; text += ch; for (let k = 0; k < ch.length; k++) owner.push(i); }
  });
  return { text, owner };
}
function mergeRects(rs: number[][]): number[][] {
  const out: number[][] = [];
  for (const r of rs) { const m = out[out.length - 1]; if (m && Math.abs(m[1] - r[1]) < 0.5 && r[0] <= m[2] + 2) { m[2] = Math.max(m[2], r[2]); m[3] = Math.max(m[3], r[3]); } else out.push(r.slice()); }
  return out;
}
export type { Path };
