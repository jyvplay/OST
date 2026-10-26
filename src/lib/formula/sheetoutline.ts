/**
 * TT78 — Spreadsheet outlines (Data ▸ Group / Ungroup / Show-Hide Detail / Auto Outline / Clear Outline / Subtotal).
 *
 * Formal model (one axis; rows and columns are symmetric). A sheet carries a level map λ: line → {1..7} (absent = 0),
 * a set K of "collapsed" lines, and a summary placement σ ∈ {after, before} (ECMA-376 §18.3.1.31 outlinePr
 * summaryBelow / summaryRight; default after). For each L ≥ 1 a GROUP at level L is a maximal run [s, e] of
 * consecutive lines with λ ≥ L; its summary line is e+1 (σ = after) or s−1 (σ = before). The file stores exactly λ
 * (outlineLevel), K (collapsed) and the hidden flag — nothing else — so every operation below is defined in those terms:
 *   collapse(G)  hides every line of G and puts G's summary line in K.
 *   expand(G)    removes G's summary from K and shows each line of G that is not inside a nested group G′ (level >
 *                level(G)) whose summary line is in K — nested collapsed groups stay collapsed (Excel).
 *   level(n)     the outline-symbol buttons 1 … max+1: lines with λ ≥ n hidden, λ < n shown; every group at level ≥ n
 *                collapsed, every group below n expanded.
 *   group(a..b)  λ += 1 on the lines (refused past 7 — Excel's eight outline levels incl. the summary level).
 *   ungroup(a..b) λ −= 1; hidden lines stay hidden (Microsoft: "If you ungroup an outline while the detail data is
 *                hidden, the detail rows or columns may remain hidden"); K entries that no longer head a group are dropped.
 *   clear         λ := ∅, K := ∅ (hidden lines stay hidden, as in Excel).
 * Rows hidden by an outline are ordinary hidden rows ("manual"): the file cannot tell them apart from Hide, SUBTOTAL
 * 1–11 counts them and 101–111 skips them (Excel). Rows hidden by an AutoFilter are never shown by expand.
 *
 * Subtotal (Data ▸ Subtotal): for every change in the "at each change in" column of a list with a header row, a row is
 * inserted after the group with "<value> Total" (or Count / Average / Max / Min / Product / StdDev / StdDevp / Var /
 * Varp) and =SUBTOTAL(fn, range) in each chosen column, then a "Grand Total" row over the whole list; detail rows get
 * level 2, subtotal rows level 1, the grand total level 0 (Excel's 1 2 3 buttons). Remove All deletes the rows holding
 * SUBTOTAL formulas inside the list and clears its outline. Summary-above (σ = before) and page breaks are not offered
 * by Subtotal here (declared).
 *
 * Auto Outline (heuristic, declared): a cell whose formula aggregates a contiguous single-column (rows) / single-row
 * (columns) range that ends right next to it makes those detail lines a group; nested totals nest. Excel's own Auto
 * Outline algorithm is not documented beyond "summary formulas adjacent to detail"; differences are possible.
 */
import { type Workbook, type Sheet } from "./engine";
import { insertDelete } from "./sheetops";

export type OAxis = "row" | "col";
export const MAX_OUTLINE = 7;
export interface OGroup { level: number; start: number; end: number; summary: number; collapsed: boolean }
export type OResult = { ok: true; message: string } | { ok: false; error: string };
const LIMIT = { row: 1048576, col: 16384 } as const;

const lv = (s: Sheet, a: OAxis) => (a === "row" ? s.rowLevels : s.colLevels);
const ks = (s: Sheet, a: OAxis) => (a === "row" ? s.rowCollapsed : s.colCollapsed);
const after = (s: Sheet, a: OAxis) => (a === "row" ? s.summaryBelow : s.summaryRight);
const isHidden = (s: Sheet, a: OAxis, i: number) => (a === "row" ? s.hiddenRows.has(i) : s.hiddenCols.has(i));
function hide(s: Sheet, a: OAxis, i: number) { if (a === "row") { if (!s.hiddenRows.has(i)) s.hiddenRows.set(i, "manual"); } else s.hiddenCols.add(i); }
/** show a line hidden by hand / an outline; a row the AutoFilter rejected stays hidden */
function show(s: Sheet, a: OAxis, i: number) { if (a === "row") { if (s.hiddenRows.get(i) === "manual") s.hiddenRows.delete(i); } else s.hiddenCols.delete(i); }

