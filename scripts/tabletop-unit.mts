/**
 * Suite "tabletop-unit" (TT26): the pure parts of the TT26 work, no browser.
 *   - aesthetic dock sizing (idealDockIcon / planDock): band, grid, presets, fold order, pinned/running, phone
 *   - rearrangeable desktop icons (desk-icons-core): layout, move/swap, nudge clamp, clean up, sort, SH-04 drop
 *   - Tabletop state (tabletop-core): normalisation against the VFS, piles, take-out, unstack, jitter, fan, hit test,
 *     box geometry / face transforms
 *   - micro peek (micro-peek-core): Markdown, CSV with RFC 4180 quoting, JSON grids, images, SVG, binary, sealed
 *   - beauty rules (beauty-core): every hard rule catches a seeded violation and passes the clean case
 *   - settings / routines / seed rows for the new settings
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tabletop-unit.mts
 */
import { readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import * as CB from "../src/lib/colour-beauty-core.ts";
import { STYLES as STY, STYLE_IDS as SIDS } from "../src/lib/style-core.ts";
import { fitSlant, slantGeometry, applyH, apply, project, MIN_FLOOR_COVERAGE, type V3 } from "../src/lib/tabletop-slant.ts";
import { idealDockIcon, planDock, DOCK_BAND, DOCK_FLOOR, DOCK_FILL, dockWidth, DOCK_GAP, DOCK_PAD, DOCK_SEP_W } from "../src/lib/layout-core.ts";
import { layoutIcons, moveIcon, nudgeIcon, cleanUp, sortByName, cellAt } from "../src/lib/desk-icons-core.ts";
import {
  moveToSurface, saveView, loadView, deleteView, renameView, MAX_VIEWS, freeSlot, surfacePaths, surfaceOf, pinnedPaths, boardOf,
  PHI, CARD_W, CARD_H, normalizeTable, floorItems, hitItem, pileUp, takeFromPile, unstack, moveItem, renamePile, pileJitter, fanLayout, boxGeometry, faceTransform, emptyTable, fnv1a,
} from "../src/lib/tabletop-core.ts";
import { microPeek, parseDelimited, PEEK_LINES } from "../src/lib/micro-peek-core.ts";
import * as B from "../src/lib/beauty-core.ts";
import { appForFile } from "../src/lib/open-with.ts";
import { validateSetting } from "../src/lib/settings-validate.ts";
import { ROUTINE_COMMANDS } from "../src/lib/routines.ts";

const { test, finish } = makeHarness("tabletop-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const GROUPS = [
  { id: "Core", apps: ["files", "find", "terminal", "browser", "calculator", "clock", "clipboard", "localdisk", "peek"] },
  { id: "Create", apps: ["editor", "notes", "media", "capture", "lens", "planner", "imageedit", "vector", "writer", "slides", "sheet", "contacts", "tables", "whiteboard"] },
  { id: "Connect", apps: ["beam", "together", "messages", "share"] },
  { id: "System", apps: ["vault", "privacy", "backup", "alerts", "monitor", "settings", "spec", "devices", "routines", "storage"] },
];
const reachable = (plan: ReturnType<typeof planDock>) => GROUPS.every((g) => plan.folded.includes(g.id) || g.apps.every((a) => plan.visible[g.id].includes(a)));

await test("idealDockIcon: 44–64 px band on the 4-px grid, from the screen not the app count; presets; junk input", { "LY-05": "full" }, () => {
  ok(idealDockIcon(1440, 900) === 48, `1440×900 → ${idealDockIcon(1440, 900)}`);
  ok(idealDockIcon(1920, 1080) === 60, `1920×1080 → ${idealDockIcon(1920, 1080)}`);
  ok(idealDockIcon(1280, 800) === 44 && idealDockIcon(360, 640) === 44, "small screens clamp to 44");
  ok(idealDockIcon(5120, 2880) === 64, "5K clamps to 64");
  for (let w = 300; w <= 6000; w += 137) for (let h = 300; h <= 3000; h += 211) {
    const s = idealDockIcon(w, h);
    ok(s >= DOCK_BAND.min && s <= DOCK_BAND.max && s % 4 === 0, `band/grid at ${w}×${h}: ${s}`);
  }
  ok(idealDockIcon(1440, 900, "small") === 44 && idealDockIcon(1440, 900, "medium") === 52 && idealDockIcon(1440, 900, "large") === 64, "presets");
  ok(idealDockIcon(NaN, -1, "nonsense") === 48, "junk → defaults (1440×900)");
});

await test("planDock: keeps the pleasing size and folds the biggest groups first; pinned + running stay out; every app reachable; never wider than the fill limit when it reports fits", { "LY-05": "full" }, () => {
  const p = planDock(GROUPS, 1440, 48);
  ok(p.size === 48, `size kept ${p.size}`);
  ok(p.folded.join() === "Create,System", `fold order ${p.folded}`);
  ok(p.visible.System.join() === "settings" && p.visible.Core.length === 9, `pinned settings stays: ${p.visible.System}`);
  ok(p.fits && p.width <= 1440 * DOCK_FILL, `fits ${p.width}`);
  ok(p.width === dockWidth(p.icons, 48, { gap: DOCK_GAP, pad: DOCK_PAD, separators: p.separators, sepWidth: DOCK_SEP_W }), "width formula matches the CSS constants");
  ok(reachable(p), "every app reachable");
  // a huge screen folds nothing
  const big = planDock(GROUPS, 4000, 60);
  ok(big.folded.length === 0 && big.icons === 39, `4000 px: nothing folded (${big.folded})`);
  // running apps of a folded group stay visible
  const r = planDock(GROUPS, 1440, 48, { running: ["notes", "vault"] });
  ok(r.visible.Create.join() === "notes" && r.visible.System.includes("vault"), `running visible ${r.visible.Create} / ${r.visible.System}`);
  // property: for many widths the plan either fits at ≥ floor or has folded everything; size only drops when all folded
  for (let w = 300; w <= 3000; w += 23) {
    const q = planDock(GROUPS, w, idealDockIcon(w, 900), { tail: 1 + (w % 3) });
    ok(q.size >= DOCK_FLOOR && q.size <= DOCK_BAND.max, `size range at ${w}`);
    ok(reachable(q), `reachable at ${w}`);
    if (q.size < idealDockIcon(w, 900)) ok(q.folded.length === 4, `shrinks only after folding everything (w=${w})`);
    if (q.fits) ok(q.width <= w * DOCK_FILL + 1e-9, `fits ⇒ within fill at ${w}`);
  }
});

await test("planDock on a phone: all groups fold, pinned apps fold back before shrinking, ≥32 px; with many minimised windows it reports !fits (dock scrolls)", { "LY-05": "full" }, () => {
  const p = planDock(GROUPS, 360, 44);
  ok(p.folded.length === 4 && p.fits && p.size >= 32, `phone: ${JSON.stringify({ f: p.folded, s: p.size, w: p.width })}`);
  ok(Object.values(p.visible).every((v) => v.length === 0), "pinned folded back on a phone");
  const many = planDock(GROUPS, 360, 44, { tail: 9 });
  ok(!many.fits && many.size === DOCK_FLOOR, `many minimised → floor + scroll (${many.size}, fits=${many.fits})`);
  ok(planDock([], 0, NaN).size >= DOCK_FLOOR, "degenerate input is total");
});

await test("desktop icons: column-major auto layout, saved cells win, contested/out-of-grid cells ignored, missing paths dropped (SH-04)", { "LY-06": "full" }, () => {
  const paths = ["/a", "/b", "/c", "/d", "/e"];
  const auto = layoutIcons(paths, [], 2, 3);
  ok(auto.map((p) => `${p.col},${p.row}`).join(" ") === "0,0 0,1 0,2 1,0 1,1", `auto ${auto.map((p) => `${p.col},${p.row}`)}`);
  const saved = [{ id: "/c", path: "/c", x: 1, y: 2 }, { id: "/d", path: "/d", x: 1, y: 2 }, { id: "/e", path: "/e", x: 9, y: 0 }, { id: "/gone", path: "/gone", x: 0, y: 0 }];
  const l = layoutIcons(paths, saved, 2, 3);
  const at = Object.fromEntries(l.map((p) => [p.path, `${p.col},${p.row}`]));
  ok(at["/c"] === "1,2", "saved cell kept");
  ok(at["/d"] !== "1,2" && at["/e"] !== "9,0", `contested and out-of-grid fall back to auto (${at["/d"]}, ${at["/e"]})`);
  ok(!("/gone" in at) && new Set(Object.values(at)).size === l.length, "no ghost, no shared cell");
  ok(layoutIcons(Array.from({ length: 10 }, (_, i) => `/${i}`), [], 2, 2).length === 4, "overflow beyond the grid is not placed");
  ok(layoutIcons(paths, "junk" as never, 0, -3).length === 1, "junk input → 1×1 grid, total");
});

await test("desktop icons: drag moves to a cell and swaps with an occupant, nudge clamps at the edges, clean up closes gaps in reading order, sort by name is natural", { "LY-06": "full" }, () => {
  const placed = layoutIcons(["/a", "/b", "/c"], [], 3, 3); // a 0,0  b 0,1  c 0,2
  const m = moveIcon(placed, "/a", 0, 2, 3, 3);
  const pos = (s: { path: string; x: number; y: number }[], p: string) => { const e = s.find((x) => x.path === p)!; return `${e.x},${e.y}`; };
  ok(pos(m, "/a") === "0,2" && pos(m, "/c") === "0,0", `swap: a ${pos(m, "/a")} c ${pos(m, "/c")}`);
  const far = moveIcon(placed, "/b", 99, -5, 3, 3);
  ok(pos(far, "/b") === "2,0", `clamped ${pos(far, "/b")}`);
  const n = nudgeIcon(placed, "/a", -1, 0, 3, 3);
  ok(pos(n, "/a") === "0,0", "nudge left at the edge stays");
  const n2 = nudgeIcon(placed, "/a", 1, 0, 3, 3);
  ok(pos(n2, "/a") === "1,0", "nudge right");
  const gappy = layoutIcons(["/a", "/b"], [{ id: "/a", path: "/a", x: 2, y: 2 }, { id: "/b", path: "/b", x: 1, y: 0 }], 3, 3);
  const cu = cleanUp(gappy, 3, 3);
  ok(pos(cu, "/b") === "0,0" && pos(cu, "/a") === "0,1", `clean up keeps reading order ${JSON.stringify(cu)}`);
  const names = { "/x": "file10.txt", "/y": "File2.txt", "/z": "alpha.md" };
  const sorted = sortByName(layoutIcons(["/x", "/y", "/z"], [], 3, 3), names, 3, 3);
  ok(pos(sorted, "/z") === "0,0" && pos(sorted, "/y") === "0,1" && pos(sorted, "/x") === "0,2", `natural sort ${JSON.stringify(sorted)}`);
  ok(JSON.stringify(cellAt(150, 250, 100, 100)) === '{"col":1,"row":2}' && cellAt(-20, -5, 100, 100).col === 0, "cellAt");
});

await test("tabletop state: normalizeTable validates untrusted input against the files that exist", { "LY-08": "full" }, () => {
  const files = ["/D/a.md", "/D/b.md", "/D/c.csv", "/D/d.txt"];
  const t = normalizeTable({
    v: 1,
    cards: { "/D/a.md": { x: 10, y: 20 }, "/D/zz": { x: 1, y: 1 }, "/D/d.txt": { x: "bad", y: Infinity } },
    piles: [
      { id: "p1", name: "  Work  ", paths: ["/D/a.md", "/D/b.md", "/D/missing"], x: 300, y: 40 },
      { id: "p1", name: "dup id", paths: ["/D/c.csv", "/D/d.txt"], x: 0, y: 0 },
      { id: "p2", name: "", paths: ["/D/b.md", "/D/c.csv"], x: 50, y: 60 },
      "junk",
    ],
  }, files);
  ok(t.piles.length === 1 && t.piles[0].name === "Work" && t.piles[0].paths.join() === "/D/a.md,/D/b.md", `piles ${JSON.stringify(t.piles)}`);
  ok(!t.cards["/D/a.md"] && !t.cards["/D/zz"], "a pile member is not also a loose card; unknown paths dropped");
  ok(t.cards["/D/c.csv"]?.x === 50, "a pile reduced to one card dissolves into a loose card at the pile spot");
  ok(t.cards["/D/d.txt"].x === 0 && t.cards["/D/d.txt"].y === 0, "non-finite numbers clamp to 0");
  ok(JSON.stringify(normalizeTable(null, files)) === JSON.stringify(emptyTable()) && normalizeTable(42, []).piles.length === 0, "total on junk");
});

await test("tabletop piles: drop card on card → pile at the target, drop on a pile adds on top, pile on pile merges, take out / dissolve, unstack, rename, deterministic ids", { "LY-08": "full" }, () => {
  const files = ["/a", "/b", "/c", "/d"];
  let t = normalizeTable({ v: 1, cards: { "/a": { x: 0, y: 0 }, "/b": { x: 200, y: 0 }, "/c": { x: 400, y: 0 }, "/d": { x: 600, y: 0 } }, piles: [] }, files);
  t = pileUp(t, "card:/a", "card:/b", { x: 200, y: 0 });
  ok(t.piles.length === 1 && t.piles[0].paths.join() === "/b,/a" && t.piles[0].x === 200, `pile ${JSON.stringify(t.piles)}`);
  ok(!t.cards["/a"] && !t.cards["/b"], "members leave the loose cards");
  const id = t.piles[0].id;
  ok(id === pileUp(normalizeTable({ v: 1, cards: {}, piles: [] }, files), "card:/a", "card:/b", { x: 0, y: 0 }).piles[0].id, "deterministic id");
  t = pileUp(t, "card:/c", `pile:${id}`, { x: 200, y: 0 });
  ok(t.piles[0].paths.join() === "/b,/a,/c" && t.piles[0].id === id, "added on top of the existing pile");
  ok(pileUp(t, `pile:${id}`, `pile:${id}`, { x: 0, y: 0 }) === t && pileUp(t, "card:/nope", "card:/d", { x: 0, y: 0 }, files) === t, "self / unknown no-op");
  let u = pileUp(t, "card:/d", "card:/d", { x: 0, y: 0 });
  ok(u === t, "card onto itself no-op");
  u = pileUp(normalizeTable({ v: 1, cards: {}, piles: [{ id: "q", name: "Q", paths: ["/c", "/d"], x: 9, y: 9 }, { id: "r", name: "R", paths: ["/a", "/b"], x: 1, y: 1 }] }, files), "pile:q", "pile:r", { x: 1, y: 1 });
  ok(u.piles.length === 1 && u.piles[0].paths.join() === "/a,/b,/c,/d" && u.piles[0].name === "R", `pile on pile ${JSON.stringify(u.piles)}`);
  t = takeFromPile(t, id, "/a", { x: 500, y: 300 });
  ok(t.piles[0].paths.join() === "/b,/c" && t.cards["/a"].x === 500, "taken out to the drop spot");
  t = takeFromPile(t, id, "/c", { x: 10, y: 10 });
  ok(t.piles.length === 0 && t.cards["/b"].x === 200, "a pile of one dissolves (survivor at the pile spot)");
  let v = pileUp(pileUp(t, "card:/a", "card:/b", { x: 100, y: 100 }), "card:/c", "card:/b", { x: 0, y: 0 });
  v = pileUp(t, "card:/a", "card:/b", { x: 100, y: 100 });
  const pid = v.piles[0].id;
  v = renamePile(v, pid, "  Taxes 2026 ");
  ok(v.piles[0].name === "Taxes 2026" && renamePile(v, pid, "   ").piles[0].name === "Taxes 2026", "rename trims, empty keeps");
  const un = unstack(v, pid);
  ok(un.piles.length === 0 && un.cards["/a"] && un.cards["/b"] && un.cards["/a"].x !== un.cards["/b"].x, "unstack lays cards out");
  ok(moveItem(un, "card:/a", { x: 7.6, y: 8.2 }).cards["/a"].x === 8, "move rounds");
});

await test("tabletop geometry: golden cards, jitter deterministic + bounded (top card straight), fan inside the floor, floor items never overlap their slots, hit test topmost", { "LY-07": "full", "LY-08": "full" }, () => {
  ok(Math.abs(CARD_H / CARD_W - PHI) / PHI < 0.01, `card ratio ${CARD_H / CARD_W}`);
  for (let i = 0; i < 6; i++) {
    const j = pileJitter("p", `/f${i}`, i, 6);
    ok(Math.abs(j.rot) <= 6 && Math.abs(j.dx) <= 5 && Math.abs(j.dy) <= 5, `bounded ${JSON.stringify(j)}`);
    ok(JSON.stringify(j) === JSON.stringify(pileJitter("p", `/f${i}`, i, 6)), "deterministic");
  }
  ok(JSON.stringify(pileJitter("p", "/top", 5, 6)) === '{"dx":0,"dy":0,"rot":0}', "top card straight");
  for (const n of [1, 3, 9, 14, 40]) for (const [W, H] of [[1100, 700], [500, 400]]) {
    const f = fanLayout(n, { x: W - 50, y: 10 }, W, H);
    ok(f.length === n && f.every((p) => p.x >= 0 && p.y >= 0 && p.x <= W - CARD_W && p.y <= H - CARD_H), `fan ${n} in ${W}×${H}`);
  }
  // the arc fan: readable (each card shows ≥ ⅔ of its width), symmetric tilt, the middle card is the highest
  const arc = fanLayout(5, { x: 400, y: 400 }, 1400, 900);
  const gaps = arc.slice(1).map((p, i) => p.x - arc[i].x);
  ok(gaps.every((g) => g >= CARD_W * 2 / 3 && g < CARD_W), `fan spacing shows ≥⅔ of each card ${gaps}`);
  ok(arc[0].rot < 0 && arc[4].rot > 0 && arc[2].rot === 0 && arc[0].rot === -arc[4].rot && Math.abs(arc[0].rot) >= 8, `symmetric tilt ${arc.map((p) => p.rot)}`);
  ok(arc[2].y < arc[0].y && arc[0].y === arc[4].y, `arched: middle highest ${arc.map((p) => p.y)}`);
  const t = normalizeTable({ v: 1, cards: { "/a": { x: 24, y: 24 } }, piles: [] }, ["/a", "/b", "/c"]);
  const items = floorItems(t, ["/a", "/b", "/c"], 800);
  const keys = items.map((i) => `${i.x},${i.y}`);
  ok(new Set(keys).size === items.length, `no two items share a slot ${keys}`);
  ok(hitItem(items, 30, 30)?.key === "card:/a" && hitItem(items, 30, 30, "card:/a")?.key !== "card:/a" && hitItem(items, -500, -500) === null, "hit test");
  ok(fnv1a("") === 0x811c9dc5 && fnv1a("a") === 0xe40c292c, "FNV-1a reference values");
});

await test("tabletop box geometry: floor scale = p/(p+depth) < 1, walls hinge on their screen edge and fold 90° inward", { "LY-07": "full" }, () => {
  const g = boxGeometry(1440, 860);
  ok(g.depth === 430 && Math.abs(g.floorScale - g.perspective / (g.perspective + g.depth)) < 1e-12 && g.floorScale > 0.6 && g.floorScale < 0.9, JSON.stringify(g));
  ok(faceTransform("floor", 430).transform === "translateZ(-430px)", "floor pushed back by depth");
  const exp = { north: ["rotateX(-90deg)", "50% 0%"], south: ["rotateX(90deg)", "50% 100%"], west: ["rotateY(90deg)", "0% 50%"], east: ["rotateY(-90deg)", "100% 50%"] } as const;
  for (const [f, [tr, or]] of Object.entries(exp)) { const ft = faceTransform(f as "north", 430); ok(ft.transform === tr && ft.origin === or, `${f}: ${JSON.stringify(ft)}`); }
  // the far edge of each wall lands on z = −depth (CSS rotation matrices applied to the hinge-relative far edge)
  const D = 430, rad = (d: number) => (d * Math.PI) / 180;
  const zNorth = D * Math.sin(rad(-90)), zSouth = -D * Math.sin(rad(90)), zWest = -D * Math.sin(rad(90)), zEast = D * Math.sin(rad(-90));
  ok([zNorth, zSouth, zWest, zEast].every((z) => Math.abs(z + D) < 1e-9), `far edges at −depth ${[zNorth, zSouth, zWest, zEast]}`);
  ok(boxGeometry(NaN, 10).depth > 0, "total");
});

await test("slanted camera (default): floor ≥ 80 % of the frame across a viewport sweep, lip ≥ 24 px, β = 38°, walls share the rest", { "LY-11": "full" }, () => {
  const vps = [[1440, 860], [1280, 760], [1920, 1020], [390, 700], [1024, 700], [3840, 2100], [800, 300], [360, 640], [2560, 1300], [768, 1000]];
  const worst: string[] = [];
  for (const [w, h] of vps) {
    const g = fitSlant(w, h);
    if (g.coverage < MIN_FLOOR_COVERAGE) worst.push(`${w}×${h}=${g.coverage.toFixed(3)}`);
    ok(g.beta === 38 && g.P > 0 && g.FD > 0 && g.hw >= 48, `${w}×${h} params`);
    const lipPx = g.H - Math.min(...g.quads.south.map((q) => q[1]));
    ok(lipPx >= 23.5, `${w}×${h}: south lip shows ${lipPx.toFixed(1)} px (≥ 24 target)`);
    const sum = g.coverage + g.wallShare.north + g.wallShare.south + g.wallShare.west + g.wallShare.east;
    ok(sum > 0.95 && sum < 1.06, `${w}×${h}: floor + walls ≈ the whole frame (${sum.toFixed(3)})`);
    ok(g.quads.floor[2][1] <= g.H + 0.5 && g.quads.floor[0][1] > 0, `${w}×${h}: floor inside the frame vertically`);
  }
  ok(worst.length === 0, `coverage < 0.8: ${worst.join(", ")}`);
  ok(slantGeometry(1440, 860, 38, 0.2).coverage < MIN_FLOOR_COVERAGE, "the check can fail: very wide side walls drop below 80 %");
  ok(fitSlant(NaN as unknown as number, -5).W >= 320, "junk sizes clamp");
});

await test("slanted camera maths: floor homography = the 3D projection (< 0.01 px) and inverts (< 0.01 px); faces meet at the seams; every wall faces into the box", { "LY-11": "full", "LY-12": "partial" }, () => {
  const g = fitSlant(1440, 860);
  const ox = g.W / 2;
  let maxFwd = 0, maxInv = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const u = (g.FW * i) / 10, v = (g.FD * j) / 10;
    const viaH = applyH(g.toScreen, [u, v]);
    const via3d = project(apply(g.faces.floor.m, [u, v, 0]), g.P, ox, g.oy);
    maxFwd = Math.max(maxFwd, Math.hypot(viaH[0] - via3d[0], viaH[1] - via3d[1]));
    const back = applyH(g.toFloor, viaH);
    maxInv = Math.max(maxInv, Math.hypot(back[0] - u, back[1] - v));
  }
  ok(maxFwd < 0.01, `homography vs projection ${maxFwd}`);
  ok(maxInv < 0.01, `inverse round trip ${maxInv}`);
  const P3 = (f: keyof typeof g.faces, u: number, v: number) => apply(g.faces[f].m, [u, v, 0]);
  const same = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
  ok(same(P3("north", 0, g.hw), P3("floor", 0, 0)) && same(P3("north", g.FW, g.hw), P3("floor", g.FW, 0)), "north wall stands on the far edge");
  ok(same(P3("south", 0, g.hs), P3("floor", 0, g.FD)), "south lip stands on the near edge");
  ok(same(P3("west", 0, g.hw), P3("floor", 0, g.FD)) && same(P3("west", g.FD, g.hw), P3("floor", 0, 0)), "west wall on the left edge");
  ok(same(P3("east", 0, g.hw), P3("floor", g.FW, 0)) && same(P3("east", g.FD, g.hw), P3("floor", g.FW, g.FD)), "east wall on the right edge");
  const c = P3("floor", g.FW / 2, g.FD / 2), nf: V3 = [g.faces.floor.m[8], g.faces.floor.m[9], g.faces.floor.m[10]];
  for (const f of ["north", "south", "west", "east"] as const) {
    const m = g.faces[f].m, n: V3 = [m[8], m[9], m[10]];
    const wc = P3(f, g.faces[f].w / 2, g.faces[f].h / 2);
    ok(Math.abs(n[0] * nf[0] + n[1] * nf[1] + n[2] * nf[2]) < 1e-9, `${f} ⟂ floor`);
    const into = n[0] * (c[0] - wc[0]) + n[1] * (c[1] - wc[1]) + n[2] * (c[2] - wc[2]);
    // the three far walls show their inside; the south lip is the front rim, seen from outside (it faces the viewer)
    ok(f === "south" ? into < 0 : into > 0, `${f} ${f === "south" ? "faces out toward the viewer" : "faces into the box"}`);
  }
  // no face is seen from behind (mirrored text): every projected outline winds the same way as the floor's
  const wind = (q: readonly [number, number][]) => Math.sign(q.reduce((s, p, i) => { const r = q[(i + 1) % q.length]; return s + p[0] * r[1] - r[0] * p[1]; }, 0));
  for (const f of ["north", "south", "west", "east"] as const) ok(wind(g.quads[f]) === wind(g.quads.floor), `${f} is seen from its front`);
});

