/**
 * TT46 function additions — first-party, written from the published Microsoft function definitions. Each was
 * added because the real-file corpus oracle (Excel-cached values in the Apache POI test-data files, recomputed by
 * scripts/diag/xlsx-corpus.mts) or the function-coverage probe showed #NAME? for it.
 *
 * Numerical methods (declared):
 *  - Student t: CDF through the regularized incomplete beta I_x(a,b) (continued fraction, modified Lentz,
 *    ≤ 300 terms, |Δ-1| < 1e-15); inverse by bracketing bisection to 1e-14 then 3 Newton steps.
 *  - XIRR / MIRR: Newton on XNPV from `guess` (default 0.1), ≤ 100 steps, |Δ| < 1e-10, then bisection fallback.
 *  - LINEST: ordinary least squares by Gauss–Jordan with partial pivoting on XᵀX (collinear columns → #NUM!).
 */
import { ERR, isErr, toNum, toStr, toBool, type ArgAccessor, type CellValue, type FnImpl } from "./officeFunctions";

const num = (a: ArgAccessor | undefined, dflt?: number) => (a === undefined ? (dflt === undefined ? (() => { throw ERR("#VALUE!"); })() : dflt) : toNum(a.value()));
const finite = (x: number) => { if (!Number.isFinite(x)) throw ERR("#NUM!"); return x; };
const throwErr = (v: CellValue) => { if (isErr(v)) throw ERR(String(v)); };
/** Numeric grid (errors propagate; non-numbers → #VALUE!). */
const numGrid = (a: ArgAccessor): number[][] => a.grid().map((r) => r.map((v) => { throwErr(v); if (typeof v !== "number") throw ERR("#VALUE!"); return v; }));
/** Pairwise numeric values of two equally-sized ranges, skipping pairs where either side is not a number. */
function pairs(a: ArgAccessor, b: ArgAccessor): [number, number][] {
  const x = a.list(), y = b.list();
  if (x.length !== y.length) throw ERR("#N/A");
  const out: [number, number][] = [];
  for (let i = 0; i < x.length; i++) { throwErr(x[i]); throwErr(y[i]); if (typeof x[i] === "number" && typeof y[i] === "number") out.push([x[i] as number, y[i] as number]); }
  if (!out.length) throw ERR("#DIV/0!"); // TT73: Excel's SUMX2MY2/SUMX2PY2/SUMXMY2 give #DIV/0! when no numeric pair exists
  return out;
}

/* ------------------------------------------------------------------ matrices */
function det(m: number[][]): number {
  const n = m.length; const a = m.map((r) => r.slice()); let d = 1;
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (a[p][c] === 0) return 0;
    if (p !== c) { [a[p], a[c]] = [a[c], a[p]]; d = -d; }
    d *= a[c][c];
    for (let r = c + 1; r < n; r++) { const f = a[r][c] / a[c][c]; for (let k = c; k < n; k++) a[r][k] -= f * a[c][k]; }
  }
  return d;
}
function inverse(m: number[][]): number[][] | null {
  const n = m.length; const a = m.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-300) return null;
    [a[p], a[c]] = [a[c], a[p]];
    const piv = a[c][c]; for (let k = 0; k < 2 * n; k++) a[c][k] /= piv;
    for (let r = 0; r < n; r++) if (r !== c) { const f = a[r][c]; if (f) for (let k = 0; k < 2 * n; k++) a[r][k] -= f * a[c][k]; }
  }
  return a.map((r) => r.slice(n));
}
const square = (g: number[][]) => { if (!g.length || g.some((r) => r.length !== g.length)) throw ERR("#VALUE!"); return g; };
const mmul = (a: number[][], b: number[][]) => a.map((r) => b[0].map((_, j) => r.reduce((s, v, k) => s + v * b[k][j], 0)));

/* ------------------------------------------------------------ incomplete beta / t */
function lnGamma(x: number): number { // Lanczos (g=7, n=9)
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1; let s = c[0]; for (let i = 1; i < 9; i++) s += c[i] / (x + i);
  const t = x + 7.5; return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}
