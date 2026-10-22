/**
 * TT59 Spreadsheet spelling (Excel's Review ▸ Spelling, F7) over the workbook model — pure, DOM-free, Node-tested
 * (scripts/tt59-sheet-spell.mts).
 *
 * Like Excel: only text constants are checked — formulas, numbers, logicals and errors are not; with a multi-cell
 * selection only the selection is checked, otherwise the whole active sheet; order is row by row from the top-left.
 * A leading apostrophe (Excel's quote prefix) is not part of the text. "Change" rewrites the cell input in place.
 */
import type { Workbook, Sheet } from "./engine";
import { tokenize, type Speller } from "../spell/hunspell";

export interface CellSpellIssue { kind: "spell" | "repeat"; sheet: string; col: number; row: number; off: number; len: number; word: string }
export interface SheetSpellOpts { skipUpper?: boolean; ignoreAll?: Set<string>; ignoreOnce?: Set<string>; range?: { c0: number; r0: number; c1: number; r1: number } }
export const cellIssueKey = (i: CellSpellIssue) => `${i.sheet}!${i.col},${i.row}:${i.off}:${i.word}`;

/** the checkable text of a cell input and its offset in the input, or null (formula / number / logical / empty) */
export function cellText(input: string): { text: string; base: number } | null {
  if (!input) return null;
  if (input.startsWith("'")) return { text: input.slice(1), base: 1 };
  if (input.startsWith("=")) return null;
  if (input.trim() !== "" && !Number.isNaN(Number(input))) return null;
  if (/^(TRUE|FALSE)$/i.test(input.trim())) return null;
  return { text: input, base: 0 };
}

export function sheetSpellIssues(sh: Sheet, sp: Speller, o: SheetSpellOpts = {}): CellSpellIssue[] {
  const out: CellSpellIssue[] = [];
  const ignoreAll = o.ignoreAll ?? new Set<string>(), once = o.ignoreOnce ?? new Set<string>();
  const cells: [number, number, string][] = [];
  for (const [k, cell] of sh.grid) {
    const [c, r] = k.split(",").map(Number);
    if (o.range && (c < o.range.c0 || c > o.range.c1 || r < o.range.r0 || r > o.range.r1)) continue;
    cells.push([c, r, cell.input]);
  }
  cells.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  for (const [c, r, input] of cells) {
    const ct = cellText(input); if (!ct) continue;
    let prev: { w: string; end: number } | null = null;
    for (const t of tokenize(ct.text, { skipUpper: o.skipUpper })) {
      const w = t.word.replace(/’/g, "'");
      let iss: CellSpellIssue | null = null;
      if (prev && prev.w.toLowerCase() === w.toLowerCase() && /^[ \t\u00a0]+$/.test(ct.text.slice(prev.end, t.start))) iss = { kind: "repeat", sheet: sh.name, col: c, row: r, off: ct.base + prev.end, len: t.end - prev.end, word: ct.text.slice(prev.end, t.end) };
      else if (!ignoreAll.has(w) && !ignoreAll.has(w.toLowerCase()) && !sp.check(w)) iss = { kind: "spell", sheet: sh.name, col: c, row: r, off: ct.base + t.start, len: t.end - t.start, word: t.word };
      if (iss && !once.has(cellIssueKey(iss))) out.push(iss);
      prev = { w, end: t.end };
    }
  }
  return out;
}

/** replaces the issue's text inside the cell input (refuses when the cell changed since the check); returns success */
export function fixCellIssue(wb: Workbook, i: CellSpellIssue, replacement: string): boolean {
  const sh = wb.sheets.get(i.sheet); if (!sh) return false;
  const input = sh.grid.get(`${i.col},${i.row}`)?.input ?? "";
  if (input.slice(i.off, i.off + i.len) !== i.word) return false;
  let next = input.slice(0, i.off) + replacement + input.slice(i.off + i.len);
  // a fix must never turn text into a formula or a number: keep it text with Excel's quote prefix
  if (!next.startsWith("'") && cellText(next) === null && next !== "") next = `'${next}`;
  sh.setCell(i.col, i.row, next);
  return true;
}

/** Change All: every spelling issue with exactly this word in the same scope; returns the number of words changed */
export function changeAllCells(wb: Workbook, sh: Sheet, sp: Speller, word: string, replacement: string, o: SheetSpellOpts = {}): number {
  const hits = sheetSpellIssues(sh, sp, o).filter((i) => i.kind === "spell" && i.word === word);
  // right-to-left inside a cell so earlier offsets stay valid
  hits.sort((a, b) => a.row - b.row || a.col - b.col || b.off - a.off);
  let n = 0; for (const h of hits) if (fixCellIssue(wb, h, replacement)) n++;
  return n;
}
