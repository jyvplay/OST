/**
 * Pure spreadsheet editing operations (TT15). Browser-safe; no DOM.
 *
 *  - shiftFormula: copy/fill semantics — relative parts of every reference move
 *    by (dCol, dRow); `$`-anchored parts stay; a reference pushed off the grid
 *    becomes #REF! (Excel behaviour). Works on the lexer's token stream, so
 *    string literals that LOOK like references ("A1") are never touched.
 *  - insert/delete rows & columns with workbook-wide reference repair:
 *    references at/after the edit move; a single reference inside a deleted
 *    band becomes #REF!; a RANGE shrinks/expands like Excel (only collapses to
 *    #REF! when the whole range is deleted).
 *  - TSV clipboard in the exact dialect Excel/Sheets/LibreOffice put on the
 *    clipboard (tab/CRLF, RFC-4180-style quoting only when needed).
 *  - AutoFill: least-squares linear trend for ≥2 numeric seeds (Excel's
 *    behaviour for a numeric selection), "text N" increments, otherwise cyclic copy.
 */
import { adjustLayoutForStructure, sortConflict } from "./sheetlayout";
import { tokenize } from "./lexer";
import { setLink, linkAt, type SheetLink } from "./sheetlinks";
import { colToLetters, lettersToCol, type Scalar } from "./types";
import { Sheet, Workbook, textInput, type Cell, type CellStyle } from "./engine";

export interface Range { c0: number; r0: number; c1: number; r1: number }
export const MAX_COL = 16_383, MAX_ROW = 1_048_575;
export const norm = (r: Range): Range => ({ c0: Math.min(r.c0, r.c1), r0: Math.min(r.r0, r.r1), c1: Math.max(r.c0, r.c1), r1: Math.max(r.r0, r.r1) });
export const rangeA1 = (r: Range) => { const n = norm(r); const a = `${colToLetters(n.c0)}${n.r0 + 1}`, b = `${colToLetters(n.c1)}${n.r1 + 1}`; return a === b ? a : `${a}:${b}`; };
export function parseA1Range(s: string): Range | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const c0 = lettersToCol(m[1].toUpperCase()), r0 = Number(m[2]) - 1;
  const c1 = m[3] ? lettersToCol(m[3].toUpperCase()) : c0, r1 = m[4] ? Number(m[4]) - 1 : r0;
  return norm({ c0, r0, c1, r1 });
}

interface RefParts { sheet: string; colAbs: boolean; col: number; rowAbs: boolean; row: number }
const REF_RE = /^((?:[A-Za-z_][A-Za-z0-9_ ]*|'[^']+')!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/;
function parseRef(text: string): RefParts | null {
  const m = REF_RE.exec(text);
  if (!m) return null;
  return { sheet: m[1] ?? "", colAbs: m[2] === "$", col: lettersToCol(m[3].toUpperCase()), rowAbs: m[4] === "$", row: Number(m[5]) - 1 };
}
const refText = (p: RefParts) => `${p.sheet}${p.colAbs ? "$" : ""}${colToLetters(p.col)}${p.rowAbs ? "$" : ""}${p.row + 1}`;
const sheetOfPrefix = (prefix: string) => (prefix ? prefix.slice(0, -1).replace(/^'(.*)'$/, "$1").replace(/''/g, "'") : "");

/** Rewrite every reference token in a formula. `fn` gets (refs-of-one-unit) and returns replacement text. */
function rewriteRefs(input: string, fn: (unit: RefParts[]) => string): string {
  if (!input.startsWith("=")) return input;
  let toks;
  try { toks = tokenize(input); } catch { return input; }
  const body = input.trim().replace(/^=/, "");
  let out = "", last = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "ref") continue;
    const a = parseRef(t.text);
    if (!a) continue;
    let end = t.pos + t.text.length;
    const unit = [a];
    if (toks[i + 1]?.kind === "colon" && toks[i + 2]?.kind === "ref") {
      const b = parseRef(toks[i + 2].text);
      if (b) { unit.push(b); end = toks[i + 2].pos + toks[i + 2].text.length; i += 2; }
    }
    out += body.slice(last, t.pos) + fn(unit);
    last = end;
  }
  return "=" + out + body.slice(last);
}

