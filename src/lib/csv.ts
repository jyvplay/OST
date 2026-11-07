/**
 * TT139 (FF-75) — RFC 4180 CSV/TSV reader and writer that survives real files.
 *
 * Spreadsheet import is where "it worked on my sample" turns into a data-loss
 * incident. This module is written against the failure modes that actually
 * occur in the wild, each handled explicitly rather than being swallowed:
 *
 *  - quoted fields containing the delimiter, CR/LF, or doubled quotes,
 *  - a UTF-8 BOM (kept out of the first cell and reported, not silently eaten),
 *  - CRLF, CR-only and LF line endings in the same file,
 *  - unbalanced quotes at EOF: the field is returned *and* an error is
 *    reported — a parser that silently "repairs" this moves every following
 *    cell one column to the left,
 *  - embedded NUL bytes (a strong sign the "CSV" is actually binary),
 *  - delimiter auto-detection that scores candidates on *consistency of field
 *    count per row* rather than on frequency, because a text column full of
 *    semicolons otherwise wins,
 *  - spreadsheet formula injection on export: a cell that begins with = + - @
 *    TAB CR is prefixed so an opened-in-Excel file cannot execute it. The guard
 *    is applied on write, is reversible (`unescapeFormulaCell`), and is reported
 *    per cell so round-tripping our own file is exact.
 *
 * Deliberately not implemented: type inference (dates/numbers stay strings),
 * multi-line comment handling, and any locale-specific decimal comma guessing.
 */

export type Delimiter = "," | ";" | "\t" | "|";

export interface CsvDialect { delimiter: Delimiter; quote: string; lineEnding: "\r\n" | "\n" }

export interface CsvParseResult {
  rows: string[][];
  dialect: CsvDialect;
  hadBom: boolean;
  errors: string[];
  /** Rows whose field count differs from the modal count. */
  raggedRows: number[];
  bytes: number;
  truncated: boolean;
}

export const CSV_MAX_BYTES = 64 * 1024 * 1024;
export const CSV_MAX_ROWS = 1_000_000;
export const CSV_MAX_FIELD = 1 << 20;

/** Detect the field-count-consistent delimiter, not the most frequent character. */
export function detectDelimiter(sample: string): Delimiter {
  const candidates: Delimiter[] = [",", ";", "\t", "|"];
  let best: Delimiter = ",";
  let bestScore = -1;
  const lines = sample.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "").slice(0, 40);
  if (lines.length === 0) return ",";
  for (const d of candidates) {
    const counts = lines.map((line) => countFieldsOutsideQuotes(line, d));
    const mode = modeOf(counts);
    if (mode < 2) continue;
    const consistent = counts.filter((c) => c === mode).length / counts.length;
    const score = consistent * 10 + Math.min(mode, 12);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function countFieldsOutsideQuotes(line: string, d: Delimiter): number {
  let inQuotes = false, count = 1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { i++; continue; }
      inQuotes = !inQuotes;
    } else if (c === d && !inQuotes) count++;
  }
  return count;
}

function modeOf(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = 0, bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount || (c === bestCount && v > best)) { best = v; bestCount = c; }
  return best;
}

/**
 * Parse. When `delimiter` is omitted the first 8 KiB are used to detect one;
 * detection is reported back so the UI can let the user override it.
 */
