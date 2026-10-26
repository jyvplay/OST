/**
 * TT74 (FF-02): PresentationML deck → outline Markdown / plain text, original code.
 * Reading order per slide = shape-tree document order (z-order), groups recursed, mc:AlternateContent resolved to the
 * branch PowerPoint 2007 reads (pml.altContent); tables read cell by cell; pictures by their alt text; speaker notes
 * from the notes slide's body placeholder; hidden slides marked. Every dropped construct is counted in `loss`.
 */
import { attr, kid, kids, type XEl } from "./xmltree";
import { type PptxDoc, spTreeOf, shapeKids, altContent, phOf, txBodyOf, paragraphsOf, paraText, notesText, isHidden, cNvPrOf } from "./pml";

export interface SPara { text: string; lvl: number; bullet: boolean }
export type SShape =
  | { k: "text"; ph: string; paras: SPara[]; alt?: boolean }
  | { k: "table"; rows: string[][]; alt?: boolean }
  | { k: "pic"; alt: string; fromAlt?: boolean }
  | { k: "other"; what: string; alt?: boolean };
export interface SSlide { n: number; hidden: boolean; title: string; /** index of the title shape in `shapes` (-1: none) */ titleAt: number; shapes: SShape[]; notes: string }
export interface SDeck { slides: SSlide[]; loss: string[] }

const TITLE_PH = new Set(["title", "ctrTitle"]);
function paras(tx: XEl | undefined): SPara[] {
  return paragraphsOf(tx).map((p) => {
    const pPr = kid(p, "a:pPr");
    const lvl = Number(attr(pPr, "lvl") ?? 0) || 0;
    const bullet = !kid(pPr, "a:buNone") && (!!kid(pPr, "a:buChar") || !!kid(pPr, "a:buAutoNum"));
    return { text: paraText(p).replace(/\v/g, "\n"), lvl, bullet };
  });
}
function tableRows(gf: XEl): string[][] | null {
  const tbl = kid(kid(kid(gf, "a:graphic"), "a:graphicData"), "a:tbl");
  if (!tbl) return null;
  return kids(tbl, "a:tr").map((tr) => kids(tr, "a:tc").filter((tc) => attr(tc, "hMerge") !== "1" && attr(tc, "vMerge") !== "1").map((tc) => paragraphsOf(kid(tc, "a:txBody")).map((p) => paraText(p).replace(/\v/g, "\n")).join("\n")));
}