export function maxLevel(s: Sheet, a: OAxis): number { let m = 0; for (const v of lv(s, a).values()) if (v > m) m = v; return m; }
export function levelOf(s: Sheet, a: OAxis, i: number): number { return lv(s, a).get(i) ?? 0; }

/** every group at every level, sorted by level then start */
export function outlineGroups(s: Sheet, a: OAxis): OGroup[] {
  const m = lv(s, a); if (!m.size) return [];
  const lines = [...m.entries()].filter(([, l]) => l > 0).sort((x, y) => x[0] - y[0]);
  const out: OGroup[] = []; const top = maxLevel(s, a); const K = ks(s, a); const aft = after(s, a);
  for (let L = 1; L <= top; L++) {
    let start = -1, prev = -2;
    const flush = () => { if (start < 0) return; const summary = aft ? prev + 1 : start - 1; out.push({ level: L, start, end: prev, summary, collapsed: summary >= 0 && summary < LIMIT[a] && K.has(summary) }); start = -1; };
    for (const [i, l] of lines) { if (l < L) continue; if (i !== prev + 1) flush(); if (start < 0) start = i; prev = i; }
    flush();
  }
  return out;
}
/** the group at `level` whose summary line is `summary` (the +/- button in the gutter) */
export function groupAt(s: Sheet, a: OAxis, level: number, summary: number): OGroup | undefined { return outlineGroups(s, a).find((g) => g.level === level && g.summary === summary); }

function collapseG(s: Sheet, a: OAxis, g: OGroup) {
  for (let i = g.start; i <= g.end; i++) hide(s, a, i);
  if (g.summary >= 0 && g.summary < LIMIT[a]) ks(s, a).add(g.summary);
}
function expandG(s: Sheet, a: OAxis, g: OGroup, all: OGroup[]) {
  ks(s, a).delete(g.summary);
  const K = ks(s, a);
  const nestedCollapsed = all.filter((n) => n.level > g.level && n.start >= g.start && n.end <= g.end && n.summary !== g.summary && K.has(n.summary));
  for (let i = g.start; i <= g.end; i++) if (!nestedCollapsed.some((n) => i >= n.start && i <= n.end)) show(s, a, i);
}
export function collapseGroup(s: Sheet, a: OAxis, level: number, summary: number): boolean { const g = groupAt(s, a, level, summary); if (!g) return false; collapseG(s, a, g); return true; }
export function expandGroup(s: Sheet, a: OAxis, level: number, summary: number): boolean { const all = outlineGroups(s, a); const g = all.find((x) => x.level === level && x.summary === summary); if (!g) return false; expandG(s, a, g, all); return true; }
/** the gutter button: collapse when the group's lines are visible, expand when they are hidden */
export function toggleGroup(s: Sheet, a: OAxis, level: number, summary: number): "collapsed" | "expanded" | null {
  const all = outlineGroups(s, a); const g = all.find((x) => x.level === level && x.summary === summary); if (!g) return null;
  const hiddenNow = groupIsCollapsed(s, a, g);
  if (hiddenNow) { expandG(s, a, g, all); return "expanded"; }
  collapseG(s, a, g); return "collapsed";
}
/** displayed state: in K, or every line hidden (files written by other apps may hide without the flag) */
export function groupIsCollapsed(s: Sheet, a: OAxis, g: OGroup): boolean {
  if (g.collapsed) return true;
  for (let i = g.start; i <= g.end; i++) if (!isHidden(s, a, i)) return false;
  return true;
}

/** the outline-symbol buttons 1 … max+1 */
export function showLevel(s: Sheet, a: OAxis, n: number): OResult {
  const top = maxLevel(s, a); if (!top) return { ok: false, error: "There is no outline on this sheet." };
  const L = Math.max(1, Math.min(top + 1, Math.floor(n)));
  for (const [i, l] of lv(s, a)) { if (l >= L) hide(s, a, i); else show(s, a, i); }
  const K = ks(s, a); for (const g of outlineGroups(s, a)) { if (g.summary < 0 || g.summary >= LIMIT[a]) continue; if (g.level >= L) K.add(g.summary); else K.delete(g.summary); }
  return { ok: true, message: `showing outline level ${L}` };
}

