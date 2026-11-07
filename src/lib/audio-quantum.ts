/**
 * TT145 (HW-05) — low-latency audio, measured rather than asserted.
 *
 * `AudioContext({latencyHint:"interactive"})` is a *hint*. The number that matters
 * is `baseLatency + outputLatency`, both of which the browser reports as
 * estimates, and both of which a headless container will report as zero or as a
 * suspended context. So this engine separates three things that are usually
 * conflated:
 *
 *   · **the render quantum** — 128 frames. It is fixed by the Web Audio spec, so
 *     the *scheduling* latency is 128/sampleRate (2.67 ms at 48 kHz) and that is
 *     arithmetic, not a measurement.
 *   · **the device latency** — whatever the browser says, or `null` when it says
 *     nothing. `null` is propagated as "unknown", never as zero.
 *   · **the graph's own cost** — a per-node budget: a limiter with look-ahead, a
 *     convolver, and a resampler each add a known number of frames. The engine sums
 *     them into a *declared* cost, and refuses a graph whose declared cost exceeds
 *     the measured budget.
 *
 * The refusal is the feature: "low latency" that silently drops a 40 ms convolver
 * into an interactive graph is worse than no low-latency mode, because the user
 * hears a delay they cannot explain.
 */

export const QUANTUM_FRAMES = 128;
export const SAMPLE_RATES = [44100, 48000, 96000] as const;

export type Kind = "gain" | "limiter" | "convolver" | "resampler" | "analyser" | "worklet";

export interface Node {
  kind: Kind;
  /** Frames of delay this node introduces, as declared by its author. */
  latencyFrames: number;
  /** Work this node does per quantum, in microseconds, as measured by the author. */
  costUs: number;
}

export interface Graph { nodes: Node[]; sampleRate: number; budgetUs: number }

export const NODE_COST: Record<Kind, { frames: number; reason: string }> = {
  gain: { frames: 0, reason: "sample-at-a-time, no buffering" },
  limiter: { frames: 128, reason: "one quantum look-ahead so the gain ramp is click-free" },
  convolver: { frames: 1024, reason: "partitioned convolution schedules at least one block" },
  resampler: { frames: 256, reason: "two-quantum interpolation window" },
  analyser: { frames: 0, reason: "reads the current quantum, adds no delay" },
  worklet: { frames: 0, reason: "processes the quantum it is handed" },
};

export interface Estimate {
  quantumMs: number;
  declaredDelayMs: number;
  /** Sum of the per-node costs, compared against the budget for one quantum. */
  graphCostUs: number;
  budgetUs: number;
  ok: boolean;
  why: string;
}

/**
 * Estimates one graph. The budget is per-quantum because that is the deadline a
 * worklet has; a graph that needs more than one quantum's worth of CPU on the
 * audio thread glitches, and the number of nodes is irrelevant to that.
 */
export function estimate(g: Graph): Estimate {
  if (!SAMPLE_RATES.includes(g.sampleRate as (typeof SAMPLE_RATES)[number])) throw new Error(`${g.sampleRate} Hz is not one of the rates this engine models`);
  if (!(g.budgetUs > 0)) throw new Error("a budget in microseconds is required");
  const quantumMs = (QUANTUM_FRAMES / g.sampleRate) * 1000;
  let frames = 0, cost = 0;
  for (const n of g.nodes) {
    if (!(n.latencyFrames >= 0)) throw new Error(`node ${n.kind} declares a negative latency`);
    if (!(n.costUs >= 0)) throw new Error(`node ${n.kind} declares a negative cost`);
    frames += n.latencyFrames;
    cost += n.costUs;
  }
  const ok = cost <= g.budgetUs;
  return {
    quantumMs,
    declaredDelayMs: (frames / g.sampleRate) * 1000,
    graphCostUs: cost,
    budgetUs: g.budgetUs,
    ok,
    why: ok
      ? `${cost} µs of the ${g.budgetUs} µs quantum budget; ${((frames / g.sampleRate) * 1000).toFixed(1)} ms of declared delay`
      : `${cost} µs exceeds the ${g.budgetUs} µs budget by ${cost - g.budgetUs} µs: this graph will not meet its deadline on the audio thread`,
  };
}

