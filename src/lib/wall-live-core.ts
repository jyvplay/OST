/**
 * TT31 "live walls": the Tabletop's four walls are working boards IN THE OVERVIEW (not only when unfolded), with the
 * floor's moves — drag, drop on a card to pile, click a pile to fan, drag across to another surface — and no pin limit.
 *
 * Why this module exists: under the default slanted camera the floor must keep ≥ 80 % of the frame, so the walls are
 * squeezed against the frame edges — the north band is ~61 px tall, the near lip ~37 px, the side walls 15–20 px thick
 * slivers (measured at 1440×812; 4–5 px on a 390 px phone). Nothing can be enlarged in place without leaving the frame.
 * Design:
 *   1. WALL STRIP. A wall board keeps its 2D arrangement (the unfolded pinboard is unchanged: WALL_BOARD_W wide, rows
 *      grow downward without limit). On the wall face the rows are UNROLLED end to end along the wall's length, so
 *      the wall shows a continuous strip: S = row · PITCH + x along the wall, t = offset inside the row band across
 *      it. One row band fills the wall's thickness; panning along S reaches every row (infinite pins).
 *   2. LIFT. Hovering a wall (300 ms), focusing into it, or dragging over it (spring-loaded, 350 ms) swings that wall up
 *      to face you, flat and at true size, docked over the edge of the floor; it settles back when you leave. The
 *      resting camera — and its ≥ 80 % floor — is untouched.
 *   3. EXACT POINTER MAPPING. Screen → wall-element coordinates through the plane homography of the face's current
 *      quad (rest or lifted), → strip coordinates through the strip frame, → board coordinates.
 * Everything here is pure (no DOM) and unit-tested in scripts/tt31-unit.mts.
 */
import { CARD_GAP, CARD_H, CARD_W } from "./tabletop-core";
import { apply, applyH, homography, project, type H3, type Mat, type P2 } from "./tabletop-slant";

export type LiveWall = "north" | "south" | "east" | "west";
/** Logical width of a wall board: 6 cards per row on the freeSlot grid (24 + 6 × 136 = 840). */
export const WALL_BOARD_W = 840;
export const ROW_H = CARD_H + CARD_GAP;
/** board px between consecutive rows when they are laid end to end along the wall */
export const ROW_SEP = 72;
export const PITCH = WALL_BOARD_W + ROW_SEP;
/** a row band across the wall: a card plus a gap of slack above and below */
export const BAND = CARD_H + 2 * CARD_GAP;
/** fraction of the wall thickness kept clear on each side of the band */
export const STRIP_PAD = 0.08;
export const MAX_X = WALL_BOARD_W - CARD_W;
/** a rest-pose pin is a pointer target only when its projected box is at least this big both ways (WCAG 2.5.8) */
export const MIN_TARGET = 24;

/* ------------------------------------------------------------------ board ↔ strip (rows unrolled along the wall) */
const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
/** row of a board y (rows start at CARD_GAP, ROW_H apart — the freeSlot grid); nearest row, never negative */
export const rowOf = (y: number) => Math.max(0, Math.round((fin(y) - CARD_GAP) / ROW_H));
export const rowY = (r: number) => CARD_GAP + r * ROW_H;
/** board (x, y) → strip (S along the wall, t across: 0 … 2·CARD_GAP is the card's slack inside its band) */
export function boardToStrip(x: number, y: number): { S: number; t: number } {
  const r = rowOf(y);
  return { S: r * PITCH + Math.max(0, Math.min(MAX_X, fin(x))), t: Math.max(0, Math.min(2 * CARD_GAP, fin(y) - rowY(r) + CARD_GAP)) };
}
/** strip → board. A point in the gap between two unrolled rows snaps to the nearer row end. */
export function stripToBoard(S: number, t: number): { x: number; y: number } {
  const s = Math.max(0, fin(S));
  let r = Math.floor(s / PITCH), x = s - r * PITCH;
  if (x > MAX_X) { if (x - MAX_X > (PITCH - MAX_X) / 2) { r += 1; x = 0; } else x = MAX_X; }
  return { x: Math.round(x), y: Math.round(rowY(r) + Math.max(0, Math.min(2 * CARD_GAP, fin(t))) - CARD_GAP) };
}

