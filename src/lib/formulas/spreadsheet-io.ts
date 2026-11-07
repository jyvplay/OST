/**
 * TT139 (FF-20, FF-21) — SpreadsheetML 2003 writer, reader, recalculator.
 *
 * The real SpreadsheetML 2003 shape, which naive implementations get wrong:
 *
 *   <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 *             xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 *     <Worksheet ss:Name="Sheet1">
 *       <Table>
 *         <Row>                                  <- ss:Index optional, 1-BASED
 *           <Cell ss:Index="3"                   <- 1-based COLUMN NUMBER, not "C"
 *                 ss:Formula="=RC[-1]*2">        <- R1C1, and NO leading "=" is
 *             <Data ss:Type="Number">84</Data>      stored by Excel; we accept both
 *           </Cell>                              <- cached result lives here
 *         </Row>
 *       </Table>
 *     </Worksheet>
 *   </Workbook>
 *
 * Two failure modes this module is written to avoid:
 *   1. `ss:Index="A1"` — ss:Index is an integer index. A file with a letter
 *      index is rejected by Excel. We emit integers and skip only the gap.
 *   2. Dropping the cached `<Data>` beside a formula — the cell then renders
 *      blank in every reader that does not recalculate. We always emit it.
 *
 * The public model stores A1 formulas with a leading "=" because that is what
 * formula-engine.ts parses. Conversion happens only at the file boundary.
 *
 * Pure: no DOM, no I/O, no clock.
 */

import {
  evaluateFormula, parseRef, colLetter, parseColLetter,
  buildDependencyGraph, topologicalOrder, type CellValue,
} from "./formula-engine";

export type { CellValue };

export interface CellData {
  /** A1 reference, e.g. "A1", "AB12". */
  ref: string;
  value: CellValue;
  /** A1 formula with a leading "="; absent for literal cells. */
  formula?: string;
}

export interface CellRow {
  cells: CellData[];
}

export interface SheetData {
  name: string;
  rows: CellRow[];
}

export interface WorkbookData {
  sheets: SheetData[];
}

// ── A1 ⇄ R1C1 ────────────────────────────────────────────────────────────

const A1_PATTERN = /(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::(\$?[A-Za-z]{1,3}\$?\d{1,7}))?/g;

/** Hide string literals behind sentinels so "A1" inside a quote is untouched. */
function guardLiterals(formula: string): { text: string; literals: string[] } {
  const literals: string[] = [];
  const text = formula.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
    literals.push(m);
    return `\u0000${literals.length - 1}\u0000`;
  });
  return { text, literals };
}

function restoreLiterals(s: string, literals: string[]): string {
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => literals[Number(i)]);
}

/** A1 → R1C1 relative to the owning cell. "$A$1" stays absolute. */
export function a1ToR1C1(formula: string, originRow: number, originCol: number): string {
  const { text, literals } = guardLiterals(formula);
  const out = text.replace(A1_PATTERN, (whole, a: string, b?: string) => {
    const first = refToR1C1(a, originRow, originCol);
    return b ? `${first}:${refToR1C1(b, originRow, originCol)}` : first;
  });
  return restoreLiterals(out, literals);
}

function refToR1C1(ref: string, originRow: number, originCol: number): string {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/.exec(ref);
  if (!m) return ref;
  const colAbs = m[1] === "$";
  const rowAbs = m[3] === "$";
  let col: number;
  let row: number;
  try {
    col = parseColLetter(m[2]);
    row = parseInt(m[4], 10);
  } catch {
    return ref;
  }
  const r = rowAbs ? `R${row}` : row === originRow ? "R" : `R[${row - originRow}]`;
  const c = colAbs ? `C${col}` : col === originCol ? "C" : `C[${col - originCol}]`;
  return r + c;
}

// R1C1 token: R, R12, R[3], R[-1], each optionally followed by C-spec. A bare
// "R" or "C" alone is ambiguous with column "C"/"R" refs, so require R…C… or
// R[..] / Rn / C[..] / Cn with at least one bracket or digit somewhere.
const R1C1_PATTERN = /(R(?:\[\-?\d+\]|\d+)?C(?:\[\-?\d+\]|\d+)?)(?::(R(?:\[\-?\d+\]|\d+)?C(?:\[\-?\d+\]|\d+)?))?/g;

