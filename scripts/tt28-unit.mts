/**
 * Suite "tt28-unit" (TT28): pure logic behind the TT28 features, checked without a browser.
 *   - snap-core: every layout tiles the desk EXACTLY (no gaps / overlaps) at 2 000 random desk sizes; drag targets for
 *     corners / edges / interior; Snap Assist zone order; wide-only layouts; flyout thumbnails stay inside their box
 *   - the reducer's new "place" command: clamped like any rect, rejects NaN, keeps restore, raises z
 *   - ask store: FIFO queue, validation keeps a request open, settle-once, cancel-all, queue cap, value cap
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt28-unit.mts
 */
import { makeHarness } from "./harness.mts";
import * as S from "../src/lib/snap-core.ts";
import { reduce, initialDesktop } from "../src/lib/windowing/state.ts";
import * as A from "../src/lib/ask.ts";
import * as G from "../src/lib/genie-core.ts";

const { test, finish } = makeHarness("tt28-unit");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };

await test("snap layouts tile the desk exactly: for 2 000 random desk sizes every layout's zones cover each pixel exactly once; thumbnails stay inside their box", { "LY-16": "full" }, () => {
  let seed = 7; const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let n = 0; n < 2000; n++) {
    const desk = { w: Math.floor(320 + rnd() * 3500), h: Math.floor(240 + rnd() * 2000) };
    for (const l of S.SNAP_LAYOUTS) {
      const rs = l.zones.map((z) => S.zoneRect(z, desk));
      const area = rs.reduce((a, r) => a + r.w * r.h, 0);
      ok(area === desk.w * desk.h, `${l.id} at ${desk.w}×${desk.h}: area ${area} ≠ ${desk.w * desk.h}`);
      for (let i = 0; i < rs.length; i++) {
        const a = rs[i]; ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= desk.w && a.y + a.h <= desk.h && a.w > 0 && a.h > 0, `${l.id} zone out of desk`);
        for (let j = i + 1; j < rs.length; j++) {
          const b = rs[j]; const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          ok(!(ix > 0 && iy > 0), `${l.id} zones ${i},${j} overlap at ${desk.w}×${desk.h}`);
        }
      }
    }
  }
  // area equal + pairwise disjoint + inside ⇒ exact cover. Thumbnails: inside the box, gutters only between zones.
  for (const l of S.SNAP_LAYOUTS) for (const t of S.thumbZones(l, 88, 56)) ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= 88 && t.y + t.h <= 56, `${l.id} thumb outside`);
  ok(S.layoutsFor(1440).length === 5 && S.layoutsFor(1920).length === 6, "wide-only layout appears at ≥ 1600 px");
  ok(S.layoutById("quarters")!.zones.length === 4 && S.layoutById("nope") === null, "lookup");
});

await test("drag targets: corners → quarters, sides → halves, top → maximise, bottom edge only in its corners, interior → none; degenerate input → none", { "LY-17": "full" }, () => {
  const d = { w: 1440, h: 852 }; const c = S.cornerSpan(d);
  const k = (x: number, y: number) => S.dragTarget(x, y, d)?.key ?? null;
  ok(k(0, 0) === "tl" && k(1439, 0) === "tr" && k(0, 851) === "bl" && k(1439, 851) === "br", "exact corners");
  ok(k(0, c - 1) === "tl" && k(c - 1, 0) === "tl" && k(0, c + 1) === "left" && k(c + 1, 0) === "full", `corner span ${c}`);
  ok(k(0, 400) === "left" && k(1439, 400) === "right" && k(700, 0) === "full", "edges");
  ok(k(700, 851) === null && k(700, 400) === null && k(9, 400) === null, "bottom middle / interior / 9 px from edge");
  ok(S.dragTarget(NaN, 0, d) === null && S.dragTarget(0, 0, { w: 0, h: 0 }) === null, "degenerate");
  const tl = S.dragTarget(0, 0, d)!; ok(tl.rect.x === 0 && tl.rect.y === 0 && tl.rect.w === 720 && tl.rect.h === 426 && tl.layout === "quarters", `tl rect ${JSON.stringify(tl.rect)}`);
  const r = S.dragTarget(1439, 400, d)!; ok(r.rect.x === 720 && r.rect.w === 720 && r.rect.h === 852 && r.layout === "halves", "right half");
  ok(S.cornerSpan({ w: 200, h: 200 }) === 48 && S.cornerSpan({ w: 4000, h: 3000 }) === 160, "corner span clamps 48…160");
});

