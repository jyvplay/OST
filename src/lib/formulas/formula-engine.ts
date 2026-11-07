/**
 * TT139 (FF-19) — Formula engine: lexer, parser, evaluator, dependency graph.
 *
 * Pure. No DOM, no Date.now() (the caller injects a clock via `now`), no I/O.
 *
 * Semantics follow spreadsheet convention on purpose, because "replicate the
 * exact functionality" means matching the behaviour people already know:
 *
 *   • Unary minus binds TIGHTER than `^`. `-2^2` is `4`, not `-4`.
 *     (Verified against Excel/LibreOffice: both give 4. A conventional
 *     grammar that parses `^` first gives -4 and silently breaks
 *     budgets that were written in a spreadsheet.)
 *   • Comparison operators are the lowest precedence, below `&`.
 *   • `&` concatenates and stringifies both sides.
 *   • Errors are first-class values that propagate: any arithmetic touching
 *     an error returns that error.
 *   • `TRUE`/`FALSE` without parens are literals; with parens they are
 *     zero-argument functions and are accepted both ways.
 *
 * Error values are the seven Excel error literals; nothing else is invented.
 */

export type CellValue = number | string | boolean | null;

export interface CellRef {
  row: number;
  col: number;
}

export interface EvalResult {
  value: CellValue;
  error?: string;
  /** Every cell referenced, ranges expanded. */
  dependencies: CellRef[];
  /** Every function invoked, uppercase, in source order. */
  functions: string[];
}

export const ERR = {
  div0: "#DIV/0!",
  na: "#N/A",
  name: "#NAME?",
  null: "#NULL!",
  num: "#NUM!",
  ref: "#REF!",
  value: "#VALUE!",
} as const;

const ERROR_SET = new Set<string>(Object.values(ERR));

export function isErrorValue(v: unknown): boolean {
  return typeof v === "string" && ERROR_SET.has(v);
}

// ── References ───────────────────────────────────────────────────────────

/** 1 → "A", 26 → "Z", 27 → "AA". */
export function colLetter(col: number): string {
  if (!Number.isInteger(col) || col < 1) throw new Error(`Bad column index: ${col}`);
  let s = "";
  let n = col;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** "A" → 1, "AA" → 27. */
export function parseColLetter(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) throw new Error(`Bad column label: ${letters}`);
  let col = 0;
  const up = letters.toUpperCase();
  for (let i = 0; i < up.length; i++) col = col * 26 + (up.charCodeAt(i) - 64);
  return col;
}

export function makeRef(row: number, col: number): string {
  return `${colLetter(col)}${row}`;
}

/** "B3" → {row:3,col:2}; "$B$3" → same. Returns null for non-references. */
export function parseRef(ref: string): CellRef | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) return null;
  const col = parseColLetter(m[1]);
  const row = parseInt(m[2], 10);
  if (row < 1 || col < 1) return null;
  return { row, col };
}

// ── Lexer ────────────────────────────────────────────────────────────────

export type TokenType =
  | "num" | "str" | "bool" | "ref" | "range" | "func"
  | "op" | "lparen" | "rparen" | "comma" | "err";

export interface Token {
  type: TokenType;
  value?: string | number | boolean;
  row?: number;
  col?: number;
  start?: CellRef;
  end?: CellRef;
  pos: number;
}

const OPERATOR_CHARS = "+-*/^&=<>%";

export function tokenize(formula: string): Token[] {
  const src = formula.replace(/^\s*=/, "");
  const out: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }

    // Literal error values pass through as strings so they propagate.
    if (ch === "#") {
      let j = i;
      while (j < src.length && /[#A-Za-z0-9!/?]/.test(src[j])) j++;
      const lit = src.slice(i, j).toUpperCase();
      if (!ERROR_SET.has(lit)) throw new Error(`Unknown error literal at ${i}: ${src.slice(i, j)}`);
      out.push({ type: "err", value: lit, pos: i });
      i = j;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const start = i;
      let seenDot = false;
      while (i < src.length && (/[0-9]/.test(src[i]) || (src[i] === "." && !seenDot))) {
        if (src[i] === ".") seenDot = true;
        i++;
      }
      // Scientific notation: 1e5, 2.5E-3
      if (i < src.length && /[eE]/.test(src[i]) && /[-+0-9]/.test(src[i + 1] ?? "")) {
        i++;
        if (/[-+]/.test(src[i])) i++;
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      const num = Number(src.slice(start, i));
      if (!Number.isFinite(num)) throw new Error(`Bad number: ${src.slice(start, i)}`);
      out.push({ type: "num", value: num, pos: start });
      continue;
    }

    if (ch === '"') {
      i++;
      let s = "";
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') { s += '"'; i += 2; continue; } // "" escapes a quote
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ type: "str", value: s, pos: i });
      continue;
    }

    if (ch === "(") { out.push({ type: "lparen", pos: i++ }); continue; }
    if (ch === ")") { out.push({ type: "rparen", pos: i++ }); continue; }
    if (ch === ",") { out.push({ type: "comma", pos: i++ }); continue; }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < src.length && /[A-Za-z0-9_$.]/.test(src[i])) i++;
      const word = src.slice(start, i);

      // A word that is followed by "(" is a CALL, even when it is shaped like
      // a cell reference. LOG10(100) must not lex as ref "LOG10" = (row 10,
      // col 8509). This was a real bug: it silently turned every function
      // whose name ends in digits into a reference to an absurd cell.
      if (src[i] === "(" && !/^\$/.test(word)) {
        out.push({ type: "func", value: word.toUpperCase(), pos: start });
        i++;
        continue;
      }

      // Range: A1:B3 — only valid when both sides are references.
      if (src[i] === ":") {
        const a = parseRef(word);
        if (a) {
          const save = i;
          i++;
          const rstart = i;
          while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
          const b = parseRef(src.slice(rstart, i));
          if (b) {
            out.push({ type: "range", start: a, end: b, pos: start });
            continue;
          }
          i = save;
        }
      }

      const ref = parseRef(word);
      if (ref) { out.push({ type: "ref", row: ref.row, col: ref.col, pos: start }); continue; }

      // Spreadsheet names are not supported by this engine; a bare word is
      // either TRUE/FALSE or a function call.
      const up = word.toUpperCase();
      if (up === "TRUE") { out.push({ type: "bool", value: true, pos: start }); continue; }
      if (up === "FALSE") { out.push({ type: "bool", value: false, pos: start }); continue; }
      throw new Error(`Unknown name at ${start}: ${word}`);
    }

    if (OPERATOR_CHARS.includes(ch)) {
      const two = src.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "<>") {
        out.push({ type: "op", value: two, pos: i });
        i += 2;
        continue;
      }
      if (ch === "%") { out.push({ type: "op", value: "%", pos: i++ }); continue; }
      out.push({ type: "op", value: ch, pos: i++ });
      continue;
    }

    throw new Error(`Unexpected character '${ch}' at ${i}`);
  }
  return out;
}