/** R1C1 → A1 relative to the owning cell. Out-of-range refs become #REF!. */
export function r1c1ToA1(formula: string, originRow: number, originCol: number): string {
  const { text, literals } = guardLiterals(formula);
  const out = text.replace(R1C1_PATTERN, (whole, a: string, b?: string) => {
    const first = r1c1RefToA1(a, originRow, originCol);
    return b ? `${first}:${r1c1RefToA1(b, originRow, originCol)}` : first;
  });
  return restoreLiterals(out, literals);
}

function r1c1RefToA1(ref: string, originRow: number, originCol: number): string {
  const m = /^R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?$/.exec(ref);
  if (!m) return ref;
  const rowPart = m[1];
  const colPart = m[2];
  const resolve = (part: string | undefined, origin: number): number => {
    if (part === undefined) return origin;
    if (part.startsWith("[")) return origin + parseInt(part.slice(1, -1), 10);
    return parseInt(part, 10);
  };
  const row = resolve(rowPart, originRow);
  const col = resolve(colPart, originCol);
  if (!Number.isFinite(row) || !Number.isFinite(col) || row < 1 || col < 1) return "#REF!";
  // R1C1 "R1C1" is absolute; "R[-1]C[-1]" is relative; "R1C[-1]" is mixed.
  // Dropping the '$' markers made a round-trip change the meaning of the
  // formula, so restore them in both directions.
  const rowAbs = rowPart !== undefined && !rowPart.startsWith("[");
  const colAbs = colPart !== undefined && !colPart.startsWith("[");
  return `${colAbs ? "$" : ""}${colLetter(col)}${rowAbs ? "$" : ""}${row}`;
}

/** True if the formula body (no "=") uses R1C1 notation. */
export function looksR1C1(body: string): boolean {
  const { text } = guardLiterals(body);
  // A1 refs take the shape letters-then-digits; R1C1 has R/C markers.
  const hasR1C1 = /(^|[^A-Za-z0-9_])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![A-Za-z0-9])/.test(text);
  const hasA1 = /(^|[^A-Za-z0-9_$])\$?[A-Za-z]{1,3}\$?\d{1,7}(?![A-Za-z0-9])/.test(text);
  return hasR1C1 && !hasA1;
}

// ── XML escaping ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function unesc(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function ssType(v: CellValue): "Number" | "Boolean" | "String" {
  if (typeof v === "number") return "Number";
  if (typeof v === "boolean") return "Boolean";
  return "String";
}

function scalarText(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NaN";
  return String(v);
}

// ── FF-20: Writer ────────────────────────────────────────────────────────

const ILLEGAL_SHEET = /[\\/?*[\]:]/;

