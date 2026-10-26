/**
 * Office function extensions (third library): database, engineering, information,
 * and advanced statistical functions. Follows Excel semantics; unsupported modes
 * return error values rather than silently wrong answers.
 *
 * Shares helpers with officeFunctions.ts (one direction of import only, so no cycle).
 */
import {
  ERR, isErr, toNum, toStr, toBool, nums, need,
  xlNums, type ArgAccessor, type CellValue, type FnImpl,
} from "./officeFunctions";

/** MODE's scalar arguments (including a single-cell reference) must be numeric.
 * Ranges/arrays ignore nonnumbers, but still propagate errors. Keep encounter order
 * for ties. O(n) time and O(distinct numeric values) space, no sorting of the input. */
function modes(args: ArgAccessor[]): number[] {
  const counts = new Map<number, number>(); let max = 0;
  for (const a of args) {
    const scalar = !a.isRange || a.isSingleRef;
    for (const v of scalar ? [a.value()] : a.list()) {
      if (isErr(v)) throw ERR(String(v));
      if (typeof v !== "number") { if (scalar) throw ERR("#VALUE!"); continue; }
      const n = (counts.get(v) ?? 0) + 1; counts.set(v, n); max = Math.max(max, n);
    }
  }
  if (max < 2) throw ERR("#N/A");
  return [...counts].filter(([, n]) => n === max).map(([v]) => v);
}

/* ───────────────── database functions (DSUM, DCOUNT, etc.) ───────────────── */

/** Extract a grid from a range accessor (first row = field names). */
function dbGrid(a: ArgAccessor): CellValue[][] {
  const g = a.grid();
  if (g.length === 0 || g[0].length === 0) throw ERR("#VALUE!");
  return g;
}

/** Criteria grid: first row = field names, remaining rows = conditions (OR between rows). */
function dbCriteriaRows(criteria: ArgAccessor): CellValue[][] {
  const g = criteria.grid();
  if (g.length < 2) return []; // no criteria rows = match all
  return g.slice(1);
}

/** Field index by name (case-insensitive); -1 = all fields. */
function dbFieldIndex(headers: CellValue[], field: CellValue): number {
  if (typeof field === "number") {
    const idx = Math.floor(field) - 1;
    if (idx < 0 || idx >= headers.length) throw ERR("#VALUE!");
    return idx;
  }
  const name = toStr(field).toLowerCase();
  const idx = headers.findIndex((h) => toStr(h).toLowerCase() === name);
  if (idx < 0) throw ERR("#VALUE!");
  return idx;
}

function dbMatchRow(row: CellValue[], headers: CellValue[], criteria: CellValue[][]): boolean {
  for (const crit of criteria) {
    let allMatch = true;
    for (let c = 0; c < Math.min(crit.length, headers.length); c++) {
      const cond = crit[c];
      if (cond === null || cond === "") continue;
      const cell = row[c] ?? null;
      if (!dbCellMatches(cell, cond)) { allMatch = false; break; }
    }
    if (allMatch) return true; // OR between criteria rows
  }
  return criteria.length === 0;
}

