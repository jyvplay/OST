/**
 * FF-32 vector geometry core (TT16, first-party; pure TypeScript).
 *
 * Paths are normalised to ABSOLUTE M / L / C / Z segments:
 *  - H/V → L; Q/T → exact cubic elevation (C1 = P0 + 2/3(Q−P0), C2 = P + 2/3(Q−P)); S/T reflect the previous
 *    control point per SVG 1.1 §8.3.6/§8.3.7 (reflection only after C/S resp. Q/T, else the current point).
 *  - A → cubics via the SVG 1.1 Implementation Notes F.6.5 endpoint→centre conversion (radii scaled up by √Λ when too
 *    small, F.6.6), split into ≤ 90° pieces with k = 4/3·tan(Δ/4); max radial error ≈ 2.7·10⁻⁴·r.
 *    Zero radius → straight line; identical endpoints → arc omitted (F.6.2).
 *  - Error handling per SVG 1.1 F.2: render up to the last complete segment; the error is reported.
 * Bounds are exact (cubic derivative roots). Length is adaptive subdivision to 1e-4 px flatness.
 * Verified against svgelements (Python) and Chromium's SVG engine (getBBox / getTotalLength / isPointInFill).
 */

export type Matrix = [number, number, number, number, number, number]; // a b c d e f  (x' = a x + c y + e)
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
export type Seg = { t: "M"; x: number; y: number } | { t: "L"; x: number; y: number } | { t: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number } | { t: "Z" };
export interface Box { x: number; y: number; w: number; h: number }

/* ================================================================ matrices */
export const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export const scaleM = (sx: number, sy = sx): Matrix => [sx, 0, 0, sy, 0, 0];
export function rotateM(deg: number, cx = 0, cy = 0): Matrix {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return mul(mul(translate(cx, cy), [c, s, -s, c, 0, 0]), translate(-cx, -cy));
}
export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) throw new Error("singular matrix");
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export const isIdentity = (m: Matrix) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-12);
/** Decompose into translate · rotate · scale (+ skew folded into sy sign); for the rotation readout only. */
export function rotationOf(m: Matrix): number { return Math.atan2(m[1], m[0]) * 180 / Math.PI; }