export function writeWorkbook(wb: WorkbookData): string {
  if (!wb.sheets.length) throw new Error("Workbook needs at least one worksheet");
  const names = new Set<string>();
  for (const s of wb.sheets) {
    if (!s.name) throw new Error("Worksheet name is empty");
    if (s.name.length > 31) throw new Error(`Worksheet name exceeds 31 chars: ${s.name}`);
    if (ILLEGAL_SHEET.test(s.name)) throw new Error(`Worksheet name has an illegal char: ${s.name}`);
    if (names.has(s.name)) throw new Error(`Duplicate worksheet name: ${s.name}`);
    names.add(s.name);
  }

  const p: string[] = [];
  p.push('<?xml version="1.0" encoding="UTF-8"?>');
  p.push('<?mso-application progid="Excel.Sheet"?>');
  p.push(
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"' +
      ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
      ' xmlns:x="urn:schemas-microsoft-com:office:excel"' +
      ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"' +
      ' xmlns:html="http://www.w3.org/TR/REC-html40">',
  );

  for (const sheet of wb.sheets) {
    p.push(`<Worksheet ss:Name="${esc(sheet.name)}">`);
    p.push("<Table>");

    let prevRow = 0;
    for (const row of sheet.rows) {
      if (!row.cells.length) continue;
      const rowNums = row.cells.map((c) => parseRef(c.ref)?.row ?? 0);
      if (rowNums.some((n) => n < 1)) throw new Error(`Bad cell reference in sheet ${sheet.name}`);
      const rowNum = rowNums[0];
      if (new Set(rowNums).size !== 1) throw new Error(`Cells from different rows in one CellRow (sheet ${sheet.name})`);
      const rowSkip = rowNum - prevRow - 1;
      if (rowSkip < 0) throw new Error(`Rows out of order in sheet ${sheet.name} at row ${rowNum}`);
      prevRow = rowNum;
      p.push(rowSkip > 0 ? `<Row ss:Index="${rowNum}">` : "<Row>");

      let prevCol = 0;
      for (const cell of row.cells) {
        const parsed = parseRef(cell.ref)!;
        const colSkip = parsed.col - prevCol - 1;
        if (colSkip < 0) throw new Error(`Cells out of column order in ${sheet.name}!${cell.ref}`);
        prevCol = parsed.col;
        const idx = colSkip > 0 ? ` ss:Index="${parsed.col}"` : "";

        if (cell.formula) {
          const body = cell.formula.startsWith("=") ? cell.formula.slice(1) : cell.formula;
          const r1c1 = a1ToR1C1(body, parsed.row, parsed.col);
          p.push(
            `<Cell${idx} ss:Formula="=${esc(r1c1)}">` +
              `<Data ss:Type="${ssType(cell.value)}">${esc(scalarText(cell.value))}</Data>` +
              `</Cell>`,
          );
        } else if (cell.value === null || cell.value === undefined) {
          p.push(`<Cell${idx}/>`);
        } else {
          p.push(
            `<Cell${idx}><Data ss:Type="${ssType(cell.value)}">${esc(scalarText(cell.value))}</Data></Cell>`,
          );
        }
      }
      p.push("</Row>");
    }

    p.push("</Table>");
    p.push('<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><Selected/></WorksheetOptions>');
    p.push("</Worksheet>");
  }

  p.push("</Workbook>");
  return p.join("\n");
}

// ── FF-21: Reader ────────────────────────────────────────────────────────

export function readWorkbook(xml: string): WorkbookData {
  if (typeof xml !== "string" || !xml.trim()) throw new Error("Empty workbook XML");
  if (!/<(?:\w+:)?Workbook[\s>]/.test(xml)) throw new Error("Missing <Workbook> root");
  if (!/<\/(?:\w+:)?Workbook>/.test(xml)) throw new Error("Truncated XML: missing </Workbook>");

  const sheets: SheetData[] = [];
  const sheetRe = /<(?:\w+:)?Worksheet\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Worksheet>/g;
  const seen = new Set<string>();
  let sm: RegExpExecArray | null;
  while ((sm = sheetRe.exec(xml)) !== null) {
    const attrs = sm[1];
    const body = sm[2];
    const nameMatch = /\bss:Name="((?:[^"\\]|\\.)*)"/.exec(attrs);
    if (!nameMatch) throw new Error("Worksheet without ss:Name");
    const name = unesc(nameMatch[1]);
    if (seen.has(name)) throw new Error(`Duplicate worksheet name: ${name}`);
    seen.add(name);

    const tableMatch = /<(?:\w+:)?Table\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Table>/.exec(body);
    const table = tableMatch ? tableMatch[1] : body;

    const rows: CellRow[] = [];
    const rowRe = /<(?:\w+:)?Row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Row>)/g;
    let rowNum = 0;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(table)) !== null) {
      const rowIdx = /\bss:Index="(\d+)"/.exec(rm[1] ?? "");
      rowNum = rowIdx ? parseInt(rowIdx[1], 10) : rowNum + 1;
      if (rowNum < 1) throw new Error(`Invalid row index in sheet ${name}`);
      const rowInner = rm[2] ?? "";

      const cells: CellData[] = [];
      const cellRe = /<(?:\w+:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?Cell>)/g;
      let colNum = 0;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rowInner)) !== null) {
        const cAttrs = cm[1] ?? "";
        const cInner = cm[2] ?? "";
        const colIdx = /\bss:Index="(\d+)"/.exec(cAttrs);
        colNum = colIdx ? parseInt(colIdx[1], 10) : colNum + 1;
        if (colNum < 1) throw new Error(`Invalid column index in sheet ${name}`);

        const ref = `${colLetterByIndex(colNum)}${rowNum}`;
        const fAttr = /\bss:Formula="((?:[^"\\]|\\.)*)"/.exec(cAttrs);
        const dataMatch = /<(?:\w+:)?Data\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Data>/.exec(cInner);
        const typeMatch = dataMatch ? /\bss:Type="([^"]+)"/.exec(dataMatch[1]) : null;
        const raw = dataMatch ? unesc(dataMatch[2]) : "";
        const value: CellValue = dataMatch ? coerce(raw, typeMatch?.[1] ?? "String") : null;

        if (fAttr) {
          const stored = unesc(fAttr[1]);
          const bare = stored.startsWith("=") ? stored.slice(1) : stored;
          const a1 = looksR1C1(bare) ? r1c1ToA1(bare, rowNum, colNum) : bare;
          cells.push({ ref, value, formula: `=${a1}` });
        } else {
          cells.push({ ref, value });
        }
      }
      rows.push({ cells });
    }
    sheets.push({ name, rows });
  }

  if (!sheets.length) throw new Error("Workbook contains no worksheets");
  return { sheets };
}

