/**
 * TT26 — the "beauty standard": pure rules over measured element boxes. scripts/e2e-beauty.mts measures every view
 * in a real Chromium (Fusion / Business / Art, the Start menu, Launchpad, dock stacks, the Tabletop floor and each
 * wall as the main view, the desktop icons) and feeds the boxes through these rules; scripts/tabletop-unit.mts
 * checks the rules themselves (each one must catch a seeded violation).
 *
 * What is a hard rule and what is only reported, and why (sources in docs/DESIGN-TABLETOP-TT26.md):
 *   HARD  target-size     WCAG 2.2 SC 2.5.8 (AA): ≥24×24 CSS px, or the spacing exception (a 24 px circle centred
 *                         on the target does not intersect another target or its circle). Inline links exempt.
 *   HARD  chrome-target   shell chrome (dock, taskbar, Start, Launchpad, Tabletop) ≥ 32 px — between the 2.5.8
 *                         floor and the 44 pt (Apple) / 48 dp (Material) comfort sizes.
 *   HARD  overlap         interactive targets in the same region must not overlap (ambiguous hits).
 *   HARD  clipped-text    text cut off without an ellipsis (overflow hidden, scrollWidth > clientWidth).
 *   HARD  offscreen       chrome targets must lie inside the viewport.
 *   HARD  square-icon     app icons render square (|w − h| ≤ 1 px).
 *   HARD  dock-band       dock icons at rest sit in the aesthetic band (44–64 px; ≥32 only when the screen is too
 *                         narrow) and are all the same size; the dock never spans more than 90 % of the screen.
 *   HARD  rhythm          a row of chrome items has one consistent gap (σ ≤ 1 px) and one centre line (≤ 1 px) —
 *                         Ngo, Teo & Byrne's regularity/alignment measures, made binary.
 *   HARD  equilibrium     a centred element (dock, Launchpad grid, wall content) is centred within 2 % of the frame
 *                         — Ngo et al.'s equilibrium measure.
 *   HARD  line-height     paragraphs (≥ 2 lines) have line-height ≥ 1.4× the font size (WCAG 1.4.12 requires the
 *                         page to survive 1.5×; typographic guides converge on 1.4–1.6 for body text).
 *   SOFT  proportion      panels/cards near a "pleasing" rectangle: within ±6 % of φ (1.618), 5:3, 3:2 or √2.
 *                         Reported, never failed: the evidence for φ specifically is mixed (several studies find
 *                         √2 or 1.5 preferred, others no effect). Tabletop cards are designed as 1:φ and DO fail if
 *                         they drift (that is a regression of our own design, not a claim about φ).
 *   SOFT  type-scale      ratios between adjacent font sizes in a view, reported against the 1.125–1.618 band of
 *                         modular scales; more than 8 distinct sizes in one view is flagged (Ngo "economy").
 */
export const PHI = (1 + Math.sqrt(5)) / 2;
export const PLEASING = [{ name: "φ", r: PHI }, { name: "5:3", r: 5 / 3 }, { name: "3:2", r: 1.5 }, { name: "√2", r: Math.SQRT2 }] as const;

export interface Box {
  id: string;
  x: number; y: number; w: number; h: number;
  /** interactive control (button, link, input, role=button …) */
  interactive?: boolean;
  /** shell chrome: dock, taskbar, Start, Launchpad, tabletop */
  chrome?: boolean;
  /** inline link inside running text (2.5.8 inline exception) */
  inline?: boolean;
  region?: string;
  /** text element: overflow clips and the text is wider/taller than the box */
  clipped?: boolean;
  ellipsis?: boolean;
  fontSize?: number;
  lineHeight?: number;
  lines?: number;
  icon?: boolean;
  /** inside a scroll container that can scroll it into view (exempt from `offscreen`, not from anything else) */
  scrolled?: boolean;
}
export interface Violation { rule: string; id: string; detail: string; hard: boolean }

const inter = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const contains = (a: Box, b: Box) => b.x >= a.x - 0.5 && b.y >= a.y - 0.5 && b.x + b.w <= a.x + a.w + 0.5 && b.y + b.h <= a.y + a.h + 0.5;
const cx = (b: Box) => b.x + b.w / 2, cy = (b: Box) => b.y + b.h / 2;
/** distance from point to rectangle (0 inside) */
const distToRect = (px: number, py: number, b: Box) => Math.hypot(Math.max(b.x - px, 0, px - (b.x + b.w)), Math.max(b.y - py, 0, py - (b.y + b.h)));
const r1 = (v: number) => Math.round(v * 10) / 10;

