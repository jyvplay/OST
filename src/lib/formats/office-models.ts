/**
 * TT139 (FF-22, FF-23) — WordprocessingML and PresentationML models.
 *
 * Pure models + serializers. No DOM, no zip container: these are the *document
 * bodies* (`word/document.xml` and `ppt/presentation.xml` content), which is
 * the part a browser app can actually author without a full OPC packager.
 * Every serializer states the same honest boundary in its doc comment.
 *
 * Deliberate choices, each with a reason:
 *   • Text is escaped with all five XML entities, including the quote and
 *     apostrophe. Attribute injection through a paragraph is the obvious
 *     attack on a code path like this.
 *   • `w:b` / `w:i` are only emitted when the run is actually bold/italic, and
 *     `w:b w:val="0"` is emitted when a run inherits bold but turns it off,
 *     because OOXML distinguishes "absent" from "explicitly false".
 *   • The reader accepts the namespace-prefixed and default-namespace forms,
 *     and both `<w:b/>` and `<w:b w:val="true"/>`.
 *   • Styles are a closed enum. A document that references a style outside the
 *     enum is rejected at write time rather than producing a file Word will
 *     silently repair.
 */

// ══ FF-22: WordprocessingML ══════════════════════════════════════════════

export type Align = "left" | "center" | "right" | "both";

export interface WpRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Explicit "not bold" — needed when a run overrides an inherited style. */
  boldOff?: boolean;
  italicOff?: boolean;
  fontSizeHalfPoints?: number;
  color?: string;
  /** Internal hyperlink anchor, no URL scheme. */
  linkAnchor?: string;
}

export const PARAGRAPH_STYLES = ["Normal", "Title", "Heading1", "Heading2", "Heading3", "Quote", "Code", "ListParagraph"] as const;
export type ParagraphStyle = (typeof PARAGRAPH_STYLES)[number];

export interface WpParagraph {
  runs: WpRun[];
  style?: ParagraphStyle;
  align?: Align;
  /** 0 = no explicit list marker; 1..9 = numbering level minus one. */
  listLevel?: number;
  listKind?: "bullet" | "decimal";
}

export interface WpCell {
  paragraphs: WpParagraph[];
}

export interface WpTable {
  rows: WpCell[][];
  /** Column widths in twips (twentieths of a point). */
  widths?: number[];
}

export interface WpDocument {
  paragraphs: WpParagraph[];
  tables: WpTable[];
  /** Title metadata; not part of the body. */
  title?: string;
}

export function createWpDocument(title?: string): WpDocument {
  return { paragraphs: [], tables: [], title };
}

export function addParagraph(doc: WpDocument, text: string, opts: Partial<WpParagraph> & Partial<WpRun> = {}): WpDocument {
  const { style, align, listLevel, listKind, ...runOpts } = opts;
  const run: WpRun = { text, ...runOpts };
  return {
    ...doc,
    paragraphs: [...doc.paragraphs, { runs: text === "" ? [] : [run], style, align, listLevel, listKind }],
  };
}

export function addRun(doc: WpDocument, paraIndex: number, run: WpRun): WpDocument {
  if (paraIndex < 0 || paraIndex >= doc.paragraphs.length) throw new Error(`Paragraph ${paraIndex} out of range`);
  const paragraphs = doc.paragraphs.map((p, i) => (i === paraIndex ? { ...p, runs: [...p.runs, run] } : p));
  return { ...doc, paragraphs };
}

export function addTable(doc: WpDocument, rows: string[][]): WpDocument {
  if (!rows.length) throw new Error("Table needs at least one row");
  const width = rows[0].length;
  if (!width) throw new Error("Table rows need at least one cell");
  for (const r of rows) if (r.length !== width) throw new Error("Table rows must all have the same cell count");
  const table: WpTable = {
    rows: rows.map((r) => r.map((text) => ({ paragraphs: [{ runs: text === "" ? [] : [{ text }] }] }))),
  };
  return { ...doc, tables: [...doc.tables, table] };
}