/** Integer column index → letters. Local to avoid a second import cycle risk. */
function colLetterByIndex(col: number): string {
  let s = "";
  let n = col;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function coerce(raw: string, type: string): CellValue {
  if (type === "Number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "Boolean") return raw === "1" || raw.toLowerCase() === "true";
  return raw;
}

// ── FF-21: Recalculation ─────────────────────────────────────────────────

export interface RecalcReport {
  workbook: WorkbookData;
  /** `Sheet!Ref` keys that never settled (real dependency cycles). */
  circular: string[];
  /** Number of fixed-point passes actually taken. */
  passes: number;
  /** `Sheet!Ref` → final value. */
  values: Record<string, CellValue>;
}

/**
 * Recalculate to a fixed point. Cross-sheet references (`=Data!A2`) are
 * resolved by value substitution before the engine sees the formula, because
 * the engine's reference model is single-sheet on purpose.
 *
 * A real cycle never settles; those cells are reported, not silently given a
 * stale number.
 */
export function recalculateWorkbook(wb: WorkbookData): RecalcReport {
  const values = new Map<string, CellValue>();
  const formulas = new Map<string, { formula: string; sheet: string; row: number; col: number }>();

  for (const sheet of wb.sheets) {
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        const key = `${sheet.name}!${cell.ref}`;
        const parsed = parseRef(cell.ref);
        if (cell.formula && parsed) {
          formulas.set(key, { formula: cell.formula, sheet: sheet.name, row: parsed.row, col: parsed.col });
        } else {
          values.set(key, cell.value);
        }
      }
    }
  }

  const lookup = (sheet: string, ref: string): CellValue => {
    const v = values.get(`${sheet}!${ref}`);
    return v === undefined ? null : v;
  };

  const substituteCrossSheet = (formula: string, defaultSheet: string): string => {
    return formula.replace(
      /\b([A-Za-z_][A-Za-z0-9_]{0,30})!(\$?[A-Za-z]{1,3}\$?\d{1,7})\b/g,
      (_all, sheet: string, refRaw: string) => {
        const sheetName = sheet === defaultSheet ? defaultSheet : sheet;
        const ref = refRaw.replace(/\$/g, "").toUpperCase();
        const v = lookup(sheetName, ref);
        if (v === null || v === undefined) return "0";
        if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
        if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
        const s = String(v);
        return `"${s.replace(/"/g, '""')}"`;
      },
    );
  };

  const maxPasses = formulas.size + 2;
  let passes = 0;
  let settled = formulas.size === 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    passes = pass + 1;
    let changed = false;
    for (const [key, info] of formulas) {
      const localFormula = substituteCrossSheet(info.formula, info.sheet);
      const res = evaluateFormula(localFormula, (r, c) => lookup(info.sheet, `${colLetterByIndex(c)}${r}`));
      const next = res.value;
      const before = values.get(key);
      if (!sameValue(before, next)) {
        values.set(key, next);
        changed = true;
      }
    }
    if (!changed) { settled = true; break; }
  }

  // A cycle is decided structurally (Tarjan SCC over the sheet's own refs), not
  // by watching values wobble. Value-wobble missed a two-cell cycle whenever
  // the first pass happened to land on the cached numbers, and it also
  // reported any legitimately unstable formula as circular.
  const circular: string[] = [];
  {
    const nodes: Array<{ row: number; col: number; formula?: string }> = [];
    for (const sheet of wb.sheets) {
      for (const row of sheet.rows) {
        for (const cell of row.cells) {
          const p = parseRef(cell.ref);
          if (!p) continue;
          // Strip "Sheet!" prefixes so the single-sheet graph sees the edge.
          const local = cell.formula
            ? cell.formula.replace(/\b[A-Za-z_][A-Za-z0-9_]{0,30}!/g, "")
            : undefined;
          nodes.push({ row: p.row, col: p.col, formula: local });
        }
      }
    }
    if (nodes.length) {
      const graph = buildDependencyGraph(nodes);
      const { components } = topologicalOrder(graph);
      const cycleKeys = new Set<string>();
      for (const comp of components) for (const k of comp) cycleKeys.add(k);
      for (const key of cycleKeys) {
        const [r, c] = key.split(":").map(Number);
        for (const sheet of wb.sheets) {
          for (const row of sheet.rows) {
            for (const cell of row.cells) {
              const p = parseRef(cell.ref);
              if (p && p.row === r && p.col === c) circular.push(`${sheet.name}!${cell.ref}`);
            }
          }
        }
      }
    }
  }
  void settled;
  // Second pass: cross-sheet cycles (Sheet1!A1 -> Sheet2!B1 -> Sheet1!A1). The
  // single-sheet graph above cannot see them, so build a qualified graph too.
  {
    type QNode = { key: string; deps: string[] };
    const qnodes: QNode[] = [];
    for (const sheet of wb.sheets) {
      for (const row of sheet.rows) {
        for (const cell of row.cells) {
          if (!cell.formula) continue;
          const deps: string[] = [];
          const re = /\b([A-Za-z_][A-Za-z0-9_]{0,30})!(\$?[A-Za-z]{1,3}\$?\d{1,7})\b/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(cell.formula))) {
            deps.push(`${m[1]}!${m[2].replace(/\$/g, "").toUpperCase()}`);
          }
          qnodes.push({ key: `${sheet.name}!${cell.ref}`, deps });
        }
      }
    }
    const edges = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();
    for (const n of qnodes) {
      edges.set(n.key, n.deps);
      for (const d of n.deps) {
        const list = reverse.get(d) ?? [];
        list.push(n.key);
        reverse.set(d, list);
      }
    }
    const { components } = topologicalOrder({ edges, reverse, missing: [] });
    for (const comp of components) for (const k of comp) {
      if (!circular.includes(k)) circular.push(k);
    }
    circular.sort();
  }

  const out: WorkbookData = {
    sheets: wb.sheets.map((s) => ({
      name: s.name,
      rows: s.rows.map((r) => ({
        cells: r.cells.map((c) => {
          const key = `${s.name}!${c.ref}`;
          if (!c.formula) return { ...c };
          const v = values.get(key);
          return { ...c, value: v === undefined ? null : v };
        }),
      })),
    })),
  };

  const flat: Record<string, CellValue> = {};
  for (const [k, v] of values) flat[k] = v;

  return { workbook: out, circular: circular.sort(), passes, values: flat };
}