await test("walls as pinboards: pin a card / a whole pile to a wall, move between walls, back to the floor; walls-first wins on conflicts; v1 → v2 migration; free slots", { "LY-12": "full" }, () => {
  const files = ["/D/a.md", "/D/b.md", "/D/c.csv", "/D/d.txt", "/D/e.png"];
  const v1 = normalizeTable({ v: 1, cards: { "/D/a.md": { x: 10, y: 20 } }, piles: [{ id: "p1", name: "Work", paths: ["/D/b.md", "/D/c.csv"], x: 300, y: 40 }] }, files);
  ok(v1.v === 2 && v1.camera === "slant" && v1.cards["/D/a.md"].x === 10 && v1.piles[0].id === "p1" && JSON.stringify(v1.walls) === "{}" && v1.views!.length === 0, "v1 table migrates to v2 unchanged, slanted camera");
  let t = moveToSurface(v1, "card:/D/a.md", "floor", "north", { x: 40, y: 50 }, files);
  ok(t.walls!.north!.cards["/D/a.md"].x === 40 && !t.cards["/D/a.md"] && surfaceOf(t, "/D/a.md") === "north", "card pinned to north");
  ok(!surfacePaths(t, "floor", files).includes("/D/a.md") && surfacePaths(t, "north", files).join() === "/D/a.md", "a pinned file leaves the floor");
  t = moveToSurface(t, "pile:p1", "floor", "west", { x: 0, y: 0 }, files);
  ok(t.walls!.west!.piles[0].paths.join() === "/D/b.md,/D/c.csv" && t.piles.length === 0 && pinnedPaths(t).size === 3, "whole pile pinned");
  t = moveToSurface(t, "card:/D/a.md", "north", "east", { x: 5, y: 5 }, files);
  ok(!t.walls!.north && t.walls!.east!.cards["/D/a.md"] && surfaceOf(t, "/D/a.md") === "east", "wall → wall; an emptied wall is dropped");
  ok(moveToSurface(t, "card:/D/b.md", "west", "floor", { x: 0, y: 0 }, files) === t, "a pile member cannot leave as a loose card");
  ok(moveToSurface(t, "card:/nope", "floor", "north", { x: 0, y: 0 }, files) === t && moveToSurface(t, "pile:zz", "west", "floor", { x: 0, y: 0 }, files) === t, "unknown keys are no-ops");
  t = moveToSurface(t, "pile:p1", "west", "floor", { x: 70, y: 80 }, files);
  ok(t.piles[0].x === 70 && !t.walls!.west, "pile back on the table");
  const moved = moveToSurface(t, "card:/D/a.md", "east", "east", { x: 300, y: 99999 }, files);
  ok(moved.walls!.east!.cards["/D/a.md"].x === 300 && moved.walls!.east!.cards["/D/a.md"].y === 20000, "motion on a wall (stored range clamped; the UI also clamps drops to the board)");
  const conflict = normalizeTable({ v: 2, cards: { "/D/a.md": { x: 1, y: 1 } }, piles: [], walls: { south: { cards: { "/D/a.md": { x: 9, y: 9 } }, piles: [] }, north: { cards: { "/D/a.md": { x: 7, y: 7 }, "/D/zz": { x: 0, y: 0 } }, piles: [] } } }, files);
  const owners = (["north", "south"] as const).filter((w) => conflict.walls?.[w]?.cards["/D/a.md"]);
  ok(!conflict.cards["/D/a.md"] && owners.length === 1 && !conflict.walls?.north?.cards["/D/zz"], `walls-first, one owner (${owners.join()}), unknown dropped`);
  const many = normalizeTable({ v: 2, cards: {}, piles: [], walls: { north: { cards: Object.fromEntries(files.map((f, i) => [f, { x: i * 10, y: 0 }])), piles: [] } } }, files);
  ok(Object.keys(boardOf(many, "north").cards).length === files.length, "no cap on pins below the file count (infinite pinning = every file)");
  const slot = freeSlot([{ x: 24, y: 24 }], 800);
  ok(slot.x === 24 + CARD_W + 24 && slot.y === 24 && freeSlot([], 10).x === 24, `free slot ${JSON.stringify(slot)}`);
});

