/**
 * Office function extensions (second library): multi-criteria conditionals, XLOOKUP, financial,
 * date-arithmetic and text-splitting functions. Each follows the Excel semantics documented by
 * Microsoft; where a mode is not implemented the function returns an error value instead of a
 * silently wrong answer (binary-search modes of XLOOKUP are the honest example).
 *
 * Shares helpers with officeFunctions.ts (one direction of import only, so no cycle).
 */
import { type ResultValue,
  ERR, isErr, toNum, toStr, matchesCriteria, serialToDate, nums, need, variance,
  xlNums, type ArgAccessor, type CellValue, type FnImpl,
} from "./officeFunctions";

/* ───────────────── multi-criteria conditionals ───────────────── */

/** Boolean mask over `len` rows from criteria pairs starting at argument index `start`. */
function criteriaMask(args: ArgAccessor[], start: number): { len: number; mask: boolean[] } {
  if (args.length <= start || (args.length - start) % 2 !== 0) throw ERR("#VALUE!");
  let len = -1;
  const ranges: CellValue[][] = [];
  const crits: CellValue[] = [];
  for (let i = start; i < args.length; i += 2) {
    const r = args[i].list();
    if (len < 0) len = r.length;
    if (r.length !== len) throw ERR("#VALUE!");
    ranges.push(r);
    crits.push(args[i + 1].value());
  }
  const mask = new Array<boolean>(len).fill(true);
  for (let k = 0; k < ranges.length; k++) {
    for (let i = 0; i < len; i++) if (mask[i] && !matchesCriteria(ranges[k][i], crits[k])) mask[i] = false;
  }
  return { len, mask };
}

const pickMasked = (values: CellValue[], mask: boolean[]) => values.filter((_, i) => mask[i]);

/* ───────────────── XLOOKUP ───────────────── */

/**
 * XLOOKUP(lookup, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])
 * match_mode: 0 exact (default), -1 exact or next smaller, 1 exact or next larger, 2 wildcard.
 * search_mode: 1 first-to-last (default), -1 last-to-first. 2/-2 (binary search) are NOT implemented
 * and return #VALUE! rather than a possibly-different answer.
 */
/** TT74: full XLOOKUP. lookup_array is one row or one column; the result is the matching row (column lookup) or column
 *  (row lookup) of return_array, so a multi-column return spills. match_mode 0 exact, -1 exact-or-next-smaller,
 *  1 exact-or-next-larger, 2 wildcard; search_mode 1 first→last, -1 last→first, 2/-2 binary search over ascending /
 *  descending data. Ordering across types: numbers < text (case-insensitive) < logicals. */
function xlookup(a: ArgAccessor[]): ResultValue {
  need(a, 3);
  if (a.length > 6) throw ERR("#VALUE!");
  const key = a[0].value();
  if (isErr(key as CellValue)) throw ERR(String(key));
  const lg = a[1].grid(), rg = a[2].grid();
  const byRow = lg.length === 1 && (lg[0]?.length ?? 0) > 1; // a horizontal lookup vector
  if (!byRow && lg.some((r) => r.length !== 1)) throw ERR("#VALUE!");
  const lookup: CellValue[] = byRow ? lg[0] : lg.map((r) => r[0]);
  const n = lookup.length;
  if (!n || (byRow ? (rg[0]?.length ?? 0) !== n : rg.length !== n)) throw ERR("#VALUE!");
  const matchMode = a[4] && a[4].value() !== null ? toNum(a[4].value()) : 0;
  const searchMode = a[5] && a[5].value() !== null ? toNum(a[5].value()) : 1;
  if (![-1, 0, 1, 2].includes(matchMode) || ![-2, -1, 1, 2].includes(searchMode)) throw ERR("#VALUE!");
  if (matchMode === 2 && Math.abs(searchMode) === 2) throw ERR("#VALUE!");
  const rank = (v: CellValue) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3);
  const cmp = (x: CellValue, y: CellValue): number => {
    const d = rank(x) - rank(y); if (d) return d;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "string" && typeof y === "string") { const p = x.toLowerCase(), q = y.toLowerCase(); return p < q ? -1 : p > q ? 1 : 0; }
    if (typeof x === "boolean" && typeof y === "boolean") return Number(x) - Number(y);
    return 0;
  };
  const k: CellValue = key === null ? "" : key;
  let found = -1;
  if (Math.abs(searchMode) === 2) {
    // binary search; desc flips the comparison so the same loop serves both orders
    const sgn = searchMode === 2 ? 1 : -1;
    let lo = 0, hi = n - 1, le = -1, ge = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1; const c = sgn * cmp(lookup[mid] ?? "", k);
      if (c === 0) { found = mid; break; }
      if (c < 0) { le = mid; lo = mid + 1; } else { ge = mid; hi = mid - 1; }
    }
    if (found < 0 && matchMode === -1) found = sgn === 1 ? le : ge;
    if (found < 0 && matchMode === 1) found = sgn === 1 ? ge : le;
    // Excel returns the binary search's landing position as is, even when it is a different type (POI xlookup.xlsx
    // Sheet2!F2: next-larger over 9700,"xyz","xyz",160726… lands on "xyz" → 0.22)
  } else {
    const order = lookup.map((_, i) => i); if (searchMode === -1) order.reverse();
    if (matchMode === 2) { for (const i of order) if (matchesCriteria(lookup[i], key)) { found = i; break; } }
    else {
      for (const i of order) if (lookup[i] !== null && cmp(lookup[i], k) === 0) { found = i; break; }
      if (found < 0 && matchMode !== 0) {
        let best = -1;
        for (const i of order) {
          const v = lookup[i]; if (v === null || rank(v) !== rank(k)) continue;
          const c = cmp(v, k);
          if (matchMode === -1 ? c < 0 && (best < 0 || cmp(v, lookup[best]) > 0) : c > 0 && (best < 0 || cmp(v, lookup[best]) < 0)) best = i;
        }
        found = best;
      }
    }
  }
  if (found < 0) {
    if (a[3] !== undefined) { const g = a[3].grid(); return g.length === 1 && g[0].length === 1 ? g[0][0] : g; }
    throw ERR("#N/A");
  }
  const z = (v: CellValue) => (v === null ? 0 : v);
  const out: CellValue[][] = byRow ? rg.map((r) => [z(r[found])]) : [rg[found].map(z)];
  return out.length === 1 && out[0].length === 1 ? out[0][0] : out;
}