export function groupLines(s: Sheet, a: OAxis, from: number, to: number): OResult {
  const lo = Math.max(0, Math.min(from, to)), hi = Math.min(LIMIT[a] - 1, Math.max(from, to));
  if (hi - lo + 1 > 100000) return { ok: false, error: "Select fewer than 100,000 rows or columns to group." };
  for (let i = lo; i <= hi; i++) if (levelOf(s, a, i) >= MAX_OUTLINE) return { ok: false, error: "Excel allows at most eight outline levels — this selection is already grouped seven deep." };
  const m = lv(s, a); for (let i = lo; i <= hi; i++) m.set(i, levelOf(s, a, i) + 1);
  return { ok: true, message: `grouped ${hi - lo + 1} ${a === "row" ? "row" : "column"}(s)` };
}
function pruneFlags(s: Sheet, a: OAxis) { const heads = new Set(outlineGroups(s, a).map((g) => g.summary)); for (const k of [...ks(s, a)]) if (!heads.has(k)) ks(s, a).delete(k); }
export function ungroupLines(s: Sheet, a: OAxis, from: number, to: number): OResult {
  const lo = Math.max(0, Math.min(from, to)), hi = Math.min(LIMIT[a] - 1, Math.max(from, to)); const m = lv(s, a); let n = 0;
  for (const [i, l] of [...m]) if (i >= lo && i <= hi) { if (l <= 1) m.delete(i); else m.set(i, l - 1); n++; }
  if (!n) return { ok: false, error: "Cannot ungroup: the selection is not part of an outline." };
  pruneFlags(s, a);
  return { ok: true, message: `ungrouped ${n} ${a === "row" ? "row" : "column"}(s)` };
}
export function clearOutline(s: Sheet, a?: OAxis): OResult {
  const axes: OAxis[] = a ? [a] : ["row", "col"]; let n = 0;
  for (const x of axes) { n += lv(s, x).size; lv(s, x).clear(); ks(s, x).clear(); }
  return n ? { ok: true, message: "outline cleared (hidden rows / columns stay hidden — Unhide shows them)" } : { ok: false, error: "There is no outline to clear." };
}

/** Data ▸ Hide Detail: collapse the deepest group containing the line, or headed by it */
export function hideDetail(s: Sheet, a: OAxis, line: number): OResult {
  const all = outlineGroups(s, a); const cands = all.filter((g) => (line >= g.start && line <= g.end) || g.summary === line).filter((g) => !groupIsCollapsed(s, a, g));
  if (!cands.length) return { ok: false, error: all.length ? "Nothing to hide here." : "There is no outline on this sheet." };
  const g = cands.reduce((x, y) => (y.level > x.level ? y : x)); collapseG(s, a, g); return { ok: true, message: `hid level ${g.level} detail` };
}
/** Data ▸ Show Detail: expand the shallowest collapsed group headed by (or containing) the line */
export function showDetail(s: Sheet, a: OAxis, line: number): OResult {
  const all = outlineGroups(s, a); const cands = all.filter((g) => g.summary === line || (line >= g.start && line <= g.end)).filter((g) => groupIsCollapsed(s, a, g));
  if (!cands.length) return { ok: false, error: all.length ? "Nothing to show here." : "There is no outline on this sheet." };
  const g = cands.reduce((x, y) => (y.level < x.level ? y : x)); expandG(s, a, g, all); return { ok: true, message: `showed level ${g.level} detail` };
}

/** levels / collapsed flags follow inserted / deleted lines; a line inserted strictly inside a group joins it */
export function shiftOutline(s: Sheet, a: OAxis, at: number, count: number) {
  const m = lv(s, a), K = ks(s, a); if (!m.size && !K.size) return;
  const shift = (v: number) => (count > 0 ? (v >= at ? v + count : v) : v < at ? v : v >= at - count ? v + count : -1);
  const inherit = count > 0 ? Math.min(m.get(at - 1) ?? 0, m.get(at) ?? 0) : 0;
  const nm = new Map<number, number>(); for (const [i, l] of m) { const n = shift(i); if (n >= 0 && n < LIMIT[a]) nm.set(n, l); }
  if (inherit > 0) for (let i = at; i < at + count; i++) nm.set(i, inherit);
  const nk = new Set<number>(); for (const i of K) { const n = shift(i); if (n >= 0 && n < LIMIT[a]) nk.add(n); }
  if (a === "row") { s.rowLevels = nm; s.rowCollapsed = nk; } else { s.colLevels = nm; s.colCollapsed = nk; }
}

