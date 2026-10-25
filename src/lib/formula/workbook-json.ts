/**
 * Client-safe workbook JSON codec (no node: imports). v2 (TT15) adds optional
 * per-cell `style` and per-sheet `colWidths` / `freezeRows`; v1 documents
 * (cells with only ref+input) still load unchanged.
 */
import { sanitizeFilterColumnXml } from "./sheetfilter";
import { Workbook, Sheet, a1, type CellStyle, type CellBorder, type MergeRange } from "./engine";
import { err, isError, ERROR_CODES, type ErrorCode, type Scalar } from "./types";
import { isBorderLine, parseRef, rangeRef, sanitizeValidation, intersects } from "./sheetlayout";
import { lettersToCol } from "./types";
import { sanitizeCharts, sanitizeCondFormats } from "./sheetmeta";
import { sanitizeLink, type SheetLink } from "./sheetlinks";
import { sanitizePivot, type PivotDef } from "./pivotsheet";

export interface CellJson { ref: string; input: string; style?: CellStyle;
  /** TT75: legacy (implicit-intersection) formula read from .xlsx, and a CSE array formula's range — lost before, so the UI showed #SPILL! where Excel shows a value */
  legacy?: true; cse?: { rows: number; cols: number } }
export interface SheetJson { name: string; cells: CellJson[]; colWidths?: Record<string, number>; freezeRows?: number; freezeCols?: number; merges?: string[]; validations?: unknown[]; links?: unknown[]; pivots?: unknown[];
  /** TT74: hidden rows by reason, hidden columns, the AutoFilter */
  hiddenRows?: { manual?: number[]; filter?: number[] }; hiddenCols?: number[]; autoFilter?: { ref: string; cols: Record<string, string[]>; foreign?: boolean; raw?: Record<string, string> } }
export interface WorkbookJson { sheets: SheetJson[]; charts?: unknown[]; condFormats?: unknown[]; names?: unknown[]; tables?: unknown[]; date1904?: boolean;
  /** TT74: cached values of linked external workbooks ([1]Sheet1!A1 keeps evaluating after the UI round trip) */
  externals?: { target: string; sheetNames: string[]; sheets: [string, [string, unknown][]][]; names: [string, string][] }[] }

export function workbookToJson(wb: Workbook): WorkbookJson {
  const extra: Partial<WorkbookJson> = {};
  if (wb.charts.length) extra.charts = wb.charts.map((c) => ({ ...c }));
  if (wb.condFormats.length) extra.condFormats = wb.condFormats.map((c) => ({ ...c }));
  if (wb.names.size) extra.names = wb.listNames().map((n) => ({ ...n }));
  // TT46: Excel tables (structured-reference targets) and the 1904 date system must survive the UI round-trip.
  if (wb.tables.size) extra.tables = [...wb.tables.values()].map((t) => ({ ...t, columns: [...t.columns] }));
  if (wb.date1904) extra.date1904 = true;
  if (wb.externals.length) extra.externals = wb.externals.map((b) => ({ target: b.target, sheetNames: [...b.sheetNames], sheets: [...b.sheets].map(([n, m]) => [n, [...m].map(([k, v]) => [k, isError(v) ? { error: v.error } : v] as [string, unknown])] as [string, [string, unknown][]]), names: [...b.names] }));
  return {
    ...extra,
    sheets: [...wb.sheets.values()].map((s) => {
      const out: SheetJson = {
        name: s.name,
        cells: [...s.grid.entries()].map(([k, c]) => {
          const [col, row] = k.split(",").map(Number);
          const cell: CellJson = { ref: a1(col, row), input: c.input };
          if (c.style && Object.keys(c.style).length) cell.style = { ...c.style };
          if (c.formula && c.legacy) cell.legacy = true;
          if (c.formula && c.cse) cell.cse = { rows: c.cse.rows, cols: c.cse.cols };
          return cell;
        }),
      };
      if (Object.keys(s.colWidths).length) out.colWidths = Object.fromEntries(Object.entries(s.colWidths).map(([k, v]) => [k, v]));
      if (s.freezeRows) out.freezeRows = s.freezeRows;
      if (s.freezeCols) out.freezeCols = s.freezeCols;
      if (s.merges.length) out.merges = s.merges.map(rangeRef);
      if (s.validations.length) out.validations = s.validations.map((v) => ({ ...v }));
      if (s.links.length) out.links = s.links.map((l) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)));
      if (s.pivots.length) out.pivots = s.pivots.map((p) => JSON.parse(JSON.stringify(p)));
      if (s.hiddenRows.size) { const m: number[] = [], f: number[] = []; for (const [r, w] of s.hiddenRows) (w === "filter" ? f : m).push(r); out.hiddenRows = { ...(m.length ? { manual: m.sort((a, b) => a - b) } : {}), ...(f.length ? { filter: f.sort((a, b) => a - b) } : {}) }; }
      if (s.hiddenCols.size) out.hiddenCols = [...s.hiddenCols].sort((a, b) => a - b);
      if (s.autoFilter) out.autoFilter = { ref: s.autoFilter.ref, cols: Object.fromEntries(Object.entries(s.autoFilter.cols).map(([k, v]) => [k, [...v]])), ...(s.autoFilter.foreign ? { foreign: true } : {}), ...(s.autoFilter.raw ? { raw: { ...s.autoFilter.raw } } : {}) };
      return out;
    }),
  };
}

