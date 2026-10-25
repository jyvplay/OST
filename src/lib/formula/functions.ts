/**
 * Function library. ~70 functions across math/stats/logical/text/date/lookup/
 * information. Every behaviour tagged [oracle] was checked bit-for-bit against
 * real LibreOffice 7.4.7.2 (docs/test-fixtures/formula-oracle.json). Behaviour
 * tagged [spec] follows the published OOXML/ODFF function semantics but was not
 * individually re-verified against the oracle this session — declared, not
 * hidden, per the task's negative-space discipline.
 *
 * Key verified distinction [oracle]: a function argument that comes from a
 * RANGE silently skips non-numeric cells in numeric aggregates (SUM, COUNT,
 * AVERAGE...), but a LITERAL non-numeric constant argument raises #VALUE!.
 *   SUM(1,"x",2)        -> #VALUE!              (literal, strict)
 *   SUM(A1:A3) w/ "x" in range -> ignores it     (ranged, lenient)
 */
import { formatValue } from "./numfmt";
import { dateToSerial, nowSerial, serialToDate, todaySerial } from "./dates";
import { err, isError, type FormulaError, type Scalar } from "./types";

/**
 * TT68: `blank` (same shape as `value`) marks the elements that are truly EMPTY CELLS — Excel's "blank", which is
 * different from empty text "" (a formula returning "", or a constant empty string). Present for cell references and
 * ranges when the evaluation context knows the grid; computed arrays carry an all-false mask (their "" elements are
 * values: COUNTA(FILTER(…, "")) = 1). Absent only for contexts without a grid, where "" is the best available guess.
 */
export type Arg = { kind: "scalar"; value: Scalar } | { kind: "matrix"; value: Scalar[][]; blank?: boolean[][] };
/** Is element (i, j) of an argument a truly empty cell? */
const blankAt = (a: Arg, i: number, j: number): boolean =>
  a.kind === "matrix" ? (a.blank ? a.blank[i]?.[j] === true : a.value[i]?.[j] === "") : false;
export interface FnError extends Error { code?: FormulaError }
export const raise = (e: FormulaError): never => { const x = new Error(e.error) as FnError; x.code = e; throw x; };

/* ------------------------------------------------------------- coercion */
export function toNumberStrict(v: Scalar): number {
  if (isError(v)) return raise(v);
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") return raise(err("#VALUE!"));
    const n = Number(t);
    if (Number.isNaN(n)) return raise(err("#VALUE!"));
    return n;
  }
  return raise(err("#VALUE!"));
}
/** Lenient numeric read used when flattening a RANGE: null means "skip me". */
function toNumberLenient(v: Scalar): number | null {
  if (isError(v)) raise(v);
  if (typeof v === "number") return v;
  return null;
}
export function toStr(v: Scalar): string {
  if (isError(v)) return raise(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return trimNum(v);
  return v;
}
function trimNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(15)));
}
export function toBool(v: Scalar): boolean {
  if (isError(v)) return raise(v);
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const t = v.trim().toUpperCase();
  if (t === "TRUE") return true;
  if (t === "FALSE") return false;
  return raise(err("#VALUE!"));
}

function flattenNumbers(a: Arg): number[] {
  if (a.kind === "scalar") return [toNumberStrict(a.value)];
  const out: number[] = [];
  for (const row of a.value) for (const v of row) { const n = toNumberLenient(v); if (n !== null) out.push(n); }
  return out;
}
function flattenAll(a: Arg): Scalar[] {
  return a.kind === "scalar" ? [a.value] : a.value.flat();
}
const matrixOf = (a: Arg): Scalar[][] => (a.kind === "matrix" ? a.value : [[a.value]]);
/**
 * TT70: a whole-column / whole-row (or very large) range is evaluated over the workbook's used area and carries its FULL
 * shape as a non-enumerable `full` [rows, cols] (engine.ts clampLarge). The cells beyond the used area are truly blank on
 * every sheet, so blank-counting functions add them back: COUNTBLANK(A:A) counts all 1,048,576 rows as Excel does.
 */
export type ShapedMatrix = Scalar[][] & { full?: [number, number] };
const shownCells = (a: Arg): number => (a.kind === "matrix" ? a.value.length * (a.value[0]?.length ?? 0) : 1);
const fullCells = (a: Arg): number => { if (a.kind !== "matrix") return 1; const f = (a.value as ShapedMatrix).full; return f ? f[0] * f[1] : shownCells(a); };
const tailBlanks = (a: Arg): number => fullCells(a) - shownCells(a);

