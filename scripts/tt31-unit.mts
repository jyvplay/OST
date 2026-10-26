/**
 * Suite "tt31-unit" (TT31): live-wall geometry (src/lib/wall-live-core.ts) — no browser.
 * Every check is a property that must hold by construction (inverse maps compose to the identity, the lifted face
 * projects exactly onto its dock rectangle, rotations have det +1, the strip always has an empty row to drop into),
 * plus hand-computed values for the row mapping. Mutants at the end prove the checks can fail.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt31-unit.mts
 */
import { makeHarness } from "./harness.mts";
import * as L from "../src/lib/wall-live-core.ts";
import { CARD_H, CARD_W, freeSlot } from "../src/lib/tabletop-core.ts";
import { apply, applyH, boxQuads, fitSlant, project, type P2 } from "../src/lib/tabletop-slant.ts";

const { test, finish } = makeHarness("tt31-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const near = (a: number, b: number, eps: number, m: string) => { if (!(Math.abs(a - b) <= eps)) throw new Error(`${m}: ${a} vs ${b}`); };
const WALLS: L.LiveWall[] = ["north", "east", "south", "west"];
const VIEWS: [number, number][] = [[1440, 812], [1280, 720], [1920, 1001], [390, 700], [820, 1100], [1024, 640]];
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

await test("row mapping (hand values): board (24,24) → strip (24,24); row 1 (y=229) → S = 912 + x; strip → board inverts every on-grid board point", { "LY-22": "full" }, () => {
  // rows start at CARD_GAP = 24 and are ROW_H = 205 apart; PITCH = 840 + 72 = 912; MAX_X = 840 − 112 = 728
  ok(L.PITCH === 912 && L.ROW_H === 205 && L.MAX_X === 728, `constants ${L.PITCH} ${L.ROW_H} ${L.MAX_X}`);
  const a = L.boardToStrip(24, 24); ok(a.S === 24 && a.t === 24, JSON.stringify(a));
  const b = L.boardToStrip(160, 229); ok(b.S === 912 + 160 && b.t === 24, JSON.stringify(b));
  const c = L.boardToStrip(0, 229 + 30); ok(c.S === 912 && c.t === 48, `t clamps to the band slack: ${JSON.stringify(c)}`);
  const d = L.boardToStrip(5000, -80); ok(d.S === 728 && d.t === 0, `x clamps, negative y → row 0: ${JSON.stringify(d)}`);
  for (let i = 0; i < 4000; i++) {
    const r = Math.floor(rnd() * 40), x = Math.round(rnd() * L.MAX_X), y = L.rowY(r) + Math.round(rnd() * 48) - 24;
    const s = L.boardToStrip(x, y), back = L.stripToBoard(s.S, s.t);
    ok(back.x === x && back.y === y, `(${x},${y}) → ${JSON.stringify(s)} → ${JSON.stringify(back)}`);
  }
  // a point in the 72 px gap between two unrolled rows snaps to the nearer row end
  ok(L.stripToBoard(728 + 10, 24).x === 728 && L.stripToBoard(728 + 10, 24).y === 24, "gap near row 0 end");
  const g = L.stripToBoard(911, 24); ok(g.x === 0 && g.y === L.rowY(1), `gap near row 1 start: ${JSON.stringify(g)}`);
  // every freeSlot position on the wall board (6 per row) is on the grid
  const items: { kind: "card"; key: string; path: string; x: number; y: number }[] = [];
  for (let i = 0; i < 30; i++) { const p = freeSlot(items, L.WALL_BOARD_W); items.push({ kind: "card", key: `card:${i}`, path: String(i), x: p.x, y: p.y }); }
  ok(new Set(items.map((i) => i.y)).size === 5, `30 pins in 5 rows of 6, got ys ${[...new Set(items.map((i) => i.y))]}`);
  for (const it of items) { const s = L.boardToStrip(it.x, it.y); const back = L.stripToBoard(s.S, s.t); ok(back.x === it.x && back.y === it.y, `slot ${it.x},${it.y}`); }
});

await test("strip frames: element ↔ (u,v) are inverse rotations (det +1, no mirror) for rot 0 / 90 / −90 and the CSS matrix matches the math", { "LY-22": "full" }, () => {
  for (const rot of [0, 90, -90] as const) {
    const f = L.stripFrame(rot === 0 ? 900 : 140, rot === 0 ? 140 : 900, rot);
    ok(f.L === 900 && f.T === 140, `L/T for rot ${rot}`);
    for (let i = 0; i < 300; i++) {
      const u = rnd() * f.L, v = rnd() * f.T, [x, y] = L.uvToElement(f, u, v), [u2, v2] = L.elementToUv(f, x, y);
      near(u2, u, 1e-9, `u rot ${rot}`); near(v2, v, 1e-9, `v rot ${rot}`);
      ok(x >= -1e-9 && x <= f.ew + 1e-9 && y >= -1e-9 && y <= f.eh + 1e-9, `inside element rot ${rot}`);
    }
    // Jacobian of uv → element: columns (∂/∂u, ∂/∂v); proper rotation ⇔ det = +1
    const [x0, y0] = L.uvToElement(f, 10, 10), [xu, yu] = L.uvToElement(f, 11, 10), [xv, yv] = L.uvToElement(f, 10, 11);
    near((xu - x0) * (yv - y0) - (yu - y0) * (xv - x0), 1, 1e-9, `det rot ${rot}`);
    // the CSS matrix(a,b,c,d,e,f) maps (u,v) → (a u + c v + e, b u + d v + f)
    const css = L.stripCss(f);
    if (rot === 0) ok(css === "none", css);
    else {
      const [a, b, c, d, e, g] = css.slice(7, -1).split(",").map(Number);
      for (const [u, v] of [[0, 0], [37, 12], [f.L, f.T]] as P2[]) {
        const [x, y] = L.uvToElement(f, u, v);
        near(a * u + c * v + e, x, 1e-9, `css x rot ${rot}`); near(b * u + d * v + g, y, 1e-9, `css y rot ${rot}`);
      }
    }
  }
  // strip ↔ uv with pan
  const f = L.stripFrame(1440, 128, 0);
  for (let i = 0; i < 200; i++) { const S = rnd() * 9000, t = rnd() * 48, pan = rnd() * 3000; const [u, v] = L.stripToUv(f, S, t, pan); const b = L.uvToStrip(f, u, v, pan); near(b.S, S, 1e-7, "S"); near(b.t, t, 1e-7, "t"); }
  // the band (a card + slack) fits inside the thickness with padding on both sides, and k never magnifies
  for (const [ew, eh] of [[1440, 128], [1440, 95], [879, 128], [390, 30], [1200, 600]]) {
    const g = L.stripFrame(ew, eh, 0);
    ok(g.padV >= 0 && g.padV + L.BAND * g.k <= eh + 1e-9 && g.k <= 1, `band fits ${ew}×${eh}: padV ${g.padV} k ${g.k}`);
  }
});

await test("infinite pins: rows in use + one empty row; max pan reaches every pin and the empty row; panToShow brings any pin fully into view", { "LY-22": "full" }, () => {
  const f = L.stripFrame(1440 - 12, 227, 0, L.LIFT_HEAD);
  ok(L.stripRows([]) === 1, "empty wall still has a row to drop into");
  for (const n of [1, 6, 7, 40, 300]) {
    const ys = Array.from({ length: n }, (_, i) => L.rowY(Math.floor(i / 6)));
    const rows = L.stripRows(ys), want = Math.ceil(n / 6) + 1;
    ok(rows === want, `${n} pins → ${rows} rows, want ${want}`);
    const mp = L.maxPan(f, rows), vis = L.visibleS(f);
    // the last pin's right edge and the start of the empty row are reachable
    const lastS = L.boardToStrip(L.MAX_X, L.rowY(rows - 2)).S;
    ok(mp + vis >= lastS + CARD_W - 1e-6, `${n}: last pin reachable (${mp + vis} ≥ ${lastS + CARD_W})`);
    ok(mp + vis >= (rows - 1) * L.PITCH + CARD_W, `${n}: empty row reachable`);
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 25))) {
      const S = L.boardToStrip(L.MAX_X * ((i % 6) / 5), ys[i]).S, p = L.panToShow(f, rows, 0, S);
      ok(S >= p - 1e-6 && S + CARD_W <= p + vis + 1e-6, `${n}: pin ${i} at S=${S} visible with pan ${p}`);
    }
  }
  ok(L.clampPan(f, 2, -50) === 0 && L.clampPan(f, 2, 1e9) === L.maxPan(f, 2) && L.clampPan(f, 2, NaN) === 0, "clamp");
});

