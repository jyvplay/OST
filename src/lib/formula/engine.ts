/**
 * Workbook engine: grid storage, formula parsing/caching, dependency-ordered
 * recalculation with cycle detection, and the operator semantics that bind the
 * parser's AST to real values.
 *
 * Scope decision (declared, not hidden): recalculation is a full topological
 * pass over all formula cells on `recalculate()`, not an incrementally-
 * invalidated dependency graph. For the grid sizes this app persists (a
 * spreadsheet document in the VFS, not a million-row workbook) a full pass is
 * fast and removes an entire class of incremental-invalidation bugs. The
 * dependency graph itself (needed for correct evaluation ORDER and for cycle
 * detection) is real and exact — only the "recompute just what changed"
 * optimisation is out of scope.
 *
 * v3.4 (TT15) — dynamic arrays:
 *  - Every expression evaluates to a Value = Scalar | Scalar[][] internally
 *    (`evalRaw`). Unary/binary operators broadcast element-wise (Excel 365
 *    semantics: a 1×N / N×1 / 1×1 operand stretches; mismatched sizes give #N/A
 *    in the non-overlapping area). `evaluate()` keeps its old scalar contract by
 *    implicit intersection (top-left), so every pre-existing caller and every
 *    LibreOffice-oracle vector sees identical results.
 *  - A cell whose formula yields a multi-cell array SPILLS into neighbours.
 *    Reservation is deterministic (sheet order, then row-major anchor order);
 *    any non-empty source cell or an earlier anchor's reservation in the target
 *    block blocks the WHOLE array with #SPILL! (no partial publication).
 *    Spill references are resolved by a bounded fixed point (≤ 8 passes); a
 *    reservation map that has not stabilised by then yields #CALC! on the
 *    anchors still changing, never an endless loop.
 *  - Functions not in the first-party oracle-verified table are served by the
 *    extended library (./ext) through an adapter; the first-party table always
 *    wins on name collisions.
 */
import type { ChartSpec, CondRule } from "./sheetmeta";
import type { SheetLink } from "./sheetlinks";
import type { PivotDef } from "./pivotsheet";
import { parseFormula, MAX_ROW, MAX_COL } from "./parser";
import { setDate1904 } from "./dates";
import { takesArray } from "./paramkinds";
import { validateName, type DefinedName } from "./names";
import { colToLetters, isError, type CellAddr, type ErrorCode, type Node, type RangeAddr, type Scalar } from "./types";
import { FUNCTIONS, toBool, toNumberStrict, toStr, type Arg } from "./functions";
import { err } from "./types";
import { EXT_FUNCTIONS, isGridValue, type ArgAccessor, type ExtValue, type ResultValue } from "./ext";

export interface Cell { input: string; formula: Node | null; value: Scalar; error?: string; /** TT46: legacy (pre-dynamic-array) formula read from .xlsx — implicit intersection, never spills. */ legacy?: boolean; /** TT74: legacy CSE array formula range (t="array" ref=…): the result is shaped to exactly this size. */ cse?: { rows: number; cols: number }; spill?: { rows: number; cols: number } | null; spillGrid?: Scalar[][] | null; style?: CellStyle }
/** Presentation-only attributes. Never affect values (DP-04: no silent mutation of data). */
export type BorderLine = "thin" | "medium" | "thick" | "dashed" | "dotted" | "double" | "hair";
export interface BorderSide { style: BorderLine; color?: string }
/** ECMA-376 §18.8.4 border: each cell stores its own four edges (adjacent cells are independent). */
export interface CellBorder { top?: BorderSide; right?: BorderSide; bottom?: BorderSide; left?: BorderSide }
export interface CellStyle { bold?: boolean; italic?: boolean; underline?: boolean; align?: "left" | "center" | "right"; valign?: "top" | "center" | "bottom"; fill?: string; color?: string; numFmt?: string; wrap?: boolean; border?: CellBorder }
/** Merged area (0-based, inclusive). The value lives in the top-left cell; the others are blank. */
export interface MergeRange { c0: number; r0: number; c1: number; r1: number }
export type ValidationType = "list" | "whole" | "decimal" | "textLength" | "date" | "custom";
export type ValidationOp = "between" | "notBetween" | "equal" | "notEqual" | "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual";
/** ECMA-376 §18.3.1.32 dataValidation. formula1/2 are stored WITHOUT a leading "=" (as in the file format). */
export interface DataValidation {
  id: string; sqref: string; type: ValidationType; operator?: ValidationOp; formula1: string; formula2?: string;
  allowBlank: boolean; errorStyle: "stop" | "warning" | "information"; showError: boolean; inCellDropdown: boolean;
  errorTitle?: string; error?: string; promptTitle?: string; prompt?: string;
}
export type SheetGrid = Map<string, Cell>;
export type Value = Scalar | Scalar[][];

export const SPILL_CELL_LIMIT = 20_000;
export const SPILL_MAX_PASSES = 8;

const key = (col: number, row: number) => `${col},${row}`;
/**
 * TT47: input that reproduces TEXT exactly. Text that would otherwise parse as a number, boolean or formula
 * (or that itself starts with an apostrophe) gets Excel's quote prefix; the cell VALUE stays the plain text.
 */
export function textInput(text: string): string {
  if (text === "") return "";
  return text.startsWith("=") || text.startsWith("'") || typeof parseLiteral(text) !== "string" ? `'${text}` : text;
}
export const a1 = (col: number, row: number) => `${colToLetters(col)}${row + 1}`;
const isGrid = (v: Value): v is Scalar[][] => Array.isArray(v);

/** Parse a raw input string into either a literal Scalar or a formula AST. */
function parseLiteral(input: string): Scalar {
  if (input === "") return "";
  // TT47: Excel's quote prefix — a leading apostrophe makes the rest literal text ('0012, 'TRUE, '=A1)
  if (input.startsWith("'")) return input.slice(1);
  const n = Number(input);
  if (input.trim() !== "" && !Number.isNaN(n)) return n;
  if (/^(TRUE|FALSE)$/i.test(input.trim())) return input.trim().toUpperCase() === "TRUE";
  // TT68: an error literal typed (or stored as a t="e" constant) is an ERROR value, as in Excel — ISERROR(#N/A typed) is TRUE.
  const e = input.trim().toUpperCase();
  if (CONST_ERRORS.has(e)) return err(e as ErrorCode);
  return input;
}
/** ECMA-376 ST_CellError — the error literals a cell constant can hold. */
const CONST_ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"]);

export class Sheet {
  grid: SheetGrid = new Map();
  name: string;
  /** Column widths in px (presentation only). */
  colWidths: Record<number, number> = {};
  /** Frozen top rows (presentation only; exported as an xlsx pane). */
  freezeRows = 0;
  /** Frozen left columns (TT17; exported as pane xSplit). */
  freezeCols = 0;
  /** Merged areas (TT17; <mergeCells>). Non-overlapping, each ≥ 2 cells. */
  merges: MergeRange[] = [];
  /** Data-validation rules (TT17; <dataValidations>). */
  validations: DataValidation[] = [];
  /** Cell hyperlinks (TT57; <hyperlinks> + sheet rels). */
  links: SheetLink[] = [];
  /** TT58: PivotTables shown on this sheet (definitions; their output is ordinary cells). */
  pivots: PivotDef[] = [];
  /** TT74: hidden rows — "manual" (Hide) or "filter" (rejected by the AutoFilter); see sheetfilter.ts. */
  hiddenRows: Map<number, "manual" | "filter"> = new Map();
  /** TT74: hidden columns (presentation; <col hidden="1">). */
  hiddenCols: Set<number> = new Set();
  /** TT74: the sheet AutoFilter (range incl. header row; shown values per column offset). */
  autoFilter: { ref: string; cols: Record<number, string[]>; foreign?: boolean } | null = null;
  constructor(name = "Sheet1") { this.name = name; }

  setCell(col: number, row: number, input: string) {
    const k = key(col, row);
    const style = this.grid.get(k)?.style;
    if (input === "") { if (style) this.grid.set(k, { input: "", formula: null, value: "", style }); else this.grid.delete(k); return; }
    if (input.startsWith("=")) {
      try {
        this.grid.set(k, { input, formula: parseFormula(input), value: "", style });
      } catch (e) {
        this.grid.set(k, { input, formula: null, value: err("#NAME?"), error: (e as Error).message, style });
      }
    } else {
      this.grid.set(k, { input, formula: null, value: parseLiteral(input), style });
    }
  }
  setStyle(col: number, row: number, patch: Partial<CellStyle> | null) {
    const k = key(col, row);
    const cur = this.grid.get(k);
    const style = patch === null ? undefined : { ...(cur?.style ?? {}), ...patch };
    if (style) for (const p of Object.keys(style) as (keyof CellStyle)[]) if (style[p] === undefined || style[p] === "" || style[p] === false) delete style[p];
    const empty = !style || Object.keys(style).length === 0;
    if (cur) { if (empty && cur.input === "") this.grid.delete(k); else this.grid.set(k, { ...cur, style: empty ? undefined : style }); }
    else if (!empty) this.grid.set(k, { input: "", formula: null, value: "", style });
  }
  get(col: number, row: number): Cell | undefined { return this.grid.get(key(col, row)); }
  /** A cell that blocks a spill: anything with user input (a styled blank does not block). */
  occupied(col: number, row: number): boolean { const c = this.grid.get(key(col, row)); return !!c && c.input !== ""; }
  cellAddr(col: number, row: number): CellAddr { return { sheet: this.name, col, row, colAbs: false, rowAbs: false }; }
}

interface SpillClaim { anchorSheet: string; anchorCol: number; anchorRow: number; r: number; c: number }
const fqKey = (sheet: string, col: number, row: number) => `${sheet}!${col},${row}`;

/** TT73: one linked workbook's cached copy. `sheets`: upper-case sheet name → "col,row" → value; `names`: upper-case
 *  defined name → refers-to text in the linked book (e.g. "='Defines'!$B$2"). */