// ── AST ──────────────────────────────────────────────────────────────────

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "err"; value: string }
  | { kind: "ref"; ref: CellRef }
  | { kind: "range"; start: CellRef; end: CellRef }
  | { kind: "unary"; op: string; operand: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "func"; name: string; args: Expr[] };

// ── Parser (recursive descent; precedence mirrors spreadsheet convention) ──

export function parseFormula(formula: string): Expr {
  const tokens = tokenize(formula);
  if (tokens.length === 0) throw new Error("Empty formula");
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const eat = (): Token => tokens[pos++];

  function parseComparison(): Expr {
    let left = parseConcat();
    for (;;) {
      const t = peek();
      if (t?.type === "op" && ["=", "<>", "<", ">", "<=", ">="].includes(String(t.value))) {
        eat();
        left = { kind: "binary", op: String(t.value), left, right: parseConcat() };
      } else return left;
    }
  }

  function parseConcat(): Expr {
    let left = parseAdditive();
    while (peek()?.type === "op" && peek()?.value === "&") {
      eat();
      left = { kind: "binary", op: "&", left, right: parseAdditive() };
    }
    return left;
  }

  function parseAdditive(): Expr {
    let left = parseMultiplicative();
    for (;;) {
      const t = peek();
      if (t?.type === "op" && (t.value === "+" || t.value === "-")) {
        eat();
        left = { kind: "binary", op: String(t.value), left, right: parseMultiplicative() };
      } else return left;
    }
  }

  function parseMultiplicative(): Expr {
    let left = parsePower();
    for (;;) {
      const t = peek();
      if (t?.type === "op" && (t.value === "*" || t.value === "/")) {
        eat();
        left = { kind: "binary", op: String(t.value), left, right: parsePower() };
      } else return left;
    }
  }

  // Excel operator precedence: a leading sign binds to its operand BEFORE ^,
  // so =-2^2 is (-2)^2 = 4 while =0-2^2 stays 0-(2^2) = -4. This is not the
  // mathematical convention (Google Sheets gives -4); it is the spreadsheet
  // one, and this engine targets spreadsheet files.
  function parseSigned(): Expr {
    const t = peek();
    if (t?.type === "op" && (t.value === "-" || t.value === "+")) {
      eat();
      const operand = parseSigned();
      return t.value === "-" ? { kind: "unary", op: "-", operand } : operand;
    }
    return parsePostfix();
  }

  function parsePower(): Expr {
    const base = parseSigned();
    const t = peek();
    if (t?.type === "op" && t.value === "^") {
      eat();
      // Right-associative (2^3^2 = 2^(3^2)), and the exponent may be signed.
      return { kind: "binary", op: "^", left: base, right: parsePower() };
    }
    return base;
  }

  function parsePostfix(): Expr {
    let e = parsePrimary();
    while (peek()?.type === "op" && peek()?.value === "%") {
      eat();
      e = { kind: "binary", op: "/", left: e, right: { kind: "num", value: 100 } };
    }
    return e;
  }

  function parsePrimary(): Expr {
    const t = eat();
    if (!t) throw new Error("Unexpected end of formula");

    switch (t.type) {
      case "num": return { kind: "num", value: Number(t.value) };
      case "str": return { kind: "str", value: String(t.value) };
      case "bool": return { kind: "bool", value: Boolean(t.value) };
      case "err": return { kind: "err", value: String(t.value) };
      case "ref": return { kind: "ref", ref: { row: t.row!, col: t.col! } };
      case "range": return { kind: "range", start: t.start!, end: t.end! };
      case "lparen": {
        const inner = parseComparison();
        const close = eat();
        if (!close || close.type !== "rparen") throw new Error("Missing closing parenthesis");
        return inner;
      }
      case "func": {
        const args: Expr[] = [];
        // A function may be called with zero arguments: NOW()
        if (peek()?.type === "rparen") { eat(); return { kind: "func", name: String(t.value), args }; }
        for (;;) {
          args.push(parseComparison());
          const n = peek();
          if (n?.type === "comma") { eat(); continue; }
          if (n?.type === "rparen") { eat(); break; }
          throw new Error(`Expected ',' or ')' in ${t.value}(…)`);
        }
        return { kind: "func", name: String(t.value), args };
      }
      default:
        throw new Error(`Unexpected token '${t.type}'`);
    }
  }

  const ast = parseComparison();
  if (pos !== tokens.length) throw new Error(`Trailing input at token ${pos}`);
  return ast;
}

