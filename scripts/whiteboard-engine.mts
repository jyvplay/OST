/**
 * Unit suite "whiteboard-engine" (TT23): the pure Whiteboard engine (src/lib/whiteboard-core.ts).
 * Expected values are worked out by hand in the comments, not read back from the engine.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/whiteboard-engine.mts
 */
import { makeHarness } from "./harness.mts";
import * as W from "../src/lib/whiteboard-core.ts";

const { test, finish } = makeHarness("whiteboard-engine");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const near = (a: number, b: number, m: string, eps = 1e-6) => { if (Math.abs(a - b) > eps) throw new Error(`${m}: got ${a}, want ${b}`); };
const P = (p: W.Pt, x: number, y: number, m: string) => { near(p.x, x, `${m}.x`); near(p.y, y, `${m}.y`); };

/** rect A at (0,0) 100×50 and ellipse B centred at (300,25) with radii 50×25, joined by an arrow A→B. */
function fixture() {
  let b = W.emptyBoard(); let a: string, e: string, ar: string;
  [b, a] = W.addEl(b, { kind: "rect", x: 0, y: 0, w: 100, h: 50, text: "Start" });
  [b, e] = W.addEl(b, { kind: "ellipse", x: 250, y: 0, w: 100, h: 50, text: "End" });
  [b, ar] = W.addEl(b, { kind: "arrow", x: 50, y: 25, w: 250, h: 0, start: a, end: e });
  return { b, a, e, ar };
}

await test("boundary points: rect, ellipse and diamond exits along the ray from the centre", { "WB-02": "full" }, () => {
  const rect = { id: "r", kind: "rect", x: 0, y: 0, w: 100, h: 50, stroke: "", fill: "", sw: 1, text: "" } as W.El;
  P(W.boundaryPoint(rect, { x: 250, y: 25 }), 100, 25, "rect → right edge");          // centre (50,25), horizontal ray
  P(W.boundaryPoint(rect, { x: 50, y: -100 }), 50, 0, "rect → top edge");
  P(W.boundaryPoint(rect, { x: 150, y: 125 }), 75, 50, "rect corner-ish");              // dir (100,100): t = min(50/100, 25/100) = .25 → (75,50)
  const ell = { ...rect, kind: "ellipse", x: 150, y: 75, w: 100, h: 50 } as W.El;       // centre (200,100), rx 50, ry 25
  P(W.boundaryPoint(ell, { x: 0, y: 100 }), 150, 100, "ellipse ← left");
  P(W.boundaryPoint(ell, { x: 200, y: 0 }), 200, 75, "ellipse ↑ top");
  const dia = { ...rect, kind: "diamond", x: -50, y: -50, w: 100, h: 100 } as W.El;     // |x|/50 + |y|/50 = 1, 45° → (25,25)
  P(W.boundaryPoint(dia, { x: 100, y: 100 }), 25, 25, "diamond 45°");
  P(W.boundaryPoint(rect, { x: 50, y: 25 }), 50, 25, "degenerate: target = centre");
});

await test("bound connectors follow their shapes; moving a lone arrow detaches it where it was", { "WB-02": "full" }, () => {
  let { b, a, e, ar } = fixture();
  let r = W.resolveConnector(b, b.els.find((x) => x.id === ar)!);
  P(r.a, 100, 25, "start on A's right edge"); P(r.z, 250, 25, "end on B's left edge");
  b = W.move(b, [a], 0, 100);                                                             // A centre → (50,125); B centre (300,25)
  r = W.resolveConnector(b, b.els.find((x) => x.id === ar)!);
  // A: dir (250,-100) → t = min(50/250, 25/100) = .2 → (100, 105). B: dir (-250,100); ellipse t = 1/√(25+16) → (300-250/√41, 25+100/√41)
  P(r.a, 100, 105, "A end after move"); P(r.z, 300 - 250 / Math.sqrt(41), 25 + 100 / Math.sqrt(41), "B end after move");
  const arrow = b.els.find((x) => x.id === ar)!;
  ok(arrow.start === a && arrow.end === e, "still bound (the shape moved, not the arrow)");
  const b2 = W.move(b, [ar], 10, 0);
  const moved = b2.els.find((x) => x.id === ar)!;
  ok(moved.start === null && moved.end === null, "moving the arrow alone detaches both ends");
  near(moved.x, 110, "frozen start + dx"); near(moved.y, 105, "frozen start y");
  const b3 = W.move(b, [a, e, ar], 5, 5);
  ok(b3.els.find((x) => x.id === ar)!.start === a, "moving the arrow WITH both shapes keeps it bound");
});

