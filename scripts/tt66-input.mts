/**
 * TT66 IN-01 wheel normalisation (src/lib/input.ts). Ground truth = the per-notch values browsers are documented to
 * report for one notch of an ordinary mouse wheel (web sources recorded in docs/DESIGN-TT66.md): Chromium/Windows
 * 100 px (deltaMode 0), Firefox line mode 3 lines (deltaMode 1), Firefox's own line→pixel conversion ≈ 102.4 px, and
 * the feature's acceptance "wheel on 3 input kinds → same scroll distance ±10%".
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt66-input.mts
 */
import { makeHarness } from "./harness.mts";
import { wheelPx, normalizeWheel, PX_PER_NOTCH } from "../src/lib/input.ts";

const { test, finish } = makeHarness("tt66-input");
const COV = { "IN-01": "full" } as const;
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const near = (a: number, b: number, tol: number, m: string) => ok(Math.abs(a - b) <= tol * Math.abs(b), `${m}: ${a} vs ${b} (±${tol * 100}%)`);
const ev = (deltaMode: number, deltaY: number, deltaX = 0) => ({ deltaMode, deltaX, deltaY });

await test("one notch from three input kinds (Chromium px, Firefox lines, Firefox converted px) → the same distance ±10%; page mode = surface height", COV, () => {
  const chromium = wheelPx(ev(0, 100)).dy, ffLines = wheelPx(ev(1, 3)).dy, ffPx = wheelPx(ev(0, 102.4)).dy;
  for (const [n, v] of [["Firefox lines", ffLines], ["Firefox px", ffPx]] as const) near(v, chromium, 0.1, n);
  near(normalizeWheel(ev(1, 3)).notches, 1, 0.1, "3 lines = one notch");
  near(normalizeWheel(ev(0, 100)).notches, 1, 1e-9, "100 px = one notch");
  ok(wheelPx(ev(2, 1), 640).dy === 640 && wheelPx(ev(2, -0.5), 640).dy === -320, "page mode uses the surface height, sign kept");
  ok(wheelPx(ev(1, 0, 3)).dx === PX_PER_NOTCH, "horizontal deltas converted too");
  ok(wheelPx(ev(0, 37)).dy === 37, "pixel deltas untouched (a trackpad stays fine-grained)");
  ok(wheelPx(ev(2, 1), 0).dy === 1, "a zero-height surface never zeroes a page scroll");
});

await test("deltaMode is read BEFORE the deltas (Firefox ≥ 88 reports lines only to scripts that do; reading deltaY first converts the event)", COV, () => {
  const order: string[] = [];
  const spy = { get deltaMode() { order.push("mode"); return 1; }, get deltaX() { order.push("x"); return 0; }, get deltaY() { order.push("y"); return 3; } };
  wheelPx(spy);
  ok(order[0] === "mode", `access order ${order.join(",")}`);
});

finish();
