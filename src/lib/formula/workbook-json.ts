/**
 * Client-safe workbook JSON codec (no node: imports). v2 (TT15) adds optional
 * per-cell `style` and per-sheet `colWidths` / `freezeRows`; v1 documents
 * (cells with only ref+input) still load unchanged.
 */
import { Workbook, Sheet, a1, type CellStyle, type CellBorder, type MergeRange } from "./engine";
import { isBorderLine, parseRef, rangeRef, sanitizeValidation, intersects } from "./sheetlayout";
import { lettersToCol } from "./types";
import { sanitizeCharts, sanitizeCondFormats } from "./sheetmeta";

export interface CellJson { ref: string; input: string; style?: CellStyle }
export interface SheetJson { name: string; cells: CellJson[]; colWidths?: Record<string, number>; freezeRows?: number; freezeCols?: number; merges?: string[]; validations?: unknown[] }
export interface WorkbookJson { sheets: SheetJson[]; charts?: unknown[]; condFormats?: unknown[]; names?: unknown[] }

export function workbookToJson(wb: Workbook): WorkbookJson {
  const extra: Partial<WorkbookJson> = {};
  if (wb.charts.length) extra.charts = wb.charts.map((c) => ({ ...c }));
  if (wb.condFormats.length) extra.condFormats = wb.condFormats.map((c) => ({ ...c }));
  if (wb.names.size) extra.names = wb.listNames().map((n) => ({ ...n }));
  return {
    ...extra,
    sheets: [...wb.sheets.values()].map((s) => {
      const out: SheetJson = {
        name: s.name,
        cells: [...s.grid.entries()].map(([k, c]) => {
          const [col, row] = k.split(",").map(Number);
          const cell: CellJson = { ref: a1(col, row), input: c.input };
          if (c.style && Object.keys(c.style).length) cell.style = { ...c.style };
          return cell;
        }),
      };
      if (Object.keys(s.colWidths).length) out.colWidths = Object.fromEntries(Object.entries(s.colWidths).map(([k, v]) => [k, v]));
      if (s.freezeRows) out.freezeRows = s.freezeRows;
      if (s.freezeCols) out.freezeCols = s.freezeCols;
      if (s.merges.length) out.merges = s.merges.map(rangeRef);
      if (s.validations.length) out.validations = s.validations.map((v) => ({ ...v }));
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
    if (typeof v === "boolean" || (typeof v === "string" && v.length <= 64)) out[k] = v;
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
    for (const { ref, input, style } of s.cells ?? []) {
      const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
      if (!m) continue;
      const col = lettersToCol(m[1].toUpperCase()), row = Number(m[2]) - 1;
      sheet.setCell(col, row, String(input ?? ""));
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
    wb.sheets.set(s.name, sheet);
  }
  if (!wb.sheets.size) wb.addSheet("Sheet1");
  wb.charts = sanitizeCharts(data.charts);
  wb.condFormats = sanitizeCondFormats(data.condFormats);
  // Untrusted names: each goes through defineName's validation; invalid ones are dropped (max 2000).
  for (const raw of (Array.isArray(data.names) ? data.names : []).slice(0, 2000)) {
    const n = raw as { name?: unknown; ref?: unknown; scope?: unknown; comment?: unknown };
    if (typeof n?.name !== "string" || typeof n.ref !== "string" || n.ref.length > 8192) continue;
    try { wb.defineName(n.name, n.ref, typeof n.scope === "string" ? n.scope : null, typeof n.comment === "string" ? n.comment : undefined); } catch { /* dropped */ }
  }
  wb.recalculate();
  return wb;
}
