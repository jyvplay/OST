/**
 * TT74 (FF-02): spreadsheet ⇄ CSV, original code.
 *
 * Export follows Excel's "CSV (Comma delimited)" save (Microsoft support, "Import or export text (.txt or .csv) files"):
 * only the active sheet; each cell's text AS DISPLAYED (number formats applied, conditional formatting not); the used
 * range (from its first used row/column — leading empty rows/columns are not written; a formatted-but-empty cell
 * extends the range); a field holding the delimiter, a quote or a line break is quoted with "" escaping; rows end in
 * CRLF. Options: raw values instead of display text, ";" or tab delimiter, UTF-8 BOM ("CSV UTF-8"), LF line ends.
 * Not replicated (disclosed): Excel's omission of trailing delimiters in some 16-row blocks.
 *
 * Import types each field as Excel does when it opens a .csv ("as if typed"): numbers (with thousands separators),
 * percentages, $ currency, (negatives), TRUE/FALSE, error literals, m/d/yyyy and ISO dates, times, date-times — each
 * with the number format Excel assigns. Declared safety deviation: a field starting with "=" (or "+"/"-"/"@" followed
 * by a non-number) is kept as TEXT, never evaluated (CSV formula injection, OWASP).
 */
import { Workbook, Sheet, textInput } from "./engine";
import { formatValue } from "./numfmt";
import { dateToSerial, setDate1904 } from "./dates";
import { colToLetters } from "./types";

export interface CsvExportOptions { delimiter?: "," | ";" | "\t"; values?: "display" | "raw"; bom?: boolean; eol?: "\r\n" | "\n" }
export interface CsvExport { text: string; rows: number; cols: number; range: string; loss: string[] }

const isErr = (v: unknown): v is { error: string } => typeof v === "object" && v !== null && "error" in v;

/** Used range of a sheet: every cell with an input, a style, or a spilled value. */
export function usedRange(wb: Workbook, sheetName: string): { c0: number; r0: number; c1: number; r1: number } | null {
  const sh = wb.sheets.get(sheetName);
  if (!sh) return null;
  let c0 = Infinity, r0 = Infinity, c1 = -1, r1 = -1;
  const take = (c: number, r: number) => { if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r; };
  for (const [k, cell] of sh.grid) {
    if (cell.input === "" && !cell.style) continue;
    const [c, r] = k.split(",").map(Number);
    take(c, r);
    if (cell.spill) { take(c + cell.spill.cols - 1, r + cell.spill.rows - 1); }
  }
  return c1 < 0 ? null : { c0, r0, c1, r1 };
}

