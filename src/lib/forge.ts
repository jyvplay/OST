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
  { ext: ["pdf"], mime: "application/pdf", label: "PDF", engine: "browser PDF viewer (<embed>)", grade: "B", editable: false, boundary: "Rendered by the browser; annotations are stored as a sidecar, never written into the file." },
  { ext: ["docx"], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", label: "Word document", engine: "Writer: first-party WordprocessingML subset", grade: "C", editable: true, boundary: "Paragraphs, headings, runs, and simple tables. No pagination/layout engine.", dropsOnExport: ["pagination", "images/drawings", "headers/footers", "footnotes", "numbering", "comments/tracked changes", "fields/macros", "themes"] },
  { ext: ["xlsx"], mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", label: "Excel workbook", engine: "Spreadsheet module: from-scratch formula engine (src/lib/formula), verified against real LibreOffice", grade: "B", editable: true, boundary: "Opens in the Spreadsheet module: cell values AND formulas are read and RE-EVALUATED by our own engine (~70 functions). Charts, pivot tables, conditional formatting and macros are not read (Peek still offers grade-D text extraction as a fallback).", dropsOnExport: ["charts", "pivot tables", "conditional formatting", "macros", "cell styling beyond bold/basic"] },
  { ext: ["fsheet", "fworkbook"], mime: "application/json", label: "Fusion Spreadsheet", engine: "first-party JSON + src/lib/formula", grade: "A", editable: true, boundary: "Native multi-sheet format: exact cell input/formula round trip." },
  { ext: ["fdoc"], mime: "application/json", label: "Fusion Writer document", engine: "first-party structured blocks", grade: "A", editable: true, boundary: "Native paragraph/run/table model." },
  { ext: ["fdeck"], mime: "application/json", label: "Fusion slide deck", engine: "first-party slide model", grade: "A", editable: true, boundary: "Native title/body/notes model." },
  { ext: ["pptx"], mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", label: "PowerPoint deck", engine: "Slides: first-party PresentationML text subset", grade: "C", editable: true, boundary: "Title/body text shapes and slide order; export is a new minimal package, not a lossless edit.", dropsOnExport: ["positioning/styles", "images/charts", "notes", "animations/transitions", "masters/themes"] },
  { ext: ["zip"], mime: "application/zip", label: "ZIP archive", engine: "central-directory parser + DecompressionStream", grade: "B", editable: false, boundary: "Browse without extracting. Zip-slip and ratio guards reject hostile archives." },
  { ext: ["epub"], mime: "application/epub+zip", label: "EPUB book", engine: "server: OPF spine reader", grade: "C", editable: false, boundary: "Text in spine order; styling, images and links are dropped.", dropsOnExport: ["CSS styling", "images", "internal links"] },
  { ext: ["ics"], mime: "text/calendar", label: "iCalendar", engine: "first-party RFC 5545 reader", grade: "A", editable: true, boundary: "Text round-trips; Planner import reads TZID as local time." },
  { ext: ["psd", "psb"], mime: "image/vnd.adobe.photoshop", label: "Photoshop document", engine: "header parser", grade: "E", editable: false, boundary: "Dimensions, colour mode and layer count only. Layer editing is not offered." },
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