await test("delete and duplicate keep connector integrity", { "WB-02": "full", "WB-03": "full" }, () => {
  const { b, a, e, ar } = fixture();
  const d = W.remove(b, [e]);
  const arrow = d.els.find((x) => x.id === ar)!;
  ok(d.els.length === 2 && arrow.start === a && arrow.end === null, "arrow kept, end detached");
  near(arrow.x + arrow.w, 250, "detached end frozen at B's old boundary x"); near(arrow.y + arrow.h, 25, "…and y");
  const [d2, ids] = W.duplicate(b, [a, e, ar]);
  ok(ids.length === 3 && new Set([...ids, a, e, ar]).size === 6, "fresh ids");
  const copy = d2.els.find((x) => x.id === ids[2])!;
  ok(copy.start === ids[0] && copy.end === ids[1], "binding remapped to the copies");
  near(d2.els.find((x) => x.id === ids[0])!.x, 16, "offset 16");
  const [d3, only] = W.duplicate(b, [ar]);
  const lone = d3.els.find((x) => x.id === only[0])!;
  ok(lone.start === null && lone.end === null, "duplicating just the arrow detaches the copy");
  ok(d3.seq > b.seq && !d3.els.some((x, i) => d3.els.findIndex((y) => y.id === x.id) !== i), "no duplicate ids, seq advanced");
});

await test("hit testing, marquee and bind targets respect real shape outlines and z-order", { "WB-01": "full" }, () => {
  let b = W.emptyBoard(); let r: string, el: string, ln: string;
  [b, r] = W.addEl(b, { kind: "rect", x: 0, y: 0, w: 100, h: 100 });
  [b, el] = W.addEl(b, { kind: "ellipse", x: 50, y: 50, w: 100, h: 100 });             // on top, overlaps the rect's corner
  [b, ln] = W.addEl(b, { kind: "line", x: 200, y: 0, w: 100, h: 100 });
  ok(W.hitTest(b, { x: 90, y: 90 }) === el, "overlap → topmost (ellipse)");
  ok(W.hitTest(b, { x: 55, y: 55 }) === r, "inside the ellipse's box but outside its outline → rect beneath");  // (55,55) is 63.6 from (100,100) > 50
  ok(W.hitTest(b, { x: 250, y: 53 }) === ln, "within tolerance of the line");               // distance from (250,53) to y=x-200 is 3/√2 ≈ 2.1
  ok(W.hitTest(b, { x: 250, y: 80 }) === null, "far from the line → nothing");
  ok(W.bindTarget(b, { x: 250, y: 50 }) === null, "lines are never bind targets");
  ok(W.bindTarget(b, { x: 10, y: 10 }) === r, "bind target = shape under the point");
  const m = W.marquee(b, { x: -5, y: -5, w: 160, h: 160 });
  ok(m.length === 2 && m.includes(r) && m.includes(el), "marquee takes only fully-enclosed elements");
  ok(W.marquee(b, { x: 155, y: 155, w: -160, h: -160 }).length === 2, "negative-size marquee normalised");
});

await test("align, distribute, z-order and groups", { "WB-03": "full" }, () => {
  let b = W.emptyBoard(); const ids: string[] = [];
  for (const [x, y, w] of [[0, 0, 20], [37, 40, 10], [100, 10, 40]]) { let id: string; [b, id] = W.addEl(b, { kind: "rect", x, y, w, h: 20 }); ids.push(id); }
  const L = W.align(b, ids, "left");
  ok(L.els.every((e) => e.x === 0), "left → all x = 0");
  const R = W.align(b, ids, "right");                                                     // union right = 140
  ok(R.els.every((e) => e.x + e.w === 140), "right → all right edges 140");
  const D = W.distribute(b, ids, "h");                                                     // span 0..140, widths 70 → 2 gaps of 35 → middle x = 20 + 35 = 55
  near(D.els[1].x, 55, "distribute: middle x"); near(D.els[0].x, 0, "first fixed"); near(D.els[2].x, 100, "last fixed");
  ok(W.distribute(b, ids.slice(0, 2), "h") === b, "fewer than 3 → unchanged");
  const F = W.reorder(b, [ids[0]], "front");
  ok(F.els.at(-1)!.id === ids[0], "bring to front");
  const Bk = W.reorder(b, [ids[2]], "backward");
  ok(Bk.els.map((e) => e.id).join() === [ids[0], ids[2], ids[1]].join(), "send backward one step");
  const G = W.group(b, [ids[0], ids[1]]);
  ok(W.expandGroups(G, [ids[0]]).sort().join() === [ids[0], ids[1]].sort().join(), "selecting one member selects the group");
  ok(W.expandGroups(W.ungroup(G, [ids[1]]), [ids[0]]).length === 1, "ungroup");
});