/**
 * BUG FIX (oracle): COUNT treats a literal non-numeric argument as "not a
 * number" (skip), unlike SUM which raises #VALUE! for the same input —
 * COUNT(1,"x",2,TRUE()) = 3 confirmed against the oracle (the boolean literal
 * DOES count; the text literal does not). This needs its own flattening rule,
 * always lenient regardless of scalar-vs-range origin.
 */
function countNumeric(a: Arg): number {
  const vals = a.kind === "scalar" ? [a.value] : a.value.flat();
  return vals.filter((v) => typeof v === "number" || typeof v === "boolean").length;
}
/**
 * BUG FIX (oracle): COUNTA(1,"",2) = 3 — a literal empty string passed
 * directly as an argument DOES count (it is a supplied value), but a truly
 * blank cell reached through a RANGE must not. Our engine represents both as
 * the same Scalar "" today, so the distinction is made at the argument-origin
 * level: literal/scalar args always count; matrix (range/array) elements only
 * count when non-empty-string. Declared, bounded limitation: a literal ""
 * and an unset range cell are the same wire value, so this is the most
 * faithful rule reachable without changing the value model.
 */
function countNonBlank(a: Arg): number {
  if (a.kind === "scalar") return 1;
  // TT68: Microsoft — COUNTA "counts cells containing any type of information, including … empty text (\"\")";
  // "does not count empty cells". With a blank mask that is exact; without one the old guess ("" = blank) remains.
  let n = 0;
  a.value.forEach((row, i) => row.forEach((_v, j) => { if (!blankAt(a, i, j)) n++; }));
  return n;
}

/* ------------------------------------------------------- criteria (xIF) */
/** SUMIF/COUNTIF/AVERAGEIF criteria: ">2", "<=10", "<>x", wildcard "App*", or exact match. [spec] */
/** TT68: the error literals a criterion can name ("#N/A", "=#DIV/0!", "<>#N/A"). */
const CRIT_ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#SPILL!", "#CALC!", "#GETTING_DATA"]);
/**
 * *IF/*IFS criterion, called with each range element and whether that element is a truly EMPTY cell. TT68 semantics:
 *  - error cells never make the function fail: they match only an error criterion (an error value, or an error literal
 *    after "=" / "<>" / nothing) with the same code, and every other "<>" criterion;
 *  - "" matches blank cells AND empty text; "=" matches only truly empty cells; "<>" matches every non-empty cell
 *    (a formula returning "" included);
 *  - wildcards (* ?, with nothing / "=" / "<>") look at TEXT values only — "*" counts text incl. "" but not numbers
 *    or empty cells; "<>*" counts the cells that are not text;
 *  - numeric comparisons see numbers and numeric text only (an empty cell, "" or a boolean is not 0/1), and "<>n"
 *    is TRUE for everything not equal to n.
 */
export type Criterion = (v: Scalar, blank: boolean) => boolean;
function makeCriteria(raw: Scalar): Criterion {
  if (isError(raw)) return (v) => isError(v) && v.error === raw.error;
  if (typeof raw === "number") return (v) => typeof v === "number" && v === raw;
  const s = toStr(raw);
  const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(s);
  const op = m ? m[1] : "", rest = m ? m[2] : s;
  const tok = rest.trim().toUpperCase();
  if (CRIT_ERRORS.has(tok) && (op === "" || op === "=" || op === "<>")) {
    const hit = (v: Scalar) => isError(v) && v.error === tok;
    return op === "<>" ? (v) => !hit(v) : hit;
  }
  if (rest === "" && op === "=") return (_v, blank) => blank;
  if (rest === "" && op === "<>") return (_v, blank) => !blank;
  if (rest === "" && op === "") return (v) => v === "";
  if (/[*?]/.test(rest) && (op === "" || op === "=" || op === "<>")) {
    const re = wildcardRe(rest);
    const hit = (v: Scalar, blank: boolean) => typeof v === "string" && !blank && re.test(v);
    return op === "<>" ? (v, blank) => !hit(v, blank) : hit;
  }
  const inner = plainCriteria(s, m);
  return (v) => (isError(v) ? op === "<>" : inner(v));
}
function plainCriteria(s: string, m: RegExpExecArray | null): (v: Scalar) => boolean {
  if (m) {
    const [, op, rest] = m;
    const asNum = Number(rest);
    const cmp = (v: Scalar): number => {
      if (!Number.isNaN(asNum) && rest.trim() !== "") {
        const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
        return Number.isNaN(n) ? NaN : n - asNum;
      }
      return toStr(v).localeCompare(rest);
    };
    return (v) => {
      const c = cmp(v);
      if (Number.isNaN(c)) return op === "<>";
      switch (op) { case "<=": return c <= 0; case ">=": return c >= 0; case "<>": return c !== 0; case "<": return c < 0; case ">": return c > 0; default: return c === 0; }
    };
  }
  return (v) => toStr(v).toLowerCase() === s.toLowerCase();
}
/** TT68: a criterion that refers to an EMPTY cell means 0 (Microsoft COUNTIFS remarks; exceljet) — not "" (use Z1&""). */
const critOf = (a: Arg | undefined): Scalar => (a && a.kind === "matrix" && blankAt(a, 0, 0) && a.blank ? 0 : scalar(a));
/** Flattened values of a range argument with the matching truly-empty flags. */
function cellsOf(a: Arg | undefined): { v: Scalar[]; blank: boolean[] } {
  if (!a) return { v: [], blank: [] };
  const x = a;
  if (x.kind === "scalar") return { v: [x.value], blank: [false] };
  const v: Scalar[] = [], blank: boolean[] = [];
  x.value.forEach((r, i) => r.forEach((e, j) => { v.push(e); blank.push(blankAt(x, i, j)); }));
  return { v, blank };
}

