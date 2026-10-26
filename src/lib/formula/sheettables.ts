/**
 * TT75 — Excel tables (ListObjects) under structural edits, and their SpreadsheetML part for a NEW package.
 *
 * Formal model. A table T on sheet S is the rectangle [c0..c1] × [r0..r1] with h ∈ {0,1} header rows (row r0) and
 * t ∈ {0,1} totals rows (row r1); its body is rows r0+h .. r1−t and must keep ≥ 1 row; it has one unique
 * (case-insensitive) column name per column. An insert/delete of n lines at `at` on axis X of sheet S maps T to T′:
 *   insert rows:  at ≤ r0 → shift by n;  r0 < at ≤ r1 → r1 += n (the table grows);  at > r1 → unchanged.
 *   insert cols:  same, and every inserted column gets the lowest free default name "ColumnK" (Excel), written into
 *                 its header cell.
 *   delete band B = [at, at+n): B ⊇ T → T is removed; otherwise lines of T inside B disappear (reference rules).
 *   Refused (Excel: "This operation is not allowed"): a row delete that takes a table's header row but not the whole
 *   table; any insert/delete that would change the interior of two or more tables (side-by-side tables).
 * Structured references whose table was removed, or which name a removed column, become #REF! (Excel rewrites them).
 * Sources: MrExcel 1189827 / SO 34600858 (header row cannot be deleted), SuperUser 417196 / SO 34940979 (two tables →
 * refused), exceljet / simplesheets (deleting every row of a table removes it), Microsoft support (ColumnK names).
 */
import type { Workbook, TableDef } from "./engine";
import { structuredLen } from "./lexer";
import { filterColumnsXml } from "./sheetfilter";

export type Axis = "row" | "col";
export class TableEditError extends Error {}

const lo = (t: TableDef, axis: Axis) => (axis === "row" ? t.r0 : t.c0);
const hi = (t: TableDef, axis: Axis) => (axis === "row" ? t.r1 : t.c1);

/** Excel's refusal message for this edit, or null when it is allowed. Pure (does not mutate). */
export function tableStructureConflict(wb: Workbook, sheetName: string, axis: Axis, at: number, count: number): string | null {
  if (!count) return null;
  const tables = [...wb.tables.values()].filter((t) => t.sheet === sheetName);
  let interior = 0;
  for (const t of tables) {
    const a = lo(t, axis), b = hi(t, axis);
    if (count > 0) { if (a < at && at <= b) interior++; continue; }
    const end = at - count; // deleted band [at, end)
    const meets = at <= b && end > a, whole = at <= a && end > b;
    if (!meets || whole) continue;
    interior++;
    if (axis === "row" && t.headerRows && t.r0 >= at && t.r0 < end) return `This operation is not allowed: it would delete the header row of table ${t.name} (delete the whole table, or turn its header row off first).`;
  }
  if (interior > 1) return `This operation is not allowed: it would move cells in ${interior} tables on this sheet (Excel refuses an insert or delete across more than one table).`;
  return null;
}

/** Lowest free "ColumnK" (case-insensitive against `taken`). */
export function defaultColumnName(taken: Iterable<string>): string {
  const s = new Set([...taken].map((x) => x.toLowerCase()));
  for (let k = 1; ; k++) if (!s.has(`column${k}`)) return `Column${k}`;
}

export interface TableDead { tables: Set<string>; cols: Map<string, Set<string>> }

/**
 * Apply the model to every table on `sheetName` (call after the grid moved, before formulas are repaired). Returns what
 * died, for rewriteStructuredRefs. Throws TableEditError when Excel would refuse (nothing is changed then).
 */