const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
/** SVG transform list: matrix, translate, scale, rotate, skewX, skewY (comma/space separated, any order). */
export function parseTransform(src: string | undefined): Matrix {
  let m: Matrix = IDENTITY;
  if (!src) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(src))) {
    const a = (hit[2].match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
    let t: Matrix = IDENTITY;
    switch (hit[1]) {
      case "matrix": if (a.length === 6) t = a as Matrix; break;
      case "translate": t = translate(a[0] ?? 0, a[1] ?? 0); break;
      case "scale": t = scaleM(a[0] ?? 1, a[1] ?? a[0] ?? 1); break;
      case "rotate": t = rotateM(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0); break;
      case "skewX": t = [1, 0, Math.tan((a[0] ?? 0) * Math.PI / 180), 1, 0, 0]; break;
      case "skewY": t = [1, Math.tan((a[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}
export const fmt = (v: number, p = 3) => { const r = Number(v.toFixed(p)); return Object.is(r, -0) ? "0" : String(r); };
export const matrixAttr = (m: Matrix) => (isIdentity(m) ? "" : `matrix(${m.map((v) => fmt(v, 6)).join(" ")})`);

/* ================================================================ path parsing */
export interface ParseResult { segs: Seg[]; error?: string }
export function parsePath(d: string): ParseResult {
  const segs: Seg[] = [];
  let i = 0;
  const n = d.length;
  let cx = 0, cy = 0, sx = 0, sy = 0;           // current + subpath start
  let lastC: [number, number] | null = null;    // last cubic control (for S)
  let lastQ: [number, number] | null = null;    // last quadratic control (for T)
  let cmd = "";
  const ws = () => { while (i < n && /[\s,]/.test(d[i])) i++; };
  const num = (): number => {
    ws();
    const m = NUM.exec(d.slice(i, i + 64));
    if (!m) throw new Error(`expected a number at ${i}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number => {
    ws();
    if (d[i] !== "0" && d[i] !== "1") throw new Error(`expected an arc flag (0/1) at ${i}`);
    return Number(d[i++]);
  };
  const atNumber = () => { ws(); return i < n && /[+\-.\d]/.test(d[i]); };
  try {
    ws();
    while (i < n) {
      if (/[a-zA-Z]/.test(d[i])) { cmd = d[i++]; }
      else if (!cmd) throw new Error(`path must start with a command (at ${i})`);
      else if (!atNumber()) throw new Error(`unexpected '${d[i]}' at ${i}`);
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (!segs.length && C !== "M") throw new Error("path must start with M/m");
      const pending: Seg[] = [];
      switch (C) {
        case "M": {
          let x = num(), y = num(); if (rel) { x += cx; y += cy; }
          pending.push({ t: "M", x, y }); cx = sx = x; cy = sy = y;
          cmd = rel ? "l" : "L"; // implicit lineto for further pairs
          lastC = lastQ = null; break;
        }
        case "L": { let x = num(), y = num(); if (rel) { x += cx; y += cy; } pending.push({ t: "L", x, y }); cx = x; cy = y; lastC = lastQ = null; break; }
        case "H": { let x = num(); if (rel) x += cx; pending.push({ t: "L", x, y: cy }); cx = x; lastC = lastQ = null; break; }
        case "V": { let y = num(); if (rel) y += cy; pending.push({ t: "L", x: cx, y }); cy = y; lastC = lastQ = null; break; }
        case "C": {
          let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
          if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
          pending.push({ t: "C", x1, y1, x2, y2, x, y }); lastC = [x2, y2]; lastQ = null; cx = x; cy = y; break;
        }
        case "S": {
          let x2 = num(), y2 = num(), x = num(), y = num();
          if (rel) { x2 += cx; y2 += cy; x += cx; y += cy; }
          const [x1, y1] = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy];
          pending.push({ t: "C", x1, y1, x2, y2, x, y }); lastC = [x2, y2]; lastQ = null; cx = x; cy = y; break;
        }
        case "Q": {
          let qx = num(), qy = num(), x = num(), y = num();
          if (rel) { qx += cx; qy += cy; x += cx; y += cy; }
          pending.push(quadToCubic(cx, cy, qx, qy, x, y)); lastQ = [qx, qy]; lastC = null; cx = x; cy = y; break;
        }
        case "T": {
          let x = num(), y = num(); if (rel) { x += cx; y += cy; }
          const qx: number = lastQ ? 2 * cx - lastQ[0] : cx, qy: number = lastQ ? 2 * cy - lastQ[1] : cy;
          pending.push(quadToCubic(cx, cy, qx, qy, x, y)); lastQ = [qx, qy]; lastC = null; cx = x; cy = y; break;
        }
        case "A": {
          const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
          let x = num(), y = num(); if (rel) { x += cx; y += cy; }
          pending.push(...arcToCubics(cx, cy, rx, ry, rot, large, sweep, x, y)); cx = x; cy = y; lastC = lastQ = null; break;
        }
        case "Z": { pending.push({ t: "Z" }); cx = sx; cy = sy; lastC = lastQ = null; ws(); if (i < n && !/[a-zA-Z]/.test(d[i])) throw new Error(`unexpected number after Z at ${i}`); break; }
        default: throw new Error(`unknown command '${cmd}'`);
      }
      segs.push(...pending);
      ws();
    }
    return { segs };
  } catch (e) {
    return { segs, error: (e as Error).message };
  }
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): Seg {
  return { t: "C", x1: x0 + 2 / 3 * (qx - x0), y1: y0 + 2 / 3 * (qy - y0), x2: x + 2 / 3 * (qx - x), y2: y + 2 / 3 * (qy - y), x, y };
}

export function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, fa: number, fs: number, x2: number, y2: number): Seg[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ t: "L", x: x2, y: y2 }];
  const phi = (phiDeg % 360) * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) coef = -coef;
  const cxp = coef * (rx * y1p / ry), cyp = coef * (-ry * x1p / rx);
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (fs && dtheta < 0) dtheta += 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2) - 1e-9));
  const delta = dtheta / pieces, k = 4 / 3 * Math.tan(delta / 4);
  const pt = (t: number): [number, number] => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const dpt = (t: number): [number, number] => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: Seg[] = [];
  let t = theta1;
  for (let p = 0; p < pieces; p++) {
    const t2 = t + delta;
    const [ax, ay] = pt(t), [bx, by] = p === pieces - 1 ? [x2, y2] : pt(t2);
    const [dax, day] = dpt(t), [dbx, dby] = dpt(t2);
    out.push({ t: "C", x1: ax + k * dax, y1: ay + k * day, x2: bx - k * dbx, y2: by - k * dby, x: bx, y: by });
    t = t2;
  }
  return out;
}

export function serializePath(segs: Seg[], p = 3): string {
  return segs.map((s) => s.t === "Z" ? "Z" : s.t === "C" ? `C${fmt(s.x1, p)} ${fmt(s.y1, p)} ${fmt(s.x2, p)} ${fmt(s.y2, p)} ${fmt(s.x, p)} ${fmt(s.y, p)}` : `${s.t}${fmt(s.x, p)} ${fmt(s.y, p)}`).join(" ");
}

export function transformPath(segs: Seg[], m: Matrix): Seg[] {
  return segs.map((s) => {
    if (s.t === "Z") return s;
    if (s.t === "C") { const [x1, y1] = apply(m, s.x1, s.y1), [x2, y2] = apply(m, s.x2, s.y2), [x, y] = apply(m, s.x, s.y); return { t: "C", x1, y1, x2, y2, x, y }; }
    const [x, y] = apply(m, s.x, s.y); return { t: s.t, x, y };
  });
}

/* ================================================================ measurement */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = p1 - p0, b = p2 - p1, c = p3 - p2;
  const A = a - 2 * b + c, B = 2 * (b - a), C = a;
  const ts: number[] = [];
  if (Math.abs(A) < 1e-12) { if (Math.abs(B) > 1e-12) ts.push(-C / B); }
  else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) { const r = Math.sqrt(disc); ts.push((-B + r) / (2 * A), (-B - r) / (2 * A)); }
  }
  return ts.filter((t) => t > 0 && t < 1);
}
const bez = (p0: number, p1: number, p2: number, p3: number, t: number) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };

/** Exact geometric bounds (like SVGGraphicsElement.getBBox(): no stroke, transforms applied to points). */
export function pathBounds(segs: Seg[], m: Matrix = IDENTITY): Box | null {
  const pts = transformPath(segs, m);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const s of pts) {
    if (s.t === "M") { cx = sx = s.x; cy = sy = s.y; add(cx, cy); }
    else if (s.t === "L") { cx = s.x; cy = s.y; add(cx, cy); }
    else if (s.t === "C") {
      add(s.x, s.y);
      for (const t of cubicExtrema(cx, s.x1, s.x2, s.x)) add(bez(cx, s.x1, s.x2, s.x, t), bez(cy, s.y1, s.y2, s.y, t));
      for (const t of cubicExtrema(cy, s.y1, s.y2, s.y)) add(bez(cx, s.x1, s.x2, s.x, t), bez(cy, s.y1, s.y2, s.y, t));
      cx = s.x; cy = s.y;
    } else { cx = sx; cy = sy; }
  }
  return x1 < x0 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Flatten to polylines (one per subpath), adaptive subdivision until control points are within `tol` of the chord. */
export function flatten(segs: Seg[], tol = 0.05): { pts: [number, number][]; closed: boolean }[] {
  const out: { pts: [number, number][]; closed: boolean }[] = [];
  let cur: { pts: [number, number][]; closed: boolean } | null = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const sub = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, depth: number) => {
    const dx = x3 - x0, dy = y3 - y0, L = Math.hypot(dx, dy) || 1e-12;
    const d1 = Math.abs((x1 - x0) * dy - (y1 - y0) * dx) / L, d2 = Math.abs((x2 - x0) * dy - (y2 - y0) * dx) / L;
    if (depth > 18 || Math.max(d1, d2) <= tol) { cur!.pts.push([x3, y3]); return; }
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2, x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2, x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
    const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2, xb = (x12 + x23) / 2, yb = (y12 + y23) / 2, xm = (xa + xb) / 2, ym = (ya + yb) / 2;
    sub(x0, y0, x01, y01, xa, ya, xm, ym, depth + 1); sub(xm, ym, xb, yb, x23, y23, x3, y3, depth + 1);
  };
  for (const s of segs) {
    if (s.t === "M") { cur = { pts: [[s.x, s.y]], closed: false }; out.push(cur); cx = sx = s.x; cy = sy = s.y; continue; }
    if (!cur) { cur = { pts: [[cx, cy]], closed: false }; out.push(cur); }
    if (s.t === "L") { cur.pts.push([s.x, s.y]); cx = s.x; cy = s.y; }
    else if (s.t === "C") { sub(cx, cy, s.x1, s.y1, s.x2, s.y2, s.x, s.y, 0); cx = s.x; cy = s.y; }
    else { cur.closed = true; cur.pts.push([sx, sy]); cx = sx; cy = sy; cur = null; }
  }
  return out;
}

/** Total length (matches SVGGeometryElement.getTotalLength(): Z adds the closing segment). */
export function pathLength(segs: Seg[]): number {
  let L = 0;
  for (const p of flatten(segs, 1e-4)) for (let i = 1; i < p.pts.length; i++) L += Math.hypot(p.pts[i][0] - p.pts[i - 1][0], p.pts[i][1] - p.pts[i - 1][1]);
  return L;
}

/** Fill containment with the SVG fill rules (open subpaths are implicitly closed for filling). */
export function containsPoint(segs: Seg[], x: number, y: number, rule: "nonzero" | "evenodd" = "nonzero"): boolean {
  let wind = 0, cross = 0;
  for (const p of flatten(segs, 0.02)) {
    const pts = p.pts;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
      if ((ay <= y) !== (by <= y)) {
        const xi = ax + (y - ay) * (bx - ax) / (by - ay);
        if (xi > x) { cross++; wind += by > ay ? 1 : -1; }
      }
    }
  }
  return rule === "evenodd" ? cross % 2 === 1 : wind !== 0;
}

/** Shortest distance from a point to the path outline. */
export function distanceToPath(segs: Seg[], x: number, y: number): number {
  let best = Infinity;
  for (const p of flatten(segs, 0.05)) for (let i = 1; i < p.pts.length; i++) {
    const [ax, ay] = p.pts[i - 1], [bx, by] = p.pts[i];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/* ================================================================ primitives → paths */
const KAPPA = 0.5522847498307936; // 4/3·(√2 − 1)
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): Seg[] {
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    { t: "M", x: cx + rx, y: cy },
    { t: "C", x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { t: "C", x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { t: "C", x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { t: "C", x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { t: "Z" },
  ];
}
export function rectPath(x: number, y: number, w: number, h: number, rx = 0, ry = rx): Seg[] {
  rx = Math.min(Math.abs(rx), w / 2); ry = Math.min(Math.abs(ry), h / 2);
  if (!rx || !ry) return [{ t: "M", x, y }, { t: "L", x: x + w, y }, { t: "L", x: x + w, y: y + h }, { t: "L", x, y: y + h }, { t: "Z" }];
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    { t: "M", x: x + rx, y }, { t: "L", x: x + w - rx, y },
    { t: "C", x1: x + w - rx + kx, y1: y, x2: x + w, y2: y + ry - ky, x: x + w, y: y + ry },
    { t: "L", x: x + w, y: y + h - ry },
    { t: "C", x1: x + w, y1: y + h - ry + ky, x2: x + w - rx + kx, y2: y + h, x: x + w - rx, y: y + h },
    { t: "L", x: x + rx, y: y + h },
    { t: "C", x1: x + rx - kx, y1: y + h, x2: x, y2: y + h - ry + ky, x, y: y + h - ry },
    { t: "L", x, y: y + ry },
    { t: "C", x1: x, y1: y + ry - ky, x2: x + rx - kx, y2: y, x: x + rx, y },
    { t: "Z" },
  ];
}
export function polyPath(points: number[], closed: boolean): Seg[] {
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) segs.push(i === 0 ? { t: "M", x: points[0], y: points[1] } : { t: "L", x: points[i], y: points[i + 1] });
  if (closed && segs.length) segs.push({ t: "Z" });
  return segs;
}
/** Regular polygon (inner = 0) or star (inner > 0) points, first vertex pointing up. */
export function starPoints(cx: number, cy: number, outer: number, inner: number, n: number): number[] {
  const pts: number[] = [];
  const count = inner > 0 ? n * 2 : n;
  for (let i = 0; i < count; i++) {
    const r = inner > 0 && i % 2 ? inner : outer, a = -Math.PI / 2 + i * Math.PI * 2 / count;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}
export function parsePoints(s: string | undefined): number[] {
  const a = (s ?? "").match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g)?.map(Number) ?? [];
  return a.length % 2 ? a.slice(0, -1) : a; // odd count: last coordinate ignored (SVG 1.1 error handling)
}
