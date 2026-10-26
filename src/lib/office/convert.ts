/**
 * TT74 (FF-02): one entry point for document conversion — used by the Forge API (server) and the apps (client).
 *   .docx → Markdown / HTML / text      (readWord → convert-word; verified against mammoth on the POI corpus)
 *   .md   → .docx                       (md2docx; verified against markdown-it-py + mammoth on 386 READMEs)
 *   .xlsx → CSV / TSV (per sheet)       (readXlsxWorkbook → formula/csv; verified against openpyxl)
 *   .csv  → .xlsx                       (formula/csv typing → writeXlsxWorkbook)
 *   .pptx → outline Markdown / text     (readPptxDoc → convert-slides; verified against python-pptx)
 * Every result carries an itemised, content-specific loss list (FF-11/FF-16: no silent lossy conversion).
 */
import { readWord } from "./wordml";
import { wordToMarkdown, wordToHtml, wordToText, wordConversionLoss } from "./convert-word";
import { markdownToDocx } from "./md2docx";
import { readPptxDoc } from "./pml";
import { deckToMarkdown, deckToText } from "./convert-slides";
import { openZip, fromUtf8 } from "./zipkit";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../formula/xlsx";
import { sheetToCsv, csvToWorkbook } from "../formula/csv";

export type ConvTarget = "md" | "html" | "txt" | "csv" | "tsv" | "docx" | "xlsx";
export interface ConvOptions { sheet?: string; images?: "embed" | "alt"; csvValues?: "display" | "raw"; bom?: boolean; delimiter?: "," | ";" | "\t" }
export interface ConvResult { name: string; from: string; to: ConvTarget; mime: string; text?: string; bytes?: Uint8Array; loss: string[]; engine: string; sheets?: string[] }

const MIME: Record<ConvTarget, string> = {
  md: "text/markdown", html: "text/html", txt: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export const CONVERSIONS: Record<string, ConvTarget[]> = { docx: ["md", "html", "txt"], docm: ["md", "html", "txt"], md: ["docx"], markdown: ["docx"], xlsx: ["csv", "tsv"], xlsm: ["csv", "tsv"], csv: ["xlsx"], tsv: ["xlsx"], pptx: ["md", "txt"], pptm: ["md", "txt"] };
const extOf = (n: string) => n.toLowerCase().split(".").pop() ?? "";
const base = (n: string) => (n.split("/").pop() ?? n).replace(/\.[^.]+$/, "") || "document";

/** constructs a Word → text conversion cannot carry, counted from the package parts (content-specific loss list) */
export async function convertBytes(bytes: Uint8Array, name: string, to: ConvTarget, o: ConvOptions = {}): Promise<ConvResult> {
  const from = extOf(name);
  const allowed = CONVERSIONS[from];
  if (!allowed || !allowed.includes(to)) throw new Error(`no conversion from .${from} to .${to} (supported: ${Object.entries(CONVERSIONS).map(([k, v]) => `${k}→${v.join("/")}`).join(", ")})`);
  const out = (text: string | undefined, b: Uint8Array | undefined, loss: string[], engine: string, extra: Partial<ConvResult> = {}): ConvResult =>
    ({ name: `${base(name)}.${to}`, from, to, mime: MIME[to], ...(text !== undefined ? { text } : {}), ...(b ? { bytes: b } : {}), loss, engine, ...extra });
  if (from === "docx" || from === "docm") {
    const doc = await readWord(bytes, name);
    const images = o.images ?? "embed";
    const loss = await wordConversionLoss(bytes, to === "txt" ? "txt" : to === "html" ? "html" : "md", images);
    const text = to === "md" ? wordToMarkdown(doc, { images: images === "embed" ? "embed" : "alt" }) : to === "html" ? wordToHtml(doc, { images }) : wordToText(doc);
    return out(text, undefined, loss, "Writer engine (wordml.ts) → convert-word.ts");
  }
  if (from === "md" || from === "markdown") {
    const r = await markdownToDocx(fromUtf8(bytes), { rawHtml: "basic" });
    return out(undefined, r.bytes, r.loss, "md2docx.ts (CommonMark + GFM tables/strikethrough + footnotes)");
  }
  if (from === "xlsx" || from === "xlsm") {
    const wb = readXlsxWorkbook(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const sheets = [...wb.sheets.keys()]; // the reader recalculates (engine-authoritative, as the Spreadsheet app shows it)
    const sheet = o.sheet && wb.sheets.has(o.sheet) ? o.sheet : sheets[0];
    const r = sheetToCsv(wb, sheet, { delimiter: to === "tsv" ? "\t" : o.delimiter ?? ",", values: o.csvValues ?? "display", bom: o.bom });
    return out(r.text, undefined, [`sheet "${sheet}", range ${r.range || "(empty)"}`, ...r.loss], "Spreadsheet engine (formula/xlsx.ts) → formula/csv.ts", { sheets });
  }
  if (from === "csv" || from === "tsv") {
    const r = csvToWorkbook(fromUtf8(bytes), { delimiter: from === "tsv" ? "\t" : "auto", sheetName: base(name).slice(0, 31) });
    const x = writeXlsxWorkbook(r.wb, base(name));
    return out(undefined, new Uint8Array(x.buffer, x.byteOffset, x.byteLength), [`delimiter ${JSON.stringify(r.delimiter)}, ${r.rows} rows × ${r.cols} columns; typed: ${r.counts.number} numbers, ${r.counts.date + r.counts.time} dates/times, ${r.counts.bool} booleans, ${r.counts.text} text`, ...r.loss], "formula/csv.ts → Spreadsheet engine (formula/xlsx.ts)");
  }
  const d = await readPptxDoc(bytes, name);
  const r = to === "md" ? deckToMarkdown(d) : deckToText(d);
  return out(to === "md" ? (r as { md: string }).md : (r as { text: string }).text, undefined, r.loss, "Slides engine (pml.ts) → convert-slides.ts");
}