export function adjustTablesForStructure(wb: Workbook, sheetName: string, axis: Axis, at: number, count: number, opts: { checked?: boolean } = {}): TableDead {
  const dead: TableDead = { tables: new Set(), cols: new Map() };
  if (!count) return dead;
  if (!opts.checked) { const why = tableStructureConflict(wb, sheetName, axis, at, count); if (why) throw new TableEditError(why); }
  for (const [key, t] of [...wb.tables]) {
    if (t.sheet !== sheetName) continue;
    const a = lo(t, axis), b = hi(t, axis);
    let na = a, nb = b;
    if (count > 0) {
      if (at <= a) { na = a + count; nb = b + count; }
      else if (at <= b) {
        nb = b + count;
        if (axis === "col") {
          const k = at - t.c0; const names: string[] = [];
          for (let i = 0; i < count; i++) names.push(defaultColumnName([...t.columns, ...names]));
          t.columns = [...t.columns.slice(0, k), ...names, ...t.columns.slice(k)];
          const shiftK = <V,>(r: Record<number, V>) => Object.fromEntries(Object.entries(r).map(([o, v]) => [Number(o) >= k ? Number(o) + count : Number(o), v])) as Record<number, V>;
          if (t.filter) t.filter = { ...t.filter, cols: shiftK(t.filter.cols), ...(t.filter.raw ? { raw: shiftK(t.filter.raw) } : {}), ...(t.filter.fx ? { fx: shiftK(t.filter.fx) } : {}) };
          if (t.headerRows) { const sh = wb.sheets.get(sheetName); names.forEach((nm, i) => sh?.setCell(at + i, t.r0, nm)); }
        }
      }
    } else {
      const n = -count, end = at + n;
      if (at <= a && end > b) { wb.tables.delete(key); dead.tables.add(key); continue; }
      na = a >= end ? a - n : a >= at ? at : a;
      nb = b >= end ? b - n : b >= at ? at - 1 : b;
      if (axis === "col") {
        const gone = new Set<string>(); const keep: string[] = []; const remap = new Map<number, number>();
        t.columns.forEach((nm, i) => { const c = t.c0 + i; if (c >= at && c < end) gone.add(nm.toLowerCase()); else { remap.set(i, keep.length); keep.push(nm); } });
        if (gone.size) dead.cols.set(key, gone);
        t.columns = keep;
        const keepK = <V,>(r: Record<number, V>) => Object.fromEntries(Object.entries(r).filter(([o]) => remap.has(Number(o))).map(([o, v]) => [remap.get(Number(o))!, v])) as Record<number, V>;
        if (t.filter) { const raw = t.filter.raw ? keepK(t.filter.raw) : undefined; const fx = t.filter.fx ? keepK(t.filter.fx) : undefined; t.filter = { ...t.filter, cols: keepK(t.filter.cols), ...(raw && Object.keys(raw).length ? { raw } : {}), ...(fx && Object.keys(fx).length ? { fx } : {}) }; if (!raw || !Object.keys(raw).length) delete t.filter.raw; if (!fx || !Object.keys(fx).length) delete t.filter.fx; }
      } else {
        if (t.totalsRows && t.r1 >= at && t.r1 < end) t.totalsRows = 0; // its totals row went away
        const body = nb - na + 1 - t.headerRows - t.totalsRows;
        if (body < 1) nb = na + t.headerRows + t.totalsRows; // a table keeps one (empty) body row
      }
    }
    if (axis === "row") { t.r0 = na; t.r1 = nb; } else { t.c0 = na; t.c1 = nb; }
  }
  return dead;
}

/** The table a name-less reference ([@Col]) belongs to: the one containing the formula's cell. */
function homeTable(wb: Workbook, sheet: string, col: number, row: number): TableDef | undefined {
  for (const t of wb.tables.values()) if (t.sheet === sheet && col >= t.c0 && col <= t.c1 && row >= t.r0 && row <= t.r1) return t;
  return undefined;
}

