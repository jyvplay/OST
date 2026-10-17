/**
 * TT15 function additions — first-party, written from the published Microsoft
 * function definitions (support.microsoft.com function reference) and standard
 * numerical methods. Every function here was added because the independent
 * PyPI `formulas` oracle run (scripts/oracle-formulas-py.mts) reported #NAME?
 * for it, or exposed a bug in the imported library (DATEDIF).
 *
 * Numerical methods (declared):
 *  - Φ(x): Taylor series of erf for |x| < 3, Lentz continued fraction of erfc
 *    beyond — ~1e-15 relative in double precision.
 *  - Φ⁻¹(p): Acklam's rational approximation (|rel err| < 1.15e-9) followed by
 *    one Halley refinement step against the accurate Φ above.
 *  - RATE: Newton iteration from `guess` (default 0.1), ≤ 100 steps, |Δ| < 1e-12,
 *    else #NUM! (Excel documents the same failure mode after 20 iterations).
 */
import { ERR, isErr, toNum, toStr, toBool, nums, need, dateToSerial, serialToDate, type ArgAccessor, type CellValue, type FnImpl } from "./officeFunctions";

const num = (a: ArgAccessor | undefined, dflt?: number) => (a === undefined ? (dflt === undefined ? (() => { throw ERR("#VALUE!"); })() : dflt) : toNum(a.value()));
const allNums = (args: ArgAccessor[]) => nums(args.flatMap((a) => a.list()));
const finite = (x: number) => { if (!Number.isFinite(x)) throw ERR("#NUM!"); return x; };