const STYLE_KEYS: (keyof CellStyle)[] = ["bold", "italic", "underline", "align", "valign", "fill", "color", "numFmt", "wrap"];
/** Untrusted JSON → only known style keys with primitive values survive. */
function cleanStyle(raw: unknown): Partial<CellStyle> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const k of STYLE_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    // Excel caps number-format codes at 255 characters; accounting formats routinely exceed 64.
    if (typeof v === "boolean" || (typeof v === "string" && v.length <= (k === "numFmt" ? 255 : 64))) out[k] = v;
  }
  if (out.align !== undefined && !["left", "center", "right"].includes(out.align as string)) delete out.align;
  for (const k of ["fill", "color"]) if (out[k] !== undefined && !/^#[0-9a-f]{6}$/i.test(out[k] as string)) delete out[k];
  if (out.valign !== undefined && !["top", "center", "bottom"].includes(out.valign as string)) delete out.valign;
  const b = (raw as Record<string, unknown>).border;
  if (b && typeof b === "object") {
    const border: CellBorder = {};
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const v = (b as Record<string, unknown>)[side] as { style?: unknown; color?: unknown } | undefined;
      if (v && isBorderLine(v.style)) border[side] = typeof v.color === "string" && /^#[0-9a-f]{6}$/i.test(v.color) ? { style: v.style, color: v.color } : { style: v.style };
    }
    if (Object.keys(border).length) out.border = border;
  }
  return Object.keys(out).length ? (out as Partial<CellStyle>) : null;
}

