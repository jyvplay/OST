/**
 * TT60 small units:
 *   RG-05 battery / metered awareness — the governor's snapshot under a discharging battery below 20 % pauses background
 *         work with a stated reason; heavyWorkRefusal() gates backup bundles (threshold, charging, Data Saver), with the
 *         boundary values written out by hand (the browser half is in e2e-tt60).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt60-units.mts
 */
import { makeHarness } from "./harness.mts";
import { governor, heavyWorkRefusal } from "../src/lib/governor.ts";

const { test, finish } = makeHarness("tt60-units");
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

await test("RG-05 heavyWorkRefusal: < 20 % and discharging refuses (says the level); 20 %, charging, unknown battery go ahead; Data Saver refuses", { "RG-05": "full" }, () => {
  const g = (batteryLevel: number | null, charging: boolean | null, saveData = false) => heavyWorkRefusal({ batteryLevel, charging, saveData });
  ok(g(0.19, false)?.includes("19%"), "19% discharging refused with the level");
  ok(g(0.05, false)?.includes("discharging"), "5% refused");
  eq(g(0.2, false), null, "exactly 20% is allowed (below 20% refuses)");
  eq(g(0.1, true), null, "charging is allowed");
  eq(g(null, null), null, "no Battery API (Firefox / Safari) is allowed — never a false refusal");
  ok(g(0.9, false, true)?.includes("Data Saver"), "Data Saver refuses");
  ok(g(0.1, false, true)?.includes("Battery"), "battery reason first");
});

await test("RG-05 governor snapshot: a low discharging battery pauses background work and states why; charging restores it", { "RG-05": "full" }, () => {
  const G = governor as unknown as { frameMs: number; battery: { level: number; charging: boolean } | null; snapshot: () => { backgroundWork: boolean; reason: string; state: string; batteryLevel: number | null } };
  G.battery = { level: 0.15, charging: false };
  let s = G.snapshot();
  eq([s.backgroundWork, s.state, s.batteryLevel], [false, "WARM", 0.15], "paused");
  ok(/Battery below 20%/.test(s.reason), "reason " + s.reason);
  G.battery = { level: 0.15, charging: true };
  s = G.snapshot();
  eq([s.backgroundWork, s.state], [true, "COOL"], "charging");
  // a busy-but-fine machine (WARM from frame cost) still reports the battery reason; 60 Hz idle is COOL, not WARM
  G.frameMs = 20; G.battery = { level: 0.1, charging: false };
  s = G.snapshot(); ok(/Battery below 20%/.test(s.reason) && !s.backgroundWork, "battery reason over WARM: " + s.reason);
  G.battery = null; s = G.snapshot(); eq(s.state, "WARM", "20 ms interval is WARM");
  G.frameMs = 16.7; s = G.snapshot(); eq(s.state, "COOL", "a healthy 60 Hz interval is COOL");
});

await finish();