function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-300; let c = 1, d = 1 - ((a + b) * x) / (a + 1); if (Math.abs(d) < tiny) d = tiny; d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}
export function betaReg(x: number, a: number, b: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** Student t lower-tail CDF. */
export function tCdf(t: number, df: number): number { const x = df / (df + t * t); const tail = 0.5 * betaReg(x, df / 2, 0.5); return t >= 0 ? 1 - tail : tail; }
const tPdf = (t: number, df: number) => Math.exp(lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log(1 + (t * t) / df));
function tInv(p: number, df: number): number {
  let lo = -1e3, hi = 1e3;
  while (tCdf(lo, df) > p) lo *= 2; while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-14 * Math.max(1, Math.abs(lo)); i++) { const m = (lo + hi) / 2; if (tCdf(m, df) < p) lo = m; else hi = m; }
  let x = (lo + hi) / 2; for (let i = 0; i < 3; i++) { const f = tPdf(x, df); if (f > 0) x -= (tCdf(x, df) - p) / f; }
  return x;
}

/* ------------------------------------------------------------------ regression */
interface Ols { coef: number[]; b: number; se: number[]; seB: number; r2: number; sey: number; F: number; df: number; ssreg: number; ssresid: number }
function ols(ys: number[], xs: number[][], withConst: boolean): Ols {
  const n = ys.length, k = xs[0]?.length ?? 0;
  const X = xs.map((r) => (withConst ? [...r, 1] : r.slice()));
  const p = k + (withConst ? 1 : 0);
  if (n < p) throw ERR("#NUM!");
  const XtX = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0)));
  const Xty = Array.from({ length: p }, (_, i) => X.reduce((s, r, t) => s + r[i] * ys[t], 0));
  const inv = inverse(XtX); if (!inv) throw ERR("#NUM!");
  const beta = inv.map((r) => r.reduce((s, v, j) => s + v * Xty[j], 0));
  const fit = X.map((r) => r.reduce((s, v, j) => s + v * beta[j], 0));
  const ssresid = ys.reduce((s, y, t) => s + (y - fit[t]) ** 2, 0);
  const mean = ys.reduce((s, y) => s + y, 0) / n;
  const sstot = withConst ? ys.reduce((s, y) => s + (y - mean) ** 2, 0) : ys.reduce((s, y) => s + y * y, 0);
  const ssreg = sstot - ssresid; const df = n - p;
  const sey = df > 0 ? Math.sqrt(ssresid / df) : 0;
  const se = inv.map((r, i) => Math.sqrt(Math.max(0, r[i]) * (df > 0 ? ssresid / df : 0)));
  return { coef: beta.slice(0, k), b: withConst ? beta[k] : 0, se: se.slice(0, k), seB: withConst ? se[k] : 0, r2: sstot ? ssreg / sstot : 1, sey, F: df > 0 && ssresid > 0 ? (ssreg / (p - (withConst ? 1 : 0))) / (ssresid / df) : 0, df, ssreg, ssresid };
}
/** known_y + known_x (optional; default 1..n) → y vector and x rows (each row = one observation). */
function regData(yA: ArgAccessor, xA: ArgAccessor | undefined): { ys: number[]; xs: number[][]; byRow: boolean } {
  const yg = numGrid(yA); const ys = yg.flat(); const yCol = yg[0].length === 1;
  if (!xA) return { ys, xs: ys.map((_, i) => [i + 1]), byRow: false };
  const xg = numGrid(xA);
  if (xg.length * (xg[0]?.length ?? 0) === ys.length) return { ys, xs: xg.flat().map((v) => [v]), byRow: false };
  if (yCol && xg.length === ys.length) return { ys, xs: xg, byRow: false };
  if (!yCol && (xg[0]?.length ?? 0) === ys.length) return { ys, xs: ys.map((_, i) => xg.map((r) => r[i])), byRow: true };
  throw ERR("#REF!");
}
const isMissingArg = (a: ArgAccessor | undefined) => a === undefined || (!a.isRange && a.value() === null);