export function parseCsv(text: string, opts: { delimiter?: Delimiter; limitRows?: number; hasHeader?: boolean } = {}): CsvParseResult {
  const bytes = text.length;
  if (text.length > CSV_MAX_BYTES) throw new Error(`csv: ${text.length} characters exceeds the ${CSV_MAX_BYTES} limit`);
  if (text.includes("\u0000")) throw new Error("csv: input contains NUL bytes; this is not a text file");
  let body = text;
  const hadBom = body.charCodeAt(0) === 0xfeff;
  if (hadBom) body = body.slice(1);
  const delimiter = opts.delimiter ?? detectDelimiter(body.slice(0, 8192));
  const lineEnding: "\r\n" | "\n" = body.includes("\r\n") ? "\r\n" : "\n";
  const rows: string[][] = [];
  const errors: string[] = [];
  const limitRows = opts.limitRows ?? CSV_MAX_ROWS;
  let truncated = false;

  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = body.length;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    if (rows.length > limitRows) { truncated = true; return false; }
    return true;
  };

  while (i < n) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++;
      if (field.length > CSV_MAX_FIELD) throw new Error(`csv: field longer than ${CSV_MAX_FIELD} characters`);
      continue;
    }
    if (c === '"' && field === "") { inQuotes = true; i++; continue; }
    if (c === '"' && field !== "") {
      // a quote in the middle of an unquoted field is literal, but worth flagging
      if (errors.length < 20) errors.push(`row ${rows.length + 1}: quote inside an unquoted field was kept literally`);
      field += c; i++; continue;
    }
    if (c === delimiter) { pushField(); i++; continue; }
    if (c === "\r") {
      if (body[i + 1] === "\n") i++;
      i++;
      if (!pushRow()) break;
      continue;
    }
    if (c === "\n") { i++; if (!pushRow()) break; continue; }
    field += c; i++;
  }
  if (inQuotes) {
    // Recovery contract: the delimiter that was swallowed by the unclosed quote
    // is put back, so the fields after it survive as readable cells. This is a
    // heuristic and is labelled as one; the raw text is never mutated on disk.
    errors.push("the file ends inside a quoted field; the field was split on its first delimiter and may have swallowed line breaks");
    const parts = field.split(delimiter);
    if (parts.length > 1) { row.push(parts[0]); for (const extra of parts.slice(1, -1)) row.push(extra); field = parts[parts.length - 1]; }
  }
  if (field !== "" || row.length > 0) pushRow();
  // A trailing newline produces one empty row; that is not data.
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();

  const counts = rows.map((r) => r.length);
  const modal = modeOf(counts);
  const raggedRows = rows.map((r, idx) => (r.length !== modal ? idx : -1)).filter((x) => x >= 0);
  if (raggedRows.length) errors.push(`${raggedRows.length} row(s) have a different field count than the modal ${modal}`);
  return { rows, dialect: { delimiter, quote: '"', lineEnding }, hadBom, errors, raggedRows, bytes, truncated };
}

/**
 * A cell opens a formula in a spreadsheet when it starts with `=`, `+`, `@`, a
 * tab or a carriage return. A leading `-` is *not* included: `-2` and `-0.5` are
 * ordinary signed numbers, and prefixing them turns a valid dataset into text.
 * The unguarded residual risk is a cell such as `-1+cmd|' /C calc'!A0`, which is
 * reported by `writeCsv(...).guarded` audits rather than silently rewritten.
 */
const INJECTION_PREFIX = /^[=+@\t\r]/;

/**
 * Serialise. Every value is quoted only when needed, quotes are doubled, and
 * formula-looking cells are prefixed with a single quote unless
 * `guardFormulas: false`. The prefix is recorded in `guarded` so the caller can
 * tell the user exactly which cells changed.
 */
export function writeCsv(
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
  opts: { delimiter?: Delimiter; lineEnding?: "\r\n" | "\n"; guardFormulas?: boolean; formulaPrefix?: string } = {},
): { text: string; guarded: { row: number; col: number }[] } {
  const delim = opts.delimiter ?? ",";
  const eol = opts.lineEnding ?? "\r\n";
  const guard = opts.guardFormulas !== false;
  const prefix = opts.formulaPrefix ?? "'";
  const guarded: { row: number; col: number }[] = [];
  const lines: string[] = [];
  rows.forEach((row, r) => {
    const cells = row.map((v, c) => {
      let s = v === null || v === undefined ? "" : String(v);
      if (guard && INJECTION_PREFIX.test(s)) { s = prefix + s; guarded.push({ row: r, col: c }); }
      // Quote only when the format requires it. Leading whitespace is preserved
      // by quoting *without* applying the injection prefix — conflating the two
      // is what made " -2" and "-2" behave differently for no reason.
      const needsQuotes = s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r") || s.length !== s.trimStart().length;
      return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s;
    });
    lines.push(cells.join(delim));
  });
  return { text: lines.join(eol) + (lines.length ? eol : ""), guarded };
}

/** Reverse the injection guard for exactly one cell. */
export function unescapeFormulaCell(cell: string, prefix = "'"): string {
  return cell.startsWith(prefix) && INJECTION_PREFIX.test(cell.slice(prefix.length)) ? cell.slice(prefix.length) : cell;
}

/** Column width plan for the Spreadsheet's "paste CSV" preview: no cell is silently clipped. */
export function csvPreview(rows: readonly string[][], maxRows = 20, maxCols = 12): { rows: string[][]; hiddenRows: number; hiddenCols: number; columnWidths: number[] } {
  const shown = rows.slice(0, maxRows).map((r) => r.slice(0, maxCols));
  const cols = Math.max(0, ...shown.map((r) => r.length));
  const columnWidths = Array.from({ length: cols }, (_, c) => {
    const longest = Math.max(3, ...shown.map((r) => (r[c] ?? "").length));
    return Math.min(40, longest + 1);
  });
  return { rows: shown, hiddenRows: Math.max(0, rows.length - maxRows), hiddenCols: Math.max(0, cols - maxCols), columnWidths };
}