export interface ExternalBook { target: string; sheetNames: string[]; sheets: Map<string, Map<string, Scalar>>; /** "NAME" or "sheetId|NAME" */ names: Map<string, string> }
/** `[1]` → book 1; `[Book.xlsx]` / `[file:///…/Book.xlsx]` → the linked book whose target has that file name. */
export function externalBook(books: ExternalBook[], key: string): ExternalBook | undefined {
  if (/^\d+$/.test(key)) return books[Number(key) - 1];
  const base = (p: string) => p.replace(/^'|'$/g, "").split(/[\\/]/).pop()!.toLowerCase();
  return books.find((b) => base(b.target) === base(key));
}
export class Workbook {
  sheets = new Map<string, Sheet>();
  /** fq child key -> owning anchor (children only; anchors are not listed). */
  spillOwner = new Map<string, SpillClaim>();
  /** Diagnostics of the last recalculation (exposed for tests and the UI status bar). */
  lastRecalc = { passes: 0, stable: true, spills: 0, blocked: 0 };
  /** Presentation metadata (TT15): charts and conditional-format rules, persisted in workbook JSON. */
  charts: ChartSpec[] = [];
  condFormats: CondRule[] = [];
  /** TT19 defined names. Key: `${scope ?? ""}|${NAME_UPPER}`. */
  names = new Map<string, DefinedName>();
  /** TT46: Excel tables (xl/tables/tableN.xml) — the targets of structured references. Key: upper-case name. */
  tables = new Map<string, TableDef>();
  /** TT46: 1904 date system (<workbookPr date1904="1">). */
  date1904 = false;
  /** TT73: linked external workbooks (xl/externalLinks/externalLinkN.xml, ECMA-376 §18.14) — the cached values Excel shows
   *  while the source book is closed. Index k holds the book that formulas call [k+1]. Read-only: never recalculated. */
  externals: ExternalBook[] = [];
  /** `[1]Sheet` / `[book.xlsx]Sheet` (the sheet part of an external reference) → the cached cell value; "" when the
   *  cache has no such cell (Excel shows it as 0 / blank), #REF! when the book or sheet is not linked. */
  externalValue(sheetToken: string, col: number, row: number): Scalar {
    const m = /^\[([^\]]+)\](.*)$/.exec(sheetToken); if (!m) return err("#REF!");
    const book = externalBook(this.externals, m[1]); if (!book) return err("#REF!");
    const cells = book.sheets.get(m[2].toUpperCase()); if (!cells) return err("#REF!");
    return cells.get(`${col},${row}`) ?? "";
  }
  private nameAst = new Map<string, Node | null>();
  private expandCache = new WeakMap<Node, Map<string, Node>>();
  private namesVersion = 0;
  constructor() { this.addSheet("Sheet1"); }

  private nameKey(name: string, scope: string | null) { return `${scope ?? ""}|${name.toUpperCase()}`; }
  /** Defines (or redefines) a name. Throws a user-facing message on invalid input. */
  defineName(name: string, ref: string, scope: string | null = null, comment?: string) {
    const bad = validateName(name);
    if (bad) throw new Error(bad);
    if (scope !== null && !this.sheets.has(scope)) throw new Error(`no such sheet: ${scope}`);
    const body = ref.trim().replace(/^=/, "");
    if (!body) throw new Error("a name must refer to something");
    parseFormula(`=${body}`); // syntax check now, not at first use
    const k = this.nameKey(name, scope);
    this.names.set(k, { name, ref: body, scope, ...(comment ? { comment: comment.slice(0, 255) } : {}) });
    this.nameAst.delete(k); this.namesVersion++; this.expandCache = new WeakMap();
  }
  deleteName(name: string, scope: string | null = null) {
    const k = this.nameKey(name, scope);
    const ok = this.names.delete(k);
    this.nameAst.delete(k); this.namesVersion++; this.expandCache = new WeakMap();
    return ok;
  }
  /** Sheet-scoped names shadow workbook names on their own sheet (Excel precedence). */
  lookupName(name: string, sheet: string | null): DefinedName | undefined {
    const bang = name.lastIndexOf("!");
    if (bang > 0) { // TT46: Sheet!Name → that sheet's scoped name (else the workbook name)
      const raw = name.slice(0, bang); const sc = raw.startsWith("'") ? raw.slice(1, -1).replace(/''/g, "'") : raw; const nm = name.slice(bang + 1);
      // TT73: [0]!Name is this workbook's name; [k]!Name is a defined name of linked book k, read from its cached copy
      const ext = /^\[(\d+)\](.*)$/.exec(sc);
      if (ext) {
        if (ext[1] === "0") return this.names.get(this.nameKey(nm, ext[2] || null)) ?? this.names.get(this.nameKey(nm, null));
        const bk = this.externals[Number(ext[1]) - 1]; if (!bk) return undefined;
        // [1]Sheet!Name → that linked sheet's scoped name (sheetId = its index in <sheetNames>), else the book-level name
        const si = ext[2] ? bk.sheetNames.findIndex((x) => x.toUpperCase() === ext[2].toUpperCase()) : -1;
        const d = (si >= 0 ? bk.names.get(`${si}|${nm.toUpperCase()}`) : undefined) ?? bk.names.get(nm.toUpperCase()); if (!d) return undefined;
        const r = /^=?\s*(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(d);
        return { name: nm, scope: `[${ext[1]}]`, ref: r ? `'[${ext[1]}]${(r[1] ?? r[2]).replace(/'/g, "''")}'!${r[3]}` : d.replace(/^=/, "") };
      }
      return this.names.get(this.nameKey(nm, sc)) ?? this.names.get(this.nameKey(nm, null));
    }
    return (sheet !== null ? this.names.get(this.nameKey(name, sheet)) : undefined) ?? this.names.get(this.nameKey(name, null));
  }
  listNames(): DefinedName[] { return [...this.names.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.scope ?? "").localeCompare(b.scope ?? "")); }
  private defAst(d: DefinedName): Node | null {
    const k = this.nameKey(d.name, d.scope);
    if (!this.nameAst.has(k)) { try { this.nameAst.set(k, parseFormula(`=${d.ref}`)); } catch { this.nameAst.set(k, null); } }
    return this.nameAst.get(k) ?? null;
  }
  /**
   * Replaces name nodes with their definitions. Unqualified references inside a definition belong to the
   * name's scope sheet (or, for workbook names, the sheet the formula lives on). Unknown → #NAME?;
   * a name that (indirectly) refers to itself → #NAME? after 32 levels (declared; Excel also refuses).
   */
  expandNames(node: Node, sheet: string, depth = 0): Node {
    if (this.names.size === 0 && this.externals.length === 0) return node;
    let perNode = this.expandCache.get(node);
    const ck = `${sheet}|${depth}`;
    const hit = perNode?.get(ck);
    if (hit) return hit;
    const out = this.expandUncached(node, sheet, depth);
    if (!perNode) { perNode = new Map(); this.expandCache.set(node, perNode); }
    perNode.set(ck, out);
    return out;
  }
  private expandUncached(node: Node, sheet: string, depth: number): Node {
    const qualify = (n: Node, home: string): Node => {
      if (n.t === "ref") return n.v.sheet ? n : { t: "ref", v: { ...n.v, sheet: home } };
      if (n.t === "range") return n.v.from.sheet ? n : { t: "range", v: { from: { ...n.v.from, sheet: home }, to: { ...n.v.to, sheet: n.v.to.sheet ?? home } } };
      return n;
    };
    const walk = (n: Node, home: string, d: number): Node => {
      switch (n.t) {
        case "name": {
          if (d > 32) return { t: "err", v: "#NAME?" };
          const def = this.lookupName(n.name, home);
          const ast = def ? this.defAst(def) : null;
          if (!def || !ast) return { t: "err", v: "#NAME?" };
          return walk(ast, def.scope ?? home, d + 1);
        }
        case "ref": case "range": return d > 0 ? qualify(n, home) : n;
        case "call": return { ...n, args: n.args.map((a) => walk(a, home, d)) };
        case "unary": return { ...n, arg: walk(n.arg, home, d) };
        case "percent": return { ...n, arg: walk(n.arg, home, d) };
        case "binary": return { ...n, left: walk(n.left, home, d), right: walk(n.right, home, d) };
        case "array": return n;
        default: return n;
      }
    };
    return walk(node, sheet, depth);
  }
  addSheet(name: string) { const s = new Sheet(name); this.sheets.set(name, s); return s; }
  sheet(name?: string | null) { const s = this.sheets.get(name ?? [...this.sheets.keys()][0]); if (!s) throw new Error(`no such sheet: ${name}`); return s; }

  /** Displayed value at a position: the cell's own value, or a spilled child value. */
  valueAt(sheetName: string, col: number, row: number): Scalar | undefined {
    const cell = this.sheets.get(sheetName)?.get(col, row);
    if (cell && cell.input !== "") return cell.value;
    const claim = this.spillOwner.get(fqKey(sheetName, col, row));
    if (!claim) return cell ? "" : undefined;
    const anchor = this.sheets.get(claim.anchorSheet)?.get(claim.anchorCol, claim.anchorRow);
    return anchor?.spillGrid?.[claim.r]?.[claim.c] ?? "";
  }
  spillAnchorOf(sheetName: string, col: number, row: number): SpillClaim | undefined { return this.spillOwner.get(fqKey(sheetName, col, row)); }

  /**
   * TT49: evaluate a formula (conditional-format expression, cfvo formula, cellIs operand) as if it sat in
   * (sheet, col, row), against the values of the last recalculation. Read-only — never writes a cell. Array
   * results collapse to their top-left element (CF formulas are evaluated as array formulas, not legacy implicit
   * intersection); errors are returned as values.
   */
  evalFormulaAt(sheetName: string, col: number, row: number, formula: Node | string): Scalar {
    const prev = setDate1904(this.date1904);
    try {
      const node = typeof formula === "string" ? parseFormula(formula.startsWith("=") ? formula : "=" + formula) : formula;
      const isBlank = (s: string | null, c: number, r: number, home?: string): boolean => {
        const sn = s ?? home ?? sheetName; const cell = this.sheets.get(sn)?.get(c, r);
        if (cell && cell.input !== "") return false;
        return !this.spillOwner.has(fqKey(sn, c, r));
      };
      const vAt = (s: string, c: number, r: number): Scalar => this.valueAt(s, c, r) ?? "";
      const occCache = new Map<string, Set<number>>();
      const occOf = (sn: string) => { let o = occCache.get(sn); if (!o) { o = occupiedRows(this.sheets.get(sn)); occCache.set(sn, o); } return o; };
      let wbBounds: { r: number; c: number } | null = null;
      const shaped = (range: RangeAddr): Scalar[][] => {
        const { range: r, full } = clampLarge(range, () => (wbBounds ??= this.workbookBounds()));
        return withFull(resolveRangeMatrix(r, sheetName, vAt, occOf), full);
      };
      const ctx: EvalContext = {
        resolveRef: (addr) => vAt(addr.sheet ?? sheetName, addr.col, addr.row),
        resolveRange: shaped,
        cursor: { sheet: sheetName, col, row },
        isBlank,
        sheetsBetween: (a, b) => { const order = [...this.sheets.keys()]; const i = order.findIndex((x) => x.toUpperCase() === a.toUpperCase()), j = order.findIndex((x) => x.toUpperCase() === b.toUpperCase()); return i < 0 || j < 0 ? null : order.slice(Math.min(i, j), Math.max(i, j) + 1); },
        table: (name) => (name ? this.tables.get(name.toUpperCase()) : [...this.tables.values()].find((t) => t.sheet === sheetName && col >= t.c0 && col <= t.c1 && row >= t.r0 && row <= t.r1)),
        sheetExists: (n) => this.sheets.has(n),
        expandName: (n) => (this.lookupName(n, sheetName) ? this.expandNames({ t: "name", name: n }, sheetName) : null),
        cellInput: (s, c, r) => this.sheets.get(s ?? sheetName)?.get(c, r)?.input,
        rowHidden: (s, r) => this.sheets.get(s ?? sheetName)?.hiddenRows.get(r),
      };
      let top = this.names.size || this.externals.length ? this.expandNames(node, sheetName) : node;
      top = resolveRefNode(top, ctx);
      const v = top.t === "ref" && isBlank(top.v.sheet, top.v.col, top.v.row, sheetName) ? 0 : evalRaw(top, ctx);
      return isGrid(v) ? (v[0]?.[0] ?? "") : v;
    } catch (e) { return (e as { code?: Scalar }).code ?? err("#VALUE!"); }
    finally { setDate1904(prev); }
  }
  /** TT70: used area of the WORKBOOK (last row / col holding input or a spill on any sheet) — clamps whole-column refs. */
  private workbookBounds(): { r: number; c: number } {
    const b = { r: 0, c: 0 };
    for (const sh of this.sheets.values()) for (const [k, cell] of sh.grid) {
      if (cell.input === "") continue;
      const comma = k.indexOf(","); const c = Number(k.slice(0, comma)), r = Number(k.slice(comma + 1));
      const r1 = cell.spill ? r + cell.spill.rows - 1 : r, c1 = cell.spill ? c + cell.spill.cols - 1 : c;
      if (r1 > b.r) b.r = r1; if (c1 > b.c) b.c = c1;
    }
    return b;
  }

  /** Full dependency-ordered recalculation with cycle detection and bounded spill fixed point. */
  recalculate(): void {
    const prev = setDate1904(this.date1904);
    try { this.recalculateInner(); } finally { setDate1904(prev); }
  }
  private recalculateInner(): void {
    let prevSig = "";
    let passes = 0;
    let stable = false;
    let claims = new Map<string, SpillClaim>();
    let blocked = 0;
    for (passes = 1; passes <= SPILL_MAX_PASSES; passes++) {
      const r = this.pass();
      claims = r.claims; blocked = r.blocked;
      const sig = [...claims.entries()].map(([k, v]) => `${k}>${v.anchorSheet}!${v.anchorCol},${v.anchorRow}`).sort().join("|");
      this.spillOwner = claims;
      if (sig === prevSig) { stable = true; break; }
      prevSig = sig;
    }
    if (!stable) {
      // [declared] Not converged: every anchor that currently spills is marked #CALC!
      // and its reservation withdrawn, so no value derived from an unstable map is shown.
      for (const s of this.sheets.values()) for (const cell of s.grid.values()) if (cell.spill) { cell.value = err("#CALC!"); cell.spill = null; cell.spillGrid = null; }
      this.spillOwner = new Map();
      passes = SPILL_MAX_PASSES;
    }
    this.lastRecalc = { passes, stable, spills: new Set([...this.spillOwner.values()].map((c) => fqKey(c.anchorSheet, c.anchorCol, c.anchorRow))).size, blocked };
  }

  private pass(): { claims: Map<string, SpillClaim>; blocked: number } {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const raw = new Map<string, Value>();
    const prevOwner = this.spillOwner;

    /** Truly empty (no input, no spilled value) — Excel's "blank", distinct from a formula that returns "". */
    const isBlank = (sheetName: string | null, col: number, row: number, home?: string): boolean => {
      const sn = sheetName ?? home ?? "";
      if (sn.startsWith("[") && !this.sheets.has(sn)) return this.externalValue(sn, col, row) === ""; // TT73
      const cell = this.sheets.get(sn)?.get(col, row);
      if (cell && cell.input !== "") return false;
      return !prevOwner.has(fqKey(sn, col, row));
    };
    const occCache = new Map<string, Set<number>>();
    const occOf = (sn: string) => { let o = occCache.get(sn); if (!o) { o = occupiedRows(this.sheets.get(sn)); occCache.set(sn, o); } return o; };
    /** Whole-column/row and very large ranges are evaluated over the WORKBOOK's used area (TT70: one bound for all sheets,
     *  so Sheet1!A:A and Data!A:A keep the same shape) and carry their full shape for blank-counting functions. */
    let wbBounds: { r: number; c: number } | null = null;
    const shapedRange = (range: RangeAddr, home: string): Scalar[][] => {
      const { range: r, full } = clampLarge(range, () => (wbBounds ??= this.workbookBounds()));
      return withFull(resolveRangeMatrix(r, home, evalCell, occOf), full);
    };
    const evalCell = (sheetName: string, col: number, row: number): Scalar => {
      const fk = fqKey(sheetName, col, row);
      const sheet = this.sheets.get(sheetName);
      if (!sheet && sheetName.startsWith("[")) return this.externalValue(sheetName, col, row); // TT73: linked book cache
      const cell = sheet?.get(col, row);
      if (!cell || cell.input === "") {
        // Spilled child (reservation from the previous pass of the fixed point).
        const claim = prevOwner.get(fk);
        if (!claim) return "";
        const v = evalRawCell(claim.anchorSheet, claim.anchorCol, claim.anchorRow);
        if (!isGrid(v)) return "";
        return v[claim.r]?.[claim.c] ?? "";
      }
      const v = evalRawCell(sheetName, col, row);
      return isGrid(v) ? (v[0]?.[0] ?? "") : v;
    };
    const evalRawCell = (sheetName: string, col: number, row: number): Value => {
      const fk = fqKey(sheetName, col, row);
      const c0 = color.get(fk) ?? WHITE;
      if (c0 === GRAY) return err("#CIRCULAR!");
      const cell = this.sheets.get(sheetName)?.get(col, row);
      if (!cell) return "";
      if (!cell.formula) return cell.value;
      if (c0 === BLACK) return raw.get(fk) ?? cell.value;
      color.set(fk, GRAY);
      const ctx: EvalContext = {
        resolveRef: (addr) => evalCell(addr.sheet ?? sheetName, addr.col, addr.row),
        resolveRange: (range) => shapedRange(range, sheetName),
        cursor: { sheet: sheetName, col, row },
        isBlank,
        sheetsBetween: (a, b) => { const order = [...this.sheets.keys()]; const i = order.findIndex((x) => x.toUpperCase() === a.toUpperCase()), j = order.findIndex((x) => x.toUpperCase() === b.toUpperCase()); return i < 0 || j < 0 ? null : order.slice(Math.min(i, j), Math.max(i, j) + 1); },
        table: (name) => (name ? this.tables.get(name.toUpperCase()) : [...this.tables.values()].find((t) => t.sheet === sheetName && col >= t.c0 && col <= t.c1 && row >= t.r0 && row <= t.r1)),
        sheetExists: (n) => this.sheets.has(n),
        expandName: (n) => (this.lookupName(n, sheetName) ? this.expandNames({ t: "name", name: n }, sheetName) : null),
        legacy: !!cell.legacy,
        cellInput: (s, c, r) => this.sheets.get(s ?? sheetName)?.get(c, r)?.input,
        rowHidden: (s, r) => this.sheets.get(s ?? sheetName)?.hiddenRows.get(r),
      };
      let value: Value;
      try {
        let top = this.names.size || this.externals.length ? this.expandNames(cell.formula, sheetName) : cell.formula;
        top = resolveRefNode(top, ctx);
        if (ctx.legacy && top.t === "range") top = intersectNode(top, ctx);
        // A formula whose result IS a blank cell displays 0 (=A9, =OFFSET(...), =INDEX(...)) — Excel semantics.
        value = top.t === "ref" && isBlank(top.v.sheet, top.v.col, top.v.row, sheetName) ? 0 : evalRaw(top, ctx);
      }
      catch (e) { value = (e as { code?: Scalar }).code ?? err("#VALUE!"); }
      // TT74: a CSE array formula fills exactly its entered range — a scalar or a single row/column is repeated, cells
      // beyond a smaller result show #N/A, a larger result is cut (Excel legacy array semantics; POI 57798).
      if (cell.cse && (cell.cse.rows > 1 || cell.cse.cols > 1)) {
        const src: Scalar[][] = isGrid(value) ? value : [[value as Scalar]];
        const R = src.length, C = src[0]?.length ?? 0;
        value = Array.from({ length: cell.cse.rows }, (_, r) => Array.from({ length: cell.cse!.cols }, (_, c) =>
          (R === 1 || r < R) && (C === 1 || c < C) ? (src[R === 1 ? 0 : r]?.[C === 1 ? 0 : c] ?? err("#N/A")) : err("#N/A")));
      }
      if (isGrid(value) && (ctx.legacy || (value.length === 1 && value[0].length === 1))) value = value[0]?.[0] ?? "";
      if (isGrid(value) && value.length * (value[0]?.length ?? 0) > SPILL_CELL_LIMIT) value = err("#NUM!");
      raw.set(fk, value);
      cell.value = isGrid(value) ? (value[0]?.[0] ?? "") : value;
      cell.spillGrid = isGrid(value) ? value : null;
      color.set(fk, BLACK);
      return value;
    };

    // Deterministic evaluation/reservation order: sheet order, then row-major.
    const anchors: { sheet: Sheet; col: number; row: number; cell: Cell }[] = [];
    for (const sheet of this.sheets.values()) {
      const cells: { col: number; row: number; cell: Cell }[] = [];
      for (const [k, cell] of sheet.grid) if (cell.formula) { const [c, r] = k.split(",").map(Number); cells.push({ col: c, row: r, cell }); }
      cells.sort((a, b) => a.row - b.row || a.col - b.col);
      for (const x of cells) { evalRawCell(sheet.name, x.col, x.row); anchors.push({ sheet, ...x }); }
    }

    const claims = new Map<string, SpillClaim>();
    let blocked = 0;
    for (const { sheet, col, row, cell } of anchors) {
      const g = cell.spillGrid;
      if (!g) { cell.spill = null; continue; }
      const rows = g.length, cols = g[0]?.length ?? 0;
      let ok = rows > 0 && cols > 0;
      const mine: string[] = [];
      for (let r = 0; ok && r < rows; r++) for (let c = 0; c < cols; c++) {
        if (r === 0 && c === 0) continue;
        if (row + r > 1_048_575 || col + c > 16_383 || sheet.occupied(col + c, row + r) || claims.has(fqKey(sheet.name, col + c, row + r))) { ok = false; break; }
        mine.push(`${r},${c}`);
      }
      if (!ok) { cell.value = err("#SPILL!"); cell.spill = null; cell.spillGrid = null; blocked++; continue; }
      cell.spill = { rows, cols };
      for (const rc of mine) { const [r, c] = rc.split(",").map(Number); claims.set(fqKey(sheet.name, col + c, row + r), { anchorSheet: sheet.name, anchorCol: col, anchorRow: row, r, c }); }
    }
    return { claims, blocked };
  }
}

