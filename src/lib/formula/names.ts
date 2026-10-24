/**
 * TT19 — Excel defined names (Formulas ▸ Name Manager). Rules web-checked (Microsoft help text as quoted by
 * DevExpress/BetterSolutions/Ablebits): first character a letter, "_" or "\"; then letters, digits, "." and "_";
 * no spaces; ≤255 characters; case-insensitive; must not look like a cell reference (A1, $B$2, R1C1); the
 * single letters C/c/R/r are reserved. Names are absolute by default.
 *
 * Implementation limits (declared): the formula lexer only reads names that start with a letter or "_" and are
 * ASCII, so names starting with "\" or using non-ASCII letters are refused instead of half-supported;
 * sheet-qualified name references (Sheet1!Tax) are not parsed.
 */
import { colToLetters, lettersToCol, type Node } from "./types";
import { parseFormula } from "./parser";

export interface DefinedName {
  name: string;          // display spelling, case kept
  ref: string;           // refers-to text WITHOUT the leading "=" (e.g. "Data!$B$2:$B$9", "0.07", "Data!$B$1*2")
  scope: string | null;  // null = workbook; otherwise the sheet name
  comment?: string;
}

export const NAME_MAX = 255;

export function validateName(name: string): string | null {
  if (!name) return "a name is required";
  if (name.length > NAME_MAX) return `names are limited to ${NAME_MAX} characters`;
  if (/\s/.test(name)) return "names cannot contain spaces (use _ or .)";
  if (name.startsWith("\\")) return "names starting with \\ are valid in Excel but not supported by this formula engine";
  if (!/^[A-Za-z_\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u03FF\u0400-\u052F\u0531-\u0587\u05D0-\u05EA\u0620-\u064A\u0E01-\u0E30\u1E00-\u1FFF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF][A-Za-z0-9_.\u00AA\u00B5\u00BA\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u03FF\u0400-\u052F\u0531-\u0587\u05D0-\u05EA\u0620-\u064A\u0E01-\u0E30\u1E00-\u1FFF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]*$/.test(name)) return "names must start with a letter or _ and contain only letters, digits, . and _"; // TT73: Unicode letters too (Excel)
  if (/^[rc]$/i.test(name)) return "C, c, R and r are reserved by Excel";
  if (/^(true|false)$/i.test(name)) return "TRUE and FALSE cannot be names";
  const a1 = /^([A-Za-z]{1,3})(\d+)$/.exec(name);
  if (a1 && lettersToCol(a1[1].toUpperCase()) <= 16_383 && Number(a1[2]) >= 1 && Number(a1[2]) <= 1_048_576) return `"${name}" is a cell reference`;
  if (/^r\d*c\d*$/i.test(name) || /^r\d+$/i.test(name) || /^c\d+$/i.test(name)) return `"${name}" is an R1C1 reference`;
  return null;
}

/** Quotes a sheet name for use in a reference when Excel would require it. */
export const quoteSheet = (s: string) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) && !/^[A-Za-z]{1,3}\d+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);

/** Where a name points when it is a plain reference/range (Name Box navigation, F5 Go To); null for formulas/constants. */
export function referenceTarget(refText: string, defaultSheet: string): { sheet: string; c0: number; r0: number; c1: number; r1: number } | null {
  let node: Node;
  try { node = parseFormula(`=${refText.replace(/^=/, "")}`); } catch { return null; }
  if (node.t === "ref") return { sheet: node.v.sheet ?? defaultSheet, c0: node.v.col, r0: node.v.row, c1: node.v.col, r1: node.v.row };
  if (node.t === "range") {
    const { from, to } = node.v;
    return { sheet: from.sheet ?? defaultSheet, c0: Math.min(from.col, to.col), r0: Math.min(from.row, to.row), c1: Math.max(from.col, to.col), r1: Math.max(from.row, to.row) };
  }
  return null;
}
/** Absolute A1 text for a selection, sheet-qualified (what Excel's Name Box stores when you type a new name). */
export function absoluteRef(sheet: string, c0: number, r0: number, c1: number, r1: number) {
  const cell = (c: number, r: number) => `$${colToLetters(c)}$${r + 1}`;
  return `${quoteSheet(sheet)}!${cell(c0, r0)}${c0 === c1 && r0 === r1 ? "" : `:${cell(c1, r1)}`}`;
}