/** WCAG 2.5.8 with its spacing exception. */
export function targetSize(boxes: readonly Box[], min = 24): Violation[] {
  const t = boxes.filter((b) => b.interactive && !b.inline && b.w > 1 && b.h > 1);
  const out: Violation[] = [];
  for (const b of t) {
    if (b.w >= min - 0.5 && b.h >= min - 0.5) continue;
    const px = cx(b), py = cy(b), rad = min / 2;
    const crowded = t.some((o) => o !== b && !contains(o, b) && !contains(b, o) &&
      ((o.w < min - 0.5 || o.h < min - 0.5) ? Math.hypot(cx(o) - px, cy(o) - py) < 2 * rad : distToRect(px, py, o) < rad));
    if (crowded) out.push({ rule: "target-size", id: b.id, detail: `${r1(b.w)}×${r1(b.h)} < ${min} and a neighbour is inside its 24 px circle`, hard: true });
  }
  return out;
}

/**
 * Chrome floor. With the viewport size given, a target that touches a screen edge counts as unbounded in the direction
 * of that edge (Fitts's law: the pointer stops at the edge, so the effective depth is infinite) — e.g. the
 * Windows-style "show desktop" sliver at the right edge is judged on its height only.
 */
export function chromeTarget(boxes: readonly Box[], min = 32, vw?: number, vh?: number): Violation[] {
  const edgeX = (b: Box) => vw !== undefined && (b.x <= 0.5 || b.x + b.w >= vw - 0.5);
  const edgeY = (b: Box) => vh !== undefined && (b.y <= 0.5 || b.y + b.h >= vh - 0.5);
  return boxes.filter((b) => b.interactive && b.chrome && !b.inline && b.w > 1 && b.h > 1 && ((b.w < min - 0.5 && !edgeX(b)) || (b.h < min - 0.5 && !edgeY(b))))
    .map((b) => ({ rule: "chrome-target", id: b.id, detail: `${r1(b.w)}×${r1(b.h)} < ${min}`, hard: true }));
}

export function overlaps(boxes: readonly Box[], tol = 1): Violation[] {
  const t = boxes.filter((b) => b.interactive && b.w > 1 && b.h > 1);
  const out: Violation[] = [];
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    const a = t[i], b = t[j];
    if ((a.region ?? "") !== (b.region ?? "") || contains(a, b) || contains(b, a)) continue;
    const area = inter(a, b);
    if (area > tol) out.push({ rule: "overlap", id: `${a.id} × ${b.id}`, detail: `${r1(area)} px² shared`, hard: true });
  }
  return out;
}

export const clippedText = (boxes: readonly Box[]): Violation[] =>
  boxes.filter((b) => b.clipped && !b.ellipsis).map((b) => ({ rule: "clipped-text", id: b.id, detail: "text cut off without an ellipsis", hard: true }));

export const offscreen = (boxes: readonly Box[], vw: number, vh: number): Violation[] =>
  boxes.filter((b) => b.chrome && b.interactive && !b.scrolled && b.w > 1 && (b.x < -1 || b.y < -1 || b.x + b.w > vw + 1 || b.y + b.h > vh + 1))
    .map((b) => ({ rule: "offscreen", id: b.id, detail: `${r1(b.x)},${r1(b.y)} ${r1(b.w)}×${r1(b.h)} outside ${vw}×${vh}`, hard: true }));

export const squareIcons = (boxes: readonly Box[]): Violation[] =>
  boxes.filter((b) => b.icon && b.w > 1 && Math.abs(b.w - b.h) > 1).map((b) => ({ rule: "square-icon", id: b.id, detail: `${r1(b.w)}×${r1(b.h)}`, hard: true }));

/** Dock icons at rest: one size, inside the band, dock ≤ 90 % of the viewport width. */
export function dockBand(icons: readonly Box[], dock: Box | null, vw: number, band = { min: 44, max: 64, floor: 32 }): Violation[] {
  const out: Violation[] = [];
  if (!icons.length || !dock) return out;
  const sizes = icons.map((b) => Math.round(b.w));
  const s = sizes[0];
  if (sizes.some((v) => Math.abs(v - s) > 1)) out.push({ rule: "dock-band", id: "dock", detail: `uneven resting sizes ${[...new Set(sizes)].join("/")}`, hard: true });
  const narrow = vw < 600;
  if (s > band.max + 0.5 || s < (narrow ? band.floor : band.min) - 0.5) out.push({ rule: "dock-band", id: "dock", detail: `icon ${s}px outside ${narrow ? band.floor : band.min}–${band.max}`, hard: true });
  if (dock.w > vw * 0.9 + 1) out.push({ rule: "dock-band", id: "dock", detail: `dock ${r1(dock.w)}px > 90% of ${vw}`, hard: true });
  return out;
}

