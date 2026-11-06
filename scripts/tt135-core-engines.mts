/**
 * TT135 pure-suite: network quality, scheduler hints, audio latency.
 * Runs in Node with no browser — these engines are pure functions.
 */
import { makeHarness } from "./harness.mts";
import { classifySample, nextQuality, planFor, pickSource } from "../src/lib/network-quality.ts";
import { planTask, chunks, shouldYield, describeCapabilities } from "../src/lib/scheduler-hints.ts";
import { PROFILES, quantumMs, evaluate, limiterPlan, peakDb, limiterGain } from "../src/lib/audio-latency.ts";

const { test, finish } = makeHarness("tt135-core-engines");

// ── Network quality (HW-09) ──────────────────────────────────────────────────
await test("HW-09 · slow-2g sample classifies as minimal", { "HW-09": "full" }, () => {
  const plan = classifySample({ effectiveType: "slow-2g" });
  if (plan.tier !== "minimal") throw new Error(`expected minimal, got ${plan.tier}`);
  if (plan.maxHeight !== null) throw new Error("minimal must be poster-only");
  if (plan.posterOnly !== true) throw new Error("minimal must set posterOnly");
});

await test("HW-09 · 4g with good downlink classifies as high", { "HW-09": "full" }, () => {
  const plan = classifySample({ effectiveType: "4g", downlink: 5, rtt: 100 });
  if (plan.tier !== "high") throw new Error(`expected high, got ${plan.tier}`);
  if (plan.maxHeight !== 1080) throw new Error("high must allow 1080p");
});

await test("HW-09 · saveData forces minimal even on 4g", { "HW-09": "full" }, () => {
  const plan = classifySample({ effectiveType: "4g", saveData: true });
  if (plan.tier !== "minimal") throw new Error(`expected minimal with saveData, got ${plan.tier}`);
});

await test("HW-09 · unknown effectiveType defaults to high", { "HW-09": "full" }, () => {
  const plan = classifySample({ effectiveType: "5g-unknown" as any });
  if (plan.tier !== "high") throw new Error(`expected high for unknown type, got ${plan.tier}`);
  if (!plan.reasons.some(r => r.includes("no usable"))) throw new Error("should note unknown signal");
});

await test("HW-09 · two agreeing samples needed before tier change", { "HW-09": "full" }, () => {
  const s1 = nextQuality(null, classifySample({ effectiveType: "3g" }), 1000);
  if (s1.tier !== "low") throw new Error(`expected low from 3g, got ${s1.tier}`);
  // First sample at low: streak 1. Second sample proposes high: streak 2 → one step to medium.
  const s2 = nextQuality(s1, classifySample({ effectiveType: "4g", downlink: 5 }), 2000);
  if (s2.tier !== "medium") throw new Error(`expected medium (one step from low), got ${s2.tier}`);
  // Third sample at medium: streak reset to 0 after change → streak 1, not enough for another step.
  const s3 = nextQuality(s2, classifySample({ effectiveType: "4g", downlink: 5 }), 3000);
  if (s3.tier !== "medium") throw new Error(`expected medium (streak 1, not enough), got ${s3.tier}`);
  // Fourth sample: streak 2 → one step to high.
  const s4 = nextQuality(s3, classifySample({ effectiveType: "4g", downlink: 5 }), 4000);
  if (s4.tier !== "high") throw new Error(`expected high (streak 2), got ${s4.tier}`);
});

await test("HW-09 · pickSource returns null when plan is poster-only", { "HW-09": "full" }, () => {
  const plan = planFor("minimal");
  const sources = [{ height: 360, src: "a.mp4" }];
  if (pickSource(plan, sources) !== null) throw new Error("poster-only must reject all sources");
});

await test("HW-09 · pickSource picks the highest fitting source", { "HW-09": "full" }, () => {
  const plan = planFor("medium"); // max 720
  const sources = [{ height: 1080, src: "h.mp4" }, { height: 720, src: "m.mp4" }, { height: 360, src: "l.mp4" }];
  const picked = pickSource(plan, sources);
  if (!picked || picked.src !== "m.mp4") throw new Error(`expected m.mp4, got ${picked?.src}`);
});

// ── Scheduler hints (RG-02) ───────────────────────────────────────────────────
await test("RG-02 · input kind maps to user-blocking", { "RG-02": "full" }, () => {
  const p = planTask("input", { postTask: true, idle: true, isInputPending: true }, true);
  if (p.priority !== "user-blocking") throw new Error(`expected user-blocking, got ${p.priority}`);
});

