/**
 * TT19 — Pathfinder shape modes (Illustrator semantics, checked against Adobe's Pathfinder panel doc):
 *   Unite        union of all operands; result takes the FRONTMOST operand's paint
 *   Minus Front  backmost operand minus every operand in front of it; result takes the BACKMOST paint
 *   Intersect    area common to ALL operands; frontmost paint
 *   Exclude      areas covered an ODD number of times (XOR); frontmost paint, even-odd compound path
 * The result replaces the operands at the stacking position of the operand whose paint it takes.
 *
 * Geometry: each operand (with its transform and any group nesting) is flattened to polygons at `tol`
 * document units and combined with polygon-clipping 0.15.7 (Martinez–Rueda–Feito sweep line, robust
 * predicates). Declared limit: results are polygonal — curves become line segments within `tol`;
 * Illustrator keeps Béziers. Open paths (line/polyline) and text have no fill area and are refused.
 */
import * as pcNs from "polygon-clipping";
import type { MultiPolygon, Ring } from "polygon-clipping";
import { IDENTITY, flatten, mul, transformPath, type Matrix, type Seg } from "./path";
import { localSegs, nextId, type Shape, type VDoc } from "./model";

// polygon-clipping ships CJS (module.exports = {…}) and ESM (export default {…}); normalise both.
const pc = ((pcNs as unknown as { default?: typeof pcNs }).default ?? pcNs) as typeof pcNs;

export type BoolOp = "unite" | "minusFront" | "intersect" | "exclude";
export const BOOL_LABEL: Record<BoolOp, string> = { unite: "Unite", minusFront: "Minus Front", intersect: "Intersect", exclude: "Exclude" };

const ringArea = (r: Ring) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; };
/** Area of a polygon-clipping MultiPolygon (exterior minus holes). */
export const regionArea = (mp: MultiPolygon) => mp.reduce((s, poly) => s + poly.reduce((t, ring, i) => t + (i === 0 ? 1 : -1) * Math.abs(ringArea(ring)), 0), 0);

function inside(r: Ring, x: number, y: number) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i]; const [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Fill region of one shape in document space. `approx` = nonzero rule with crossing, mixed-direction subpaths. */
export function shapeRegion(s: Shape, parent: Matrix = IDENTITY, tol = 0.05): { region: MultiPolygon; approx: boolean } {
  const m = mul(parent, s.transform);
  if (s.kind === "group") {
    const parts = s.children.filter((c) => !c.hidden).map((c) => shapeRegion(c, m, tol));
    if (!parts.length) return { region: [], approx: false };
    return { region: pc.union(parts[0].region, ...parts.slice(1).map((p) => p.region)), approx: parts.some((p) => p.approx) };
  }
  if (s.kind === "line" || s.kind === "polyline") throw new Error(`${s.name ?? s.kind} is an open path — it has no fill area to combine`);
  if (s.kind === "text") throw new Error("text has no outline geometry here (no font glyph data) — convert is not available");
  const segs: Seg[] = transformPath(localSegs(s), m);
  const rings: Ring[] = flatten(segs, tol).map((r) => r.pts as Ring).filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-9);
  if (!rings.length) return { region: [], approx: false };
  if (rings.length === 1) return { region: pc.union([rings[0]]), approx: false };
  if (s.style.fillRule === "evenodd") return { region: pc.xor([rings[0]], ...rings.slice(1).map((r) => [r])), approx: false };
  // nonzero: same direction everywhere → winding ≥ 1 wherever any ring covers → exactly the union
  const signs = rings.map((r) => Math.sign(ringArea(r)));
  if (signs.every((v) => v === signs[0])) return { region: pc.union([rings[0]], ...rings.slice(1).map((r) => [r])), approx: false };
  // mixed directions: exact when rings nest without crossing — toggle a ring in iff it flips filled-ness
  const order = rings.map((r, i) => ({ r, i, a: Math.abs(ringArea(r)) })).sort((p, q) => q.a - p.a);
  let region: MultiPolygon = []; let approx = false;
  for (let k = 0; k < order.length; k++) {
    const { r, i } = order[k];
    let outside = 0;
    for (let j = 0; j < k; j++) {
      const big = order[j].r;
      const ins = r.map(([x, y]) => inside(big, x, y));
      if (ins.some(Boolean) && !ins.every(Boolean)) approx = true;   // crossing rings: nesting assumption broken
      if (ins.filter(Boolean).length * 2 > ins.length) outside += signs[order[j].i];
    }
    const insideW = outside + signs[i];
    if ((outside !== 0) !== (insideW !== 0)) region = region.length ? pc.xor(region, [r]) : pc.union([r]);
  }
  return { region, approx };
}

export function regionToSegs(mp: MultiPolygon, p = 3): Seg[] {
  const q = (v: number) => Number(v.toFixed(p));
  const out: Seg[] = [];
  for (const poly of mp) for (const ring of poly) {
    const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
    if (pts.length < 3) continue;
    out.push({ t: "M", x: q(pts[0][0]), y: q(pts[0][1]) });
    for (const [x, y] of pts.slice(1)) out.push({ t: "L", x: q(x), y: q(y) });
    out.push({ t: "Z" });
  }
  return out;
}

export interface BoolResult { doc: VDoc; id: string; approx: boolean; area: number; rings: number; region: MultiPolygon }

/** Apply a shape mode to top-level shapes `ids` (z-order = doc.shapes order, index 0 = back). */
export function booleanOp(doc: VDoc, ids: string[], op: BoolOp, tol = 0.05): BoolResult {
  const operands = doc.shapes.filter((s) => ids.includes(s.id));
  if (operands.length < 2) throw new Error(`${BOOL_LABEL[op]} needs at least two selected shapes`);
  if (operands.some((s) => s.locked)) throw new Error("a selected shape is locked");
  const regs = operands.map((s) => shapeRegion(s, IDENTITY, tol));
  const [first, ...rest] = regs.map((r) => r.region);
  const region = op === "unite" ? pc.union(first, ...rest)
    : op === "intersect" ? pc.intersection(first, ...rest)
    : op === "exclude" ? pc.xor(first, ...rest)
    : pc.difference(first, ...rest);
  if (!region.length) throw new Error(op === "intersect" ? "the selected shapes do not all overlap — nothing to keep" : `${BOOL_LABEL[op]} leaves no area`);
  const paint = op === "minusFront" ? operands[0] : operands[operands.length - 1];
  const id = nextId(doc, "p");
  const result: Shape = {
    id, name: `${BOOL_LABEL[op]} (${operands.length})`, kind: "path", transform: IDENTITY,
    style: { ...paint.style, fillRule: "evenodd" }, segs: regionToSegs(region),
  };
  const shapes: Shape[] = [];
  for (const s of doc.shapes) {
    if (s.id === paint.id) shapes.push(result);
    else if (!ids.includes(s.id)) shapes.push(s);
  }
  return { doc: { ...doc, shapes }, id, approx: regs.some((r) => r.approx), area: regionArea(region), rings: region.reduce((a, p) => a + p.length, 0), region };
}