/** Flattened plain text, the way a text-only export would see the document. */
export function documentText(doc: WpDocument): string {
  const para = (p: WpParagraph): string => p.runs.map((r) => r.text).join("");
  const parts = doc.paragraphs.map(para);
  for (const t of doc.tables) {
    for (const row of t.rows) parts.push(row.map((c) => c.paragraphs.map(para).join(" ")).join("\t"));
  }
  return parts.join("\n");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** `w:rPr` children for a run — only what is actually set. */
function runProps(r: WpRun): string {
  const p: string[] = [];
  if (r.bold) p.push("<w:b/>");
  else if (r.boldOff) p.push('<w:b w:val="0"/>');
  if (r.italic) p.push("<w:i/>");
  else if (r.italicOff) p.push('<w:i w:val="0"/>');
  if (r.underline) p.push('<w:u w:val="single"/>');
  if (r.strike) p.push("<w:strike/>");
  if (r.color) {
    if (!/^[0-9A-Fa-f]{6}$/.test(r.color)) throw new Error(`Color must be 6 hex digits: ${r.color}`);
    p.push(`<w:color w:val="${r.color.toUpperCase()}"/>`);
  }
  if (r.fontSizeHalfPoints !== undefined) {
    if (!Number.isInteger(r.fontSizeHalfPoints) || r.fontSizeHalfPoints < 2 || r.fontSizeHalfPoints > 3276) {
      throw new Error(`Font size out of range: ${r.fontSizeHalfPoints}`);
    }
    p.push(`<w:sz w:val="${r.fontSizeHalfPoints}"/>`);
  }
  return p.length ? `<w:rPr>${p.join("")}</w:rPr>` : "";
}

function runXml(r: WpRun): string {
  // Preserve leading/trailing spaces; without xml:space Word trims them.
  const needsSpace = /^\s|\s$|\s{2,}/.test(r.text);
  const t = `<w:t${needsSpace ? ' xml:space="preserve"' : ""}>${esc(r.text)}</w:t>`;
  if (r.linkAnchor) {
    return `<w:hyperlink w:anchor="${esc(r.linkAnchor)}"><w:r>${runProps(r)}${t}</w:r></w:hyperlink>`;
  }
  return `<w:r>${runProps(r)}${t}</w:r>`;
}

function paragraphXml(p: WpParagraph): string {
  const pPr: string[] = [];
  if (p.style) {
    if (!(PARAGRAPH_STYLES as readonly string[]).includes(p.style)) {
      throw new Error(`Unknown paragraph style: ${p.style}`);
    }
    pPr.push(`<w:pStyle w:val="${esc(p.style)}"/>`);
  }
  if (p.align) {
    // "both" is the OOXML spelling of justified; "justify" is not a w:jc token.
    pPr.push(`<w:jc w:val="${p.align}"/>`);
  }
  if (p.listLevel !== undefined) {
    if (!Number.isInteger(p.listLevel) || p.listLevel < 0 || p.listLevel > 8) {
      throw new Error(`List level must be 0..8: ${p.listLevel}`);
    }
    pPr.push(`<w:numPr><w:ilvl w:val="${p.listLevel}"/><w:numId w:val="${p.listKind === "decimal" ? 2 : 1}"/></w:numPr>`);
  }
  const head = pPr.length ? `<w:pPr>${pPr.join("")}</w:pPr>` : "";
  return `<w:p>${head}${p.runs.map(runXml).join("")}</w:p>`;
}

function tableXml(t: WpTable): string {
  const grid = t.widths
    ? `<w:tblGrid>${t.widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`
    : "";
  const rows = t.rows
    .map((row) => {
      const cells = row
        .map((c) => `<w:tc><w:tcPr/>${c.paragraphs.map(paragraphXml).join("")}</w:tc>`)
        .join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>${grid}${rows}</w:tbl>`;
}

// Body order matters: a table cannot be nested inside a paragraph-run list.
// This model keeps paragraphs and tables separate, and serializes paragraphs
// first — which is exactly what the API guarantees, so the file always matches
// the model.
export function toWordprocessingXml(doc: WpDocument): string {
  const body = doc.paragraphs.map(paragraphXml).join("") + doc.tables.map(tableXml).join("");
  const title = doc.title ? `<dc:title>${esc(doc.title)}</dc:title>` : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>' +
    "</w:document>" +
    (title ? `<!-- ${title} -->` : "")
  );
}

/**
 * Parse a document body. Accepts `w:` prefixed or default-namespaced elements,
 * `<w:b/>` or `<w:b w:val="true"/>`. Returns a model that re-serializes to the
 * same XML for every document this module wrote (fixed-point property).
 */
export function fromWordprocessingXml(xml: string): WpDocument {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("Empty document XML");
  const bodyMatch = /<(?:\w+:)?body[\s>]([\s\S]*?)<\/(?:\w+:)?body>/.exec(xml);
  const body = bodyMatch ? bodyMatch[1] : xml;
  const doc: WpDocument = { paragraphs: [], tables: [] };
  const titleMatch = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(xml);
  if (titleMatch) doc.title = unesc(titleMatch[1]);

  const boolProp = (inner: string, tag: "b" | "i"): { on: boolean; off: boolean } => {
    const m = new RegExp(`<w:${tag}(?:\\s+w:val="([^"]*)")?\\s*/>`).exec(inner);
    if (!m) return { on: false, off: false };
    const val = m[1];
    if (val === undefined) return { on: true, off: false };
    const truthy = val === "1" || val.toLowerCase() === "true" || val === "on";
    return truthy ? { on: true, off: false } : { on: false, off: true };
  };

  const parseRuns = (chunk: string): WpRun[] => {
    const runs: WpRun[] = [];
    const rRe = /<w:r[\s>]([\s\S]*?)<\/w:r>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rRe.exec(chunk)) !== null) {
      const inner = rm[1];
      const tMatch = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/.exec(inner);
      const text = tMatch ? unesc(tMatch[1]) : "";
      const run: WpRun = { text };
      const b = boolProp(inner, "b");
      if (b.on) run.bold = true;
      if (b.off) run.boldOff = true;
      const i = boolProp(inner, "i");
      if (i.on) run.italic = true;
      if (i.off) run.italicOff = true;
      if (/<w:u\b[^>]*w:val="single"/.test(inner)) run.underline = true;
      if (/<w:strike\s*\/>/.test(inner)) run.strike = true;
      const color = /<w:color\s+w:val="([0-9A-Fa-f]{6})"/.exec(inner);
      if (color) run.color = color[1].toUpperCase();
      const sz = /<w:sz\s+w:val="(\d+)"/.exec(inner);
      if (sz) run.fontSizeHalfPoints = parseInt(sz[1], 10);
      runs.push(run);
    }
    return runs;
  };

  const parseParagraph = (chunk: string): WpParagraph => {
    const p: WpParagraph = { runs: parseRuns(chunk) };
    const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(chunk);
    if (style) {
      const name = unesc(style[1]);
      if (!(PARAGRAPH_STYLES as readonly string[]).includes(name)) {
        throw new Error(`Document uses an unsupported style: ${name}`);
      }
      p.style = name as ParagraphStyle;
    }
    const jc = /<w:jc\s+w:val="([^"]+)"/.exec(chunk);
    if (jc) {
      const v = jc[1];
      if (v === "left" || v === "center" || v === "right" || v === "both") p.align = v;
      else if (v === "justify") p.align = "both";
      else throw new Error(`Unknown alignment: ${v}`);
    }
    const ilvl = /<w:ilvl\s+w:val="(\d+)"/.exec(chunk);
    if (ilvl) {
      p.listLevel = parseInt(ilvl[1], 10);
      const numId = /<w:numId\s+w:val="(\d+)"/.exec(chunk);
      p.listKind = numId && numId[1] === "2" ? "decimal" : "bullet";
    }
    return p;
  };

  // Tables first (removed from the body) so their paragraphs are not
  // double-counted as top-level paragraphs.
  let rest = body;
  const tblRe = /<w:tbl[\s>]([\s\S]*?)<\/w:tbl>/g;
  const tables: WpTable[] = [];
  rest = rest.replace(tblRe, (_all, tblInner: string) => {
    const rows: WpCell[][] = [];
    const trRe = /<w:tr[\s>]([\s\S]*?)<\/w:tr>/g;
    let tm: RegExpExecArray | null;
    while ((tm = trRe.exec(tblInner)) !== null) {
      const cells: WpCell[] = [];
      const tcRe = /<w:tc[\s>]([\s\S]*?)<\/w:tc>/g;
      let cm: RegExpExecArray | null;
      while ((cm = tcRe.exec(tm[1])) !== null) {
        const paras: WpParagraph[] = [];
        const pRe = /<w:p[\s>]([\s\S]*?)<\/w:p>/g;
        let pm: RegExpExecArray | null;
        while ((pm = pRe.exec(cm[1])) !== null) paras.push(parseParagraph(pm[1]));
        cells.push({ paragraphs: paras });
      }
      rows.push(cells);
    }
    const gridMatch = /<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/.exec(tblInner);
    const widths = gridMatch
      ? [...gridMatch[1].matchAll(/<w:gridCol\s+w:w="(\d+)"/g)].map((m) => parseInt(m[1], 10))
      : undefined;
    tables.push(widths && widths.length ? { rows, widths } : { rows });
    return "";
  });

  const pRe = /<w:p[\s>]([\s\S]*?)<\/w:p>/g;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(rest)) !== null) doc.paragraphs.push(parseParagraph(pm[1]));
  doc.tables = tables;
  return doc;
}