function sameValue(a: CellValue | undefined, b: CellValue | undefined): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-12;
  return false;
}

// ── Model helpers ────────────────────────────────────────────────────────

export function createWorkbook(sheetNames: string[] = ["Sheet1"]): WorkbookData {
  if (!sheetNames.length) throw new Error("At least one sheet name required");
  const seen = new Set<string>();
  for (const n of sheetNames) {
    if (!n) throw new Error("Sheet name is empty");
    if (seen.has(n)) throw new Error(`Duplicate sheet name: ${n}`);
    seen.add(n);
  }
  return { sheets: sheetNames.map((name) => ({ name, rows: [] })) };
}

export function addSheet(wb: WorkbookData, name: string): WorkbookData {
  if (!name) throw new Error("Sheet name required");
  if (wb.sheets.some((s) => s.name === name)) throw new Error(`Sheet already exists: ${name}`);
  return { sheets: [...wb.sheets, { name, rows: [] }] };
}

export function sheetNames(wb: WorkbookData): string[] {
  return wb.sheets.map((s) => s.name);
}

export function getCell(wb: WorkbookData, ref: string, sheetName?: string): CellValue {
  const sheet = sheetName ? wb.sheets.find((s) => s.name === sheetName) : wb.sheets[0];
  if (!sheet) return null;
  const want = ref.replace(/\$/g, "").toUpperCase();
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      if (cell.ref.toUpperCase() === want) return cell.value;
    }
  }
  return null;
}