/* ------------------------------------------------------------------ strip frame inside a wall element */
/**
 * How a strip sits in a wall element of ew × eh px. rot 0: the element's x is the wall's length (all slanted faces
 * and the top-down north/south walls); ±90: the element is tall (top-down side walls) and the strip runs down it,
 * card tops toward the floor. A is a proper rotation (no mirror) — checked in the unit tests.
 */
export interface StripFrame { ew: number; eh: number; rot: 0 | 90 | -90; L: number; T: number; k: number; padU: number; padV: number }
export function stripFrame(ew: number, eh: number, rot: 0 | 90 | -90, head = 0): StripFrame {
  const L = rot === 0 ? ew : eh, T = rot === 0 ? eh : ew;
  const avail = Math.max(1, T - head), pad = avail * STRIP_PAD;
  const k = Math.max(0.02, Math.min(1, (avail - 2 * pad) / BAND));
  return { ew, eh, rot, L, T, k, padU: Math.max(6, Math.min(24, avail * STRIP_PAD)), padV: head + (avail - BAND * k) / 2 };
}
/** strip-space (u along, v across, element px) → element px */
export function uvToElement(f: StripFrame, u: number, v: number): P2 {
  if (f.rot === 0) return [u, v];
  if (f.rot === 90) return [f.T - v, u];
  return [v, f.L - u];
}
export function elementToUv(f: StripFrame, x: number, y: number): P2 {
  if (f.rot === 0) return [x, y];
  if (f.rot === 90) return [y, f.T - x];
  return [f.L - y, x];
}
/** CSS matrix() placing a (u, v) box inside the element */
export function stripCss(f: StripFrame): string {
  if (f.rot === 0) return "none";
  return f.rot === 90 ? `matrix(0, 1, -1, 0, ${f.T}, 0)` : `matrix(0, -1, 1, 0, 0, ${f.L})`;
}
/** strip (S, t) → (u, v) for pan offset `pan` (board px along S) */
export const stripToUv = (f: StripFrame, S: number, t: number, pan: number): P2 => [f.padU + (S - pan) * f.k, f.padV + t * f.k];
export const uvToStrip = (f: StripFrame, u: number, v: number, pan: number): { S: number; t: number } => ({ S: (u - f.padU) / f.k + pan, t: (v - f.padV) / f.k });
/** board px of strip visible along the wall */
export const visibleS = (f: StripFrame) => Math.max(0, (f.L - 2 * f.padU) / f.k);
/** rows in use (≥ 1) for the board y values present, plus one empty row to drop into — so there is always room */
export function stripRows(ys: readonly number[]): number { return (ys.length ? Math.max(...ys.map(rowOf)) + 1 : 0) + 1; }
export function maxPan(f: StripFrame, rows: number): number { return Math.max(0, rows * PITCH - ROW_SEP - visibleS(f)); }
export const clampPan = (f: StripFrame, rows: number, pan: number) => Math.max(0, Math.min(maxPan(f, rows), fin(pan)));
/** smallest pan change that shows a card at S whole */
export function panToShow(f: StripFrame, rows: number, pan: number, S: number): number {
  const vis = visibleS(f);
  let p = pan;
  if (S < p) p = S - CARD_GAP; else if (S + CARD_W > p + vis) p = S + CARD_W + CARD_GAP - vis;
  return clampPan(f, rows, p);
}
/** a fanned pile on a wall spreads ALONG the strip around the pile (the band is one card tall) */
export function fanStrip(n: number, S0: number): { S: number; t: number; rot: number }[] {
  const step = CARD_W * 0.86;
  const w = (n - 1) * step;
  const start = Math.max(0, S0 + CARD_W / 2 - w / 2 - CARD_W / 2);
  return Array.from({ length: n }, (_, i) => { const u = n === 1 ? 0 : i / (n - 1) - 0.5; return { S: Math.round(start + i * step), t: CARD_GAP, rot: Math.round(u * 2 * 8 * 10) / 10 }; });
}