await test("lifted pose (slant camera, 6 viewports × 4 walls): projects EXACTLY onto the dock rectangle, in front of every resting face, inside the frame, cards ≥ 24 px and names ≥ 9 px", { "LY-22": "full" }, () => {
  for (const [W, H] of VIEWS) {
    const g = fitSlant(W, H), ox = W / 2, lipTop = g.quads.south[0][1];
    // deepest point of any resting face toward the viewer (z' after the tilt)
    let zMax = -Infinity;
    for (const f of ["floor", "north", "south", "west", "east"] as const) {
      const { w, h, m } = g.faces[f];
      for (const [u, v] of [[0, 0], [w, 0], [w, h], [0, h]] as P2[]) zMax = Math.max(zMax, apply(m, [u, v, 0])[2]);
    }
    const Z = Math.ceil(zMax) + 60; // floor cards lift ≤ 56 px
    for (const w of WALLS) {
      const dk = L.dockRect(w, { W, H, lipTop, nav: { l: W / 2 - 200, r: W / 2 + 200, t: H - 70, b: H - 18 } });
      const m = L.liftMatrix(dk, g.P, ox, g.oy, Z), q = L.liftQuad(dk, m, g.P, ox, g.oy);
      const R = dk.rect, want: P2[] = w === "west" ? [[R.x, R.y + R.h], [R.x, R.y], [R.x + R.w, R.y], [R.x + R.w, R.y + R.h]]
        : w === "east" ? [[R.x + R.w, R.y], [R.x + R.w, R.y + R.h], [R.x, R.y + R.h], [R.x, R.y]]
          : [[R.x, R.y], [R.x + R.w, R.y], [R.x + R.w, R.y + R.h], [R.x, R.y + R.h]];
      q.forEach((p, i) => { near(p[0], want[i][0], 1e-6, `${W}×${H} ${w} corner ${i} x`); near(p[1], want[i][1], 1e-6, `${W}×${H} ${w} corner ${i} y`); });
      ok(R.x >= 0 && R.y >= 0 && R.x + R.w <= W && R.y + R.h <= H, `${W}×${H} ${w} inside frame`);
      if (w === "south" || w === "west" || w === "east") ok(R.y + R.h <= H - 70 - 6 + 1e-9 || R.x + R.w < W / 2 - 200 || R.x > W / 2 + 200, `${W}×${H} ${w} clears the switcher`);
      if (w === "west" || w === "east") ok(R.y + R.h <= lipTop, `${W}×${H} ${w} above the lip`);
      ok(Z > zMax, "in front");
      // proper rotation of the dock map (no mirrored text)
      near(dk.a * dk.d - dk.b * dk.c, 1, 1e-12, `${w} det`);
      const f = L.stripFrame(dk.ew, dk.eh, 0, L.LIFT_HEAD);
      ok(CARD_W * f.k >= 24 && CARD_H * f.k >= 24, `${W}×${H} ${w}: lifted card ${CARD_W * f.k}×${CARD_H * f.k}`);
      ok(Math.max(13.75 * f.k, 10) >= 9, "name rule: max(11·fs-u·k, 10) ≥ 9");
    }
  }
});