/** Column names named by a structured-reference bracket part ("[A]:[C]", "[@Col]", "Col", specials excluded). */
export function structuredColumns(spec: string): string[] {
  let inner = spec.slice(1, -1).trim();
  if (inner.startsWith("@")) inner = inner.slice(1).trim();
  const parts: string[] = []; let depth = 0, cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'") { cur += ch + (inner[i + 1] ?? ""); i++; continue; }
    if (ch === "[") depth++; else if (ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const out: string[] = [];
  for (const p of parts) {
    if (/^\[?\s*#(All|Data|Headers|Totals|This Row)\s*\]?$/i.test(p)) continue;
    const body = p.startsWith("[") && p.endsWith("]") ? p.slice(1, -1) : p;
    for (const nm of body.split(/\]\s*:\s*\[/)) out.push(nm.replace(/'(.)/g, "$1"));
  }
  return out;
}

/**
 * Rewrite structured references that point at a removed table or a removed column to #REF! (string literals and
 * quoted sheet names are skipped exactly as the lexer skips them).
 */
export function rewriteStructuredRefs(input: string, wb: Workbook, sheet: string, col: number, row: number, dead: TableDead): string {
  if (!input.startsWith("=") || (!dead.tables.size && !dead.cols.size) || input.indexOf("[") < 0) return input;
  const s = input; let out = "", i = 1, changed = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length) { if (s[j] === c) { if (s[j + 1] === c) { j += 2; continue; } break; } j++; } out += s.slice(i, j + 1); i = j + 1; continue; }
    const prev = s[i - 1] ?? "";
    if (!/[A-Za-z0-9_.\\\]]/.test(prev) && (c === "[" || /[A-Za-z_\\\u00C0-\uFFFF]/.test(c))) {
      const n = structuredLen(s, i);
      if (n > 0) {
        const text = s.slice(i, i + n); const b = text.indexOf("[");
        const name = text.slice(0, b);
        const key = name ? name.toUpperCase() : homeTable(wb, sheet, col, row)?.name.toUpperCase() ?? "";
        const goneCols = dead.cols.get(key);
        const kill = (!!name && dead.tables.has(key)) || (!!goneCols && structuredColumns(text.slice(b)).some((x) => goneCols.has(x.toLowerCase())));
        out += kill ? "#REF!" : text; changed ||= kill; i += n; continue;
      }
    }
    // identifiers are copied whole so a name like A1B[ is not split mid-token
    const id = /^[A-Za-z_\\\u00C0-\uFFFF][A-Za-z0-9_.\\\u00C0-\uFFFF]*/.exec(s.slice(i));
    if (id && !s.slice(i + id[0].length).startsWith("[")) { out += id[0]; i += id[0].length; continue; }
    out += c; i++;
  }
  return changed ? `=${out}` : input;
}

/* ------------------------------------------------------------------ SpreadsheetML table part (new package) */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** ST_Xstring escaping: control characters and a literal "_xHHHH_" are written as _xHHHH_ (ECMA-376 §22.9.2.19). */
export function xstring(s: string): string {
  return s.replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\n\r\t]/g, (ch) => `_x${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}_`);
}
/** Inverse of xstring (reader side). */
export function unXstring(s: string): string {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
const colL = (c: number) => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };
const a1r = (c0: number, r0: number, c1: number, r1: number) => `${colL(c0)}${r0 + 1}:${colL(c1)}${r1 + 1}`;

/** Column names Excel will accept: one per column, non-empty, unique case-insensitively (later duplicates get a number). */
export function tableColumnNames(t: TableDef): string[] {
  const out: string[] = []; const taken = new Set<string>();
  for (let i = 0; i <= t.c1 - t.c0; i++) {
    let nm = (t.columns[i] ?? "").trim() ? t.columns[i] : "";
    if (!nm) nm = defaultColumnName(taken);
    let cand = nm; for (let k = 2; taken.has(cand.toLowerCase()); k++) cand = `${nm}${k}`;
    taken.add(cand.toLowerCase()); out.push(cand);
  }
  return out;
}

/** xl/tables/tableN.xml for one table (CT_Table: autoFilter, tableColumns, tableStyleInfo). */
/** TT78: the <tableColumn> element, with <calculatedColumnFormula> when the column is calculated (`fileForm` turns the
 *  stored formula into file text: structured refs in file form, future-function prefixes) */
