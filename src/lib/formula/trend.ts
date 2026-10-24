/**
 * TT50 — chart trendlines, the six types Excel offers (DrawingML c:trendlineType: linear, exp, log, power, poly,
 * movingAvg), written from the textbook least-squares definitions (no code borrowed):
 *
 *   linear     y = m·x + b            ordinary least squares; with a fixed intercept b0 (c:intercept) m = Σx(y−b0)/Σx²
 *   exp        y = b·e^(m·x)          OLS on ln y            (every y > 0, else no trendline — Excel refuses too)
 *   log        y = a·ln x + b         OLS on ln x            (every x > 0)
 *   power      y = b·x^m              OLS on ln x, ln y      (every x, y > 0)
 *   poly k     y = Σ c_j x^j, k=2..6  normal equations on CENTRED + SCALED x (t = (x−x̄)/s) solved with partial
 *                                     pivoting, then expanded back to powers of x for the equation label
 *   movingAvg  p = 2..255             mean of the last p points (blank points skipped)
 *
 * R² is reported the way Excel's trendline label (and LINEST) computes it: on the fitted scale (ln y for exp/power),
 * with the uncentred total sum of squares when the intercept is fixed. Category charts use x = 1..n like Excel.
 */
export type TrendType = "linear" | "exp" | "log" | "power" | "poly" | "movingAvg";
export const TREND_TYPES: readonly TrendType[] = ["linear", "exp", "log", "power", "poly", "movingAvg"];
export interface TrendSpec { type: TrendType; order?: number; period?: number; forward?: number; backward?: number; intercept?: number; dispEq?: boolean; dispRSqr?: boolean; name?: string }
export interface TrendFit {
  type: TrendType;
  /** y at x (NaN outside the model's domain, e.g. x ≤ 0 for log/power) */
  predict: (x: number) => number;
  /** linear: [b, m]; exp/power: [b, m]; log: [b, a]; poly: [c0..ck] in powers of x */
  coef: number[];
  r2: number;
  /** moving average: the averaged points (x, y) */
  points?: [number, number][];
}

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

function ols(xs: number[], ys: number[], b0?: number): { m: number; b: number; r2: number } {
  const n = xs.length;
  if (b0 !== undefined) {
    const sxx = sum(xs.map((x) => x * x)); if (!(sxx > 0)) throw new Error("trendline needs x values other than 0");
    const m = sum(xs.map((x, i) => x * (ys[i] - b0))) / sxx;
    const ssr = sum(ys.map((y, i) => (y - (m * xs[i] + b0)) ** 2)), sst = sum(ys.map((y) => y * y)); // LINEST const=FALSE: uncentred
    return { m, b: b0, r2: sst > 0 ? 1 - ssr / sst : 1 };
  }
  const mx = sum(xs) / n, my = sum(ys) / n;
  const sxx = sum(xs.map((x) => (x - mx) ** 2)), sxy = sum(xs.map((x, i) => (x - mx) * (ys[i] - my)));
  if (!(sxx > 0)) throw new Error("trendline needs at least two different x values");
  const m = sxy / sxx, b = my - m * mx;
  const ssr = sum(ys.map((y, i) => (y - (m * xs[i] + b)) ** 2)), sst = sum(ys.map((y) => (y - my) ** 2));
  return { m, b, r2: sst > 0 ? 1 - ssr / sst : 1 };
}

/** Solves A·x = b (n ≤ 7) by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (!(Math.abs(M[p][c]) > 1e-300)) throw new Error("polynomial trendline: too few distinct x values for this order");
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}
const binom = (n: number, k: number) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };

/**
 * Fits a trendline to the points (x[i], y[i]); null entries are skipped (blank cells). Throws with a user-facing
 * reason when the type cannot be fitted to these data (Excel greys the option out in the same cases).
 */