/**
 * TT70: clamp a whole-column / whole-row / very large range to the workbook's used area — only along the oversized axis
 * (rows of A:C, columns of 3:5), so a range's shape depends on the reference alone, never on which sheet it points at.
 * Returns the full (unclamped) shape: the cells cut off are blank on every sheet (no input, no spill).
 */
function clampLarge(range: RangeAddr, bounds: () => { r: number; c: number }): { range: RangeAddr; full: [number, number] } {
  const r0 = Math.min(range.from.row, range.to.row), r1 = Math.max(range.from.row, range.to.row);
  const c0 = Math.min(range.from.col, range.to.col), c1 = Math.max(range.from.col, range.to.col);
  const full: [number, number] = [r1 - r0 + 1, c1 - c0 + 1];
  const rows = range.whole === "col" || full[0] > 65_536, cols = range.whole === "row" || full[1] > 1_024;
  if (!rows && !cols) return { range, full };
  const b = bounds();
  const nr1 = rows ? Math.max(r0, Math.min(r1, b.r)) : r1, nc1 = cols ? Math.max(c0, Math.min(c1, b.c)) : c1;
  return { range: { ...range, from: { ...range.from, row: r0, col: c0 }, to: { ...range.to, row: nr1, col: nc1 } }, full };
}
/** attach the full shape (non-enumerable: copies and JSON never carry it) when the matrix was clamped */
function withFull(m: Scalar[][], full: [number, number]): Scalar[][] {
  if (m.length !== full[0] || (m[0]?.length ?? 0) !== full[1]) Object.defineProperty(m, "full", { value: full, enumerable: false });
  return m;
}
/** TT70: rows of a sheet holding input or a spill (any column) — every other row of a range is all-empty. */
function occupiedRows(sh: Sheet | undefined): Set<number> {
  const rows = new Set<number>(); if (!sh) return rows;
  for (const [k, cell] of sh.grid) {
    if (cell.input === "") continue;
    const r = Number(k.slice(k.indexOf(",") + 1));
    if (cell.spill) for (let i = 0; i < cell.spill.rows; i++) rows.add(r + i); else rows.add(r);
  }
  return rows;
}
/** TT70: one shared, frozen all-empty row per width (a mutation throws instead of corrupting other rows). */
const EMPTY_ROWS = new Map<number, Scalar[]>();
function emptyRow(w: number): Scalar[] {
  let e = EMPTY_ROWS.get(w); if (!e) { e = Object.freeze(Array(w).fill("")) as Scalar[]; if (EMPTY_ROWS.size < 64) EMPTY_ROWS.set(w, e); }
  return e;
}
const isSharedEmptyRow = (row: Scalar[]) => EMPTY_ROWS.get(row.length) === row;
const BLANK_ROWS = new Map<number, boolean[]>();
function blankRow(w: number): boolean[] {
  let e = BLANK_ROWS.get(w); if (!e) { e = Object.freeze(Array(w).fill(true)) as boolean[]; if (BLANK_ROWS.size < 64) BLANK_ROWS.set(w, e); }
  return e;
}
/** dense cells evaluated one by one */
const MAX_DENSE_CELLS = 2_097_152;
/** TT70: total cells a sparse (whole-column / very large) range may present: 16 full columns */
const MAX_SPARSE_AREA = 16 * 1_048_576;

