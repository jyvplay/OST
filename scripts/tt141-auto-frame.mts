/**
 * TT141 — LN-02 auto-frame.
 *
 * The engine is new this turn; before it there was only an inline
 * `faceRef.current = box` in Lens.tsx, which is why the row said `probe`.
 * These tests are aimed at the two ways a camera filter actually fails: it
 * overshoots (seasick) or it never arrives (lagging behind the speaker).
 */
import { makeHarness } from "./harness.mts";
import {
  subjectFromFaces, initialTracker, track, cropRect, isSettled, describeAutoframe,
  SMOOTH_SECONDS, MAX_ZOOM, MIN_ZOOM, FRAME_FILL, MAX_STEP_FRACTION,
  type FaceBox, type Tracker,
} from "../src/lib/lens/auto-frame.ts";

const { test, finish } = makeHarness("tt141-auto-frame");

const face = (x: number, y: number, w: number, h: number): FaceBox => ({ x, y, w, h });

await test("LN-02 · one face gives a centred subject of its own size", { "LN-02": "full" }, () => {
  const s = subjectFromFaces([face(0.4, 0.3, 0.2, 0.2)]);
  if (!s) throw new Error("one valid face produced no subject");
  if (Math.abs(s.cx - 0.5) > 1e-9 || Math.abs(s.cy - 0.4) > 1e-9) throw new Error(`centre ${s.cx},${s.cy}`);
  if (Math.abs(s.rx - 0.1) > 1e-9 || Math.abs(s.ry - 0.1) > 1e-9) throw new Error(`half-extents ${s.rx},${s.ry}`);
});

await test("LN-02 · several faces produce the union, so nobody is cropped out", { "LN-02": "full" }, () => {
  // The attack: taking faces[0] makes the camera lurch when a second person
  // leans in. The union keeps both people in frame instead.
  const s = subjectFromFaces([face(0.1, 0.1, 0.1, 0.1), face(0.7, 0.5, 0.2, 0.2)]);
  if (!s) throw new Error("two faces produced no subject");
  if (Math.abs(s.cx - 0.5) > 1e-9) throw new Error(`union centre ${s.cx}, want 0.5`);
  if (Math.abs(s.rx - 0.4) > 1e-9) throw new Error(`union half-width ${s.rx}, want 0.4`);
  // Order must not matter.
  const rev = subjectFromFaces([face(0.7, 0.5, 0.2, 0.2), face(0.1, 0.1, 0.1, 0.1)]);
  if (JSON.stringify(rev) !== JSON.stringify(s)) throw new Error("face order changed the union");
});

await test("LN-02 · a degenerate or non-finite box cannot poison the frame", { "LN-02": "full" }, () => {
  // One NaN in the union would make every subsequent crop NaN and blank the
  // camera, so bad boxes are dropped before the union, not filtered after it.
  const s = subjectFromFaces([face(NaN, 0.2, 0.1, 0.1), face(0.4, 0.3, 0.2, 0.2)]);
  if (!s) throw new Error("one bad box discarded the good one");
  if (!Number.isFinite(s.cx) || !Number.isFinite(s.cy)) throw new Error("NaN survived into the subject");
  if (Math.abs(s.cx - 0.5) > 1e-9) throw new Error("the valid face was not used");
  // A zero-area box is not a person.
  if (subjectFromFaces([face(0.5, 0.5, 0, 0.2), face(0.5, 0.5, 0.2, -1)]) !== null) {
    throw new Error("a zero or negative area box was treated as a face");
  }
  if (subjectFromFaces([]) !== null) throw new Error("no faces must be null, not a centred subject");
});

await test("LN-02 · the first detection snaps instead of gliding in", { "LN-02": "full" }, () => {
  // Gliding from the centre reads as an unexplained slow pan on the very first
  // frame, before the user has even seen the picture settle.
  const t = track(initialTracker(), subjectFromFaces([face(0.8, 0.8, 0.1, 0.1)]), 1 / 30);
  if (!t.primed) throw new Error("the tracker did not prime");
  if (Math.abs(t.cx - 0.85) > 1e-9) throw new Error(`first frame at ${t.cx}, want the subject at 0.85`);
  if (t.vx !== 0) throw new Error("priming left velocity behind, which would kick off a spurious pan");
});