/** Copy/fill semantics: shift relative reference parts. */
export function shiftFormula(input: string, dCol: number, dRow: number): string {
  if ((dCol === 0 && dRow === 0) || !input.startsWith("=")) return input;
  return rewriteRefs(input, (unit) => {
    const text = () => unit.map((p, i) => (i === 0 ? refText(p) : refText({ ...p, sheet: "" }))).join(":");
    if (unit.some((p) => p.col < 0 || p.row < 0 || p.col > MAX_COL || p.row > MAX_ROW)) return text(); // TT49: "A0" is not a reference — never shift it into one
    const moved = unit.map((p) => ({ ...p, col: p.colAbs ? p.col : p.col + dCol, row: p.rowAbs ? p.row : p.row + dRow }));
    if (moved.some((p) => p.col < 0 || p.row < 0 || p.col > MAX_COL || p.row > MAX_ROW)) return "#REF!";
    return moved.map((p, i) => (i === 0 ? refText(p) : refText({ ...p, sheet: "" }))).join(":");
  });
}

/**
 * TT56 Paste Special → Transpose: a formula copied from `src` lands at `dst`. A fully relative reference keeps pointing
 * at the TRANSPOSED cell — its row / column offsets from the formula cell are swapped (R[a]C[b] → R[b]C[a]); a mixed
 * reference shifts only its relative component by the displacement (copy semantics); absolute references are kept.
 */
export function transposeFormula(input: string, src: { col: number; row: number }, dst: { col: number; row: number }): string {
  if (!input.startsWith("=")) return input;
  return rewriteRefs(input, (unit) => {
    const text = (u: RefParts[]) => u.map((p, i) => (i === 0 ? refText(p) : refText({ ...p, sheet: "" }))).join(":");
    if (unit.some((p) => p.col < 0 || p.row < 0 || p.col > MAX_COL || p.row > MAX_ROW)) return text(unit);
    const moved = unit.map((p) => {
      if (!p.colAbs && !p.rowAbs) return { ...p, col: dst.col + (p.row - src.row), row: dst.row + (p.col - src.col) };
      return { ...p, col: p.colAbs ? p.col : p.col + dst.col - src.col, row: p.rowAbs ? p.row : p.row + dst.row - src.row };
    });
    if (moved.some((p) => p.col < 0 || p.row < 0 || p.col > MAX_COL || p.row > MAX_ROW)) return "#REF!";
    return text(moved);
  });
}

export type Axis = "row" | "col";
/** Reference repair for an insert (count>0) or delete (count<0) at index `at` on `target` sheet. */
export function adjustForStructure(input: string, formulaSheet: string, target: string, axis: Axis, at: number, count: number): string {
  if (!input.startsWith("=")) return input;
  const get = (p: RefParts) => (axis === "row" ? p.row : p.col);
  const set = (p: RefParts, v: number): RefParts => (axis === "row" ? { ...p, row: v } : { ...p, col: v });
  return rewriteRefs(input, (unit) => {
    const sheet = sheetOfPrefix(unit[0].sheet) || formulaSheet;
    if (sheet !== target) return unit.map((p, i) => (i === 0 ? refText(p) : refText({ ...p, sheet: "" }))).join(":");
    if (count > 0) {
      const moved = unit.map((p) => (get(p) >= at ? set(p, get(p) + count) : p));
      if (moved.some((p) => get(p) > (axis === "row" ? MAX_ROW : MAX_COL))) return "#REF!";
      return moved.map((p, i) => (i === 0 ? refText(p) : refText({ ...p, sheet: "" }))).join(":");
    }
    const n = -count, end = at + n; // deleted band [at, end)
    if (unit.length === 1) {
      const v = get(unit[0]);
      if (v >= at && v < end) return "#REF!";
      return refText(v >= end ? set(unit[0], v - n) : unit[0]);
    }
    let [a, b] = unit; if (get(a) > get(b)) [a, b] = [b, a];
    const lo = get(a), hi = get(b);
    if (lo >= at && hi < end) return "#REF!";
    const nlo = lo >= end ? lo - n : lo >= at ? at : lo;
    const nhi = hi >= end ? hi - n : hi >= at ? at - 1 : hi;
    return `${refText(set(a, nlo))}:${refText({ ...set(b, nhi), sheet: "" })}`;
  });
}