await test("pointer mapping: screen → element through the face's quad inverts element → screen (rest quads of both cameras and lifted quads), and surfaceAt follows paint order", { "LY-22": "full" }, () => {
  for (const [W, H] of VIEWS) {
    const g = fitSlant(W, H);
    for (const w of WALLS) {
      const { w: ew, h: eh } = g.faces[w];
      const toEl = L.screenToElementH(g.quads[w], ew, eh), toSc = L.elementToScreenH(g.quads[w], ew, eh);
      for (let i = 0; i < 60; i++) {
        const p: P2 = [rnd() * ew, rnd() * eh], sc = applyH(toSc, p), back = applyH(toEl, sc);
        near(back[0], p[0], 1e-5, `${w} x`); near(back[1], p[1], 1e-5, `${w} y`);
        // the homography agrees with the real CSS 3D projection of the face
        const real = project(apply(g.faces[w].m, [p[0], p[1], 0]), g.P, W / 2, g.oy);
        near(sc[0], real[0], 1e-5, `${W}×${H} ${w} homography = projection x`); near(sc[1], real[1], 1e-5, "y");
      }
    }
    const bq = boxQuads(W, H, Math.round(Math.min(W, H) * 0.5), 0.6);
    for (const w of WALLS) {
      const fw = bq.faces[w].w, fh = bq.faces[w].h, rot = w === "west" ? 90 : w === "east" ? -90 : 0;
      const f = L.stripFrame(fw, fh, rot), toEl = L.screenToElementH(bq.quads[w], fw, fh), toSc = L.elementToScreenH(bq.quads[w], fw, fh);
      for (let i = 0; i < 40; i++) {
        const S = rnd() * L.visibleS(f), t = rnd() * 48, [u, v] = L.stripToUv(f, S, t, 0), sc = applyH(toSc, L.uvToElement(f, u, v));
        const back = L.screenToStrip(sc, toEl, f, 0);
        near(back.S, S, 1e-4, `top ${w} S`); near(back.t, t, 1e-4, `top ${w} t`);
      }
    }
  }
  // paint order on a 1440 frame: lifted > tag > resting walls > floor
  const g = fitSlant(1440, 812);
  const rest = { north: g.quads.north, south: g.quads.south, west: g.quads.west, east: g.quads.east };
  const dk = L.dockRect("north", { W: 1440, H: 812, lipTop: g.quads.south[0][1] });
  const lq: P2[] = [[dk.rect.x, dk.rect.y], [dk.rect.x + dk.rect.w, dk.rect.y], [dk.rect.x + dk.rect.w, dk.rect.y + dk.rect.h], [dk.rect.x, dk.rect.y + dk.rect.h]];
  const base = { lifted: null, liftedQuad: null, tags: {}, rest, floor: g.quads.floor };
  ok(L.surfaceAt([720, 30], base)?.face === "north", "north band");
  ok(L.surfaceAt([720, 400], base)?.face === "floor", "middle of the floor");
  ok(L.surfaceAt([720, 805], base)?.face === "south", "near lip");
  const cen = (q: readonly P2[]): P2 => [q.reduce((a, p) => a + p[0], 0) / 4, q.reduce((a, p) => a + p[1], 0) / 4];
  ok(L.surfaceAt(cen(g.quads.west), base)?.face === "west", `west sliver at ${cen(g.quads.west)}`);
  ok(L.surfaceAt(cen(g.quads.east), base)?.face === "east", "east sliver");
  const lifted = { ...base, lifted: "north" as const, liftedQuad: lq };
  const r = L.surfaceAt([720, 200], lifted); ok(r?.face === "north" && r.via === "lifted", `lifted panel over the floor: ${JSON.stringify(r)}`);
  ok(L.surfaceAt([720, 400], lifted)?.face === "floor", "below the lifted panel is floor");
  const tagged = { ...base, tags: { east: { x: 700, y: 380, w: 60, h: 40 } } };
  ok(L.surfaceAt([720, 400], tagged)?.via === "tag", "a tag beats the floor under it");
  ok(L.surfaceAt([720, 200], { ...lifted, tags: { east: { x: 700, y: 180, w: 60, h: 40 } } })?.via === "lifted", "the lifted wall beats a tag");
  ok(L.surfaceAt([-5, -5], base) === null, "outside");
});