export function workbookFromJson(data: WorkbookJson): Workbook {
  const wb = new Workbook(); wb.sheets.clear();
  for (const s of data.sheets ?? []) {
    const sheet = new Sheet(s.name);
    for (const { ref, input, style, legacy, cse } of s.cells ?? []) {
      const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      const col = lettersToCol(m[1].toUpperCase()), row = Number(m[2]) - 1;
      sheet.setCell(col, row, String(input ?? ""));
      const made = sheet.get(col, row);
      if (made?.formula) {
        if (legacy === true) made.legacy = true;
        const okN = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;
        if (cse && typeof cse === "object" && okN(cse.rows, 1048576) && okN(cse.cols, 16384) && cse.rows * cse.cols <= 1_000_000) made.cse = { rows: cse.rows, cols: cse.cols };
      }
      const st = cleanStyle(style);
      if (st) sheet.setStyle(col, row, st);
    }
    for (const [k, v] of Object.entries(s.colWidths ?? {})) if (Number.isInteger(Number(k)) && typeof v === "number" && v >= 16 && v <= 1200) sheet.colWidths[Number(k)] = Math.round(v);
    if (typeof s.freezeRows === "number" && s.freezeRows >= 0 && s.freezeRows <= 50) sheet.freezeRows = s.freezeRows;
    if (typeof s.freezeCols === "number" && s.freezeCols >= 0 && s.freezeCols <= 26) sheet.freezeCols = Math.trunc(s.freezeCols);
    // Untrusted merges: valid refs, ≥2 cells, non-overlapping (first wins).
    for (const ref of (Array.isArray(s.merges) ? s.merges : []).slice(0, 5000)) {
      const r = typeof ref === "string" ? parseRef(ref) : null;
      if (r && !(r.c0 === r.c1 && r.r0 === r.r1) && !sheet.merges.some((m: MergeRange) => intersects(m, r))) sheet.merges.push(r);
    }
    sheet.validations = (Array.isArray(s.validations) ? s.validations : []).slice(0, 1000).map((v, i) => sanitizeValidation(v, `v${i + 1}`)).filter((v): v is NonNullable<typeof v> => !!v);
    sheet.links = (Array.isArray(s.links) ? s.links : []).slice(0, 10000).map(sanitizeLink).filter((l): l is SheetLink => !!l);
    sheet.pivots = (Array.isArray(s.pivots) ? s.pivots : []).slice(0, 100).map(sanitizePivot).filter((x): x is PivotDef => !!x);
    // TT74 (untrusted): hidden rows / columns as bounded integer lists; AutoFilter with a valid ref and string lists
    const rowsOf = (v: unknown, max: number) => (Array.isArray(v) ? v : []).slice(0, 200_000).filter((n): n is number => Number.isInteger(n) && n >= 0 && n < max);
    const hr = (s.hiddenRows && typeof s.hiddenRows === "object" ? s.hiddenRows : {}) as { manual?: unknown; filter?: unknown };
    for (const r of rowsOf(hr.manual, 1048576)) sheet.hiddenRows.set(r, "manual");
    for (const r of rowsOf(hr.filter, 1048576)) if (!sheet.hiddenRows.has(r)) sheet.hiddenRows.set(r, "filter");
    for (const c of rowsOf(s.hiddenCols, 16384)) sheet.hiddenCols.add(c);
    const af = s.autoFilter as { ref?: unknown; cols?: unknown; foreign?: unknown; raw?: unknown } | undefined;
    if (af && typeof af.ref === "string" && parseRef(af.ref)) {
      const cols: Record<number, string[]> = {};
      if (af.cols && typeof af.cols === "object") for (const [k, v] of Object.entries(af.cols as Record<string, unknown>).slice(0, 16384)) if (Number.isInteger(Number(k)) && Number(k) >= 0 && Array.isArray(v)) cols[Number(k)] = v.slice(0, 100_000).filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 32767));
      const raw = rawFiltersFromJson(af.raw);
      sheet.autoFilter = { ref: rangeRef(parseRef(af.ref)!), cols, ...(af.foreign === true ? { foreign: true } : {}), ...(raw ? { raw } : {}) };
    }
    wb.sheets.set(s.name, sheet);
  }
  if (!wb.sheets.size) wb.addSheet("Sheet1");
  wb.charts = sanitizeCharts(data.charts);
  wb.condFormats = sanitizeCondFormats(data.condFormats);
  wb.date1904 = data.date1904 === true;
  // TT74 (untrusted): external-link caches — ≤ 64 books, ≤ 256 sheets each, scalar values only
  const ERRS = new Set<string>(ERROR_CODES);
  const scalarOf = (v: unknown): Scalar | undefined => (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" ? v : typeof v === "string" ? v.slice(0, 32767)
    : v && typeof v === "object" && typeof (v as { error?: unknown }).error === "string" && ERRS.has((v as { error: string }).error) ? err((v as { error: string }).error as ErrorCode) : undefined;
  wb.externals = (Array.isArray(data.externals) ? data.externals : []).slice(0, 64).flatMap((b) => {
    if (!b || typeof b.target !== "string") return [];
    const sheets = new Map<string, Map<string, Scalar>>();
    for (const e of (Array.isArray(b.sheets) ? b.sheets : []).slice(0, 256)) {
      if (!Array.isArray(e) || typeof e[0] !== "string" || !Array.isArray(e[1])) continue;
      const m = new Map<string, Scalar>();
      for (const kv of e[1].slice(0, 1_000_000)) { if (Array.isArray(kv) && typeof kv[0] === "string" && /^\d{1,5},\d{1,7}$/.test(kv[0])) { const v = scalarOf(kv[1]); if (v !== undefined) m.set(kv[0], v); } }
      sheets.set(e[0].slice(0, 255), m);
    }
    const names = new Map<string, string>();
    for (const kv of (Array.isArray(b.names) ? b.names : []).slice(0, 10_000)) if (Array.isArray(kv) && typeof kv[0] === "string" && typeof kv[1] === "string") names.set(kv[0].slice(0, 300), kv[1].slice(0, 8192));
    return [{ target: b.target.slice(0, 2048), sheetNames: (Array.isArray(b.sheetNames) ? b.sheetNames : []).filter((x): x is string => typeof x === "string").slice(0, 256), sheets, names }];
  });
  // Untrusted tables: name syntax, existing sheet, sane bounds, one column name per column (max 2000 tables).
  const okInt = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;
  for (const raw of (Array.isArray(data.tables) ? data.tables : []).slice(0, 2000)) {
    const t = raw as Partial<Record<keyof import("./engine").TableDef, unknown>>;
    if (typeof t?.name !== "string" || !tableNameOk(t.name) || typeof t.sheet !== "string" || !wb.sheets.has(t.sheet)) continue;
    if (!okInt(t.c0, 16383) || !okInt(t.c1, 16383) || !okInt(t.r0, 1048575) || !okInt(t.r1, 1048575) || (t.c1 as number) < (t.c0 as number) || (t.r1 as number) < (t.r0 as number)) continue;
    const cols = Array.isArray(t.columns) ? t.columns.filter((c): c is string => typeof c === "string" && c.length <= 255) : [];
    if (cols.length !== (t.c1 as number) - (t.c0 as number) + 1) continue;
    wb.tables.set(t.name.toUpperCase(), { name: t.name, sheet: t.sheet, c0: t.c0 as number, r0: t.r0 as number, c1: t.c1 as number, r1: t.r1 as number, headerRows: okInt(t.headerRows, 1) ? (t.headerRows as number) : 1, totalsRows: okInt(t.totalsRows, 1) ? (t.totalsRows as number) : 0, columns: cols, ...tableFilterFromJson(t.filter, cols.length) });
  }
  // Untrusted names: each goes through defineName's validation; invalid ones are dropped (max 2000).
  for (const raw of (Array.isArray(data.names) ? data.names : []).slice(0, 2000)) {
    const n = raw as { name?: unknown; ref?: unknown; scope?: unknown; comment?: unknown };
    if (typeof n?.name !== "string" || typeof n.ref !== "string" || n.ref.length > 8192) continue;
    try { wb.defineName(n.name, n.ref, typeof n.scope === "string" ? n.scope : null, typeof n.comment === "string" ? n.comment : undefined); } catch { /* dropped */ }
  }
  wb.recalculate();
  return wb;
}