// ── Dependency extraction ────────────────────────────────────────────────

export function extractRefs(expr: Expr): CellRef[] {
  const out: CellRef[] = [];
  const seen = new Set<string>();
  const push = (r: CellRef) => {
    const k = `${r.row}:${r.col}`;
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  };
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case "ref": push(e.ref); break;
      case "range": {
        const r0 = Math.min(e.start.row, e.end.row);
        const r1 = Math.max(e.start.row, e.end.row);
        const c0 = Math.min(e.start.col, e.end.col);
        const c1 = Math.max(e.start.col, e.end.col);
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) push({ row: r, col: c });
        break;
      }
      case "unary": walk(e.operand); break;
      case "binary": walk(e.left); walk(e.right); break;
      case "func": e.args.forEach(walk); break;
      default: break;
    }
  };
  walk(expr);
  return out;
}

export function extractFunctions(expr: Expr): string[] {
  const out: string[] = [];
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case "func": out.push(e.name); e.args.forEach(walk); break;
      case "unary": walk(e.operand); break;
      case "binary": walk(e.left); walk(e.right); break;
      default: break;
    }
  };
  walk(expr);
  return out;
}

// ── Coercion ─────────────────────────────────────────────────────────────

function toNumber(v: CellValue): number | string {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const str = String(v);
  if (isErrorValue(str)) return str;
  const t = str.trim();
  if (t === "") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : ERR.value;
}

function toText(v: CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return formatNumber(v);
  return String(v);
}

function toBool(v: CellValue): boolean | string {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const str = String(v);
  if (isErrorValue(str)) return str;
  const t = str.trim().toUpperCase();
  if (t === "TRUE") return true;
  if (t === "FALSE") return false;
  return ERR.value;
}

/** Deterministic number→text: no exponent for ordinary magnitudes, ≤15 sig digits. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return n > 0 ? "∞" : n < 0 ? "-∞" : "NaN";
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-9 || abs >= 1e15)) return n.toExponential(9).replace(/\.?0+e/, "e");
  return String(Number(n.toPrecision(15)));
}

// ── Evaluator ────────────────────────────────────────────────────────────

type Scalar = CellValue;
type Arg = Scalar | Scalar[];

export interface EvalOptions {
  /** Injected clock so the engine stays pure. Defaults to 0. */
  now?: number;
  /** Deterministic RNG for RAND(); returns [0,1). Injected, never Math.random. */
  random?: () => number;
}

export function evaluateFormula(
  formula: string,
  getCell: (row: number, col: number) => CellValue,
  options: EvalOptions = {},
): EvalResult {
  const now = options.now ?? 0;
  const random = options.random ?? (() => 0);
  let ast: Expr;
  try {
    ast = parseFormula(formula);
  } catch (e) {
    return { value: ERR.name, error: (e as Error).message, dependencies: [], functions: [] };
  }
  const dependencies = extractRefs(ast);
  const functions = extractFunctions(ast);

  let value: Arg;
  try {
    value = evalExpr(ast, getCell, now, random);
  } catch (e) {
    // A thrown error during evaluation is a bad argument (#VALUE!), not an
    // unknown function. Conflating the two made "is every advertised function
    // dispatched?" untestable and hid real crashes behind #NAME?.
    return { value: ERR.value, error: (e as Error).message, dependencies, functions };
  }
  const scalar = Array.isArray(value) ? (value.length ? value[0] : null) : value;
  const out: EvalResult = { value: scalar, dependencies, functions };
  if (isErrorValue(scalar)) out.error = String(scalar);
  return out;
}

function evalExpr(e: Expr, getCell: (r: number, c: number) => CellValue, now: number, random: () => number): Arg {
  switch (e.kind) {
    case "num": return e.value;
    case "str": return e.value;
    case "bool": return e.value;
    case "err": return e.value;
    case "ref": {
      const v = getCell(e.ref.row, e.ref.col);
      return v === undefined ? null : v;
    }
    case "range": {
      const r0 = Math.min(e.start.row, e.end.row);
      const r1 = Math.max(e.start.row, e.end.row);
      const c0 = Math.min(e.start.col, e.end.col);
      const c1 = Math.max(e.start.col, e.end.col);
      const out: Scalar[] = [];
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const v = getCell(r, c);
        out.push(v === undefined ? null : v);
      }
      return out;
    }
    case "unary": {
      const v = flatten1(evalExpr(e.operand, getCell, now, random));
      const n = toNumber(v);
      if (typeof n === "string") return n;
      return -n;
    }
    case "binary": return evalBinary(e, getCell, now, random);
    case "func": return evalFunction(e, getCell, now, random);
  }
}

function flatten1(a: Arg): Scalar {
  if (Array.isArray(a)) return a.length ? a[0] : null;
  return a;
}

function flattenAll(a: Arg): Scalar[] {
  return Array.isArray(a) ? a : [a];
}

/** Numeric cells only; blanks and text are skipped (spreadsheet aggregate rule). */
function numericCells(args: Arg[]): number[] | string {
  const out: number[] = [];
  for (const a of args) {
    for (const v of flattenAll(a)) {
      if (isErrorValue(v)) return String(v);
      if (typeof v === "number") out.push(v);
      else if (typeof v === "boolean") out.push(v ? 1 : 0);
      // strings and nulls are ignored by SUM/AVERAGE/MIN/MAX
    }
  }
  return out;
}

