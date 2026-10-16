/**
 * Client-safe workbook JSON codec (no node: imports). v2 (TT15) adds optional
 * per-cell `style` and per-sheet `colWidths` / `freezeRows`; v1 documents
 * (cells with only ref+input) still load unchanged.
 */
import { Workbook, Sheet, a1, type CellStyle } from "./engine";
import { lettersToCol } from "./types";
import { sanitizeCharts, sanitizeCondFormats } from "./sheetmeta";

export interface CellJson { ref: string; input: string; style?: CellStyle }
export interface SheetJson { name: string; cells: CellJson[]; colWidths?: Record<string, number>; freezeRows?: number }
export interface WorkbookJson { sheets: SheetJson[]; charts?: unknown[]; condFormats?: unknown[] }

export function workbookToJson(wb: Workbook): WorkbookJson {
  const extra: Partial<WorkbookJson> = {};
  if (wb.charts.length) extra.charts = wb.charts.map((c) => ({ ...c }));
  if (wb.condFormats.length) extra.condFormats = wb.condFormats.map((c) => ({ ...c }));
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
      return out;
    }),
  };
}

const STYLE_KEYS: (keyof CellStyle)[] = ["bold", "italic", "underline", "align", "fill", "color", "numFmt", "wrap"];
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
    wb.sheets.set(s.name, sheet);
  }
  if (!wb.sheets.size) wb.addSheet("Sheet1");
  wb.charts = sanitizeCharts(data.charts);
  wb.condFormats = sanitizeCondFormats(data.condFormats);
  wb.recalculate();
  return wb;
}