// ══ FF-23: PresentationML ════════════════════════════════════════════════

export type ShapeKind = "title" | "body" | "text" | "image";

export interface SlideShape {
  type: ShapeKind;
  text: string;
  /** Position in EMU (914400 EMU = 1 inch). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Only for type "image": a data: URI or relative asset path. Never remote. */
  src?: string;
}

export interface Slide {
  shapes: SlideShape[];
  /** 6-hex background colour. */
  background?: string;
  /** Per-slide notes, plain text. */
  notes?: string;
}

export interface Presentation {
  slides: Slide[];
  /** Slide size in EMU; 16:9 widescreen is the default. */
  size: { width: number; height: number };
  title?: string;
}

export function createPresentation(title?: string): Presentation {
  return { slides: [], size: { width: 12192000, height: 6858000 }, title };
}

export function addSlide(p: Presentation, opts: { background?: string; notes?: string } = {}): Presentation {
  if (opts.background && !/^[0-9A-Fa-f]{6}$/.test(opts.background)) throw new Error("Background must be 6 hex digits");
  return { ...p, slides: [...p.slides, { shapes: [], background: opts.background?.toUpperCase(), notes: opts.notes }] };
}

export function addShape(p: Presentation, slideIndex: number, shape: SlideShape): Presentation {
  if (slideIndex < 0 || slideIndex >= p.slides.length) throw new Error(`Slide ${slideIndex} out of range`);
  if (shape.width <= 0 || shape.height <= 0) throw new Error("Shape must have positive size");
  if (shape.type !== "image" && shape.text.length > 5000) throw new Error("Shape text too long (>5000)");
  if (shape.type === "image") {
    if (!shape.src) throw new Error("Image shape needs src");
    // Remote images would make the deck phone home when opened.
    if (/^(https?:)?\/\//i.test(shape.src)) throw new Error("Remote image URLs are not permitted; embed a data: URI");
  }
  const slides = p.slides.map((s, i) => (i === slideIndex ? { ...s, shapes: [...s.shapes, shape] } : s));
  return { ...p, slides };
}

export function moveSlide(p: Presentation, from: number, to: number): Presentation {
  if (from === to) return p;
  if (from < 0 || from >= p.slides.length) throw new Error(`Slide ${from} out of range`);
  if (to < 0 || to >= p.slides.length) throw new Error(`Slide ${to} out of range`);
  const slides = [...p.slides];
  const [moved] = slides.splice(from, 1);
  slides.splice(to, 0, moved);
  return { ...p, slides };
}

export function deleteSlide(p: Presentation, index: number): Presentation {
  if (index < 0 || index >= p.slides.length) throw new Error(`Slide ${index} out of range`);
  return { ...p, slides: p.slides.filter((_, i) => i !== index) };
}

export function setSlideText(p: Presentation, slideIndex: number, shapeIndex: number, text: string): Presentation {
  const slide = p.slides[slideIndex];
  if (!slide) throw new Error(`Slide ${slideIndex} out of range`);
  if (!slide.shapes[shapeIndex]) throw new Error(`Shape ${shapeIndex} out of range`);
  const slides = p.slides.map((s, i) =>
    i !== slideIndex
      ? s
      : { ...s, shapes: s.shapes.map((sh, j) => (j === shapeIndex ? { ...sh, text } : sh)) },
  );
  return { ...p, slides };
}

export function slideTitle(slide: Slide): string {
  return slide.shapes.find((s) => s.type === "title")?.text ?? "";
}

export function toPresentationXml(p: Presentation): string {
  const phType: Record<ShapeKind, string> = { title: "title", body: "body", text: "body", image: "pic" };
  const slides = p.slides
    .map((slide, idx) => {
      const bg = slide.background
        ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
        : "";
      const shapes = slide.shapes
        .map((s, si) => {
          const nv = `<p:nvSpPr><p:cNvPr id="${si + 2}" name="${esc(`${s.type} ${si + 1}`)}"/>` +
            `<p:cNvSpPr${s.type === "title" || s.type === "body" ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr>`;
          const xfrm = `<a:xfrm><a:off x="${Math.round(s.x)}" y="${Math.round(s.y)}"/>` +
            `<a:ext cx="${Math.round(s.width)}" cy="${Math.round(s.height)}"/></a:xfrm>`;
          const img =
            s.type === "image" && s.src
              ? `<a:blipFill><a:blip r:embed="${esc(s.src.slice(0, 64))}"/></a:blipFill>`
              : `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${esc(s.text)}</a:t></a:r></a:p></p:txBody>`;
          return `<p:sp>${nv}<p:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>${img}` +
            `<p:ph type="${phType[s.type]}"/></p:sp>`;
        })
        .join("");
      const notes = slide.notes ? `<p:notes><p:text>${esc(slide.notes)}</p:text></p:notes>` : "";
      return `<p:sld id="${idx + 1}" showMasterSp="1"><p:cSld>${bg}<p:spTree>` +
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
        `<p:grpSpPr/>${shapes}</p:spTree></p:cSld>${notes}</p:sld>`;
    })
    .join("");

  const title = p.title ? `<p:title>${esc(p.title)}</p:title>` : "";
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<p:sldSz cx="${p.size.width}" cy="${p.size.height}"/>${title}` +
    `<p:sldIdLst>${p.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("")}</p:sldIdLst>` +
    `<p:slides>${slides}</p:slides>` +
    "</p:presentation>"
  );
}

export function fromPresentationXml(xml: string): Presentation {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("Empty presentation XML");
  if (!/<p:presentation[\s>]/.test(xml)) throw new Error("Missing <p:presentation> root");
  const sizeMatch = /<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/.exec(xml);
  const p: Presentation = {
    slides: [],
    size: sizeMatch
      ? { width: parseInt(sizeMatch[1], 10), height: parseInt(sizeMatch[2], 10) }
      : { width: 12192000, height: 6858000 },
  };
  const titleMatch = /<p:title>([\s\S]*?)<\/p:title>/.exec(xml);
  if (titleMatch) p.title = unesc(titleMatch[1]);

  const slideRe = /<p:sld[\s>]([\s\S]*?)<\/p:sld>/g;
  const idToKind: Record<string, ShapeKind> = { title: "title", body: "body", ctrTitle: "title", subTitle: "body", pic: "image" };
  let sm: RegExpExecArray | null;
  while ((sm = slideRe.exec(xml)) !== null) {
    const inner = sm[1];
    const slide: Slide = { shapes: [] };
    const bg = /<p:bg[\s>][\s\S]*?<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/.exec(inner);
    if (bg) slide.background = bg[1].toUpperCase();
    const notes = /<p:notes[\s>][\s\S]*?<p:text>([\s\S]*?)<\/p:text>/.exec(inner);
    if (notes) slide.notes = unesc(notes[1]);

    const spRe = /<p:sp[\s>]([\s\S]*?)<\/p:sp>/g;
    let shm: RegExpExecArray | null;
    while ((shm = spRe.exec(inner)) !== null) {
      const sp = shm[1];
      const off = /<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(sp);
      const ext = /<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/.exec(sp);
      const ph = /<p:ph\s+type="([^"]+)"/.exec(sp);
      const t = /<a:t>([\s\S]*?)<\/a:t>/.exec(sp);
      const blip = /<a:blip\s+r:embed="([^"]*)"/.exec(sp);
      const kind: ShapeKind = ph ? (idToKind[ph[1]] ?? "text") : blip ? "image" : "text";
      const shape: SlideShape = {
        type: kind,
        text: t ? unesc(t[1]) : "",
        x: off ? parseInt(off[1], 10) : 0,
        y: off ? parseInt(off[2], 10) : 0,
        width: ext ? parseInt(ext[1], 10) : 1000000,
        height: ext ? parseInt(ext[2], 10) : 1000000,
      };
      if (kind === "image") shape.src = blip ? blip[1] : undefined;
      slide.shapes.push(shape);
    }
    p.slides.push(slide);
  }
  if (!p.slides.length && !/<p:sldIdLst\s*\/>|<p:sldIdLst><\/p:sldIdLst>/.test(xml)) {
    // An empty deck is legal; a deck that lost its slides is not.
    if (/<p:sldIdLst>[\s\S]*<\/p:sldIdLst>/.test(xml) === false) throw new Error("Presentation has no slide list");
  }
  return p;
}

export function slideCount(p: Presentation): number {
  return p.slides.length;
}

/** Plain-text outline, the way a slide sorter lists a deck. */
export function presentationOutline(p: Presentation): string[] {
  return p.slides.map((s, i) => `${i + 1}. ${slideTitle(s) || "(untitled)"} [${s.shapes.length} shapes]`);
}