function evalBinary(e: Extract<Expr, { kind: "binary" }>, getCell: (r: number, c: number) => CellValue, now: number, random: () => number): Scalar {
  const l = flatten1(evalExpr(e.left, getCell, now, random));
  const r = flatten1(evalExpr(e.right, getCell, now, random));
  if (isErrorValue(l)) return l;
  if (isErrorValue(r)) return r;

  switch (e.op) {
    case "&": return toText(l) + toText(r);
    case "=": case "<>": case "<": case ">": case "<=": case ">=":
      return compare(l, r, e.op);
    case "+": case "-": case "*": case "/": case "^": {
      const a = toNumber(l);
      const b = toNumber(r);
      if (typeof a === "string") return a;
      if (typeof b === "string") return b;
      switch (e.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? ERR.div0 : a / b;
        case "^": {
          const p = Math.pow(a, b);
          return Number.isFinite(p) ? p : ERR.num;
        }
      }
    }
  }
  return ERR.value;
}

function compare(l: Scalar, r: Scalar, op: string): boolean | string {
  // Blank behaves like 0 against numbers, like "" against text.
  let a: number | string;
  let b: number | string;
  if (typeof l === "number" || typeof l === "boolean" || l === null) a = l === null ? 0 : toNumber(l) as number;
  else a = toText(l);
  if (typeof r === "number" || typeof r === "boolean" || r === null) b = r === null ? 0 : toNumber(r) as number;
  else b = toText(r);
  if (typeof a === "string" && typeof b === "number") a = toText(l);
  if (typeof b === "string" && typeof a === "number") b = toText(r);

  const cmp = typeof a === "number" && typeof b === "number"
    ? (a < b ? -1 : a > b ? 1 : 0)
    : String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  switch (op) {
    case "=": return cmp === 0;
    case "<>": return cmp !== 0;
    case "<": return cmp < 0;
    case ">": return cmp > 0;
    case "<=": return cmp <= 0;
    case ">=": return cmp >= 0;
  }
  return ERR.value;
}