export function fitTrend(spec: TrendSpec, xs0: (number | null)[], ys0: (number | null)[]): TrendFit {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < ys0.length; i++) { const x = xs0[i], y = ys0[i]; if (x !== null && y !== null && Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); } }
  const t = spec.type;
  if (t === "movingAvg") {
    const p = Math.max(2, Math.min(255, Math.floor(spec.period ?? 2)));
    if (ys.length < p) throw new Error(`moving average needs at least ${p} points`);
    const points: [number, number][] = [];
    for (let i = p - 1; i < ys.length; i++) points.push([xs[i], sum(ys.slice(i - p + 1, i + 1)) / p]);
    const predict = (x: number) => { let best = NaN; for (const [px, py] of points) if (px <= x) best = py; return best; };
    return { type: t, predict, coef: [], r2: NaN, points };
  }
  if (xs.length < 2) throw new Error("a trendline needs at least two points");
  if (t === "linear") { const { m, b, r2 } = ols(xs, ys, spec.intercept); return { type: t, coef: [b, m], r2, predict: (x) => m * x + b }; }
  if (t === "exp") {
    if (ys.some((y) => y <= 0)) throw new Error("an exponential trendline needs positive values");
    const { m, b, r2 } = ols(xs, ys.map(Math.log), spec.intercept !== undefined && spec.intercept > 0 ? Math.log(spec.intercept) : undefined);
    const B = Math.exp(b); return { type: t, coef: [B, m], r2, predict: (x) => B * Math.exp(m * x) };
  }
  if (t === "log") {
    if (xs.some((x) => x <= 0)) throw new Error("a logarithmic trendline needs positive x values");
    const { m, b, r2 } = ols(xs.map(Math.log), ys); return { type: t, coef: [b, m], r2, predict: (x) => (x > 0 ? m * Math.log(x) + b : NaN) };
  }
  if (t === "power") {
    if (xs.some((x) => x <= 0) || ys.some((y) => y <= 0)) throw new Error("a power trendline needs positive x and y values");
    const { m, b, r2 } = ols(xs.map(Math.log), ys.map(Math.log)); const B = Math.exp(b);
    return { type: t, coef: [B, m], r2, predict: (x) => (x > 0 ? B * x ** m : NaN) };
  }
  // polynomial
  const k = Math.max(2, Math.min(6, Math.floor(spec.order ?? 2)));
  if (new Set(xs).size <= k) throw new Error(`a polynomial trendline of order ${k} needs at least ${k + 1} different x values`);
  const mx = sum(xs) / xs.length; const s = Math.sqrt(sum(xs.map((x) => (x - mx) ** 2)) / xs.length) || 1;
  const ts = xs.map((x) => (x - mx) / s);
  const A = Array.from({ length: k + 1 }, (_, i) => Array.from({ length: k + 1 }, (_, j) => sum(ts.map((v) => v ** (i + j)))));
  const rhs = Array.from({ length: k + 1 }, (_, i) => sum(ts.map((v, n) => v ** i * ys[n])));
  const a = solve(A, rhs); // y = Σ a_i t^i
  const pt = (x: number) => { const v = (x - mx) / s; let r = 0; for (let i = k; i >= 0; i--) r = r * v + a[i]; return r; };
  // expand Σ a_i ((x − mx)/s)^i into Σ c_j x^j (for the equation label / comparison with numpy.polyfit)
  const c = new Array<number>(k + 1).fill(0);
  for (let i = 0; i <= k; i++) for (let j = 0; j <= i; j++) c[j] += a[i] * binom(i, j) * (-mx) ** (i - j) / s ** i;
  const my = sum(ys) / ys.length;
  const ssr = sum(ys.map((y, n) => (y - pt(xs[n])) ** 2)), sst = sum(ys.map((y) => (y - my) ** 2));
  return { type: "poly", coef: c, r2: sst > 0 ? 1 - ssr / sst : 1, predict: pt };
}

/** Excel-style label number: up to 4 decimals, trailing zeros trimmed (Excel's default label format is General). */
const num = (v: number) => { if (!Number.isFinite(v)) return "?"; const a = Math.abs(v); const s = a !== 0 && (a < 1e-4 || a >= 1e9) ? v.toExponential(4).replace(/\.?0+e/, "E") : String(Number(v.toFixed(4))); return s; };
const signed = (v: number, term: string) => `${v < 0 ? " - " : " + "}${num(Math.abs(v))}${term}`;
/** The trendline label text ("y = 2x + 1", "R² = 0.9936") as Excel displays it for each type. */
export function trendLabel(f: TrendFit, eq: boolean, r2: boolean): string[] {
  const out: string[] = [];
  if (eq && f.type !== "movingAvg") {
    const [a, b] = f.coef;
    if (f.type === "linear") out.push(`y = ${num(b)}x${a === 0 ? "" : signed(a, "")}`);
    else if (f.type === "exp") out.push(`y = ${num(a)}e^${num(b)}x`);
    else if (f.type === "log") out.push(`y = ${num(b)}ln(x)${signed(a, "")}`);
    else if (f.type === "power") out.push(`y = ${num(a)}x^${num(b)}`);
    else { const c = f.coef; let s = ""; for (let j = c.length - 1; j >= 0; j--) { const term = j === 0 ? "" : j === 1 ? "x" : `x^${j}`; s += j === c.length - 1 ? `${num(c[j])}${term}` : signed(c[j], term); } out.push(`y = ${s}`); }
  }
  if (r2 && f.type !== "movingAvg" && Number.isFinite(f.r2)) out.push(`R² = ${num(f.r2)}`);
  return out;
}