await test("saved tabletop views: save captures camera + face + every surface; same name updates in place; load restores (re-validated against today's files); rename / delete; cap", { "LY-13": "full" }, () => {
  const files = ["/D/a.md", "/D/b.md", "/D/c.csv"];
  let t = normalizeTable({ v: 2, cards: { "/D/a.md": { x: 10, y: 10 } }, piles: [], camera: "top" }, files);
  t = moveToSurface(t, "card:/D/b.md", "floor", "north", { x: 30, y: 30 }, files);
  t = saveView(t, "  Morning  ", "north", "2026-10-17T09:00:00Z");
  const v = t.views![0];
  ok(v.name === "Morning" && v.camera === "top" && v.face === "north" && v.floor.cards["/D/a.md"].x === 10 && v.walls.north!.cards["/D/b.md"].x === 30, "captured");
  const live = moveToSurface({ ...t, camera: "slant" }, "card:/D/b.md", "north", "floor", { x: 0, y: 0 }, files);
  ok(t.views![0].walls.north!.cards["/D/b.md"], "the saved view is a snapshot, not a live reference");
  const r = loadView(live, v.id, files)!;
  ok(r.face === "north" && r.table.camera === "top" && r.table.walls!.north!.cards["/D/b.md"] && !r.table.cards["/D/b.md"], "load restores camera, face and pins");
  const gone = loadView(live, v.id, ["/D/a.md"])!;
  ok(!gone.table.walls?.north && Object.keys(gone.table.cards).join() === "/D/a.md", "deleted files drop out on load");
  ok(loadView(live, "nope", files) === null, "unknown id");
  const upd = saveView(r.table, "morning", "floor", "later");
  ok(upd.views!.length === 1 && upd.views![0].id === v.id && upd.views![0].face === "floor", "same name (any case) updates in place");
  let full = upd;
  for (let i = 0; i < MAX_VIEWS + 3; i++) full = saveView(full, `View ${i}`, "floor", `t${i}`);
  ok(full.views!.length === MAX_VIEWS && saveView(full, "One more", "floor", "x") === full, `cap ${MAX_VIEWS}`);
  ok(saveView(full, "   ", "floor", "x") === full, "blank name refused");
  const ren = renameView(upd, v.id, "Focus");
  ok(ren.views![0].name === "Focus" && renameView(full, full.views![1].id, "morning") === full, "rename; duplicate names refused");
  ok(deleteView(ren, v.id).views!.length === 0, "delete");
  const rt = normalizeTable(JSON.parse(JSON.stringify(full)), files);
  ok(rt.views!.length === MAX_VIEWS && rt.views![0].walls.north!.cards["/D/b.md"], "views survive a JSON round trip through normalizeTable");
  const junk = normalizeTable({ v: 2, cards: {}, piles: [], views: [{ id: "a", name: "X", face: "ceiling", camera: "drone", floor: { cards: { "/D/zz": { x: 1, y: 1 } } } }, { id: "a", name: "Y" }, { id: "b", name: "x" }, null] }, files);
  ok(junk.views!.length === 1 && junk.views![0].face === "floor" && junk.views![0].camera === "slant" && !junk.views![0].floor.cards["/D/zz"], "junk views normalised (dup ids / names, bad faces)");
});