function evalFunction(e: Extract<Expr, { kind: "func" }>, getCell: (r: number, c: number) => CellValue, now: number, random: () => number): Scalar {
  const name = e.name;

  // Lazy functions must not evaluate all args eagerly.
  if (name === "IF") {
    if (e.args.length < 2) return ERR.value;
    const cond = toBool(flatten1(evalExpr(e.args[0], getCell, now, random)));
    if (typeof cond === "string") return cond;
    if (cond) return flatten1(evalExpr(e.args[1], getCell, now, random));
    if (e.args.length >= 3) return flatten1(evalExpr(e.args[2], getCell, now, random));
    return false;
  }
  if (name === "IFERROR") {
    if (e.args.length < 2) return ERR.value;
    const v = flatten1(evalExpr(e.args[0], getCell, now, random));
    if (isErrorValue(v)) return flatten1(evalExpr(e.args[1], getCell, now, random));
    return v;
  }
  if (name === "AND" || name === "OR") {
    const vals: boolean[] = [];
    for (const a of e.args) {
      for (const v of flattenAll(evalExpr(a, getCell, now, random))) {
        if (isErrorValue(v)) return v;
        if (v === null) continue;
        const b = toBool(v);
        if (typeof b === "string") return b;
        vals.push(b);
      }
    }
    if (vals.length === 0) return ERR.value;
    return name === "AND" ? vals.every(Boolean) : vals.some(Boolean);
  }
  if (name === "CHOOSE") {
    if (e.args.length < 2) return ERR.value;
    const idxRaw = flatten1(evalExpr(e.args[0], getCell, now, random));
    if (isErrorValue(idxRaw)) return idxRaw;
    const idx = toNumber(idxRaw);
    if (typeof idx === "string") return idx;
    const i = Math.trunc(idx);
    if (i < 1 || i > e.args.length - 1) return ERR.value;
    return flatten1(evalExpr(e.args[i], getCell, now, random));
  }

  const args: Arg[] = e.args.map((a) => evalExpr(a, getCell, now, random));
  const first = args.length ? flatten1(args[0]) : null;

  const nums = (): number[] | string => numericCells(args);

  switch (name) {
    // ── Aggregates ──
    case "SUM": { const n = nums(); return typeof n === "string" ? n : n.reduce((a, b) => a + b, 0); }
    case "PRODUCT": { const n = nums(); if (typeof n === "string") return n; return n.length ? n.reduce((a, b) => a * b, 1) : 0; }
    case "AVERAGE": { const n = nums(); if (typeof n === "string") return n; return n.length ? n.reduce((a, b) => a + b, 0) / n.length : ERR.div0; }
    case "MIN": { const n = nums(); if (typeof n === "string") return n; return n.length ? Math.min(...n) : 0; }
    case "MAX": { const n = nums(); if (typeof n === "string") return n; return n.length ? Math.max(...n) : 0; }
    case "COUNT": { const n = nums(); return typeof n === "string" ? n : n.length; }
    case "COUNTA": {
      let c = 0;
      for (const a of args) for (const v of flattenAll(a)) {
        if (isErrorValue(v)) return v;
        if (v === null) continue;
        if (typeof v === "string" && v === "") continue;
        c++;
      }
      return c;
    }
    case "MEDIAN": {
      const n = nums(); if (typeof n === "string") return n;
      if (!n.length) return ERR.num;
      const s = [...n].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
    case "STDEV": case "VAR": {
      const n = nums(); if (typeof n === "string") return n;
      if (n.length < 2) return ERR.div0;
      const mean = n.reduce((a, b) => a + b, 0) / n.length;
      const ss = n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1);
      return name === "VAR" ? ss : Math.sqrt(ss);
    }
    case "LARGE": case "SMALL": {
      const n = Array.isArray(args[0]) ? (args[0] as Scalar[]) : [first];
      const k = toNumber(flatten1(args[1] ?? null));
      if (typeof k === "string") return k;
      const vals = n.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      const i = Math.trunc(k);
      if (i < 1 || i > vals.length) return ERR.num;
      return name === "LARGE" ? vals[vals.length - i] : vals[i - 1];
    }
    case "RANK": {
      const x = toNumber(first);
      if (typeof x === "string") return x;
      const pool = Array.isArray(args[1]) ? args[1].filter((v): v is number => typeof v === "number") : [];
      const desc = args.length > 2 ? toBool(flatten1(args[2])) !== false : true;
      const sorted = [...pool].sort((a, b) => (desc ? b - a : a - b));
      const idx = sorted.indexOf(x);
      return idx < 0 ? ERR.na : idx + 1;
    }
    case "PERCENTILE": {
      const pool = Array.isArray(args[0]) ? args[0].filter((v): v is number => typeof v === "number").sort((a, b) => a - b) : [];
      const p = toNumber(flatten1(args[1] ?? null));
      if (typeof p === "string") return p;
      if (!pool.length || p < 0 || p > 1) return ERR.num;
      const pos = (pool.length - 1) * p;
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      return lo === hi ? pool[lo] : pool[lo] + (pool[hi] - pool[lo]) * (pos - lo);
    }

    // ── Math ──
    case "ABS": { const n = toNumber(first); return typeof n === "string" ? n : Math.abs(n); }
    case "SQRT": { const n = toNumber(first); if (typeof n === "string") return n; return n < 0 ? ERR.num : Math.sqrt(n); }
    case "POWER": { const a = toNumber(first); const b = toNumber(flatten1(args[1] ?? null)); if (typeof a === "string") return a; if (typeof b === "string") return b; const p = Math.pow(a, b); return Number.isFinite(p) ? p : ERR.num; }
    case "EXP": { const n = toNumber(first); return typeof n === "string" ? n : Math.exp(n); }
    case "LN": { const n = toNumber(first); if (typeof n === "string") return n; return n <= 0 ? ERR.num : Math.log(n); }
    case "LOG10": { const n = toNumber(first); if (typeof n === "string") return n; return n <= 0 ? ERR.num : Math.log10(n); }
    case "LOG": {
      const n = toNumber(first);
      if (typeof n === "string") return n;
      if (n <= 0) return ERR.num;
      if (args.length < 2) return Math.log10(n);
      const base = toNumber(flatten1(args[1]));
      if (typeof base === "string") return base;
      if (base <= 0 || base === 1) return ERR.num;
      return Math.log(n) / Math.log(base);
    }
    case "SIN": { const n = toNumber(first); return typeof n === "string" ? n : Math.sin(n); }
    case "COS": { const n = toNumber(first); return typeof n === "string" ? n : Math.cos(n); }
    case "TAN": { const n = toNumber(first); return typeof n === "string" ? n : Math.tan(n); }
    case "PI": return Math.PI;
    case "INT": { const n = toNumber(first); return typeof n === "string" ? n : Math.floor(n); }
    case "MOD": { const a = toNumber(first); const b = toNumber(flatten1(args[1] ?? null)); if (typeof a === "string") return a; if (typeof b === "string") return b; if (b === 0) return ERR.div0; return a - b * Math.floor(a / b); }
    case "ROUND": {
      const n = toNumber(first);
      const dRaw = args.length > 1 ? toNumber(flatten1(args[1])) : 0;
      if (typeof n === "string") return n;
      if (typeof dRaw === "string") return dRaw;
      const d = Math.trunc(dRaw);
      const f = Math.pow(10, d);
      // Half away from zero, matching spreadsheet ROUND (JS Math.round rounds -0.5 to -0).
      return Math.sign(n) * Math.round(Math.abs(n) * f) / f;
    }
    case "FLOOR": { const n = toNumber(first); const s = args.length > 1 ? toNumber(flatten1(args[1])) : 1; if (typeof n === "string") return n; if (typeof s === "string") return s; if (s === 0) return ERR.div0; return Math.floor(n / s) * s; }
    case "CEILING": { const n = toNumber(first); const s = args.length > 1 ? toNumber(flatten1(args[1])) : 1; if (typeof n === "string") return n; if (typeof s === "string") return s; if (s === 0) return ERR.div0; return Math.ceil(n / s) * s; }
    case "RAND": return random();

    // ── Text ──
    case "LEN": { const n = toNumber(first); if (typeof n === "string" && n !== ERR.value) return n; return toText(first).length; }
    case "UPPER": return toText(first).toUpperCase();
    case "LOWER": return toText(first).toLowerCase();
    case "TRIM": return toText(first).replace(/\s+/g, " ").trim();
    case "CONCAT": return args.map((a) => flattenAll(a).map(toText).join("")).join("");
    case "LEFT": {
      const s = toText(first);
      const nRaw = args.length > 1 ? toNumber(flatten1(args[1])) : 1;
      if (typeof nRaw === "string") return nRaw;
      const n = Math.trunc(nRaw);
      return n < 0 ? ERR.value : s.slice(0, n);
    }
    case "RIGHT": {
      const s = toText(first);
      const nRaw = args.length > 1 ? toNumber(flatten1(args[1])) : 1;
      if (typeof nRaw === "string") return nRaw;
      const n = Math.trunc(nRaw);
      if (n < 0) return ERR.value;
      return n === 0 ? "" : s.slice(-n);
    }
    case "MID": {
      const s = toText(first);
      const st = toNumber(flatten1(args[1] ?? null));
      const ln = toNumber(flatten1(args[2] ?? null));
      if (typeof st === "string") return st;
      if (typeof ln === "string") return ln;
      const start = Math.trunc(st);
      const len = Math.trunc(ln);
      if (start < 1 || len < 0) return ERR.value;
      return s.substr(start - 1, len);
    }
    case "SUBSTITUTE": {
      const s = toText(first);
      const find = toText(flatten1(args[1] ?? null));
      const rep = toText(flatten1(args[2] ?? null));
      if (!find) return s;
      if (args.length > 3) {
        const nth = toNumber(flatten1(args[3]));
        if (typeof nth === "string") return nth;
        const n = Math.trunc(nth);
        if (n < 1) return ERR.value;
        let idx = -1;
        for (let k = 0; k < n; k++) { idx = s.indexOf(find, idx + 1); if (idx < 0) return s; }
        return s.slice(0, idx) + rep + s.slice(idx + find.length);
      }
      return s.split(find).join(rep);
    }
    case "FIND": {
      const needle = toText(first);
      const hay = toText(flatten1(args[1] ?? null));
      const startRaw = args.length > 2 ? toNumber(flatten1(args[2])) : 1;
      if (typeof startRaw === "string") return startRaw;
      const start = Math.trunc(startRaw);
      if (start < 1) return ERR.value;
      const idx = hay.indexOf(needle, start - 1);
      return idx < 0 ? ERR.value : idx + 1;
    }
    case "REPLACE": {
      const s = toText(first);
      const st = toNumber(flatten1(args[1] ?? null));
      const ln = toNumber(flatten1(args[2] ?? null));
      const rep = toText(flatten1(args[3] ?? null));
      if (typeof st === "string") return st;
      if (typeof ln === "string") return ln;
      const start = Math.trunc(st);
      const len = Math.trunc(ln);
      if (start < 1 || len < 0) return ERR.value;
      return s.slice(0, start - 1) + rep + s.slice(start - 1 + len);
    }
    case "REPT": {
      const s = toText(first);
      const nRaw = toNumber(flatten1(args[1] ?? null));
      if (typeof nRaw === "string") return nRaw;
      const n = Math.trunc(nRaw);
      if (n < 0) return ERR.value;
      if (s.length * n > 32767) return ERR.value;
      return s.repeat(n);
    }
    case "TEXT": return toText(first);
    case "VALUE": {
      const n = toNumber(first);
      return typeof n === "string" ? ERR.value : n;
    }

    // ── Logic ──
    case "NOT": { const b = toBool(first); return typeof b === "string" ? b : !b; }
    case "TRUE": return true;
    case "FALSE": return false;

    // ── Lookup ──
    case "VLOOKUP": {
      const needle = first;
      const table = Array.isArray(args[1]) ? args[1] : [];
      const colRaw = toNumber(flatten1(args[2] ?? null));
      if (typeof colRaw === "string") return colRaw;
      const colIdx = Math.trunc(colRaw);
      const approx = args.length > 3 ? toBool(flatten1(args[3])) !== false : true;
      const rangeArg = e.args[1];
      const width = rangeArg && rangeArg.kind === "range"
        ? Math.abs(rangeArg.end.col - rangeArg.start.col) + 1
        : colIdx;
      if (colIdx < 1 || colIdx > width) return ERR.ref;
      if (width === 0) return ERR.ref;
      const rows = table.length / width;
      let best = -1;
      for (let r = 0; r < rows; r++) {
        const cell = table[r * width];
        const eq = compare(cell, needle, "=");
        if (eq === true) { best = r; break; }
        if (approx && compare(cell, needle, "<=") === true) best = r;
      }
      if (best < 0) return ERR.na;
      return table[best * width + (colIdx - 1)] ?? null;
    }
    case "MATCH": {
      const needle = first;
      const hay = Array.isArray(args[1]) ? args[1] : [];
      const typeRaw = args.length > 2 ? toNumber(flatten1(args[2])) : 1;
      if (typeof typeRaw === "string") return typeRaw;
      const t = Math.trunc(typeRaw);
      let best = -1;
      for (let i = 0; i < hay.length; i++) {
        if (compare(hay[i], needle, "=") === true) return i + 1;
        if (t !== 0 && compare(hay[i], needle, t > 0 ? "<=" : ">=") === true) best = i;
      }
      return t === 0 || best < 0 ? ERR.na : best + 1;
    }
    case "INDEX": {
      const table = Array.isArray(args[0]) ? args[0] : [];
      const rowRaw = toNumber(flatten1(args[1] ?? null));
      if (typeof rowRaw === "string") return rowRaw;
      const row = Math.trunc(rowRaw);
      const rangeArg = e.args[0];
      const width = rangeArg && rangeArg.kind === "range"
        ? Math.abs(rangeArg.end.col - rangeArg.start.col) + 1
        : 1;
      if (args.length < 3) {
        if (row < 1 || row > table.length) return ERR.ref;
        return table[row - 1];
      }
      const colRaw = toNumber(flatten1(args[2]));
      if (typeof colRaw === "string") return colRaw;
      const col = Math.trunc(colRaw);
      const totalRows = table.length / width;
      if (row < 1 || row > totalRows || col < 1 || col > width) return ERR.ref;
      return table[(row - 1) * width + (col - 1)] ?? null;
    }

    // ── Information ──
    case "ISBLANK": return first === null || first === "";
    case "ISNUMBER": return typeof first === "number";
    case "ISTEXT": return typeof first === "string" && !isErrorValue(first);
    case "ISERROR": return isErrorValue(first);
    case "ISLOGICAL": return typeof first === "boolean";
    case "NA": return ERR.na;
    case "TYPE": {
      if (typeof first === "number") return 1;
      if (typeof first === "string") return isErrorValue(first) ? 16 : 2;
      if (typeof first === "boolean") return 4;
      return 1;
    }

    // ── Date ──
    case "NOW": return serialFromMs(now);
    case "TODAY": return Math.floor(serialFromMs(now));
    case "YEAR": { const s = toNumber(first); if (typeof s === "string") return s; return msFromSerial(s).getUTCFullYear(); }
    case "MONTH": { const s = toNumber(first); if (typeof s === "string") return s; return msFromSerial(s).getUTCMonth() + 1; }
    case "DAY": { const s = toNumber(first); if (typeof s === "string") return s; return msFromSerial(s).getUTCDate(); }

    default:
      return ERR.name;
  }
}