/** Physically insert/delete rows or columns on one sheet and repair references in the whole workbook. */
export function insertDelete(wb: Workbook, sheetName: string, axis: Axis, at: number, count: number): void {
  const sheet = wb.sheet(sheetName);
  const moved = new Map<string, Cell>();
  for (const [k, cell] of sheet.grid) {
    const [c, r] = k.split(",").map(Number);
    const v = axis === "row" ? r : c;
    let nv = v;
    if (count > 0 && v >= at) nv = v + count;
    if (count < 0) { if (v >= at && v < at - count) continue; if (v >= at - count) nv = v + count; }
    moved.set(axis === "row" ? `${c},${nv}` : `${nv},${r}`, cell);
  }
  sheet.grid = moved;
  adjustLayoutForStructure(sheet, axis, at, count);
  if (axis === "col") {
    const w: Record<number, number> = {};
    for (const [k, px] of Object.entries(sheet.colWidths)) { const c = Number(k); if (count > 0) w[c >= at ? c + count : c] = px; else if (c < at) w[c] = px; else if (c >= at - count) w[c + count] = px; }
    sheet.colWidths = w;
  }
  // TT19: defined names move with their cells too (Excel adjusts Name Manager references); a fully deleted
  // range becomes #REF! inside the name, exactly like a cell formula.
  for (const d of wb.listNames()) {
    const home = d.scope ?? [...wb.sheets.keys()][0];
    const next = adjustForStructure(`=${d.ref}`, home, sheetName, axis, at, count);
    if (next !== `=${d.ref}`) { try { wb.defineName(d.name, next, d.scope, d.comment); } catch { /* keep the old text if unparsable */ } }
  }
  // TT58: PivotTable sources follow inserted / deleted rows and columns (a row inserted inside the source grows it), and
  // a pivot's own position moves with its cells
  for (const s of wb.sheets.values()) for (const p of s.pivots) {
    if (p.src.sheet === sheetName) {
      const was = parseA1Range(p.src.ref);
      const next = adjustForStructure(`=${p.src.ref}`, sheetName, sheetName, axis, at, count).slice(1); if (parseA1Range(next)) p.src = { ...p.src, ref: next };
      // fields are source columns: a column inserted / deleted inside the source shifts them (a deleted field leaves the pivot)
      if (axis === "col" && was && at <= was.c1) {
        const k = Math.max(0, at - was.c0), n = count > 0 ? count : -count, start = at - was.c0;
        const map = (f: number): number | null => (count > 0 ? (f >= k && at > was.c0 ? f + n : f) : f >= start + n ? f - n : f >= start ? null : f);
        const ok = (f: number | null): f is number => f !== null;
        const sp = p.spec;
        p.spec = { ...sp, rows: sp.rows.map(map).filter(ok), cols: sp.cols.map(map).filter(ok), values: sp.values.map((v) => ({ ...v, field: map(v.field) })).filter((v): v is typeof v & { field: number } => v.field !== null), filters: (sp.filters ?? []).map((f) => ({ ...f, field: map(f.field) })).filter((f): f is typeof f & { field: number } => f.field !== null) };
      }
    }
    if (s.name !== sheetName) continue;
    const mv = (v: number) => (count > 0 ? (v >= at ? v + count : v) : v >= at - count ? v + count : v >= at ? at : v);
    if (axis === "row") { p.anchor = { ...p.anchor, row: mv(p.anchor.row) }; if (p.out) p.out = { ...p.out, r0: mv(p.out.r0), r1: Math.max(mv(p.out.r0), count < 0 && p.out.r1 >= at && p.out.r1 < at - count ? at - 1 : mv(p.out.r1)) }; }
    else { p.anchor = { ...p.anchor, col: mv(p.anchor.col) }; if (p.out) p.out = { ...p.out, c0: mv(p.out.c0), c1: Math.max(mv(p.out.c0), count < 0 && p.out.c1 >= at && p.out.c1 < at - count ? at - 1 : mv(p.out.c1)) }; }
  }
  for (const s of wb.sheets.values()) {
    for (const [k, cell] of s.grid) {
      if (!cell.formula) continue;
      const next = adjustForStructure(cell.input, s.name, sheetName, axis, at, count);
      if (next !== cell.input) { const [c, r] = k.split(",").map(Number); const style = cell.style; s.setCell(c, r, next); if (style) s.setStyle(c, r, style); }
    }
  }
  wb.recalculate();
}