/**
 * Set one cell. `formula` (if given) is stored A1 with a leading "=".
 * The caller is responsible for having a value in `value` as the cached result.
 */
export function setCell(
  wb: WorkbookData,
  ref: string,
  value: CellValue,
  sheetName?: string,
  formula?: string,
): WorkbookData {
  const name = sheetName ?? wb.sheets[0]?.name;
  if (!name) throw new Error("Workbook has no sheets");
  const parsed = parseRef(ref);
  if (!parsed) throw new Error(`Not an A1 reference: ${ref}`);
  const normalized = `${colLetterByIndex(parsed.col)}${parsed.row}`;

  const sheets = wb.sheets.map((s) => {
    if (s.name !== name) return s;
    // Rebuild the sheet as one CellRow per row number. The previous version
    // indexed `rows[parsed.row - 1]` and appended when the array was shorter,
    // which silently produced a SECOND CellRow for row 2 on overwrite.
    const byRow = new Map<number, Map<number, CellData>>();
    const rowOf = (n: number): Map<number, CellData> => {
      let m = byRow.get(n);
      if (!m) { m = new Map(); byRow.set(n, m); }
      return m;
    };
    for (const r of s.rows) {
      for (const c of r.cells) {
        const p = parseRef(c.ref);
        if (p) rowOf(p.row).set(p.col, c);
      }
    }
    const targetRow = rowOf(parsed.row);
    targetRow.set(parsed.col, formula ? { ref: normalized, value, formula } : { ref: normalized, value });

    const rows: CellRow[] = [...byRow.keys()]
      .sort((a, b) => a - b)
      .map((n) => {
        const cols = byRow.get(n)!;
        return {
          cells: [...cols.keys()].sort((a, b) => a - b).map((c) => cols.get(c)!),
        };
      });
    return { name: s.name, rows };
  });

  return { sheets };
}

/** Remove a cell entirely (it becomes an empty cell, not a 0). */
export function clearCell(wb: WorkbookData, ref: string, sheetName?: string): WorkbookData {
  const name = sheetName ?? wb.sheets[0]?.name;
  const parsed = parseRef(ref);
  if (!name || !parsed) return wb;
  return {
    sheets: wb.sheets.map((s) =>
      s.name !== name
        ? s
        : {
            name: s.name,
            rows: s.rows
              .map((r) => ({
                cells: r.cells.filter((c) => {
                  const p = parseRef(c.ref);
                  return !(p && p.row === parsed.row && p.col === parsed.col);
                }),
              }))
              .filter((r) => r.cells.length > 0),
          },
    ),
  };
}

/** Inspect a used range, e.g. { rows: 3, cols: 2 }. */
export function usedRange(wb: WorkbookData, sheetName?: string): { rows: number; cols: number } {
  const sheet = sheetName ? wb.sheets.find((s) => s.name === sheetName) : wb.sheets[0];
  if (!sheet) return { rows: 0, cols: 0 };
  let rows = 0;
  let cols = 0;
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const p = parseRef(cell.ref);
      if (!p) continue;
      rows = Math.max(rows, p.row);
      cols = Math.max(cols, p.col);
    }
  }
  return { rows, cols };
}
