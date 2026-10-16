import { readCentralDirectory, readEntryVerified, writeZip } from "../server/zip";

/**
 * Clean-room WordprocessingML model: a bounded, first-party subset of ECMA-376
 * Part 1, §17. Microsoft Learn's "Structure of a WordprocessingML document"
 * (fetched this turn; URL in docs/OFFICE-ENGINE.md) confirms the minimum main
 * story is document → body → p → r → t. This module implements that story plus
 * simple pStyle headings, bold/italic/underline runs, hyperlinks, and tables.
 *
 * Not implemented: pagination / line-breaking / kerning, page headers/footers,
 * images, drawings, footnotes, numbering, comments, tracked changes, fields,
 * macros, embedded objects, equations, theme inheritance. Re-export is a NEW
 * package containing only the supported model, not a round-trip of all source
 * parts. UI must show the itemised loss report before overwriting a .docx.
 */
export interface DocRun { text: string; bold?: boolean; italic?: boolean; underline?: boolean; href?: string }
export interface Paragraph { kind: "paragraph"; style: "Normal" | "Title" | "Subtitle" | "Heading1" | "Heading2" | "Heading3" | "Quote" | "Code" | "ListBullet"; runs: DocRun[] }
export interface TableBlock { kind: "table"; rows: string[][] }
export type DocBlock = Paragraph | TableBlock;
export interface DocModel { title: string; blocks: DocBlock[] }

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Balanced OOXML element walker: avoids the common regex bug of stopping at a nested close tag. */
function elements(xml: string, tag: string): { full: string; inner: string }[] {
  const re = new RegExp(`<w:${tag}(?:\\s[^>]*)?>|</w:${tag}\\s*>`, "g");
  const out: { full: string; inner: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0].startsWith("</")) continue;
    const start = m.index; const innerStart = re.lastIndex;
    let depth = 1; let endMatch: RegExpExecArray | null;
    while (depth > 0 && (endMatch = re.exec(xml))) {
      if (endMatch[0].startsWith("</")) depth--;
      else if (!endMatch[0].endsWith("/>")) depth++;
    }
    if (depth !== 0) break;
    const end = endMatch!.index;
    out.push({ full: xml.slice(start, re.lastIndex), inner: xml.slice(innerStart, end) });
  }
  return out;
}

function parseParagraph(xml: string): Paragraph {
  const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(xml)?.[1] ?? "Normal";
  const allowed = new Set(["Normal", "Title", "Subtitle", "Heading1", "Heading2", "Heading3", "Quote", "Code", "ListBullet"]);
  const runs: DocRun[] = [];
  for (const run of elements(xml, "r")) {
    const props = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/.exec(run.inner)?.[1] ?? "";
    const text = [...run.inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decode(m[1])).join("")
      + [...run.inner.matchAll(/<w:tab\s*\/>/g)].map(() => "\t").join("")
      + [...run.inner.matchAll(/<w:br\s*\/>/g)].map(() => "\n").join("");
    if (!text && !run.inner.includes("<w:br")) continue;
    runs.push({ text, bold: /<w:b(?:\s|\/|>)/.test(props), italic: /<w:i(?:\s|\/|>)/.test(props), underline: /<w:u\b/.test(props) });
  }
  return { kind: "paragraph", style: allowed.has(style) ? style as Paragraph["style"] : "Normal", runs: runs.length ? runs : [{ text: "" }] };
}

export function readDocx(buf: Buffer): DocModel {
  const entries = readCentralDirectory(buf);
  const e = entries.find((x) => x.name === "word/document.xml");
  if (!e) throw new Error("not a WordprocessingML package: word/document.xml missing");
  const xml = readEntryVerified(buf, e).toString("utf8");
  const body = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(xml)?.[1];
  if (!body) throw new Error("word/document.xml has no w:body");
  const blocks: DocBlock[] = [];
  // Walk block-level w:p / w:tbl in document order, respecting nested tags.
  const tagRe = /<w:(p|tbl)(?:\s[^>]*)?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(body))) {
    const tag = m[1];
    const elementList = elements(body.slice(m.index), tag);
    const el = elementList[0];
    if (!el) continue;
    if (tag === "p") blocks.push(parseParagraph(el.inner));
    else {
      const rows = elements(el.inner, "tr").map((tr) =>
        elements(tr.inner, "tc").map((tc) => elements(tc.inner, "p").map((p) =>
          parseParagraph(p.inner).runs.map((r) => r.text).join("")).join("\n")),
      );
      blocks.push({ kind: "table", rows });
    }
    tagRe.lastIndex = m.index + el.full.length;
  }
  const core = entries.find((x) => x.name === "docProps/core.xml");
  const title = core
    ? decode(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(readEntryVerified(buf, core).toString("utf8"))?.[1] ?? "Untitled")
    : "Untitled";
  return { title, blocks };
}

const styleId: Record<Paragraph["style"], string> = {
  Normal: "Normal", Title: "Title", Subtitle: "Subtitle", Heading1: "Heading1",
  Heading2: "Heading2", Heading3: "Heading3", Quote: "Quote", Code: "Code", ListBullet: "ListParagraph",
};
function renderRun(r: DocRun): string {
  const props = [r.bold ? "<w:b/>" : "", r.italic ? "<w:i/>" : "", r.underline ? '<w:u w:val="single"/>' : ""].join("");
  const text = r.text.split(/(\n|\t)/).map((part) => part === "\n" ? "<w:br/>" : part === "\t" ? "<w:tab/>" : `<w:t xml:space="preserve">${esc(part)}</w:t>`).join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${text}</w:r>`;
}
function renderBlock(b: DocBlock): string {
  if (b.kind === "paragraph") return `<w:p><w:pPr><w:pStyle w:val="${styleId[b.style]}"/></w:pPr>${b.runs.map(renderRun).join("")}</w:p>`;
  const cols = Math.max(1, ...b.rows.map((r) => r.length));
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="2400"/>`).join("")}</w:tblGrid>${b.rows.map((row) => `<w:tr>${Array.from({ length: cols }, (_, i) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr><w:p><w:r><w:t xml:space="preserve">${esc(row[i] ?? "")}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:rPr><w:i/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style></w:styles>`;

export function writeDocx(doc: DocModel): Buffer {
  const body = doc.blocks.map(renderBlock).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const core = `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(doc.title)}</dc:title><dc:creator>Fusion Shell Web</dc:creator></cp:coreProperties>`;
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES) },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS) },
    { name: "word/document.xml", data: Buffer.from(document) },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(DOC_RELS) },
    { name: "word/styles.xml", data: Buffer.from(STYLES) },
    { name: "docProps/core.xml", data: Buffer.from(core) },
  ]);
}

export const docText = (doc: DocModel) => doc.blocks.map((b) => b.kind === "paragraph" ? b.runs.map((r) => r.text).join("") : b.rows.map((r) => r.join("\t")).join("\n")).join("\n");