/* ------------------------------------------------------------------ TSV clipboard */
const needsQuote = (s: string) => /[\t\r\n"]/.test(s);
export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (needsQuote(c) ? `"${c.replace(/"/g, '""')}"` : c)).join("\t")).join("\r\n");
}
export function parseTsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let i = 0; let quoted = false;
  const t = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  while (i < t.length) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === "") { quoted = true; i++; continue; }
    if (ch === "\t") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  row.push(cell); rows.push(row);
  return rows;
}

/* ------------------------------------------------------------------ block copy / paste */
export interface Clip { inputs: string[][]; styles: (CellStyle | undefined)[][]; origin: { col: number; row: number }; links?: (Omit<SheetLink, "ref"> | undefined)[][] }
export function copyBlock(sheet: Sheet, r: Range): Clip {
  const n = norm(r); const inputs: string[][] = [], styles: (CellStyle | undefined)[][] = [];
  for (let row = n.r0; row <= n.r1; row++) {
    const ir: string[] = [], sr: (CellStyle | undefined)[] = [];
    for (let col = n.c0; col <= n.c1; col++) { const c = sheet.get(col, row); ir.push(c?.input ?? ""); sr.push(c?.style ? { ...c.style } : undefined); }
    inputs.push(ir); styles.push(sr);
  }
  // TT57: hyperlinks travel with their cells (copy / paste, and sort which is built on these)
  const links = sheet.links.length ? inputs.map((ir, i) => ir.map((_, j) => { const l = linkAt(sheet, n.c0 + j, n.r0 + i); if (!l) return undefined; const { ref: _r, ...rest } = l; return rest; })) : undefined;
  return { inputs, styles, origin: { col: n.c0, row: n.r0 }, links: links?.some((r) => r.some(Boolean)) ? links : undefined };
}
/** Paste a block at (col,row); formulas are shifted relative to where they were copied from. */
export function pasteBlock(sheet: Sheet, clip: Clip, col: number, row: number, opts: { valuesOnly?: boolean; values?: string[][] } = {}): Range {
  const dc = col - clip.origin.col, dr = row - clip.origin.row;
  clip.inputs.forEach((ir, i) => ir.forEach((input, j) => {
    const v = opts.valuesOnly ? (opts.values?.[i]?.[j] ?? input) : shiftFormula(input, dc, dr);
    sheet.setCell(col + j, row + i, v);
    if (!opts.valuesOnly) sheet.setStyle(col + j, row + i, clip.styles[i]?.[j] ?? null);
  }));
  if (!opts.valuesOnly && (clip.links || sheet.links.length)) {
    // the pasted cells take the source's link state: its link, or none (as Excel's paste-all does)
    const H = clip.inputs.length, W = clip.inputs[0]?.length ?? 1;
    setLink(sheet, { c0: col, r0: row, c1: col + W - 1, r1: row + H - 1 }, null);
    clip.links?.forEach((lr, i) => lr.forEach((l, j) => { if (l) setLink(sheet, { c0: col + j, r0: row + i, c1: col + j, r1: row + i }, l); }));
  }
  return { c0: col, r0: row, c1: col + (clip.inputs[0]?.length ?? 1) - 1, r1: row + clip.inputs.length - 1 };
}
/* ------------------------------------------------------------------ TT56 Paste Special */
export type PasteWhat = "all" | "formulas" | "values" | "formats";
export type PasteOp = "none" | "add" | "subtract" | "multiply" | "divide";
export interface PasteSpecialOpts { what: PasteWhat; op?: PasteOp; transpose?: boolean; skipBlanks?: boolean }
/**
 * Excel-style Paste Special from an in-app clip.
 *  - what: all (inputs shifted + formats) · formulas (inputs shifted, target formats kept) · values (the computed values at
 *    copy time, `values`, as literals — text that would re-parse gets the quote prefix) · formats (styles only).
 *  - transpose: source cell (i, j) lands at (j, i); formulas go through transposeFormula (relative offsets swapped).
 *  - skipBlanks: an empty source cell leaves the target untouched (inputs and formats).
 *  - op: arithmetic with the target's current value for numeric pastes (blank target = 0, blank source = 0 → no change);
 *    a non-numeric source or target value is pasted as-is (Excel pastes text over the operation). Division by zero writes
 *    the error literal =#DIV/0!. With what="all"/"formulas" and a formula source, the result is the formula
 *    "=(<target>)<op>(<source formula>)" like Excel.
 * `targetValue(col,row)` reads the target's current computed value (needed for op); returns the written range.
 */