function quoteField(s: string, delim: string): string {
  return s.includes(delim) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rawText(v: unknown): string {
  if (v === undefined || v === "" || v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "#NUM!";
  if (isErr(v)) return v.error;
  return String(v);
}

export function sheetToCsv(wb: Workbook, sheetName: string, o: CsvExportOptions = {}): CsvExport {
  const delim = o.delimiter ?? ","; const eol = o.eol ?? "\r\n";
  const sh = wb.sheets.get(sheetName);
  if (!sh) throw new Error(`no sheet "${sheetName}"`);
  const ur = usedRange(wb, sheetName);
  const loss = new Map<string, number>();
  const lose = (k: string, n = 1) => loss.set(k, (loss.get(k) ?? 0) + n);
  const lines: string[] = [];
  const prev = setDate1904(wb.date1904);
  try {
    if (ur) {
      for (let r = ur.r0; r <= ur.r1; r++) {
        const fields: string[] = [];
        for (let c = ur.c0; c <= ur.c1; c++) {
          const cell = sh.get(c, r);
          const v = wb.valueAt(sheetName, c, r);
          let t: string;
          if (o.values === "raw") t = rawText(v);
          else {
            const fmt = cell?.style?.numFmt;
            t = formatValue(v, fmt).text;
            if (fmt && fmt !== "General" && typeof v === "number") lose("number formats applied (the CSV holds the displayed text)");
          }
          if (cell?.formula) lose("formulas (their current values are written)");
          if (typeof v === "string" && v !== "" && retypes(v)) lose("text cells that look like numbers, dates or booleans (a spreadsheet opening the CSV will turn them into values)");
          if (cell?.style && (cell.style.bold || cell.style.italic || cell.style.fill || cell.style.color || cell.style.border || cell.style.align)) lose("cell styles (fonts, fills, borders, alignment)");
          fields.push(quoteField(t, delim));
        }
        lines.push(fields.join(delim));
      }
    }
  } finally { setDate1904(prev); }
  const others = [...wb.sheets.keys()].filter((n) => n !== sheetName).length;
  if (others) lose("other sheets (CSV holds one sheet)", others);
  if (sh.merges.length) lose("merged areas (values stay in their top-left cell)", sh.merges.length);
  const charts = wb.charts.filter((c) => (c as { sheet?: string }).sheet === sheetName || !(c as { sheet?: string }).sheet).length;
  if (charts) lose("charts", charts);
  const cf = wb.condFormats.filter((c) => c.sheet === sheetName).length;
  if (cf) lose("conditional-format rules (not applied, as in Excel's CSV)", cf);
  if (sh.validations.length) lose("data-validation rules", sh.validations.length);
  if (sh.links.length) lose("hyperlinks (their display text is kept)", sh.links.length);
  if (wb.names.size) lose("defined names", wb.names.size);
  const text = (o.bom ? "\ufeff" : "") + lines.map((l) => l + eol).join("");
  return {
    text, rows: lines.length, cols: ur ? ur.c1 - ur.c0 + 1 : 0,
    range: ur ? `${colToLetters(ur.c0)}${ur.r0 + 1}:${colToLetters(ur.c1)}${ur.r1 + 1}` : "",
    loss: [...loss].map(([k, n]) => (k.startsWith("number formats") || k.startsWith("formulas") || k.startsWith("cell styles") || k.startsWith("text cells") ? `${n} cells: ${k}` : `${n} ${k}`)),
  };
}

/** would Excel-style typing turn this TEXT into a non-text value? (export loss report, X2) */
export function retypes(text: string): boolean { const k = typeField(text).kind; return k !== "text" && k !== "guarded" && k !== "empty"; }

/* ================================================================ import */
/** RFC 4180 parser (quotes, "" escapes, CRLF / LF / CR row ends, line breaks inside quotes). */
export function parseCsvText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ""; let quoted = false; let wasQuoted = false;
  const s = text.replace(/^\ufeff/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"' && field === "" && !wasQuoted) { quoted = true; wasQuoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ""; wasQuoted = false; continue; }
    if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; wasQuoted = false; continue; }
    field += c;
  }
  if (field !== "" || row.length || wasQuoted) { row.push(field); rows.push(row); }
  return rows;
}
/** Delimiter detection: the candidate giving the most rows with the same (>1) field count, quotes respected. */
export function detectDelimiter(text: string): "," | ";" | "\t" | "|" {
  const sample = text.slice(0, 64 * 1024);
  let best: "," | ";" | "\t" | "|" = ","; let bestScore = -1;
  for (const d of [",", ";", "\t", "|"] as const) {
    const rows = parseCsvText(sample, d).slice(0, 50);
    if (rows.length > 1 && rows.length === 50) rows.pop(); // the last sampled row may be cut
    const counts = new Map<number, number>();
    for (const r of rows) if (r.length > 1) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    const score = Math.max(0, ...counts.values()) * 1000 + (counts.size ? [...counts.keys()].reduce((a, b) => Math.max(a, b), 0) : 0);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const NUM = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d*)?|\\.\\d+";
const RE_NUM = new RegExp(`^([+-]?)(${NUM})(?:[eE]([+-]?\\d+))?$`);
const RE_PCT = new RegExp(`^([+-]?)(${NUM})\\s?%$`);
const RE_CUR = new RegExp(`^([+-]?)\\$\\s?(${NUM})$`);
const RE_PAREN = new RegExp(`^\\((\\$?)\\s?(${NUM})\\)$`);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function decimals(n: string): number { const k = n.indexOf("."); return k < 0 ? 0 : n.length - k - 1; }
function fixedFmt(base: string, dec: number): string { return dec ? `${base}.${"0".repeat(Math.min(dec, 2))}` : base; }
function timeFrac(t: string): { v: number; fmt: string } | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(?:\s*([AaPp])[Mm]?)?$/.exec(t.trim());
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2]); const s = m[3] ? Number(m[3]) : 0;
  if (mi > 59 || s >= 60) return null;
  if (m[4]) { if (h < 1 || h > 12) return null; h = (h % 12) + (/[Pp]/.test(m[4]) ? 12 : 0); } else if (h > 23) return null;
  return { v: (h * 3600 + mi * 60 + s) / 86400, fmt: m[4] ? (m[3] ? "h:mm:ss AM/PM" : "h:mm AM/PM") : m[3] ? "h:mm:ss" : "h:mm" };
}
function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 9999) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}
function dateSerial(t: string): { v: number; fmt: string } | null {
  const s = t.trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](.+))?$/.exec(s);
  let y: number, mo: number, d: number, rest: string | undefined, fmt = "m/d/yyyy";
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(.+))?$/.exec(s))) { mo = +m[1]; d = +m[2]; y = m[3].length === 2 ? (+m[3] < 30 ? 2000 : 1900) + +m[3] : +m[3]; rest = m[4]; }
  else if ((m = /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{2}|\d{4})$/.exec(s)) && MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) >= 0) { d = +m[1]; mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; y = m[3].length === 2 ? (+m[3] < 30 ? 2000 : 1900) + +m[3] : +m[3]; fmt = "d-mmm-yy"; }
  else return null;
  if (!validYmd(y, mo, d)) return null;
  let v = dateToSerial(y, mo, d);
  if (rest) { const tf = timeFrac(rest); if (!tf) return null; v += tf.v; fmt = "m/d/yyyy h:mm"; }
  return { v, fmt };
}
export interface TypedField { input: string; numFmt?: string; kind: "number" | "text" | "bool" | "date" | "time" | "error" | "guarded" | "empty" }
/** One CSV field → cell input + the number format Excel would assign when the field is "typed". */
export function typeField(raw: string): TypedField {
  if (raw === "") return { input: "", kind: "empty" };
  const s = raw.trim();
  if (/^[=+\-@]/.test(s) && !RE_NUM.test(s) && !RE_CUR.test(s) && !RE_PCT.test(s)) return { input: textInput(raw), kind: "guarded" };
  let m = RE_NUM.exec(s);
  if (m) {
    const n = Number(`${m[1]}${m[2].replace(/,/g, "")}${m[3] !== undefined ? `e${m[3]}` : ""}`);
    if (Number.isFinite(n)) return { input: String(n), kind: "number", ...(m[2].includes(",") ? { numFmt: fixedFmt("#,##0", decimals(m[2])) } : m[3] !== undefined ? { numFmt: "0.00E+00" } : {}) };
  }
  if ((m = RE_PCT.exec(s))) { const n = Number(`${m[1]}${m[2].replace(/,/g, "")}`) / 100; if (Number.isFinite(n)) return { input: String(n), kind: "number", numFmt: decimals(m[2]) ? "0.00%" : "0%" }; }
  if ((m = RE_CUR.exec(s))) { const n = Number(`${m[1]}${m[2].replace(/,/g, "")}`); if (Number.isFinite(n)) return { input: String(n), kind: "number", numFmt: decimals(m[2]) ? "$#,##0.00" : "$#,##0" }; }
  if ((m = RE_PAREN.exec(s))) { const n = -Number(m[2].replace(/,/g, "")); if (Number.isFinite(n)) return { input: String(n), kind: "number", ...(m[1] ? { numFmt: decimals(m[2]) ? "$#,##0.00_);($#,##0.00)" : "$#,##0_);($#,##0)" } : {}) }; }
  if (/^(true|false)$/i.test(s)) return { input: s.toUpperCase(), kind: "bool" };
  if (/^#(NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A)$/i.test(s)) return { input: s.toUpperCase(), kind: "error" };
  const ds = dateSerial(s); if (ds) return { input: String(ds.v), numFmt: ds.fmt, kind: "date" };
  const tf = timeFrac(s); if (tf) return { input: String(tf.v), numFmt: tf.fmt, kind: "time" };
  return { input: textInput(raw), kind: "text" };
}

export interface CsvImportOptions { delimiter?: "," | ";" | "\t" | "|" | "auto"; types?: "excel" | "text"; sheetName?: string; maxCells?: number }
export interface CsvImport { wb: Workbook; sheet: string; delimiter: string; rows: number; cols: number; counts: Record<TypedField["kind"], number>; loss: string[] }
export function csvToWorkbook(text: string, o: CsvImportOptions = {}): CsvImport {
  const delimiter = !o.delimiter || o.delimiter === "auto" ? detectDelimiter(text) : o.delimiter;
  const rows = parseCsvText(text, delimiter);
  const max = o.maxCells ?? 2_000_000;
  const wb = new Workbook();
  const name = (o.sheetName ?? "Sheet1").replace(/[[\]:*?/\\]/g, "_").slice(0, 31) || "Sheet1";
  wb.sheets.clear();
  const sh = new Sheet(name); wb.sheets.set(name, sh);
  const counts: Record<TypedField["kind"], number> = { number: 0, text: 0, bool: 0, date: 0, time: 0, error: 0, guarded: 0, empty: 0 };
  let cells = 0; let cols = 0; let imported = 0;
  const loss: string[] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]; if (row.length > cols) cols = row.length; imported = r + 1;
    for (let c = 0; c < row.length; c++) {
      if (++cells > max) { loss.push(`the file holds more than ${max} cells; the rest was not imported`); r = rows.length; break; }
      const f = o.types === "text" ? { input: row[c] === "" ? "" : textInput(row[c]), kind: (row[c] === "" ? "empty" : "text") as TypedField["kind"] } : typeField(row[c]);
      counts[f.kind]++;
      if (f.input === "") continue;
      sh.setCell(c, r, f.input);
      if ((f as TypedField).numFmt) sh.setStyle(c, r, { numFmt: (f as TypedField).numFmt });
    }
  }
  wb.recalculate();
  if (counts.guarded) loss.push(`${counts.guarded} fields starting with = + - @ were kept as text, never evaluated (CSV formula-injection guard)`);
  return { wb, sheet: name, delimiter, rows: imported, cols, counts, loss };
}