/* ------------------------------------------------------------------ lifted pose */
/**
 * The lifted wall: the face element takes a readable size (ew along the wall × eh across) and is laid FLAT in front
 * of the scene, docked over the floor's edge on its own side — north along the top, south along the bottom (above the
 * view switcher), west / east down the left / right edge (above the near lip and the switcher), the wall's top edge
 * toward the frame edge. A 2D map (x, y) → (a x + c y + e, b x + d y + f) with a pure rotation (det = +1, no mirror).
 */
export interface Dock { ew: number; eh: number; a: number; b: number; c: number; d: number; e: number; f: number; rect: { x: number; y: number; w: number; h: number } }
export interface DockFrame { W: number; H: number; lipTop: number; nav?: { l: number; r: number; t: number; b: number } | null; margin?: number }
export const liftThickness = (wall: LiveWall, W: number, H: number) =>
  Math.round(wall === "north" || wall === "south" ? Math.max(150, Math.min(240, H * 0.28)) : Math.max(130, Math.min(240, W * 0.24)));
export function dockRect(wall: LiveWall, g: DockFrame): Dock {
  const { W, H } = g, M = g.margin ?? 6, th = liftThickness(wall, W, H);
  const navAbove = (x0: number, x1: number) => (g.nav && g.nav.r > x0 && g.nav.l < x1 ? g.nav.t - 6 : Infinity);
  if (wall === "north") return { ew: W - 2 * M, eh: th, a: 1, b: 0, c: 0, d: 1, e: M, f: M, rect: { x: M, y: M, w: W - 2 * M, h: th } };
  if (wall === "south") {
    const bottom = Math.min(H - M, navAbove(M, W - M)), y0 = Math.max(M, bottom - th);
    return { ew: W - 2 * M, eh: th, a: 1, b: 0, c: 0, d: 1, e: M, f: y0, rect: { x: M, y: y0, w: W - 2 * M, h: th } };
  }
  const xL = wall === "west" ? M : W - M - th;
  const top = M, bottom = Math.max(top + 2 * th, Math.min(H - M, g.lipTop - M, navAbove(xL, xL + th))), len = bottom - top;
  // west: the wall runs near (bottom) → far (top), its top edge at the frame's left edge; east mirrors it
  if (wall === "west") return { ew: len, eh: th, a: 0, b: -1, c: 1, d: 0, e: M, f: bottom, rect: { x: M, y: top, w: th, h: len } };
  return { ew: len, eh: th, a: 0, b: 1, c: -1, d: 0, e: W - M, f: top, rect: { x: W - M - th, y: top, w: th, h: len } };
}
/**
 * The dock as a 3D matrix: at depth Z in front of every resting face, pre-scaled about the perspective origin by
 * (P − Z) / P so that after the browser's perspective it lands EXACTLY on the dock rectangle (unit-tested to 1e-6 px).
 * Being in front in 3D is what makes it paint over — and receive the pointer before — the walls and the floor in a
 * preserve-3d scene, where z-index does not apply.
 */
export function liftMatrix(dk: Dock, P: number, ox: number, oy: number, Z: number): Mat {
  const k = (P - Z) / P;
  return [dk.a * k, dk.b * k, 0, 0, dk.c * k, dk.d * k, 0, 0, 0, 0, 1, 0, ox + (dk.e - ox) * k, oy + (dk.f - oy) * k, Z, 1];
}
export function liftQuad(dk: Dock, m: Mat, P: number, ox: number, oy: number): P2[] {
  return ([[0, 0], [dk.ew, 0], [dk.ew, dk.eh], [0, dk.eh]] as P2[]).map(([x, y]) => project(apply(m, [x, y, 0]), P, ox, oy));
}
/** strip header height inside a lifted wall (title + pan buttons) */
export const LIFT_HEAD = 34;

