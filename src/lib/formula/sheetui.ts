/**
 * Pure helpers behind the spreadsheet UI (TT15), kept out of the React
 * component so they are unit-testable headless: current region (Excel Ctrl+A /
 * Ctrl+Shift+*), Ctrl+Arrow data-edge jumps, fill-handle target geometry,
 * header-row heuristic, formula autocomplete and argument hints.
 */
import type { Workbook } from "./engine";
import type { Range } from "./sheetops";

export type HasValue = (col: number, row: number) => boolean;
export const hasValueIn = (wb: Workbook, sheet: string): HasValue => (c, r) => { const v = wb.valueAt(sheet, c, r); return v !== undefined && v !== ""; };

/** Excel "current region": the rectangle bounded by blank rows/columns around (col,row). */
export function currentRegion(has: HasValue, col: number, row: number, maxCol: number, maxRow: number): Range {
  const r: Range = { c0: col, r0: row, c1: col, r1: row };
  for (let guard = 0; guard < 10_000; guard++) {
    let grew = false;
    const C0 = Math.max(0, r.c0 - 1), C1 = Math.min(maxCol, r.c1 + 1), R0 = Math.max(0, r.r0 - 1), R1 = Math.min(maxRow, r.r1 + 1);
    const any = (c0: number, r0: number, c1: number, r1: number) => { for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) if (has(x, y)) return true; return false; };
    if (r.r0 > 0 && any(C0, R0, C1, R0)) { r.r0--; grew = true; }
    if (r.r1 < maxRow && any(C0, R1, C1, R1)) { r.r1++; grew = true; }
    if (r.c0 > 0 && any(C0, R0, C0, R1)) { r.c0--; grew = true; }
    if (r.c1 < maxCol && any(C1, R0, C1, R1)) { r.c1++; grew = true; }
    if (!grew) break;
  }
  return r;
}

/** Ctrl+Arrow: jump to the edge of the data block, or to the next non-blank, or to the sheet edge. */
export function jump(has: HasValue, col: number, row: number, dc: number, dr: number, maxCol: number, maxRow: number): { col: number; row: number } {
  const inb = (c: number, r: number) => c >= 0 && r >= 0 && c <= maxCol && r <= maxRow;
  let c = col, r = row;
  if (!inb(c + dc, r + dr)) return { col: c, row: r };
  if (has(c, r) && has(c + dc, r + dr)) { while (inb(c + dc, r + dr) && has(c + dc, r + dr)) { c += dc; r += dr; } return { col: c, row: r }; }
  c += dc; r += dr;
  while (inb(c, r) && !has(c, r)) { if (!inb(c + dc, r + dr)) return { col: c, row: r }; c += dc; r += dr; }
  return { col: c, row: r };
}

/** Fill-handle drag: extend `sel` toward the hovered cell along the dominant axis; null if inside. */
export function fillTarget(sel: Range, col: number, row: number): Range | null {
  const down = row - sel.r1, up = sel.r0 - row, right = col - sel.c1, left = sel.c0 - col;
  const best = Math.max(down, up, right, left);
  if (best <= 0) return null;
  if (best === down) return { ...sel, r1: row };
  if (best === up) return { ...sel, r0: row };
  if (best === right) return { ...sel, c1: col };
  return { ...sel, c0: col };
}

/** Excel's sort-dialog guess: first row is a header if it is all text and some later row in the region has a non-text value. */
export function looksLikeHeader(wb: Workbook, sheet: string, r: Range): boolean {
  if (r.r1 <= r.r0) return false;
  let allText = true, anyNonTextBelow = false;
  for (let c = r.c0; c <= r.c1; c++) {
    const v = wb.valueAt(sheet, c, r.r0); if (typeof v !== "string" || v === "") allText = false;
    const b = wb.valueAt(sheet, c, r.r0 + 1); if (b !== undefined && b !== "" && typeof b !== "string") anyNonTextBelow = true;
  }
  return allText && anyNonTextBelow;
}

/** Autocomplete: the function-name token being typed at the end of a formula, if any. */
export function completionToken(text: string): string | null {
  if (!text.startsWith("=")) return null;
  let q = false; for (const ch of text) if (ch === '"') q = !q;
  if (q) return null; // inside a string literal
  const m = /(?:^=|[^A-Za-z0-9_.$!:'"])([A-Za-z][A-Za-z0-9.]*)$/.exec(text);
  if (!m) return null;
  if (/^[A-Za-z]{1,3}\d+$/.test(m[1])) return null; // a cell reference, not a function
  return m[1];
}
export function completions(token: string, names: Iterable<string>, limit = 8): string[] {
  const up = token.toUpperCase(); const out: string[] = [];
  for (const n of names) if (n.startsWith(up)) out.push(n);
  return out.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
}
/** Innermost unclosed call at the end of the text → name and 0-based argument index. */
export function activeCall(text: string): { name: string; arg: number } | null {
  const stack: { name: string; arg: number }[] = []; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { q = !q; continue; }
    if (q) continue;
    if (ch === "(") { const m = /([A-Za-z][A-Za-z0-9.]*)\s*$/.exec(text.slice(0, i)); stack.push({ name: m ? m[1].toUpperCase() : "", arg: 0 }); }
    else if (ch === ")") stack.pop();
    else if (ch === "," && stack.length) stack[stack.length - 1].arg++;
  }
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].name) return stack[i];
  return null;
}