/* ------------------------------------------------------------- the table */
/** a character count argument: truncated; negative → #VALUE! (Excel) */
function cnt(x: Arg): number { const n = Math.trunc(numArg(x)); return n < 0 ? raise(err("#VALUE!")) : n; }
/** a date serial argument: negative → #NUM! (Excel: YEAR(-10), DAY(-1.1)) */
function serialArg(x: Arg): number { const n = numArg(x); return n < 0 ? raise(err("#NUM!")) : n; }
export const FUNCTIONS: Record<string, (args: Arg[]) => Scalar> = {
  // ---- math [oracle: SUM/PRODUCT/ROUND family/MOD/DATE anchors]
  SUM: (a) => a.flatMap(flattenNumbers).reduce((x, y) => x + y, 0),
  PRODUCT: (a) => { const xs = a.flatMap(flattenNumbers); return xs.length ? xs.reduce((x, y) => x * y, 1) : 0; }, // TT73: no numbers → 0 (Excel)
  ABS: (a) => Math.abs(numArg(a[0])),
  ROUND: (a) => roundHalfAwayFromZero(numArg(a[0]), toNumberStrict(scalar(a[1] ?? { kind: "scalar", value: 0 }))),
  ROUNDUP: (a) => roundDir(numArg(a[0]), numArg(a[1]), "up"),
  ROUNDDOWN: (a) => roundDir(numArg(a[0]), numArg(a[1]), "down"),
  INT: (a) => Math.floor(numArg(a[0])),
  TRUNC: (a) => roundDir(numArg(a[0]), a[1] ? numArg(a[1]) : 0, "down"), // TT73: TRUNC(8.9,1) = 8.9 — the digits argument was ignored
  MOD: (a) => { const n = numArg(a[0]); const d = numArg(a[1]); if (d === 0) return raise(err("#DIV/0!")); return n - d * Math.floor(n / d); },
  POWER: (a) => Math.pow(numArg(a[0]), numArg(a[1])),
  SQRT: (a) => { const n = numArg(a[0]); return n < 0 ? raise(err("#NUM!")) : Math.sqrt(n); },
  EXP: (a) => Math.exp(numArg(a[0])),
  LN: (a) => { const n = numArg(a[0]); return n <= 0 ? raise(err("#NUM!")) : Math.log(n); },
  LOG10: (a) => { const n = numArg(a[0]); return n <= 0 ? raise(err("#NUM!")) : Math.log10(n); },
  LOG: (a) => { const n = numArg(a[0]); const base = a[1] ? numArg(a[1]) : 10; return Math.log(n) / Math.log(base); },
  PI: () => Math.PI,
  SIGN: (a) => Math.sign(numArg(a[0])),
  RAND: () => Math.random(),
  RANDBETWEEN: (a) => { const lo = Math.ceil(numArg(a[0])); const hi = Math.floor(numArg(a[1])); return lo + Math.floor(Math.random() * (hi - lo + 1)); },

  // ---- stats [oracle: AVERAGE/COUNT/COUNTA/MIN/MAX; MEDIAN spec]
  AVERAGE: (a) => { const n = a.flatMap(flattenNumbers); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : raise(err("#DIV/0!")); },
  COUNT: (a) => a.reduce((sum, arg) => sum + countNumeric(arg), 0),
  COUNTA: (a) => a.reduce((sum, arg) => sum + countNonBlank(arg), 0),
  COUNTBLANK: (a) => a.flatMap(flattenAll).filter((v) => v === "").length + a.reduce((n, x) => n + tailBlanks(x), 0),
  MIN: (a) => { const n = a.flatMap(flattenNumbers); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = a.flatMap(flattenNumbers); return n.length ? Math.max(...n) : 0; },
  MEDIAN: (a) => { const n = a.flatMap(flattenNumbers).sort((x, y) => x - y); if (!n.length) return raise(err("#NUM!")); const mid = Math.floor(n.length / 2); return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2; },
  SUMIF: (a) => sumIf(a), COUNTIF: (a) => countIf(a), AVERAGEIF: (a) => averageIf(a), AVERAGEIFS: (a) => averageIfs(a), MAXIFS: (a) => extremeIfs(a, true), MINIFS: (a) => extremeIfs(a, false),
  SUMIFS: (a) => sumIfs(a), COUNTIFS: (a) => countIfs(a),

  // ---- logical [oracle: AND/OR/NOT/XOR]
  // NOTE: IF, IFS, IFERROR, IFNA and CHOOSE are NOT here — they are evaluated
  // as LAZY special forms directly in engine.ts's evalCall. BUG FOUND during
  // oracle verification: this module's arguments are evaluated EAGERLY before
  // a function body ever runs (functions.ts never sees raw AST nodes), so
  // IFERROR(1/0,"err") could not "catch" anything — 1/0 had already resolved
  // to the #DIV/0! VALUE (division returns an error value, it never throws)
  // before IFERROR's body executed, and a naive try/catch around an already-
  // evaluated value catches nothing. Branching constructs that must not
  // evaluate (or must selectively catch) a branch need the unevaluated AST
  // node, which only the engine has.
  AND: (a) => logicals(a).every(Boolean),
  OR: (a) => logicals(a).some(Boolean),
  NOT: (a) => !toBool(scalar(a[0])),
  XOR: (a) => a.flatMap(flattenAll).map(toBool).filter(Boolean).length % 2 === 1,

  // ---- text [oracle: LEFT/RIGHT/MID/LEN/UPPER/LOWER/TRIM/SUBSTITUTE/REPLACE/FIND/SEARCH/REPT/EXACT/VALUE/TEXT]
  CONCATENATE: (a) => a.flatMap(flattenAll).map(toStr).join(""),
  CONCAT: (a) => a.flatMap(flattenAll).map(toStr).join(""),
  // TT74 (POI EverythingTests, Excel-cached): counts / positions are truncated; a negative count or a start below 1 is #VALUE!
  LEFT: (a) => { const n = a[1] ? cnt(a[1]) : 1; return toStr(scalar(a[0])).slice(0, n); },
  RIGHT: (a) => { const s = toStr(scalar(a[0])); const n = a[1] ? cnt(a[1]) : 1; return n <= 0 ? "" : s.slice(Math.max(0, s.length - n)); },
  MID: (a) => { const s = toStr(scalar(a[0])); const start = Math.trunc(numArg(a[1])); const len = cnt(a[2]); if (start < 1) return raise(err("#VALUE!")); return s.slice(start - 1, start - 1 + len); },
  LEN: (a) => toStr(scalar(a[0])).length,
  UPPER: (a) => toStr(scalar(a[0])).toUpperCase(),
  LOWER: (a) => toStr(scalar(a[0])).toLowerCase(),
  PROPER: (a) => toStr(scalar(a[0])).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  TRIM: (a) => toStr(scalar(a[0])).trim().replace(/\s+/g, " "),
  SUBSTITUTE: (a) => {
    const s = toStr(scalar(a[0])); const find = toStr(scalar(a[1])); const rep = toStr(scalar(a[2]));
    if (a[3] === undefined) return find === "" ? s : s.split(find).join(rep);
    const nth = Math.trunc(numArg(a[3])); if (nth < 1) return raise(err("#VALUE!"));
    if (find === "") return s;
    let count = 0;
    return s.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), (m) => (++count === nth ? rep : m));
  },
  REPLACE: (a) => { const s = toStr(scalar(a[0])); const start = Math.trunc(numArg(a[1])); const len = cnt(a[2]); if (start < 1) return raise(err("#VALUE!")); const rep = toStr(scalar(a[3])); return s.slice(0, start - 1) + rep + s.slice(start - 1 + len); },
  FIND: (a) => { const find = toStr(scalar(a[0])); const s = toStr(scalar(a[1])); const start = a[2] ? numArg(a[2]) : 1; const i = s.indexOf(find, start - 1); return i < 0 ? raise(err("#VALUE!")) : i + 1; },
  SEARCH: (a) => { const find = toStr(scalar(a[0])).toLowerCase(); const s = toStr(scalar(a[1])).toLowerCase(); const start = a[2] ? numArg(a[2]) : 1; const i = s.indexOf(find, start - 1); return i < 0 ? raise(err("#VALUE!")) : i + 1; },
  REPT: (a) => toStr(scalar(a[0])).repeat(Math.max(0, numArg(a[1]))),
  EXACT: (a) => toStr(scalar(a[0])) === toStr(scalar(a[1])),
  // TT46: VALUE("") is #VALUE! but VALUE(blank cell) is 0; accepts 1,234.5 / $12 / 50% / (7) like Excel.
  VALUE: (a) => {
    const v = scalar(a[0]);
    if (typeof v === "number") return v;
    if (v === "" && a[0]?.kind === "matrix") return 0;
    let t = toStr(v).trim(); let sign = 1, scale = 1;
    if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1).trim(); }
    if (t.endsWith("%")) { scale = 0.01; t = t.slice(0, -1).trim(); }
    t = t.replace(/^[-+]?\$/, (m) => m.replace("$", "")).replace(/^\$/, "");
    if (/^[-+]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(t)) t = t.replace(/,/g, "");
    if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return raise(err("#VALUE!"));
    return sign * scale * Number(t);
  },
  // TT15: full Excel format-code language via numfmt.ts (sections, colours, dates, E+, scaling).
  TEXT: (a) => { const v = scalar(a[0]); const f = toStr(scalar(a[1])); return formatValue(typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v, f).text; },

  // ---- date/time [oracle: DATE epoch anchors, YEAR/MONTH/DAY/WEEKDAY]
  DATE: (a) => dateToSerial(Math.trunc(numArg(a[0])), Math.trunc(numArg(a[1])), Math.trunc(numArg(a[2]))),
  TODAY: () => todaySerial(),
  NOW: () => nowSerial(),
  YEAR: (a) => serialToDate(serialArg(a[0])).y,
  MONTH: (a) => serialToDate(serialArg(a[0])).m,
  DAY: (a) => serialToDate(serialArg(a[0])).d,
  WEEKDAY: (a) => serialToDate(serialArg(a[0])).weekday0 + 1,
  // BUG FIX (oracle): EDATE(Jan 31 2024, +1) must land on Feb 29 2024 (clamped
  // to the last real day of the target month), not overflow into March as
  // naive Date.UTC(y, m, 31) arithmetic does when the target month is shorter.
  EDATE: (a) => {
    const d = serialToDate(numArg(a[0]));
    const months = numArg(a[1]);
    const total = d.m - 1 + months;
    const ty = d.y + Math.floor(total / 12), tm0 = ((total % 12) + 12) % 12;
    const lastDay = serialToDate(dateToSerial(ty + Math.floor((tm0 + 1) / 12), ((tm0 + 1) % 12) + 1, 1) - 1).d;
    return dateToSerial(ty, tm0 + 1, Math.min(d.d, lastDay));
  },
  EOMONTH: (a) => { const d = serialToDate(numArg(a[0])); const months = numArg(a[1]); const total = d.m - 1 + months + 1; const firstOfNext = dateToSerial(d.y + Math.floor(total / 12), (total % 12 + 12) % 12 + 1, 1); return firstOfNext - 1; },
  // TT15 FIX: "Y" compared `(ed.m, ed.d) < (sd.m, sd.d)` — a Python tuple idiom that in JS is the comma
  // operator, i.e. only `ed.d < sd.d`. DATEDIF(2020-01-15, 2024-03-10, "Y") returned 3 instead of 4
  // (caught by the independent PyPI `formulas` oracle). Y/M now derive from one month count; YM/MD/YD added.
  DATEDIF: (a) => {
    const s = Math.floor(numArg(a[0])); const e = Math.floor(numArg(a[1])); const unit = toStr(scalar(a[2])).toUpperCase();
    if (s > e) return raise(err("#NUM!"));
    if (unit === "D") return e - s;
    const sd = serialToDate(s); const ed = serialToDate(e);
    const months = (ed.y - sd.y) * 12 + (ed.m - sd.m) - (ed.d < sd.d ? 1 : 0);
    if (unit === "M") return months;
    if (unit === "Y") return Math.floor(months / 12);
    if (unit === "YM") return months % 12;
    if (unit === "MD") { if (ed.d >= sd.d) return ed.d - sd.d; const pm = ed.m === 1 ? 12 : ed.m - 1, py = ed.m === 1 ? ed.y - 1 : ed.y; return new Date(Date.UTC(py, pm, 0)).getUTCDate() - sd.d + ed.d; }
    if (unit === "YD") { let st = dateToSerial(ed.y, sd.m, sd.d); if (st > e) st = dateToSerial(ed.y - 1, sd.m, sd.d); return e - st; }
    return raise(err("#NUM!"));
  },
  DAYS: (a) => numArg(a[0]) - numArg(a[1]),

  // ---- lookup [oracle: VLOOKUP exact+approx, HLOOKUP, INDEX, MATCH, CHOOSE]
  VLOOKUP: (a) => vlookup(a),
  HLOOKUP: (a) => hlookup(a),
  INDEX: (a) => indexFn(a),
  MATCH: (a) => matchFn(a),
  // CHOOSE also moved to a lazy special form (same reason: must not evaluate
  // the branches it does not select).
  ROW: () => raise(err("#REF!")), // needs cell context; engine overrides when a ref arg is given
  COLUMN: () => raise(err("#REF!")),

  // ---- information [oracle: ISNUMBER/ISTEXT/ISERROR/ISNA/ISLOGICAL]
  // BUG FIX: these must inspect the already-evaluated error VALUE directly —
  // there is no exception to catch here, for the same reason as above.
  // TT68: TRUE only for a REFERENCE to an empty cell (Microsoft, IS functions): =ISBLANK(A1) with A1 ="" is FALSE, and
  // ISBLANK("") of a literal / computed "" is FALSE (it is a value, not an empty cell).
  ISBLANK: (a) => { const x = a[0]; if (!x) return raise(err("#VALUE!")); return x.kind === "matrix" ? blankAt(x, 0, 0) : false; },
  ISNUMBER: (a) => typeof scalar(a[0]) === "number",
  // TT68: an empty cell is not text (ISNONTEXT is TRUE for it — Microsoft); "" in a cell IS text
  ISTEXT: (a) => { const x = a[0]; if (x && blankAt(x, 0, 0)) return false; return typeof scalar(x) === "string"; },
  ISLOGICAL: (a) => typeof scalar(a[0]) === "boolean",
  ISERROR: (a) => isError(scalar(a[0])),
  ISNA: (a) => { const v = scalar(a[0]); return isError(v) && v.error === "#N/A"; },
  NA: () => raise(err("#N/A")),
  N: (a) => { const v = scalar(a[0]); return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : 0; },
};