/* ------------------------------------------------------------------ Auto Outline */
const AGG = /^(SUM|SUBTOTAL|AVERAGE|COUNT|COUNTA|MAX|MIN|PRODUCT|AGGREGATE)$/i;
interface Span { from: number; to: number; at: number }
/** ranges a summary formula aggregates along the axis: A1 refs in the same column (rows) / row (cols), ending next to it */
function summarySpan(input: string, a: OAxis, col: number, row: number, aft: boolean): Span | null {
  const m = /^=\s*([A-Z.]+)\s*\(/i.exec(input); if (!m || !AGG.test(m[1])) return null;
  const refs = [...input.matchAll(/\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?/gi)];
  if (!refs.length || refs.length > 64) return null;
  const L = (x: string) => { let n = 0; for (const ch of x.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  let lo = Infinity, hi = -Infinity;
  for (const r of refs) {
    const c0 = L(r[1]), r0 = Number(r[2]) - 1, c1 = r[3] ? L(r[3]) : c0, r1 = r[4] ? Number(r[4]) - 1 : r0;
    if (a === "row") { if (c0 !== col || c1 !== col) return null; lo = Math.min(lo, r0, r1); hi = Math.max(hi, r0, r1); }
    else { if (r0 !== row || r1 !== row) return null; lo = Math.min(lo, c0, c1); hi = Math.max(hi, c0, c1); }
  }
  const here = a === "row" ? row : col;
  if (aft && hi === here - 1 && lo < hi + 1) return { from: lo, to: hi, at: here };
  if (!aft && lo === here + 1) return { from: lo, to: hi, at: here };
  return null;
}
export function autoOutline(s: Sheet, a: OAxis): OResult {
  const aft = after(s, a); const spans: Span[] = []; const seen = new Set<string>();
  for (const [k, cell] of s.grid) {
    if (!cell.formula) continue; const [c, r] = k.split(",").map(Number);
    const sp = summarySpan(cell.input, a, c, r, aft); if (!sp) continue;
    const id = `${sp.from}:${sp.to}`; if (seen.has(id)) continue; seen.add(id); spans.push(sp);
    if (spans.length > 5000) break;
  }
  if (!spans.length) return { ok: false, error: `Cannot create an outline: no summary formulas next to their detail ${a === "row" ? "rows" : "columns"} were found.` };
  // spans must nest or be disjoint (overlapping ones are dropped, smaller first wins)
  spans.sort((x, y) => (x.to - x.from) - (y.to - y.from));
  const kept: Span[] = [];
  for (const sp of spans) if (kept.every((k) => sp.to < k.from || sp.from > k.to || (sp.from <= k.from && sp.to >= k.to))) kept.push(sp);
  const m = new Map<number, number>();
  for (const sp of kept) for (let i = sp.from; i <= sp.to; i++) m.set(i, Math.min(MAX_OUTLINE, (m.get(i) ?? 0) + 1));
  if (a === "row") { s.rowLevels = m; s.rowCollapsed = new Set(); } else { s.colLevels = m; s.colCollapsed = new Set(); }
  return { ok: true, message: `outline created: ${kept.length} group(s), ${maxLevel(s, a)} level(s)` };
}

/* ------------------------------------------------------------------ Subtotal */
export const SUBTOTAL_FNS = { Sum: 9, Count: 3, Average: 1, Max: 4, Min: 5, Product: 6, "Count Numbers": 2, StdDev: 7, StdDevp: 8, Var: 10, Varp: 11 } as const;
export type SubtotalFn = keyof typeof SUBTOTAL_FNS;
const LABEL: Record<SubtotalFn, string> = { Sum: "Total", Count: "Count", Average: "Average", Max: "Max", Min: "Min", Product: "Product", "Count Numbers": "Count", StdDev: "StdDev", StdDevp: "StdDevp", Var: "Var", Varp: "Varp" };
export interface SubtotalOpts { c0: number; r0: number; c1: number; r1: number; groupCol: number; fn: SubtotalFn; totalCols: number[]; replace?: boolean }
const colL = (c: number) => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const isSubtotalRow = (s: Sheet, r: number, c0: number, c1: number) => { for (let c = c0; c <= c1; c++) if (/^=\s*SUBTOTAL\s*\(/i.test(s.get(c, r)?.input ?? "")) return true; return false; };

/** Data ▸ Subtotal ▸ Remove All: rows holding SUBTOTAL formulas inside the list are deleted; the outline is cleared */
export function removeSubtotals(wb: Workbook, sheetName: string, r: { c0: number; r0: number; c1: number; r1: number }): { removed: number; r1: number } {
  const s = wb.sheet(sheetName); let removed = 0, r1 = r.r1;
  for (let row = r.r1; row > r.r0; row--) if (isSubtotalRow(s, row, r.c0, r.c1)) { insertDelete(wb, sheetName, "row", row, -1); removed++; r1--; }
  for (const [i] of [...s.rowLevels]) if (i >= r.r0 && i <= r.r1) s.rowLevels.delete(i);
  for (const i of [...s.rowCollapsed]) if (i >= r.r0 && i <= r.r1 + 1) s.rowCollapsed.delete(i);
  for (let row = r.r0; row <= r1; row++) if (s.hiddenRows.get(row) === "manual") s.hiddenRows.delete(row);
  return { removed, r1 };
}
export function subtotal(wb: Workbook, sheetName: string, o: SubtotalOpts): OResult & { r1?: number } {
  const s = wb.sheet(sheetName);
  if (o.r1 - o.r0 < 1) return { ok: false, error: "Select a list with a header row and at least one row of data." };
  if (o.groupCol < o.c0 || o.groupCol > o.c1) return { ok: false, error: "The “At each change in” column must be inside the list." };
  const cols = [...new Set(o.totalCols)].filter((c) => c >= o.c0 && c <= o.c1).sort((x, y) => x - y);
  if (!cols.length) return { ok: false, error: "Choose at least one column to add a subtotal to." };
  if (o.r1 - o.r0 > 200000) return { ok: false, error: "The list is too long for Subtotal (200,000 rows max)." };
  if ([...wb.tables.values()].some((t) => t.sheet === sheetName && t.c0 <= o.c1 && o.c0 <= t.c1 && t.r0 <= o.r1 && o.r0 <= t.r1)) return { ok: false, error: "Subtotal cannot be used inside an Excel table — convert it to a range first (Excel refuses too)." };
  let r1 = o.r1;
  if (o.replace !== false) r1 = removeSubtotals(wb, sheetName, o).r1;
  const fn = SUBTOTAL_FNS[o.fn]; const label = LABEL[o.fn];
  const key = (r: number) => { const c = s.get(o.groupCol, r); return c ? String(c.value) : ""; };
  // groups of consecutive equal keys among the data rows (top-down), then insert bottom-up so indexes stay valid
  const groups: { a: number; b: number; k: string }[] = [];
  for (let r = o.r0 + 1; r <= r1; r++) { const k = key(r); const g = groups[groups.length - 1]; if (g && g.k.toLowerCase() === k.toLowerCase() && g.b === r - 1) g.b = r; else groups.push({ a: r, b: r, k }); }
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi]; insertDelete(wb, sheetName, "row", g.b + 1, 1);
    s.setCell(o.groupCol, g.b + 1, `${g.k} ${label}`.trim()); s.setStyle(o.groupCol, g.b + 1, { bold: true });
    for (const c of cols) if (c !== o.groupCol) s.setCell(c, g.b + 1, `=SUBTOTAL(${fn},${colL(c)}${g.a + 1}:${colL(c)}${g.b + 1})`);
  }
  const last = r1 + groups.length; const grand = last + 1;
  insertDelete(wb, sheetName, "row", grand, 1);
  s.setCell(o.groupCol, grand, `Grand ${label}`); s.setStyle(o.groupCol, grand, { bold: true });
  for (const c of cols) if (c !== o.groupCol) s.setCell(c, grand, `=SUBTOTAL(${fn},${colL(c)}${o.r0 + 2}:${colL(c)}${last + 1})`);
  // outline: detail 2, subtotal rows 1, header + grand total 0
  for (let r = o.r0 + 1; r <= last; r++) s.rowLevels.set(r, isSubtotalRow(s, r, o.c0, o.c1) ? 1 : 2);
  s.rowLevels.delete(grand); s.summaryBelow = true;
  return { ok: true, message: `${groups.length} subtotal(s) + grand total (${o.fn})`, r1: grand };
}