function resolveRangeMatrix(range: RangeAddr, defaultSheet: string, evalCell: (s: string, c: number, r: number) => Scalar, occupied?: (sheet: string) => Set<number>): Scalar[][] {
  const sheetName = range.from.sheet ?? defaultSheet;
  const c0 = Math.min(range.from.col, range.to.col), c1 = Math.max(range.from.col, range.to.col);
  const r0 = Math.min(range.from.row, range.to.row), r1 = Math.max(range.from.row, range.to.row);
  const w = c1 - c0 + 1, h = r1 - r0 + 1;
  const NUM = () => Object.assign(new Error("#NUM!"), { code: err("#NUM!") });
  // TT69: 2^21 (two full columns) — the old 1,000,000 cap made one full column #NUM! once data reached the last rows.
  // TT70: large ranges (whole columns / > 200k cells, already clamped to the used area) are SPARSE: rows with no input
  // and no spill share one frozen empty row and are never evaluated cell by cell, so =SUM(A:C) with data in row
  // 1,048,576 is 113, not #NUM!, and takes milliseconds instead of seconds. The dense cap now counts occupied rows only.
  const occ = occupied && w * h > 200_000 ? occupied(sheetName) : null;
  if (!occ) {
    if (w * h > MAX_DENSE_CELLS) throw NUM();
  } else {
    if (w * h > MAX_SPARSE_AREA) throw NUM();
    let dense = 0;
    if (occ.size < h) { for (const r of occ) if (r >= r0 && r <= r1) dense += w; } else dense = w * h;
    if (dense > MAX_DENSE_CELLS) throw NUM();
  }
  const rows: Scalar[][] = new Array(h);
  const empty = occ ? emptyRow(w) : null;
  for (let r = r0; r <= r1; r++) {
    if (empty && !occ!.has(r)) { rows[r - r0] = empty; continue; }
    const row: Scalar[] = new Array(w);
    for (let c = c0; c <= c1; c++) row[c - c0] = evalCell(sheetName, c, r);
    rows[r - r0] = row;
  }
  return rows;
}

export interface TableDef { name: string; sheet: string; c0: number; r0: number; c1: number; r1: number; headerRows: number; totalsRows: number; columns: string[] }
export interface EvalContext {
  /** TT46 (optional so simple contexts keep working): blank detection, 3-D sheet spans, tables. */
  isBlank?(sheet: string | null, col: number, row: number, home?: string): boolean;
  sheetsBetween?(a: string, b: string): string[] | null;
  table?(name: string): TableDef | undefined;
  sheetExists?(name: string): boolean;
  expandName?(name: string): Node | null;
  /** TT74: why a row is hidden (SUBTOTAL / AGGREGATE skip hidden rows). */
  rowHidden?: (sheet: string | null, row: number) => "manual" | "filter" | undefined;
  /** TT46: raw input of a cell (FORMULATEXT, SUBTOTAL nesting). */
  cellInput?(sheet: string | null, col: number, row: number): string | undefined;
  /** TT46: evaluating a legacy formula (implicit intersection). */
  legacy?: boolean;
  resolveRef(addr: CellAddr): Scalar;
  resolveRange(range: RangeAddr): Scalar[][];
  /** The cell being evaluated (for ROW()/COLUMN() with no argument). */
  cursor?: { sheet: string; col: number; row: number };
}

/** Scalar contract (unchanged): arrays collapse by implicit intersection to the top-left element. */
export function evaluate(node: Node, ctx: EvalContext): Scalar {
  const v = evalRaw(node, ctx);
  return isGrid(v) ? (v[0]?.[0] ?? "") : v;
}

