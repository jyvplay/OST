/**
 * TT142 — LN-08 voice isolation gate.
 *
 * The gate lived inside a template string in Lens.tsx, so its timings had never
 * been checked by anything but ear. These tests check the three properties that
 * make a gate usable instead of annoying.
 */
import { makeHarness } from "./harness.mts";
import {
  initialGate, stepGate, timeToReach, describeGate,
  HOLD_MS, ATTACK, RELEASE, ENVELOPE_DECAY, type GateState,
} from "../src/lib/lens/voice-gate.ts";

const { test, finish } = makeHarness("tt142-voice-gate");
const SR = 48000;
const TH = 0.02;

/** Run n samples of a constant-amplitude input and return the final state. */
const run = (s: GateState, amp: number, n: number, th = TH, sr = SR) => {
  let gain = 0;
  for (let i = 0; i < n; i++) {
    const r = stepGate(s, i % 2 === 0 ? amp : -amp, th, sr);
    s = r.state;
    gain = r.gain;
  }
  return { state: s, gain };
};

await test("LN-08 · silence keeps the gate shut and never leaks gain", { "LN-08": "full" }, () => {
  const { state, gain } = run(initialGate(), 0, SR);
  if (gain !== 0) throw new Error(`silence produced gain ${gain}`);
  if (state.hold !== 0) throw new Error("silence left a hold open");
});

await test("LN-08 · speech opens the gate in a couple of milliseconds", { "LN-08": "full" }, () => {
  // A slow attack clips the first consonant of every word.
  const { gain } = run(initialGate(), 0.5, Math.round(SR * 0.01));
  if (gain < 0.6) throw new Error(`10 ms of loud speech only reached gain ${gain.toFixed(3)} — the attack is too slow`);
});

await test("LN-08 · the hold bridges the gaps between words", { "LN-08": "full" }, () => {
  // This is the whole point: a gap inside a sentence must not mute the mic.
  // Open the gate, then go silent for just under the hold time.
  let s = run(initialGate(), 0.5, Math.round(SR * 0.05)).state;
  if (s.hold <= 0) throw new Error("the gate never opened");
  const gap = Math.round((HOLD_MS / 1000) * SR) - 10;
  const after = run(s, 0, gap);
  if (after.state.hold <= 0) throw new Error("the hold expired before HOLD_MS of silence");
  // ...and it must still be open, i.e. gain has not collapsed.
  if (after.gain < 0.5) throw new Error(`gain fell to ${after.gain.toFixed(3)} inside the hold window`);
  // Just past the hold, it should be closing.
  s = after.state;
  const past = run(s, 0, Math.round(SR * 0.4));
  if (past.gain > 0.1) throw new Error(`gate still open at ${past.gain.toFixed(3)} well past hold + release`);
});

await test("LN-08 · release is slow enough not to amputate a word's tail", { "LN-08": "full" }, () => {
  // A gate that closes instantly clips the decay of every final syllable.
  if (RELEASE >= ATTACK / 10) throw new Error("release is not meaningfully slower than attack");
  let s = run(initialGate(), 0.5, Math.round(SR * 0.05)).state;
  // Drop to silence and measure the gain one hold period later.
  const hold = Math.round((HOLD_MS / 1000) * SR);
  const tail = run(s, 0, hold + Math.round(SR * 0.005));
  if (tail.gain < 0.9) throw new Error(`gain collapsed to ${tail.gain.toFixed(3)} immediately after the hold — that clips tails`);
});

await test("LN-08 · a single click cannot hold the gate open", { "LN-08": "full" }, () => {
  // Peak-follow with decay is what makes this true; a plain running average
  // would be dragged upward by one spike and stay there.
  let s = stepGate(initialGate(), 1.0, TH, SR).state;
  const envAfterSpike = s.env;
  // The envelope must have decayed measurably one millisecond later.
  s = run(s, 0, Math.round(SR * 0.001)).state;
  if (s.env >= envAfterSpike) throw new Error("the envelope did not decay after the spike");
  if (ENVELOPE_DECAY >= 1) throw new Error("envelope decay is a no-op");
});

await test("LN-08 · non-finite samples are silence, not NaN gain", { "LN-08": "full" }, () => {
  // One NaN reaching the gain would silence the mic permanently and look like
  // a hardware failure.
  let s = initialGate();
  for (const bad of [NaN, Infinity, -Infinity]) {
    const r = stepGate(s, bad, TH, SR);
    s = r.state;
    if (!Number.isFinite(r.gain)) throw new Error(`sample ${bad} produced gain ${r.gain}`);
    if (!Number.isFinite(s.env)) throw new Error(`sample ${bad} poisoned the envelope`);
  }
});

await test("LN-08 · the threshold actually controls what opens the gate", { "LN-08": "full" }, () => {
  // Below threshold: shut. Above: open. Checked on the same signal at two thresholds.
  const quiet = run(initialGate(), 0.01, Math.round(SR * 0.05), 0.02);
  if (quiet.gain > 0.05) throw new Error(`input below threshold opened the gate to ${quiet.gain.toFixed(3)}`);
  const loud = run(initialGate(), 0.3, Math.round(SR * 0.05), 0.02);
  if (loud.gain < 0.9) throw new Error(`input above threshold barely opened: ${loud.gain.toFixed(3)}`);
});

await test("LN-08 · sample rate changes the hold in time, not in samples", { "LN-08": "full" }, () => {
  // A hardcoded sample count is the classic bug: correct at 48 kHz, an eighth
  // of the intended hold at 8 kHz.
  const at8k = run(initialGate(), 0.5, 800, TH, 8000);
  if (at8k.state.hold <= 0) throw new Error("the gate did not open at 8 kHz");
  // 100 ms at 8 kHz is 800 samples. The original worklet hardcoded 4800, which
  // is 100 ms only at 48 kHz; here it would hold the mic open for 600 ms.
  if (at8k.state.hold > 800) throw new Error(`hold is sample-count based: ${at8k.state.hold} samples at 8 kHz, want ≤800`);
});

await test("LN-08 · the gate is pure, and its own text tells the truth", { "LN-08": "full" }, () => {
  const s = initialGate();
  const frozen = JSON.stringify(s);
  stepGate(s, 0.5, TH, SR);
  if (JSON.stringify(s) !== frozen) throw new Error("stepGate mutated its state");
  // An honest description must not promise music removal.
  const d = describeGate(0.02, true);
  if (/removes? music/i.test(d) && !/cannot/i.test(d)) throw new Error("the description promises music removal");
  if (!/cannot/i.test(d)) throw new Error("the description does not state a limit");
  if (!/ungated/i.test(describeGate(0.02, false))) throw new Error("a missing worklet must be stated, not hidden");
  // Time-to-reach must be computed from the coefficient, not hardcoded.
  const t = timeToReach(0, 1, ATTACK, SR);
  if (!(t > 0.5 && t < 20)) throw new Error(`attack time computed as ${t.toFixed(2)} ms, which is not a few ms`);
});

finish();