export function pasteSpecial(sheet: Sheet, clip: Clip, values: Scalar[][] | undefined, col: number, row: number, o: PasteSpecialOpts,
  targetValue: (col: number, row: number) => Scalar | undefined = () => undefined): Range {
  const op = o.op ?? "none";
  const H = clip.inputs.length, W = clip.inputs[0]?.length ?? 1;
  const sym = { add: "+", subtract: "-", multiply: "*", divide: "/" } as const;
  const lit = (v: Scalar | undefined): string => v === undefined || v === "" ? "" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE")
    : typeof v === "string" ? textInput(v) : `=${(v as { error: string }).error}`;
  const num = (v: Scalar | undefined): number | null => v === undefined || v === "" ? 0 : typeof v === "number" ? v : typeof v === "boolean" ? null : null;
  const apply = (a: number, b: number): number | null => op === "add" ? a + b : op === "subtract" ? a - b : op === "multiply" ? a * b : b === 0 ? null : a / b;
  for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) {
    const input = clip.inputs[i]?.[j] ?? "";
    const tc = col + (o.transpose ? i : j), tr = row + (o.transpose ? j : i);
    if (o.skipBlanks && input === "") continue;
    if (o.what === "formats") { sheet.setStyle(tc, tr, clip.styles[i]?.[j] ?? null); continue; }
    let out: string;
    if (o.what === "values") {
      const v = values?.[i]?.[j];
      out = lit(v === undefined ? (input.startsWith("=") ? "" : parseLit(input)) : v);
    } else {
      out = o.transpose ? transposeFormula(input, { col: clip.origin.col + j, row: clip.origin.row + i }, { col: tc, row: tr })
        : shiftFormula(input, tc - (clip.origin.col + j), tr - (clip.origin.row + i));
    }
    if (op !== "none" && out !== "") {
      const tv = targetValue(tc, tr);
      if (out.startsWith("=")) {
        const tn = num(tv);
        if (tn !== null) out = `=(${tn})${sym[op]}(${out.slice(1)})`;
      } else {
        const sv = o.what === "values" ? values?.[i]?.[j] : parseLit(input);
        const a = num(tv), b = num(sv);
        if (a !== null && b !== null && typeof sv === "number") { const r = apply(a, b); out = r === null ? "=#DIV/0!" : String(r); }
      }
    }
    sheet.setCell(tc, tr, out);
    if (o.what === "all") {
      sheet.setStyle(tc, tr, clip.styles[i]?.[j] ?? null);
      // TT59: hyperlinks travel with Paste Special ▸ All (as with a plain paste): the target cell takes the source cell's
      // link state; Values / Formulas / Formats leave the target's links alone (Excel keeps a link under pasted values)
      const l = clip.links?.[i]?.[j];
      if (l || sheet.links.length) setLink(sheet, { c0: tc, r0: tr, c1: tc, r1: tr }, l ?? null);
    }
  }
  return { c0: col, r0: row, c1: col + (o.transpose ? H : W) - 1, r1: row + (o.transpose ? W : H) - 1 };
}
/**
 * TT59 Paste Link (Paste Special ▸ Paste Link): every target cell gets a formula referring to its source cell with an
 * absolute reference ("=$B$2", or "=Sheet1!$B$2" from another sheet), so the target follows later source edits.
 * Excel offers it only without Transpose / Skip blanks / an operation; a blank source shows 0, as in Excel.
 */
