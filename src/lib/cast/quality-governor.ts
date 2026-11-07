/**
 * TT139 (CA-13) — Quality governor for screen share and casting.
 *
 * The browser gives you an `RTCStatsReport` and two knobs
 * (`scaleResolutionDownBy`, `maxBitrate`). Everything between those is policy,
 * and getting it wrong is why screen shares look either mushy or frozen:
 *
 *   • A single bad sample must not drop the bitrate. Stats arrive every 2 s and
 *     one hiccup would halve quality for the next two seconds.
 *   • A *sustained* problem must drop it. Without hysteresis the ladder
 *     oscillates: drop → recover → drop, which looks worse than a stable low rung.
 *   • `scaleResolutionDownBy` is a divisor of the *source* height, not a target
 *     height. Setting it to `sourceHeight / 720` is correct; setting it to 720
 *     is a catastrophic mistake that people make.
 *   • Bitrate headroom matters: `availableOutgoingBitrate` is an estimate, so
 *     using 100% of it guarantees queueing. 85% is the floor of safety.
 *   • Screen content is mostly still. A frame-rate of 60 is wasted when the
 *     content changes at 5 fps, and dropping it buys bitrate for detail.
 *
 * This module is pure: samples in, decisions out. No RTCPeerConnection, no
 * timers, no Date.now(). The caller polls and applies.
 */

/** Rungs from best to worst. Height is the target encode height. */
export interface Rung {
  name: string;
  height: number;
  maxFps: number;
  /** Bitrate ceiling for this rung, bits per second. */
  maxBitrate: number;
}

export const LADDER: Rung[] = [
  { name: "1080p60", height: 1080, maxFps: 60, maxBitrate: 6_000_000 },
  { name: "1080p30", height: 1080, maxFps: 30, maxBitrate: 4_000_000 },
  { name: "720p30", height: 720, maxFps: 30, maxBitrate: 2_500_000 },
  { name: "720p15", height: 720, maxFps: 15, maxBitrate: 1_500_000 },
  { name: "480p15", height: 480, maxFps: 15, maxBitrate: 800_000 },
  { name: "360p10", height: 360, maxFps: 10, maxBitrate: 400_000 },
];

/** Sample the caller extracts from an RTCStatsReport plus what it knows. */
export interface QualitySample {
  /** Fraction of frames the encoder dropped since the last sample, 0..1. */
  dropRate: number;
  /** Measured round-trip time, milliseconds. */
  rttMs: number;
  /** `availableOutgoingBitrate` from the candidate pair, bps. 0 = unknown. */
  availableBitrate: number;
  /** Encoded height actually produced, px. 0 = unknown. */
  encodedHeight: number;
  /** Frames per second actually produced. */
  fps: number;
  /** Fraction of frames that were new (content changed), 0..1. */
  contentChangeRate: number;
  /** Extra loss reported by the receiver, 0..1. */
  packetLossRate?: number;
}

export interface GovernorPolicy {
  /** Smoothed score must be at or above this to step down a rung (worse). */
  downAt: number;
  /** ... and at or below this to step up (better). */
  upAt: number;
  /** Consecutive samples needed before a move, so one spike cannot act. */
  dwell: number;
  /** Fraction of the measured bitrate the encoder may use. */
  headroom: number;
  /** Hardest the governor may ever go, from the shell's load policy. */
  maxHeight: number;
  /** Content this still is treated as a slideshow and given a low fps. */
  staticFpsBelow: number;
}

export const DEFAULT_POLICY: GovernorPolicy = {
  // 0.25 = "a quarter of the way to the worst possible sample". Stated in the
  // same units as qualityScore() so the two cannot drift apart.
  downAt: 0.25,
  upAt: 0.05,
  dwell: 2,
  headroom: 0.85,
  maxHeight: 1080,
  staticFpsBelow: 0.08,
};

export interface GovernorState {
  /**
   * Position in LADDER. NOTE THE DIRECTION: 0 is the BEST rung (1080p60) and
   * higher numbers are worse. This is the opposite of "quality", which is why
   * `rungQuality()` exists — asserting on the index directly is how a
   * step-down gets mistaken for a step-up.
   */
  rungIndex: number;
  /** EMA of the badness score, 0 (perfect) .. 1 (unusable). */
  smoothed: number;
  /** Samples in a row pointing the same way. */
  streak: number;
  streakDir: "up" | "down" | "none";
  samples: number;
  /** Moves made, for the report. */
  moves: number;
  lastReason: string;
}

/**
 * Badness, 0..1, where 0 is perfect and 1 is unusable. Weighted so no single
 * input can max it out on its own except a total stall:
 *   drops 45%, bandwidth 30%, latency 15%, loss 10%.
 * Bandwidth is scored against the current rung's need, not an absolute number,
 * because 2 Mbps is plenty for 480p and terrible for 1080p.
 */