await test("colour beauty core: OKLCH matches published values, WCAG contrast, harmony templates, hue entropy, pixel statistics (60-30-10, light-neutral share); Silver/Daylight tokens are silver/light", { "LY-15": "full", "LY-14": "partial" }, () => {
  const red = CB.oklch(CB.hex("#ff0000"));
  ok(Math.abs(red.L - 0.628) < 0.002 && Math.abs(red.C - 0.2577) < 0.002 && Math.abs(red.h - 29.23) < 0.3, `red ${JSON.stringify(red)}`);
  const w = CB.oklch(CB.hex("#fff"));
  ok(Math.abs(w.L - 1) < 1e-3 && w.C < 1e-3, "white");
  ok(Math.abs(CB.contrast(CB.hex("#000"), CB.hex("#fff")) - 21) < 1e-9 && Math.abs(CB.contrast(CB.hex("#777"), CB.hex("#fff")) - 4.48) < 0.01, "WCAG ratios");
  const analog = CB.harmonyFit([{ c: CB.hex("#e5484d") }, { c: CB.hex("#f76b15") }, { c: CB.hex("#ffb224") }])!;
  ok((analog.template === "V" || analog.template === "i") && analog.deviation === 0, `analogous → ${JSON.stringify(analog)}`);
  const comp = CB.harmonyFit([{ c: CB.hex("#0a84ff") }, { c: CB.hex("#ff9f0a") }])!;
  ok(comp.template === "I" && comp.deviation === 0, `complementary → ${JSON.stringify(comp)}`);
  ok(CB.harmonyFit([{ c: CB.hex("#808080") }]) === null, "neutrals have no hue");
  ok(CB.hueEntropy([{ c: CB.hex("#0a84ff") }, { c: CB.hex("#2f6fd0") }]) < 0.1, "one hue family ≈ 0");
  const wheel = Array.from({ length: 12 }, (_, i) => { const a = (i * 30 + 15) * Math.PI / 180; return { c: [0.5 + 0.35 * Math.cos(a), 0.5 + 0.35 * Math.cos(a - 2.094), 0.5 + 0.35 * Math.cos(a + 2.094)] as CB.RGB }; });
  ok(CB.hueEntropy(wheel) > 0.85, `rainbow ≈ 1 (${CB.hueEntropy(wheel)})`);
  const px: number[] = [];
  const put = (n: number, r: number, g: number, b: number) => { for (let i = 0; i < n; i++) px.push(r, g, b, 255); };
  put(600, 255, 255, 255); put(300, 128, 128, 128); put(100, 10, 132, 255);
  const st = CB.pixelStats(px);
  ok(st.lightNeutral === 0.6 && st.light === 0.6 && st.top[0].share === 0.6 && st.top[2].share === 0.1 && st.sixtyThirtyTen === 0, `pixel stats ${JSON.stringify(st)}`);
  ok(CB.pixelStats([0, 0, 0, 0]).sixtyThirtyTen === 100, "transparent only → empty stats");
  for (const id of ["silver", "daylight"] as const) {
    const t = STY[id].light;
    for (const k of ["bg", "bg2", "panelSolid"] as const) {
      const o = CB.oklch(CB.hex(t[k]));
      ok(o.L >= 0.9 && o.C <= 0.02, `${id} light ${k} ${t[k]} is light + near-neutral (L ${o.L.toFixed(3)}, C ${o.C.toFixed(3)})`);
    }
    ok(CB.LIGHT_INTENT[id] >= 0.5, `${id} has a measured light-intent rule`);
  }
  // every style's chrome text tokens pass WCAG 1.4.3 under the colour core too (cross-check of a11y-unit with an independent implementation)
  for (const id of SIDS) for (const th of ["dark", "light"] as const) {
    const t = STY[id][th];
    ok(CB.contrast(CB.hex(t.text), CB.hex(t.panelSolid)) >= 4.5 && CB.contrast(CB.hex(t.muted), CB.hex(t.bg)) >= 4.5, `${id}/${th} text tokens`);
  }
});