await test("RG-02 · background work uses idle when hidden", { "RG-02": "full" }, () => {
  const p = planTask("index", { postTask: true, idle: true, isInputPending: true }, false);
  if (p.priority !== "background") throw new Error(`expected background, got ${p.priority}`);
  if (!p.idle) throw new Error("should use idle callback when hidden");
});

await test("RG-02 · postTask unavailable downgrades with reason", { "RG-02": "full" }, () => {
  const p = planTask("status", { postTask: false, idle: true, isInputPending: true }, true);
  if (!p.downgraded) throw new Error("should report downgrade");
  if (!p.reason.includes("postTask unavailable")) throw new Error("reason should mention downgrade");
});

await test("RG-02 · chunks splits into bounded pieces", { "RG-02": "full" }, () => {
  const c = chunks(100, 12, 0.1);
  if (c.length === 0) throw new Error("must produce at least one chunk");
  if (c.length > 100) throw new Error("too many chunks");
  // Each chunk covers at most sliceMs / costPerUnit ≈ 120 units
  if (c[0].to - c[0].from > 120) throw new Error("chunk too large");
});

await test("RG-02 · shouldYield after slice budget", { "RG-02": "full" }, () => {
  if (!shouldYield(13, 12, false)) throw new Error("should yield after 13ms of a 12ms slice");
  if (shouldYield(5, 12, false)) throw new Error("should not yield at 5ms");
  if (!shouldYield(0, 12, true)) throw new Error("should yield when input is pending");
});

await test("RG-02 · capabilities string mentions all three", { "RG-02": "full" }, () => {
  const s = describeCapabilities({ postTask: true, idle: true, isInputPending: true });
  if (!s.includes("postTask") || !s.includes("idle") || !s.includes("input-pending")) throw new Error(`incomplete: ${s}`);
});

// ── Audio latency (HW-05) ────────────────────────────────────────────────────
await test("HW-05 · quantum at 48kHz is 2.67ms", { "HW-05": "full" }, () => {
  const q = quantumMs(48000);
  if (q !== 2.67) throw new Error(`expected 2.67ms, got ${q}`);
});

await test("HW-05 · suspended context reports not ok", { "HW-05": "full" }, () => {
  const v = evaluate("low", { state: "suspended", sampleRate: 48000 });
  if (v.ok) throw new Error("suspended should not be ok");
  if (v.grade !== "unknown") throw new Error(`expected unknown, got ${v.grade}`);
});

await test("HW-05 · running context with good latency grades excellent", { "HW-05": "full" }, () => {
  const v = evaluate("low", { state: "running", sampleRate: 48000, baseLatency: 0.003, outputLatency: 0.005 });
  if (!v.ok) throw new Error(`expected ok, got detail: ${v.detail}`);
  if (v.grade !== "excellent") throw new Error(`expected excellent, got ${v.grade}`);
});

await test("HW-05 · limiter plan has attack and release frames", { "HW-05": "full" }, () => {
  const plan = limiterPlan(48000, "low");
  if (plan.attackFrames < 1) throw new Error("attack must be at least 1 frame");
  if (plan.releaseFrames < 1) throw new Error("release must be at least 1 frame");
  if (plan.thresholdDb !== -1) throw new Error("default threshold is -1 dBFS");
});

await test("HW-05 · peakDb converts linear to dB", { "HW-05": "full" }, () => {
  const db = peakDb(1);
  if (Math.abs(db - 0) > 0.1) throw new Error(`expected ~0 dB for peak 1.0, got ${db}`);
});

await test("HW-05 · limiterGain reduces when input exceeds threshold", { "HW-05": "full" }, () => {
  const plan = limiterPlan(48000, "low");
  const g = limiterGain(0, 6, plan); // 6 dB above -1 dBFS threshold
  if (g >= 6) throw new Error(`limiter should reduce gain, got ${g}`);
});

await test("HW-05 · PROFILES cover all three profiles", { "HW-05": "full" }, () => {
  for (const key of ["low", "balanced", "stable"] as const) {
    const p = PROFILES[key];
    if (!p.latencyHint) throw new Error(`${key} missing latencyHint`);
    if (!p.reason) throw new Error(`${key} missing reason`);
  }
});

finish();