await test("resting pins: a pin is a pointer target only where its projected box is ≥ 24 px both ways — north band yes at 1440, side slivers no (they lift instead)", { "LY-22": "full" }, () => {
  const g = fitSlant(1440, 812);
  const size = (w: L.LiveWall) => {
    const { w: ew, h: eh } = g.faces[w], f = L.stripFrame(ew, eh, 0);
    return L.pinScreenSize(L.elementToScreenH(g.quads[w], ew, eh), f, 400, 24, 0);
  };
  const n = size("north"), we = size("west"), s = size("south");
  ok(n.w >= L.MIN_TARGET && n.h >= L.MIN_TARGET, `north ${JSON.stringify(n)}`);
  ok(we.w < L.MIN_TARGET || we.h < L.MIN_TARGET, `west ${JSON.stringify(we)}`);
  ok(Number.isFinite(s.w) && Number.isFinite(s.h), `south ${JSON.stringify(s)}`);
  // phone: every slanted wall is too small at rest
  const p = fitSlant(390, 700), pw = p.faces.west, ps = L.pinScreenSize(L.elementToScreenH(p.quads.west, pw.w, pw.h), L.stripFrame(pw.w, pw.h, 0), 100, 24, 0);
  ok(ps.w < 24 || ps.h < 24, `phone west ${JSON.stringify(ps)}`);
});

