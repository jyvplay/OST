/**
 * TT139 (RG-01, RG-02, RG-04, RG-06) — Load governor, scheduling hints,
 * resource monitor, and low-memory mode.
 *
 * A browser cannot read a thermometer. What it *can* read is its own frame
 * budget, its own event-loop lag, and its own allocation churn. Those are
 * leading indicators of the same thing a thermal throttle responds to, so this
 * module grades pressure from them and the UI calls that what it is: a load
 * governor, not a thermal sensor.
 *
 * Hysteresis is the whole design. A governor without it oscillates: pressure
 * rises, it throttles, throttling drops pressure, it un-throttles, pressure
 * rises again — every 200 ms, forever, which is worse than either steady state.
 * `enterAt` / `leaveAt` per level, plus a dwell time, makes transitions rare
 * and monotone in practice.
 *
 * RG-02 scheduling hints answer "when should this background task run?" from
 * the same pressure signal, so a backup starts during idle and a prefetch waits.
 * RG-06 low-memory mode is a policy object the rest of the app reads: cache
 * caps, image decode limits, and which features degrade rather than fail.
 */

// ══ RG-01: load governor ═════════════════════════════════════════════════

export type LoadLevel = "cool" | "warm" | "hot" | "throttled" | "critical";

export const LOAD_LEVELS: LoadLevel[] = ["cool", "warm", "hot", "throttled", "critical"];

export interface LoadSample {
  /** Fraction of the frame budget consumed, 0..1. */
  frameLoad: number;
  /** Event-loop lag in ms over the last window. */
  eventLoopLagMs: number;
  /** Heap used as a fraction of the JS heap limit, 0..1. */
  heapPressure: number;
  at: number;
}

export interface GovernorThresholds {
  enterAt: Record<Exclude<LoadLevel, "cool">, number>;
  leaveAt: Record<Exclude<LoadLevel, "cool">, number>;
  /** Minimum ms between two upward transitions. */
  dwellMs: number;
}

/**
 * Defaults are deliberately asymmetric: it takes a sustained 0.65 composite to
 * enter "hot" but only a drop below 0.45 to leave it. See the hysteresis note
 * in the module header.
 */
export const DEFAULT_THRESHOLDS: GovernorThresholds = {
  enterAt: { warm: 0.30, hot: 0.60, throttled: 0.80, critical: 0.93 },
  leaveAt: { warm: 0.20, hot: 0.45, throttled: 0.70, critical: 0.85 },
  dwellMs: 1500,
};

export interface LoadGovernor {
  level: LoadLevel;
  /** Exponential moving average of the composite pressure, 0..1. */
  pressure: number;
  samples: LoadSample[];
  transitions: Array<{ from: LoadLevel; to: LoadLevel; at: number }>;
  lastTransitionAt: number;
  thresholds: GovernorThresholds;
}

export function createLoadGovernor(now: number, thresholds: Partial<GovernorThresholds> = {}): LoadGovernor {
  return {
    level: "cool",
    pressure: 0,
    samples: [],
    transitions: [],
    lastTransitionAt: now,
    thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds },
  };
}

/**
 * Composite pressure in 0..1.
 *
 * Lag is scaled against a 200 ms bar because 200 ms is the threshold at which
 * a UI stops feeling responsive; heap against 1.0 because pressure is already
 * a fraction. The weights sum to 1 so the result stays in range.
 */
export function compositePressure(s: LoadSample): number {
  const lag = Math.min(1, Math.max(0, s.eventLoopLagMs / 200));
  const frame = Math.min(1, Math.max(0, s.frameLoad));
  const heap = Math.min(1, Math.max(0, s.heapPressure));
  return 0.45 * lag + 0.35 * frame + 0.20 * heap;
}

export const PRESSURE_ALPHA = 0.35;