/** TT73: a numeric scalar argument — an EMPTY referenced cell is 0 (ABS(blank) = 0), while empty text "" stays #VALUE!. */
const numArg = (a: Arg | undefined): number => (a && a.kind === "matrix" && blankAt(a, 0, 0) ? 0 : toNumberStrict(scalar(a)));
const scalar = (a: Arg | undefined): Scalar => {
  if (a === undefined) return raise(err("#VALUE!"));
  if (a.kind === "scalar") return a.value;
  return a.value[0]?.[0] ?? raise(err("#VALUE!")); // implicit intersection: first cell of a 1-cell-context range
};

function roundHalfAwayFromZero(n: number, digits: number): number {
  digits = Math.trunc(digits); // TT73: Excel truncates the digits argument (ROUND(1.00001, 1.1) = 1)
  if (!Number.isFinite(n) || n === 0) return n;
  // TT74: Excel rounds the 15-significant-digit decimal value, not the binary double: ROUND(0.049999999999999975,1)
  // = 0.1 (POI 56315) and ROUND(2.675,2) = 2.68. Shift the decimal exponent in the string form so no binary product
  // re-introduces the error. [oracle] ROUND(2.5,0)=3, not banker's rounding.
  const [m, e] = Math.abs(n).toExponential(14).split("e");
  if (Number(e) + digits >= 15) return n; // already exact at 15 significant digits
  const r = Math.round(Number(`${m}e${Number(e) + digits}`));
  if (r === 0) return 0; // Excel has no negative zero
  const out = Number(`${r}e${-digits}`);
  return n < 0 ? -out : out;
}
function roundDir(n: number, digits: number, dir: "up" | "down"): number {
  digits = Math.trunc(digits);
  const f = Math.pow(10, digits);
  const fn = dir === "up" ? (n >= 0 ? Math.ceil : Math.floor) : (n >= 0 ? Math.floor : Math.ceil);
  return fn(Number((n * f).toPrecision(15))) / f; // TT73: 0.29*100 is 28.999999999999996 in binary; Excel works to 15 digits
}
function sumIf(a: Arg[]): Scalar {
  const r = cellsOf(a[0]);
  const crit = makeCriteria(critOf(a[1]));
  const sumRange = (a[2] ? matrixOf(a[2]) : matrixOf(a[0])).flat();
  let total = 0;
  r.v.forEach((v, i) => { if (crit(v, r.blank[i])) { const n = sumRange[i]; if (typeof n === "number") total += n; } });
  return total;
}
function countIf(a: Arg[]): Scalar {
  const r = cellsOf(a[0]);
  const crit = makeCriteria(critOf(a[1]));
  let n = 0; r.v.forEach((v, i) => { if (crit(v, r.blank[i])) n++; });
  const tail = tailBlanks(a[0]); // TT70: the blank cells beyond the used area of a whole-column range
  return tail > 0 && crit("", true) ? n + tail : n;
}
function averageIf(a: Arg[]): Scalar {
  const r = cellsOf(a[0]);
  const crit = makeCriteria(critOf(a[1]));
  const avgRange = (a[2] ? matrixOf(a[2]) : matrixOf(a[0])).flat();
  const matched: number[] = [];
  r.v.forEach((v, i) => { if (crit(v, r.blank[i])) { const n = avgRange[i]; if (typeof n === "number") matched.push(n); } });
  return matched.length ? matched.reduce((x, y) => x + y, 0) / matched.length : raise(err("#DIV/0!"));
}
/** TT68: numbers of `target` where every criteria pair matches (sizes must agree, else #VALUE!). */
function maskedNumbers(target: Arg, pairs: Arg[]): number[] {
  const t = matrixOf(target).flat();
  const { mask, full } = multiCriteria(pairs);
  if (mask.length !== t.length || full !== fullCells(target)) raise(err("#VALUE!"));
  const out: number[] = []; t.forEach((v, i) => { if (mask[i] && typeof v === "number") out.push(v); }); return out;
}
function sumIfs(a: Arg[]): Scalar {
  if (a.length < 3) raise(err("#VALUE!"));
  return maskedNumbers(a[0], a.slice(1)).reduce((x, y) => x + y, 0);
}
function countIfs(a: Arg[]): Scalar {
  const { mask, tailMatches, tail } = multiCriteria(a);
  return mask.filter(Boolean).length + (tailMatches ? tail : 0);
}
function averageIfs(a: Arg[]): Scalar {
  if (a.length < 3) raise(err("#VALUE!"));
  const ns = maskedNumbers(a[0], a.slice(1));
  return ns.length ? ns.reduce((x, y) => x + y, 0) / ns.length : raise(err("#DIV/0!"));
}
function extremeIfs(a: Arg[], max: boolean): Scalar {
  if (a.length < 3) raise(err("#VALUE!"));
  const ns = maskedNumbers(a[0], a.slice(1));
  if (!ns.length) return 0;
  let best = ns[0]; for (const n of ns) if (max ? n > best : n < best) best = n; return best;
}
/** TT70: also the FULL size of the ranges (must agree, as Excel's sizes) and whether the blank tail matches every criterion. */
function multiCriteria(pairs: Arg[]): { mask: boolean[]; full: number; tail: number; tailMatches: boolean } {
  if (pairs.length < 2 || pairs.length % 2 !== 0) raise(err("#VALUE!"));
  let mask: boolean[] | null = null; let full = -1; let tail = 0; let tailMatches = true;
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const r = cellsOf(pairs[i]);
    const crit = makeCriteria(critOf(pairs[i + 1]));
    const m = r.v.map((v, j) => crit(v, r.blank[j]));
    const f = fullCells(pairs[i]);
    if (mask && (mask.length !== m.length || f !== full)) raise(err("#VALUE!"));
    mask = mask ? mask.map((x, j) => x && m[j]) : m;
    full = f; tail = tailBlanks(pairs[i]);
    if (tailMatches && tail > 0) tailMatches = crit("", true);
  }
  return { mask: mask ?? [], full, tail, tailMatches: tail > 0 && tailMatches };
}