export function pasteLink(sheet: Sheet, clip: Clip, srcSheet: string, col: number, row: number): Range {
  const H = clip.inputs.length, W = clip.inputs[0]?.length ?? 1;
  const q = srcSheet === sheet.name ? "" : `${/^[A-Za-z_][A-Za-z0-9_.]*$/.test(srcSheet) && !/^[A-Za-z]{1,3}\d+$|^[RrCc]$|^[Rr]\d*[Cc]\d*$/.test(srcSheet) ? srcSheet : `'${srcSheet.replace(/'/g, "''")}'`}!`;
  for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) {
    const sc = clip.origin.col + j, sr = clip.origin.row + i;
    sheet.setCell(col + j, row + i, `=${q}$${colToLetters(sc)}$${sr + 1}`);
  }
  return { c0: col, r0: row, c1: col + W - 1, r1: row + H - 1 };
}
function parseLit(input: string): Scalar {
  if (input === "") return "";
  if (input.startsWith("'")) return input.slice(1);
  const n = Number(input); if (input.trim() !== "" && !Number.isNaN(n)) return n;
  if (/^(TRUE|FALSE)$/i.test(input.trim())) return input.trim().toUpperCase() === "TRUE";
  return input;
}
export function clearRange(sheet: Sheet, r: Range, what: "contents" | "all" = "contents") {
  if (what === "all") setLink(sheet, norm(r), null); // TT57: Clear All removes hyperlinks too (Clear Contents keeps them, as in Excel)
  const n = norm(r);
  for (let row = n.r0; row <= n.r1; row++) for (let col = n.c0; col <= n.c1; col++) { sheet.setCell(col, row, ""); if (what === "all") sheet.setStyle(col, row, null); }
}

/* ------------------------------------------------------------------ AutoFill */
/** Extend `seed` (the source block) to cover `target` (which contains seed), along one axis. */
export function autoFill(sheet: Sheet, seed: Range, target: Range): void {
  const s = norm(seed), t = norm(target);
  const vertical = t.r1 > s.r1 || t.r0 < s.r0;
  if (vertical) {
    for (let col = s.c0; col <= s.c1; col++) {
      const inputs = []; for (let row = s.r0; row <= s.r1; row++) inputs.push({ input: sheet.get(col, row)?.input ?? "", style: sheet.get(col, row)?.style, pos: row });
      fillLine(inputs, (k) => (t.r1 > s.r1 ? s.r1 + 1 + k : s.r0 - 1 - k), t.r1 > s.r1 ? t.r1 - s.r1 : s.r0 - t.r0, t.r1 > s.r1 ? 1 : -1, (pos, v, style, srcPos) => { sheet.setCell(col, pos, v.formula ? shiftFormula(v.input, 0, pos - srcPos) : v.input); sheet.setStyle(col, pos, style ?? null); });
    }
  } else {
    for (let row = s.r0; row <= s.r1; row++) {
      const inputs = []; for (let col = s.c0; col <= s.c1; col++) inputs.push({ input: sheet.get(col, row)?.input ?? "", style: sheet.get(col, row)?.style, pos: col });
      fillLine(inputs, (k) => (t.c1 > s.c1 ? s.c1 + 1 + k : s.c0 - 1 - k), t.c1 > s.c1 ? t.c1 - s.c1 : s.c0 - t.c0, t.c1 > s.c1 ? 1 : -1, (pos, v, style, srcPos) => { sheet.setCell(pos, row, v.formula ? shiftFormula(v.input, pos - srcPos, 0) : v.input); sheet.setStyle(pos, row, style ?? null); });
    }
  }
}
function fillLine(seed: { input: string; style?: CellStyle; pos: number }[], posOf: (k: number) => number, count: number, dir: 1 | -1,
  write: (pos: number, v: { input: string; formula: boolean }, style: CellStyle | undefined, srcPos: number) => void) {
  const nums = seed.map((x) => (x.input.trim() !== "" && !x.input.startsWith("=") && !Number.isNaN(Number(x.input)) ? Number(x.input) : null));
  const textNum = seed.map((x) => /^(.*?)(\d+)$/.exec(x.input));
  const n = seed.length;
  const allNum = nums.every((v) => v !== null);
  if (allNum && n >= 2) {
    // least-squares trend y = a + b·i over i = 0..n-1 (Excel AutoFill on a numeric selection)
    const xs = nums as number[]; const mx = (n - 1) / 2; const my = xs.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0; xs.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; });
    const b = sxx ? sxy / sxx : 0, a = my - b * mx;
    for (let k = 0; k < count; k++) { const i = dir > 0 ? n + k : -1 - k; const v = Number((a + b * i).toPrecision(15)); write(posOf(k), { input: String(v), formula: false }, seed[dir > 0 ? n - 1 : 0].style, 0); }
    return;
  }
  if (n === 1 && textNum[0] && !seed[0].input.startsWith("=") && nums[0] === null) {
    const [, pre, digits] = textNum[0];
    for (let k = 0; k < count; k++) write(posOf(k), { input: `${pre}${Number(digits) + (k + 1) * dir}`, formula: false }, seed[0].style, 0);
    return;
  }
  for (let k = 0; k < count; k++) {
    const idx = dir > 0 ? k % n : n - 1 - (k % n);
    const src = seed[idx];
    write(posOf(k), { input: src.input, formula: src.input.startsWith("=") }, src.style, src.pos);
  }
}