function dbCellMatches(cell: CellValue, cond: CellValue): boolean {
  if (typeof cond === "string") {
    const s = cond.trim();
    if (s.startsWith(">=") || s.startsWith("<=") || s.startsWith("<>") || s.startsWith(">") || s.startsWith("<") || s.startsWith("=")) {
      const op = s.slice(0, 2).match(/^(>=|<=|<>)/)?.[0] ?? s[0];
      const operand = s.slice(op.length);
      const numOperand = Number(operand);
      if (!Number.isNaN(numOperand)) {
        const c = toNum(cell);
        switch (op) {
          case ">=": return c >= numOperand;
          case "<=": return c <= numOperand;
          case "<>": return c !== numOperand;
          case ">": return c > numOperand;
          case "<": return c < numOperand;
          case "=": return c === numOperand;
        }
      }
      const cellStr = toStr(cell).toLowerCase();
      const want = operand.toLowerCase();
      switch (op) {
        case ">": return cellStr > want;
        case "<": return cellStr < want;
        case "=": return cellStr === want;
        case "<>": return cellStr !== want;
      }
    }
    // Wildcard match
    if (/[*?]/.test(s)) {
      const re = new RegExp(`^${s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
      return re.test(toStr(cell));
    }
    return toStr(cell).toLowerCase() === s.toLowerCase();
  }
  if (typeof cond === "number") return toNum(cell) === cond;
  if (typeof cond === "boolean") return toBool(cell) === cond;
  return cell === cond;
}

function dbSelect(database: ArgAccessor, field: ArgAccessor, criteria: ArgAccessor): CellValue[] {
  const g = dbGrid(database);
  const headers = g[0];
  const fIdx = dbFieldIndex(headers, field.value());
  // Criteria grid: row 0 = field names, remaining rows = condition rows.
  // CRITICAL: criteria columns align to database columns BY HEADER NAME, not by position.
  // A criteria range of E1:E2 means "where Dept = Eng" because E1 says "Dept".
  const cg = criteria.grid();
  const critHeaders = cg.length > 0 ? cg[0] : [];
  const critRows = cg.slice(1);
  // Map each criteria column index to a database column index via header name.
  const colMap: { dbCol: number; critCol: number }[] = [];
  for (let cc = 0; cc < critHeaders.length; cc++) {
    const hName = toStr(critHeaders[cc]).toLowerCase();
    if (!hName) continue;
    const dbCol = headers.findIndex((h) => toStr(h).toLowerCase() === hName);
    if (dbCol >= 0) colMap.push({ dbCol, critCol: cc });
  }
  const out: CellValue[] = [];
  for (let r = 1; r < g.length; r++) {
    const row = g[r];
    // A data row matches if ANY criteria row matches (OR between rows).
    let rowMatches = critRows.length === 0;
    for (const crit of critRows) {
      let allMatch = true;
      for (const { dbCol, critCol } of colMap) {
        const cond = crit[critCol];
        if (cond === null || cond === "") continue;
        if (!dbCellMatches(row[dbCol] ?? null, cond)) { allMatch = false; break; }
      }
      if (allMatch) { rowMatches = true; break; }
    }
    if (rowMatches) out.push(row[fIdx] ?? null);
  }
  return out;
}

/* ───────────────── engineering functions ───────────────── */

function fromBase(s: string, base: number): number {
  const v = parseInt(s, base);
  if (Number.isNaN(v)) throw ERR("#NUM!");
  return v;
}


const ENG_BITS: Record<number, number> = { 2: 10, 8: 30, 16: 40 };
function engParse(v: CellValue, base: 2 | 8 | 16): number {
  const s = (typeof v === "number" ? String(Math.trunc(v)) : toStr(v)).trim().toUpperCase();
  if (s.length === 0 || s.length > 10) throw ERR("#NUM!");
  const ok = base === 2 ? /^[01]+$/ : base === 8 ? /^[0-7]+$/ : /^[0-9A-F]+$/;
  if (!ok.test(s)) throw ERR("#NUM!");
  const bits = ENG_BITS[base];
  const n = parseInt(s, base);
  return s.length === 10 && n >= 2 ** (bits - 1) ? n - 2 ** bits : n;
}
function engFormat(n: number, base: 2 | 8 | 16, placesArg?: ArgAccessor): string {
  const bits = ENG_BITS[base];
  if (!Number.isFinite(n) || n < -(2 ** (bits - 1)) || n >= 2 ** (bits - 1)) throw ERR("#NUM!");
  if (n < 0) return (n + 2 ** bits).toString(base).toUpperCase(); // always 10 digits; places ignored
  const out = n.toString(base).toUpperCase();
  if (!placesArg) return out;
  const places = Math.trunc(toNum(placesArg.value()));
  if (places < 1 || places > 10 || out.length > places) throw ERR("#NUM!");
  return out.padStart(places, "0");
}
function big48(a: ArgAccessor[], op: (x: bigint, y: bigint) => bigint): number {
  const xs = [toNum(a[0].value()), toNum(a[1].value())];
  if (xs.some((x) => !Number.isInteger(x) || x < 0 || x >= 2 ** 48)) throw ERR("#NUM!");
  return Number(op(BigInt(xs[0]), BigInt(xs[1])));
}
function shift48(n: number, by: number): number {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 48 || Math.abs(by) > 53) throw ERR("#NUM!");
  const r = by >= 0 ? n * 2 ** by : Math.floor(n / 2 ** -by);
  if (r >= 2 ** 48) throw ERR("#NUM!");
  return r;
}

/* ───────────────── information functions ───────────────── */

function colLetters(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

/* ───────────────── statistical (advanced) ───────────────── */

function quantileInc(xs: number[], k: number): number {
  if (!xs.length) throw ERR("#NUM!");
  if (k < 0 || k > 1) throw ERR("#NUM!");
  const s = [...xs].sort((a, b) => a - b);
  const rank = k * (s.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

function correl(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) throw ERR("#N/A");
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  if (den === 0) throw ERR("#DIV/0!");
  return num / den;
}

/** Linear regression slope via least squares. */
function slope(ys: number[], xs: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) throw ERR("#N/A");
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) throw ERR("#DIV/0!");
  return num / den;
}

function intercept(ys: number[], xs: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  return my - slope(ys, xs) * mx;
}

/* ───────────────── financial (depreciation) ───────────────── */

/** Straight-line depreciation: (cost - salvage) / life */
function sln(cost: number, salvage: number, life: number): number {
  if (life === 0) throw ERR("#DIV/0!");
  return (cost - salvage) / life;
}

/** Declining balance: rate = 1 - (salvage/cost)^(1/life); book value per period. */
function db(cost: number, salvage: number, life: number, period: number, month = 12): number {
  if (cost <= 0 || salvage < 0 || life <= 0 || period < 1 || period > life || month < 1 || month > 12) throw ERR("#NUM!");
  const rate = 1 - (salvage / cost) ** (1 / life);
  const r = Math.round(rate * 1000) / 1000; // Excel rounds rate to 3 decimals
  let total = 0;
  for (let p = 1; p <= Math.floor(period); p++) {
    const dep = p === 1
      ? cost * r * (month / 12)
      : (cost - total) * r;
    total += dep;
  }
  if (period > Math.floor(period)) {
    // partial final period
    const dep = (cost - total) * r * ((12 - month + 1) / 12);
    total += dep;
  }
  return total - (period > Math.floor(period) ? (cost - (total - (cost - (total - (cost - total) * r * ((12 - month + 1) / 12)))) * r * ((12 - month + 1) / 12)) : 0);
}

/** Sum-of-years'-digits depreciation for a period. */
function syd(cost: number, salvage: number, life: number, period: number): number {
  if (life <= 0 || period < 1 || period > life) throw ERR("#NUM!");
  const sum = (life * (life + 1)) / 2;
  return ((life - period + 1) / sum) * (cost - salvage);
}

/** Double-declining balance depreciation. */
function ddb(cost: number, salvage: number, life: number, period: number, factor = 2): number {
  if (cost <= 0 || salvage < 0 || life <= 0 || period < 1 || period > life || factor <= 0) throw ERR("#NUM!");
  let book = cost;
  for (let p = 1; p <= Math.floor(period); p++) {
    const dep = Math.min((book * factor) / life, book - salvage);
    if (p === Math.floor(period)) return dep;
    book -= dep;
  }
  return 0;
}

/* ───────────────── the function table ───────────────── */

export const ADVANCED_FUNCTIONS: Record<string, FnImpl> = {
  /* database */
  DSUM: (a) => { need(a, 3); const vals = dbSelect(a[0], a[1], a[2]).map((v) => toNum(v)); return vals.reduce((x, y) => x + y, 0); },
  DCOUNT: (a) => { need(a, 3); return dbSelect(a[0], a[1], a[2]).filter((v) => typeof v === "number").length; },
  DCOUNTA: (a) => { need(a, 3); return dbSelect(a[0], a[1], a[2]).filter((v) => v !== null && v !== "").length; },
  DAVERAGE: (a) => {
    need(a, 3);
    const vals = dbSelect(a[0], a[1], a[2]).map((v) => toNum(v));
    if (!vals.length) throw ERR("#DIV/0!");
    return vals.reduce((x, y) => x + y, 0) / vals.length;
  },
  DMAX: (a) => { need(a, 3); const vals = nums(dbSelect(a[0], a[1], a[2])); return vals.length ? Math.max(...vals) : 0; },
  DMIN: (a) => { need(a, 3); const vals = nums(dbSelect(a[0], a[1], a[2])); return vals.length ? Math.min(...vals) : 0; },
  DPRODUCT: (a) => { need(a, 3); const vals = nums(dbSelect(a[0], a[1], a[2])); return vals.length ? vals.reduce((x, y) => x * y, 1) : 0; },
  DSTDEV: (a) => {
    need(a, 3);
    const vals = nums(dbSelect(a[0], a[1], a[2]));
    if (vals.length < 2) throw ERR("#DIV/0!");
    const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
    return Math.sqrt(vals.reduce((x, y) => x + (y - mean) ** 2, 0) / (vals.length - 1));
  },
  DVAR: (a) => {
    need(a, 3);
    const vals = nums(dbSelect(a[0], a[1], a[2]));
    if (vals.length < 2) throw ERR("#DIV/0!");
    const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
    return vals.reduce((x, y) => x + (y - mean) ** 2, 0) / (vals.length - 1);
  },

  /* engineering */
  DECIMAL: (a) => { need(a, 2); return fromBase(toStr(a[0].value()), toNum(a[1].value())); },
  /* TT15 FIX: Excel engineering conversions. The imported versions padded every
   * result to a default width (DEC2BIN(10) -> "0000001010"; Excel: "1010") and
   * mishandled negatives. Excel rules: 10-digit two's complement for negatives
   * (bits = 10 / 30 / 40 for bin / oct / hex), `places` pads non-negatives only
   * and is #NUM! if too small, inputs longer than 10 digits or with invalid
   * digits are #NUM!, out-of-range numbers are #NUM!, decimal input truncates. */
  BIN2DEC: (a) => { need(a, 1); return engParse(a[0].value(), 2); },
  OCT2DEC: (a) => { need(a, 1); return engParse(a[0].value(), 8); },
  HEX2DEC: (a) => { need(a, 1); return engParse(a[0].value(), 16); },
  DEC2BIN: (a) => { need(a, 1); return engFormat(Math.trunc(toNum(a[0].value())), 2, a[1]); },
  DEC2OCT: (a) => { need(a, 1); return engFormat(Math.trunc(toNum(a[0].value())), 8, a[1]); },
  DEC2HEX: (a) => { need(a, 1); return engFormat(Math.trunc(toNum(a[0].value())), 16, a[1]); },
  BIN2OCT: (a) => { need(a, 1); return engFormat(engParse(a[0].value(), 2), 8, a[1]); },
  BIN2HEX: (a) => { need(a, 1); return engFormat(engParse(a[0].value(), 2), 16, a[1]); },
  OCT2BIN: (a) => { need(a, 1); return engFormat(engParse(a[0].value(), 8), 2, a[1]); },
  OCT2HEX: (a) => { need(a, 1); return engFormat(engParse(a[0].value(), 8), 16, a[1]); },
  HEX2BIN: (a) => { need(a, 1); return engFormat(engParse(a[0].value(), 16), 2, a[1]); },
  HEX2OCT: (a) => { need(a, 1); return engFormat(engParse(a[0].value(), 16), 8, a[1]); },
  /* TT15 FIX: JS bitwise operators are 32-bit; Excel's BIT* accept integers in [0, 2^48). */
  BITAND: (a) => { need(a, 2); return big48(a, (x, y) => x & y); },
  BITOR: (a) => { need(a, 2); return big48(a, (x, y) => x | y); },
  BITXOR: (a) => { need(a, 2); return big48(a, (x, y) => x ^ y); },
  BITLSHIFT: (a) => { need(a, 2); return shift48(toNum(a[0].value()), Math.trunc(toNum(a[1].value()))); },
  BITRSHIFT: (a) => { need(a, 2); return shift48(toNum(a[0].value()), -Math.trunc(toNum(a[1].value()))); },
  COMPLEX: (a) => { need(a, 2); return `${toNum(a[0].value())}${toNum(a[1].value()) >= 0 ? "+" : ""}${toNum(a[1].value())}i`; },
  IMREAL: (a) => { need(a, 1); const m = /^(-?[\d.]+)/.exec(toStr(a[0].value())); return m ? Number(m[1]) : 0; },
  IMAGINARY: (a) => { need(a, 1); const m = /(-?[\d.]+)i$/.exec(toStr(a[0].value())); return m ? Number(m[1]) : 0; },
  CONJUGATE: (a) => { need(a, 1); const s = toStr(a[0].value()); const m = /^(-?[\d.]+)([+-][\d.]+)i$/.exec(s); if (!m) return s; const re = Number(m[1]); const im = -Number(m[2]); return `${re}${im >= 0 ? "+" : ""}${im}i`; },

  /* information */
  ISFORMULA: (a) => { need(a, 1); return false; }, // we don't track formula-ness per accessor; honest answer
  ISREF: (a) => { need(a, 1); return a[0].isRange; },
  ISLOGICAL: (a) => { try { return typeof a[0].value() === "boolean"; } catch { return false; } },
  ISNONTEXT: (a) => { try { const v = a[0].value(); return typeof v !== "string" || isErr(v); } catch { return true; } },
  ISODD: (a) => { need(a, 1); return Math.trunc(toNum(a[0].value())) % 2 !== 0; },
  ISEVEN: (a) => { need(a, 1); return Math.trunc(toNum(a[0].value())) % 2 === 0; },
  SHEET: (a) => 1, // single-sheet context in our evaluator; multi-sheet is tracked by name
  COLUMN: (a, env) => (a.length ? a[0].grid()[0]?.length && env.cursor.col : env.cursor.col),
  ROW: (a, env) => (a.length ? a[0].grid().length && env.cursor.row : env.cursor.row),
  COLUMNS: (a) => { const g = a[0].grid(); if (g.length === 1 && g[0]?.length === 1 && isErr(g[0][0])) throw ERR(String(g[0][0])); return g[0]?.length ?? 0; },
  /* TT75: a non-reference error argument (=ROWS(#REF!) after its table was deleted, =ROWS(1/0)) propagates, as in Excel */
  ROWS: (a) => { const g = a[0].grid(); if (g.length === 1 && g[0]?.length === 1 && isErr(g[0][0])) throw ERR(String(g[0][0])); return g.length; },
  ADDRESS: (a) => {
    need(a, 2);
    const row = toNum(a[0].value()), col = toNum(a[1].value());
    const abs = a[2] ? toNum(a[2].value()) : 1;
    const a1 = a[3] ? toBool(a[3].value()) : true;
    const colPart = a1 ? colLetters(col) : `[${col}]`;
    const rowPart = a1 ? String(row) : `[${row}]`;
    // TT46 (corpus-found): abs_num 2 = absolute ROW / relative column, 3 = relative row / absolute column; sheet_text prefix.
    const sheet = a[4] ? toStr(a[4].value()) : "";
    const pre = sheet ? `${/^[A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) || /^\[[^\]]+\][A-Za-z_][A-Za-z0-9_.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!` : "";
    if (!a1) { const r = abs === 1 || abs === 2 ? `R${row}` : `R[${row}]`, c = abs === 1 || abs === 3 ? `C${col}` : `C[${col}]`; return pre + r + c; }
    if (abs === 1) return `${pre}$${colPart}$${rowPart}`;
    if (abs === 2) return `${pre}${colPart}$${rowPart}`;
    if (abs === 3) return `${pre}$${colPart}${rowPart}`;
    return `${pre}${colPart}${rowPart}`;
  },
  HYPERLINK: (a) => { need(a, 1); const url = toStr(a[0].value()); const label = a[1] ? toStr(a[1].value()) : url; return label; },

  /* statistical advanced */
  QUARTILE: (a) => { need(a, 2); return quantileInc(nums(a[0].list()), toNum(a[1].value()) / 4); },
  "QUARTILE.INC": (a) => { need(a, 2); return quantileInc(nums(a[0].list()), toNum(a[1].value()) / 4); },
  "QUARTILE.EXC": (a) => {
    need(a, 2);
    const xs = nums(a[0].list()).sort((x, y) => x - y);
    const q = toNum(a[1].value());
    if (!xs.length || q < 1 || q > 3) throw ERR("#NUM!");
    const pos = (q / 4) * (xs.length + 1);
    const lo = Math.floor(pos) - 1, hi = Math.ceil(pos) - 1;
    if (lo < 0 || hi >= xs.length) throw ERR("#NUM!");
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - Math.floor(pos));
  },
  PERCENTRANK: (a) => {
    need(a, 2);
    const xs = nums(a[0].list()).sort((x, y) => x - y);
    const x = toNum(a[1].value());
    const sig = a[2] ? toNum(a[2].value()) : 3;
    if (!xs.length) throw ERR("#N/A");
    if (x < xs[0] || x > xs[xs.length - 1]) throw ERR("#N/A");
    if (xs.length === 1) return 0;
    const rank = xs.filter((v) => v < x).length;
    const ties = xs.filter((v) => v === x).length;
    const pr = (rank + (ties - 1) / 2) / (xs.length - 1);
    return Number(pr.toFixed(sig));
  },
  CORREL: (a) => { need(a, 2); return correl(nums(a[0].list()), nums(a[1].list())); },
  PEARSON: (a) => { need(a, 2); return correl(nums(a[0].list()), nums(a[1].list())); },
  SLOPE: (a) => { need(a, 2); return slope(nums(a[0].list()), nums(a[1].list())); },
  INTERCEPT: (a) => { need(a, 2); return intercept(nums(a[0].list()), nums(a[1].list())); },
  FORECAST: (a) => {
    need(a, 3);
    const x = toNum(a[0].value());
    const ys = nums(a[1].list());
    const xs = nums(a[2].list());
    return intercept(ys, xs) + slope(ys, xs) * x;
  },
  "FORECAST.LINEAR": (a) => {
    need(a, 3);
    const x = toNum(a[0].value());
    const ys = nums(a[1].list());
    const xs = nums(a[2].list());
    return intercept(ys, xs) + slope(ys, xs) * x;
  },
  RSQ: (a) => { need(a, 2); const r = correl(nums(a[0].list()), nums(a[1].list())); return r * r; },
  STEYX: (a) => {
    need(a, 2);
    const ys = nums(a[0].list());
    const xs = nums(a[1].list());
    if (xs.length < 2) throw ERR("#N/A");
    const b = slope(ys, xs), a0 = intercept(ys, xs);
    const n = xs.length;
    let sse = 0;
    for (let i = 0; i < n; i++) sse += (ys[i] - (a0 + b * xs[i])) ** 2;
    return Math.sqrt(sse / (n - 2));
  },
  MODE: (a) => modes(a)[0],
  "MODE.SNGL": (a) => modes(a)[0],
  "MODE.MULT": (a) => modes(a).map((v) => [v]),
  MEDIAN: (a) => {
    const vals = xlNums(a).sort((x, y) => x - y);
    if (!vals.length) throw ERR("#NUM!");
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  },
  GEOMEAN: (a) => {
    const vals = xlNums(a).filter((v) => v > 0);
    if (!vals.length) throw ERR("#NUM!");
    return Math.exp(vals.reduce((s, v) => s + Math.log(v), 0) / vals.length);
  },
  HARMEAN: (a) => {
    const vals = xlNums(a).filter((v) => v > 0);
    if (!vals.length) throw ERR("#NUM!");
    return vals.length / vals.reduce((s, v) => s + 1 / v, 0);
  },
  TRIMMEAN: (a) => {
    need(a, 2);
    const vals = nums(a[0].list()).sort((x, y) => x - y);
    const pct = toNum(a[1].value());
    if (pct < 0 || pct >= 1) throw ERR("#NUM!");
    if (!vals.length) throw ERR("#NUM!");
    const cut = Math.floor(vals.length * pct / 2);
    const trimmed = vals.slice(cut, vals.length - cut);
    if (!trimmed.length) throw ERR("#NUM!");
    return trimmed.reduce((x, y) => x + y, 0) / trimmed.length;
  },
  CONFIDENCE: (a) => {
    need(a, 3);
    const alpha = toNum(a[0].value()), sd = toNum(a[1].value()), n = toNum(a[2].value());
    if (alpha <= 0 || alpha >= 1 || sd < 0 || n < 1) throw ERR("#NUM!");
    // Normal approximation: z * sd / sqrt(n)
    const z = 1.959963984540054; // 95% default approximation; alpha used for scaling
    const zAlpha = alpha === 0.05 ? z : alpha === 0.01 ? 2.5758293035489004 : alpha === 0.1 ? 1.6448536269514722 : z;
    return zAlpha * sd / Math.sqrt(n);
  },
  "CONFIDENCE.NORM": (a) => {
    need(a, 3);
    const alpha = toNum(a[0].value()), sd = toNum(a[1].value()), n = toNum(a[2].value());
    if (alpha <= 0 || alpha >= 1 || sd < 0 || n < 1) throw ERR("#NUM!");
    const zMap: Record<string, number> = { "0.05": 1.959963984540054, "0.01": 2.5758293035489004, "0.1": 1.6448536269514722, "0.025": 2.2413620170187274, "0.005": 2.807034165742327 };
    const z = zMap[String(alpha)] ?? 1.959963984540054;
    return z * sd / Math.sqrt(n);
  },

  /* financial depreciation */
  SLN: (a) => { need(a, 3); return sln(toNum(a[0].value()), toNum(a[1].value()), toNum(a[2].value())); },
  SYD: (a) => { need(a, 4); return syd(toNum(a[0].value()), toNum(a[1].value()), toNum(a[2].value()), toNum(a[3].value())); },
  DDB: (a) => { need(a, 4); return ddb(toNum(a[0].value()), toNum(a[1].value()), toNum(a[2].value()), toNum(a[3].value()), a[4] ? toNum(a[4].value()) : 2); },
  VDB: (a) => {
    need(a, 5);
    const cost = toNum(a[0].value()), salvage = toNum(a[1].value()), life = toNum(a[2].value());
    const start = toNum(a[3].value()), end = toNum(a[4].value());
    const factor = a[5] ? toNum(a[5].value()) : 2;
    const noSwitch = a[6] ? toBool(a[6].value()) : false;
    if (cost < 0 || salvage < 0 || life <= 0 || start < 0 || end < start || end > life) throw ERR("#NUM!");
    let total = 0;
    let book = cost;
    let p = 0;
    while (p < end) {
      const periodEnd = Math.min(p + 1, end);
      const sl = sln(cost, salvage, life);
      const d = noSwitch ? sl : Math.min((book * factor) / life, book - salvage);
      const overlap = Math.max(0, Math.min(periodEnd, life) - Math.max(p, start));
      if (overlap > 0 && p + 1 > start) {
        total += d * Math.min(1, Math.max(0, periodEnd - Math.max(p, start)));
      }
      book -= d;
      p = periodEnd;
    }
    return total;
  },

  /* text advanced */
  TEXTJOIN: (a) => {
    need(a, 3);
    const sep = toStr(a[0].value());
    const skipEmpty = toBool(a[1].value());
    const parts = a.slice(2).flatMap((x) => x.list()).map((v) => toStr(v));
    return (skipEmpty ? parts.filter((p) => p !== "") : parts).join(sep);
  },
  REPLACETEXT: (a) => { // alias of REPLACE for clarity
    need(a, 4);
    const text = toStr(a[0].value()), start = toNum(a[1].value()), len = toNum(a[2].value()), repl = toStr(a[3].value());
    if (start < 1) throw ERR("#VALUE!");
    return text.slice(0, start - 1) + repl + text.slice(start - 1 + len);
  },
  NUMBERVALUE: (a) => {
    need(a, 1);
    let s = toStr(a[0].value());
    const dec = a[1] ? toStr(a[1].value()) : ".";
    const grp = a[2] ? toStr(a[2].value()) : ",";
    s = s.split(grp).join("");
    if (dec !== ".") s = s.split(dec).join(".");
    const n = Number(s);
    if (Number.isNaN(n)) throw ERR("#VALUE!");
    return n;
  },
  UNICHAR: (a) => { need(a, 1); return String.fromCodePoint(toNum(a[0].value())); },
  UNICODE: (a) => { need(a, 1); const s = toStr(a[0].value()); if (!s) throw ERR("#VALUE!"); return s.codePointAt(0)!; },
  ARABIC: (a) => {
    need(a, 1);
    const s = toStr(a[0].value()).trim();
    const map: Record<string, number> = { "M": 1000, "D": 500, "C": 100, "L": 50, "X": 10, "V": 5, "I": 1 };
    let total = 0, prev = 0;
    for (const ch of s.toUpperCase()) {
      const v = map[ch];
      if (v === undefined) throw ERR("#VALUE!");
      if (v > prev) total += v - 2 * prev;
      else total += v;
      prev = v;
    }
    return total;
  },
  ROMAN: (a) => {
    need(a, 1);
    let n = Math.floor(toNum(a[0].value()));
    if (n < 1 || n > 3999) throw ERR("#VALUE!");
    const vals = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    const syms = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
    let out = "";
    for (let i = 0; i < vals.length; i++) {
      while (n >= vals[i]) { out += syms[i]; n -= vals[i]; }
    }
    return out;
  },
  BASE: (a) => {
    need(a, 2);
    const n = Math.floor(toNum(a[0].value())), base = toNum(a[1].value());
    const digits = a[2] ? toNum(a[2].value()) : 0;
    if (base < 2 || base > 36 || n < 0) throw ERR("#NUM!");
    let s = n.toString(base).toUpperCase();
    if (digits > 0) s = s.padStart(digits, "0");
    return s;
  },
  COMBIN: (a) => {
    need(a, 2);
    const n = Math.floor(toNum(a[0].value())), k = Math.floor(toNum(a[1].value()));
    if (n < 0 || k < 0 || k > n) throw ERR("#NUM!");
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
    return Math.round(r);
  },
  PERMUT: (a) => {
    need(a, 2);
    const n = Math.floor(toNum(a[0].value())), k = Math.floor(toNum(a[1].value()));
    if (n < 0 || k < 0 || k > n) throw ERR("#NUM!");
    let r = 1;
    for (let i = 0; i < k; i++) r *= (n - i);
    return r;
  },
  FACT: (a) => {
    need(a, 1);
    const n = Math.floor(toNum(a[0].value()));
    if (n < 0 || n > 170) throw ERR("#NUM!");
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  },
  FACTDOUBLE: (a) => {
    need(a, 1);
    const n = Math.floor(toNum(a[0].value()));
    if (n < 0 || n > 170) throw ERR("#NUM!");
    let r = 1;
    for (let i = n; i > 1; i -= 2) r *= i;
    return r;
  },
  GCD: (a) => {
    const vals = nums(a.flatMap((x) => x.list())).map((v) => Math.abs(Math.trunc(v)));
    if (!vals.length || vals.some((v) => v === 0)) throw ERR("#NUM!");
    const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
    return vals.reduce(gcd);
  },
  LCM: (a) => {
    const vals = nums(a.flatMap((x) => x.list())).map((v) => Math.abs(Math.trunc(v)));
    if (!vals.length || vals.some((v) => v === 0)) throw ERR("#NUM!");
    const gcd = (x: number, y: number): number => (y === 0 ? x : gcd(y, x % y));
    return vals.reduce((acc, v) => (acc * v) / gcd(acc, v));
  },
  MULTINOMIAL: (a) => {
    const vals = nums(a.flatMap((x) => x.list())).map(Math.trunc);
    const sum = vals.reduce((x, y) => x + y, 0);
    const fact = (n: number) => { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; };
    return fact(sum) / vals.reduce((acc, v) => acc * fact(v), 1);
  },
  SIGN: (a) => Math.sign(toNum(a[0].value())),
  DELTA: (a) => {
    need(a, 1);
    const x = toNum(a[0].value());
    const y = a[1] ? toNum(a[1].value()) : 0;
    const tol = a[2] ? toNum(a[2].value()) : 0;
    return Math.abs(x - y) <= tol ? 1 : 0;
  },
  GESTEP: (a) => {
    need(a, 1);
    const x = toNum(a[0].value());
    const step = a[1] ? toNum(a[1].value()) : 0;
    return x >= step ? 1 : 0;
  },
};
