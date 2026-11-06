/**
 * TT139 (HW-02, HW-05) — Worker pool sizing and low-latency audio budget.
 *
 * The browser gives us exactly one honest hardware number:
 * `navigator.hardwareConcurrency`. Everything else — cache size, whether a core
 * is a P-core, current thermal state — is unavailable. So this planner takes
 * that number plus an injected load level and produces a *defensible* pool
 * size, and documents where the guess could be wrong instead of pretending it
 * measured something.
 *
 * The rules, and why each is what it is:
 *   • CPU-bound parallel work gets `cores - 1` workers, keeping one core for
 *     the main thread. Going to `cores` makes the UI stutter while throughput
 *     stays flat — measured behaviour, not a hunch: the main thread competes
 *     for the same core and the render deadline slips.
 *   • I/O-bound work may exceed the core count because workers spend most of
 *     their time parked. The cap is `2 * cores` and never more than 16, since
 *     beyond that the context-switch cost dominates.
 *   • A memory budget can veto the plan. A worker that cannot allocate its
 *     working set just fails slower.
 *   • Under throttle, the plan shrinks *and says so*, rather than silently
 *     queueing.
 *
 * HW-05 computes an audio budget: the total number of simultaneous source
 * nodes and impulse responses that fit inside a latency target, which is the
 * number a mixer UI actually needs before it starts dropping voices.
 */

export type PoolStrategy = "round-robin" | "work-stealing" | "fifo";

export interface TaskProfile {
  /** Median task duration in ms — the caller measures this, we do not guess. */
  medianMs: number;
  /** 90th-percentile duration, if known; drives queue-depth advice. */
  p90Ms?: number;
  /** Peak bytes a single task allocates. */
  peakBytes: number;
  /** 0 = pure I/O wait, 1 = pure CPU spin. */
  cpuShare: number;
  parallelizable: boolean;
}

export interface PoolPlan {
  poolSize: number;
  maxQueueDepth: number;
  strategy: PoolStrategy;
  /** Upper bound assuming perfect scaling — labelled as an upper bound. */
  idealThroughputPerSec: number;
  /** Realistic bound after Amdahl on the non-parallel fraction. */
  realisticThroughputPerSec: number;
  /** Speedup over running on the main thread. */
  speedup: number;
  memoryWantedBytes: number;
  notes: string[];
}

export const MAX_WORKERS = 16;