export function qualityScore(s: QualitySample, rung: Rung): number {
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const drops = clamp01(s.dropRate / 0.10); // 10% dropped frames is unusable
  // Latency: 150 ms is fine for a screen share, 600 ms is a conversation killer.
  const latency = clamp01((s.rttMs - 150) / 450);
  const loss = clamp01((s.packetLossRate ?? 0) / 0.05);

  let bandwidth = 0;
  if (s.availableBitrate > 0) {
    const ratio = s.availableBitrate / rung.maxBitrate;
    // Below 1.0 there is not enough for this rung; below 0.5 it is hopeless.
    bandwidth = ratio >= 1 ? 0 : clamp01((1 - ratio) / 0.5);
  }
  // If the encoder is already producing less than the rung asked for, the link
  // is the limit even when `availableOutgoingBitrate` is missing or optimistic.
  if (s.encodedHeight > 0 && s.encodedHeight < rung.height * 0.8) {
    bandwidth = Math.max(bandwidth, 0.4);
  }

  return clamp01(0.45 * drops + 0.30 * bandwidth + 0.15 * latency + 0.10 * loss);
}

export interface Governor { state: GovernorState; policy: GovernorPolicy }

export function createGovernor(policy: Partial<GovernorPolicy> = {}): Governor {
  const p = { ...DEFAULT_POLICY, ...policy };
  if (!(p.headroom > 0 && p.headroom <= 1)) throw new Error("headroom must be in (0, 1]");
  if (p.upAt >= p.downAt) throw new Error("upAt must be below downAt, or the ladder oscillates on every sample");
  if (!Number.isInteger(p.dwell) || p.dwell < 1) throw new Error("dwell must be a positive integer");
  return {
    policy: p,
    state: {
      // The ladder starts one rung below the best: an opening burst of keyframes
      // on a cold connection looks like packet loss, and starting at 1080p60
      // makes the first two seconds of every share stutter.
      rungIndex: 1,
      smoothed: 0,
      streak: 0,
      streakDir: "none",
      samples: 0,
      moves: 0,
      lastReason: "initial: one rung below the best while the link warms up",
    },
  };
}

export function currentRung(g: Governor): Rung {
  return LADDER[g.state.rungIndex];
}

/**
 * Quality as a number that grows when things get BETTER: LADDER.length-1 at the
 * worst rung, 0 at the best. Use this for comparisons so the index direction
 * cannot be read backwards.
 */
export function rungQuality(g: Governor): number {
  return LADDER.length - 1 - g.state.rungIndex;
}
export const RUNG_QUALITY_MAX = LADDER.length - 1;

/** Rungs this device may use at all, given the shell's height cap. */
export function admissibleRungs(policy: GovernorPolicy): Rung[] {
  const out = LADDER.filter((r) => r.height <= policy.maxHeight);
  return out.length ? out : [LADDER[LADDER.length - 1]];
}

/**
 * Fold one sample in. Returns the new state and what to apply to the sender.
 * `application` is null when nothing should change — a caller that applies
 * every sample forces `setParameters` every two seconds for no reason.
 */
