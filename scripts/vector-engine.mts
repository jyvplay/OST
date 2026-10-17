/**
 * Suite "vector": headless tests for src/lib/vector (FF-32 vector engine v2). Expected values are hand-derived from
 * SVG 1.1 (path grammar §8.3, error handling F.2, arc implementation notes F.6, transforms §7.6, gradients §13.2)
 * and closed-form geometry. External oracles: scripts/oracle-svg.mts (svgelements) and scripts/e2e-vector.mts (Chromium).
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { parseXml, textContent, childEls } from "../src/lib/vector/xml.ts";
import {
  apply, arcToCubics, containsPoint, distanceToPath, invert, mul, parsePath, parseTransform, pathBounds, pathLength, rotateM,
  serializePath, starPoints, polyPath, type Seg,
} from "../src/lib/vector/path.ts";
import {
  alignShapes, blankDoc, deleteShapes, distributeShapes, duplicateShapes, exportSvg, groupShapes, hitTest, importSvg, migrate, moveNode,
  moveShapes, pathNodes, reorder, resizeShapes, rotateShapes, selectionBounds, shapeBounds, shapesInRect, toPath, ungroup, validateDoc,
  flipShapes, arrowSegs, restar, type Shape, type VDoc,
} from "../src/lib/vector/model.ts";

const { test, finish } = makeHarness("vector");
const near = (a: number, b: number, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b}`);
const boxNear = (a: { x: number; y: number; w: number; h: number } | null, b: number[], eps = 1e-6) => {
  assert.ok(a, "no bounds"); [a.x, a.y, a.w, a.h].forEach((v, i) => near(v, b[i], eps, `box[${i}]`));
};
const I = [1, 0, 0, 1, 0, 0] as const;
const doc = (shapes: Shape[], gradients: VDoc["gradients"] = []): VDoc => ({ version: 2, title: "t", width: 400, height: 300, shapes, gradients });
const R = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Shape> = {}): Shape => ({ id, kind: "rect", transform: [...I], style: { fill: "#f00", stroke: "none", strokeWidth: 1 }, x, y, w, h, rx: 0, ry: 0, ...extra } as Shape);

await test("path grammar: implicit repeats, '1.5.5', signs as separators, exponents, compact arc flags", { "FF-32": "partial" }, () => {
  const a = parsePath("M1.5.5L3.25-1.75 6e1 2E1").segs;
  assert.deepEqual(a, [{ t: "M", x: 1.5, y: 0.5 }, { t: "L", x: 3.25, y: -1.75 }, { t: "L", x: 60, y: 20 }]);
  const b = parsePath("m5 5 10 10 20-5").segs;            // relative implicit lineto after m
  assert.deepEqual(b.map((s) => s.t === "Z" ? [] : [s.x, s.y]), [[5, 5], [15, 15], [35, 10]]);
  const c = parsePath("M0 0a5 5 0 1010 0").segs;          // flags "1","0" then x=10
  assert.equal(c.length, 3, "large arc of a 5-radius circle over 10 px = 180° → 2 cubic pieces");
  const last = c[c.length - 1] as Extract<Seg, { t: "C" }>; near(last.x, 10); near(last.y, 0);
  const z = parsePath("M0 0h10v10zm5 5h1").segs;           // after z, m is relative to the subpath start (0,0)
  assert.deepEqual(z[4], { t: "M", x: 5, y: 5 });
});

await test("path errors (SVG F.2): render up to the last good segment and report", { "FF-32": "full" }, () => {
  const r = parsePath("M0 0 L10 10 L20");
  assert.equal(r.segs.length, 2); assert.match(r.error!, /expected a number/);
  assert.equal(parsePath("L10 10").segs.length, 0);
  assert.match(parsePath("L10 10").error!, /start with M/);
  assert.match(parsePath("M0 0 A5 5 0 2 0 10 10").error!, /arc flag/);
  assert.match(parsePath("M0 0 Z 5").error!, /after Z/);
  assert.match(parsePath("M0 0 X 5").error!, /unknown command/);
  assert.equal(parsePath("").segs.length, 0);
});

await test("Q/T → cubic elevation is exact; S/T reflect only after C/S resp. Q/T", { "FF-32": "partial" }, () => {
  const [, q] = parsePath("M0 0 Q50 100 100 0").segs as Extract<Seg, { t: "C" }>[];
  // quadratic at t=.5: (50,50); cubic at t=.5: (P0 + 3C1 + 3C2 + P3)/8
  near((0 + 3 * q.x1 + 3 * q.x2 + 100) / 8, 50); near((0 + 3 * q.y1 + 3 * q.y2 + 0) / 8, 50);
  const s = parsePath("M10 10 S 50 80 90 10").segs[1] as Extract<Seg, { t: "C" }>;
  assert.deepEqual([s.x1, s.y1], [10, 10]);
  const t = parsePath("M0 0 Q10 10 20 0 T40 0").segs[2] as Extract<Seg, { t: "C" }>;
  // reflected control (30,-10): C1 = P0 + 2/3(Q-P0) = (20 + 20/3, -20/3)
  near(t.x1, 20 + 20 / 3); near(t.y1, -20 / 3);
});

await test("arcs (F.6.5/F.6.6): semicircle bounds/length, radius scaling, rx=0 line, zero-length arc omitted", { "FF-32": "full" }, () => {
  const semi = parsePath("M0 0 A50 50 0 0 1 100 0").segs;
  boxNear(pathBounds(semi), [0, -50, 100, 50], 0.02);                // sweep=1 goes through (50,-50) in y-down space
  near(pathLength(semi), Math.PI * 50, 0.03); // cubic approximation over-estimates arc length by ≈1.4e-4 relative
  boxNear(pathBounds(parsePath("M0 0 A50 50 0 0 0 100 0").segs), [0, 0, 100, 50], 0.02);
  boxNear(pathBounds(parsePath("M0 0 A1 1 0 0 1 100 0").segs), [0, -50, 100, 50], 0.02);   // Λ > 1 → radii scaled to 50
  assert.deepEqual(arcToCubics(0, 0, 0, 10, 0, 0, 1, 50, 50), [{ t: "L", x: 50, y: 50 }]);
  assert.deepEqual(arcToCubics(5, 5, 10, 10, 0, 0, 1, 5, 5), []);
  // each piece ≤ 90°: a 270° arc → 3 pieces; max radial deviation of the cubic approximation ≤ 2.8e-4·r
  const big = arcToCubics(100, 0, 100, 100, 0, 1, 1, 0, -100);
  assert.equal(big.length, 3);
  let worst = 0;
  let px = 100, py = 0;
  for (const c of big as Extract<Seg, { t: "C" }>[]) {
    for (let k = 1; k < 50; k++) { const t = k / 50, u = 1 - t; const x = u * u * u * px + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, y = u * u * u * py + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y; worst = Math.max(worst, Math.abs(Math.hypot(x, y) - 100)); }
    px = c.x; py = c.y;
  }
  assert.ok(worst <= 0.028, `radial error ${worst}`);
});

await test("cubic bounds use derivative roots (not control hull); length of closed square includes Z", { "FF-32": "partial" }, () => {
  boxNear(pathBounds(parsePath("M0 0C0 100 100 100 100 0").segs), [0, 0, 100, 75], 1e-12);
  near(pathLength(parsePath("M0 0h10v10h-10z").segs), 40, 1e-9);
  near(pathLength(parsePath("M0 0 C0 0 100 0 100 0").segs), 100, 1e-6);
});

await test("fill rules: nonzero vs evenodd on nested same-direction squares; distance to outline", { "FF-32": "partial" }, () => {
  const sq = parsePath("M0 0h100v100h-100z M25 25h50v50h-50z").segs;
  assert.equal(containsPoint(sq, 50, 50, "nonzero"), true);
  assert.equal(containsPoint(sq, 50, 50, "evenodd"), false);
  assert.equal(containsPoint(sq, 10, 10, "evenodd"), true);
  assert.equal(containsPoint(sq, 150, 50), false);
  const rev = parsePath("M0 0h100v100h-100z M25 25v50h50v-50z").segs;  // opposite winding → hole under nonzero too
  assert.equal(containsPoint(rev, 50, 50, "nonzero"), false);
  near(distanceToPath(parsePath("M0 0 L100 0").segs, 50, 7), 7, 1e-9);
  near(distanceToPath(parsePath("M0 0 L100 0").segs, 110, 0), 10, 1e-9);
});

await test("transforms: list order, rotate(a cx cy), skew, inverse; serialise rounding", { "FF-32": "partial" }, () => {
  const p = apply(parseTransform("translate(10,20) rotate(90)"), 1, 0); near(p[0], 10); near(p[1], 21);
  const q = apply(parseTransform("rotate(90 50 50)"), 100, 50); near(q[0], 50); near(q[1], 100);
  const s = apply(parseTransform("skewX(45)"), 0, 10); near(s[0], 10); near(s[1], 10);
  const m = parseTransform("matrix(2 1 -1 3 5 6) rotate(17)");
  const back = apply(mul(invert(m), m), 3, 4); near(back[0], 3); near(back[1], 4);
  assert.throws(() => invert([0, 0, 0, 0, 1, 1]), /singular/);
  assert.equal(serializePath(parsePath("M0.00049 -0.0004 L1.23456 2").segs), "M0 0 L1.235 2");
});

await test("XML reader: quoted '>' in attributes, entities, no DOCTYPE entity expansion, depth limit", { "FF-32": "full" }, () => {
  const x = parseXml(`<svg><text data-x="a>b" id='q'>&lt;b&gt; &amp; &#x41;&#66;</text></svg>`);
  const t = childEls(x)[0];
  assert.equal(t.attrs["data-x"], "a>b"); assert.equal(textContent(t), "<b> & AB");
  const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><svg><text>&lol2;</text></svg>`;
  const b = parseXml(bomb);
  assert.equal(textContent(b).trim(), "&lol2;", "custom entities must stay unexpanded");
  assert.throws(() => parseXml("<a>".repeat(300)), /too deep/i);
});

await test("SVG import: style attr beats presentation attr, g inheritance, circle→ellipse, %-offset gradients, <use>", { "FF-32": "full" }, () => {
  const src = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 200 100" width="400" height="200">
    <defs><linearGradient id="g1"><stop offset="0%" stop-color="#ff0000"/><stop offset="50%" style="stop-color:#00ff00;stop-opacity:.5"/><stop offset="0.25" stop-color="blue"/></linearGradient>
    <linearGradient id="g2" xlink:href="#g1" x2="0" y2="1"/><rect id="tpl" width="10" height="10"/></defs>
    <g fill="#123456" stroke="red" stroke-width="3" transform="translate(5 5)" opacity="0.5">
      <rect x="1" y="2" width="30" height="20" fill="blue" style="fill: #00ff00; stroke-width: 2px"/>
      <circle cx="50" cy="50" r="10"/>
    </g>
    <path d="M0 0 L10 10" stroke="url(#g2)"/>
    <use href="#tpl" x="100" y="20" fill="url(#g1)"/>
  </svg>`;
  const { doc: d, dropped, warnings } = importSvg(src, "t");
  assert.equal(d.width, 200); assert.equal(d.height, 100);
  assert.deepEqual(dropped, []); assert.deepEqual(warnings, []);
  const g = d.shapes[0] as Extract<Shape, { kind: "group" }>;
  assert.equal(g.kind, "group"); assert.equal(g.style.opacity, 0.5); assert.deepEqual(g.transform, [1, 0, 0, 1, 5, 5]);
  const r = g.children[0]; assert.equal(r.style.fill, "#00ff00"); assert.equal(r.style.stroke, "red"); assert.equal(r.style.strokeWidth, 2);
  const c = g.children[1]; assert.equal(c.kind, "ellipse"); assert.equal(c.style.fill, "#123456"); assert.equal(c.style.strokeWidth, 3);
  const g1 = d.gradients.find((x) => x.id === "g1")!;
  assert.deepEqual(g1.stops.map((s) => s.offset), [0, 0.5, 0.5], "50% → .5 (not NaN); 0.25 after 0.5 clamps to 0.5 (monotonic, §13.2.4)");
  assert.equal(g1.stops[1].opacity, 0.5); assert.equal(g1.stops[1].color, "#00ff00");
  const g2 = d.gradients.find((x) => x.id === "g2")!;
  assert.equal(g2.stops.length, 3, "stops inherited through xlink:href"); assert.equal(g2.x2, 0); assert.equal(g2.y2, 1);
  const use = d.shapes[2] as Extract<Shape, { kind: "group" }>;
  assert.equal(use.kind, "group"); assert.deepEqual(use.transform, [1, 0, 0, 1, 100, 20]); assert.equal(use.children[0].style.fill, "url(#g1)");
  boxNear(shapeBounds(use), [100, 20, 10, 10]);
});

await test("SVG import security: scripts, handlers, foreignObject, external refs, CSS, filters reported and never exported", { "FF-32": "full" }, () => {
  const evil = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" onload="alert(1)">
    <script>alert(2)</script><style>rect{fill:red}</style>
    <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
    <image href="https://evil.example/x.png" width="10" height="10"/>
    <rect width="10" height="10" fill="url(https://evil.example/#g)" onclick="steal()" filter="url(#f)" style="behavior:url(x.htc)"/>
    <use href="https://evil.example/sprite.svg#icon"/>
    <use id="loop" href="#loop"/>
    <a href="javascript:alert(3)"><circle r="5" cx="50" cy="50" fill="javascript:alert(4)"/></a>
    <filter id="f"><feGaussianBlur stdDeviation="2"/></filter><mask id="m"/><clipPath id="c"/>
  </svg>`;
  const { doc: d, dropped } = importSvg(evil);
  const txt = dropped.join(" | ");
  for (const w of ["script", "CSS <style>", "foreignObject", "raster <image>", "event-handler", "external <use>", "recursive", "filters", "masks", "clip paths", "unsupported paint", "behavior", "hyperlinks"]) assert.ok(txt.includes(w), `missing report for ${w}: ${txt}`);
  const out = exportSvg(d);
  for (const bad of ["script", "onload", "onclick", "javascript", "evil.example", "foreignObject", "<style", "behavior"]) assert.ok(!out.includes(bad), `export contains ${bad}`);
  assert.ok(out.includes("<rect"), "the safe rect survives");
});

await test("export → import round trip is a fixed point (shapes, styles, bounds, gradients)", { "FF-32": "full" }, () => {
  const d0 = blankDoc();
  const d1 = importSvg(exportSvg(d0), d0.title).doc;
  const d2 = importSvg(exportSvg(d1), d0.title).doc;
  assert.equal(exportSvg(d1), exportSvg(d2));
  assert.equal(d1.shapes.length, 5, "background rect + 4 shapes");
  d0.shapes.forEach((s, i) => {
    const a = shapeBounds(s)!, b = shapeBounds(d1.shapes[i + 1])!;
    [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h].forEach((v) => near(v, 0, 2e-3));
  });
  assert.equal(d1.gradients[0].stops[1].color, "#9b5bff");
});

await test("ops: move/align/distribute/resize/rotate/flip keep exact geometry", { "FF-32": "full" }, () => {
  let d = doc([R("a", 10, 10, 20, 20), R("b", 100, 50, 40, 10), R("c", 300, 0, 10, 10)]);
  d = moveShapes(d, ["a"], 5, -5); boxNear(shapeBounds(d.shapes[0]), [15, 5, 20, 20]);
  const al = alignShapes(d, ["a", "b", "c"], "left"); al.shapes.forEach((s) => near(shapeBounds(s)!.x, 15));
  const top = alignShapes(d, ["a", "b", "c"], "bottom"); top.shapes.forEach((s) => near(shapeBounds(s)!.y + shapeBounds(s)!.h, 60));
  const page = alignShapes(d, ["b"], "hcenter"); near(shapeBounds(page.shapes[1])!.x, 180);
  const di = distributeShapes(d, ["a", "b", "c"], "h");     // span 15..310, widths 20+40+10 → gap (295-70)/2 = 112.5
  near(shapeBounds(di.shapes[1])!.x, 15 + 20 + 112.5);
  const rs = resizeShapes(d, ["b"], { x: 100, y: 50, w: 40, h: 10 }, { x: 0, y: 0, w: 80, h: 30 });
  const rb = rs.shapes[1] as Extract<Shape, { kind: "rect" }>; assert.deepEqual([rb.x, rb.y, rb.w, rb.h], [0, 0, 80, 30]); assert.deepEqual(rb.transform, [...I], "axis-aligned resize baked into the rect");
  const ro = rotateShapes(d, ["b"], 90); boxNear(shapeBounds(ro.shapes[1]), [115, 35, 10, 40]);
  near(Math.atan2(ro.shapes[1].transform[1], ro.shapes[1].transform[0]) * 180 / Math.PI, 90);
  const fl = flipShapes(doc([{ id: "p", kind: "path", transform: [...I], style: {}, segs: parsePath("M0 0 L10 0 L10 5 Z").segs }]), ["p"], "h");
  assert.deepEqual((fl.shapes[0] as Extract<Shape, { kind: "path" }>).segs.slice(0, 2).map((s) => s.t === "Z" ? [] : [s.x, s.y]), [[10, 0], [0, 0]]);
});

await test("ops: group/ungroup preserve bounds through a rotated group; z-order; duplicate; delete; marquee", { "FF-32": "full" }, () => {
  let d = doc([R("a", 0, 0, 10, 10), R("b", 20, 0, 10, 10), R("c", 50, 50, 5, 5)]);
  const gr = groupShapes(d, ["a", "b"]); assert.ok(gr.id);
  d = gr.doc; assert.deepEqual(d.shapes.map((s) => s.id), [gr.id, "c"]);
  d = rotateShapes(d, [gr.id!], 90);
  const gb = shapeBounds(d.shapes[0])!;
  const un = ungroup(d, gr.id!); assert.equal(un.ids.length, 2);
  const ub = selectionBounds(un.doc, un.ids)!;
  [gb.x - ub.x, gb.y - ub.y, gb.w - ub.w, gb.h - ub.h].forEach((v) => near(v, 0, 1e-9));
  boxNear(gb, [10, -10, 10, 30]);
  const z = doc([R("a", 0, 0, 1, 1), R("b", 0, 0, 1, 1), R("c", 0, 0, 1, 1)]);
  assert.deepEqual(reorder(z, ["a"], "front").shapes.map((s) => s.id), ["b", "c", "a"]);
  assert.deepEqual(reorder(z, ["c"], "back").shapes.map((s) => s.id), ["c", "a", "b"]);
  assert.deepEqual(reorder(z, ["a"], "forward").shapes.map((s) => s.id), ["b", "a", "c"]);
  assert.deepEqual(reorder(z, ["c"], "backward").shapes.map((s) => s.id), ["a", "c", "b"]);
  const dup = duplicateShapes(z, ["a", "b"]);
  assert.equal(new Set(dup.doc.shapes.map((s) => s.id)).size, 5); boxNear(shapeBounds(dup.doc.shapes[3]), [10, 10, 1, 1]);
  assert.deepEqual(deleteShapes(z, ["b"]).shapes.map((s) => s.id), ["a", "c"]);
  assert.deepEqual(shapesInRect(doc([R("a", 0, 0, 10, 10), R("b", 20, 0, 10, 10)]), { x: -1, y: -1, w: 15, h: 15 }), ["a"]);
});

await test("toPath keeps exact bounds for rect(rx)/ellipse/polygon; text refuses (no glyph data)", { "FF-32": "partial" }, () => {
  const shapes: Shape[] = [
    R("a", 10, 10, 50, 30, { rx: 8, ry: 8 } as Partial<Shape>),
    { id: "e", kind: "ellipse", transform: [...I], style: {}, cx: 100, cy: 100, rx: 40, ry: 20 },
    { id: "p", kind: "polygon", transform: [...I], style: {}, points: starPoints(50, 50, 40, 20, 5) },
  ];
  for (const s of shapes) { const a = shapeBounds(s)!, b = shapeBounds(toPath(s))!; [a.x - b.x, a.y - b.y, a.w - b.w, a.h - b.h].forEach((v) => near(v, 0, 1e-9)); }
  boxNear(shapeBounds(shapes[1]), [60, 80, 80, 40], 1e-9);
  assert.throws(() => toPath({ id: "t", kind: "text", transform: [...I], style: {}, x: 0, y: 0, text: "x" }), /glyph/);
  assert.equal(polyPath([0, 0, 1, 1], true).at(-1)!.t, "Z");
});

await test("hit test: fill-rule holes, stroke tolerance, transformed shapes, topmost wins, hidden/locked skipped", { "FF-32": "full" }, () => {
  const ring: Shape = { id: "ring", kind: "path", transform: [...I], style: { fill: "#000", fillRule: "evenodd" }, segs: parsePath("M0 0h100v100h-100z M25 25h50v50h-50z").segs };
  const ln: Shape = { id: "ln", kind: "line", transform: [...I], style: { stroke: "#000", strokeWidth: 10 }, x1: 200, y1: 0, x2: 300, y2: 0 };
  const rot: Shape = { ...R("rot", 0, 0, 100, 10), transform: rotateM(90, 0, 0) } as Shape;
  const d = doc([ring, ln, rot]);
  assert.equal(hitTest(d, 10, 50), "ring"); assert.equal(hitTest(d, 50, 50), null, "evenodd hole");
  assert.equal(hitTest(d, 250, 4), "ln"); assert.equal(hitTest(d, 250, 7), null);
  assert.equal(hitTest(d, -5, 50), "rot", "rotated rect occupies x∈[-10,0], y∈[0,100]");
  assert.equal(hitTest(d, 5, 5), "ring");
  assert.equal(hitTest({ ...d, shapes: [ring, { ...rot, transform: [...I] } as Shape] }, 5, 5), "rot", "topmost wins");
  assert.equal(hitTest({ ...d, shapes: [{ ...ring, hidden: true }] }, 10, 50), null);
  assert.equal(hitTest({ ...d, shapes: [{ ...ring, locked: true }] }, 10, 50), null);
});

await test("path node editing: anchors carry their handles; handles move alone", { "FF-32": "partial" }, () => {
  const segs = parsePath("M0 0 C10 0 20 10 30 10 C40 10 50 0 60 0").segs;
  const nodes = pathNodes(segs);
  assert.deepEqual(nodes.map((n) => n.role), ["anchor", "out", "in", "anchor", "out", "in", "anchor"]);
  const moved = moveNode(segs, { seg: 1, role: "anchor" }, 30, 20) as Extract<Seg, { t: "C" }>[];
  assert.deepEqual([moved[1].x2, moved[1].y2, moved[1].x, moved[1].y, moved[2].x1, moved[2].y1], [20, 20, 30, 20, 40, 20]);
  const h = moveNode(segs, { seg: 1, role: "out" }, 45, 15) as Extract<Seg, { t: "C" }>[];
  assert.deepEqual([h[2].x1, h[2].y1, h[1].x, h[1].y], [45, 15, 30, 10]);
});

await test("v1 .fsvg migration and untrusted v2 validation", { "FF-32": "full", "FF-04": "partial" }, () => {
  const v1 = { title: "Old", width: 640, height: 480, shapes: [
    { id: "s1", kind: "rect", x: 1, y: 2, w: 3, h: 4, fill: "#5b8cff", stroke: "#1e293b" },
    { id: "s2", kind: "circle", x: 50, y: 60, r: 7, fill: "#39d98a", stroke: "none" },
    { id: "s3", kind: "line", x: 0, y: 0, x2: 9, y2: 9, fill: "none", stroke: "#fff" },
    { id: "s4", kind: "text", x: 5, y: 6, text: "<hi>", fill: "javascript:alert(1)", stroke: "none" }] };
  const d = migrate(v1);
  assert.equal(d.version, 2); assert.deepEqual(d.shapes.map((s) => s.kind), ["rect", "ellipse", "line", "text"]);
  boxNear(shapeBounds(d.shapes[1]), [43, 53, 14, 14]); assert.equal(d.shapes[3].style.fill, "none");
  assert.ok(exportSvg(d).includes("&lt;hi&gt;"));
  const bad = validateDoc({ ...blankDoc(), shapes: [{ id: "x", kind: "iframe" } as unknown as Shape, { ...R("r", 0, 0, 1, 1), style: { fill: "url(https://x/#a)", fontFamily: "a;}</style><script>" } } as Shape] });
  assert.equal(bad.shapes.length, 1); assert.equal(bad.shapes[0].style.fill, "none"); assert.equal(bad.shapes[0].style.fontFamily, undefined);
  assert.throws(() => migrate({ nope: 1 }), /not a vector document/);
});
await test("parametric star survives move/rotate; arrow is plain path data (no <marker>)", { "FF-32": "partial" }, () => {
  const st: Shape = { id: "st", kind: "polygon", transform: [...I], style: {}, points: starPoints(100, 100, 50, 25, 5), star: { n: 5, inner: 0.5 } };
  let d = doc([st]);
  d = moveShapes(d, ["st"], 30, -10); d = rotateShapes(d, ["st"], 36, 130, 90);
  const re = restar(d.shapes[0], 7, 0.3) as Extract<Shape, { kind: "polygon" }>;
  assert.equal(re.points.length, 28); assert.deepEqual(re.star, { n: 7, inner: 0.3 });
  near(re.points[0], d.shapes[0].kind === "polygon" ? d.shapes[0].points[0] : NaN, 1e-9, "first vertex (rotation) kept x");
  near(Math.hypot(re.points[0] - 130, re.points[1] - 90), 50, 1e-9, "outer radius about the moved centre");
  near(Math.hypot(re.points[2] - 130, re.points[3] - 90), 15, 1e-9, "inner radius = 0.3·R");
  const plain = { ...st, star: undefined } as Shape; assert.equal(restar(plain, 7, 0.3), plain, "non-star polygon untouched");
  const a = arrowSegs(0, 0, 100, 0, 10);
  assert.deepEqual(a.slice(0, 2), [{ t: "M", x: 0, y: 0 }, { t: "L", x: 100, y: 0 }]);
  near((a[2] as { x: number }).x, 100 - 10 * Math.cos(Math.PI / 6)); near((a[2] as { y: number }).y, 5);
  const out = exportSvg(doc([{ id: "ar", kind: "path", transform: [...I], style: { stroke: "#000", fill: "none" }, segs: a }]));
  assert.ok(!out.includes("marker") && out.includes("M0 0 L100 0 M91.34 5 L100 0 L91.34 -5"), out);
});
finish();
