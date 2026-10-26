/**
 * Spreadsheet function library for the Fusion office engine.
 *
 * Mechanism note: arguments arrive as *lazy accessors*, not pre-flattened values. That is required for
 * correctness, not style — IF/IFERROR must not evaluate the untaken branch, and SUMIF/VLOOKUP/INDEX need
 * the range shape (grid) rather than a flat list. The previous flat-dispatch design could not express
 * either, so this module replaces it.
 *
 * Dates use the 1900 serial system with Excel's historical 1900-leap-year quirk preserved for
 * compatibility with real files; serials are exact for dates from 1900-03-01 onward (see DATE_EPOCH).
 * Volatile functions (TODAY/NOW/RAND) take an injected clock/seed so evaluation stays deterministic
 * and testable — nothing in this engine reads the wall clock implicitly.
 */
import { numericText } from "../numtext";

export type CellValue = number | string | boolean | null;
export type ResultValue = CellValue | CellValue[][];

export function isGridValue(v: unknown): v is CellValue[][] {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]);
}

export function unwrapScalar(v: ResultValue): CellValue {
  if (isGridValue(v)) return v[0]?.[0] ?? null;
  return v as CellValue;
}

export const ERR = (s: string) => { const e = new Error(s); e.name = "CellError"; return e; };
/** Error values are a CLOSED SET, not any string starting with "#".
 *  Prefix matching wrongly classified legitimate text such as the number format "#,##0.00" and
 *  "#1 bestseller" as errors, which made TEXT() return its own format string. */
export const ERROR_VALUES = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CYCLE!", "#ERROR!", "#SPILL!", "#CALC!"] as const;
const ERROR_SET: ReadonlySet<string> = new Set(ERROR_VALUES);
/** Deliberately not a type predicate: narrowing would erase every other string from the else-branch. */
export const isErr = (v: CellValue): boolean => typeof v === "string" && ERROR_SET.has(v);

export type ArgAccessor = {
  /** Single scalar; a range collapses to its first cell. Throws CellError for error values. */
  value: () => CellValue;
  /** Flattened cells (ranges expanded row-major); scalars yield one element. */
  list: () => CellValue[];
  /** 2-D grid for lookup functions; scalars yield [[v]]. */
  grid: () => CellValue[][];
  /** True when the argument is a range reference rather than a scalar expression. */
  isRange: boolean;
};

export type EvalEnv = {
  /** Deterministic clock for TODAY/NOW. */
  now: () => Date;
  /** Deterministic uniform source for RAND/RANDBETWEEN. */
  random: () => number;
  /** 1-based row/col of the cell being evaluated (for ROW()/COLUMN() with no argument). */
  cursor: { row: number; col: number };
};

export function toNum(v: CellValue): number {
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isErr(v)) throw ERR(String(v));
  if (v.trim() === "") throw ERR("#VALUE!"); // TT73: empty TEXT ("" from a formula) is not a number; empty cells arrive as null → 0
  const n = numericText(v); // TT79: Excel coercion ("$1.00", "1,000", "50%", "(1)")
  if (n === null) throw ERR("#VALUE!");
  return n;
}
export function toStr(v: CellValue): string {
  if (v === null) return "";
  if (isErr(v)) throw ERR(String(v));
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
export function toBool(v: CellValue): boolean {
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  if (isErr(v)) throw ERR(String(v));
  if (typeof v === "number") return v !== 0;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  return toNum(v) !== 0;
}

/* ───────────────── dates (1900 serial system) ───────────────── */
// Excel/LibreOffice day 1 = 1900-01-01 and both treat 1900 as a leap year. Anchoring at 1899-12-30 UTC
// reproduces their serials exactly for 1900-03-01 and later, which is the range real files use.
const DATE_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
export const dateToSerial = (d: Date) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - DATE_EPOCH) / DAY_MS);
export const serialToDate = (s: number) => new Date(DATE_EPOCH + Math.floor(s) * DAY_MS);
const timeFraction = (d: Date) => (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) / 86400;