/** Spreadsheet serial date (1900 system, epoch 1899-12-30) from epoch milliseconds. */
export function serialFromMs(ms: number): number {
  return ms / 86400000 + 25569;
}

/** Epoch milliseconds from a spreadsheet serial date. */
export function msFromSerial(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400000));
}

/** Every function this engine implements. The set is closed: unknown → #NAME?. */
export const SUPPORTED_FUNCTIONS: readonly string[] = [
  // Aggregates
  "SUM", "PRODUCT", "AVERAGE", "MIN", "MAX", "COUNT", "COUNTA", "MEDIAN", "STDEV", "VAR",
  "LARGE", "SMALL", "RANK", "PERCENTILE",
  // Math
  "ABS", "SQRT", "POWER", "EXP", "LN", "LOG10", "LOG", "SIN", "COS", "TAN", "PI",
  "INT", "MOD", "ROUND", "FLOOR", "CEILING", "RAND",
  // Text
  "LEN", "UPPER", "LOWER", "TRIM", "CONCAT", "LEFT", "RIGHT", "MID", "SUBSTITUTE",
  "FIND", "REPLACE", "REPT", "TEXT", "VALUE",
  // Logic
  "IF", "IFERROR", "AND", "OR", "NOT", "TRUE", "FALSE", "CHOOSE",
  // Lookup
  "VLOOKUP", "MATCH", "INDEX",
  // Information
  "ISBLANK", "ISNUMBER", "ISTEXT", "ISERROR", "ISLOGICAL", "NA", "TYPE",
  // Date
  "NOW", "TODAY", "YEAR", "MONTH", "DAY",
];