export function deckToIR(d: PptxDoc): SDeck {
  const loss = new Map<string, number>();
  const lose = (k: string, n = 1) => loss.set(k, (loss.get(k) ?? 0) + n);
  const slides = d.slides.map((s, i): SSlide => {
    const shapes: SShape[] = [];
    const walk = (tree: XEl | undefined, fromAlt: boolean, depth: number) => {
      if (depth > 64) return;
      for (const k0 of shapeKids(tree)) {
        const alt = fromAlt || k0.name === "mc:AlternateContent";
        const e = k0.name === "mc:AlternateContent" ? altContent(k0) : k0;
        if (!e) continue;
        switch (e.name) {
          case "p:grpSp": walk(e, alt, depth + 1); break;
          case "p:sp": case "p:cxnSp": {
            const tx = txBodyOf(e);
            if (tx) shapes.push({ k: "text", ph: phOf(e)?.type ?? "", paras: paras(tx), ...(alt ? { alt: true } : {}) });
            break;
          }
          case "p:graphicFrame": {
            const rows = tableRows(e);
            if (rows) { shapes.push({ k: "table", rows, ...(alt ? { alt: true } : {}) }); break; }
            const uri = attr(kid(kid(e, "a:graphic"), "a:graphicData"), "uri") ?? "";
            const what = uri.endsWith("/chart") ? "chart" : uri.includes("diagram") ? "SmartArt diagram" : uri.includes("ole") ? "embedded object" : "graphic frame";
            shapes.push({ k: "other", what, ...(alt ? { alt: true } : {}) }); lose(`${what}s (not converted; only their name is kept)`);
            break;
          }
          case "p:pic": {
            const c = cNvPrOf(e);
            const isMedia = !!kid(kid(e, "p:nvPicPr"), "p:nvPr") && kids(kid(kid(e, "p:nvPicPr"), "p:nvPr")).some((x) => x.name === "a:videoFile" || x.name === "a:audioFile" || x.name === "p:extLst");
            shapes.push({ k: "pic", alt: (attr(c, "descr") ?? "").trim() || attr(c, "title") || attr(c, "name") || "picture", ...(alt ? { fromAlt: true } : {}) });
            lose(isMedia ? "pictures / media (alt text kept, binary not embedded)" : "pictures (alt text kept, binary not embedded)");
            break;
          }
          default: lose(`${e.name} elements`);
        }
      }
    };
    walk(spTreeOf(s.xml), false, 0);
    const ti = shapes.findIndex((x) => x.k === "text" && TITLE_PH.has(x.ph));
    const title = ti >= 0 ? (shapes[ti] as { paras: SPara[] }).paras.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim() : "";
    if (findTransitionOrAnim(s.xml.root)) lose("slides with transitions / animations (dropped)");
    return { n: i + 1, hidden: isHidden(s), title, titleAt: ti, shapes, notes: notesText(d, i) };
  });
  lose("slide layout, positions, themes and formatting (an outline keeps text structure only)", slides.length ? 1 : 0);
  return { slides, loss: [...loss].filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`) };
}
function findTransitionOrAnim(root: XEl): boolean { return !!kid(root, "p:transition") || !!kid(root, "p:timing") || kids(root).some((k) => k.name === "mc:AlternateContent" && JSON.stringify(k).includes("p:transition")); }

const mdEsc = (t: string) => t.replace(/([\\`*_[\]<>|~])/g, "\\$1").replace(/^(#{1,6}\s|[-+]\s|\d+[.)]\s|>)/, "\\$1");
/** Always lost by an outline: the slide is reduced to its text in reading order. */
export const LAYOUT_LOSS = "shape positions and sizes, fonts, colours, backgrounds, layouts/masters, transitions and animations";
export function deckToMarkdown(d: PptxDoc, o: { notes?: boolean; hidden?: boolean } = {}): { md: string; loss: string[] } {
  const ir = deckToIR(d);
  const out: string[] = [];
  for (const s of ir.slides) {
    if (s.hidden && o.hidden === false) continue;
    out.push(`## ${s.n}. ${s.title ? mdEsc(s.title) : "(untitled slide)"}${s.hidden ? " *(hidden)*" : ""}`);
    for (const [j, sh] of s.shapes.entries()) {
      if (j === s.titleAt) continue;
      if (sh.k === "text") {
        const lines: string[] = [];
        for (const p of sh.paras) {
          if (!p.text.trim()) continue;
          const body = p.text.split("\n").map(mdEsc).join("\\\n" + "  ".repeat(p.lvl + 1));
          lines.push(sh.ph === "body" || sh.ph === "obj" || p.bullet || p.lvl > 0 ? `${"  ".repeat(p.lvl)}- ${body}` : body);
        }
        if (lines.length) out.push(lines.join("\n"));
      } else if (sh.k === "table") {
        const cols = Math.max(1, ...sh.rows.map((r) => r.length));
        const cell = (t: string | undefined) => (t ?? "").split("\n").map(mdEsc).join("<br>") || " ";
        const rows = sh.rows.map((r) => `| ${Array.from({ length: cols }, (_, k) => cell(r[k])).join(" | ")} |`);
        if (rows.length) { rows.splice(1, 0, `|${" --- |".repeat(cols)}`); out.push(rows.join("\n")); }
      } else if (sh.k === "pic") out.push(`*[Picture: ${mdEsc(sh.alt)}]*`);
      else out.push(`*[${sh.what}]*`);
    }
    if (o.notes !== false && s.notes.trim()) out.push(s.notes.split("\n").map((l, k) => `> ${k === 0 ? "**Notes:** " : ""}${mdEsc(l)}`).join("\n"));
  }
  const loss = [...ir.loss];
  const hid = ir.slides.filter((s) => s.hidden).length, noted = ir.slides.filter((s) => s.notes.trim() && !(s.hidden && o.hidden === false)).length;
  if (hid && o.hidden === false) loss.push(`${hid} hidden slide(s) (left out)`);
  if (noted && o.notes === false) loss.push(`speaker notes of ${noted} slide(s) (left out)`);
  loss.push(LAYOUT_LOSS);
  return { md: out.join("\n\n") + "\n", loss };
}
export function deckToText(d: PptxDoc): { text: string; loss: string[] } {
  const ir = deckToIR(d);
  const out: string[] = [];
  for (const s of ir.slides) {
    const lines = [`Slide ${s.n}${s.hidden ? " (hidden)" : ""}: ${s.title}`];
    for (const [j, sh] of s.shapes.entries()) {
      if (j === s.titleAt) continue;
      if (sh.k === "text") for (const p of sh.paras) { if (p.text.trim()) lines.push(`${"  ".repeat(p.lvl)}${p.text}`); }
      else if (sh.k === "table") for (const r of sh.rows) lines.push(r.join("\t"));
      else if (sh.k === "pic") lines.push(`[Picture: ${sh.alt}]`);
      else lines.push(`[${sh.what}]`);
    }
    if (s.notes.trim()) lines.push(`Notes: ${s.notes}`);
    out.push(lines.join("\n"));
  }
  return { text: out.join("\n\n") + "\n", loss: [...ir.loss, LAYOUT_LOSS, "all text formatting (plain text)"] };
}