/** What the browser reported, kept distinct from what was computed. */
export interface Measured {
  state: "running" | "suspended" | "closed" | "unknown";
  sampleRate: number;
  baseLatency: number | null;
  outputLatency: number | null;
  /** True when the platform exposes an AudioWorklet constructor. */
  worklet: boolean;
}

export interface Report {
  computedQuantumMs: number;
  measuredTotalMs: number | null;
  verdict: "measured" | "unmeasured" | "not-running";
  sentence: string;
}

/**
 * Combines the two sources without ever adding a number to `null`. A suspended
 * context has measured nothing, so its report says so even if the fields exist —
 * a suspended context's latency is not the latency the user will hear.
 */
export function report(m: Measured): Report {
  const quantumMs = (QUANTUM_FRAMES / m.sampleRate) * 1000;
  if (m.state !== "running") return { computedQuantumMs: quantumMs, measuredTotalMs: null, verdict: "not-running", sentence: `the context is ${m.state}: nothing was measured, and ${quantumMs.toFixed(2)} ms is arithmetic from ${m.sampleRate} Hz` };
  const known = m.baseLatency !== null && m.outputLatency !== null;
  const total = known ? (m.baseLatency as number) * 1000 + (m.outputLatency as number) * 1000 : null;
  if (total === null) return { computedQuantumMs: quantumMs, measuredTotalMs: null, verdict: "unmeasured", sentence: `this browser reports ${m.baseLatency === null ? "no baseLatency" : "baseLatency"} and ${m.outputLatency === null ? "no outputLatency" : "outputLatency"}; only the ${quantumMs.toFixed(2)} ms quantum is known` };
  return {
    computedQuantumMs: quantumMs, measuredTotalMs: total, verdict: "measured",
    sentence: `${total.toFixed(1)} ms end to end as reported by the browser (its own estimate, not an acoustic measurement)`,
  };
}

/**
 * Drift between a worklet clock and the audio clock. A page cannot read the audio
 * clock offline, but it *can* compare the timestamps the worklet reports against
 * performance.now and refuse a graph whose drift is larger than a quantum.
 */
export function drift(ticks: number[], frameMs: number): { perTickMs: number; ok: boolean; why: string } {
  if (ticks.length < 2) throw new Error("drift needs at least two ticks");
  const deltas: number[] = [];
  for (let i = 1; i < ticks.length; i++) deltas.push(ticks[i] - ticks[i - 1]);
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const ok = Math.abs(mean - frameMs) <= frameMs;
  return {
    perTickMs: mean, ok,
    why: ok
      ? `ticks arrive every ${mean.toFixed(2)} ms against a ${frameMs.toFixed(2)} ms quantum`
      : `ticks arrive every ${mean.toFixed(2)} ms against a ${frameMs.toFixed(2)} ms quantum: more than one quantum of drift, which is an audible stutter`,
  };
}

/**
 * Resampling ratio check. A 44.1 kHz source into a 48 kHz context needs a
 * fractional ratio; using an integer ratio "close enough" accumulates error and
 * eventually produces a click. The engine returns the exact rational and refuses
 * a request whose error would exceed one sample per minute.
 */
export function resample(sourceHz: number, contextHz: number): { ratio: number; errorSamplesPerMinute: number; ok: boolean; why: string } {
  if (!(sourceHz > 0) || !(contextHz > 0)) throw new Error("sample rates must be positive");
  const ratio = contextHz / sourceHz;
  // A minute of SOURCE samples needs `ratio` output samples per source sample. The
  // error is the gap between that exact count and the nearest whole output sample,
  // expressed back in source samples, because that is the unit a click shows up in.
  const exactOutput = 60 * sourceHz * ratio;
  const errorSamplesPerMinute = Math.abs(exactOutput - Math.round(exactOutput)) / ratio;
  const ok = errorSamplesPerMinute < 1;
  return { ratio, errorSamplesPerMinute, ok, why: ok ? `${sourceHz} → ${contextHz} is exact to less than one sample a minute` : `${sourceHz} → ${contextHz} drifts ${errorSamplesPerMinute.toFixed(1)} samples a minute` };
}