/** Array-aware evaluation. */
export function evalRaw(node: Node, ctx: EvalContext): Value {
  switch (node.t) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "err": return err(node.v);
    case "ref": return ctx.resolveRef(node.v);
    case "range": return ctx.resolveRange(node.v);
    case "array": return node.rows.map((row) => row.map((n) => evaluate(n, ctx)));
    case "unary": return map1(evalOperand(node.arg, ctx), (x) => { const v = x === BLANK ? 0 : toNumberStrict(x); return node.op === "-" ? -v : v; });
    case "percent": return map1(evalOperand(node.arg, ctx), (x) => (x === BLANK ? 0 : toNumberStrict(x) / 100));
    case "binary": return map2(evalOperand(node.left, ctx), evalOperand(node.right, ctx), (l, r) => { const v = evalBinary(node.op, l, r); return typeof v === "number" && !Number.isFinite(v) ? err("#NUM!") : v; });
    case "call": {
      if (REF_FORMS.has(node.name)) { const r = resolveRefNode(node, ctx); if (r !== node) return evalRaw(r, ctx); if (node.name.startsWith("__")) return node.name === "__MISSING" ? 0 : err("#VALUE!"); }
      return evalCall(node.name, node.args, ctx);
    }
    case "name": return err("#NAME?"); // only reached when no workbook expanded it (unknown name / no context)
  }
}

const guard = (f: () => Scalar): Scalar => { try { return f(); } catch (e) { return (e as { code?: Scalar }).code ?? err("#VALUE!"); } };
function map1(v: Value, f: (x: Scalar) => Scalar): Value {
  if (!isGrid(v)) return f(v);
  return v.map((row) => row.map((x) => (isError(x) ? x : guard(() => f(x)))));
}
/** Excel-365 broadcasting: singleton rows/cols stretch; outside the common area → #N/A. */
function map2(l: Value, r: Value, f: (a: Scalar, b: Scalar) => Scalar): Value {
  if (!isGrid(l) && !isGrid(r)) return f(l, r);
  const L = isGrid(l) ? l : [[l]], R = isGrid(r) ? r : [[r]];
  const rows = Math.max(L.length, R.length), cols = Math.max(L[0]?.length ?? 0, R[0]?.length ?? 0);
  const pick = (m: Scalar[][], i: number, j: number): Scalar | undefined => {
    const ri = m.length === 1 ? 0 : i, cj = (m[0]?.length ?? 0) === 1 ? 0 : j;
    return m[ri]?.[cj];
  };
  const out: Scalar[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: Scalar[] = [];
    for (let j = 0; j < cols; j++) {
      const a = pick(L, i, j), b = pick(R, i, j);
      row.push(a === undefined || b === undefined ? err("#N/A") : guard(() => f(a, b)));
    }
    out.push(row);
  }
  return out;
}

function evalBinary(op: string, l: Scalar, r: Scalar): Scalar {
  if (isError(l)) return l;
  if (isError(r)) return r;
  if (l === BLANK || r === BLANK) {
    // Excel blank: 0 in arithmetic, "" in &, and in comparisons it takes the type of the other operand.
    const as = (other: Scalar): Scalar => (op === "&" ? "" : "+-*/^".includes(op) ? 0 : typeof other === "string" ? "" : typeof other === "boolean" ? false : 0);
    const l2 = l === BLANK ? as(r === BLANK ? 0 : r) : l; r = r === BLANK ? as(l2) : r; l = l2;
  }
  switch (op) {
    case "+": return toNumberStrict(l) + toNumberStrict(r);
    case "-": return toNumberStrict(l) - toNumberStrict(r);
    case "*": return toNumberStrict(l) * toNumberStrict(r);
    case "/": { const d = toNumberStrict(r); return d === 0 ? err("#DIV/0!") : toNumberStrict(l) / d; } // [oracle] 5/0 -> #DIV/0!, propagates through + too
    case "^": return Math.pow(toNumberStrict(l), toNumberStrict(r)); // [oracle] left-assoc chain handled by the parser
    case "&": return toStr(l) + toStr(r); // [oracle] 1&2 -> "12"
    case "=": return typeCompare(l, r) === 0; // [oracle] "A"="a" -> FALSE: case-SENSITIVE text equality (measured, not assumed)
    case "<>": return typeCompare(l, r) !== 0;
    case "<": return typeCompare(l, r) < 0;
    case ">": return typeCompare(l, r) > 0;
    case "<=": return typeCompare(l, r) <= 0;
    case ">=": return typeCompare(l, r) >= 0;
    default: return err("#VALUE!");
  }
}
/** TT49: an Excel comparison between a cell and an operand with Excel's blank semantics (blank takes the other
 * operand's type: 0, "" or FALSE) — the cellIs conditional-format test. Errors never match. */
export function cfCompare(op: "=" | "<>" | "<" | ">" | "<=" | ">=", cell: Scalar | undefined, blank: boolean, operand: Scalar): boolean {
  return evalBinary(op, blank ? BLANK : (cell ?? ""), operand) === true;
}
/** [spec] cross-type ordering: number < text < boolean, matching the documented
 * Excel/Calc sort convention; same-type compares directly (numbers numerically,
 * text case-sensitively per the measured oracle default, booleans false<true). */