await test("Snap Assist plan: remaining zones in reading order; nothing to offer → null; the reducer's 'place' clamps, rejects NaN, keeps the restore rect, raises z", { "LY-16": "full" }, () => {
  const d = { w: 1440, h: 900 };
  const q = S.assistPlan("quarters", "tl", d, 3)!; ok(q.zones.map((z) => z.key).join() === "tr,bl,br", `quarters order ${q.zones.map((z) => z.key)}`);
  const h = S.assistPlan("half-quarters", "tr", d, 1)!; ok(h.zones.map((z) => z.key).join() === "left,br", `half-quarters ${h.zones.map((z) => z.key)}`);
  ok(S.assistPlan("halves", "left", d, 0) === null && S.assistPlan("bogus", "left", d, 2) === null, "no windows / unknown layout");
  let s = reduce(initialDesktop(), { t: "viewport", w: 1440, h: 900 });
  s = reduce(s, { t: "open", id: "a", module: "files", title: "A", rect: { x: 100, y: 100, w: 600, h: 400 } });
  s = reduce(s, { t: "open", id: "b", module: "notes", title: "B", rect: { x: 200, y: 150, w: 600, h: 400 } });
  const z0 = s.windows.find((w) => w.id === "a")!.z;
  s = reduce(s, { t: "place", id: "a", rect: { x: 720, y: 0, w: 720, h: 450 } });
  const a = s.windows.find((w) => w.id === "a")!;
  ok(a.x === 720 && a.y === 0 && a.w === 720 && a.h === 450 && !a.maximized && a.z > z0 && s.focus === "a", `placed ${JSON.stringify([a.x, a.y, a.w, a.h])}`);
  ok(a.restore && a.restore.w === 600, "restore kept");
  const s2 = reduce(s, { t: "place", id: "a", rect: { x: NaN, y: 0, w: 10, h: 10 } }); ok(s2 === s, "NaN rejected");
  const s3 = reduce(s, { t: "place", id: "a", rect: { x: 5000, y: -50, w: 50, h: 9000 } }); const a3 = s3.windows.find((w) => w.id === "a")!;
  ok(a3.x <= 1440 - 40 && a3.y >= 0 && a3.w >= 240 && a3.h <= 900, `clamped ${JSON.stringify([a3.x, a3.y, a3.w, a3.h])}`);
});