/** Ngo regularity + alignment for one row of items (left-to-right). */
export function rhythm(row: readonly Box[], name: string, tol = 1): Violation[] {
  if (row.length < 3) return [];
  const s = [...row].sort((a, b) => a.x - b.x);
  const gaps = s.slice(1).map((b, i) => b.x - (s[i].x + s[i].w));
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  const ys = s.map(cy), yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const out: Violation[] = [];
  if (sd > tol) out.push({ rule: "rhythm", id: name, detail: `gap σ ${r1(sd)}px (gaps ${gaps.map(r1).join(",")})`, hard: true });
  const dev = Math.max(...ys.map((y) => Math.abs(y - yMean)));
  if (dev > tol) out.push({ rule: "rhythm", id: name, detail: `centre line off by ${r1(dev)}px`, hard: true });
  return out;
}

/** Ngo equilibrium: the box's centre vs the frame's centre, as a share of the frame size. */
export function equilibrium(b: Box, frame: Box, name: string, tol = 0.02, axes: "x" | "xy" = "x"): Violation[] {
  const dx = Math.abs(cx(b) - cx(frame)) / frame.w, dy = Math.abs(cy(b) - cy(frame)) / frame.h;
  const bad = dx > tol || (axes === "xy" && dy > tol);
  return bad ? [{ rule: "equilibrium", id: name, detail: `off-centre ${r1(dx * 100)}% x${axes === "xy" ? `, ${r1(dy * 100)}% y` : ""}`, hard: true }] : [];
}

export const lineHeight = (boxes: readonly Box[], min = 1.4): Violation[] =>
  boxes.filter((b) => (b.lines ?? 1) >= 2 && b.fontSize && b.lineHeight && b.lineHeight / b.fontSize < min - 0.005)
    .map((b) => ({ rule: "line-height", id: b.id, detail: `${r1(b.lineHeight! / b.fontSize!)}× < ${min}×`, hard: true }));

/** Nearest pleasing ratio for a rectangle (orientation-free). */
export function nearestPleasing(w: number, h: number): { name: string; ratio: number; off: number } {
  const r = Math.max(w, h) / Math.max(1e-9, Math.min(w, h));
  let best: { name: string; ratio: number; off: number } = { name: PLEASING[0].name, ratio: r, off: Infinity };
  for (const p of PLEASING) { const off = Math.abs(r - p.r) / p.r; if (off < best.off) best = { name: p.name, ratio: r, off }; }
  return best;
}
export function proportion(boxes: readonly Box[], tol = 0.06): Violation[] {
  return boxes.map((b) => ({ b, n: nearestPleasing(b.w, b.h) })).filter(({ n }) => n.off > tol)
    .map(({ b, n }) => ({ rule: "proportion", id: b.id, detail: `ratio ${n.ratio.toFixed(3)} (nearest ${n.name}, ${r1(n.off * 100)}% off)`, hard: false }));
}
/** Our own golden cards must stay golden (hard, ±2 %). */
export const goldenCards = (cards: readonly Box[], tol = 0.02): Violation[] =>
  cards.filter((b) => Math.abs(Math.max(b.w, b.h) / Math.min(b.w, b.h) - PHI) / PHI > tol)
    .map((b) => ({ rule: "golden-card", id: b.id, detail: `ratio ${(Math.max(b.w, b.h) / Math.min(b.w, b.h)).toFixed(3)} ≠ φ`, hard: true }));

export function typeScale(sizes: readonly number[], name: string): Violation[] {
  const d = [...new Set(sizes.filter((s) => s > 0).map((s) => Math.round(s * 2) / 2))].sort((a, b) => a - b);
  const out: Violation[] = [];
  if (d.length > 8) out.push({ rule: "type-scale", id: name, detail: `${d.length} distinct font sizes (> 8)`, hard: false });
  const big = d.length >= 2 ? d[d.length - 1] / d[0] : 1;
  if (big > PHI ** 4 + 0.01) out.push({ rule: "type-scale", id: name, detail: `largest/smallest ${big.toFixed(2)} > φ⁴`, hard: false });
  return out;
}

/** Ngo balance (0…1, 1 = perfectly balanced optical weight left/right and top/bottom). Reported, not failed. */
export function balance(boxes: readonly Box[], frame: Box): number {
  let L = 0, R = 0, T = 0, B = 0;
  const mx = cx(frame), my = cy(frame);
  for (const b of boxes) {
    const a = b.w * b.h;
    if (cx(b) < mx) L += a * (mx - cx(b)); else R += a * (cx(b) - mx);
    if (cy(b) < my) T += a * (my - cy(b)); else B += a * (cy(b) - my);
  }
  const v = Math.max(L, R) ? Math.abs(L - R) / Math.max(L, R) : 0, h = Math.max(T, B) ? Math.abs(T - B) / Math.max(T, B) : 0;
  return 1 - (v + h) / 2;
}

export const hardOnly = (v: readonly Violation[]) => v.filter((x) => x.hard);