/* ------------------------------------------------------------------ sort / find */
export function sortRange(wb: Workbook, sheetName: string, r: Range, keyCol: number, ascending: boolean, hasHeader = false): void {
  const sheet = wb.sheet(sheetName); const n = norm(r);
  const conflict = sortConflict(sheet, n); if (conflict) throw new Error(conflict);
  const start = hasHeader ? n.r0 + 1 : n.r0;
  const rows: { row: number; key: unknown; clip: Clip }[] = [];
  for (let row = start; row <= n.r1; row++) rows.push({ row, key: wb.valueAt(sheetName, keyCol, row) ?? "", clip: copyBlock(sheet, { c0: n.c0, r0: row, c1: n.c1, r1: row }) });
  const rank = (v: unknown) => (typeof v === "number" ? 0 : typeof v === "string" ? (v === "" ? 3 : 1) : typeof v === "boolean" ? 2 : 3);
  rows.sort((x, y) => {
    const rx = rank(x.key), ry = rank(y.key);
    if (rx === 3 || ry === 3) return rx - ry; // blanks last in both directions (Excel)
    const c = rx !== ry ? rx - ry : typeof x.key === "number" ? (x.key as number) - (y.key as number) : String(x.key).localeCompare(String(y.key), undefined, { sensitivity: "base" });
    return (ascending ? c : -c) || x.row - y.row; // stable
  });
  rows.forEach((x, i) => pasteBlock(sheet, x.clip, n.c0, start + i));
  wb.recalculate();
}
export interface FindHit { sheet: string; col: number; row: number; text: string }
export function findAll(wb: Workbook, query: string, opts: { matchCase?: boolean; inFormulas?: boolean; whole?: boolean } = {}): FindHit[] {
  if (!query) return [];
  const hits: FindHit[] = [];
  const norm = (s: string) => (opts.matchCase ? s : s.toLowerCase());
  const q = norm(query);
  for (const s of wb.sheets.values()) for (const [k, cell] of s.grid) {
    const text = opts.inFormulas ? cell.input : String(typeof cell.value === "object" ? cell.value.error : cell.value);
    const t = norm(text);
    if (opts.whole ? t === q : t.includes(q)) { const [c, r] = k.split(",").map(Number); hits.push({ sheet: s.name, col: c, row: r, text }); }
  }
  return hits.sort((a, b) => (a.sheet === b.sheet ? a.row - b.row || a.col - b.col : 0));
}
export function replaceAll(wb: Workbook, query: string, repl: string, opts: { matchCase?: boolean } = {}): number {
  let n = 0;
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.matchCase ? "g" : "gi");
  for (const s of wb.sheets.values()) for (const [k, cell] of [...s.grid]) {
    if (!cell.input || !re.test(cell.input)) continue;
    re.lastIndex = 0;
    const [c, r] = k.split(",").map(Number); s.setCell(c, r, cell.input.replace(re, repl)); n++;
  }
  wb.recalculate();
  return n;
}