export function planPool(
  hardwareConcurrency: number,
  profile: TaskProfile,
  opts: { memoryBudgetBytes?: number; loadLevel?: "cool" | "warm" | "hot" | "throttled" | "critical" } = {},
): PoolPlan {
  if (!Number.isInteger(hardwareConcurrency) || hardwareConcurrency < 1) {
    throw new Error(`hardwareConcurrency must be a positive integer, got ${hardwareConcurrency}`);
  }
  if (!(profile.medianMs > 0)) throw new Error("medianMs must be positive");
  if (profile.p90Ms !== undefined && profile.p90Ms < profile.medianMs) {
    throw new Error("p90Ms cannot be less than medianMs");
  }
  if (!(profile.peakBytes >= 0)) throw new Error("peakBytes must be non-negative");
  if (!(profile.cpuShare >= 0 && profile.cpuShare <= 1)) throw new Error("cpuShare must be 0..1");

  const notes: string[] = [];
  const cores = Math.min(hardwareConcurrency, MAX_WORKERS);
  if (hardwareConcurrency > MAX_WORKERS) {
    notes.push(`Hardware reports ${hardwareConcurrency} cores; capped at ${MAX_WORKERS} workers.`);
  }

  let poolSize: number;
  let strategy: PoolStrategy;

  if (!profile.parallelizable) {
    poolSize = 1;
    strategy = "fifo";
    notes.push("Tasks are not parallelizable; a single worker avoids lock contention.");
  } else if (profile.cpuShare >= 0.7) {
    poolSize = Math.max(1, cores - 1);
    strategy = "work-stealing";
    notes.push(`CPU-bound: ${cores} cores minus one for the main thread gives ${poolSize}.`);
  } else if (profile.cpuShare <= 0.3) {
    poolSize = Math.min(MAX_WORKERS, cores * 2);
    strategy = "round-robin";
    notes.push(`I/O-bound: workers park, so ${poolSize} (2× cores, capped at ${MAX_WORKERS}) is safe.`);
  } else {
    poolSize = Math.max(1, Math.round(cores * 0.75));
    strategy = "work-stealing";
    notes.push(`Mixed profile (cpuShare ${profile.cpuShare}): ${poolSize} workers, leaving headroom.`);
  }

  // Memory veto.
  const memoryWanted = poolSize * profile.peakBytes;
  const budget = opts.memoryBudgetBytes;
  if (budget !== undefined) {
    if (!(budget >= 0)) throw new Error("memoryBudgetBytes must be non-negative");
    if (profile.peakBytes > 0) {
      const maxByMemory = Math.floor(budget / profile.peakBytes);
      if (maxByMemory < poolSize) {
        if (maxByMemory < 1) {
          notes.push(`Memory budget ${budget} B is below one task's ${profile.peakBytes} B; pool forced to 1.`);
          poolSize = 1;
        } else {
          notes.push(`Memory budget allows ${maxByMemory} concurrent tasks; pool reduced from ${poolSize}.`);
          poolSize = maxByMemory;
        }
      }
    }
  }

  // Load veto.
  const level = opts.loadLevel ?? "cool";
  if (level === "throttled" || level === "critical") {
    const before = poolSize;
    poolSize = Math.max(1, Math.floor(poolSize / 2));
    notes.push(`Load is ${level}: pool reduced ${before} → ${poolSize} to protect the main thread.`);
  }

  // Amdahl-style honest throughput. The serial fraction is (1 - cpuShare) plus
  // a fixed 5% overhead for postMessage/serialisation, which is real cost that
  // a pure thread-count argument ignores.
  const serial = Math.min(0.95, (1 - profile.cpuShare) + 0.05);
  const speedup = 1 / (serial + (1 - serial) / poolSize);
  const baseRate = 1000 / profile.medianMs;

  // Queue depth: enough to keep workers fed across one p90 task, not so much
  // that a burst fills memory with pending results.
  const spread = profile.p90Ms && profile.p90Ms > profile.medianMs ? profile.p90Ms / profile.medianMs : 1.5;
  const maxQueueDepth = Math.max(poolSize, Math.ceil(poolSize * spread * 2));

  return {
    poolSize,
    maxQueueDepth,
    strategy,
    idealThroughputPerSec: Math.round(baseRate * poolSize * 100) / 100,
    realisticThroughputPerSec: Math.round(baseRate * speedup * 100) / 100,
    speedup: Math.round(speedup * 100) / 100,
    memoryWantedBytes: memoryWanted,
    notes,
  };
}

// ══ HW-05: low-latency audio budget ══════════════════════════════════════

export interface AudioBudget {
  /** Absolute floor from the device: baseLatency + outputLatency, seconds. */
  deviceLatencySec: number;
  /** Total added buffering in seconds. */
  addedLatencySec: number;
  /** End-to-end latency the user actually hears. */
  totalLatencySec: number;
  /** Frames of lookahead that fit in the buffer at this sample rate. */
  lookaheadFrames: number;
  /** Voices that can run in parallel before the audio callback misses. */
  safeVoices: number;
  /** Above this, the user perceives latency as a delay rather than tightening. */
  perceivedAs: "tight" | "acceptable" | "laggy";
  notes: string[];
}

/**
 * Latency classes for interactive audio. These are the standard perceptual
 * bands: under ~10 ms reads as "immediate" for monitoring, 10–25 ms is fine for
 * instruments, and past ~40 ms a player hears a delay.
 */
export const LATENCY_BANDS = { tight: 0.010, acceptable: 0.040 } as const;