/* ------------------------------------------------------------ normal distribution */
function erfSeries(x: number): number {
  let sum = x, term = x, n = 0;
  const x2 = x * x;
  while (Math.abs(term) > 1e-17 * Math.abs(sum) && n < 200) { n++; term *= -x2 / n; sum += term / (2 * n + 1); }
  return (2 / Math.sqrt(Math.PI)) * sum;
}
function erfcCF(x: number): number { // x > 0, modified Lentz on erfc(x) = exp(-x²)/√π · 1/(x+ 1/2/(x+ 1/(x+ 3/2/(x+ ...))))
  const tiny = 1e-300;
  let f = x, C = x, D = 0;
  for (let i = 1; i < 500; i++) {
    const a = i / 2;
    D = x + a * D; if (Math.abs(D) < tiny) D = tiny; D = 1 / D;
    C = x + a / C; if (Math.abs(C) < tiny) C = tiny;
    const delta = C * D; f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * f);
}
const erfc = (x: number) => (Math.abs(x) < 3 ? 1 - erfSeries(x) : x > 0 ? erfcCF(x) : 2 - erfcCF(-x));
export const normCdf = (z: number) => 0.5 * erfc(-z / Math.SQRT2);
const normPdf = (z: number) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
export function normInv(p: number): number {
  if (!(p > 0 && p < 1)) throw ERR("#NUM!");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x: number;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  else if (p <= 1 - pl) { const q = p - 0.5, r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  else { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const e = normCdf(x) - p; const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2); // Halley step
}

/* ------------------------------------------------------------ financial core */
function annuity(rate: number, nper: number, pmt: number, pv: number, fv: number, type: number) {
  if (rate === 0) return pv + pmt * nper + fv;
  const f = (1 + rate) ** nper;
  return pv * f + pmt * (1 + rate * type) * (f - 1) / rate + fv;
}
function pmtOf(rate: number, nper: number, pv: number, fv = 0, type = 0) {
  if (rate === 0) return -(pv + fv) / nper;
  const f = (1 + rate) ** nper;
  return -(rate * (pv * f + fv)) / ((1 + rate * type) * (f - 1));
}
function fvOf(rate: number, nper: number, pmt: number, pv: number, type: number) {
  if (rate === 0) return -(pv + pmt * nper);
  const f = (1 + rate) ** nper;
  return -(pv * f + pmt * (1 + rate * type) * (f - 1) / rate);
}
function ipmtOf(rate: number, per: number, nper: number, pv: number, fv: number, type: number) {
  // Excel sign convention: IPMT(r, per, n, pv>0) is negative (cash paid). Interest accrues on the
  // balance left after per-1 payments: FV(r, per-1, pmt, pv, type) · r; annuity-due shifts one period.
  if (per < 1 || per > nper) throw ERR("#NUM!");
  const pmt = pmtOf(rate, nper, pv, fv, type);
  if (type === 1) return per === 1 ? 0 : (fvOf(rate, per - 2, pmt, pv, 1) - pmt) * rate;
  return fvOf(rate, per - 1, pmt, pv, 0) * rate;
}

/* ------------------------------------------------------------ dates */
const ymd = (s: number) => { const d = serialToDate(s); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; };
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
function days360(s: number, e: number, european: boolean) {
  const A = ymd(s), B = ymd(e);
  let d1 = A.d, d2 = B.d;
  if (european) { if (d1 === 31) d1 = 30; if (d2 === 31) d2 = 30; }
  else {
    const lastFebA = A.m === 2 && d1 === daysInMonth(A.y, 2);
    const lastFebB = B.m === 2 && d2 === daysInMonth(B.y, 2);
    if (lastFebA && lastFebB) d2 = 30;
    if (lastFebA) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
    if (d1 === 31) d1 = 30;
  }
  return (B.y - A.y) * 360 + (B.m - A.m) * 30 + (d2 - d1);
}
function fracTime(v: CellValue): number { const n = toNum(v); if (n < 0) throw ERR("#NUM!"); return n - Math.floor(n); }
function parseDateText(s: string): number {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return dateToSerial(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(t); // en-US M/D/Y (declared locale)
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] - (+m[3] >= 30 ? 100 : 0) : +m[3]; return dateToSerial(new Date(Date.UTC(y, +m[1] - 1, +m[2]))); }
  const mon = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ,]+(\d{4})/.exec(t);
  if (m && mon.includes(m[2].toLowerCase())) return dateToSerial(new Date(Date.UTC(+m[3], mon.indexOf(m[2].toLowerCase()), +m[1])));
  throw ERR("#VALUE!");
}
function parseTimeText(s: string): number {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(AM|PM)?/i.exec(s);
  if (!m) throw ERR("#VALUE!");
  let h = +m[1]; const mi = +m[2], se = m[3] ? +m[3] : 0;
  if (m[4]) { if (h > 12) throw ERR("#VALUE!"); h = (h % 12) + (m[4].toUpperCase() === "PM" ? 12 : 0); }
  return (h * 3600 + mi * 60 + se) / 86400;
}

/* ------------------------------------------------------------ stats helpers */
function moments(xs: number[]) {
  const n = xs.length; const mean = xs.reduce((a, b) => a + b, 0) / n;
  const dev = xs.map((x) => x - mean);
  return { n, mean, dev, ss: dev.reduce((a, b) => a + b * b, 0) };
}
function percentRank(xs: number[], x: number, sig: number, exclusive: boolean) {
  const s = [...xs].sort((a, b) => a - b); const n = s.length;
  if (!n) throw ERR("#NUM!");
  if (x < s[0] || x > s[n - 1]) throw ERR("#N/A");
  let pos: number;
  const idx = s.indexOf(x);
  if (idx >= 0) {
    const less = s.filter((v) => v < x).length;
    pos = exclusive ? (less + 1) / (n + 1) : n === 1 ? 1 : less / (n - 1);
  } else {
    let i = 0; while (s[i + 1] < x) i++;
    const lo = exclusive ? (i + 1) / (n + 1) : i / (n - 1), hi = exclusive ? (i + 2) / (n + 1) : (i + 1) / (n - 1);
    pos = lo + (hi - lo) * (x - s[i]) / (s[i + 1] - s[i]);
  }
  const f = 10 ** sig; return Math.floor(pos * f + 1e-9) / f;
}
const lnGamma = (z: number): number => { // Lanczos g=7
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lnGamma(1 - z);
  z -= 1; let x = c[0]; for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
};
const lnComb = (n: number, k: number) => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);