/* ------------------------------------------------------------------ selection statistics (status bar) */
export function selectionStats(wb: Workbook, sheetName: string, r: Range) {
  const n = norm(r); let sum = 0, count = 0, numeric = 0, min = Infinity, max = -Infinity;
  for (let row = n.r0; row <= n.r1; row++) for (let col = n.c0; col <= n.c1; col++) {
    const v = wb.valueAt(sheetName, col, row);
    if (v === undefined || v === "") continue;
    count++;
    if (typeof v === "number") { numeric++; sum += v; min = Math.min(min, v); max = Math.max(max, v); }
  }
  return { count, numeric, sum, average: numeric ? sum / numeric : null, min: numeric ? min : null, max: numeric ? max : null };
}

/* ------------------------------------------------------------------ OOXML future-function prefixes */
/** Functions added after Excel 2007 must be stored as `_xlfn.NAME` in SpreadsheetML (MS-XLSX §2.2.2),
 *  otherwise Excel shows #NAME?. FILTER/SORT/SORTBY/UNIQUE etc. additionally carry `_xlws.`. */
export const XLFN = new Set(("AGGREGATE ARABIC BASE BINOM.DIST BITAND BITLSHIFT BITOR BITRSHIFT BITXOR CEILING.MATH CEILING.PRECISE CHISQ.DIST COMBINA CONCAT CONFIDENCE.NORM COT COVARIANCE.P COVARIANCE.S CSC DAYS DECIMAL ERF.PRECISE EXPON.DIST FLOOR.MATH FLOOR.PRECISE FORECAST.LINEAR GAMMA GAMMALN.PRECISE IFNA IFS ISFORMULA ISOWEEKNUM ISO.CEILING MAXIFS MINIFS MODE.SNGL NORM.DIST NORM.INV NORM.S.DIST NORM.S.INV NUMBERVALUE PDURATION PERCENTILE.EXC PERCENTILE.INC PERCENTRANK.EXC PERCENTRANK.INC POISSON.DIST QUARTILE.EXC QUARTILE.INC RANK.EQ RRI SEC SHEET SKEW.P STDEV.P STDEV.S SWITCH TEXTJOIN UNICHAR UNICODE VAR.P VAR.S XLOOKUP XMATCH SEQUENCE RANDARRAY TEXTBEFORE TEXTAFTER TEXTSPLIT VSTACK HSTACK TAKE DROP CHOOSEROWS CHOOSECOLS TOCOL TOROW WRAPROWS WRAPCOLS EXPAND ARRAYTOTEXT VALUETOTEXT").split(" "));
export const XLWS = new Set(["FILTER", "SORT", "SORTBY"]);
export const XLFN_PLAIN = new Set(["UNIQUE"]);
export function addFuturePrefixes(formulaBody: string): string {
  return formulaBody.replace(/("(?:[^"]|"")*")|\b([A-Z][A-Z0-9]*(?:\.[A-Z0-9]+)*)\s*\(/gi, (m, str, name) => {
    if (str) return str;
    const up = String(name).toUpperCase();
    if (XLWS.has(up)) return `_xlfn._xlws.${up}(`;
    if (XLFN.has(up) || XLFN_PLAIN.has(up)) return `_xlfn.${up}(`;
    return m;
  });
}
export const stripFuturePrefixes = (formulaBody: string) => formulaBody.replace(/("(?:[^"]|"")*")|_xlfn\.(?:_xlws\.)?/gi, (m, str) => (str ? str : ""));