export function isSupportedFunction(name: string): boolean {
  return (SUPPORTED_FUNCTIONS as readonly string[]).includes(name.toUpperCase());
}

// ── Dependency graph ─────────────────────────────────────────────────────

export interface CellGraphNode {
  row: number;
  col: number;
  formula?: string;
}

export interface DependencyGraph {
  /** node key "r:c" → keys it depends on */
  edges: Map<string, string[]>;
  /** dependency → dependents (reverse) */
  reverse: Map<string, string[]>;
  missing: string[];
}

export function buildDependencyGraph(
  cells: CellGraphNode[],
  parse: (formula: string) => CellRef[] = (f) => extractRefs(parseFormula(f)),
): DependencyGraph {
  const edges = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  const present = new Set(cells.map((c) => `${c.row}:${c.col}`));
  const missing: string[] = [];

  for (const c of cells) {
    const key = `${c.row}:${c.col}`;
    if (!c.formula) { edges.set(key, []); continue; }
    let deps: CellRef[] = [];
    try { deps = parse(c.formula); } catch { deps = []; }
    const depKeys = deps.map((d) => `${d.row}:${d.col}`);
    edges.set(key, depKeys);
    for (const d of depKeys) {
      if (!present.has(d) && !missing.includes(d)) missing.push(d);
      const list = reverse.get(d) ?? [];
      list.push(key);
      reverse.set(d, list);
    }
  }
  return { edges, reverse, missing };
}

/**
 * Tarjan strongly-connected components over the dependency graph.
 *
 * A cycle is an SCC of size >= 2, or a self-loop. This matters because a
 * plain DFS-colour detector reports every node *downstream* of a cycle as
 * being in the cycle too, which silently marks correct cells as broken.
 * Verified against the case A1=B1, B1=A1, A2=A1+1: the cycle is {A1,B1} and
 * A2 is only downstream.
 */
