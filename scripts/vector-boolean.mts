/**
 * TT19 suite "vector-boolean": Pathfinder shape modes against GEOS (shapely 2.x, PyPI) as an independent oracle.
 * Operands are rebuilt in Python from their PRIMITIVE parameters (box / buffered point / affinity rotate), never from
 * our flattened polygons; we compare area, symmetric-difference area and IoU with our result region.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/vector-boolean.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import { blankDoc, exportSvg, importSvg, type Shape, type VDoc } from "../src/lib/vector/model.ts";
import { rotateM, flatten, IDENTITY } from "../src/lib/vector/path.ts";
import { booleanOp, regionArea, shapeRegion, type BoolOp } from "../src/lib/vector/boolean.ts";

const { test, finish } = makeHarness("vector-boolean");
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
type Prim = Record<string, unknown>;
const oracle = (cases: { op: BoolOp; operands: Prim[]; ours: unknown }[]) =>
  JSON.parse(execFileSync(PY, ["scripts/oracles/boolean_oracle.py"], { input: JSON.stringify({ cases }), encoding: "utf8", timeout: 120_000 })) as { area: number; ours_area: number; symdiff: number; iou: number; parts: number }[];

const st = (fill: string) => ({ fill, stroke: "#111111", strokeWidth: 2 });
const rect = (id: string, x: number, y: number, w: number, h: number, fill = "#ff0000", rot = 0): Shape =>
  ({ id, kind: "rect", x, y, w, h, rx: 0, ry: 0, transform: rot ? rotateM(rot, x + w / 2, y + h / 2) : IDENTITY, style: st(fill) });
const ell = (id: string, cx: number, cy: number, rx: number, ry: number, fill = "#0000ff"): Shape => ({ id, kind: "ellipse", cx, cy, rx, ry, transform: IDENTITY, style: st(fill) });
const doc = (...shapes: Shape[]): VDoc => ({ ...blankDoc("bool"), shapes });
const OPS: BoolOp[] = ["unite", "minusFront", "intersect", "exclude"];

await test("two rectangles: all four shape modes equal GEOS exactly; paint + stacking follow Illustrator (front paint; Minus Front keeps the back)", { "FF-37": "full" }, () => {
  const d = doc(rect("bg", 0, 0, 500, 500, "#eeeeee"), rect("a", 0, 0, 100, 100, "#ff0000"), rect("mid", 300, 300, 10, 10, "#00ff00"), rect("b", 50, 50, 100, 100, "#0000ff"));
  const res = OPS.map((op) => booleanOp(d, ["a", "b"], op));
  const want = { unite: 17500, minusFront: 7500, intersect: 2500, exclude: 15000 };
  res.forEach((r, i) => assert.ok(Math.abs(r.area - want[OPS[i]]) < 1e-9, `${OPS[i]} area ${r.area}`));
  const o = oracle(res.map((r, i) => ({ op: OPS[i], operands: [{ kind: "rect", x: 0, y: 0, w: 100, h: 100 }, { kind: "rect", x: 50, y: 50, w: 100, h: 100 }], ours: r.region })));
  o.forEach((x, i) => { assert.ok(Math.abs(x.area - res[i].area) < 1e-6 && x.symdiff < 1e-6, `${OPS[i]}: GEOS ${x.area} ours ${res[i].area} symdiff ${x.symdiff}`); });
  const [u, m, , x] = res;
  assert.equal(u.doc.shapes.find((s) => s.id === u.id)!.style.fill, "#0000ff", "Unite → frontmost paint");
  assert.equal(m.doc.shapes.find((s) => s.id === m.id)!.style.fill, "#ff0000", "Minus Front → backmost paint");
  assert.deepEqual(u.doc.shapes.map((s) => s.id), ["bg", "mid", u.id], "result takes the frontmost operand's z position");
  assert.deepEqual(m.doc.shapes.map((s) => s.id), ["bg", m.id, "mid"], "Minus Front result sits where the back operand was");
  assert.equal(x.rings, 2, "Exclude of two overlapping squares = two L-shaped pieces");
  assert.equal(x.doc.shapes.find((s) => s.id === x.id)!.style.fillRule, "evenodd");
});

await test("rotated rectangle (transform) × ellipse: every mode within flattening tolerance of GEOS (IoU ≥ 0.9995)", { "FF-37": "full" }, () => {
  const d = doc(ell("e", 200, 150, 120, 70), rect("r", 150, 60, 160, 120, "#00aa00", 30));
  const res = OPS.map((op) => booleanOp(d, ["e", "r"], op));
  const o = oracle(res.map((r, i) => ({ op: OPS[i], operands: [{ kind: "ellipse", cx: 200, cy: 150, rx: 120, ry: 70 }, { kind: "rect", x: 150, y: 60, w: 160, h: 120, rot: 30 }], ours: r.region })));
  o.forEach((x, i) => {
    assert.ok(x.iou >= 0.9995, `${OPS[i]} IoU ${x.iou}`);
    assert.ok(Math.abs(x.area - res[i].area) / x.area < 5e-4, `${OPS[i]} area GEOS ${x.area} vs ${res[i].area}`);
  });
});

await test("three operands: Minus Front subtracts every front shape from the back one; Exclude fills odd coverage only (GEOS XOR chain)", { "FF-37": "full" }, () => {
  const d = doc(ell("c1", 100, 100, 60, 60), ell("c2", 160, 100, 60, 60, "#ff00ff"), ell("c3", 130, 150, 60, 60, "#00ffff"));
  const prims = [{ kind: "ellipse", cx: 100, cy: 100, rx: 60, ry: 60 }, { kind: "ellipse", cx: 160, cy: 100, rx: 60, ry: 60 }, { kind: "ellipse", cx: 130, cy: 150, rx: 60, ry: 60 }];
  const ops: BoolOp[] = ["minusFront", "exclude", "intersect", "unite"];
  const res = ops.map((op) => booleanOp(d, ["c1", "c2", "c3"], op));
  oracle(res.map((r, i) => ({ op: ops[i], operands: prims, ours: r.region }))).forEach((x, i) => assert.ok(x.iou >= 0.999, `${ops[i]} IoU ${x.iou} (GEOS ${x.area}, ours ${res[i].area})`));
  assert.equal(res[0].doc.shapes.find((s) => s.id === res[0].id)!.style.fill, "#0000ff", "back paint");
  assert.equal(res[1].doc.shapes.find((s) => s.id === res[1].id)!.style.fill, "#00ffff", "front paint");
});

await test("fill rules: even-odd hole, nonzero opposite-direction hole, nonzero same-direction (no hole), group = union of leaves with its transform", { "FF-37": "full" }, () => {
  const sq = (x: number, y: number, w: number, h: number, cw: boolean) => cw ? `M${x} ${y}H${x + w}V${y + h}H${x}Z` : `M${x} ${y}V${y + h}H${x + w}V${y}Z`;
  const path = (id: string, d: string, rule?: "evenodd" | "nonzero"): Shape => ({ ...importSvg(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`).doc.shapes[0], id, style: { fill: "#000000", fillRule: rule } });
  const eo = shapeRegion(path("p", sq(0, 0, 100, 100, true) + sq(25, 25, 50, 50, true), "evenodd"));
  const nzOpp = shapeRegion(path("p", sq(0, 0, 100, 100, true) + sq(25, 25, 50, 50, false)));
  const nzSame = shapeRegion(path("p", sq(0, 0, 100, 100, true) + sq(25, 25, 50, 50, true)));
  assert.equal(regionArea(eo.region), 7500); assert.equal(regionArea(nzOpp.region), 7500); assert.equal(regionArea(nzSame.region), 10000);
  assert.equal(nzOpp.approx, false);
  const crossing = shapeRegion(path("p", sq(0, 0, 100, 100, true) + sq(50, 50, 100, 100, false)));
  assert.equal(crossing.approx, true, "crossing mixed-direction subpaths are flagged, not silently trusted");
  const d = doc(path("donut", sq(0, 0, 100, 100, true) + sq(25, 25, 50, 50, true), "evenodd"), rect("bar", 40, -10, 20, 120, "#00ff00"));
  const minus = booleanOp(d, ["donut", "bar"], "minusFront");
  const o = oracle([{ op: "minusFront", operands: [{ kind: "ring_hole", outer: [0, 0, 100, 100], inner: [25, 25, 50, 50] }, { kind: "rect", x: 40, y: -10, w: 20, h: 120 }], ours: minus.region }]);
  assert.ok(o[0].symdiff < 1e-6, `donut minus bar symdiff ${o[0].symdiff}`); assert.equal(o[0].parts, 2);
  const g: Shape = { id: "g", kind: "group", transform: [1, 0, 0, 1, 200, 0], style: {}, children: [rect("g1", 0, 0, 50, 50), rect("g2", 25, 25, 50, 50)] };
  const gu = booleanOp(doc(g, rect("z", 200, 0, 10, 10, "#123456")), ["g", "z"], "unite");
  const og = oracle([{ op: "unite", operands: [{ kind: "union", children: [{ kind: "rect", x: 200, y: 0, w: 50, h: 50 }, { kind: "rect", x: 225, y: 25, w: 50, h: 50 }] }, { kind: "rect", x: 200, y: 0, w: 10, h: 10 }], ours: gu.region }]);
  assert.ok(og[0].symdiff < 1e-6, "group transform applied");
});

await test("refusals: open paths, text, a single shape, locked shapes, Intersect of disjoint shapes; result survives SVG export → import", { "FF-37": "partial" }, () => {
  const line: Shape = { id: "l", kind: "line", x1: 0, y1: 0, x2: 10, y2: 10, transform: IDENTITY, style: st("none") };
  const text: Shape = { id: "t", kind: "text", x: 0, y: 0, text: "Hi", transform: IDENTITY, style: st("#000") };
  const r1 = rect("a", 0, 0, 10, 10); const r2 = rect("b", 50, 50, 10, 10);
  assert.throws(() => booleanOp(doc(r1, line), ["a", "l"], "unite"), /open path/);
  assert.throws(() => booleanOp(doc(r1, text), ["a", "t"], "unite"), /text/);
  assert.throws(() => booleanOp(doc(r1, r2), ["a"], "unite"), /at least two/);
  assert.throws(() => booleanOp(doc(r1, { ...r2, locked: true }), ["a", "b"], "unite"), /locked/);
  assert.throws(() => booleanOp(doc(r1, r2), ["a", "b"], "intersect"), /do not all overlap/);
  const ok = booleanOp(doc(ell("e", 50, 50, 40, 30), rect("r", 20, 20, 60, 20)), ["e", "r"], "exclude");
  const back = importSvg(exportSvg(ok.doc)).doc.shapes.find((x) => x.kind === "path")!;
  assert.ok(back, "path survives export"); assert.equal(back.style.fillRule, "evenodd");
  const reArea = regionArea(shapeRegion(back).region);
  assert.ok(Math.abs(reArea - ok.area) / ok.area < 1e-4, `round-tripped area ${reArea} vs ${ok.area}`);
});

await test("performance: two 600-unit ellipses + a rotated rect, all modes < 400 ms each on this 2-CPU host", { "FF-37": "partial" }, () => {
  const d = doc(ell("e1", 600, 600, 600, 400), ell("e2", 900, 700, 500, 500), rect("r", 300, 300, 800, 300, "#000", 17));
  for (const op of OPS) { const t = performance.now(); booleanOp(d, ["e1", "e2", "r"], op); const ms = performance.now() - t; assert.ok(ms < 400, `${op} took ${ms.toFixed(0)} ms`); }
});

finish();