await test("fan along the strip: n cards, increasing S, no overlap beyond 14 %, centred on the pile, never before S = 0", { "LY-22": "full" }, () => {
  for (const n of [2, 5, 9, 20]) {
    const fan = L.fanStrip(n, 2000);
    ok(fan.length === n, "count");
    for (let i = 1; i < n; i++) ok(fan[i].S - fan[i - 1].S >= CARD_W * 0.85, `step ${fan[i].S - fan[i - 1].S}`);
    near((fan[0].S + fan[n - 1].S) / 2, 2000, 1, "centred");
    ok(L.fanStrip(n, 0)[0].S >= 0, "clamped at 0");
  }
});

await test("mutants: each seeded defect in the geometry is caught by the checks above", { "LY-22": "full" }, () => {
  let caught = 0;
  // M1: forgetting the perspective pre-compensation (k = 1) moves the lifted quad off the dock rectangle
  { const g = fitSlant(1440, 812), dk = L.dockRect("north", { W: 1440, H: 812, lipTop: 775 }), Z = 160;
    const bad = [dk.a, dk.b, 0, 0, dk.c, dk.d, 0, 0, 0, 0, 1, 0, dk.e, dk.f, Z, 1];
    const q = L.liftQuad(dk, bad, g.P, 720, g.oy); if (Math.abs(q[0][0] - dk.rect.x) > 1e-3) caught++; }
  // M2: a mirrored rot-90 frame (x = v instead of T − v) has det −1
  { const f = L.stripFrame(140, 900, 90); const mir = (u: number, v: number): P2 => [v, u];
    const [x0, y0] = mir(10, 10), [xu, yu] = mir(11, 10), [xv, yv] = mir(10, 11);
    if (Math.abs((xu - x0) * (yv - y0) - (yu - y0) * (xv - x0) - 1) > 1e-9 && f.T === 140) caught++; }
  // M3: no trailing empty row → a full wall has nowhere to drop
  { const ys = Array.from({ length: 40 }, (_, i) => L.rowY(Math.floor(i / 6))); const rowsBad = Math.max(...ys.map(L.rowOf)) + 1;
    const f = L.stripFrame(1428, 227, 0, L.LIFT_HEAD); if (L.maxPan(f, rowsBad) + L.visibleS(f) < rowsBad * L.PITCH + CARD_W) caught++; }
  // M4: floor-first hit order would send a drop on the lifted panel to the floor
  { const g = fitSlant(1440, 812); if (L.inQuad([720, 200], g.quads.floor)) caught++; }
  // M5: rowOf with floor() instead of round() breaks the round trip for a card nudged up by 24
  { const y = L.rowY(3) - 24, bad = Math.max(0, Math.floor((y - 24) / L.ROW_H)); if (bad !== L.rowOf(y)) caught++; }
  ok(caught === 5, `${caught}/5 mutants caught`);
});

finish();