await test("LN-02 · the tracking is critically damped, so it never overshoots", { "LN-02": "full" }, () => {
  // Overshoot is the seasick failure. With ζ = 1 the position approaches the
  // target from one side and stops; it must never cross it.
  const target = subjectFromFaces([face(0.7, 0.5, 0.2, 0.2)])!;
  let t: Tracker = { ...initialTracker(), cx: 0.2, cy: 0.5, zoom: 1.5, primed: true };
  const start = t.cx;
  let maxOvershoot = 0;
  for (let i = 0; i < 300; i++) {
    t = track(t, target, 1 / 30);
    maxOvershoot = Math.max(maxOvershoot, t.cx - target.cx);
    if (t.cx > target.cx) throw new Error(`overshot the target at frame ${i}: ${t.cx} > ${target.cx}`);
  }
  if (maxOvershoot > 0) throw new Error("overshoot detected");
  if (start >= target.cx) throw new Error("test setup: the subject must start right of the crop");
  // It must actually arrive, not crawl forever.
  if (Math.abs(t.cx - target.cx) > 0.01) throw new Error(`did not converge: ${t.cx} vs ${target.cx}`);
});

await test("LN-02 · a stationary subject settles and stops moving", { "LN-02": "full" }, () => {
  const target = subjectFromFaces([face(0.4, 0.3, 0.2, 0.2)])!;
  let t = track(initialTracker(), target, 1 / 30);
  for (let i = 0; i < 120; i++) t = track(t, target, 1 / 30);
  if (!isSettled(t)) throw new Error(`still moving after 4 s: v=${t.vx},${t.vy},${t.vz}`);
  // Settled means settled: another second changes essentially nothing.
  const before = { cx: t.cx, cy: t.cy, zoom: t.zoom };
  for (let i = 0; i < 30; i++) t = track(t, target, 1 / 30);
  if (Math.abs(t.cx - before.cx) > 1e-3) throw new Error("a settled tracker kept drifting");
});

await test("LN-02 · a backgrounded tab cannot integrate seconds of velocity", { "LN-02": "full" }, () => {
  const target = subjectFromFaces([face(0.8, 0.5, 0.2, 0.2)])!;
  let t = track(initialTracker(), subjectFromFaces([face(0.1, 0.5, 0.2, 0.2)])!, 1 / 30);
  // Build up velocity, then hand it a 5-second delta as a returning tab would.
  for (let i = 0; i < 4; i++) t = track(t, target, 1 / 30);
  const jump = track(t, target, 5);
  const clamped = track(t, target, 0.1);
  if (Math.abs(jump.cx - clamped.cx) > 1e-9) throw new Error("a 5 s delta was not clamped to 100 ms");
  // And a nonsensical delta must be a no-op, not a NaN.
  for (const bad of [0, -1, NaN, Infinity]) {
    if (track(t, target, bad) !== t) throw new Error(`dt ${bad} was not a no-op`);
  }
});

await test("LN-02 · a wild detection cannot yank the crop to the frame edge", { "LN-02": "full" }, () => {
  // A detector that boxes a poster on the wall must move the crop gradually,
  // not teleport it in one frame.
  const wild = subjectFromFaces([face(0.95, 0.95, 0.04, 0.04)])!;
  const t0 = track(initialTracker(), subjectFromFaces([face(0.05, 0.05, 0.2, 0.2)])!, 1 / 30);
  const t1 = track(t0, wild, 1 / 30);
  if (t1.cx - t0.cx > MAX_STEP_FRACTION + 1e-9) {
    throw new Error(`one frame moved the crop ${(t1.cx - t0.cx).toFixed(3)} of the frame, cap is ${MAX_STEP_FRACTION}`);
  }
});

await test("LN-02 · losing the subject holds the framing instead of snapping to centre", { "LN-02": "full" }, () => {
  // A face turning away for a quarter second must not swing the camera back to
  // the middle and forth again.
  const target = subjectFromFaces([face(0.75, 0.5, 0.2, 0.2)])!;
  let t = track(initialTracker(), target, 1 / 30);
  for (let i = 0; i < 60; i++) t = track(t, target, 1 / 30);
  const held = { cx: t.cx, cy: t.cy };
  for (let i = 0; i < 10; i++) t = track(t, null, 1 / 30);
  if (Math.abs(t.cx - held.cx) > 1e-3) throw new Error(`drifted to ${t.cx} while holding ${held.cx}`);
  // Velocity must decay, so a second of absence is genuinely still.
  if (!isSettled(t)) throw new Error("velocity did not decay while the subject was lost");
});