/* ───────────────── criteria (SUMIF/COUNTIF family) ───────────────── */
export function matchesCriteria(cell: CellValue, criterion: CellValue): boolean {
  if (criterion === null) return cell === null;
  if (typeof criterion === "number" || typeof criterion === "boolean") return cell === criterion;
  const raw = String(criterion);
  const m = /^(<=|>=|<>|=|<|>)\s*(.*)$/.exec(raw);
  const op = m ? m[1] : "=";
  const operand = m ? m[2] : raw;
  const operandNum = operand.trim() === "" ? NaN : Number(operand);
  const numeric = !Number.isNaN(operandNum) && typeof cell !== "string";
  if (numeric || (!Number.isNaN(operandNum) && typeof cell === "string" && !Number.isNaN(Number(cell)))) {
    const c = typeof cell === "number" ? cell : typeof cell === "boolean" ? (cell ? 1 : 0) : Number(cell);
    switch (op) {
      case "=": return c === operandNum;
      case "<>": return c !== operandNum;
      case "<": return c < operandNum;
      case ">": return c > operandNum;
      case "<=": return c <= operandNum;
      case ">=": return c >= operandNum;
    }
  }
  const cellText = cell === null ? "" : String(cell).toLowerCase();
  const want = operand.toLowerCase();
  // Wildcards: * = any run, ? = one char (escaped literally otherwise).
  const wildcard = /[*?]/.test(want)
    ? new RegExp(`^${want.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`)
    : null;
  const eq = wildcard ? wildcard.test(cellText) : cellText === want;
  switch (op) {
    case "=": return eq;
    case "<>": return !eq;
    case "<": return cellText < want;
    case ">": return cellText > want;
    case "<=": return cellText <= want;
    case ">=": return cellText >= want;
    default: return eq;
  }
}

