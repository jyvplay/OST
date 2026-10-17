/**
 * Suite "tt29-unit" (TT29): the pure maths behind the Tabletop legibility level of detail, without a browser.
 *   - minSingular / faceScale against hand-computed cases (identity, uniform scale, rotation, anisotropic squash,
 *     a real perspective trapezoid whose scale is known at its corners)
 *   - centroid on shapes with known answers
 *   - slanted tray: at 1 500 random frames every tag lies inside the frame AND inside its wall's visible polygon;
 *     side walls are labelled as vertical spines, north/south horizontally; the rule's verdict follows its definition
 *   - straight-down box: the four quads tile the frame minus the floor exactly (area identity) and share the floor's
 *     edges; a frontal face is "detail", a strongly foreshortened one "glyph"
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt29-unit.mts
 */
import { makeHarness } from "./harness.mts";
import * as L from "../src/lib/tabletop-slant.ts";
import { boxGeometry } from "../src/lib/tabletop-core.ts";

const { test, finish } = makeHarness("tt29-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;
type P = [number, number];
const inConvex = (p: P, poly: readonly P[]) => {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
    if (Math.abs(c) < 1e-6) continue;
    const s = Math.sign(c); if (sign && s !== sign) return false; sign = s;
  }
  return true;
};
const area = (p: readonly P[]) => Math.abs(p.reduce((s, [x1, y1], i) => { const [x2, y2] = p[(i + 1) % p.length]; return s + x1 * y2 - x2 * y1; }, 0)) / 2;

await test("minSingular and faceScale match hand-computed cases: identity 1, ×0.5 → 0.5, a 90° rotation stays 1, a 1 × 0.25 squash → 0.25, and a perspective trapezoid's corner scale", { "LY-20": "full" }, () => {
  ok(near(L.minSingular(2, 0, 0, 3), 2), "diag(2,3) → 2");
  ok(near(L.minSingular(0, -1, 1, 0), 1), "rotation → 1");
  ok(near(L.minSingular(1, 1, 0, 0), 0), "rank-1 → 0");
  const R: P[] = [[0, 0], [400, 0], [400, 300], [0, 300]];
  ok(near(L.faceScale(400, 300, R), 1), "identity");
  ok(near(L.faceScale(400, 300, R.map(([x, y]) => [x / 2 + 10, y / 2 + 5] as P)), 0.5), "uniform half");
  ok(near(L.faceScale(400, 300, [[0, 0], [0, 400], [-300, 400], [-300, 0]]), 1), "rotated 90° is not 'squashed'");
  ok(near(L.faceScale(400, 300, [[0, 0], [400, 0], [400, 75], [0, 75]]), 0.25), "vertical squash 0.25");
  // a symmetric trapezoid (top edge 200 wide, bottom 400, height 100) from a 400×300 rect: the narrow corners are
  // the least scaled; the top edge's horizontal scale there is 0.5 and the vertical one is smaller still
  const tr: P[] = [[100, 0], [300, 0], [400, 100], [0, 100]];
  const sc = L.faceScale(400, 300, tr);
  ok(sc > 0 && sc < 0.5 && sc < 100 / 300 + 1e-9, `trapezoid scale ${sc}`);
  ok(L.faceScale(0, 300, R) === 0 && L.faceScale(400, 300, R.slice(0, 3)) === 0, "degenerate input → 0 (never NaN)");
});

await test("centroid: a square's centre, a right triangle's (a/3, b/3), and the vertex mean for a degenerate polygon", { "LY-20": "full" }, () => {
  const c1 = L.centroid([[0, 0], [10, 0], [10, 10], [0, 10]]); ok(near(c1[0], 5) && near(c1[1], 5), "square");
  const c2 = L.centroid([[0, 0], [9, 0], [0, 6]]); ok(near(c2[0], 3) && near(c2[1], 2), "triangle");
  const c3 = L.centroid([[0, 0], [4, 0], [8, 0]]); ok(near(c3[0], 4) && near(c3[1], 0), "collinear");
});

await test("slanted tray at 1 500 random frames: every tag inside the frame and inside its wall's visible polygon; sides are spines, north/south horizontal; the verdict follows the rule (scale ≥ 0.6 AND extent ≥ 96 px ⇔ detail)", { "LY-20": "full" }, () => {
  let seed = 29; const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  let glyphs = 0;
  for (let n = 0; n < 1500; n++) {
    const W = Math.floor(320 + rnd() * 3000), H = Math.floor(240 + rnd() * 1600);
    const g = L.fitSlant(W, H), lg = L.wallLegibility(g);
    const screen: P[] = [[0, 0], [g.W, 0], [g.W, g.H], [0, g.H]];
    for (const w of ["north", "south", "west", "east"] as const) {
      const t = lg[w];
      ok(t.x >= 0 && t.x <= g.W && t.y >= 0 && t.y <= g.H, `${w} tag off-frame at ${W}×${H}`);
      const vis = L.clipConvex(g.quads[w], screen) as P[];
      ok(inConvex([t.x, t.y], vis), `${w} tag not on its visible wall at ${W}×${H}`);
      ok(t.lod === (t.scale >= L.MIN_LEGIBLE_SCALE && t.extent >= L.MIN_DETAIL_EXTENT ? "detail" : "glyph"), "verdict = rule");
      if (w === "west" || w === "east") ok(t.vertical, `${w} should be a spine at ${W}×${H}`); else ok(!t.vertical, `${w} should be horizontal at ${W}×${H}`);
      if (t.lod === "glyph") glyphs++;
    }
  }
  console.log(`    ${glyphs} / 6000 wall faces need the glyph LOD under the slanted camera`);
});

await test("straight-down box: wall quads + floor tile the frame exactly (area identity), share the floor's edges, and the projected scale at the hinge edge is 1 while the floor edge is s (so the face is foreshortened, never magnified)", { "LY-20": "full" }, () => {
  for (const [W, H] of [[1440, 800], [1920, 980], [390, 700], [800, 300]] as const) {
    const g = boxGeometry(W, H), s = g.floorScale;
    const { quads, faces } = L.boxQuads(W, H, g.depth, s);
    const sum = (["north", "south", "west", "east"] as const).reduce((a, w) => a + area(quads[w] as P[]), 0);
    ok(near(sum + W * s * H * s, W * H, 1e-6 * W * H), `area identity at ${W}×${H}: ${sum + W * s * H * s} vs ${W * H}`);
    ok(near(quads.north[3][0], quads.west[1][0]) && near(quads.north[3][1], quads.west[1][1]), "north and west meet at the floor's corner");
    const sc = L.faceScale(faces.west.w, faces.west.h, quads.west);
    ok(sc > 0 && sc < 1, `west scale ${sc} in (0, 1)`);
    const lg = L.boxLegibility(W, H, g.depth, s);
    console.log(`    ${W}×${H}: D=${g.depth}, s=${s.toFixed(3)} → ${Object.entries(lg).map(([k, v]) => `${k} ${v.lod} ${v.scale.toFixed(2)}`).join(", ")}`);
  }
  // control: an unprojected face is legible, a heavily foreshortened one is not
  const R: P[] = [[0, 0], [600, 0], [600, 400], [0, 400]];
  ok(L.faceScale(600, 400, R) >= L.MIN_LEGIBLE_SCALE, "frontal face is legible");
  ok(L.faceScale(600, 400, [[0, 0], [600, 0], [600, 40], [0, 40]]) < L.MIN_LEGIBLE_SCALE, "10:1 squash is not");
});

finish();