await test("micro peek: Markdown keeps headings/bullets, plain text and code, line cap, CSV with RFC 4180 quoting, JSON grid / pretty text, images, SVG, binary, sealed, empty", { "LY-09": "full" }, () => {
  const md = microPeek({ name: "w.md", content: "# Title\n\nSome **bold** text\n- one\n- two\n```\ncode()\n```\n" });
  ok(md.kind === "text" && md.lines[0].role === "h" && md.lines[0].t === "Title" && md.lines.some((l) => l.role === "li" && l.t === "one") && md.lines.some((l) => l.t === "Some bold text"), JSON.stringify(md));
  ok(md.kind === "text" && md.lines.some((l) => l.role === "code" && l.t === "code()"), "fenced code kept as code");
  const long = microPeek({ name: "a.txt", content: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") });
  ok(long.kind === "text" && long.lines.length === PEEK_LINES && long.more, "capped with more flag");
  const csv = microPeek({ name: "b.csv", content: 'item,qty,notes\n"Monitor, 27""",1,"multi\nline"\nMouse,2,x\n' });
  ok(csv.kind === "grid" && csv.rows[1][0] === 'Monitor, 27"' && csv.rows[1][2] === "multi\nline" && csv.rows.length === 3, JSON.stringify(csv));
  ok(parseDelimited("a\tb\r\nc\td", "\t").map((r) => r.join("|")).join("/") === "a|b/c|d", "TSV + CRLF");
  const jg = microPeek({ name: "g.json", content: "[[1,2],[3,null]]" });
  ok(jg.kind === "grid" && jg.rows[1][1] === "", "JSON array of rows → grid");
  const jt = microPeek({ name: "o.json", content: '{"a":1,"b":[true]}' });
  ok(jt.kind === "text" && jt.lines.some((l) => l.t.includes('"a": 1')), "JSON object → pretty text");
  const img = microPeek({ name: "p.png", mime: "image/png", encoding: "base64", content: "iVBORw0KGgo=" });
  ok(img.kind === "image" && img.src === "data:image/png;base64,iVBORw0KGgo=", JSON.stringify(img));
  const svg = microPeek({ name: "s.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
  ok(svg.kind === "image" && svg.src.startsWith("data:image/svg+xml;charset=utf-8,") && !svg.src.includes("<script>"), "SVG as an encoded <img> data URL");
  ok(microPeek({ name: "x.bin", encoding: "base64", content: "AAEC" }).kind === "none", "binary → badge");
  ok(JSON.stringify(microPeek({ name: "k.md", content: "secret", sealed: true })) === '{"kind":"none","label":"SEALED"}', "sealed never peeked");
  ok(microPeek({ name: "e.md", content: "   " }).kind === "none" && microPeek({ name: "noext" }).kind === "none", "empty → badge");
});

await test("beauty rules: each hard rule catches a seeded violation and passes the clean layout", { "LY-10": "full" }, () => {
  const btn = (id: string, x: number, y: number, w = 44, h = 44, extra: Partial<B.Box> = {}): B.Box => ({ id, x, y, w, h, interactive: true, ...extra });
  const clean = [btn("a", 0, 0), btn("b", 52, 0), btn("c", 104, 0)];
  ok(B.targetSize(clean).length === 0 && B.overlaps(clean).length === 0 && B.rhythm(clean, "row").length === 0, "clean passes");
  // 2.5.8: small but spaced passes (spacing exception); small and crowded fails; inline links exempt
  ok(B.targetSize([btn("s", 0, 0, 16, 16), btn("t", 40, 0, 16, 16)]).length === 0, "spacing exception");
  ok(B.targetSize([btn("s", 0, 0, 16, 16), btn("t", 18, 0, 16, 16)]).length === 2, "crowded small targets fail");
  ok(B.targetSize([btn("s", 0, 0, 16, 16, { inline: true }), btn("t", 18, 0, 16, 16, { inline: true })]).length === 0, "inline exempt");
  ok(B.chromeTarget([btn("c", 0, 0, 30, 30, { chrome: true })]).length === 1 && B.chromeTarget([btn("c", 0, 0, 30, 30)]).length === 0, "chrome ≥32");
  ok(B.overlaps([btn("a", 0, 0), btn("b", 30, 0)]).length === 1 && B.overlaps([btn("a", 0, 0, 44, 44, { region: "x" }), btn("b", 30, 0, 44, 44, { region: "y" })]).length === 0, "overlap within a region only");
  ok(B.overlaps([btn("outer", 0, 0, 100, 100), btn("inner", 10, 10)]).length === 0, "nesting is not overlap");
  ok(B.clippedText([{ id: "t", x: 0, y: 0, w: 10, h: 10, clipped: true }]).length === 1 && B.clippedText([{ id: "t", x: 0, y: 0, w: 10, h: 10, clipped: true, ellipsis: true }]).length === 0, "clipped text");
  ok(B.offscreen([btn("o", 1430, 0, 44, 44, { chrome: true })], 1440, 900).length === 1, "offscreen");
  ok(B.offscreen([btn("o", 1430, 0, 44, 44, { chrome: true, scrolled: true })], 1440, 900).length === 0, "reachable by scrolling is not offscreen");
  // Fitts edge: a 10 px sliver on the right screen edge is judged on its height only; the same sliver mid-screen fails
  ok(B.chromeTarget([btn("e", 1430, 852, 10, 48, { chrome: true })], 32, 1440, 900).length === 0
    && B.chromeTarget([btn("e", 700, 852, 10, 48, { chrome: true })], 32, 1440, 900).length === 1
    && B.chromeTarget([btn("e", 1430, 880, 10, 20, { chrome: true })], 32, 1440, 900).length === 0
    && B.chromeTarget([btn("e", 1430, 700, 10, 20, { chrome: true })], 32, 1440, 900).length === 1, "edge exemption only on the edge axis");
  ok(B.squareIcons([{ id: "i", x: 0, y: 0, w: 48, h: 40, icon: true }]).length === 1, "square icons");
  const dock = { id: "dock", x: 0, y: 0, w: 1000, h: 64 };
  ok(B.dockBand([btn("1", 0, 0, 48, 48), btn("2", 56, 0, 48, 48)], dock, 1440).length === 0, "dock band ok");
  ok(B.dockBand([btn("1", 0, 0, 30, 30)], dock, 1440).length === 1 && B.dockBand([btn("1", 0, 0, 48, 48), btn("2", 0, 0, 40, 40)], dock, 1440).length >= 1, "too small / uneven");
  ok(B.dockBand([btn("1", 0, 0, 48, 48)], { ...dock, w: 1400 }, 1440).length === 1, "dock wider than 90%");
  ok(B.rhythm([btn("a", 0, 0), btn("b", 52, 0), btn("c", 110, 0)], "r").some((v) => /gap/.test(v.detail)), "uneven gaps");
  ok(B.rhythm([btn("a", 0, 0), btn("b", 52, 4), btn("c", 104, 0)], "r").some((v) => /centre/.test(v.detail)), "misaligned centre line");
  ok(B.equilibrium({ id: "d", x: 100, y: 0, w: 200, h: 10 }, { id: "f", x: 0, y: 0, w: 400, h: 10 }, "d").length === 0 && B.equilibrium({ id: "d", x: 140, y: 0, w: 200, h: 10 }, { id: "f", x: 0, y: 0, w: 400, h: 10 }, "d").length === 1, "equilibrium");
  ok(B.lineHeight([{ id: "p", x: 0, y: 0, w: 1, h: 1, lines: 3, fontSize: 16, lineHeight: 19 }]).length === 1 && B.lineHeight([{ id: "p", x: 0, y: 0, w: 1, h: 1, lines: 3, fontSize: 16, lineHeight: 24 }]).length === 0, "line height");
  ok(B.goldenCards([{ id: "c", x: 0, y: 0, w: CARD_W, h: CARD_H }]).length === 0 && B.goldenCards([{ id: "c", x: 0, y: 0, w: 112, h: 150 }]).length === 1, "golden cards");
  // soft rules never hard-fail
  const soft = [...B.proportion([{ id: "sq", x: 0, y: 0, w: 100, h: 100 }]), ...B.typeScale([8, 9, 10, 11, 12, 13, 14, 15, 16, 40], "v")];
  ok(soft.length >= 2 && soft.every((v) => !v.hard), "proportion / type-scale are soft");
  ok(B.nearestPleasing(1618, 1000).name === "φ" && B.nearestPleasing(1414, 1000).name === "√2", "nearest pleasing");
  const bal = B.balance([{ id: "l", x: 0, y: 0, w: 10, h: 10 }, { id: "r", x: 90, y: 90, w: 10, h: 10 }], { id: "f", x: 0, y: 0, w: 100, h: 100 });
  ok(Math.abs(bal - 1) < 1e-9, `symmetric balance = 1 (${bal})`);
});

await test("open-with routing shared by Files / desktop / Tabletop; settings, routine 'view', seed rows", { "LY-06": "partial", "LY-07": "full", "LY-05": "partial" }, () => {
  ok(appForFile("a.svg", "image/svg+xml") === "vector" && appForFile("b.png", "image/png") === "imageedit" && appForFile("c.csv", "text/csv") === "editor"
    && appForFile("d.vcf", "text/vcard") === "contacts" && appForFile("e.xlsx", "") === "sheet" && appForFile("x", "", "dir") === "files" && appForFile("f.zzz", "application/octet-stream") === "peek", "routing");
  ok(validateSetting("appearance.desktopView", "tabletop") === null && validateSetting("appearance.desktopView", "classic") === null && validateSetting("appearance.desktopView", "3d") !== null, "desktopView enum");
  for (const v of ["auto", "small", "medium", "large"]) ok(validateSetting("appearance.dockSize", v) === null, `dockSize ${v}`);
  ok(validateSetting("appearance.dockSize", "huge") !== null, "dockSize junk refused");
  ok((ROUTINE_COMMANDS as readonly string[]).includes("view"), "routine command 'view'");
  const seed = readFileSync("src/db/seed.ts", "utf8");
  ok(/key: "appearance.desktopView", value: "classic"/.test(seed) && /key: "appearance.dockSize", value: "auto"/.test(seed), "seed rows (classic stays the default)");
  const shell = readFileSync("src/components/Shell.tsx", "utf8");
  ok(/case "view": if \(arg === "tabletop" \|\| arg === "classic"\)/.test(shell), "Shell runs the routine command");
});

finish();