/* ------------------------------------------------------------ lookup helpers */
function cmpLoose(a: CellValue, b: CellValue): number {
  const rank = (v: CellValue) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return Number(a) - Number(b);
}
function wildcardRe(p: string) { return new RegExp(`^${p.replace(/~([*?~])|([.+^${}()|[\]\\])|(\*)|(\?)/g, (_m, esc, meta, star, q) => (esc ? `\\${esc}` : meta ? `\\${meta}` : star ? ".*" : q ? "." : ""))}$`, "i"); }

export const TT15_FUNCTIONS: Record<string, FnImpl> = {
  /* trig & hyperbolic */
  SIN: (a) => Math.sin(num(a[0])), COS: (a) => Math.cos(num(a[0])), TAN: (a) => Math.tan(num(a[0])),
  ASIN: (a) => { const x = num(a[0]); if (x < -1 || x > 1) throw ERR("#NUM!"); return Math.asin(x); },
  ACOS: (a) => { const x = num(a[0]); if (x < -1 || x > 1) throw ERR("#NUM!"); return Math.acos(x); },
  ATAN: (a) => Math.atan(num(a[0])),
  ATAN2: (a) => { const x = num(a[0]), y = num(a[1]); if (x === 0 && y === 0) throw ERR("#DIV/0!"); return Math.atan2(y, x); }, // Excel arg order: (x, y)
  SINH: (a) => Math.sinh(num(a[0])), COSH: (a) => Math.cosh(num(a[0])), TANH: (a) => Math.tanh(num(a[0])),
  ASINH: (a) => Math.asinh(num(a[0])),
  ACOSH: (a) => { const x = num(a[0]); if (x < 1) throw ERR("#NUM!"); return Math.acosh(x); },
  ATANH: (a) => { const x = num(a[0]); if (x <= -1 || x >= 1) throw ERR("#NUM!"); return Math.atanh(x); },
  COT: (a) => { const x = num(a[0]); if (x === 0) throw ERR("#DIV/0!"); return 1 / Math.tan(x); },
  CSC: (a) => { const x = num(a[0]); if (x === 0) throw ERR("#DIV/0!"); return 1 / Math.sin(x); },
  SEC: (a) => 1 / Math.cos(num(a[0])),
  RADIANS: (a) => (num(a[0]) * Math.PI) / 180, DEGREES: (a) => (num(a[0]) * 180) / Math.PI,

  /* rounding */
  EVEN: (a) => { const x = num(a[0]); const r = Math.ceil(Math.abs(x) / 2) * 2; return x < 0 ? -r : r; },
  ODD: (a) => { const x = num(a[0]); let r = Math.ceil(Math.abs(x)); if (r % 2 === 0) r += 1; return x < 0 ? -r : r; },
  MROUND: (a) => { const x = num(a[0]), m = num(a[1]); if (m === 0) return 0; if (x * m < 0) throw ERR("#NUM!"); return Math.round(x / m + 1e-12 * Math.sign(x / m)) * m; },
  "CEILING.MATH": (a) => { const x = num(a[0]); const s = Math.abs(num(a[1], 1)) || 1; const mode = num(a[2], 0); if (x < 0 && mode !== 0) return -Math.ceil(-x / s) * s; return Math.ceil(x / s) * s; },
  "FLOOR.MATH": (a) => { const x = num(a[0]); const s = Math.abs(num(a[1], 1)) || 1; const mode = num(a[2], 0); if (x < 0 && mode !== 0) return -Math.floor(-x / s) * s; return Math.floor(x / s) * s; },
  "CEILING.PRECISE": (a) => { const s = Math.abs(num(a[1], 1)); return s === 0 ? 0 : Math.ceil(num(a[0]) / s) * s; },
  "FLOOR.PRECISE": (a) => { const s = Math.abs(num(a[1], 1)); return s === 0 ? 0 : Math.floor(num(a[0]) / s) * s; },
  "ISO.CEILING": (a) => { const s = Math.abs(num(a[1], 1)); return s === 0 ? 0 : Math.ceil(num(a[0]) / s) * s; },
  QUOTIENT: (a) => { const d = num(a[1]); if (d === 0) throw ERR("#DIV/0!"); return Math.trunc(num(a[0]) / d); },
  SUMSQ: (a) => allNums(a).reduce((s, x) => s + x * x, 0),
  SQRTPI: (a) => { const x = num(a[0]); if (x < 0) throw ERR("#NUM!"); return Math.sqrt(x * Math.PI); },
  COMBINA: (a) => { const n = Math.trunc(num(a[0])), k = Math.trunc(num(a[1])); if (n < 0 || k < 0) throw ERR("#NUM!"); return Math.round(Math.exp(lnComb(n + k - 1, k))); },
  SERIESSUM: (a) => { const x = num(a[0]), n = num(a[1]), m = num(a[2]); return nums(a[3].list()).reduce((s, c, i) => s + c * x ** (n + i * m), 0); },
  BASE: (a) => { const n = Math.trunc(num(a[0])), r = Math.trunc(num(a[1])); const len = Math.trunc(num(a[2], 0)); if (n < 0 || r < 2 || r > 36) throw ERR("#NUM!"); return n.toString(r).toUpperCase().padStart(len, "0"); },

  /* financial */
  NPER: (a) => {
    const rate = num(a[0]), pmt = num(a[1]), pv = num(a[2]), fv = num(a[3], 0), type = num(a[4], 0);
    if (rate === 0) { if (pmt === 0) throw ERR("#NUM!"); return -(pv + fv) / pmt; }
    const k = pmt * (1 + rate * type) / rate;
    const v = (k - fv) / (k + pv); if (v <= 0) throw ERR("#NUM!");
    return finite(Math.log(v) / Math.log(1 + rate));
  },
  RATE: (a) => {
    const nper = num(a[0]), pmt = num(a[1]), pv = num(a[2]), fv = num(a[3], 0), type = num(a[4], 0);
    let r = num(a[5], 0.1);
    for (let i = 0; i < 100; i++) {
      const f = annuity(r, nper, pmt, pv, fv, type);
      const h = 1e-7 * Math.max(1, Math.abs(r));
      const df = (annuity(r + h, nper, pmt, pv, fv, type) - annuity(r - h, nper, pmt, pv, fv, type)) / (2 * h);
      if (!Number.isFinite(df) || df === 0) break;
      const next = r - f / df;
      if (Math.abs(next - r) < 1e-12) return next;
      r = next;
    }
    throw ERR("#NUM!");
  },
  IPMT: (a) => ipmtOf(num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4], 0), num(a[5], 0)),
  PPMT: (a) => { const rate = num(a[0]), per = num(a[1]), nper = num(a[2]), pv = num(a[3]), fv = num(a[4], 0), type = num(a[5], 0); return pmtOf(rate, nper, pv, fv, type) - ipmtOf(rate, per, nper, pv, fv, type); },
  CUMIPMT: (a) => { const rate = num(a[0]), nper = num(a[1]), pv = num(a[2]), s = num(a[3]), e = num(a[4]), type = num(a[5]); if (rate <= 0 || nper <= 0 || pv <= 0 || s < 1 || e < s || e > nper) throw ERR("#NUM!"); let t = 0; for (let p = s; p <= e; p++) t += ipmtOf(rate, p, nper, pv, 0, type); return t; },
  CUMPRINC: (a) => { const rate = num(a[0]), nper = num(a[1]), pv = num(a[2]), s = num(a[3]), e = num(a[4]), type = num(a[5]); if (rate <= 0 || nper <= 0 || pv <= 0 || s < 1 || e < s || e > nper) throw ERR("#NUM!"); let t = 0; const p0 = pmtOf(rate, nper, pv, 0, type); for (let p = s; p <= e; p++) t += p0 - ipmtOf(rate, p, nper, pv, 0, type); return t; },
  EFFECT: (a) => { const r = num(a[0]), n = Math.trunc(num(a[1])); if (r <= 0 || n < 1) throw ERR("#NUM!"); return (1 + r / n) ** n - 1; },
  NOMINAL: (a) => { const r = num(a[0]), n = Math.trunc(num(a[1])); if (r <= 0 || n < 1) throw ERR("#NUM!"); return n * ((1 + r) ** (1 / n) - 1); },
  PDURATION: (a) => { const r = num(a[0]), pv = num(a[1]), fv = num(a[2]); if (r <= 0 || pv <= 0 || fv <= 0) throw ERR("#NUM!"); return Math.log(fv / pv) / Math.log(1 + r); },
  RRI: (a) => { const n = num(a[0]), pv = num(a[1]), fv = num(a[2]); if (n <= 0 || pv === 0) throw ERR("#NUM!"); return (fv / pv) ** (1 / n) - 1; },
  XNPV: (a) => { const r = num(a[0]); const v = nums(a[1].list()), d = nums(a[2].list()); if (v.length !== d.length || !v.length) throw ERR("#NUM!"); return v.reduce((s, x, i) => s + x / (1 + r) ** ((d[i] - d[0]) / 365), 0); },

  /* statistics */
  AVEDEV: (a) => { const xs = allNums(a); if (!xs.length) throw ERR("#NUM!"); const { mean } = moments(xs); return xs.reduce((s, x) => s + Math.abs(x - mean), 0) / xs.length; },
  DEVSQ: (a) => { const xs = allNums(a); if (!xs.length) throw ERR("#NUM!"); return moments(xs).ss; },
  KURT: (a) => { const xs = allNums(a); const { n, dev, ss } = moments(xs); if (n < 4) throw ERR("#DIV/0!"); const s = Math.sqrt(ss / (n - 1)); if (s === 0) throw ERR("#DIV/0!"); const m4 = dev.reduce((t, d) => t + (d / s) ** 4, 0); return (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * m4 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)); },
  SKEW: (a) => { const xs = allNums(a); const { n, dev, ss } = moments(xs); if (n < 3) throw ERR("#DIV/0!"); const s = Math.sqrt(ss / (n - 1)); if (s === 0) throw ERR("#DIV/0!"); return (n / ((n - 1) * (n - 2))) * dev.reduce((t, d) => t + (d / s) ** 3, 0); },
  "SKEW.P": (a) => { const xs = allNums(a); const { n, dev, ss } = moments(xs); if (n < 1) throw ERR("#DIV/0!"); const s = Math.sqrt(ss / n); if (s === 0) throw ERR("#DIV/0!"); return dev.reduce((t, d) => t + (d / s) ** 3, 0) / n; },
  "PERCENTRANK.INC": (a) => percentRank(nums(a[0].list()), num(a[1]), Math.trunc(num(a[2], 3)), false),
  "PERCENTRANK.EXC": (a) => percentRank(nums(a[0].list()), num(a[1]), Math.trunc(num(a[2], 3)), true),
  "PERCENTILE.EXC": (a) => { const s = nums(a[0].list()).sort((x, y) => x - y); const k = num(a[1]); const n = s.length; const h = (n + 1) * k - 1; if (k <= 0 || k >= 1 || h < 0 || h > n - 1) throw ERR("#NUM!"); const lo = Math.floor(h); return s[lo] + (h - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]); },
  "NORM.S.DIST": (a) => { const z = num(a[0]); return toBool(a[1].value()) ? normCdf(z) : normPdf(z); },
  "NORM.DIST": (a) => { const x = num(a[0]), m = num(a[1]), sd = num(a[2]); if (sd <= 0) throw ERR("#NUM!"); const z = (x - m) / sd; return toBool(a[3].value()) ? normCdf(z) : normPdf(z) / sd; },
  "NORM.S.INV": (a) => normInv(num(a[0])),
  "NORM.INV": (a) => { const sd = num(a[2]); if (sd <= 0) throw ERR("#NUM!"); return num(a[1]) + sd * normInv(num(a[0])); },
  NORMSDIST: (a) => normCdf(num(a[0])),
  NORMSINV: (a) => normInv(num(a[0])),
  NORMDIST: (a) => { const x = num(a[0]), m = num(a[1]), sd = num(a[2]); if (sd <= 0) throw ERR("#NUM!"); const z = (x - m) / sd; return toBool(a[3].value()) ? normCdf(z) : normPdf(z) / sd; },
  NORMINV: (a) => { const sd = num(a[2]); if (sd <= 0) throw ERR("#NUM!"); return num(a[1]) + sd * normInv(num(a[0])); },
  STANDARDIZE: (a) => { const sd = num(a[2]); if (sd <= 0) throw ERR("#NUM!"); return (num(a[0]) - num(a[1])) / sd; },
  "EXPON.DIST": (a) => { const x = num(a[0]), l = num(a[1]); if (x < 0 || l <= 0) throw ERR("#NUM!"); return toBool(a[2].value()) ? 1 - Math.exp(-l * x) : l * Math.exp(-l * x); },
  "POISSON.DIST": (a) => { const k = Math.trunc(num(a[0])), m = num(a[1]); if (k < 0 || m < 0) throw ERR("#NUM!"); const pmf = (i: number) => Math.exp(i * Math.log(m || 1e-300) - m - lnGamma(i + 1)); if (!toBool(a[2].value())) return m === 0 ? (k === 0 ? 1 : 0) : pmf(k); let s = 0; for (let i = 0; i <= k; i++) s += m === 0 ? (i === 0 ? 1 : 0) : pmf(i); return s; },
  "BINOM.DIST": (a) => { const k = Math.trunc(num(a[0])), n = Math.trunc(num(a[1])), p = num(a[2]); if (k < 0 || k > n || p < 0 || p > 1) throw ERR("#NUM!"); const pmf = (i: number) => (p === 0 ? (i === 0 ? 1 : 0) : p === 1 ? (i === n ? 1 : 0) : Math.exp(lnComb(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p))); if (!toBool(a[3].value())) return pmf(k); let s = 0; for (let i = 0; i <= k; i++) s += pmf(i); return s; },
  GAMMALN: (a) => { const x = num(a[0]); if (x <= 0) throw ERR("#NUM!"); return lnGamma(x); },
  "GAMMALN.PRECISE": (a) => { const x = num(a[0]); if (x <= 0) throw ERR("#NUM!"); return lnGamma(x); },
  GAMMA: (a) => { const x = num(a[0]); if (x <= 0 && Number.isInteger(x)) throw ERR("#NUM!"); const g = Math.exp(lnGamma(x)); return x < 0 && Math.floor(-x) % 2 === 0 ? -g : g; },
  FISHER: (a) => { const x = num(a[0]); if (x <= -1 || x >= 1) throw ERR("#NUM!"); return 0.5 * Math.log((1 + x) / (1 - x)); },
  FISHERINV: (a) => { const y = num(a[0]); return (Math.exp(2 * y) - 1) / (Math.exp(2 * y) + 1); },
  "COVARIANCE.P": (a) => { const x = nums(a[0].list()), y = nums(a[1].list()); if (x.length !== y.length || !x.length) throw ERR("#N/A"); const mx = moments(x).mean, my = moments(y).mean; return x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / x.length; },
  "COVARIANCE.S": (a) => { const x = nums(a[0].list()), y = nums(a[1].list()); if (x.length !== y.length || x.length < 2) throw ERR("#DIV/0!"); const mx = moments(x).mean, my = moments(y).mean; return x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0) / (x.length - 1); },
  MAXA: (a) => { const xs = a.flatMap((x) => x.list()).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : v === null ? null : isErr(v) ? (() => { throw ERR(String(v)); })() : 0)).filter((v): v is number => v !== null); return xs.length ? Math.max(...xs) : 0; },
  MINA: (a) => { const xs = a.flatMap((x) => x.list()).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : v === null ? null : isErr(v) ? (() => { throw ERR(String(v)); })() : 0)).filter((v): v is number => v !== null); return xs.length ? Math.min(...xs) : 0; },
  AVERAGEA: (a) => { const xs = a.flatMap((x) => x.list()).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? v : v === null ? null : isErr(v) ? (() => { throw ERR(String(v)); })() : 0)).filter((v): v is number => v !== null); if (!xs.length) throw ERR("#DIV/0!"); return xs.reduce((s, x) => s + x, 0) / xs.length; },

  /* text & information */
  CLEAN: (a) => toStr(a[0].value()).replace(/[\x00-\x1f]/g, ""),
  T: (a) => { const v = a[0].value(); return typeof v === "string" && !isErr(v) ? v : ""; },
  FIXED: (a) => { const x = num(a[0]), d = Math.trunc(num(a[1], 2)); const noCommas = a[2] ? toBool(a[2].value()) : false; const f = 10 ** d; const r = Math.round(Math.abs(x) * f + 1e-9) / f; const s = d >= 0 ? r.toFixed(d) : String(Math.round(r)); const [i, frac] = s.split("."); return `${x < 0 && r !== 0 ? "-" : ""}${noCommas ? i : i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`; },
  DOLLAR: (a) => { const x = num(a[0]), d = Math.trunc(num(a[1], 2)); const f = 10 ** d; const r = Math.round(Math.abs(x) * f + 1e-9) / f; const s = d >= 0 ? r.toFixed(d) : String(Math.round(r)); const [i, frac] = s.split("."); const body = `$${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`; return x < 0 ? `(${body})` : body; }, // en-US
  "ERROR.TYPE": (a) => { let v: CellValue; try { v = a[0].value(); } catch (e) { v = (e as Error).message; } const codes = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"]; const i = typeof v === "string" ? codes.indexOf(v) : -1; if (i < 0) throw ERR("#N/A"); return i + 1; },
  TYPE: (a) => { if (a[0].isRange && a[0].grid().length * (a[0].grid()[0]?.length ?? 0) > 1) return 64; let v: CellValue; try { v = a[0].value(); } catch { return 16; } if (typeof v === "number" || v === null) return 1; if (typeof v === "boolean") return 4; if (isErr(v)) return 16; return 2; },
  ISFORMULA: () => { throw ERR("#N/A"); },

  /* date & time */
  DATEDIF: (a) => { // TT15 FIX: imported version returned 3 for ("2020-01-15","2024-03-10","Y") (should be 4) and #NUM! for "MD".
    const s = Math.floor(num(a[0])), e = Math.floor(num(a[1])); const unit = toStr(a[2].value()).toUpperCase();
    if (s > e) throw ERR("#NUM!");
    const A = ymd(s), B = ymd(e);
    let months = (B.y - A.y) * 12 + (B.m - A.m); if (B.d < A.d) months--;
    switch (unit) {
      case "D": return e - s;
      case "M": return months;
      case "Y": return Math.floor(months / 12);
      case "YM": return months % 12;
      case "MD": { if (B.d >= A.d) return B.d - A.d; const pm = B.m === 1 ? 12 : B.m - 1, py = B.m === 1 ? B.y - 1 : B.y; return daysInMonth(py, pm) - A.d + B.d; } // [disputed] Excel documents MD as unreliable; we borrow from the month before the end date
      case "YD": { let start = dateToSerial(new Date(Date.UTC(B.y, A.m - 1, A.d))); if (start > e) start = dateToSerial(new Date(Date.UTC(B.y - 1, A.m - 1, A.d))); return e - start; }
      default: throw ERR("#NUM!");
    }
  },
  TIME: (a) => { const t = (Math.trunc(num(a[0])) * 3600 + Math.trunc(num(a[1])) * 60 + Math.trunc(num(a[2]))) / 86400; if (t < 0) throw ERR("#NUM!"); return t - Math.floor(t); },
  HOUR: (a) => Math.floor(fracTime(a[0].value()) * 24 + 1e-9),
  MINUTE: (a) => Math.floor(((fracTime(a[0].value()) * 1440) + 1e-7) % 60),
  SECOND: (a) => Math.round(fracTime(a[0].value()) * 86400) % 60,
  TIMEVALUE: (a) => parseTimeText(toStr(a[0].value())),
  DATEVALUE: (a) => parseDateText(toStr(a[0].value())),
  WEEKNUM: (a) => {
    const s = Math.floor(num(a[0])); const type = Math.trunc(num(a[1], 1));
    if (type === 21) return isoWeek(s);
    const startDow: Record<number, number> = { 1: 0, 2: 1, 11: 1, 12: 2, 13: 3, 14: 4, 15: 5, 16: 6, 17: 0 };
    if (!(type in startDow)) throw ERR("#NUM!");
    const { y } = ymd(s); const jan1 = dateToSerial(new Date(Date.UTC(y, 0, 1)));
    const dow = (n: number) => serialToDate(n).getUTCDay();
    const offset = (dow(jan1) - startDow[type] + 7) % 7;
    return Math.floor((s - jan1 + offset) / 7) + 1;
  },
  ISOWEEKNUM: (a) => isoWeek(Math.floor(num(a[0]))),
  DAYS360: (a) => days360(Math.floor(num(a[0])), Math.floor(num(a[1])), a[2] ? toBool(a[2].value()) : false),
  YEARFRAC: (a) => {
    let s = Math.floor(num(a[0])), e = Math.floor(num(a[1])); const basis = Math.trunc(num(a[2], 0));
    if (s > e) [s, e] = [e, s];
    switch (basis) {
      case 0: return days360(s, e, false) / 360;
      case 1: { const A = ymd(s), B = ymd(e); if (A.y === B.y) return (e - s) / (isLeap(A.y) ? 366 : 365);
        const oneYear = (B.y === A.y + 1) && (B.m < A.m || (B.m === A.m && B.d <= A.d));
        if (oneYear) { const leapIn = (isLeap(A.y) && (A.m < 3)) || (isLeap(B.y) && (B.m > 2 || (B.m === 2 && B.d === 29))); return (e - s) / (leapIn ? 366 : 365); }
        let days = 0; for (let y = A.y; y <= B.y; y++) days += isLeap(y) ? 366 : 365; return (e - s) / (days / (B.y - A.y + 1)); }
      case 2: return (e - s) / 360;
      case 3: return (e - s) / 365;
      case 4: return days360(s, e, true) / 360;
      default: throw ERR("#NUM!");
    }
  },

  /* lookup */
  XMATCH: (a) => {
    const want = a[0].value(); const list = a[1].list(); const mode = Math.trunc(num(a[2], 0)); const search = Math.trunc(num(a[3], 1));
    const order = search < 0 ? [...list.keys()].reverse() : [...list.keys()];
    if (mode === 2) { const re = wildcardRe(toStr(want)); for (const i of order) if (typeof list[i] === "string" && re.test(list[i] as string)) return i + 1; throw ERR("#N/A"); }
    let best = -1;
    for (const i of order) {
      const v = list[i]; if (v === null) continue;
      const c = cmpLoose(v, want);
      if (c === 0) return i + 1;
      if (mode === -1 && c < 0 && (best < 0 || cmpLoose(v, list[best]) > 0)) best = i;
      if (mode === 1 && c > 0 && (best < 0 || cmpLoose(v, list[best]) < 0)) best = i;
    }
    if (best >= 0) return best + 1;
    throw ERR("#N/A");
  },
  LOOKUP: (a) => {
    const want = a[0].value();
    let keys: CellValue[], vals: CellValue[];
    if (a[1] && a[2]) { keys = a[1].list(); vals = a[2].list(); }
    else { const g = a[1].grid(); const wide = (g[0]?.length ?? 0) > g.length; keys = wide ? g[0] : g.map((r) => r[0]); vals = wide ? g[g.length - 1] : g.map((r) => r[r.length - 1]); }
    let hit = -1;
    for (let i = 0; i < keys.length; i++) { const k = keys[i]; if (k === null) continue; if (cmpLoose(k, want) <= 0) hit = i; else break; } // approximate match on ascending data
    if (hit < 0) throw ERR("#N/A");
    return vals[hit] ?? null;
  },
};

function isoWeek(s: number): number {
  const d = serialToDate(s); const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  const thursday = new Date(d.getTime() + (3 - dow) * 86400000);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - yearStart) / 86400000 / 7) + 1;
}
void need;
