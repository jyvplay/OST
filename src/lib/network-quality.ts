/**
 * TT136 (HW-09) — network-aware media quality.
 *
 * Honest scope: this reasons over the Network Information API's *estimates*
 * (`effectiveType`, `downlink`, `rtt`, `saveData`). Those values are coarse,
 * self-reported by the browser, can be absent, and are never a measured
 * throughput. The module therefore (a) prefers the most pessimistic signal,
 * (b) treats "unknown" as an ordinary connection rather than as "fast",
 * (c) requires two consecutive agreeing samples before changing tier, and
 * (d) never upgrades straight from the lowest tier to the highest one.
 *
 * Pure: no Date.now(), no globals, no DOM. Callers pass `now` and the sample.
 */

export type QualityTier = "minimal" | "low" | "medium" | "high";

export interface NetworkSample {
  /** "slow-2g" | "2g" | "3g" | "4g" — any other value is ignored, not trusted. */
  effectiveType?: string;
  /** Megabits per second, per the API's own (bounded) estimate. */
  downlink?: number;
  /** Round-trip estimate in milliseconds. */
  rtt?: number;
  /** The user's data-saver preference. */
  saveData?: boolean;
}

export interface QualityPlan {
  tier: QualityTier;
  /** Longest video edge the plan will request; null means "no video". */
  maxHeight: 240 | 360 | 480 | 720 | 1080 | null;
  /** Declared bitrate ceiling in kbit/s; 0 means "audio only". */
  maxBitrateKbps: number;
  preload: "none" | "metadata" | "auto";
  autoplayMuted: boolean;
  /** True when a poster/placeholder is the only honest thing to render. */
  posterOnly: boolean;
  /** Stable machine-readable reasons, most significant first. */
  reasons: string[];
}

export const TIER_ORDER: readonly QualityTier[] = ["minimal", "low", "medium", "high"];

const PLANS: Record<QualityTier, Omit<QualityPlan, "tier" | "reasons">> = {
  minimal: { maxHeight: null, maxBitrateKbps: 64, preload: "none", autoplayMuted: true, posterOnly: true },
  low: { maxHeight: 360, maxBitrateKbps: 500, preload: "metadata", autoplayMuted: true, posterOnly: false },
  medium: { maxHeight: 720, maxBitrateKbps: 2_500, preload: "metadata", autoplayMuted: false, posterOnly: false },
  high: { maxHeight: 1080, maxBitrateKbps: 8_000, preload: "auto", autoplayMuted: false, posterOnly: false },
};

const KNOWN_TYPES = new Set(["slow-2g", "2g", "3g", "4g"]);

const finite = (n: unknown, lo: number, hi: number): number | null =>
  typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi ? n : null;

const rank = (t: QualityTier) => TIER_ORDER.indexOf(t);

/** Classify one sample. Out-of-range or unknown fields are ignored, never clamped silently into "fast". */
export function classifySample(sample: NetworkSample): QualityPlan {
  const reasons: string[] = [];
  const type = typeof sample.effectiveType === "string" && KNOWN_TYPES.has(sample.effectiveType) ? sample.effectiveType : null;
  const downlink = finite(sample.downlink, 0, 10_000);
  const rtt = finite(sample.rtt, 0, 60_000);

  // Evidence points towards a ceiling; the final tier is the *lowest* ceiling found.
  let ceiling: QualityTier = "high";
  const cap = (tier: QualityTier, reason: string) => {
    if (rank(tier) < rank(ceiling)) { ceiling = tier; }
    reasons.push(reason);
  };

  if (sample.saveData === true) cap("minimal", "data-saver is on");
  if (type === "slow-2g") cap("minimal", "effective type slow-2g");
  else if (type === "2g") cap("minimal", "effective type 2g");
  else if (type === "3g") cap("low", "effective type 3g");
  if (downlink !== null) {
    if (downlink < 0.3) cap("minimal", `downlink estimate ${downlink} Mb/s`);
    else if (downlink < 1) cap("low", `downlink estimate ${downlink} Mb/s`);
    else if (downlink < 3) cap("medium", `downlink estimate ${downlink} Mb/s`);
  }
  if (rtt !== null) {
    if (rtt > 1_200) cap("low", `round-trip estimate ${rtt} ms`);
    else if (rtt > 500) cap("medium", `round-trip estimate ${rtt} ms`);
  }
  if (type === null && downlink === null && rtt === null && sample.saveData !== true) reasons.push("no usable network signal; ordinary default");

  // A slow path is capped at "low" and may never advertise a poster-only screen unless it is minimal.
  return { tier: ceiling, ...PLANS[ceiling], reasons };
}

export interface QualityState { tier: QualityTier; streak: number; lastAt: number }

/**
 * Tier changes need two agreeing samples and at most one step per change, so a
 * single blip cannot drop a player to 240p (or promote it to 1080p) instantly.
 */
export function nextQuality(state: QualityState | null, candidate: QualityPlan, now: number): QualityState {
  if (!Number.isFinite(now) || now < 0) throw new Error("nextQuality needs a finite non-negative timestamp");
  if (!state) return { tier: candidate.tier, streak: 1, lastAt: now };
  if (candidate.tier === state.tier) return { tier: state.tier, streak: state.streak + 1, lastAt: now };
  const streak = state.streak + 1;
  // Two consecutive non-agreeing samples are required before moving, and the move is one step.
  if (streak < 2) return { tier: state.tier, streak, lastAt: now };
  const target = candidate.tier;
  const step = rank(target) > rank(state.tier) ? TIER_ORDER[rank(state.tier) + 1] : TIER_ORDER[rank(state.tier) - 1];
  return { tier: step, streak: 0, lastAt: now };
}

/** Plan for the tier currently held, with the reasons from the latest sample. */
export function planFor(tier: QualityTier, reasons: readonly string[] = []): QualityPlan {
  return { tier, ...PLANS[tier], reasons: [...reasons] };
}

/** Human-facing one-liner; deliberately says "estimate" because that is what it is. */
export function describePlan(plan: QualityPlan): string {
  const cap = plan.maxHeight === null ? "poster only" : `up to ${plan.maxHeight}p`;
  return `${plan.tier} (${cap}${plan.maxBitrateKbps ? `, ≤${plan.maxBitrateKbps} kbit/s` : ""}) — browser estimate, not a measurement`;
}

/**
 * Choose a source from a declared ladder. Sources must already be ordered; the
 * first source whose height fits the cap wins, otherwise the smallest one. The
 * caller still owns the element and its errors.
 */
export function pickSource<T extends { height: number; src: string }>(plan: QualityPlan, sources: readonly T[]): T | null {
  if (!sources.length) return null;
  if (plan.maxHeight === null) return null;
  const ordered = [...sources].sort((a, b) => a.height - b.height);
  return [...ordered].reverse().find((s) => s.height <= (plan.maxHeight as number)) ?? ordered[0];
}