/* ------------------------------------------------------------------ hit testing + pointer mapping */
/** point in a convex quad (either winding) */
export function inQuad(p: P2, q: readonly P2[]): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length];
    const c = (x2 - x1) * (p[1] - y1) - (y2 - y1) * (p[0] - x1);
    if (Math.abs(c) < 1e-9) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}
export type HitVia = "lifted" | "tag" | "wall" | "floor";
/**
 * Which surface is under a screen point while dragging in the overview. Order = paint order: the lifted wall is in
 * front of everything, flat wall tags float above the scene, then resting walls, then the floor.
 */
export function surfaceAt(p: P2, s: { lifted: LiveWall | null; liftedQuad: readonly P2[] | null; tags: Partial<Record<LiveWall, { x: number; y: number; w: number; h: number }>>; rest: Record<LiveWall, readonly P2[]>; floor: readonly P2[] }): { face: LiveWall | "floor"; via: HitVia } | null {
  if (s.lifted && s.liftedQuad && inQuad(p, s.liftedQuad)) return { face: s.lifted, via: "lifted" };
  for (const w of ["north", "east", "south", "west"] as LiveWall[]) {
    const t = s.tags[w];
    if (t && w !== s.lifted && p[0] >= t.x && p[0] <= t.x + t.w && p[1] >= t.y && p[1] <= t.y + t.h) return { face: w, via: "tag" };
  }
  for (const w of ["north", "east", "south", "west"] as LiveWall[]) if (w !== s.lifted && inQuad(p, s.rest[w])) return { face: w, via: "wall" };
  if (inQuad(p, s.floor)) return { face: "floor", via: "floor" };
  return null;
}
/** screen (root px) → element px for a face whose element corners (0,0),(ew,0),(ew,eh),(0,eh) appear at `quad` */
export function screenToElementH(quad: readonly P2[], ew: number, eh: number): H3 {
  return homography(quad, [[0, 0], [ew, 0], [ew, eh], [0, eh]]);
}
export function elementToScreenH(quad: readonly P2[], ew: number, eh: number): H3 {
  return homography([[0, 0], [ew, 0], [ew, eh], [0, eh]], quad);
}
/** screen → strip, in one call */
export function screenToStrip(p: P2, toEl: H3, f: StripFrame, pan: number): { S: number; t: number } {
  const [x, y] = applyH(toEl, p);
  const [u, v] = elementToUv(f, x, y);
  return uvToStrip(f, u, v, pan);
}
/** projected size (min side, screen px) of a card at strip (S, t) — decides whether a resting pin is a pointer target */
export function pinScreenSize(toScreen: H3, f: StripFrame, S: number, t: number, pan: number): { w: number; h: number } {
  const c = ([[0, 0], [CARD_W, 0], [CARD_W, CARD_H], [0, CARD_H]] as P2[]).map(([dx, dy]) => {
    const [u, v] = stripToUv(f, S + dx, t + dy, pan);
    return applyH(toScreen, uvToElement(f, u, v));
  });
  // the projected card is (nearly) a parallelogram: its usable size is its two HEIGHTS (area ÷ the opposite side),
  // not its side lengths — a sheared sliver has long sides and almost no area
  const d = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let A = 0;
  for (let i = 0; i < 4; i++) { const [x1, y1] = c[i], [x2, y2] = c[(i + 1) % 4]; A += x1 * y2 - x2 * y1; }
  A = Math.abs(A) / 2;
  const top = (d(c[0], c[1]) + d(c[3], c[2])) / 2, side = (d(c[0], c[3]) + d(c[1], c[2])) / 2;
  return { w: top > 0 ? A / side : 0, h: side > 0 ? A / top : 0 };
}