function typeCompare(l: Scalar, r: Scalar): number {
  const rank = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  const [rl, rr] = [rank(l), rank(r)];
  if (rl !== rr) return rl - rr;
  if (typeof l === "number" && typeof r === "number") return l - r;
  if (typeof l === "boolean" && typeof r === "boolean") return (l ? 1 : 0) - (r ? 1 : 0);
  // TT46: Excel comparison operators are case-INSENSITIVE ("A"="a" is TRUE; EXACT is the case-sensitive test).
  const a = (l as string).toLowerCase(), b = (r as string).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Lazy special forms: these must NOT eagerly evaluate every argument, either
 * because an untaken branch must never be touched (CHOOSE, IF, IFS) or
 * because they need to observe (and suppress) an error VALUE produced by
 * evaluating one specific argument (IFERROR, IFNA) — see the bug-fix comment
 * in functions.ts for why eager evaluation silently broke all five of these.
 * Array-valued conditions/values are handled element-wise (Excel 365).
 */
function evalLazy(name: string, argNodes: Node[], ctx: EvalContext): Value | undefined {
  switch (name) {
    case "IF": {
      const condRaw = evalRaw(argNodes[0], ctx);
      if (isGrid(condRaw)) {
        const t = argNodes[1] ? evalRaw(argNodes[1], ctx) : true;
        const f = argNodes[2] ? evalRaw(argNodes[2], ctx) : false;
        return map2(map2(condRaw, t, (c, a) => (isError(c) ? c : toBool(c) ? a : ({ skip: true } as unknown as Scalar))), f, (a, b) => (typeof a === "object" && a !== null && "skip" in a ? b : a));
      }
      const cond = toBool(condRaw);
      const branch = cond ? argNodes[1] : argNodes[2];
      if (!branch) return cond; // IF(cond) with a missing branch -> the condition itself
      return evalRaw(branch, ctx);
    }
    case "IFS": {
      for (let i = 0; i + 1 < argNodes.length; i += 2) if (toBool(evaluate(argNodes[i], ctx))) return evalRaw(argNodes[i + 1], ctx);
      return err("#N/A");
    }
    case "CHOOSE": {
      const i = Math.trunc(Number(evaluate(argNodes[0], ctx)));
      const branch = argNodes[i];
      return branch ? evalRaw(branch, ctx) : err("#VALUE!");
    }
    case "IFERROR": {
      const v = evalRaw(argNodes[0], ctx);
      if (isGrid(v)) { const alt = evalRaw(argNodes[1], ctx); return map2(v, alt, (a, b) => (isError(a) ? b : a)); }
      return isError(v) ? evalRaw(argNodes[1], ctx) : v;
    }
    case "IFNA": {
      const v = evalRaw(argNodes[0], ctx);
      if (isGrid(v)) { const alt = evalRaw(argNodes[1], ctx); return map2(v, alt, (a, b) => (isError(a) && a.error === "#N/A" ? b : a)); }
      return isError(v) && v.error === "#N/A" ? evalRaw(argNodes[1], ctx) : v;
    }
    default: return undefined;
  }
}

function evalCall(name: string, argNodes: Node[], ctx: EvalContext): Value {
  if (argNodes.some((n) => n.t === "call" && n.name === "__REF3D")) {
    const out: Node[] = [];
    for (const n of argNodes) { const x = expand3d(n, ctx); if (!x) return err("#REF!"); out.push(...x); }
    argNodes = out;
  }
  if (argNodes.some((n) => n.t === "call" && REF_FORMS.has(n.name) && n.name !== "__MISSING")) argNodes = argNodes.map((n) => resolveRefNode(n, ctx));
  if (ctx.legacy) argNodes = argNodes.map((n, i) => (n.t === "range" && !takesArray(name, i) ? intersectNode(n, ctx) : n));
  // TT69: SUMIF / AVERAGEIF use sum_range's TOP-LEFT cell resized to the shape of `range` (Microsoft: "uses the upper
  // leftmost cell in sum_range as the beginning cell and then includes cells that correspond in size and shape to range");
  // TT68 paired the cells by flat index, so SUMIF(A1:A3,…,C1) summed only C1 and SUMIF(A1:B2,…,C1:C4) paired A2 with C3
  if ((name === "SUMIF" || name === "AVERAGEIF") && argNodes.length === 3) {
    const a = asRange(argNodes[0]), sr = asRange(argNodes[2]);
    if (a && sr) {
      const A = bounds(a), S = bounds(sr);
      if (A.c1 - A.c0 !== S.c1 - S.c0 || A.r1 - A.r0 !== S.r1 - S.r0) {
        // past the sheet edge the resize is clipped (the missing cells pair with nothing; Excel's docs are silent: unverified).
        // Column clipping keeps pairing right because the function pairs by flat index only when widths agree.
        const c1 = Math.min(MAX_COL, S.c0 + (A.c1 - A.c0)), r1 = Math.min(MAX_ROW, S.r0 + (A.r1 - A.r0));
        if (c1 - S.c0 === A.c1 - A.c0) argNodes = [argNodes[0], argNodes[1], mkRef(sr.from.sheet, S.c0, S.r0, c1, r1)];
      }
    }
  }
  if ((name === "ROWS" || name === "COLUMNS") && argNodes.length === 1 && (argNodes[0].t === "range" || argNodes[0].t === "ref")) {
    const v = argNodes[0].t === "ref" ? { from: argNodes[0].v, to: argNodes[0].v } : argNodes[0].v;
    return name === "ROWS" ? Math.abs(v.to.row - v.from.row) + 1 : Math.abs(v.to.col - v.from.col) + 1;
  }
  if (name === "SUBTOTAL" || name === "AGGREGATE") return evalSubtotal(name, argNodes, ctx);
  if (name === "FORMULATEXT") {
    const n = argNodes[0];
    if (!n || (n.t !== "ref" && n.t !== "range")) return n?.t === "err" ? err(n.v) : err("#N/A");
    const a = n.t === "ref" ? n.v : n.v.from; const input = ctx.cellInput?.(a.sheet, a.col, a.row) ?? "";
    return input.startsWith("=") ? input : err("#N/A");
  }
  const lifted = liftCriteria(name, argNodes, ctx);
  if (lifted !== undefined) return lifted;
  if (name === "ROW" || name === "COLUMN") {
    if (argNodes[0]?.t === "ref") return name === "ROW" ? argNodes[0].v.row + 1 : argNodes[0].v.col + 1;
    if (argNodes.length === 0 && ctx.cursor) return name === "ROW" ? ctx.cursor.row + 1 : ctx.cursor.col + 1;
    if (argNodes[0]?.t === "range") {
      const { from, to } = argNodes[0].v;
      return name === "ROW"
        ? Array.from({ length: Math.abs(to.row - from.row) + 1 }, (_, i) => [Math.min(from.row, to.row) + i + 1])
        : [Array.from({ length: Math.abs(to.col - from.col) + 1 }, (_, i) => Math.min(from.col, to.col) + i + 1)];
    }
    return err("#VALUE!");
  }
  const lazy = evalLazy(name, argNodes, ctx);
  if (lazy !== undefined) return lazy;
  const fn = FUNCTIONS[name];
  // Legacy formulas: array-typed parameters are evaluated as arrays (SUMPRODUCT(--(A1:A9)) needs no CSE).
  const actx: EvalContext = ctx.legacy ? { ...ctx, legacy: false } : ctx;
  const ctxFor = (i: number) => (ctx.legacy && takesArray(name, i) ? actx : ctx);
  if (fn) {
    const args: Arg[] = argNodes.map((n, i) => toArg(n, ctxFor(i)));
    try { const r = fn(args); return typeof r === "number" && !Number.isFinite(r) ? err("#NUM!") : r; }
    catch (e) { return (e as { code?: Scalar }).code ?? err("#VALUE!"); }
  }
  const ext = (EXT_FUNCTIONS as Record<string, (a: ArgAccessor[], env: { now: () => Date; random: () => number; cursor: { row: number; col: number } }) => ResultValue>)[name];
  if (!ext) return err("#NAME?");
  return callExt(ext, argNodes, ctx, ctxFor);
}
/**
 * TT68: which elements of a reference / range are truly EMPTY cells (no input, no spilled value). Excel distinguishes an
 * empty cell from empty text "" (ISBLANK, COUNTA, ISTEXT, TYPE, ISNONTEXT, COUNTIF "<>"); the value matrix alone
 * cannot, because both read as "". Returns undefined when the context has no grid (simple contexts).
 */
function blankMask(n: Node, m: Scalar[][], ctx: EvalContext): boolean[][] | undefined {
  if (!ctx.isBlank) return undefined;
  const home = ctx.cursor?.sheet;
  if (n.t === "ref") return [[m[0]?.[0] === "" && ctx.isBlank(n.v.sheet, n.v.col, n.v.row, home)]];
  if (n.t !== "range") return undefined;
  const { c0, r0 } = bounds(n.v);
  // TT70: a shared empty row (sparse range) has no input and no spill in ANY column, so every element is blank
  return m.map((row, i) => (isSharedEmptyRow(row) ? blankRow(row.length) : row.map((x, j) => x === "" && ctx.isBlank!(n.v.from.sheet, c0 + j, r0 + i, home))));
}
function toArg(node: Node, ctx: EvalContext): Arg {
  // reference forms (OFFSET / INDEX / INDIRECT / structured / 3-D) were already resolved to a ref / range by evalCall,
  // so they get a blank mask like any other reference
  const n = node;
  if (n.t === "range") { const value = ctx.resolveRange(n.v); return { kind: "matrix", value, blank: blankMask(n, value, ctx) }; }
  // TT46: a direct single-cell reference behaves like a 1×1 range (SUM ignores its text, COUNTA ignores a blank).
  if (n.t === "ref") { const value = [[ctx.resolveRef(n.v)]]; return { kind: "matrix", value, blank: blankMask(n, value, ctx) }; }
  // computed arrays: their "" elements are VALUES (COUNTA({"",1}) = 2; COUNTA(FILTER(…, "")) = 1)
  const allValues = (value: Scalar[][]): Arg => ({ kind: "matrix", value, blank: ctx.isBlank ? value.map((r) => r.map(() => false)) : undefined });
  if (n.t === "array") return allValues(n.rows.map((row) => row.map((x) => evaluate(x, ctx))));
  const v = evalRaw(n, ctx);
  if (!isGrid(v)) return { kind: "scalar", value: v };
  // an unresolved reference form (multi-area union) keeps the "" guess; anything else computed is all values
  return n.t === "call" && REF_FORMS.has(n.name) ? { kind: "matrix", value: v } : allValues(v);
}

/* ------------------------------------------------ extended-library adapter */
const EXT_ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#SPILL!", "#CALC!", "#CYCLE!", "#ERROR!"]);
/** our Scalar -> ext CellValue. In RANGES an empty string is an empty cell (null). */
function toExt(v: Scalar, inRange: boolean): ExtValue {
  if (isError(v)) return v.error === "#CIRCULAR!" ? "#CYCLE!" : v.error;
  if (inRange && v === "") return null;
  return v;
}
function fromExt(v: ExtValue): Scalar {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? v : err("#NUM!");
  if (typeof v === "string" && EXT_ERRORS.has(v)) return err((v === "#CYCLE!" ? "#CIRCULAR!" : v === "#ERROR!" ? "#VALUE!" : v) as ErrorCode);
  return v;
}
function callExt(fn: (a: ArgAccessor[], env: { now: () => Date; random: () => number; cursor: { row: number; col: number } }) => ResultValue, argNodes: Node[], ctx: EvalContext, ctxFor: (i: number) => EvalContext = () => ctx): Value {
  const accessors: ArgAccessor[] = argNodes.map((n, i) => {
    let cached: Value | undefined;
    const get = () => (cached === undefined ? (cached = evalRaw(n, ctxFor(i))) : cached);
    const isRange = n.t === "range" || n.t === "ref";
    // TT68: a cell holding "" (formula or constant empty text) is a VALUE for TYPE / ISNONTEXT …; only empty cells are null
    let mask: boolean[][] | undefined | null = null;
    const blankOf = (m: Scalar[][]) => (mask === null ? (mask = isRange ? blankMask(n, m, ctx) : undefined) : mask);
    const ext1 = (x: Scalar, i: number, j: number, m: Scalar[][]): ExtValue => {
      if (x !== "") return toExt(x, false);
      const b = blankOf(m); return b ? (b[i]?.[j] ? null : "") : toExt(x, true);
    };
    const grid = (): ExtValue[][] => { const v = get(); if (isGrid(v)) return v.map((r, i) => r.map((x, j) => (isRange ? ext1(x, i, j, v) : toExt(x, true)))); return [[isRange ? ext1(v, 0, 0, [[v]]) : toExt(v, false)]]; };
    return {
      isRange: isRange || n.t === "array" || (n.t === "call" && isGrid(get())),
      grid,
      list: () => grid().flat(),
      value: () => { const v = get(); const x = isGrid(v) ? (v[0]?.[0] ?? "") : v; return isRange ? ext1(x, 0, 0, isGrid(v) ? v : [[v]]) : toExt(x, false); },
    };
  });
  const env = { now: () => new Date(), random: Math.random, cursor: { row: (ctx.cursor?.row ?? 0) + 1, col: (ctx.cursor?.col ?? 0) + 1 } };
  try {
    const r = fn(accessors, env);
    if (isGridValue(r)) return r.map((row) => row.map(fromExt));
    return fromExt(r as ExtValue);
  } catch (e) {
    const code = (e as { code?: Scalar }).code;
    if (code) return code;
    const msg = (e as Error).message;
    return EXT_ERRORS.has(msg) ? fromExt(msg) : err("#VALUE!");
  }
}

/* ---------------------------------------------------- TT46 reference layer */
/** Operand-only marker for an empty cell; never stored, never returned from evalBinary/map1. */
const BLANK = Object.freeze({ blank: true }) as unknown as Scalar;
const REF_FORMS = new Set(["OFFSET", "INDIRECT", "INDEX", "__SREF", "__REF3D", "__MISSING", "__ISECT", "__UNION"]);
const isMissing = (n: Node | undefined) => !n || (n.t === "call" && n.name === "__MISSING");
const errNode = (code: ErrorCode): Node => ({ t: "err", v: code });
function asRange(n: Node): RangeAddr | null { return n.t === "range" ? n.v : n.t === "ref" ? { from: n.v, to: n.v } : null; }
function bounds(r: RangeAddr) { return { c0: Math.min(r.from.col, r.to.col), c1: Math.max(r.from.col, r.to.col), r0: Math.min(r.from.row, r.to.row), r1: Math.max(r.from.row, r.to.row) }; }
function mkRef(sheet: string | null, c0: number, r0: number, c1: number, r1: number): Node {
  if (c0 < 0 || r0 < 0 || c1 > MAX_COL || r1 > MAX_ROW || c1 < c0 || r1 < r0) return errNode("#REF!");
  const a = (col: number, row: number): CellAddr => ({ sheet, col, row, colAbs: true, rowAbs: true });
  return c0 === c1 && r0 === r1 ? { t: "ref", v: a(c0, r0) } : { t: "range", v: { from: a(c0, r0), to: a(c1, r1) } };
}
/** Evaluates a numeric argument; a grid (array argument) or error aborts the reference form. */
function intArg(n: Node | undefined, dflt: number, ctx: EvalContext): number | Node {
  if (isMissing(n)) return dflt;
  const v = evalRaw(resolveRefNode(n!, ctx), ctx);
  if (isGrid(v)) return n!;
  if (isError(v)) return errNode(v.error);
  try { return Math.trunc(toNumberStrict(v)); } catch (e) { return errNode(((e as { code?: { error: ErrorCode } }).code?.error) ?? "#VALUE!"); }
}
/** OFFSET / INDIRECT / reference-form INDEX / structured / single-sheet 3-D → a concrete ref/range node (or #REF!). */
export function resolveRefNode(node: Node, ctx: EvalContext): Node {
  if (node.t !== "call" || !REF_FORMS.has(node.name)) return node;
  const a = node.args;
  switch (node.name) {
    case "OFFSET": {
      if (a.length < 3) return errNode("#VALUE!");
      const baseN = resolveRefNode(a[0], ctx); const base = asRange(baseN);
      if (!base) return baseN.t === "err" ? baseN : errNode("#VALUE!");
      const b = bounds(base);
      const vals: number[] = [];
      for (const [i, d] of [[1, 0], [2, 0], [3, b.r1 - b.r0 + 1], [4, b.c1 - b.c0 + 1]] as const) { const x = intArg(a[i], d, ctx); if (typeof x !== "number") return x.t === "err" ? x : node; vals.push(x); }
      const [dr, dc, h, w] = vals;
      if (h === 0 || w === 0) return errNode("#REF!");
      const r0 = b.r0 + dr + (h < 0 ? h + 1 : 0), c0 = b.c0 + dc + (w < 0 ? w + 1 : 0);
      return mkRef(base.from.sheet, c0, r0, c0 + Math.abs(w) - 1, r0 + Math.abs(h) - 1);
    }
    case "INDIRECT": {
      const tv = evalRaw(a[0], ctx);
      if (isGrid(tv)) return node;
      if (isError(tv)) return errNode(tv.error);
      let a1 = true;
      if (!isMissing(a[1])) { const f = evaluate(a[1], ctx); if (isError(f)) return errNode(f.error); a1 = toBool(f); }
      return parseIndirect(String(tv), a1, ctx) ?? errNode("#REF!");
    }
    case "INDEX": {
      if (a.length < 2) return node;
      const baseN = resolveRefNode(a[0], ctx); const base = asRange(baseN);
      if (!base) return node; // value form (array argument) handled by the INDEX function
      const b = bounds(base); const rows = b.r1 - b.r0 + 1, cols = b.c1 - b.c0 + 1;
      const rx = intArg(a[1], 0, ctx); if (typeof rx !== "number") return rx.t === "err" ? rx : node;
      let r = rx, c: number;
      if (a.length < 3 || isMissing(a[2])) { if (rows === 1 && a.length < 3) { c = r; r = 1; } else c = cols === 1 ? 1 : 0; }
      else { const cx = intArg(a[2], 0, ctx); if (typeof cx !== "number") return cx.t === "err" ? cx : node; c = cx; }
      if (r < 0 || c < 0 || r > rows || c > cols) return errNode("#REF!");
      return mkRef(base.from.sheet, c === 0 ? b.c0 : b.c0 + c - 1, r === 0 ? b.r0 : b.r0 + r - 1, c === 0 ? b.c1 : b.c0 + c - 1, r === 0 ? b.r1 : b.r0 + r - 1);
    }
    case "__ISECT": {
      const x = asRange(resolveRefNode(a[0], ctx)), y = asRange(resolveRefNode(a[1], ctx));
      if (!x || !y) return errNode("#VALUE!");
      const p = bounds(x), q = bounds(y);
      const c0 = Math.max(p.c0, q.c0), c1 = Math.min(p.c1, q.c1), r0 = Math.max(p.r0, q.r0), r1 = Math.min(p.r1, q.r1);
      if (c0 > c1 || r0 > r1 || (x.from.sheet ?? null) !== (y.from.sheet ?? null)) return errNode("#NULL!");
      return mkRef(x.from.sheet, c0, r0, c1, r1);
    }
    case "__UNION": { // (A1,B2:B3) — evaluated as one row of all member values (aggregates/RANK/LARGE semantics)
      const vals: Node[] = [];
      for (const m of a) {
        const r = resolveRefNode(m, ctx);
        if (r.t === "err") return r;
        const v = r.t === "range" ? ctx.resolveRange(r.v).flat() : r.t === "ref" ? [ctx.resolveRef(r.v)] : (() => { const z = evalRaw(r, ctx); return isGrid(z) ? z.flat() : [z]; })();
        vals.push(...v.map(litNode));
      }
      return { t: "array", rows: [vals] };
    }
    case "__SREF": return structuredRef((a[0] as { v: string }).v, (a[1] as { v: string }).v, ctx) ?? errNode("#REF!");
    case "__REF3D": { const x = expand3d(node, ctx); return x && x.length === 1 ? x[0] : x ? node : errNode("#REF!"); }
    default: return node;
  }
}
/** INDIRECT text → reference. A1 style (with sheet, defined names) or R1C1 (absolute R5C2 / relative R[-1]C[2]). */
function parseIndirect(text: string, a1: boolean, ctx: EvalContext): Node | null {
  const t = text.trim();
  if (!t) return null;
  const home = ctx.cursor?.sheet ?? null;
  const own = (n: Node): Node | null => {
    if (n.t === "ref") { const sh = n.v.sheet ?? home; return sh && ctx.sheetExists && !ctx.sheetExists(sh) ? null : { t: "ref", v: { ...n.v, sheet: sh } }; }
    if (n.t === "range") { const sh = n.v.from.sheet ?? home; return sh && ctx.sheetExists && !ctx.sheetExists(sh) ? null : { t: "range", v: { ...n.v, from: { ...n.v.from, sheet: sh }, to: { ...n.v.to, sheet: sh } } }; }
    return null;
  };
  if (a1) {
    let n: Node;
    try { n = parseFormula(`=${t}`); } catch { return null; }
    if (n.t === "name") { const e = ctx.expandName?.(n.name); return e ? own(e) : null; }
    if (n.t === "call" && n.name === "__SREF") return resolveRefNode(n, ctx);
    return own(n);
  }
  const m = /^(?:('(?:[^']|'')+'|[^!]+)!)?(R(\[-?\d+\]|\d*)C(\[-?\d+\]|\d*))(?::(R(\[-?\d+\]|\d*)C(\[-?\d+\]|\d*)))?$/i.exec(t);
  if (!m || !ctx.cursor) return null;
  const sheet = m[1] ? (m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]) : home;
  const part = (s: string, cur: number) => (s === "" ? cur : s.startsWith("[") ? cur + Number(s.slice(1, -1)) : Number(s) - 1);
  const r0 = part(m[3], ctx.cursor.row), c0 = part(m[4], ctx.cursor.col);
  const r1 = m[5] ? part(m[6], ctx.cursor.row) : r0, c1 = m[5] ? part(m[7], ctx.cursor.col) : c0;
  if (sheet && ctx.sheetExists && !ctx.sheetExists(sheet)) return null;
  const n = mkRef(sheet, Math.min(c0, c1), Math.min(r0, r1), Math.max(c0, c1), Math.max(r0, r1));
  return n.t === "err" ? null : n;
}
/** Sheet1:Sheet3!A1 → one node per sheet, in workbook order. null → #REF! (unknown sheet). */
function expand3d(n: Node, ctx: EvalContext): Node[] | null {
  if (n.t !== "call" || n.name !== "__REF3D") return [n];
  const [s0, s1, target] = n.args as [{ v: string }, { v: string }, Node];
  const sheets = ctx.sheetsBetween?.(s0.v, s1.v);
  if (!sheets) return null;
  return sheets.map((sh): Node => target.t === "ref" ? { t: "ref", v: { ...target.v, sheet: sh } } : target.t === "range" ? { t: "range", v: { from: { ...target.v.from, sheet: sh }, to: { ...target.v.to, sheet: sh } } } : target);
}
/** Structured references: Table1[Col], Table1[[#Headers],[A]:[C]], Table1[#All], [@Col], Table1[@[Col Name]], Table1[]. */
function structuredRef(tableName: string, spec: string, ctx: EvalContext): Node | null {
  const t = ctx.table?.(tableName);
  if (!t) return null;
  let inner = spec.slice(1, -1).trim();
  let thisRow = false;
  if (inner.startsWith("@")) { thisRow = true; inner = inner.slice(1).trim(); }
  // split on top-level commas
  const parts: string[] = []; let depth = 0, cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "'") { cur += ch + (inner[i + 1] ?? ""); i++; continue; }
    if (ch === "[") depth++; else if (ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  // Column names are whitespace-exact inside their brackets ("Gender " ≠ "Gender").
  const unbr = (x: string) => { const t = x.trim(); return (t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t).replace(/'(.)/g, "$1"); };
  const specials = new Set<string>(); let cols: [number, number] | null = null;
  for (const p of parts) {
    const sp = /^\[?\s*#(All|Data|Headers|Totals|This Row)\s*\]?$/i.exec(p);
    if (sp) { specials.add(sp[1].toLowerCase()); continue; }
    const pt = p.trim(); const body = pt.startsWith("[") && pt.endsWith("]") ? pt.slice(1, -1) : pt;
    const names = body.split(/\]\s*:\s*\[/).map((x) => x.replace(/'(.)/g, "$1"));
    const idx = names.map((nm) => t.columns.findIndex((c) => c.toLowerCase() === nm.toLowerCase()));
    if (idx.some((i) => i < 0)) return null;
    cols = [Math.min(...idx), Math.max(...idx)];
  }
  if (thisRow) specials.add("this row");
  const header = t.headerRows ? t.r0 : -1, d0 = t.r0 + t.headerRows, d1 = t.r1 - t.totalsRows, totals = t.totalsRows ? t.r1 : -1;
  let r0 = Infinity, r1 = -Infinity;
  const take = (a: number, b: number) => { if (a < 0 || b < a) return; r0 = Math.min(r0, a); r1 = Math.max(r1, b); };
  if (!specials.size || specials.has("data")) take(d0, d1);
  if (specials.has("all")) take(t.r0, t.r1);
  if (specials.has("headers")) take(header, header);
  if (specials.has("totals")) take(totals, totals);
  if (specials.has("this row")) { const row = ctx.cursor?.row ?? -1; if (row < d0 || row > d1) return null; r0 = r1 = row; }
  if (!Number.isFinite(r0)) return null;
  const [c0, c1] = cols ? [t.c0 + cols[0], t.c0 + cols[1]] : [t.c0, t.c1];
  return mkRef(t.sheet, c0, r0, c1, r1);
}
/** Operator operands: blank cells become BLANK (0 / "" / FALSE by context, Excel semantics). */
/** Legacy implicit intersection: a range in a value position yields the cell in the formula's row/column, else #VALUE!. */
function intersectNode(n: Node, ctx: EvalContext): Node {
  if (n.t !== "range" || !ctx.cursor) return n;
  const b = bounds(n.v); const sh = n.v.from.sheet; const { row, col } = ctx.cursor;
  if (b.c0 === b.c1 && b.r0 === b.r1) return mkRef(sh, b.c0, b.r0, b.c0, b.r0);
  if (b.c0 === b.c1) return row >= b.r0 && row <= b.r1 ? mkRef(sh, b.c0, row, b.c0, row) : errNode("#VALUE!");
  if (b.r0 === b.r1) return col >= b.c0 && col <= b.c1 ? mkRef(sh, col, b.r0, col, b.r0) : errNode("#VALUE!");
  return errNode("#VALUE!");
}
function evalOperand(node: Node, ctx: EvalContext): Value {
  let n = node.t === "call" && REF_FORMS.has(node.name) ? resolveRefNode(node, ctx) : node;
  if (ctx.legacy && n.t === "range") n = intersectNode(n, ctx);
  if (!ctx.isBlank) return evalRaw(n, ctx);
  const home = ctx.cursor?.sheet;
  if (n.t === "ref") return ctx.isBlank(n.v.sheet, n.v.col, n.v.row, home) ? BLANK : ctx.resolveRef(n.v);
  if (n.t === "range") {
    const m = ctx.resolveRange(n.v); const { c0, r0 } = bounds(n.v);
    return m.map((row, i) => row.map((x, j) => (x === "" && ctx.isBlank!(n.v.from.sheet, c0 + j, r0 + i, home) ? BLANK : x)));
  }
  return evalRaw(n, ctx);
}
/** SUBTOTAL(fn, refs…) / AGGREGATE(fn, options, refs… | array, k): nested SUBTOTAL/AGGREGATE cells are skipped. */
const SUB_FN = ["", "AVERAGE", "COUNT", "COUNTA", "MAX", "MIN", "PRODUCT", "STDEV", "STDEVP", "SUM", "VAR", "VARP", "MEDIAN", "MODE.SNGL", "LARGE", "SMALL", "PERCENTILE.INC", "QUARTILE.INC", "PERCENTILE.EXC", "QUARTILE.EXC"];
function evalSubtotal(name: string, argNodes: Node[], ctx: EvalContext): Value {
  const f = evaluate(argNodes[0] ?? errNode("#VALUE!"), ctx);
  if (isError(f)) return f;
  let k: number, opts = 0;
  try { k = Math.trunc(toNumberStrict(f)); } catch { return err("#VALUE!"); }
  let refs: Node[];
  const kOrig = k;
  if (name === "SUBTOTAL") { if (k > 100) k -= 100; if (k < 1 || k > 11) return err("#VALUE!"); refs = argNodes.slice(1); }
  else {
    const o = argNodes[1] && !isMissing(argNodes[1]) ? evaluate(argNodes[1], ctx) : 0;
    if (isError(o)) return o;
    try { opts = Math.trunc(toNumberStrict(o)); } catch { return err("#VALUE!"); }
    if (k < 1 || k > 19 || opts < 0 || opts > 7) return err("#VALUE!");
    refs = argNodes.slice(2);
  }
  if (!refs.length) return err("#VALUE!");
  const ignoreNested = name === "SUBTOTAL" || opts <= 3, ignoreErr = [2, 3, 6, 7].includes(opts);
  // TT74: SUBTOTAL 1–11 skip rows hidden by a filter, 101–111 skip every hidden row; AGGREGATE options 1/3/5/7 skip
  // every hidden row. Rows only — SUBTOTAL is defined for vertical ranges (hidden columns never count as skipped).
  const skipRow = (sheet: string | null, row: number) => {
    const why = ctx.rowHidden?.(sheet, row); if (!why) return false;
    return name === "SUBTOTAL" ? (kOrig > 100 || why === "filter") : [1, 3, 5, 7].includes(opts);
  };
  const nested = /\b(?:_xlfn\.)?(SUBTOTAL|AGGREGATE)\s*\(/i;
  const data = k >= 14 ? refs.slice(0, 1) : refs;
  const lit: Node[] = [];
  for (const n of data) {
    let m: Scalar[][];
    if (n.t === "range" || n.t === "ref") {
      const rg = asRange(n)!; const b = bounds(rg); const sheet = rg.from.sheet ?? ctx.cursor?.sheet ?? null;
      m = n.t === "range" ? ctx.resolveRange(n.v) : [[ctx.resolveRef(n.v)]];
      const excl = (i: number, j: number) => skipRow(sheet, b.r0 + i) || (ignoreNested && nested.test(ctx.cellInput?.(sheet, b.c0 + j, b.r0 + i) ?? "")) || (ignoreErr && isError(m[i][j]));
      if (k < 14) {
        // TT74: pass REFERENCES (the included cells as vertical runs), so blanks, text and logicals keep their
        // range semantics (COUNTA skips blanks, SUM skips text) — a literal array cannot represent a blank cell.
        const runs: Node[] = []; let skipped = false;
        for (let j = 0; j < (m[0]?.length ?? 0); j++) {
          for (let i = 0; i < m.length;) {
            if (excl(i, j)) { skipped = true; i++; continue; }
            const st = i; while (i < m.length && !excl(i, j)) i++;
            runs.push(mkRef(sheet, b.c0 + j, b.r0 + st, b.c0 + j, b.r0 + i - 1));
          }
        }
        if (!skipped) lit.push(n); else lit.push(...runs);
        continue;
      }
      m = m.filter((_, i) => !skipRow(sheet, b.r0 + i)).map((row, i0) => row.map((v, j) => (ignoreNested && nested.test(ctx.cellInput?.(sheet, b.c0 + j, b.r0 + i0) ?? "") ? "" : v)));
      if (!m.length) m = [[""]];
    } else { const v = evalRaw(n, ctx); m = isGrid(v) ? v : [[v]]; }
    if (ignoreErr) m = m.map((row) => row.map((v) => (isError(v) ? "" : v)));
    lit.push({ t: "array", rows: m.map((row) => row.map(litNode)) });
  }
  // every referenced cell excluded: Excel's result over an empty set
  if (!lit.length) return [0, err("#DIV/0!"), 0, 0, 0, 0, 0, err("#DIV/0!"), err("#DIV/0!"), 0, err("#DIV/0!"), err("#DIV/0!"), err("#NUM!"), err("#N/A")][k] ?? err("#VALUE!");
  if (k >= 14) lit.push(refs[1] ?? errNode("#VALUE!"));
  return evalCall(SUB_FN[k], lit, ctx);
}
/** Excel lifts the *IF(S) criteria over an array: COUNTIFS(A1:F1,{"a","b"}) → {count a, count b}. */
const CRITERIA_POS: Record<string, (i: number) => boolean> = {
  COUNTIF: (i) => i === 1, SUMIF: (i) => i === 1, AVERAGEIF: (i) => i === 1,
  COUNTIFS: (i) => i % 2 === 1, SUMIFS: (i) => i >= 2 && i % 2 === 0, AVERAGEIFS: (i) => i >= 2 && i % 2 === 0, MAXIFS: (i) => i >= 2 && i % 2 === 0, MINIFS: (i) => i >= 2 && i % 2 === 0,
};
const litNode = (v: Scalar): Node => (isError(v) ? { t: "err", v: v.error } : typeof v === "number" ? { t: "num", v } : typeof v === "boolean" ? { t: "bool", v } : { t: "str", v: String(v) });
function liftCriteria(name: string, argNodes: Node[], ctx: EvalContext): Value | undefined {
  const pos = CRITERIA_POS[name];
  if (!pos) return undefined;
  const grids = new Map<number, Scalar[][]>();
  argNodes.forEach((n, i) => {
    if (!pos(i) || n.t === "str" || n.t === "num" || n.t === "bool") return;
    const v = n.t === "range" ? ctx.resolveRange(n.v) : n.t === "ref" ? null : evalRaw(n, ctx);
    if (v && isGrid(v) && v.length * (v[0]?.length ?? 0) > 1) grids.set(i, v);
  });
  if (!grids.size) return undefined;
  const R = Math.max(...[...grids.values()].map((g) => g.length)), C = Math.max(...[...grids.values()].map((g) => g[0]?.length ?? 0));
  const out: Scalar[][] = [];
  for (let r = 0; r < R; r++) {
    const row: Scalar[] = [];
    for (let c = 0; c < C; c++) {
      const args = argNodes.map((n, i) => { const g = grids.get(i); if (!g) return n; const v = g[g.length === 1 ? 0 : r]?.[(g[0]?.length ?? 0) === 1 ? 0 : c]; return v === undefined ? errNode("#N/A") : litNode(v); });
      const v = evalCall(name, args, ctx);
      row.push(isGrid(v) ? (v[0]?.[0] ?? "") : v);
    }
    out.push(row);
  }
  return out;
}

export { toBool };
