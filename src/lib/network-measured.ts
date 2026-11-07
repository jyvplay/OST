/**
 * TT139 (HW-09b) — a quality ladder driven by measured throughput, not by a guess.
 *
 * (Companion to `network-quality.ts`, which reasons over the Network Information
 * API's self-reported estimates. This file measures; that one interprets. The two
 * are deliberately separate so neither can launder a guess as a measurement.)
 *
 * `navigator.connection.effectiveType` is a coarse hint (Chromium only) and it is
 * wrong in both directions: a tethered phone reports 4g, and a throttled office
 * LAN reports 3g. So the ladder is driven by a real measurement — the wall-clock
 * time of a known-size response — and the hint is used only to *start* in a
 * sensible place. There is no image-quality knob that lies: the ladder names the
 * exact resolution and bitrate it will use.
 *
 * The measurement itself has to be honest about its own error: a single small
 * request is dominated by latency, so the model subtracts the measured round-trip
 * and refuses to publish a number when the sample is too small to be meaningful.
 *
 * Limits: no UDP, no active probing (that would be traffic the user did not ask
 * for), and a cache hit is not a measurement — a response served from cache is
 * discarded rather than reported as infinite bandwidth.
 */

export interface Sample { bytes: number; ms: number; fromCache?: boolean; rttMs?: number }
export interface Estimate { bitsPerSecond: number; confidence: "low" | "medium" | "high"; usable: boolean; reason: string }

export const MIN_SAMPLE_BYTES = 16 * 1024;
export const MIN_SAMPLE_MS = 12;

/** Throughput from one response, with latency subtracted and cache hits rejected. */
export function estimateThroughput(samples: readonly Sample[]): Estimate {
  const valid = samples.filter((s) => !s.fromCache && s.bytes > 0 && s.ms > 0);
  if (!valid.length) return { bitsPerSecond: 0, confidence: "low", usable: false, reason: "every sample came from cache or was empty — nothing was measured" };
  const totalBytes = valid.reduce((a, s) => a + s.bytes, 0);
  const totalMs = valid.reduce((a, s) => a + Math.max(1, s.ms - (s.rttMs ?? 0)), 0);
  const biggest = Math.max(...valid.map((s) => s.bytes));
  if (biggest < MIN_SAMPLE_BYTES) return { bitsPerSecond: 0, confidence: "low", usable: false, reason: `the largest response was ${biggest} bytes — too small to estimate throughput (need ${MIN_SAMPLE_BYTES})` };
  const bps = (totalBytes * 8) / (totalMs / 1000);
  // More bytes and more samples -> more confidence. Nothing here invents a
  // bracket: a single 20 KB sample is "medium" at best.
  const confidence: Estimate["confidence"] = totalBytes > 4 * 1024 * 1024 && valid.length >= 3 ? "high" : totalBytes > 512 * 1024 ? "medium" : "low";
  return { bitsPerSecond: Math.round(bps), confidence, usable: true, reason: `${valid.length} sample(s), ${(totalBytes / 1024).toFixed(0)} KiB transferred` };
}

export type RungName = "lowest" | "low" | "standard" | "high" | "best";
export interface Rung { name: RungName; maxHeight: number; bitrateKbps: number; fps: number; note: string }

export const LADDER: Rung[] = [
  { name: "lowest", maxHeight: 240, bitrateKbps: 150, fps: 15, note: "text stays readable, motion does not" },
  { name: "low", maxHeight: 360, bitrateKbps: 400, fps: 24, note: "usable for talking heads" },
  { name: "standard", maxHeight: 720, bitrateKbps: 1500, fps: 30, note: "default for a screen share with text" },
  { name: "high", maxHeight: 1080, bitrateKbps: 3500, fps: 30, note: "code and small type are legible" },
  { name: "best", maxHeight: 2160, bitrateKbps: 12000, fps: 30, note: "only with a real measurement above 20 Mbit/s" },
];

export const SAFETY_HEADROOM = 0.6;
export const MIN_USABLE_BPS = 300_000;

export function pickRung(estimate: Estimate, opts: { metered?: boolean; batterySaver?: boolean; wantResolution?: number } = {}): { rung: Rung; reason: string } {
  if (!estimate.usable || estimate.bitsPerSecond < MIN_USABLE_BPS) {
    return { rung: LADDER[0], reason: estimate.usable ? `measured ${(estimate.bitsPerSecond / 1000).toFixed(0)} kbit/s — below the floor for anything better` : estimate.reason };
  }
  const headroom = estimate.bitsPerSecond * SAFETY_HEADROOM * (opts.metered ? 0.6 : 1) * (opts.batterySaver ? 0.7 : 1);
  const want = opts.wantResolution ?? Infinity;
  const allowed = [...LADDER].reverse().filter((r) => r.bitrateKbps * 1000 <= headroom && r.maxHeight <= want);
  const chosen = allowed[0] ?? LADDER[0];
  const constraints = [opts.metered ? "metered connection" : null, opts.batterySaver ? "battery saver" : null].filter(Boolean);
  return { rung: chosen, reason: `${(headroom / 1_000_000).toFixed(1)} Mbit/s of usable headroom${constraints.length ? ` (${constraints.join(", ")})` : ""} → ${chosen.maxHeight}p` };
}

/** Adaptive step-down on observed loss; step-up needs a *stable* window. */
export function adaptRung(current: RungName, signal: { droppedFramesFraction: number; bufferedMs: number; stableMs: number }): { next: RungName; why: string } {
  const i = LADDER.findIndex((r) => r.name === current);
  if (signal.droppedFramesFraction > 0.08 || signal.bufferedMs > 2500) {
    return { next: LADDER[Math.max(0, i - 1)].name, why: signal.droppedFramesFraction > 0.08 ? `${(signal.droppedFramesFraction * 100).toFixed(0)}% frames dropped` : `${(signal.bufferedMs / 1000).toFixed(1)} s buffered` };
  }
  if (signal.stableMs >= 15_000 && signal.droppedFramesFraction < 0.01 && i < LADDER.length - 1) {
    return { next: LADDER[i + 1].name, why: `stable for ${Math.round(signal.stableMs / 1000)} s` };
  }
  return { next: current, why: "holding" };
}

/** A constraint set for getUserMedia that matches the rung exactly. */
export function captureConstraints(rung: Rung, deviceId?: string): Record<string, unknown> {
  return {
    audio: { echoCancellation: true, noiseSuppression: true },
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      height: { max: rung.maxHeight },
      frameRate: { max: rung.fps },
    },
  };
}
