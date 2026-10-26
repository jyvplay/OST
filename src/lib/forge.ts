/**
 * Forge — the format registry (FF-14).
 *
 * grade A: first-party, lossless round-trip
 * grade B: platform engine renders it faithfully, we do not edit it
 * grade C: structural read, visibly approximate
 * grade D: extraction/conversion only, never a round-trip
 * grade E: metadata/header only
 * grade X: not available in this browser (probe decides)
 */
export type Grade = "A" | "B" | "C" | "D" | "E" | "X";

export interface FormatDef {
  ext: string[];
  mime: string;
  label: string;
  engine: string;
  grade: Grade;
  editable: boolean;
  boundary: string;
  /** what is lost when converting out of this format */
  dropsOnExport?: string[];
  capability?: string; // capability id that must be available
}

export const FORMATS: FormatDef[] = [
  { ext: ["txt", "log", "ini", "env"], mime: "text/plain", label: "Plain text", engine: "first-party", grade: "A", editable: true, boundary: "Byte-exact round trip (UTF-8)." },
  { ext: ["md", "markdown"], mime: "text/markdown", label: "Markdown", engine: "first-party", grade: "A", editable: true, boundary: "Source is authoritative; the preview is derived." },
  { ext: ["csv", "tsv"], mime: "text/csv", label: "Delimited text", engine: "first-party RFC-4180 parser", grade: "A", editable: true, boundary: "Quoted fields with embedded commas and newlines are preserved." },
  { ext: ["json"], mime: "application/json", label: "JSON", engine: "first-party", grade: "A", editable: true, boundary: "Reformatting changes whitespace only when you ask." },
  { ext: ["svg"], mime: "image/svg+xml", label: "SVG", engine: "DOM (sanitised)", grade: "A", editable: true, boundary: "Scripts, foreignObject and external references are stripped before render." },
  { ext: ["html", "htm"], mime: "text/html", label: "HTML", engine: "sandboxed frame", grade: "B", editable: true, boundary: "Preview runs in a sandboxed frame with no same-origin access." },
  { ext: ["png", "jpg", "jpeg", "gif", "webp", "bmp"], mime: "image/*", label: "Raster image", engine: "createImageBitmap + canvas", grade: "A", editable: false, boundary: "Decode and convert; re-encoding is lossy for JPEG." },
  { ext: ["avif"], mime: "image/avif", label: "AVIF", engine: "browser decoder", grade: "B", editable: false, boundary: "Decoding depends on the browser build." },
  { ext: ["heic", "heif"], mime: "image/heic", label: "HEIC/HEIF", engine: "ImageDecoder (probe)", grade: "X", editable: false, boundary: "Most browsers cannot decode HEIC. No GPL decoder is bundled; the probe decides.", capability: "imageDecoderHeic" },
  { ext: ["pdf"], mime: "application/pdf", label: "PDF", engine: "PDF app: first-party engine (src/lib/pdf) — parser, decryption (RC4/AES-128/AES-256), fonts (TrueType/CFF/Type 1/Type 3), canvas renderer, text, incremental-update writer", grade: "A", editable: true, boundary: "View, find, copy/export text, annotate, fill forms, rotate/delete/move/insert/merge/extract pages; saves are incremental updates (original bytes kept) or a clean rewrite. JBIG2, JPEG 2000, soft masks and knockout groups render; overprint is not simulated. Signatures: validate, sign (invisible or a visible box in a page corner) with a local or PKCS#12 identity, trust anchors chosen by the user; no RFC 3161 timestamps, OCSP / CRL or system trust store." },
  { ext: ["ai"], mime: "application/illustrator", label: "Adobe Illustrator", engine: "first-party sniffer (src/lib/ai-format.ts) → browser PDF viewer", grade: "B", editable: false, boundary: "Illustrator 9+ files saved with PDF compatibility open through the browser's PDF engine (one page per artboard). Files saved without PDF content, and legacy PostScript-based .ai (Illustrator ≤8), are labelled limited: only creator, version, title and bounding box are shown. Live effects and editability are never interpreted." },
  { ext: ["eps", "ps"], mime: "application/postscript", label: "PostScript / EPS", engine: "first-party DSC header reader (src/lib/ai-format.ts)", grade: "E", editable: false, boundary: "No PostScript interpreter is bundled: creator, title, bounding box and DOS-EPS preview sections are reported; nothing is drawn." },
  { ext: ["docx"], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word document", engine: "Writer: first-party WordprocessingML engine (src/lib/office/wordml.ts) — lossless package edit; converters to Markdown/HTML/text (src/lib/office/convert-word.ts), verified against mammoth on 111 corpus documents", grade: "A", editable: true, boundary: "Opens in Writer with paragraphs, runs, styles, numbering, tables, sections, headers/footers, footnotes, comments, tracked changes, images and fields; saving edits only the changed parts. Converting to Markdown/HTML/text is extraction (grade D for that conversion) and reports what it drops. No pagination engine; OOXML Strict is not read.", dropsOnExport: ["pagination", "comments/tracked changes", "headers/footers", "page/section layout", "fields (current result kept)", "equations (as text)", "text boxes and shapes", "character formatting beyond bold/italic/strike/code", "charts and embedded objects"] },
  { ext: ["xlsx"], mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel workbook", engine: "Spreadsheet module: from-scratch formula engine (src/lib/formula) + xlsx reader/writer and in-place patcher; held-out cached-value agreement 26,869/26,946; CSV export verified against openpyxl on 783 sheets", grade: "A", editable: true, boundary: "Opens in the Spreadsheet module: values, formulas (shared, array, dynamic-array), styles, borders, merged cells, number formats, conditional formatting, data validation, charts, pivot tables, tables, names and hyperlinks; formulas are RE-EVALUATED by our engine. Saving an opened file patches only the edited cells. CSV export writes the displayed values of one sheet (Excel's CSV rules) and reports what it drops. Macros are kept but never run; OOXML Strict is not read.", dropsOnExport: ["formulas (current values written)", "number formats (displayed text written)", "cell styles and borders", "other sheets", "charts, pivot tables and conditional formatting", "merged cells (value in the first cell only)", "comments and hyperlinks", "macros"] },
  { ext: ["fsheet", "fworkbook"], mime: "application/json", label: "Fusion Spreadsheet", engine: "first-party JSON + src/lib/formula", grade: "A", editable: true, boundary: "Native multi-sheet format: exact cell input/formula round trip." },
  { ext: ["fdoc"], mime: "application/json", label: "Fusion Writer document", engine: "first-party structured blocks", grade: "A", editable: true, boundary: "Native paragraph/run/table model." },
  { ext: ["fdeck"], mime: "application/json", label: "Fusion slide deck", engine: "first-party slide model", grade: "A", editable: true, boundary: "Native title/body/notes model." },
  { ext: ["pptx"], mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint deck", engine: "Slides: first-party PresentationML engine (src/lib/office/pml.ts) — lossless package edit; outline converter (src/lib/office/convert-slides.ts), verified against python-pptx on 83 decks / 551 slides", grade: "A", editable: true, boundary: "Opens in Slides with text shapes, tables, pictures, notes, hidden slides, layouts and themes; saving edits only the changed parts. Exporting an outline (Markdown/text) keeps slide titles, text, table cells and optionally notes, and reports what it drops.", dropsOnExport: ["positioning/styles", "images/charts", "animations/transitions", "masters/themes", "speaker notes (unless included)", "hidden slides (unless included)"] },
  { ext: ["zip"], mime: "application/zip", label: "ZIP archive", engine: "Archive app: first-party isomorphic ZIP engine (src/lib/archive) — APPNOTE 6.3 container with ZIP64, stored / deflate / Deflate64 / bzip2 / LZMA, WinZip AES and ZipCrypto read + write; verified against Python zipfile, pyzipper and Info-ZIP", grade: "A", editable: true, boundary: "Browse, preview, extract, add, delete, rename, test and encrypt. Zstandard / XZ / PPMd entries and split archives are refused; zip-slip, symlink, duplicate, overlap and ratio guards block hostile archives. Files are capped at 8 MB each in Files." },
  { ext: ["epub"], mime: "application/epub+zip", label: "EPUB book", engine: "Books app: first-party EPUB 3.3 reader (src/lib/epub) — OCF / package / nav / NCX, reflowable, fixed-layout and roll renditions, verified against the W3C epub-tests (206), the IDPF epub3-samples (45 books) and an lxml OPF oracle (251 books)", grade: "A", editable: false, boundary: "Reading: pages or scrolling, contents, search, themes, spreads, right-to-left, obfuscated fonts. Book scripts never run and remote resources are never loaded; media overlays are not supported. Text extraction (Peek) drops styling, images and links.", dropsOnExport: ["CSS styling", "images", "internal links"] },
  { ext: ["vcf", "vcard"], mime: "text/vcard", label: "vCard contacts", engine: "Contacts: first-party RFC 6350 / RFC 2426 / vCard 2.1 reader, 4.0 writer (src/lib/contacts-core.ts), verified against vobject", grade: "A", editable: true, boundary: "Reads 2.1/3.0/4.0, writes 4.0. Unmodelled properties and parameters (PID, ALTID, LABEL, X-…) are kept verbatim; nested AGENT vCards are skipped with a warning." },
  { ext: ["ics"], mime: "text/calendar", label: "iCalendar", engine: "first-party RFC 5545 reader", grade: "A", editable: true, boundary: "Text round-trips; Planner import reads TZID as local time." },
  { ext: ["psd"], mime: "image/vnd.adobe.photoshop", label: "Photoshop document", engine: "Image Editor: first-party PSD codec (src/lib/image/psd.ts) + compositor (doc.ts), verified both directions against psd-tools' compositor (Δ ≤ 1/255) and against Chromium/Skia for the 16 canvas modes", grade: "A", editable: true, boundary: "8-bit RGB/Grayscale: pixel layers with offsets, opacity, visibility, Unicode names and user masks; layer groups (pass-through and isolated, nested, hidden, group opacity and blend); clipping masks; 26 of Photoshop's 27 blend modes (dissolve is shown as normal) — read, rendered, edited and written (RLE/ZIP/raw). Adjustment/fill/type/smart-object layers render from their stored pixels; layer effects and vector masks are not rendered; clipping to a group is drawn unclipped; PSB, 16/32-bit, CMYK, Lab and Indexed are refused. Each gap is reported on open.", dropsOnExport: ["adjustment layers", "smart objects", "type engine data", "layer effects", "vector masks", "16/32-bit, CMYK, Lab"] },
  { ext: ["psb"], mime: "image/vnd.adobe.photoshop", label: "Photoshop large document", engine: "not supported", grade: "E", editable: false, boundary: "PSB (version 2) is rejected with an explicit message." },
  { ext: ["mp4", "webm", "mkv"], mime: "video/*", label: "Video", engine: "<video> + Media Session", grade: "B", editable: false, boundary: "Playback depends on the browser's codec support." },
  { ext: ["mp3", "wav", "ogg", "opus", "flac"], mime: "audio/*", label: "Audio", engine: "<audio> + WebAudio", grade: "B", editable: false, boundary: "Playback and routing; no editing." },
];

export function formatFor(nameOrPath: string): FormatDef | null {
  const ext = nameOrPath.toLowerCase().split(".").pop() ?? "";
  return FORMATS.find((f) => f.ext.includes(ext)) ?? null;
}

export const GRADE_TEXT: Record<Grade, string> = {
  A: "Full fidelity — first-party engine, lossless round trip.",
  B: "Rendered by the platform engine; we do not modify the file.",
  C: "Structural read; visibly approximate.",
  D: "Extraction and conversion only — not a round trip.",
  E: "Metadata only.",
  X: "Not available in this browser.",
};

export interface LossReport { from: string; to: string; drops: string[]; safe: boolean }

/** FF-11/FF-16: no lossy conversion happens without an itemised list. */
export function lossReport(fromName: string, toExt: string): LossReport {
  const from = formatFor(fromName);
  const to = FORMATS.find((f) => f.ext.includes(toExt.toLowerCase()));
  const drops: string[] = [];
  if (from?.dropsOnExport) drops.push(...from.dropsOnExport);
  if (from && to && from.grade === "A" && to.grade === "A" && from !== to) {
    drops.push(`structure specific to ${from.label} that ${to.label} has no equivalent for`);
  }
  if (to && ["jpg", "jpeg"].includes(toExt)) drops.push("alpha channel", "re-encode generation loss");
  return { from: from?.label ?? fromName, to: to?.label ?? toExt, drops, safe: drops.length === 0 };
}

/** Sanitise SVG before it is ever inserted into the document (FF-04). */
export function sanitizeSvg(src: string): { svg: string; removed: string[] } {
  const removed: string[] = [];
  let out = src;
  const kill = (re: RegExp, what: string) => {
    if (re.test(out)) { removed.push(what); out = out.replace(re, ""); }
  };
  kill(/<script[\s\S]*?<\/script>/gi, "<script>");
  kill(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "<foreignObject>");
  kill(/\son\w+\s*=\s*"[^"]*"/gi, "inline event handlers");
  kill(/\son\w+\s*=\s*'[^']*'/gi, "inline event handlers");
  kill(/xlink:href\s*=\s*"(?!#)[^"]*"/gi, "external references");
  kill(/href\s*=\s*"javascript:[^"]*"/gi, "javascript: urls");
  return { svg: out, removed };
}

/** AX-07: SRT → WebVTT (header, comma→dot timestamps, numeric cue ids dropped). */
export function toVtt(src: string): string {
  if (src.trimStart().startsWith("WEBVTT")) return src;
  return "WEBVTT\n\n" + src.replace(/\r/g, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/^\d+\n(?=\d{2}:\d{2})/gm, "");
}

/** RFC-4180 parser — quoted commas and newlines survive (FF-09). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n");
}