/** TT75: an untrusted table filter — value lists keyed by a column offset inside the table (≤ 1000 values of ≤ 255 chars each). */
function tableFilterFromJson(raw: unknown, ncols: number): { filter?: { cols: Record<number, string[]>; foreign?: boolean; raw?: Record<number, string> } } {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as { cols?: unknown; foreign?: unknown }; const cols: Record<number, string[]> = {};
  if (r.cols && typeof r.cols === "object") for (const [k, v] of Object.entries(r.cols as Record<string, unknown>)) {
    const o = Number(k); if (!/^\d+$/.test(k) || o >= ncols || !Array.isArray(v)) continue;
    cols[o] = v.filter((x): x is string => typeof x === "string" && x.length <= 255).slice(0, 1000);
  }
  const rawK = rawFiltersFromJson((raw as { raw?: unknown }).raw, ncols);
  return Object.keys(cols).length || r.foreign === true || rawK ? { filter: { cols, ...(r.foreign === true ? { foreign: true } : {}), ...(rawK ? { raw: rawK } : {}) } } : {};
}

/**
 * TT75: Excel table-name rules — starts with a letter (any script), "_" or "\\"; then letters, digits, ".", "_", "\\";
 * ≤ 255 characters; not "C" / "R"; not a cell reference (A1 or R1C1 style). (Was ASCII-only: 表23 tables were dropped.)
 */
export function tableNameOk(n: string): boolean {
  if (!/^[\p{L}_\\][\p{L}\p{N}\p{M}._\\]{0,254}$/u.test(n)) return false;
  if (/^[cr]$/i.test(n)) return false;
  if (/^[A-Za-z]{1,3}\d+$/.test(n) || /^R\d*C\d*$/i.test(n)) return false;
  return true;
}

/** TT75: kept foreign filter criteria from untrusted JSON — every entry goes back through the allowlist sanitiser. */
function rawFiltersFromJson(v: unknown, ncols = 16384): Record<number, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  const out: Record<number, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 16384)) {
    if (!/^\d+$/.test(k) || Number(k) >= ncols || typeof x !== "string") continue;
    const clean = sanitizeFilterColumnXml(x); if (clean) out[Number(k)] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}
