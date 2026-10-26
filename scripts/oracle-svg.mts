/**
 * Suite "oracle-svg": our vector geometry (src/lib/vector/path.ts) against svgelements 1.9.6 (independent Python
 * implementation that keeps arcs as TRUE elliptical arcs — analytic bounds, numeric length).
 *   - a corpus of grammar-tricky paths (implicit repeats, compact flags, "1.5.5", exponents, relative/absolute mixes,
 *     S/T reflection chains, rotated + out-of-range-radius arcs, multiple subpaths)
 *   - a corpus of transform lists (matrix/translate/scale/rotate(a cx cy)/skewX/skewY, nested order)
 * Tolerances: lines/cubics/quads exact (1e-9 relative); arcs → our cubic approximation (k = 4/3·tan(Δ/4), ≤ 90° pieces)
 * whose radial error bound is 2.7e-4·r, so bounds/length are compared at 1e-3·(scale).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import { parsePath, pathBounds, pathLength, parseTransform } from "../src/lib/vector/path.ts";
import { PATHS, TRANSFORMS } from "./svg-corpus.mts";

const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const { test, finish } = makeHarness("oracle-svg");

const oracle = JSON.parse(execFileSync(PY, ["scripts/oracles/svg_oracle.py"], { input: JSON.stringify({ paths: PATHS.map((p) => p.d), transforms: TRANSFORMS }), encoding: "utf8" }));

await test("svgelements: path bounds (exact for L/C/Q; arcs within 1e-3·r)", { "FF-32": "partial" }, () => {
  let worstExact = 0, worstArc = 0;
  PATHS.forEach((p, i) => {
    const r = parsePath(p.d); assert.equal(r.error, undefined, `${p.d}: ${r.error}`);
    const b = pathBounds(r.segs)!; const o = oracle.paths[i].bbox as number[];
    const ours = [b.x, b.y, b.x + b.w, b.y + b.h];
    const scale = Math.max(1, ...o.map(Math.abs));
    const err = Math.max(...ours.map((v, k) => Math.abs(v - o[k]))) / scale;
    if (p.arc) worstArc = Math.max(worstArc, err); else worstExact = Math.max(worstExact, err);
    assert.ok(err <= (p.arc ? 1e-3 : 1e-9), `${p.d}: ours ${ours.map((v) => v.toFixed(4))} vs svgelements ${o.map((v) => v.toFixed(4))}`);
  });
  console.log(`    worst relative bbox error: exact ${worstExact.toExponential(2)}, arcs ${worstArc.toExponential(2)}`);
});

await test("svgelements: path length (rel. error ≤ 1e-6 exact segments, ≤ 5e-4 arcs)", { "FF-32": "partial" }, () => {
  let worst = 0;
  PATHS.forEach((p, i) => {
    const L = pathLength(parsePath(p.d).segs), o = oracle.paths[i].length as number;
    if (p.oracleDeviates) { assert.equal(o, 0, "svgelements behaviour changed"); assert.ok(Math.abs(L - Math.SQRT2 * 50) < 1e-9); return; }
    const rel = Math.abs(L - o) / Math.max(1, o); worst = Math.max(worst, rel);
    assert.ok(rel <= (p.arc ? 5e-4 : 1e-6), `${p.d}: ours ${L} vs ${o}`);
  });
  console.log(`    worst relative length error ${worst.toExponential(2)}`);
});

await test("svgelements: end point of every path identical (relative-command bookkeeping)", { "FF-32": "partial" }, () => {
  PATHS.forEach((p, i) => {
    let sx = 0, sy = 0, cx = 0, cy = 0;
    for (const s of parsePath(p.d).segs) { if (s.t === "Z") { cx = sx; cy = sy; } else { cx = s.x; cy = s.y; if (s.t === "M") { sx = cx; sy = cy; } } }
    const last = { x: cx, y: cy };
    const o = oracle.paths[i].end as number[];
    if (!o) return;
    assert.ok(Math.abs(last.x - o[0]) < 1e-9 && Math.abs(last.y - o[1]) < 1e-9, `${p.d}: end ${last.x},${last.y} vs ${o}`);
  });
});

await test("svgelements: transform lists → identical matrices (1e-12)", { "FF-32": "partial" }, () => {
  TRANSFORMS.forEach((t, i) => {
    const ours = parseTransform(t), o = oracle.transforms[i] as number[];
    ours.forEach((v, k) => assert.ok(Math.abs(v - o[k]) < 1e-9 * Math.max(1, Math.abs(o[k])), `${t}: [${ours}] vs [${o}]`));
  });
});
finish();