/* ───────────────── TEXT number formatting (documented subset) ───────────────── */
export function formatNumber(value: number, fmt: string): string {
  if (/^(yyyy|dd|mm)/i.test(fmt) || /[dmy]{2,}/i.test(fmt)) {
    const d = serialToDate(value);
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return fmt
      .replace(/yyyy/gi, String(d.getUTCFullYear()))
      .replace(/yy/gi, pad(d.getUTCFullYear() % 100))
      .replace(/mm/gi, pad(d.getUTCMonth() + 1))
      .replace(/dd/gi, pad(d.getUTCDate()));
  }
  if (fmt.endsWith("%")) {
    const decimals = (/\.(0+)/.exec(fmt)?.[1].length) ?? 0;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  const decimals = (/\.(0+)/.exec(fmt)?.[1].length) ?? 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const grouped = fmt.includes(",") ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : int;
  return `${value < 0 ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/* ───────────────── helpers ───────────────── */
export const nums = (vals: CellValue[]) => {
  const out: number[] = [];
  for (const v of vals) {
    if (isErr(v)) throw ERR(String(v));
    if (typeof v === "number") out.push(v);
    else if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) out.push(Number(v));
  }
  return out;
};
/**
 * TT73: Excel's numeric-argument rule for SUM-family statistics (STDEV, VAR, MODE, MEDIAN, SUMSQ, DEVSQ …): inside a
 * REFERENCE or array only numbers count (text — even "2.5" — logicals and empty cells are ignored); a value typed straight
 * into the argument list is coerced (TRUE → 1, "2.5" → 2.5) and non-numeric text is #VALUE!. Errors propagate.
 * The older `nums` converted numeric text inside ranges, which disagreed with Excel on 40+ held-out cells.
 * `literalTextIsError`: MODE rejects even numeric literal text (MODE(B8,"1",2,3) = #VALUE! in Excel's cached values).
 */
export const xlNums = (args: ArgAccessor[], literalTextIsError = false): number[] => {
  const out: number[] = [];
  for (const a of args) {
    if (a.isRange) { for (const v of a.list()) { if (isErr(v)) throw ERR(String(v)); if (typeof v === "number") out.push(v); } continue; }
    const v = a.value();
    if (isErr(v)) throw ERR(String(v));
    if (typeof v === "number") out.push(v);
    else if (typeof v === "boolean") out.push(v ? 1 : 0);
    else if (typeof v === "string") { const t = v.trim(); if (literalTextIsError || t === "" || Number.isNaN(Number(t))) throw ERR("#VALUE!"); out.push(Number(t)); }
  }
  return out;
};
/** LARGE / SMALL data: numbers of a range or array; a logical typed straight in counts (LARGE(TRUE,1) = 1, POI
 *  EverythingTests G816) */
const kthSource = (a: ArgAccessor): number[] => {
  if (a.isRange) return nums(a.list());
  const l = a.list(); return l.length === 1 && typeof l[0] === "boolean" ? [l[0] ? 1 : 0] : nums(l);
};
export const need = (args: ArgAccessor[], n: number) => { if (args.length < n) throw ERR("#VALUE!"); };
export const variance = (xs: number[], sample: boolean) => {
  if (xs.length < (sample ? 2 : 1)) throw ERR("#DIV/0!");
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - (sample ? 1 : 0));
};
/** Shared engine for SUMIF/COUNTIF/AVERAGEIF. */
function conditional(args: ArgAccessor[], kind: "sum" | "count" | "average"): CellValue {
  need(args, kind === "count" ? 2 : 2);
  const range = args[0].list();
  const criterion = args[1].value();
  const target = kind === "count" ? range : (args[2] ? args[2].list() : range);
  const picked: CellValue[] = [];
  for (let i = 0; i < range.length; i++) if (matchesCriteria(range[i], criterion)) picked.push(target[i] ?? null);
  if (kind === "count") return picked.length;
  const ns = nums(picked);
  if (kind === "sum") return ns.reduce((a, b) => a + b, 0);
  if (!ns.length) throw ERR("#DIV/0!");
  return ns.reduce((a, b) => a + b, 0) / ns.length;
}

export type FnImpl = (args: ArgAccessor[], env: EvalEnv) => ResultValue;

export const FUNCTIONS: Record<string, FnImpl> = {
  /* math */
  SUM: (a) => a.flatMap((x) => x.list()).reduce<number>((s, v) => { if (isErr(v)) throw ERR(String(v)); return s + (typeof v === "number" ? v : 0); }, 0),
  PRODUCT: (a) => { const n = nums(a.flatMap((x) => x.list())); return n.length ? n.reduce((x, y) => x * y, 1) : 0; },
  ABS: (a) => Math.abs(toNum(a[0].value())),
  SIGN: (a) => Math.sign(toNum(a[0].value())),
  INT: (a) => Math.floor(toNum(a[0].value())),
  TRUNC: (a) => { const d = a[1] ? toNum(a[1].value()) : 0; const f = 10 ** d; return Math.trunc(toNum(a[0].value()) * f) / f; },
  MOD: (a) => { const d = toNum(a[1].value()); if (d === 0) throw ERR("#DIV/0!"); const n = toNum(a[0].value()); return n - d * Math.floor(n / d); },
  POWER: (a) => toNum(a[0].value()) ** toNum(a[1].value()),
  SQRT: (a) => { const n = toNum(a[0].value()); if (n < 0) throw ERR("#NUM!"); return Math.sqrt(n); },
  EXP: (a) => Math.exp(toNum(a[0].value())),
  LN: (a) => { const n = toNum(a[0].value()); if (n <= 0) throw ERR("#NUM!"); return Math.log(n); },
  LOG10: (a) => { const n = toNum(a[0].value()); if (n <= 0) throw ERR("#NUM!"); return Math.log10(n); },
  LOG: (a) => { const n = toNum(a[0].value()); const b = a[1] ? toNum(a[1].value()) : 10; if (n <= 0 || b <= 0) throw ERR("#NUM!"); return Math.log(n) / Math.log(b); },
  PI: () => Math.PI,
  ROUND: (a) => { const d = a[1] ? toNum(a[1].value()) : 0; const f = 10 ** d; const n = toNum(a[0].value()); return Math.sign(n) * Math.round(Math.abs(n) * f) / f; },
  ROUNDUP: (a) => { const d = a[1] ? toNum(a[1].value()) : 0; const f = 10 ** d; const n = toNum(a[0].value()); return Math.sign(n) * Math.ceil(Math.abs(n) * f) / f; },
  ROUNDDOWN: (a) => { const d = a[1] ? toNum(a[1].value()) : 0; const f = 10 ** d; const n = toNum(a[0].value()); return Math.sign(n) * Math.floor(Math.abs(n) * f) / f; },
  CEILING: (a) => { const s = a[1] ? toNum(a[1].value()) : 1; if (s === 0) return 0; return Math.ceil(toNum(a[0].value()) / s) * s; },
  FLOOR: (a) => { const s = a[1] ? toNum(a[1].value()) : 1; if (s === 0) throw ERR("#DIV/0!"); return Math.floor(toNum(a[0].value()) / s) * s; },
  SUMIF: (a) => conditional(a, "sum"),
  SUMPRODUCT: (a) => {
    const lists = a.map((x) => x.list());
    const len = lists[0]?.length ?? 0;
    if (lists.some((l) => l.length !== len)) throw ERR("#VALUE!");
    // TT74: an error anywhere in the arrays is the result (Excel; POI EverythingTests K1328/L1328 → #REF!)
    for (const l of lists) for (const v of l) if (isErr(v)) throw ERR(v as string);
    // TT79: when EVERY argument is a single cell the product is scalar, and text there is #VALUE! — even numeric text
    // (POI EverythingTests J1328: SUMPRODUCT(G1330:G1330, I1330:I1330) with G1330 = "4" → #VALUE! in Excel's cache)
    if (len === 1 && lists.some((l) => typeof l[0] === "string" && l[0] !== "")) throw ERR("#VALUE!");
    let total = 0;
    for (let i = 0; i < len; i++) total += lists.reduce((p, l) => p * (typeof l[i] === "number" ? (l[i] as number) : 0), 1);
    return total;
  },
  RAND: (_a, env) => env.random(),
  RANDBETWEEN: (a, env) => { const lo = toNum(a[0].value()), hi = toNum(a[1].value()); return lo + Math.floor(env.random() * (hi - lo + 1)); },

  /* statistics */
  AVERAGE: (a) => { const n = nums(a.flatMap((x) => x.list())); if (!n.length) throw ERR("#DIV/0!"); return n.reduce((x, y) => x + y, 0) / n.length; },
  AVERAGEIF: (a) => conditional(a, "average"),
  MEDIAN: (a) => {
    const n = nums(a.flatMap((x) => x.list())).sort((x, y) => x - y);
    if (!n.length) throw ERR("#NUM!");
    const mid = Math.floor(n.length / 2);
    return n.length % 2 ? n[mid] : (n[mid - 1] + n[mid]) / 2;
  },
  MIN: (a) => { const n = nums(a.flatMap((x) => x.list())); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = nums(a.flatMap((x) => x.list())); return n.length ? Math.max(...n) : 0; },
  COUNT: (a) => nums(a.flatMap((x) => x.list())).length,
  COUNTA: (a) => a.flatMap((x) => x.list()).filter((v) => v !== null && v !== "").length,
  COUNTBLANK: (a) => a.flatMap((x) => x.list()).filter((v) => v === null || v === "").length,
  COUNTIF: (a) => conditional(a, "count"),
  STDEV: (a) => Math.sqrt(variance(xlNums(a), true)),
  STDEVP: (a) => Math.sqrt(variance(xlNums(a), false)),
  VAR: (a) => variance(xlNums(a), true),
  VARP: (a) => variance(xlNums(a), false),
  LARGE: (a) => { const n = kthSource(a[0]).sort((x, y) => y - x); const k = toNum(a[1].value()); if (k < 1 || k > n.length) throw ERR("#NUM!"); return n[k - 1]; },
  SMALL: (a) => { const n = kthSource(a[0]).sort((x, y) => x - y); const k = toNum(a[1].value()); if (k < 1 || k > n.length) throw ERR("#NUM!"); return n[k - 1]; },

  /* logic — lazy where it matters */
  IF: (a) => { need(a, 2); return toBool(a[0].value()) ? a[1].value() : (a[2] ? a[2].value() : false); },
  IFS: (a) => {
    for (let i = 0; i + 1 < a.length; i += 2) if (toBool(a[i].value())) return a[i + 1].value();
    throw ERR("#N/A");
  },
  SWITCH: (a) => {
    const subject = a[0].value();
    for (let i = 1; i + 1 < a.length; i += 2) if (a[i].value() === subject) return a[i + 1].value();
    return a.length % 2 === 0 ? a[a.length - 1].value() : (() => { throw ERR("#N/A"); })();
  },
  AND: (a) => a.flatMap((x) => x.list()).every((v) => toBool(v)),
  OR: (a) => a.flatMap((x) => x.list()).some((v) => toBool(v)),
  XOR: (a) => a.flatMap((x) => x.list()).filter((v) => toBool(v)).length % 2 === 1,
  NOT: (a) => !toBool(a[0].value()),
  TRUE: () => true,
  FALSE: () => false,
  IFERROR: (a) => { try { const v = a[0].value(); return isErr(v) ? a[1].value() : v; } catch { return a[1].value(); } },
  IFNA: (a) => { try { const v = a[0].value(); return v === "#N/A" ? a[1].value() : v; } catch (e) { return e instanceof Error && e.message === "#N/A" ? a[1].value() : (() => { throw e; })(); } },
  NA: () => { throw ERR("#N/A"); },

  /* information */
  ISNUMBER: (a) => { try { return typeof a[0].value() === "number"; } catch { return false; } },
  ISTEXT: (a) => { try { const v = a[0].value(); return typeof v === "string" && !isErr(v); } catch { return false; } },
  ISBLANK: (a) => { try { const v = a[0].value(); return v === null || v === ""; } catch { return false; } },
  ISLOGICAL: (a) => { try { return typeof a[0].value() === "boolean"; } catch { return false; } },
  ISERROR: (a) => { try { return isErr(a[0].value()); } catch { return true; } },
  ISERR: (a) => { try { const v = a[0].value(); return isErr(v) && v !== "#N/A"; } catch (e) { return !(e instanceof Error && e.message === "#N/A"); } },

  /* text */
  CONCAT: (a) => a.flatMap((x) => x.list()).map((v) => toStr(v)).join(""),
  CONCATENATE: (a) => a.flatMap((x) => x.list()).map((v) => toStr(v)).join(""),
  TEXTJOIN: (a) => {
    const sep = toStr(a[0].value());
    const skipEmpty = toBool(a[1].value());
    const parts = a.slice(2).flatMap((x) => x.list()).map((v) => toStr(v));
    return (skipEmpty ? parts.filter((p) => p !== "") : parts).join(sep);
  },
  LEFT: (a) => toStr(a[0].value()).slice(0, a[1] ? Math.max(0, toNum(a[1].value())) : 1),
  RIGHT: (a) => { const n = a[1] ? Math.max(0, toNum(a[1].value())) : 1; const s = toStr(a[0].value()); return n === 0 ? "" : s.slice(-n); },
  MID: (a) => { const start = toNum(a[1].value()); if (start < 1) throw ERR("#VALUE!"); return toStr(a[0].value()).substr(start - 1, Math.max(0, toNum(a[2].value()))); },
  LEN: (a) => toStr(a[0].value()).length,
  LOWER: (a) => toStr(a[0].value()).toLowerCase(),
  UPPER: (a) => toStr(a[0].value()).toUpperCase(),
  PROPER: (a) => toStr(a[0].value()).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
  TRIM: (a) => toStr(a[0].value()).replace(/\s+/g, " ").trim(),
  REPT: (a) => { const n = toNum(a[1].value()); if (n < 0) throw ERR("#VALUE!"); return toStr(a[0].value()).repeat(Math.min(n, 10000)); },
  SUBSTITUTE: (a) => {
    const text = toStr(a[0].value()), find = toStr(a[1].value()), repl = toStr(a[2].value());
    if (find === "") return text;
    if (!a[3]) return text.split(find).join(repl);
    const which = toNum(a[3].value());
    let i = -1, count = 0;
    while ((i = text.indexOf(find, i + 1)) >= 0) { count++; if (count === which) return text.slice(0, i) + repl + text.slice(i + find.length); }
    return text;
  },
  REPLACE: (a) => {
    const text = toStr(a[0].value()), start = toNum(a[1].value()), len = toNum(a[2].value()), repl = toStr(a[3].value());
    if (start < 1) throw ERR("#VALUE!");
    return text.slice(0, start - 1) + repl + text.slice(start - 1 + len);
  },
  FIND: (a) => { const i = toStr(a[1].value()).indexOf(toStr(a[0].value()), a[2] ? toNum(a[2].value()) - 1 : 0); if (i < 0) throw ERR("#VALUE!"); return i + 1; },
  SEARCH: (a) => { const i = toStr(a[1].value()).toLowerCase().indexOf(toStr(a[0].value()).toLowerCase(), a[2] ? toNum(a[2].value()) - 1 : 0); if (i < 0) throw ERR("#VALUE!"); return i + 1; },
  EXACT: (a) => toStr(a[0].value()) === toStr(a[1].value()),
  VALUE: (a) => toNum(a[0].value()),
  CHAR: (a) => String.fromCharCode(toNum(a[0].value())),
  CODE: (a) => { const s = toStr(a[0].value()); if (!s) throw ERR("#VALUE!"); return s.charCodeAt(0); },
  TEXT: (a) => formatNumber(toNum(a[0].value()), toStr(a[1].value())),

  /* lookup & reference */
  VLOOKUP: (a) => {
    need(a, 3);
    const key = a[0].value();
    const grid = a[1].grid();
    const colIdx = toNum(a[2].value());
    const approx = a[3] ? toBool(a[3].value()) : true;
    if (colIdx < 1 || !grid.length || colIdx > grid[0].length) throw ERR("#REF!");
    let best: CellValue[] | null = null;
    for (const row of grid) {
      const probe = row[0];
      if (!approx) { if (probe === key || (typeof probe === "string" && typeof key === "string" && probe.toLowerCase() === key.toLowerCase())) return row[colIdx - 1] ?? null; continue; }
      const pn = typeof probe === "number" ? probe : Number(probe);
      const kn = typeof key === "number" ? key : Number(key);
      if (!Number.isNaN(pn) && !Number.isNaN(kn) ? pn <= kn : String(probe) <= String(key)) best = row;
    }
    if (approx && best) return best[colIdx - 1] ?? null;
    throw ERR("#N/A");
  },
  HLOOKUP: (a) => {
    need(a, 3);
    const key = a[0].value();
    const grid = a[1].grid();
    const rowIdx = toNum(a[2].value());
    if (rowIdx < 1 || rowIdx > grid.length) throw ERR("#REF!");
    const header = grid[0] ?? [];
    for (let c = 0; c < header.length; c++) {
      const probe = header[c];
      if (probe === key || (typeof probe === "string" && typeof key === "string" && probe.toLowerCase() === key.toLowerCase())) return grid[rowIdx - 1][c] ?? null;
    }
    throw ERR("#N/A");
  },
  INDEX: (a) => {
    const grid = a[0].grid();
    const r = toNum(a[1].value());
    const c = a[2] ? toNum(a[2].value()) : 1;
    if (grid.length === 1 && !a[2]) { const row = grid[0]; if (r < 1 || r > row.length) throw ERR("#REF!"); return row[r - 1] ?? null; }
    if (r < 1 || r > grid.length) throw ERR("#REF!");
    const row = grid[r - 1];
    if (c < 1 || c > row.length) throw ERR("#REF!");
    return row[c - 1] ?? null;
  },
  MATCH: (a) => {
    const key = a[0].value();
    const list = a[1].list();
    const type = a[2] ? toNum(a[2].value()) : 1;
    if (type === 0) {
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v === key || (typeof v === "string" && typeof key === "string" && v.toLowerCase() === key.toLowerCase())) return i + 1;
      }
      throw ERR("#N/A");
    }
    let best = -1;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const ok = type === 1 ? toNum(v) <= toNum(key) : toNum(v) >= toNum(key);
      if (ok) best = i;
      if (type === -1 && ok) { best = i; }
    }
    if (best < 0) throw ERR("#N/A");
    return best + 1;
  },
  CHOOSE: (a) => { const i = toNum(a[0].value()); if (i < 1 || i >= a.length) throw ERR("#VALUE!"); return a[i].value(); },
  /* TT75: a non-reference error argument (=ROWS(#REF!) after its table was deleted, =ROWS(1/0)) propagates, as in Excel */
  ROWS: (a) => { const g = a[0].grid(); if (g.length === 1 && g[0]?.length === 1 && isErr(g[0][0])) throw ERR(String(g[0][0])); return g.length; },
  COLUMNS: (a) => { const g = a[0].grid(); if (g.length === 1 && g[0]?.length === 1 && isErr(g[0][0])) throw ERR(String(g[0][0])); return g[0]?.length ?? 0; },
  ROW: (a, env) => (a.length ? a[0].grid().length && env.cursor.row : env.cursor.row),
  COLUMN: (a, env) => (a.length ? a[0].grid()[0]?.length && env.cursor.col : env.cursor.col),

  /* dates */
  TODAY: (_a, env) => dateToSerial(env.now()),
  NOW: (_a, env) => dateToSerial(env.now()) + timeFraction(env.now()),
  DATE: (a) => dateToSerial(new Date(Date.UTC(toNum(a[0].value()), toNum(a[1].value()) - 1, toNum(a[2].value())))),
  YEAR: (a) => serialToDate(toNum(a[0].value())).getUTCFullYear(),
  MONTH: (a) => serialToDate(toNum(a[0].value())).getUTCMonth() + 1,
  DAY: (a) => serialToDate(toNum(a[0].value())).getUTCDate(),
  WEEKDAY: (a) => { const d = serialToDate(toNum(a[0].value())).getUTCDay(); const type = a[1] ? toNum(a[1].value()) : 1; return type === 2 ? (d === 0 ? 7 : d) : d + 1; },
  DAYS: (a) => toNum(a[0].value()) - toNum(a[1].value()),
  EDATE: (a) => {
    const d = serialToDate(toNum(a[0].value()));
    const months = toNum(a[1].value());
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
    return dateToSerial(target);
  },
  EOMONTH: (a) => {
    const d = serialToDate(toNum(a[0].value()));
    const months = a[1] ? toNum(a[1].value()) : 0;
    return dateToSerial(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0)));
  },
};

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