/* ------------------------------------------------------------------ dates */
function weekendMask(a: ArgAccessor | undefined): boolean[] { // index 0 = Monday … 6 = Sunday
  if (a === undefined) return [false, false, false, false, false, true, true];
  const v = a.value();
  if (typeof v === "string") { if (!/^[01]{7}$/.test(v) || v === "1111111") throw ERR("#VALUE!"); return [...v].map((c) => c === "1"); }
  const n = toNum(v);
  const two: Record<number, [number, number]> = { 1: [5, 6], 2: [6, 0], 3: [0, 1], 4: [1, 2], 5: [2, 3], 6: [3, 4], 7: [4, 5] };
  const m = Array(7).fill(false);
  if (two[n]) { m[two[n][0]] = m[two[n][1]] = true; return m; }
  if (n >= 11 && n <= 17) { m[n - 11] = true; return m; }
  throw ERR("#NUM!");
}
const dow = (serial: number) => (((Math.floor(serial) - 2) % 7) + 7) % 7; // 0 = Monday (serial 2 = 1900-01-01 Mon… 1900 system)
const holidaySet = (a: ArgAccessor | undefined) => new Set((a ? a.list() : []).filter((v): v is number => typeof v === "number").map(Math.floor));

/* ------------------------------------------------------------------ table */
const CP1252 = "\u20AC\uFFFD\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\uFFFD\u017D\uFFFD\uFFFD\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\uFFFD\u017E\u0178";
export const TT46_FUNCTIONS: Record<string, FnImpl> = {
  // Overrides of imported implementations whose behaviour the corpus showed to differ from Excel:
  IRR: (a) => {
    const v = a[0].list().map((x) => { throwErr(x); return x; }).filter((x): x is number => typeof x === "number");
    if (!v.some((x) => x > 0) || !v.some((x) => x < 0)) throw ERR("#NUM!");
    const f = (r: number) => v.reduce((s, x, i) => s + x / (1 + r) ** i, 0);
    const df = (r: number) => v.reduce((s, x, i) => s - (i * x) / (1 + r) ** (i + 1), 0);
    return solveRate(f, df, num(a[1], 0.1));
  },
  CHAR: (a) => { const n = Math.trunc(num(a[0])); if (n < 1 || n > 255) throw ERR("#VALUE!"); return n >= 128 && n <= 159 ? CP1252[n - 128] : String.fromCharCode(n); },
  FLOOR: (a) => {
    const x = num(a[0]); const s = a[1] ? num(a[1]) : (() => { throw ERR("#VALUE!"); })();
    if (a.length > 2) throw ERR("#VALUE!");
    if (x === 0) return 0; if (s === 0) throw ERR("#DIV/0!"); if (x > 0 && s < 0) throw ERR("#NUM!");
    const q = x / s; const r = Math.abs(q - Math.round(q)) < 1e-12 ? Math.round(q) : (x < 0 && s < 0 ? Math.floor(q) : Math.floor(q));
    return r * s;
  },
  MMULT: (a) => { const x = numGrid(a[0]), y = numGrid(a[1]); if (x[0].length !== y.length) throw ERR("#VALUE!"); return mmul(x, y); },
  MDETERM: (a) => det(square(numGrid(a[0]))),
  MINVERSE: (a) => { const inv = inverse(square(numGrid(a[0]))); if (!inv) throw ERR("#NUM!"); return inv; },
  TRANSPOSE: (a) => { const g = a[0].grid(); return g[0].map((_, j) => g.map((r) => r[j] ?? 0)); },
  SUMX2MY2: (a) => pairs(a[0], a[1]).reduce((s, [x, y]) => s + x * x - y * y, 0),
  SUMX2PY2: (a) => pairs(a[0], a[1]).reduce((s, [x, y]) => s + x * x + y * y, 0),
  SUMXMY2: (a) => pairs(a[0], a[1]).reduce((s, [x, y]) => s + (x - y) ** 2, 0),
  RANK: (a) => rank(a, false), "RANK.AVG": (a) => rank(a, true),
  POISSON: (a) => { const x = Math.floor(num(a[0])), m = num(a[1]), c = toBool(a[2]?.value() ?? false); if (x < 0 || m < 0) throw ERR("#NUM!"); const pmf = (k: number) => Math.exp(k * Math.log(m || 1e-300) - m - lnGamma(k + 1)); if (!c) return m === 0 ? (x === 0 ? 1 : 0) : pmf(x); let s = 0; for (let k = 0; k <= x; k++) s += m === 0 ? (k === 0 ? 1 : 0) : pmf(k); return Math.min(1, s); },
  FREQUENCY: (a) => {
    const data = a[0].list().filter((v): v is number => typeof v === "number");
    const bins = a[1].list().filter((v): v is number => typeof v === "number");
    const order = bins.map((b, i) => [b, i] as const).sort((p, q) => p[0] - q[0]);
    const counts = Array(bins.length + 1).fill(0);
    for (const d of data) { const k = order.findIndex(([b]) => d <= b); counts[k < 0 ? bins.length : order[k][1]]++; }
    return counts.map((c) => [c]);
  },
  XIRR: (a) => {
    const v = a[0].list().map((x) => toNum(x)), d = a[1].list().map((x) => Math.floor(toNum(x)));
    if (v.length !== d.length || v.length < 2 || !v.some((x) => x > 0) || !v.some((x) => x < 0)) throw ERR("#NUM!");
    const f = (r: number) => v.reduce((s, x, i) => s + x / (1 + r) ** ((d[i] - d[0]) / 365), 0);
    const df = (r: number) => v.reduce((s, x, i) => { const t = (d[i] - d[0]) / 365; return s - (t * x) / (1 + r) ** (t + 1); }, 0);
    return solveRate(f, df, num(a[2], 0.1));
  },
  MIRR: (a) => {
    const v = a[0].list().filter((x): x is number => typeof x === "number"); const fr = num(a[1]), rr = num(a[2]); const n = v.length;
    const pos = v.reduce((s, x, i) => s + (x > 0 ? x * (1 + rr) ** (n - 1 - i) : 0), 0);
    const neg = v.reduce((s, x, i) => s + (x < 0 ? x / (1 + fr) ** i : 0), 0);
    if (!pos || !neg) throw ERR("#DIV/0!");
    return finite((-pos / neg) ** (1 / (n - 1)) - 1);
  },
  DB: (a) => {
    const cost = num(a[0]), salvage = num(a[1]), life = num(a[2]), period = num(a[3]), month = num(a[4], 12);
    if (cost < 0 || salvage < 0 || life <= 0 || period <= 0 || month < 1 || month > 12 || period > life + 1) throw ERR("#NUM!");
    const rate = cost === 0 ? 0 : Math.round((1 - (salvage / cost) ** (1 / life)) * 1000) / 1000;
    let total = 0, dep = 0;
    for (let p = 1; p <= period; p++) {
      if (p === 1) dep = (cost * rate * month) / 12;
      else if (p === Math.floor(life) + 1) dep = ((cost - total) * rate * (12 - month)) / 12;
      else dep = (cost - total) * rate;
      total += dep;
    }
    return dep;
  },
  "NETWORKDAYS.INTL": (a) => {
    let s = Math.floor(num(a[0])), e = Math.floor(num(a[1])); const mask = weekendMask(isMissingArg(a[2]) ? undefined : a[2]); const hol = holidaySet(a[3]);
    const sign = e >= s ? 1 : -1; if (sign < 0) [s, e] = [e, s];
    let n = 0; for (let d = s; d <= e; d++) if (!mask[dow(d)] && !hol.has(d)) n++;
    return sign * n;
  },
  "WORKDAY.INTL": (a) => {
    let d = Math.floor(num(a[0])); let k = Math.trunc(num(a[1])); const mask = weekendMask(isMissingArg(a[2]) ? undefined : a[2]); const hol = holidaySet(a[3]);
    const step = k >= 0 ? 1 : -1; k = Math.abs(k);
    while (k > 0) { d += step; if (!mask[dow(d)] && !hol.has(d)) k--; }
    return d;
  },
  "T.DIST": (a) => { const x = num(a[0]), df = Math.trunc(num(a[1])); if (df < 1) throw ERR("#NUM!"); return toBool(a[2]?.value() ?? false) ? tCdf(x, df) : tPdf(x, df); },
  "T.DIST.RT": (a) => { const df = Math.trunc(num(a[1])); if (df < 1) throw ERR("#NUM!"); return 1 - tCdf(num(a[0]), df); },
  "T.DIST.2T": (a) => { const x = num(a[0]), df = Math.trunc(num(a[1])); if (x < 0 || df < 1) throw ERR("#NUM!"); return 2 * (1 - tCdf(x, df)); },
  TDIST: (a) => { const x = num(a[0]), df = Math.trunc(num(a[1])), tails = Math.trunc(num(a[2])); if (x < 0 || df < 1 || (tails !== 1 && tails !== 2)) throw ERR("#NUM!"); return tails * (1 - tCdf(x, df)); },
  "T.INV": (a) => { const p = num(a[0]), df = Math.trunc(num(a[1])); if (p <= 0 || p >= 1 || df < 1) throw ERR("#NUM!"); return tInv(p, df); },
  "T.INV.2T": (a) => { const p = num(a[0]), df = Math.trunc(num(a[1])); if (p <= 0 || p > 1 || df < 1) throw ERR("#NUM!"); return Math.abs(tInv(p / 2, df)); },
  TINV: (a) => { const p = num(a[0]), df = Math.trunc(num(a[1])); if (p <= 0 || p > 1 || df < 1) throw ERR("#NUM!"); return Math.abs(tInv(p / 2, df)); },
  "T.TEST": (a) => tTest(a), TTEST: (a) => tTest(a),
  LINEST: (a) => {
    const { ys, xs } = regData(a[0], isMissingArg(a[1]) ? undefined : a[1]);
    const c = isMissingArg(a[2]) ? true : toBool(a[2].value()); const stats = isMissingArg(a[3]) ? false : toBool(a[3].value());
    const r = ols(ys, xs, c); const k = r.coef.length; const pad = (row: CellValue[]) => [...row, ...Array(k + 1 - row.length).fill("#N/A")];
    const first = [...r.coef.slice().reverse(), r.b];
    if (!stats) return [first];
    return [first, [...r.se.slice().reverse(), c ? r.seB : "#N/A"], pad([r.r2, r.sey]), pad([r.F, r.df]), pad([r.ssreg, r.ssresid])];
  },
  LOGEST: (a) => {
    const { ys, xs } = regData(a[0], isMissingArg(a[1]) ? undefined : a[1]);
    if (ys.some((y) => y <= 0)) throw ERR("#NUM!");
    const r = ols(ys.map(Math.log), xs, isMissingArg(a[2]) ? true : toBool(a[2].value()));
    return [[...r.coef.slice().reverse().map(Math.exp), Math.exp(r.b)]];
  },
  TREND: (a) => trend(a, false), GROWTH: (a) => trend(a, true),
  DGET: (a) => {
    const db = a[0].grid(), crit = a[2].grid(); const head = db[0].map((h) => toStr(h ?? "").toLowerCase());
    const f = a[1].value(); const col = typeof f === "number" ? f - 1 : head.indexOf(toStr(f ?? "").toLowerCase());
    if (col < 0 || col >= head.length) throw ERR("#VALUE!");
    const ch = crit[0].map((h) => head.indexOf(toStr(h ?? "").toLowerCase()));
    const hits = db.slice(1).filter((row) => crit.slice(1).some((cr) => cr.every((c, j) => c === null || c === "" || ch[j] < 0 || matchCrit(row[ch[j]], c))));
    if (!hits.length) throw ERR("#VALUE!"); if (hits.length > 1) throw ERR("#NUM!");
    return hits[0][col];
  },
};
function matchCrit(v: CellValue, c: CellValue): boolean {
  if (typeof c === "number") return v === c;
  const s = toStr(c ?? ""); const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(s)!; const op = m[1] ?? "="; const rhs = m[2];
  const rn = Number(rhs); const isNum = rhs !== "" && !Number.isNaN(rn);
  if (isNum && typeof v === "number") return op === "=" ? v === rn : op === "<>" ? v !== rn : op === "<" ? v < rn : op === ">" ? v > rn : op === "<=" ? v <= rn : v >= rn;
  const vs = toStr(v ?? "").toLowerCase(), r = rhs.toLowerCase();
  if (op === "=" || op === "<>") { const re = new RegExp(`^${r.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}${m[1] ? "$" : ""}`); const ok = re.test(vs); return op === "=" ? ok : !ok; }
  return op === "<" ? vs < r : op === ">" ? vs > r : op === "<=" ? vs <= r : vs >= r;
}
function rank(a: ArgAccessor[], avg: boolean): number {
  const x = num(a[0]); const list = a[1].list().filter((v): v is number => typeof v === "number"); const asc = a[2] ? toNum(a[2].value()) !== 0 : false;
  const better = list.filter((v) => (asc ? v < x : v > x)).length; const ties = list.filter((v) => v === x).length;
  if (!ties) throw ERR("#N/A");
  return avg ? better + (ties + 1) / 2 : better + 1;
}
function solveRate(f: (r: number) => number, df: (r: number) => number, guess: number): number {
  let r = guess;
  for (let i = 0; i < 100; i++) { const y = f(r), d = df(r); if (!Number.isFinite(y) || !d) break; const nr = r - y / d; if (Math.abs(nr - r) < 1e-10) return nr; r = nr <= -1 ? (r - 1) / 2 : nr; }
  let lo = -0.999999, hi = 10; if (f(lo) * f(hi) > 0) throw ERR("#NUM!");
  for (let i = 0; i < 300; i++) { const m = (lo + hi) / 2; if (f(lo) * f(m) <= 0) hi = m; else lo = m; }
  return (lo + hi) / 2;
}
function tTest(a: ArgAccessor[]): number {
  const tails = Math.trunc(num(a[2])), type = Math.trunc(num(a[3]));
  if ((tails !== 1 && tails !== 2) || type < 1 || type > 3) throw ERR("#NUM!");
  let t: number, df: number;
  if (type === 1) {
    const d = pairs(a[0], a[1]).map(([x, y]) => x - y); const n = d.length; if (n < 2) throw ERR("#DIV/0!");
    const m = d.reduce((s, v) => s + v, 0) / n; const v = d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
    t = m / Math.sqrt(v / n); df = n - 1;
  } else {
    const x = a[0].list().filter((v): v is number => typeof v === "number"), y = a[1].list().filter((v): v is number => typeof v === "number");
    const n1 = x.length, n2 = y.length; if (n1 < 2 || n2 < 2) throw ERR("#DIV/0!");
    const m1 = x.reduce((s, v) => s + v, 0) / n1, m2 = y.reduce((s, v) => s + v, 0) / n2;
    const v1 = x.reduce((s, v) => s + (v - m1) ** 2, 0) / (n1 - 1), v2 = y.reduce((s, v) => s + (v - m2) ** 2, 0) / (n2 - 1);
    if (type === 2) { df = n1 + n2 - 2; const sp = ((n1 - 1) * v1 + (n2 - 1) * v2) / df; t = (m1 - m2) / Math.sqrt(sp * (1 / n1 + 1 / n2)); }
    else { const q1 = v1 / n1, q2 = v2 / n2; t = (m1 - m2) / Math.sqrt(q1 + q2); df = (q1 + q2) ** 2 / (q1 * q1 / (n1 - 1) + q2 * q2 / (n2 - 1)); }
  }
  const p = 1 - tCdf(Math.abs(t), df);
  return tails * p;
}
function trend(a: ArgAccessor[], growth: boolean): CellValue[][] {
  const { ys, xs } = regData(a[0], isMissingArg(a[1]) ? undefined : a[1]);
  if (growth && ys.some((y) => y <= 0)) throw ERR("#NUM!");
  const r = ols(growth ? ys.map(Math.log) : ys, xs, isMissingArg(a[3]) ? true : toBool(a[3].value()));
  const k = r.coef.length;
  let rows: number[][]; let shape: [number, number];
  if (isMissingArg(a[2])) { rows = xs; const g = a[0].grid(); shape = [g.length, g[0].length]; }
  else { const g = numGrid(a[2]); if (k === 1) { rows = g.flat().map((v) => [v]); shape = [g.length, g[0].length]; } else { rows = g; shape = [g.length, 1]; } }
  const vals = rows.map((x) => { const y = r.b + x.reduce((s, v, j) => s + v * r.coef[j], 0); return growth ? Math.exp(y) : y; });
  return Array.from({ length: shape[0] }, (_, i) => Array.from({ length: shape[1] }, (_, j) => vals[i * shape[1] + j]));
}
