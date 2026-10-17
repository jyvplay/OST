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
import { parseFormula } from "./parser";
import { validateName, type DefinedName } from "./names";
import { colToLetters, isError, type CellAddr, type ErrorCode, type Node, type RangeAddr, type Scalar } from "./types";
import { FUNCTIONS, toBool, toNumberStrict, toStr, type Arg } from "./functions";
import { err } from "./types";
import { EXT_FUNCTIONS, isGridValue, type ArgAccessor, type ExtValue, type ResultValue } from "./ext";

export interface Cell { input: string; formula: Node | null; value: Scalar; error?: string; spill?: { rows: number; cols: number } | null; spillGrid?: Scalar[][] | null; style?: CellStyle }
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
export const a1 = (col: number, row: number) => `${colToLetters(col)}${row + 1}`;
const isGrid = (v: Value): v is Scalar[][] => Array.isArray(v);

/** Parse a raw input string into either a literal Scalar or a formula AST. */
function parseLiteral(input: string): Scalar {
  if (input === "") return "";
  const n = Number(input);
  if (input.trim() !== "" && !Number.isNaN(n)) return n;
  if (/^(TRUE|FALSE)$/i.test(input.trim())) return input.trim().toUpperCase() === "TRUE";
  return input;
}

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
    if (this.names.size === 0) return node;
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

  /** Full dependency-ordered recalculation with cycle detection and bounded spill fixed point. */
  recalculate(): void {
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

    const evalCell = (sheetName: string, col: number, row: number): Scalar => {
      const fk = fqKey(sheetName, col, row);
      const sheet = this.sheets.get(sheetName);
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
        resolveRange: (range) => resolveRangeMatrix(range, sheetName, evalCell),
        cursor: { sheet: sheetName, col, row },
      };
      let value: Value;
      try { value = evalRaw(this.names.size ? this.expandNames(cell.formula, sheetName) : cell.formula, ctx); }
      catch (e) { value = (e as { code?: Scalar }).code ?? err("#VALUE!"); }
      if (isGrid(value) && value.length === 1 && value[0].length === 1) value = value[0][0];
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

function resolveRangeMatrix(range: RangeAddr, defaultSheet: string, evalCell: (s: string, c: number, r: number) => Scalar): Scalar[][] {
  const sheetName = range.from.sheet ?? defaultSheet;
  const c0 = Math.min(range.from.col, range.to.col), c1 = Math.max(range.from.col, range.to.col);
  const r0 = Math.min(range.from.row, range.to.row), r1 = Math.max(range.from.row, range.to.row);
  if ((c1 - c0 + 1) * (r1 - r0 + 1) > 1_000_000) throw Object.assign(new Error("#NUM!"), { code: err("#NUM!") });
  const rows: Scalar[][] = [];
  for (let r = r0; r <= r1; r++) {
    const row: Scalar[] = [];
    for (let c = c0; c <= c1; c++) row.push(evalCell(sheetName, c, r));
    rows.push(row);
  }
  return rows;
}

export interface EvalContext {
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
    case "unary": return map1(evalRaw(node.arg, ctx), (x) => { const v = toNumberStrict(x); return node.op === "-" ? -v : v; });
    case "percent": return map1(evalRaw(node.arg, ctx), (x) => toNumberStrict(x) / 100);
    case "binary": return map2(evalRaw(node.left, ctx), evalRaw(node.right, ctx), (l, r) => evalBinary(node.op, l, r));
    case "call": return evalCall(node.name, node.args, ctx);
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
/** [spec] cross-type ordering: number < text < boolean, matching the documented
 * Excel/Calc sort convention; same-type compares directly (numbers numerically,
 * text case-sensitively per the measured oracle default, booleans false<true). */
function typeCompare(l: Scalar, r: Scalar): number {
  const rank = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
  const [rl, rr] = [rank(l), rank(r)];
  if (rl !== rr) return rl - rr;
  if (typeof l === "number" && typeof r === "number") return l - r;
  if (typeof l === "boolean" && typeof r === "boolean") return (l ? 1 : 0) - (r ? 1 : 0);
  return (l as string) < (r as string) ? -1 : (l as string) > (r as string) ? 1 : 0;
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
  if (fn) {
    const args: Arg[] = argNodes.map((n) => toArg(n, ctx));
    try { return fn(args); }
    catch (e) { return (e as { code?: Scalar }).code ?? err("#VALUE!"); }
  }
  const ext = (EXT_FUNCTIONS as Record<string, (a: ArgAccessor[], env: { now: () => Date; random: () => number; cursor: { row: number; col: number } }) => ResultValue>)[name];
  if (!ext) return err("#NAME?");
  return callExt(ext, argNodes, ctx);
}
function toArg(node: Node, ctx: EvalContext): Arg {
  if (node.t === "range") return { kind: "matrix", value: ctx.resolveRange(node.v) };
  if (node.t === "array") return { kind: "matrix", value: node.rows.map((row) => row.map((n) => evaluate(n, ctx))) };
  const v = evalRaw(node, ctx);
  return isGrid(v) ? { kind: "matrix", value: v } : { kind: "scalar", value: v };
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
function callExt(fn: (a: ArgAccessor[], env: { now: () => Date; random: () => number; cursor: { row: number; col: number } }) => ResultValue, argNodes: Node[], ctx: EvalContext): Value {
  const accessors: ArgAccessor[] = argNodes.map((n) => {
    let cached: Value | undefined;
    const get = () => (cached === undefined ? (cached = evalRaw(n, ctx)) : cached);
    const isRange = n.t === "range" || n.t === "ref";
    const grid = (): ExtValue[][] => { const v = get(); return isGrid(v) ? v.map((r) => r.map((x) => toExt(x, true))) : [[toExt(v, isRange)]]; };
    return {
      isRange: isRange || n.t === "array" || (n.t === "call" && isGrid(get())),
      grid,
      list: () => grid().flat(),
      value: () => { const v = get(); return toExt(isGrid(v) ? (v[0]?.[0] ?? "") : v, isRange); },
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

export { toBool };