await test("LN-02 · zoom fills the frame within its bounds", { "LN-02": "full" }, () => {
  // A small face zooms in, a large one zooms out, and neither escapes the bounds.
  const small = subjectFromFaces([face(0.45, 0.45, 0.1, 0.1)])!;
  const big = subjectFromFaces([face(0.1, 0.1, 0.8, 0.8)])!;
  let ts = track(initialTracker(), small, 1 / 30);
  let tb = track(initialTracker(), big, 1 / 30);
  if (ts.zoom <= 1) throw new Error(`a small subject did not zoom in: ${ts.zoom}`);
  if (tb.zoom !== MIN_ZOOM) throw new Error(`a subject filling the frame zoomed to ${tb.zoom}`);
  // A tiny face (a detector mis-boxing an eye) still cannot zoom without limit.
  for (let i = 0; i < 120; i++) ts = track(ts, subjectFromFaces([face(0.5, 0.5, 0.005, 0.005)])!, 1 / 30);
  if (ts.zoom > MAX_ZOOM + 1e-9) throw new Error(`zoom ${ts.zoom} exceeded ${MAX_ZOOM}`);
  // The framing rule itself: a face whose height IS the fill fraction needs no
  // zoom. (The half-extent is height/2, so the face height must be FRAME_FILL.)
  const mid = subjectFromFaces([face(0.4, 0.4, 0.2, FRAME_FILL)])!;
  const tm = track(initialTracker(), mid, 1 / 30);
  if (Math.abs(tm.zoom - 1) > 1e-9) throw new Error(`a subject already at the fill height should not zoom: ${tm.zoom}`);
});

await test("LN-02 · the crop rectangle always lies inside the source", { "LN-02": "full" }, () => {
  // A subject at the very edge would otherwise select pixels that do not exist,
  // leaving a black bar on one side of the output.
  for (const cx of [0, 0.02, 0.5, 0.98, 1]) {
    for (const zoom of [1, 1.5, MAX_ZOOM]) {
      const t: Tracker = { cx, cy: cx, zoom, vx: 0, vy: 0, vz: 0, primed: true };
      const r = cropRect(t, 1280, 720);
      if (r.x < -1e-9 || r.y < -1e-9) throw new Error(`crop at cx=${cx} zoom=${zoom} starts outside: ${r.x},${r.y}`);
      if (r.x + r.w > 1280 + 1e-6 || r.y + r.h > 720 + 1e-6) throw new Error(`crop at cx=${cx} overruns the source`);
      if (Math.abs(r.w - 1280 / zoom) > 1e-6) throw new Error("crop width does not follow zoom");
    }
  }
  // Zoom 1 is exactly the whole frame.
  const full = cropRect(initialTracker(), 1280, 720);
  if (full.x !== 0 || full.y !== 0 || full.w !== 1280 || full.h !== 720) throw new Error("zoom 1 is not the full frame");
});

await test("LN-02 · every frame is pure, and the honesty text names what is missing", { "LN-02": "full" }, () => {
  const t = initialTracker();
  const frozen = JSON.stringify(t);
  track(t, subjectFromFaces([face(0.5, 0.5, 0.2, 0.2)]), 1 / 30);
  if (JSON.stringify(t) !== frozen) throw new Error("track mutated the tracker it was given");
  // Without a detector the UI must say so rather than implying tracking.
  const noDetector = describeAutoframe(false, true, 0);
  if (!/no facedetector/i.test(noDetector)) throw new Error(`missing-detector text does not admit it: ${noDetector}`);
  if (/following/i.test(noDetector)) throw new Error("claimed to be following with no detector");
  if (/following 2 people/.test(describeAutoframe(true, true, 2)) === false) throw new Error("multi-person text missing");
  if (!/off/i.test(describeAutoframe(true, false, 3))) throw new Error("disabled state does not say off");
  // The smoothing constant is a duration in seconds, not a magic frame count.
  if (!(SMOOTH_SECONDS > 0 && SMOOTH_SECONDS < 2)) throw new Error(`implausible smoothing constant ${SMOOTH_SECONDS}`);
});

finish();
