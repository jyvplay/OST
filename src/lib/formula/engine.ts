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
 */
import { parseFormula } from "./parser";
import { colToLetters, isError, type CellAddr, type Node, type RangeAddr, type Scalar } from "./types";
import { FUNCTIONS, toBool, toNumberStrict, toStr, type Arg } from "./functions";
import { err } from "./types";

export interface Cell { input: string; formula: Node | null; value: Scalar; error?: string }
export type SheetGrid = Map<string, Cell>;

const key = (col: number, row: number) => `${col},${row}`;
export const a1 = (col: number, row: number) => `${colToLetters(col)}${row + 1}`;

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
  constructor(name = "Sheet1") { this.name = name; }

  setCell(col: number, row: number, input: string) {
    const k = key(col, row);
    if (input === "") { this.grid.delete(k); return; }
    if (input.startsWith("=")) {
      try {
        this.grid.set(k, { input, formula: parseFormula(input), value: "" });
      } catch (e) {
        this.grid.set(k, { input, formula: null, value: err("#NAME?"), error: (e as Error).message });
      }
    } else {
      this.grid.set(k, { input, formula: null, value: parseLiteral(input) });
    }
  }
  get(col: number, row: number): Cell | undefined { return this.grid.get(key(col, row)); }
  cellAddr(col: number, row: number): CellAddr { return { sheet: this.name, col, row, colAbs: false, rowAbs: false }; }
}

export class Workbook {
  sheets = new Map<string, Sheet>();
  constructor() { this.addSheet("Sheet1"); }
  addSheet(name: string) { const s = new Sheet(name); this.sheets.set(name, s); return s; }
  sheet(name?: string | null) { const s = this.sheets.get(name ?? [...this.sheets.keys()][0]); if (!s) throw new Error(`no such sheet: ${name}`); return s; }

  /** Full dependency-ordered recalculation with cycle detection (DFS, 3-colour). */
  recalculate(): void {
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    const fqKey = (sheet: string, col: number, row: number) => `${sheet}!${col},${row}`;

    const evalCell = (sheetName: string, col: number, row: number): Scalar => {
      const fk = fqKey(sheetName, col, row);
      const c0 = color.get(fk) ?? WHITE;
      if (c0 === GRAY) return err("#CIRCULAR!");
      const sheet = this.sheets.get(sheetName);
      const cell = sheet?.get(col, row);
      if (!cell) return "";
      if (!cell.formula) return cell.value;
      if (c0 === BLACK) return cell.value;
      color.set(fk, GRAY);
      const ctx: EvalContext = {
        resolveRef: (addr) => evalCell(addr.sheet ?? sheetName, addr.col, addr.row),
        resolveRange: (range) => resolveRangeMatrix(range, sheetName, evalCell),
      };
      let value: Scalar;
      try { value = evaluate(cell.formula, ctx); }
      catch (e) { value = (e as { code?: Scalar }).code ?? err("#VALUE!"); }
      cell.value = value;
      color.set(fk, BLACK);
      return value;
    };

    for (const [sheetName, sheet] of this.sheets) {
      for (const k of sheet.grid.keys()) {
        const [c, r] = k.split(",").map(Number);
        if (sheet.grid.get(k)?.formula) evalCell(sheetName, c, r);
      }
    }
  }
}

function resolveRangeMatrix(range: RangeAddr, defaultSheet: string, evalCell: (s: string, c: number, r: number) => Scalar): Scalar[][] {
  const sheetName = range.from.sheet ?? defaultSheet;
  const c0 = Math.min(range.from.col, range.to.col), c1 = Math.max(range.from.col, range.to.col);
  const r0 = Math.min(range.from.row, range.to.row), r1 = Math.max(range.from.row, range.to.row);
  const rows: Scalar[][] = [];
  for (let r = r0; r <= r1; r++) {
    const row: Scalar[] = [];
    for (let c = c0; c <= c1; c++) row.push(evalCell(sheetName, c, r));
    rows.push(row);
  }
  return rows;
}

export interface EvalContext { resolveRef(addr: CellAddr): Scalar; resolveRange(range: RangeAddr): Scalar[][] }

/** Operator semantics. [oracle]-tagged facts are cited in a comment at each branch. */
export function evaluate(node: Node, ctx: EvalContext): Scalar {
  switch (node.t) {
    case "num": return node.v;
    case "str": return node.v;
    case "bool": return node.v;
    case "err": return err(node.v);
    case "ref": return ctx.resolveRef(node.v);
    case "range": { const m = ctx.resolveRange(node.v); return m[0]?.[0] ?? ""; } // implicit intersection in scalar context
    case "array": return node.rows[0][0] ? evaluate(node.rows[0][0], ctx) : "";
    case "unary": { const v = toNumberStrict(evaluate(node.arg, ctx)); return node.op === "-" ? -v : v; }
    case "percent": return toNumberStrict(evaluate(node.arg, ctx)) / 100;
    case "binary": return evalBinary(node.op, evaluate(node.left, ctx), evaluate(node.right, ctx));
    case "call": return evalCall(node.name, node.args, ctx);
  }
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
 */
function evalLazy(name: string, argNodes: Node[], ctx: EvalContext): Scalar | undefined {
  switch (name) {
    case "IF": {
      const cond = toBool(evaluate(argNodes[0], ctx));
      const branch = cond ? argNodes[1] : argNodes[2];
      if (!branch) return cond; // IF(cond) with a missing branch -> the condition itself
      return evaluate(branch, ctx);
    }
    case "IFS": {
      for (let i = 0; i + 1 < argNodes.length; i += 2) if (toBool(evaluate(argNodes[i], ctx))) return evaluate(argNodes[i + 1], ctx);
      return err("#N/A");
    }
    case "CHOOSE": {
      const i = Math.trunc(Number(evaluate(argNodes[0], ctx)));
      const branch = argNodes[i];
      return branch ? evaluate(branch, ctx) : err("#VALUE!");
    }
    case "IFERROR": {
      const v = evaluate(argNodes[0], ctx);
      return isError(v) ? evaluate(argNodes[1], ctx) : v;
    }
    case "IFNA": {
      const v = evaluate(argNodes[0], ctx);
      return isError(v) && v.error === "#N/A" ? evaluate(argNodes[1], ctx) : v;
    }
    default: return undefined;
  }
}

function evalCall(name: string, argNodes: Node[], ctx: EvalContext): Scalar {
  if (name === "ROW" || name === "COLUMN") {
    if (argNodes[0]?.t === "ref") return name === "ROW" ? argNodes[0].v.row + 1 : argNodes[0].v.col + 1;
    return err("#VALUE!");
  }
  const lazy = evalLazy(name, argNodes, ctx);
  if (lazy !== undefined) return lazy;
  const fn = FUNCTIONS[name];
  if (!fn) return err("#NAME?");
  const args: Arg[] = argNodes.map((n) => toArg(n, ctx));
  try { return fn(args); }
  catch (e) { return (e as { code?: Scalar }).code ?? err("#VALUE!"); }
}
function toArg(node: Node, ctx: EvalContext): Arg {
  if (node.t === "range") return { kind: "matrix", value: ctx.resolveRange(node.v) };
  if (node.t === "array") return { kind: "matrix", value: node.rows.map((row) => row.map((n) => evaluate(n, ctx))) };
  return { kind: "scalar", value: evaluate(node, ctx) };
}

export { toBool };