export function applySample(
  g: Governor,
  s: QualitySample,
  source: { width: number; height: number },
): {
  /** The whole governor, policy included — feeding the result back must work. */
  state: GovernorState;
  policy: GovernorPolicy;
  rung: Rung;
  application: { scaleResolutionDownBy: number; maxBitrate: number; maxFps: number } | null;
  reason: string;
} {
  const { policy } = g;
  const rung = currentRung(g);
  const score = qualityScore(s, rung);

  // EMA with a heavier weight on the new sample so a real collapse is acted on
  // quickly, but still enough inertia to ignore one frame of noise.
  const smoothed = g.state.samples === 0 ? score : g.state.smoothed * 0.55 + score * 0.45;

  // The streak is counted from the INSTANTANEOUS score, not the smoothed one.
  // Driving it from the EMA makes the governor react to its own memory: one
  // catastrophic sample left the average above the threshold for two more
  // samples, so the ladder stepped DOWN while every current sample was good.
  // Dwell means "this many samples in a row really looked like this".
  let streakDir: GovernorState["streakDir"] = g.state.streakDir;
  let streak = g.state.streak;
  if (score >= policy.downAt) {
    streakDir = "down";
    streak = g.state.streakDir === "down" ? g.state.streak + 1 : 1;
  } else if (score <= policy.upAt) {
    streakDir = "up";
    streak = g.state.streakDir === "up" ? g.state.streak + 1 : 1;
  } else {
    streakDir = "none";
    streak = 0;
  }

  const admissible = admissibleRungs(policy);
  const floorIndex = LADDER.length - admissible.length;
  const ceilingIndex = 0;
  let rungIndex = g.state.rungIndex;
  let reason = g.state.lastReason;
  let moved = false;

  // Static content: hold the detail, spend nothing on frames. This is the one
  // move that does not need dwell, because it is not a quality response — it
  // is an observation about the content.
  const isStatic = s.contentChangeRate < policy.staticFpsBelow && s.fps > 0;

  if (streak >= policy.dwell) {
    if (streakDir === "down" && rungIndex < LADDER.length - 1 && rungIndex < LADDER.length - 1) {
      // A bad sample can skip the ladder if this one is catastrophic.
      const skip = score > 0.75 ? 2 : 1;
      rungIndex = Math.min(LADDER.length - 1, Math.max(floorIndex === 0 ? 0 : floorIndex, rungIndex + skip));
      moved = true;
      reason = `step down ×${skip}: score ${score.toFixed(2)} over ${policy.downAt} for ${policy.dwell} samples`;
    } else if (streakDir === "up" && rungIndex > ceilingIndex) {
      rungIndex = Math.max(ceilingIndex, rungIndex - 1);
      // Never climb above what the shell allows.
      const minAllowed = Math.max(0, LADDER.findIndex((r) => r.height <= policy.maxHeight));
      rungIndex = Math.max(rungIndex, minAllowed);
      moved = true;
      reason = `step up: score ${score.toFixed(2)} under ${policy.upAt} for ${policy.dwell} samples`;
    }
    streak = 0;
    streakDir = "none";
  }

  const newRung = LADDER[rungIndex];

  // Bandwidth ceiling: measured availability with headroom, never above the rung.
  let maxBitrate = newRung.maxBitrate;
  if (s.availableBitrate > 0) {
    maxBitrate = Math.min(maxBitrate, Math.max(120_000, Math.round(s.availableBitrate * policy.headroom)));
  }
  // Hysteresis on the applied bitrate too: only re-apply if it changed by >10%,
  // otherwise every sample rewrites the sender for a rounding difference.
  const prevApplied = g.state.samples === 0 ? 0 : newRung.maxBitrate;
  const bitrateChanged = Math.abs(maxBitrate - prevApplied) / Math.max(1, prevApplied) > 0.10;

  const maxFps = isStatic ? Math.min(newRung.maxFps, 5) : newRung.maxFps;
  const scaleResolutionDownBy = Math.max(1, source.height / Math.min(newRung.height, policy.maxHeight));

  const application = moved || bitrateChanged || isStatic
    ? { scaleResolutionDownBy: Number(scaleResolutionDownBy.toFixed(4)), maxBitrate, maxFps }
    : null;

  return {
    policy,
    state: {
      rungIndex,
      smoothed,
      streak,
      streakDir,
      samples: g.state.samples + 1,
      moves: g.state.moves + (moved ? 1 : 0),
      lastReason: isStatic ? "static content: frame rate cut, bitrate reserved for detail" : reason,
    },
    rung: newRung,
    application,
    reason: isStatic ? "static content: frame rate cut, bitrate reserved for detail" : reason,
  };
}

/** The text a HUD shows. Deliberately short: three numbers and a cause. */
export function governorHud(g: Governor, s?: QualitySample): string {
  const r = currentRung(g);
  const head = `${r.name} · ${Math.round((1 - g.state.smoothed) * 100)}%`;
  if (!s) return head;
  return `${head} · ${Math.round(s.rttMs)} ms · ${s.dropRate > 0.02 ? `${Math.round(s.dropRate * 100)}% dropped` : "no drops"}`;
}

/** What limits quality, in the order a person would check. */
export function limitingFactor(s: QualitySample, rung: Rung): string {
  if (s.availableBitrate > 0 && s.availableBitrate < rung.maxBitrate) return "bandwidth";
  if (s.dropRate > 0.03) return "encoder drops";
  if (s.rttMs > 300) return "latency";
  if ((s.packetLossRate ?? 0) > 0.01) return "packet loss";
  if (s.encodedHeight > 0 && s.encodedHeight < rung.height * 0.8) return "resolution";
  return "nothing measurable";
}

/** Full report for the Share panel's detail drawer. */
export interface GovernorReport {
  rung: Rung;
  score: number;
  moves: number;
  samples: number;
  limiting: string;
  policy: GovernorPolicy;
  /** Every rung and whether the current link could carry it. */
  ladder: Array<{ rung: Rung; viable: boolean }>;
}

export function governorReport(g: Governor, s: QualitySample): GovernorReport {
  const rung = currentRung(g);
  return {
    rung,
    score: g.state.smoothed,
    moves: g.state.moves,
    samples: g.state.samples,
    limiting: limitingFactor(s, rung),
    policy: g.policy,
    ladder: LADDER.map((r) => ({
      rung: r,
      // Viable means: enough measured bandwidth for this rung and within the cap.
      viable: (s.availableBitrate === 0 || s.availableBitrate >= r.maxBitrate) && r.height <= g.policy.maxHeight,
    })),
  };
}