export function audioBudget(opts: {
  baseLatencySec: number;
  outputLatencySec: number;
  sampleRate: number;
  bufferFrames: number;
  /** Rough per-voice cost as a fraction of the callback budget, 0..1. */
  costPerVoice: number;
  /** Convolver impulse responses each cost several times a plain voice. */
  convolverCount?: number;
}): AudioBudget {
  const { baseLatencySec, outputLatencySec, sampleRate, bufferFrames, costPerVoice } = opts;
  // 8 kHz is telephony-grade and cannot carry music; the floor for an audio
  // pipeline that claims low latency is 22.05 kHz.
  if (!(sampleRate >= 22050)) throw new Error(`Sample rate too low for audio work: ${sampleRate}`);
  if (!(bufferFrames >= 64)) throw new Error(`Buffer must be at least 64 frames, got ${bufferFrames}`);
  if (!(costPerVoice > 0 && costPerVoice <= 1)) throw new Error("costPerVoice must be in (0,1]");
  if (baseLatencySec < 0 || outputLatencySec < 0) throw new Error("Latencies cannot be negative");

  const bufferSec = bufferFrames / sampleRate;
  const addedLatencySec = bufferSec;
  const totalLatencySec = baseLatencySec + outputLatencySec + addedLatencySec;

  // Callback budget is one buffer period. A convolver is ~4x a plain voice.
  const convolvers = opts.convolverCount ?? 0;
  const fixedCost = Math.min(0.6, convolvers * 0.12);
  const available = Math.max(0, 1 - fixedCost - 0.15); // 15% safety margin
  const safeVoices = Math.max(0, Math.floor(available / costPerVoice));

  const notes: string[] = [];
  if (bufferSec > 0.02) {
    notes.push(`A ${bufferFrames}-frame buffer at ${sampleRate} Hz adds ${(bufferSec * 1000).toFixed(1)} ms; 256 frames or fewer is the interactive target.`);
  }
  if (convolvers > 2) {
    notes.push(`${convolvers} convolvers consume the majority of the callback budget.`);
  }
  if (safeVoices < 4) {
    notes.push("Fewer than 4 safe voices: reduce polyphony or increase the buffer.");
  }

  const perceivedAs: AudioBudget["perceivedAs"] =
    totalLatencySec <= LATENCY_BANDS.tight ? "tight" : totalLatencySec <= LATENCY_BANDS.acceptable ? "acceptable" : "laggy";

  return {
    deviceLatencySec: baseLatencySec + outputLatencySec,
    addedLatencySec,
    totalLatencySec,
    lookaheadFrames: Math.round(addedLatencySec * sampleRate),
    safeVoices,
    perceivedAs,
    notes,
  };
}

// ══ pool statistics (measured, not modelled) ═════════════════════════════

export interface PoolStats {
  completed: number;
  failed: number;
  queued: number;
  /** Sum of durations, so the mean is exact rather than an average of means. */
  totalMs: number;
  maxQueueSeen: number;
}

export function createPoolStats(): PoolStats {
  return { completed: 0, failed: 0, queued: 0, totalMs: 0, maxQueueSeen: 0 };
}

export function recordEnqueue(s: PoolStats): PoolStats {
  const queued = s.queued + 1;
  return { ...s, queued, maxQueueSeen: Math.max(s.maxQueueSeen, queued) };
}

export function recordStart(s: PoolStats): PoolStats {
  return { ...s, queued: Math.max(0, s.queued - 1) };
}

export function recordCompletion(s: PoolStats, durationMs: number, ok: boolean): PoolStats {
  if (!(durationMs >= 0)) throw new Error("Duration must be non-negative");
  return {
    ...s,
    completed: s.completed + (ok ? 1 : 0),
    failed: s.failed + (ok ? 0 : 1),
    totalMs: s.totalMs + durationMs,
  };
}

export function statsSummary(s: PoolStats): {
  meanMs: number;
  failureRate: number;
  throughputPerSec: number;
  backlog: boolean;
} {
  const total = s.completed + s.failed;
  return {
    meanMs: total ? s.totalMs / total : 0,
    failureRate: total ? s.failed / total : 0,
    throughputPerSec: s.totalMs > 0 ? (total / s.totalMs) * 1000 : 0,
    backlog: s.queued > s.maxQueueSeen * 0.8 && s.queued > 4,
  };
}
