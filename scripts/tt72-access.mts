/**
 * TT72 SC-05 access log (src/lib/access-log.ts) — bookkeeping in Node. MediaStream does not exist in Node, so tracks
 * here are minimal EventTarget objects with stop(); the real browser path is scripts/e2e-tt72-access.mts.
 *  1. outcome classification of thrown errors (denied vs failed), newest-first order, 200-entry cap.
 *  2. a stream stays live until EVERY track ended — by "ended" event or by code calling stop() (which fires no event);
 *     double stop counts once; stopLive stops all tracks; Clear keeps live entries.
 *  3. wrappers over navigator: userMedia / displayMedia / clipboardRead / location record granted, denied, failed with
 *     the asking module, rethrow the original error, and never store content (clipboard text, coordinates).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt72-access.mts
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import * as L from "../src/lib/access-log.ts";

const { test, finish } = makeHarness("tt72-access");
const COV = { "SC-05": "full" } as const;
class Track extends EventTarget { kind: string; stopped = 0; constructor(kind: string) { super(); this.kind = kind; } stop() { this.stopped++; } }
const stream = (...kinds: string[]) => { const t = kinds.map((k) => new Track(k)); return { t, s: { getTracks: () => t, getAudioTracks: () => t.filter((x) => x.kind === "audio") } as unknown as MediaStream }; };
const err = (name: string) => Object.assign(new Error(name), { name });
const setNav = (v: unknown) => Object.defineProperty(globalThis, "navigator", { value: v, configurable: true, writable: true });

await test("outcomes, order, cap", COV, () => {
  L._reset();
  for (const n of ["NotAllowedError", "SecurityError", "PermissionDeniedError"]) assert.equal(L.outcomeOf(err(n)).outcome, "denied", n);
  for (const n of ["NotFoundError", "NotReadableError", "AbortError", "NotSupportedError", "OverconstrainedError"]) assert.equal(L.outcomeOf(err(n)).outcome, "failed", n);
  assert.deepEqual(L.outcomeOf(null), { outcome: "failed", error: "Error" });
  L.record("A", ["camera"], "granted"); L.record("B", ["screen"], "denied", "NotAllowedError");
  assert.deepEqual(L.snapshot().map((e) => e.app), ["B", "A"]);
  for (let i = 0; i < 300; i++) L.record(`m${i}`, ["location"], "failed");
  assert.equal(L.snapshot().length, L.MAX_ENTRIES); assert.equal(L.snapshot()[0].app, "m299");
  assert.equal(L.record("", ["camera"], "granted").app, "Unknown");
  assert.equal(L.record("x".repeat(500), ["camera"], "granted").app.length, 60);
  assert.deepEqual(L.kindsOf({ audio: true, video: { width: 1 } }), ["camera", "microphone"]);
  assert.deepEqual(L.kindsOf({ audio: false }), []);
});

await test("live until every track ended — 'ended' event or code stop(); double stop once; stopLive; Clear keeps live", COV, () => {
  L._reset();
  let n = 0; const un = L.subscribe(() => { n++; });
  const { t, s } = stream("video", "audio");
  const e = L.record("Lens", ["camera", "microphone"], "granted", undefined, true); L.track(e, s);
  t[0].stop(); t[0].stop();
  assert.equal(L.snapshot()[0].live, true, "one of two tracks still running");
  assert.equal(t[0].stopped, 2, "the real stop still runs each time");
  t[1].dispatchEvent(new Event("ended"));
  assert.equal(L.snapshot()[0].live, false); assert.ok(typeof L.snapshot()[0].endedAt === "number");
  const b = stream("video"); const e2 = L.record("Share", ["screen"], "granted", undefined, true); L.track(e2, b.s);
  L.record("Clip", ["clipboard-read"], "granted");
  L.clearLog();
  assert.deepEqual(L.snapshot().map((x) => x.app), ["Share"], "Clear keeps the live entry only");
  assert.equal(L.stopLive(e2.id), true); assert.equal(b.t[0].stopped, 1); assert.equal(L.snapshot()[0].live, false);
  assert.equal(L.stopLive(e2.id), false, "no stop hook after the end");
  const empty = stream(); const e3 = L.record("X", ["camera"], "granted", undefined, true); L.track(e3, empty.s);
  assert.equal(L.snapshot()[0].live, false, "a stream without tracks is not live");
  un(); const before = n; L.record("Y", ["camera"], "granted"); assert.equal(n, before, "unsubscribed");
});

await test("wrappers: granted / denied / failed with the module; original errors rethrown; no content stored", COV, async () => {
  L._reset();
  const real = globalThis.navigator;
  try {
    let next: () => Promise<unknown> = async () => stream("audio").s;
    let geo: (ok: (p: unknown) => void, no: (e: unknown) => void) => void = () => {};
    setNav({ mediaDevices: { getUserMedia: () => next(), getDisplayMedia: () => next() }, clipboard: { readText: () => next() }, geolocation: { getCurrentPosition: (a: never, b: never) => geo(a, b) } });
    const s = await L.userMedia("Devices · Voice", { audio: true });
    assert.deepEqual([L.snapshot()[0].app, L.snapshot()[0].kinds, L.snapshot()[0].outcome, L.snapshot()[0].live], ["Devices · Voice", ["microphone"], "granted", true]);
    s.getTracks()[0].stop(); assert.equal(L.snapshot()[0].live, false);
    next = async () => { throw err("NotAllowedError"); };
    await assert.rejects(L.userMedia("Lens", { video: true, audio: true }), { name: "NotAllowedError" });
    assert.deepEqual([L.snapshot()[0].kinds, L.snapshot()[0].outcome, L.snapshot()[0].error], [["camera", "microphone"], "denied", "NotAllowedError"]);
    next = async () => { throw err("NotSupportedError"); };
    await assert.rejects(L.displayMedia("Capture", { video: true }), { name: "NotSupportedError" });
    assert.deepEqual([L.snapshot()[0].kinds, L.snapshot()[0].outcome], [["screen"], "failed"]);
    next = async () => stream("video", "audio").s;
    await L.displayMedia("Share", { video: true, audio: true });
    assert.deepEqual(L.snapshot()[0].kinds, ["screen", "microphone"], "system audio in a display stream is logged");
    next = async () => "my bank PIN 1234";
    assert.equal(await L.clipboardRead("Clipboard"), "my bank PIN 1234");
    next = async () => { throw err("NotAllowedError"); };
    await assert.rejects(L.clipboardRead("Shell · clear sensitive copy"));
    const P = { PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
    let got = "";
    geo = (ok) => ok({ coords: { latitude: 35.7795, longitude: -78.6381 } });
    L.location("Maps", () => { got = "ok"; }, () => { got = "no"; });
    geo = (_ok, no) => no({ ...P, code: 1, message: "denied" });
    L.location("Maps", () => { got += "!"; }, () => { got += "+no"; });
    geo = (_ok, no) => no({ ...P, code: 3, message: "slow" });
    L.location("Maps", () => {}, () => {});
    assert.equal(got, "ok+no");
    const top = L.snapshot().slice(0, 5).map((e) => [e.app, e.kinds.join(), e.outcome, e.error ?? ""]);
    assert.deepEqual(top, [["Maps", "location", "failed", "Timeout"], ["Maps", "location", "denied", "PermissionDenied"], ["Maps", "location", "granted", ""], ["Shell · clear sensitive copy", "clipboard-read", "denied", "NotAllowedError"], ["Clipboard", "clipboard-read", "granted", ""]]);
    const dump = JSON.stringify(L.snapshot());
    assert.ok(!dump.includes("PIN") && !dump.includes("35.77") && !dump.includes("78.63"), "no content or coordinates in the log");
  } finally { setNav(real); }
});

finish();