/* ───────────────── financial (Excel sign convention: outflows negative) ───────────────── */

const isZeroRate = (r: number) => Math.abs(r) < 1e-12;

export function PMT(rate: number, nper: number, pv: number, fv = 0, type = 0): number {
  if (nper === 0) throw ERR("#NUM!");
  if (isZeroRate(rate)) return -(pv + fv) / nper;
  const g = (1 + rate) ** nper;
  return -(rate * (pv * g + fv)) / ((1 + rate * type) * (g - 1));
}
export function FV(rate: number, nper: number, pmt: number, pv = 0, type = 0): number {
  if (isZeroRate(rate)) return -(pv + pmt * nper);
  const g = (1 + rate) ** nper;
  return -(pv * g + pmt * (1 + rate * type) * (g - 1) / rate);
}
export function PV(rate: number, nper: number, pmt: number, fv = 0, type = 0): number {
  if (isZeroRate(rate)) return -(fv + pmt * nper);
  const g = (1 + rate) ** nper;
  return -(pmt * (1 + rate * type) * (g - 1) / rate + fv) / g;
}
/** NPV: discounts the first value by one period (Excel convention), unlike a t=0 cash flow. */
export function NPV(rate: number, values: number[]): number {
  return values.reduce((acc, v, i) => acc + v / (1 + rate) ** (i + 1), 0);
}
/** IRR by Newton iteration from `guess`; #NUM! when the flows have no sign change or do not converge. */
export function IRR(values: number[], guess = 0.1): number {
  if (!(values.some((v) => v > 0) && values.some((v) => v < 0))) throw ERR("#NUM!");
  let r = guess;
  for (let it = 0; it < 200; it++) {
    let f = 0, df = 0;
    values.forEach((v, t) => { f += v / (1 + r) ** t; df += -t * v / (1 + r) ** (t + 1); });
    if (Math.abs(f) < 1e-11) return r;
    if (df === 0) break;
    const next = r - f / df;
    if (!Number.isFinite(next) || next <= -1) break;
    r = next;
  }
  throw ERR("#NUM!");
}

/* ───────────────── dates (serial system from officeFunctions) ───────────────── */