await test("ask store: FIFO queue; validation keeps the dialog open; each request settles exactly once; cancel-all; queue cap 8; values capped at 4 KiB", { "SH-15": "full" }, async () => {
  const p1 = A.askText("First", "one"); const p2 = A.askForm({ title: "Second", fields: [{ name: "a", label: "A" }, { name: "b", label: "B", secret: true }], validate: (v) => (v.a === v.b ? null : "must match") });
  ok(A.askQueueLength() === 2 && A.currentAsk()!.title === "First" && A.currentAsk()!.fields[0].def === "one", "queued in order");
  const id1 = A.currentAsk()!.id;
  ok(A.answerAsk(id1, { value: "hello" }) === "" && A.answerAsk(id1, { value: "again" }) === "", "settle + second settle is a no-op");
  ok(await p1 === "hello", "first resolved with the text");
  const id2 = A.currentAsk()!.id; ok(A.currentAsk()!.fields[1].secret === true, "secret flag kept");
  ok(A.answerAsk(id2, { a: "x", b: "y" }) === "must match" && A.isAskOpen(), "invalid stays open");
  ok(A.answerAsk(id2, { a: "x", b: "x", junk: "dropped" } as Record<string, string>) === "", "valid settles");
  const r2 = await p2; ok(r2 && r2.a === "x" && !("junk" in r2), "only declared fields are returned");
  const p3 = A.askText("Cancel me"); A.answerAsk(A.currentAsk()!.id, null); ok(await p3 === null, "cancel → null");
  const p4 = A.askText("Empty ok"); A.answerAsk(A.currentAsk()!.id, { value: "" }); ok(await p4 === "", "empty string is not cancel (prompt semantics)");
  const many = Array.from({ length: 10 }, (_, i) => A.askText(`m${i}`));
  ok(A.askQueueLength() === 8, `cap: ${A.askQueueLength()}`);
  ok(await many[9] === null && await many[8] === null, "requests beyond the cap resolve null");
  A.cancelAllAsks(); ok(!A.isAskOpen() && (await Promise.all(many.slice(0, 8))).every((v) => v === null), "cancel-all settles every pending request");
  const p5 = A.askText("Long"); A.answerAsk(A.currentAsk()!.id, { value: "x".repeat(10000) }); ok((await p5)!.length === A.MAX_VALUE, "value cap");
  const p6 = A.askForm({ title: "Throwing validator", fields: [{ name: "v", label: "V" }], validate: () => { throw new Error("boom"); } });
  ok(A.answerAsk(A.currentAsk()!.id, { v: "1" }) === "boom", "a throwing validator becomes an error message, not a crash");
  A.cancelAllAsks(); ok(await p6 === null, "then cancel");
  ok(await A.askForm({ title: "no fields", fields: [] }) === null, "no fields → null");
});

await test("genie keyframes: every frame has the same 4-point clip polygon (so it interpolates), offsets 0 → .45 → 1, phase 1 pinches only the bottom edge over the tile, and the last frame lands exactly on the dock tile for 500 random window/tile pairs", { "LY-19": "full" }, () => {
  let seed = 11; const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let n = 0; n < 500; n++) {
    const src = { x: rnd() * 1200, y: rnd() * 500, w: 240 + rnd() * 1400, h: 180 + rnd() * 700 };
    const dst = { x: rnd() * 1800, y: 820 + rnd() * 200, w: 30 + rnd() * 50, h: 30 + rnd() * 50 };
    const f = G.genieFrames(src, dst);
    ok(f.length === 3 && f.map((k) => k.offset).join() === "0,0.45,1", "offsets");
    const pts = f.map((k) => [...String(k.clipPath).matchAll(/px/g)].length);
    ok(pts.every((p) => p === 8), `clip points ${pts}`);
    const mid = [...String(f[1].clipPath).matchAll(/(-?[\d.]+)px (-?[\d.]+)px/g)].map((m) => [Number(m[1]), Number(m[2])]);
    ok(mid[0][0] === 0 && Math.abs(mid[1][0] - src.w) < 0.01, "phase 1 keeps the top edge");
    ok(Math.abs((mid[2][0] + mid[3][0]) / 2 - (dst.x + dst.w / 2 - src.x)) < 0.02, "phase 1 bottom edge centred over the tile");
    const b = G.finalBox(src, f);
    ok(Math.abs(b.x - dst.x) < 0.05 && Math.abs(b.w - dst.w) < 0.05 && Math.abs(b.y - dst.y) < 0.05 && Math.abs(b.h - dst.h) < 0.6, `final ${JSON.stringify(b)} vs ${JSON.stringify(dst)}`);
  }
  ok(G.GENIE_MS >= 300 && G.GENIE_MS <= 700, "duration in the 300–700 ms band of OS minimise animations");
});

finish();
