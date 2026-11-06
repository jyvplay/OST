/**
 * TT136 (HW-05) — low-latency audio, from a real AudioWorklet graph.
 *
 * The measured numbers a browser exposes (`baseLatency`, `outputLatency`) are
 * estimates that depend on the host's audio stack and on whether the context is
 * running at all. This module keeps the *policy* pure and testable, and the
 * Devices pane reports what the live context actually says — including "not
 * running", which is the honest answer in a headless container.
 */

export type LatencyProfile = "low" | "balanced" | "stable";

export interface ProfileSpec {
  latencyHint: "interactive" | "balanced" | "playback";
  /** Declared processing quantum budget for the worklet's limiter, in ms. */
  quantumBudgetMs: number;
  /** Fade length applied when the limiter engages, in ms (click-free). */
  attackMs: number;
  reason: string;
}

export const PROFILES: Record<LatencyProfile, ProfileSpec> = {
  low: { latencyHint: "interactive", quantumBudgetMs: 2.7, attackMs: 3, reason: "smallest interactive buffer" },
  balanced: { latencyHint: "balanced", quantumBudgetMs: 5.3, attackMs: 6, reason: "larger buffer, fewer dropouts" },
  stable: { latencyHint: "playback", quantumBudgetMs: 10.7, attackMs: 12, reason: "playback buffer, most tolerant of load" },
};

/** 128 samples is the Web Audio render quantum; a quantum at 48 kHz is 2.67 ms. */
export const RENDER_QUANTUM_FRAMES = 128;

export function quantumMs(sampleRate: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) throw new Error("sample rate must be 8,000…384,000 Hz");
  return Math.round((RENDER_QUANTUM_FRAMES / sampleRate) * 1000 * 100) / 100;
}

export interface Measurements {
  state: "running" | "suspended" | "closed" | "unknown";
  sampleRate: number;
  baseLatency?: number;
  outputLatency?: number;
  /** Round-trip measured by the worklet echo probe, when one ran. */
  measuredRoundTripMs?: number;
}

export interface Verdict {
  ok: boolean;
  profile: LatencyProfile;
  /** Total estimated output path latency in ms; null when the browser did not expose it. */
  estimatedMs: number | null;
  grade: "excellent" | "good" | "fair" | "unknown" | "stopped";
  detail: string;
}

/** Grade measured latency against the profile's own budget — not a universal audio claim. */
export function evaluate(profile: LatencyProfile, m: Measurements): Verdict {
  if (m.state !== "running") {
    return { ok: false, profile, estimatedMs: null, grade: m.state === "closed" ? "stopped" : "unknown", detail: `audio context is ${m.state}; latency cannot be measured` };
  }
  const base = typeof m.baseLatency === "number" && Number.isFinite(m.baseLatency) && m.baseLatency >= 0 && m.baseLatency < 1 ? m.baseLatency : null;
  const out = typeof m.outputLatency === "number" && Number.isFinite(m.outputLatency) && m.outputLatency >= 0 && m.outputLatency < 2 ? m.outputLatency : null;
  const measured = typeof m.measuredRoundTripMs === "number" && Number.isFinite(m.measuredRoundTripMs) && m.measuredRoundTripMs > 0 ? m.measuredRoundTripMs : null;
  const estimated = base === null && out === null && measured === null ? null : Math.round(((base ?? 0) + (out ?? 0) + (measured === null ? 0 : measured / 1_000)) * 1000 * 10) / 10;
  if (estimated === null) return { ok: false, profile, estimatedMs: null, grade: "unknown", detail: "browser exposed no latency numbers; the graph still runs" };
  const budget = profile === "low" ? 20 : profile === "balanced" ? 45 : 90;
  const grade = estimated <= budget / 2 ? "excellent" : estimated <= budget ? "good" : estimated <= budget * 2 ? "fair" : "fair";
  return {
    ok: estimated <= budget,
    profile,
    estimatedMs: estimated,
    grade,
    detail: `${estimated} ms on the output path (${profile} budget ${budget} ms); host audio stack dependent`,
  };
}

/**
 * Limiter plan for the worklet: a hard ceiling with a short attack ramp. The
 * numbers are per-render-quantum so the processor stays allocation-free.
 */
export interface LimiterPlan {
  thresholdDb: number;
  attackFrames: number;
  releaseFrames: number;
  makeUpDb: number;
  sampleRate: number;
}

export function limiterPlan(sampleRate: number, profile: LatencyProfile, thresholdDb = -1): LimiterPlan {
  const spec = PROFILES[profile];
  if (!Number.isFinite(thresholdDb) || thresholdDb < -24 || thresholdDb > 0) throw new Error("threshold must be -24…0 dBFS");
  const frames = (ms: number) => Math.max(1, Math.round((ms / 1000) * sampleRate));
  return {
    thresholdDb,
    attackFrames: frames(spec.attackMs),
    releaseFrames: frames(Math.max(40, spec.attackMs * 8)),
    makeUpDb: -thresholdDb,
    sampleRate,
  };
}

/** Peak-to-dB helper shared by the worklet probe and the tests. */
export function peakDb(peak: number): number {
  if (!Number.isFinite(peak) || peak < 0) throw new Error("peak must be finite and non-negative");
  return peak === 0 ? -Infinity : Math.round(20 * Math.log10(peak) * 100) / 100;
}

/** Apply one limiter gain step; deterministic and allocation-free (used by tests and the worklet). */
export function limiterGain(currentDb: number, inputDb: number, plan: LimiterPlan): number {
  const over = inputDb - plan.thresholdDb;
  const targetDb = over > 0 ? -over : 0;
  const frames = over > 0 ? plan.attackFrames : plan.releaseFrames;
  // one-pole approach: reaches ~63% of the needed change over `frames`
  const alpha = 1 / Math.max(1, frames);
  return currentDb + (targetDb - currentDb) * alpha;
}