export function stronglyConnected(graph: DependencyGraph, subset?: string[]): string[][] {
  const keys = subset ?? [...graph.edges.keys()];
  const keySet = new Set(keys);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;

  const deps = (k: string): string[] => (graph.edges.get(k) ?? []).filter((d) => keySet.has(d));

  // Iterative Tarjan: a recursive version blows the stack on long chains.
  for (const root of keys) {
    if (index.has(root)) continue;
    type Frame = { node: string; i: number; self: boolean };
    const work: Frame[] = [{ node: root, i: 0, self: true }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (work.length) {
      const f = work[work.length - 1];
      const children = deps(f.node);
      if (f.i < children.length) {
        const child = children[f.i++];
        if (!index.has(child)) {
          index.set(child, counter);
          low.set(child, counter);
          counter++;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, i: 0, self: true });
        } else if (onStack.has(child)) {
          low.set(f.node, Math.min(low.get(f.node)!, index.get(child)!));
        }
        continue;
      }
      if (low.get(f.node) === index.get(f.node)) {
        const comp: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
          if (w === f.node) break;
        }
        const selfLoop = comp.length === 1 && deps(comp[0]).includes(comp[0]);
        if (comp.length > 1 || selfLoop) out.push(comp.sort());
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(f.node)!));
      }
    }
  }
  return out;
}

/**
 * Topological order (dependencies first). Nodes on a cycle are excluded and
 * reported, never silently linearised — a wrong order produces wrong numbers.
 */
export function topologicalOrder(
  graph: DependencyGraph,
  subset?: string[],
): { order: string[]; cycles: string[]; components: string[][] } {
  const keys = subset ?? [...graph.edges.keys()];
  const keySet = new Set(keys);
  const components = stronglyConnected(graph, keys);
  const onCycle = new Set<string>();
  for (const comp of components) for (const k of comp) onCycle.add(k);

  const inDegree = new Map<string, number>();
  for (const k of keys) {
    if (onCycle.has(k)) continue;
    // Dependencies that sit ON a cycle count as unsatisfied on purpose. The
    // earlier version filtered them out, which made a downstream cell look
    // ready and then evaluate against a null cell — a silently wrong number
    // reported as a correct one.
    const deps = (graph.edges.get(k) ?? []).filter((d) => keySet.has(d));
    inDegree.set(k, deps.length);
  }

  const queue = keys.filter((k) => !onCycle.has(k) && (inDegree.get(k) ?? 0) === 0);
  const order: string[] = [];
  const done = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    if (done.has(k)) continue;
    order.push(k);
    done.add(k);
    for (const dependent of graph.reverse.get(k) ?? []) {
      if (!keySet.has(dependent) || onCycle.has(dependent) || done.has(dependent)) continue;
      const d = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, d);
      if (d === 0) queue.push(dependent);
    }
  }

  const cycles = keys.filter((k) => onCycle.has(k)).sort();
  return { order, cycles, components };
}

/** Cells that cannot be evaluated: on a cycle, or downstream of one. */
export function circularCells(graph: DependencyGraph): string[] {
  const { cycles, components } = topologicalOrder(graph);
  const out = new Set(cycles);
  // Build the component-level reverse edge set so descent is O(V+E), not
  // O(V^2) rescanning.
  const compOf = new Map<string, number>();
  components.forEach((comp, i) => comp.forEach((k) => compOf.set(k, i)));
  const stack = [...cycles];
  const visited = new Set<string>();
  while (stack.length) {
    const k = stack.pop()!;
    if (visited.has(k)) continue;
    visited.add(k);
    out.add(k);
    for (const dep of graph.reverse.get(k) ?? []) {
      if (!visited.has(dep) && !compOf.has(dep)) stack.push(dep);
    }
  }
  return [...out].sort();
}

export interface CellResult {
  row: number;
  col: number;
  value: CellValue;
  error?: string;
}

/**
 * Evaluate a whole sheet in dependency order, in a single pass over the
 * topologically sorted nodes. Cells on a cycle get #REF! (not a stale value).
 */
export function evaluateSheet(
  cells: CellGraphNode[],
  options: EvalOptions = {},
): { results: CellResult[]; cycles: string[] } {
  const byKey = new Map<string, CellGraphNode>();
  for (const c of cells) byKey.set(`${c.row}:${c.col}`, c);

  const values = new Map<string, CellValue>();
  for (const c of cells) {
    if (!c.formula) values.set(`${c.row}:${c.col}`, null);
  }

  const graph = buildDependencyGraph(cells);
  const { order, cycles, components } = topologicalOrder(graph);
  const onCycle = new Set<string>();
  for (const comp of components) for (const k of comp) onCycle.add(k);

  const getCell = (r: number, c: number): CellValue => {
    const k = `${r}:${c}`;
    return values.has(k) ? values.get(k)! : null;
  };

  const results: CellResult[] = [];
  for (const key of order) {
    const node = byKey.get(key)!;
    if (!node.formula) {
      results.push({ row: node.row, col: node.col, value: null });
      continue;
    }
    const res = evaluateFormula(node.formula, getCell, options);
    values.set(key, res.value);
    results.push({ row: node.row, col: node.col, value: res.value, error: res.error });
  }

  // Cycle members get #REF! with a precise reason. Cells merely downstream are
  // already absent from `order` because their in-degree never reached zero;
  // they get #REF! too, but with the honest "depends on" reason.
  const emitted = new Set(results.map((r) => `${r.row}:${r.col}`));
  for (const key of cycles) {
    const node = byKey.get(key);
    if (!node || emitted.has(key)) continue;
    values.set(key, ERR.ref);
    results.push({ row: node.row, col: node.col, value: ERR.ref, error: "circular reference" });
    emitted.add(key);
  }
  for (const node of cells) {
    const key = `${node.row}:${node.col}`;
    if (emitted.has(key) || !node.formula) continue;
    values.set(key, ERR.ref);
    results.push({
      row: node.row, col: node.col, value: ERR.ref,
      error: onCycle.has(key) ? "circular reference" : "depends on circular reference",
    });
  }

  return { results, cycles };
}