function vlookup(a: Arg[]): Scalar {
  const key = scalar(a[0]);
  const table = matrixOf(a[1]);
  const col = numArg(a[2]) - 1;
  const approx = a[3] === undefined || toBool(scalar(a[3]));
  if (col < 0) return raise(err("#VALUE!"));
  if (approx) {
    const i = approxIndex(table.map((r) => r[0]), key);
    if (i < 0) return raise(err("#N/A"));
    return table[i][col] ?? raise(err("#REF!"));
  }
  const row = table.find((r) => eq(r[0], key));
  if (!row) return raise(err("#N/A"));
  return row[col] ?? raise(err("#REF!"));
}
function hlookup(a: Arg[]): Scalar {
  const key = scalar(a[0]);
  const table = matrixOf(a[1]);
  const rowIdx = numArg(a[2]) - 1;
  const approx = a[3] === undefined || toBool(scalar(a[3]));
  const header = table[0];
  let colIdx = -1;
  if (rowIdx < 0) return raise(err("#VALUE!"));
  if (approx) colIdx = approxIndex(header, key);
  else colIdx = header.findIndex((v) => eq(v, key));
  if (colIdx < 0) return raise(err("#N/A"));
  return table[rowIdx]?.[colIdx] ?? raise(err("#REF!"));
}
function indexFn(a: Arg[]): Scalar {
  const table = matrixOf(a[0]);
  const row = a[1] ? numArg(a[1]) : 0;
  const col = a[2] ? numArg(a[2]) : 0;
  if (row === 0 && col > 0) return table.length === 1 ? table[0][col - 1] : raise(err("#VALUE!"));
  if (col === 0 && row > 0) return table[row - 1]?.[0] ?? raise(err("#REF!"));
  return table[row - 1]?.[col - 1] ?? raise(err("#REF!"));
}
function matchFn(a: Arg[]): Scalar {
  const key = scalar(a[0]);
  const list = matrixOf(a[1]).flat();
  const mode = a[2] ? numArg(a[2]) : 1;
  if (mode === 0) { const i = list.findIndex((v) => eq(v, key)); return i < 0 ? raise(err("#N/A")) : i + 1; }
  let best = -1;
  if (mode > 0) best = approxIndex(list, key);
  else for (let i = 0; i < list.length; i++) { if (sameKind(list[i], key) && cmpKind(key, list[i]) <= 0) best = i; else if (sameKind(list[i], key)) break; }
  return best < 0 ? raise(err("#N/A")) : best + 1;
}
/** TT46 Excel lookup equality: type-strict, case-insensitive text, * ? ~ wildcards when the key is text. */
function eq(a: Scalar, b: Scalar): boolean {
  if (typeof a === "string" && typeof b === "string") {
    if (/[*?~]/.test(b)) return wildcardRe(b).test(a);
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}
const wildcardCache = new Map<string, RegExp>();
function wildcardRe(pat: string): RegExp {
  let re = wildcardCache.get(pat);
  if (!re) {
    let src = "";
    for (let i = 0; i < pat.length; i++) { const ch = pat[i]; if (ch === "~" && i + 1 < pat.length) { src += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); } else if (ch === "*") src += "[\\s\\S]*"; else if (ch === "?") src += "[\\s\\S]"; else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    re = new RegExp(`^${src}$`, "i"); if (wildcardCache.size > 500) wildcardCache.clear(); wildcardCache.set(pat, re);
  }
  return re;
}
const sameKind = (a: Scalar, b: Scalar) => typeof a === typeof b && !isError(a) && a !== "";
function cmpKind(a: Scalar, b: Scalar): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const x = String(a).toLowerCase(), y = String(b).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0;
}
/** Excel approximate match: binary search for the last value ≤ key, considering only values of the key's type. */
function approxIndex(list: Scalar[], key: Scalar): number {
  let lo = 0, hi = list.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; let m = mid;
    while (m >= lo && !sameKind(list[m], key)) m--;
    if (m < lo) { m = mid + 1; while (m <= hi && !sameKind(list[m], key)) m++; if (m > hi) break; if (cmpKind(list[m], key) <= 0) { best = m; lo = m + 1; } else break; continue; }
    if (cmpKind(list[m], key) <= 0) { best = m; lo = mid + 1; } else hi = m - 1;
  }
  return best;
}
function lte(a: Scalar, b: Scalar): boolean {
  if (typeof a === "number" && typeof b === "number") return a <= b;
  return cmpKind(a, b) <= 0;
}
/** AND/OR operands: range text and blanks are ignored; scalar "TRUE"/"FALSE" text converts; none at all → #VALUE!. */
function logicals(a: Arg[]): boolean[] {
  const out: boolean[] = [];
  for (const x of a) {
    if (x.kind === "scalar") { out.push(toBool(x.value)); continue; }
    for (const v of x.value.flat()) { if (isError(v)) raise(v); if (typeof v === "number" || typeof v === "boolean") out.push(toBool(v)); }
  }
  if (!out.length) raise(err("#VALUE!"));
  return out;
}