await test("pen strokes: Ramer–Douglas–Peucker simplification and scaling", { "WB-01": "full" }, () => {
  const line: [number, number][] = Array.from({ length: 50 }, (_, i) => [i, i * 2]);    // collinear → 2 points
  ok(W.simplify(line).length === 2, "collinear points collapse to the two ends");
  const corner: [number, number][] = [[0, 0], [5, 0.1], [10, 0], [10, 5], [10, 10]];    // the corner (10,0) must survive
  const s = W.simplify(corner);
  ok(s.length === 3 && s[1][0] === 10 && s[1][1] === 0, `corner kept: ${JSON.stringify(s)}`);
  let b = W.emptyBoard(); let p: string;
  [b, p] = W.addEl(b, { kind: "pen", x: 10, y: 10, pts: [[0, 0], [10, 20]] });
  const r = W.resize(b, p, { x: 0, y: 0, w: 20, h: 40 });
  const bb = W.bounds(r, r.els[0]);
  ok(bb.x === 0 && bb.y === 0 && bb.w === 20 && bb.h === 40, `pen scaled ×2: ${JSON.stringify(bb)}`);
  ok(W.snap(37, 20) === 40 && W.snap(29, 20) === 20 && W.snap(29, 0) === 29, "grid snap");
});

await test("SVG export is escaped and self-contained; .fboard round-trips; hostile files are refused or repaired", { "WB-04": "full" }, () => {
  let { b, a } = fixture();
  b = W.patch(b, [a], () => ({ text: '<script>alert(1)</script>\n"two" & more' }));
  const svg = W.toSvg(b);
  ok(svg.startsWith("<svg") && !svg.includes("<script") && svg.includes("&lt;script&gt;") && svg.includes("&quot;two&quot; &amp; more"), "escaped text");
  ok(!/on\w+=|javascript:|<foreignObject/i.test(svg), "no handlers / js urls / foreign content");
  ok((svg.match(/<tspan/g) ?? []).length >= 3, "multi-line text becomes tspans");
  const evil = W.patch(b, [a], () => ({ fill: 'red" onload="alert(1)' }));
  ok(!W.toSvg(evil).includes("onload"), "colour injection neutralised at export");
  const rt = W.parseBoard(W.serialize(b));
  ok(rt.repaired === 0 && JSON.stringify(rt.board) === JSON.stringify(b), "lossless round-trip");
  const bad = JSON.parse(W.serialize(b));
  bad.els[2].end = "e999"; bad.els[0].fill = "url(javascript:x)"; bad.els[1].id = bad.els[0].id;
  const fixed = W.parseBoard(JSON.stringify(bad));
  ok(fixed.repaired === 3 && fixed.board.els[2].end === null && fixed.board.els[0].fill === "transparent", `repairs counted: ${fixed.repaired}`);
  ok(new Set(fixed.board.els.map((e) => e.id)).size === 3 && fixed.board.seq > 1e6, "duplicate id re-issued, seq past it");
  for (const [txt, why] of [["{", "not JSON"], [JSON.stringify({ format: "x", els: [] }), "format"], [JSON.stringify({ format: W.BOARD_FORMAT, els: [{ kind: "iframe", x: 0, y: 0, w: 1, h: 1 }] }), "kind"], [JSON.stringify({ format: W.BOARD_FORMAT, els: [{ kind: "rect", x: "1e999", y: 0, w: 1, h: 1 }] }), "geometry"]] as const) {
    let threw = false; try { W.parseBoard(txt); } catch { threw = true; }
    ok(threw, `refused: ${why}`);
  }
});

await test("limits and normalisation: boxes dragged up-left, the element cap, sticky colours readable", { "WB-01": "full", "WB-04": "partial" }, () => {
  let b = W.emptyBoard(); let r: string;
  [b, r] = W.addEl(b, { kind: "rect", x: 100, y: 100, w: -40, h: -30 });
  const e = b.els.find((x) => x.id === r)!;
  ok(e.x === 60 && e.y === 70 && e.w === 40 && e.h === 30, "normalised box");
  const big = { ...W.emptyBoard(), els: Array.from({ length: W.MAX_ELEMENTS }, (_, i) => ({ ...e, id: `e${i + 1}` })), seq: W.MAX_ELEMENTS + 1 };
  let threw = false; try { W.addEl(big, { kind: "rect" }); } catch { threw = true; }
  ok(threw, "cap enforced on add");
  threw = false; try { W.duplicate(big, ["e1"]); } catch { threw = true; }
  ok(threw, "cap enforced on duplicate");
  // WCAG 1.4.3: #1b1b1f text on every sticky colour ≥ 4.5:1
  const lum = (h: string) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  for (const s of W.STICKY_COLORS) { const r2 = (lum(s) + 0.05) / (lum(W.TEXT_INK) + 0.05); ok(r2 >= 4.5, `${s} ${r2.toFixed(2)}`); }
  for (const s of W.STROKE_COLORS) { const r2 = (1.05) / (lum(s) + 0.05); ok(r2 >= 3, `stroke ${s} on white ${r2.toFixed(2)}`); }
});

await test("describe(): plain-language labels for the Layers list", { "WB-05": "partial" }, () => {
  const { b, ar } = fixture();
  ok(W.describe(b, b.els.find((x) => x.id === ar)!) === "Arrow from Start to End", W.describe(b, b.els.find((x) => x.id === ar)!));
  ok(W.describe(b, b.els[0]) === "Rectangle: Start", "shape label");
});

finish();