export function tableColumnXml(t: TableDef, names: string[], i: number, fileForm?: (f: string, col: number) => string): string {
  const f = t.calc?.[names[i].toLowerCase()];
  const head = `<tableColumn id="${i + 1}" name="${esc(xstring(names[i]))}"`;
  return f ? `${head}><calculatedColumnFormula>${esc(fileForm ? fileForm(f, t.c0 + i) : f)}</calculatedColumnFormula></tableColumn>` : `${head}/>`;
}
export function tableXml(t: TableDef, id: number, dxf?: (xml: string) => number, fileForm?: (f: string, col: number) => string): string {
  const names = tableColumnNames(t);
  const ref = a1r(t.c0, t.r0, t.c1, t.r1);
  let af = "";
  if (t.headerRows) {
    const afRef = a1r(t.c0, t.r0, t.c1, Math.max(t.r0, t.r1 - t.totalsRows));
    const n = t.c1 - t.c0; const within = <V,>(o: Record<number, V> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => Number(k) >= 0 && Number(k) <= n)) as Record<number, V>;
    // TT76: colour criteria get a dxf in the NEW package's styles (`dxf` = the writer's StyleTable)
    const body = filterColumnsXml(within(t.filter?.cols), within(t.filter?.raw), "", dxf ? { fx: within(t.filter?.fx), dxf, fresh: true } : undefined);
    af = body ? `<autoFilter ref="${afRef}">${body}</autoFilter>` : `<autoFilter ref="${afRef}"/>`;
  }
  const head = t.headerRows ? "" : ' headerRowCount="0"';
  const tot = t.totalsRows ? ' totalsRowCount="1"' : ' totalsRowShown="0"';
  const name = esc(t.name);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" name="${name}" displayName="${name}" ref="${ref}"${head}${tot}>${af}<tableColumns count="${names.length}">${names.map((_n, i) => tableColumnXml(t, names, i, fileForm)).join("")}</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`;
}

/** Header cells whose text differs from the column name written (Excel renames the column to its header text). */
export function headerMismatches(wb: Workbook, t: TableDef): string[] {
  if (!t.headerRows) return [];
  const names = tableColumnNames(t); const out: string[] = [];
  names.forEach((nm, i) => { const v = wb.valueAt(t.sheet, t.c0 + i, t.r0); const txt = v === undefined || v === null ? "" : String(v); if (txt !== nm) out.push(`${colL(t.c0 + i)}${t.r0 + 1}`); });
  return out;
}

/**
 * File form of structured references (what Excel stores in <f>): the table name is always present and "@" is written
 * as "[#This Row],". `[@Col]` → `Table1[[#This Row],[Col]]`, `[@[A b]]` → `Table1[[#This Row],[A b]]`, `[@]` →
 * `Table1[#This Row]`, `[Col]` (inside the table) → `Table1[Col]`. Everything else is copied unchanged.
 */
export function structuredRefsToFileForm(input: string, wb: Workbook, sheet: string, col: number, row: number): string {
  if (!input.startsWith("=") || input.indexOf("[") < 0 || !wb.tables.size) return input;
  const s = input; let out = "", i = 1, changed = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length) { if (s[j] === c) { if (s[j + 1] === c) { j += 2; continue; } break; } j++; } out += s.slice(i, j + 1); i = j + 1; continue; }
    const prev = s[i - 1] ?? "";
    if (!/[A-Za-z0-9_.\\\]]/.test(prev) && (c === "[" || /[A-Za-z_\\\u00C0-\uFFFF]/.test(c))) {
      const n = structuredLen(s, i);
      if (n > 0) {
        const text = s.slice(i, i + n); const b = text.indexOf("[");
        let name = text.slice(0, b); let spec = text.slice(b);
        if (!name) name = homeTable(wb, sheet, col, row)?.name ?? "";
        const inner = spec.slice(1, -1).trim();
        if (inner.startsWith("@")) {
          const rest = inner.slice(1).trim();
          spec = !rest ? "[#This Row]" : rest.startsWith("[") ? `[[#This Row],${rest}]` : `[[#This Row],[${rest}]]`;
        }
        const next = name ? name + spec : text;
        out += next; changed ||= next !== text; i += n; continue;
      }
    }
    const id = /^[A-Za-z_\\\u00C0-\uFFFF][A-Za-z0-9_.\\\u00C0-\uFFFF]*/.exec(s.slice(i));
    if (id && !s.slice(i + id[0].length).startsWith("[")) { out += id[0]; i += id[0].length; continue; }
    out += c; i++;
  }
  return changed ? `=${out}` : input;
}