function ymd(serial: number) {
  const d = serialToDate(serial);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** DATEDIF(start, end, unit) with the documented units; end before start is #NUM!. */
export function datedif(start: number, end: number, unit: string): number {
  if (end < start) throw ERR("#NUM!");
  const s = ymd(start), e = ymd(end);
  switch (unit.toUpperCase()) {
    case "Y": { let y = e.y - s.y; if (e.m < s.m || (e.m === s.m && e.d < s.d)) y -= 1; return y; }
    case "M": { let m = (e.y - s.y) * 12 + (e.m - s.m); if (e.d < s.d) m -= 1; return m; }
    case "D": return Math.floor(end) - Math.floor(start);
    case "MD": {
      if (e.d >= s.d) return e.d - s.d;
      const pm = e.m === 1 ? 12 : e.m - 1, py = e.m === 1 ? e.y - 1 : e.y;
      return daysInMonth(py, pm) - s.d + e.d;
    }
    case "YM": { let m = e.m - s.m; if (e.d < s.d) m -= 1; return ((m % 12) + 12) % 12; }
    case "YD": {
      let anniv = Date.UTC(e.y, s.m - 1, s.d);
      if (anniv > Date.UTC(e.y, e.m - 1, e.d)) anniv = Date.UTC(e.y - 1, s.m - 1, s.d);
      return Math.round((Date.UTC(e.y, e.m - 1, e.d) - anniv) / 86_400_000);
    }
    default: throw ERR("#NUM!");
  }
}

const isWeekday = (serial: number) => { const wd = serialToDate(serial).getUTCDay(); return wd !== 0 && wd !== 6; };

/** Inclusive weekday count between two serials; a reversed range gives a negative count (Excel). */
function networkdays(start: number, end: number, holidays: Set<number>): number {
  const s = Math.floor(start), e = Math.floor(end);
  const sign = e < s ? -1 : 1;
  const lo = Math.min(s, e), hi = Math.max(s, e);
  let count = 0;
  for (let d = lo; d <= hi; d++) if (isWeekday(d) && !holidays.has(d)) count++;
  return sign * count;
}
function workday(start: number, days: number, holidays: Set<number>): number {
  let cur = Math.floor(start);
  const step = days >= 0 ? 1 : -1;
  let remaining = Math.abs(Math.trunc(days));
  while (remaining > 0) {
    cur += step;
    if (isWeekday(cur) && !holidays.has(cur)) remaining--;
  }
  return cur;
}
const holidaySet = (a: ArgAccessor | undefined) => new Set(a ? a.list().filter((v): v is number => typeof v === "number").map(Math.floor) : []);

/* ───────────────── text splitting (Excel 2019+/365) ───────────────── */
function textSplit(text: string, delim: string, instance: number, after: boolean): string {
  if (instance === 0) throw ERR("#VALUE!");
  // Empty delimiter: behaviour is not specified here, so refuse rather than guess.
  if (delim === "") throw ERR("#VALUE!");
  const parts = text.split(delim);
  if (Math.abs(instance) > parts.length - 1) throw ERR("#N/A");
  if (instance > 0) {
    const cut = parts.slice(0, instance).join(delim);
    return after ? text.slice(cut.length + delim.length) : cut;
  }
  const k = parts.length + instance; // index of the split point counted from the end
  const cut = parts.slice(k).join(delim);
  return after ? cut : text.slice(0, text.length - cut.length - delim.length);
}

/* ───────────────── statistics and ranking ───────────────── */
function percentileInc(xs: number[], k: number): number {
  if (!xs.length) throw ERR("#NUM!");
  if (k < 0 || k > 1) throw ERR("#NUM!");
  const s = [...xs].sort((a, b) => a - b);
  const rank = k * (s.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

/* ───────────────── the function table ───────────────── */
export const EXTRA_FUNCTIONS: Record<string, FnImpl> = {
  SUMIFS: (a) => {
    need(a, 3);
    const sum = a[0].list();
    const { len, mask } = criteriaMask(a, 1);
    if (len !== sum.length) throw ERR("#VALUE!");
    return nums(pickMasked(sum, mask)).reduce((x, y) => x + y, 0);
  },
  COUNTIFS: (a) => criteriaMask(a, 0).mask.filter(Boolean).length,
  AVERAGEIFS: (a) => {
    need(a, 3);
    const avg = a[0].list();
    const { len, mask } = criteriaMask(a, 1);
    if (len !== avg.length) throw ERR("#VALUE!");
    const ns = nums(pickMasked(avg, mask));
    if (!ns.length) throw ERR("#DIV/0!");
    return ns.reduce((x, y) => x + y, 0) / ns.length;
  },
  MAXIFS: (a) => {
    need(a, 3);
    const target = a[0].list();
    const { len, mask } = criteriaMask(a, 1);
    if (len !== target.length) throw ERR("#VALUE!");
    const ns = nums(pickMasked(target, mask));
    return ns.length ? Math.max(...ns) : 0;
  },
  MINIFS: (a) => {
    need(a, 3);
    const target = a[0].list();
    const { len, mask } = criteriaMask(a, 1);
    if (len !== target.length) throw ERR("#VALUE!");
    const ns = nums(pickMasked(target, mask));
    return ns.length ? Math.min(...ns) : 0;
  },
  XLOOKUP: xlookup,
  "STDEV.S": (a) => Math.sqrt(variance(xlNums(a), true)),
  "STDEV.P": (a) => Math.sqrt(variance(xlNums(a), false)),
  "VAR.S": (a) => variance(xlNums(a), true),
  "VAR.P": (a) => variance(xlNums(a), false),
  "PERCENTILE.INC": (a) => { need(a, 2); return percentileInc(nums(a[0].list()), toNum(a[1].value())); },
  PERCENTILE: (a) => { need(a, 2); return percentileInc(nums(a[0].list()), toNum(a[1].value())); },
  "RANK.EQ": (a) => {
    need(a, 2);
    const x = toNum(a[0].value());
    const ref = nums(a[1].list());
    const ascending = a[2] ? toNum(a[2].value()) !== 0 : false;
    if (!ref.includes(x)) throw ERR("#N/A");
    return 1 + ref.filter((v) => (ascending ? v < x : v > x)).length;
  },

  /* financial */
  PMT: (a) => { need(a, 3); return PMT(toNum(a[0].value()), toNum(a[1].value()), toNum(a[2].value()), a[3] ? toNum(a[3].value()) : 0, a[4] ? toNum(a[4].value()) : 0); },
  FV: (a) => { need(a, 3); return FV(toNum(a[0].value()), toNum(a[1].value()), toNum(a[2].value()), a[3] ? toNum(a[3].value()) : 0, a[4] ? toNum(a[4].value()) : 0); },
  PV: (a) => { need(a, 3); return PV(toNum(a[0].value()), toNum(a[1].value()), toNum(a[2].value()), a[3] ? toNum(a[3].value()) : 0, a[4] ? toNum(a[4].value()) : 0); },
  NPV: (a) => { need(a, 2); return NPV(toNum(a[0].value()), a.slice(1).flatMap((x) => nums(x.list()))); },
  IRR: (a) => { need(a, 1); return IRR(nums(a[0].list()), a[1] ? toNum(a[1].value()) : 0.1); },

  /* dates */
  DATEDIF: (a) => { need(a, 3); return datedif(toNum(a[0].value()), toNum(a[1].value()), toStr(a[2].value())); },
  NETWORKDAYS: (a) => { need(a, 2); return networkdays(toNum(a[0].value()), toNum(a[1].value()), holidaySet(a[2])); },
  WORKDAY: (a) => { need(a, 2); return workday(toNum(a[0].value()), toNum(a[1].value()), holidaySet(a[2])); },

  /* text splitting */
  TEXTBEFORE: (a) => { need(a, 2); return textSplit(toStr(a[0].value()), toStr(a[1].value()), a[2] ? toNum(a[2].value()) : 1, false); },
  TEXTAFTER: (a) => { need(a, 2); return textSplit(toStr(a[0].value()), toStr(a[1].value()), a[2] ? toNum(a[2].value()) : 1, true); },
};


/* Arity: Excel refuses a formula whose argument count is outside the documented range. Extra
 * arguments were previously ignored silently, so a wrong-shape call returned a plausible-looking
 * answer computed from a subset of its inputs. Each wrapped function now checks [min, max] first. */
const ARITY: Record<string, [number, number]> = {
  PMT: [3, 5], FV: [3, 5], PV: [3, 5], NPV: [2, 255], IRR: [1, 2], DATEDIF: [3, 3],
  NETWORKDAYS: [2, 3], WORKDAY: [2, 3], TEXTBEFORE: [2, 3], TEXTAFTER: [2, 3],
  PERCENTILE: [2, 2], "PERCENTILE.INC": [2, 2], "RANK.EQ": [2, 3], XLOOKUP: [3, 6],
  SUMIFS: [3, 255], AVERAGEIFS: [3, 255], MAXIFS: [3, 255], MINIFS: [3, 255], COUNTIFS: [2, 254],
};
for (const [name, [lo, hi]] of Object.entries(ARITY)) {
  const impl = EXTRA_FUNCTIONS[name];
  if (!impl) throw new Error(`arity declared for unknown function ${name}`);
  EXTRA_FUNCTIONS[name] = (a, env) => {
    if (a.length < lo || a.length > hi) throw ERR("#VALUE!");
    return impl(a, env);
  };
}