export function applyLoadSample(g: LoadGovernor, sample: LoadSample): LoadGovernor {
  if (!Number.isFinite(sample.at)) throw new Error("Sample needs a finite timestamp");
  const instant = compositePressure(sample);
  const pressure = g.pressure + PRESSURE_ALPHA * (instant - g.pressure);

  let level = g.level;
  const t = g.thresholds;

  // Upward: only if the instant AND the smoothed value both clear the bar and
  // the dwell time has elapsed. Two signals keeps a single spike from acting.
  const canRise = sample.at - g.lastTransitionAt >= t.dwellMs;
  if (canRise) {
    for (let i = LOAD_LEVELS.indexOf(level) + 1; i < LOAD_LEVELS.length; i++) {
      const candidate = LOAD_LEVELS[i] as Exclude<LoadLevel, "cool">;
      if (pressure >= t.enterAt[candidate] && instant >= t.enterAt[candidate] * 0.9) {
        level = candidate;
      }
    }
  }

  // Downward: hysteresis, and it may drop more than one level at once so a
  // machine that unloads does not crawl back down over eight seconds.
  while (level !== "cool" && pressure <= t.leaveAt[level]) {
    const idx = LOAD_LEVELS.indexOf(level);
    level = LOAD_LEVELS[idx - 1];
  }

  const transitions =
    level !== g.level ? [...g.transitions, { from: g.level, to: level, at: sample.at }].slice(-50) : g.transitions;

  return {
    ...g,
    level,
    pressure,
    samples: [...g.samples, sample].slice(-60),
    transitions,
    lastTransitionAt: level !== g.level ? sample.at : g.lastTransitionAt,
  };
}

export interface ThrottlePolicy {
  /** Target animation frame rate. */
  maxFps: number;
  maxConcurrentTasks: number;
  cacheEntries: number;
  /** Artificial delay before starting background work, ms. */
  backgroundDelayMs: number;
  /** Whether decorative animation may run at all. */
  allowDecoration: boolean;
}

export function throttlePolicy(level: LoadLevel): ThrottlePolicy {
  switch (level) {
    case "cool": return { maxFps: 60, maxConcurrentTasks: 8, cacheEntries: 400, backgroundDelayMs: 0, allowDecoration: true };
    case "warm": return { maxFps: 60, maxConcurrentTasks: 6, cacheEntries: 250, backgroundDelayMs: 50, allowDecoration: true };
    case "hot": return { maxFps: 30, maxConcurrentTasks: 4, cacheEntries: 120, backgroundDelayMs: 200, allowDecoration: false };
    case "throttled": return { maxFps: 15, maxConcurrentTasks: 2, cacheEntries: 40, backgroundDelayMs: 800, allowDecoration: false };
    case "critical": return { maxFps: 10, maxConcurrentTasks: 1, cacheEntries: 8, backgroundDelayMs: 2000, allowDecoration: false };
  }
}

export function isThrottled(g: LoadGovernor): boolean {
  return g.level === "throttled" || g.level === "critical";
}

// ══ RG-02: scheduling hints ══════════════════════════════════════════════

export type TaskWeight = "light" | "normal" | "heavy";

export interface ScheduleHint {
  runNow: boolean;
  /** ms to defer, or 0 for "now". */
  deferMs: number;
  /** Why, in words the UI can show. */
  reason: string;
}

/**
 * Decide when a background task should start. Heavy work is deferred further
 * at higher pressure, and is refused outright at critical, because a heavy
 * task in a 10-fps UI makes the app unusable and the task slower anyway.
 */
export function schedulingHint(g: LoadGovernor, weight: TaskWeight, userInitiated = false): ScheduleHint {
  if (userInitiated) {
    return { runNow: true, deferMs: 0, reason: "User-initiated; runs regardless of load" };
  }
  const base: Record<TaskWeight, number> = { light: 0, normal: 300, heavy: 1500 };
  const multiplier: Record<LoadLevel, number> = { cool: 1, warm: 2, hot: 4, throttled: 8, critical: Infinity };
  const mult = multiplier[g.level];

  if (!Number.isFinite(mult)) {
    return {
      runNow: false,
      deferMs: 0,
      reason: weight === "heavy" ? "Deferred until load drops: system is critical" : "Critical load; background work paused",
    };
  }
  const deferMs = Math.round(base[weight] * mult);
  return {
    runNow: deferMs === 0,
    deferMs,
    reason: deferMs === 0 ? `Load is ${g.level}; safe to run` : `Load is ${g.level}; deferring ${deferMs} ms`,
  };
}

// ══ RG-04: resource monitor ══════════════════════════════════════════════