/** Argument signatures for the most-used functions (hint text only; the engine is the source of truth). */
export const SIGNATURES: Record<string, string[]> = {
  SUM: ["number1", "[number2]", "…"], AVERAGE: ["number1", "[number2]", "…"], COUNT: ["value1", "[value2]", "…"], COUNTA: ["value1", "[value2]", "…"],
  MIN: ["number1", "[number2]", "…"], MAX: ["number1", "[number2]", "…"], ROUND: ["number", "num_digits"], ROUNDUP: ["number", "num_digits"], ROUNDDOWN: ["number", "num_digits"],
  IF: ["logical_test", "value_if_true", "[value_if_false]"], IFS: ["test1", "value1", "…"], IFERROR: ["value", "value_if_error"], IFNA: ["value", "value_if_na"],
  AND: ["logical1", "[logical2]", "…"], OR: ["logical1", "[logical2]", "…"], NOT: ["logical"], SWITCH: ["expression", "value1", "result1", "[default]"],
  SUMIF: ["range", "criteria", "[sum_range]"], SUMIFS: ["sum_range", "criteria_range1", "criteria1", "…"], COUNTIF: ["range", "criteria"], COUNTIFS: ["criteria_range1", "criteria1", "…"],
  AVERAGEIF: ["range", "criteria", "[average_range]"], MAXIFS: ["max_range", "criteria_range1", "criteria1", "…"], MINIFS: ["min_range", "criteria_range1", "criteria1", "…"],
  VLOOKUP: ["lookup_value", "table_array", "col_index_num", "[range_lookup]"], HLOOKUP: ["lookup_value", "table_array", "row_index_num", "[range_lookup]"],
  XLOOKUP: ["lookup_value", "lookup_array", "return_array", "[if_not_found]", "[match_mode]", "[search_mode]"], XMATCH: ["lookup_value", "lookup_array", "[match_mode]", "[search_mode]"],
  INDEX: ["array", "row_num", "[column_num]"], MATCH: ["lookup_value", "lookup_array", "[match_type]"], CHOOSE: ["index_num", "value1", "…"],
  FILTER: ["array", "include", "[if_empty]"], SORT: ["array", "[sort_index]", "[sort_order]", "[by_col]"], SORTBY: ["array", "by_array1", "[sort_order1]", "…"], UNIQUE: ["array", "[by_col]", "[exactly_once]"],
  SEQUENCE: ["rows", "[columns]", "[start]", "[step]"], TRANSPOSE: ["array"], VSTACK: ["array1", "[array2]", "…"], HSTACK: ["array1", "[array2]", "…"], TAKE: ["array", "rows", "[columns]"], DROP: ["array", "rows", "[columns]"],
  TEXT: ["value", "format_text"], TEXTJOIN: ["delimiter", "ignore_empty", "text1", "…"], CONCAT: ["text1", "…"], LEFT: ["text", "[num_chars]"], RIGHT: ["text", "[num_chars]"], MID: ["text", "start_num", "num_chars"],
  LEN: ["text"], TRIM: ["text"], UPPER: ["text"], LOWER: ["text"], PROPER: ["text"], SUBSTITUTE: ["text", "old_text", "new_text", "[instance_num]"], FIND: ["find_text", "within_text", "[start_num]"], SEARCH: ["find_text", "within_text", "[start_num]"],
  TEXTSPLIT: ["text", "col_delimiter", "[row_delimiter]", "[ignore_empty]"], TEXTBEFORE: ["text", "delimiter", "[instance_num]"], TEXTAFTER: ["text", "delimiter", "[instance_num]"], VALUE: ["text"],
  DATE: ["year", "month", "day"], TODAY: [], NOW: [], YEAR: ["serial_number"], MONTH: ["serial_number"], DAY: ["serial_number"], WEEKDAY: ["serial_number", "[return_type]"], EDATE: ["start_date", "months"], EOMONTH: ["start_date", "months"],
  DATEDIF: ["start_date", "end_date", "unit"], NETWORKDAYS: ["start_date", "end_date", "[holidays]"], WORKDAY: ["start_date", "days", "[holidays]"],
  PMT: ["rate", "nper", "pv", "[fv]", "[type]"], FV: ["rate", "nper", "pmt", "[pv]", "[type]"], PV: ["rate", "nper", "pmt", "[fv]", "[type]"], NPV: ["rate", "value1", "…"], IRR: ["values", "[guess]"], IPMT: ["rate", "per", "nper", "pv", "[fv]", "[type]"], PPMT: ["rate", "per", "nper", "pv", "[fv]", "[type]"],
  SUMPRODUCT: ["array1", "[array2]", "…"], MEDIAN: ["number1", "…"], STDEV: ["number1", "…"], "STDEV.S": ["number1", "…"], LARGE: ["array", "k"], SMALL: ["array", "k"], RANK: ["number", "ref", "[order]"],
  ABS: ["number"], SQRT: ["number"], POWER: ["number", "power"], MOD: ["number", "divisor"], INT: ["number"], RAND: [], RANDBETWEEN: ["bottom", "top"], ISBLANK: ["value"], ISNUMBER: ["value"], ISTEXT: ["value"], ISERROR: ["value"],
};