export interface ResourceReport {
  sampleCount: number;
  windowMs: number;
  frameLoadAvg: number;
  frameLoadPeak: number;
  lagAvgMs: number;
  lagPeakMs: number;
  heapAvg: number;
  heapPeak: number;
  /** Fraction of samples spent above the "hot" entry threshold. */
  timeInPressure: number;
  level: LoadLevel;
  /** True when the peaks tell a different story than the averages. */
  spiky: boolean;
}

export function resourceReport(g: LoadGovernor): ResourceReport {
  const s = g.samples;
  if (!s.length) {
    return {
      sampleCount: 0, windowMs: 0, frameLoadAvg: 0, frameLoadPeak: 0,
      lagAvgMs: 0, lagPeakMs: 0, heapAvg: 0, heapPeak: 0,
      timeInPressure: 0, level: g.level, spiky: false,
    };
  }
  const avg = (f: (x: LoadSample) => number): number => s.reduce((a, x) => a + f(x), 0) / s.length;
  const peak = (f: (x: LoadSample) => number): number => Math.max(...s.map(f));
  const frameLoadAvg = avg((x) => x.frameLoad);
  const frameLoadPeak = peak((x) => x.frameLoad);
  const lagAvgMs = avg((x) => x.eventLoopLagMs);
  const lagPeakMs = peak((x) => x.eventLoopLagMs);
  const hotBar = g.thresholds.enterAt.hot;
  const inPressure = s.filter((x) => compositePressure(x) >= hotBar).length / s.length;

  return {
    sampleCount: s.length,
    windowMs: s[s.length - 1].at - s[0].at,
    frameLoadAvg, frameLoadPeak,
    lagAvgMs, lagPeakMs,
    heapAvg: avg((x) => x.heapPressure),
    heapPeak: peak((x) => x.heapPressure),
    timeInPressure: Math.round(inPressure * 1000) / 1000,
    level: g.level,
    // A peak 2.5x the average is the signature of jank that averaging hides.
    spiky: frameLoadPeak > Math.max(0.25, frameLoadAvg * 2.5) || lagPeakMs > Math.max(50, lagAvgMs * 2.5),
  };
}

// ══ RG-06: low-memory mode ═══════════════════════════════════════════════

export interface MemoryPolicy {
  enabled: boolean;
  imageCacheEntries: number;
  maxDecodedImagePx: number;
  thumbnailSizePx: number;
  /** Features that stop working *well*; they degrade, they do not break. */
  degraded: string[];
  /** Features that keep working normally. */
  unaffected: string[];
}

/**
 * Derive the memory policy from heap pressure. The degraded list is explicit
 * so the UI can warn before a photo edit feels slow rather than after.
 */
export function memoryPolicy(heapPressure: number, heapLimitMb: number): MemoryPolicy {
  if (!(heapPressure >= 0) || heapPressure > 1.01) throw new Error(`heapPressure must be 0..1, got ${heapPressure}`);
  if (!(heapLimitMb > 0)) throw new Error("heap limit must be positive");

  if (heapPressure >= 0.85 || heapLimitMb < 256) {
    return {
      enabled: true,
      imageCacheEntries: 8,
      maxDecodedImagePx: 4_000_000,
      thumbnailSizePx: 96,
      degraded: ["photo edits above 4 MP", "multi-page PDF preview", "large spreadsheet import", "video scrubbing", "background prefetch"],
      unaffected: ["notes", "calendar", "settings", "text search", "tabs already open"],
    };
  }
  if (heapPressure >= 0.65) {
    return {
      enabled: true,
      imageCacheEntries: 40,
      maxDecodedImagePx: 16_000_000,
      thumbnailSizePx: 160,
      degraded: ["photo edits above 16 MP", "large spreadsheet import", "background prefetch"],
      unaffected: ["notes", "calendar", "settings", "PDF preview", "text search"],
    };
  }
  return {
    enabled: false,
    imageCacheEntries: 400,
    maxDecodedImagePx: 64_000_000,
    thumbnailSizePx: 256,
    degraded: [],
    unaffected: ["everything"],
  };
}

export function describeGovernor(g: LoadGovernor): string {
  const p = Math.round(g.pressure * 100);
  return `${g.level} (pressure ${p}%, ${g.transitions.length} transition${g.transitions.length === 1 ? "" : "s"})`;
}
