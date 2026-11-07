/**
 * TT146 (HW-09) — network-aware quality.
 *
 * The web exposes two very different quantities and most apps confuse them:
 *
 *   1. `navigator.connection` — an *estimate* the browser maintains. Chromium
 *      deliberately caps `downlink` at 10 Mbit/s and `rtt` at 4000 ms, and it
 *      derives `effectiveType` from those capped numbers, so a 1 Gbit/s fibre
 *      line and a good 5G phone both report `4g` / 10. Treating that as a
 *      measurement is the usual bug: the app then refuses to use bandwidth it
 *      actually has.
 *   2. A *measurement* this app makes itself: transfer N bytes and divide.
 *      That is real, but it is also instantaneous: one sample taken while the
 *      browser was opening six other connections is not the link's capacity.
 *
 * So this module keeps the two separate, states which one drove a decision, and
 * turns them into a small ladder of concrete numbers (thumbnail pixels, video
 * height, prefetch bytes, parallel transfers). Nothing here performs I/O: the
 * caller samples, this decides.
 *
 * Two rules make the ladder behave like a person expects:
 *   • Save-Data is a *user instruction*, not an estimate. When it is on, the
 *     ladder is capped at the lowest rung no matter what was measured.
 *   • Stepping *down* is immediate and stepping *up* needs evidence and dwell.
 *     The reverse (fast up, slow down) is what makes an interface flicker
 *     between 360p and 1080p every few seconds.
 */

export type EffectiveType = "slow-2g" | "2g" | "3g" | "4g" | "5g" | "unknown";

/** What the browser claims. Every field is nullable because the API is not universal. */
export interface NetworkFacts {
  online: boolean;
  effectiveType: EffectiveType;
  /** Browser estimate in Mbit/s (Chromium caps this at 10). */
  downlinkMbps: number | null;
  /** Browser estimate in ms (Chromium caps this at 4000). */
  rttMs: number | null;
  /** The user asked for less data. */
  saveData: boolean;
  /** Present only where `navigator.connection` exists at all. */
  reported: boolean;
}

export interface RawConnection {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Normalise the browser's own object. Never invents a value it did not report. */
export function readNetworkFacts(raw: RawConnection | null | undefined, online: boolean): NetworkFacts {
  if (!raw) return { online, effectiveType: "unknown", downlinkMbps: null, rttMs: null, saveData: false, reported: false };
  const t = raw.effectiveType;
  const effectiveType: EffectiveType =
    t === "slow-2g" || t === "2g" || t === "3g" || t === "4g" || t === "5g" ? t : "unknown";
  return {
    online,
    effectiveType,
    // A reported value outside the range the API can mean is not trusted.
    downlinkMbps: isFiniteNumber(raw.downlink) ? clamp(raw.downlink, 0, 100_000) : null,
    rttMs: isFiniteNumber(raw.rtt) ? clamp(raw.rtt, 0, 600_000) : null,
    saveData: raw.saveData === true,
    reported: true,
  };
}

/** Rank used for monotonicity: a faster reported link never ranks lower. */
export const EFFECTIVE_RANK: Record<EffectiveType, number> = {
  "slow-2g": 0, "2g": 1, "3g": 2, unknown: 3, "4g": 3, "5g": 4,
};

/* ------------------------------------------------------------------ measurement */

export interface TransferSample {
  bytes: number;
  ms: number;
}

export interface EstimatorOptions {
  /** EWMA weight for a new sample. */
  alpha?: number;
  /** Samples smaller than this are timer noise, not bandwidth. */
  minBytes?: number;
  /** Faster than this is a cache or a loopback; it says nothing about the link. */
  maxPlausibleMbps?: number;
  /** After this long without a sample the estimate is stale. */
  staleMs?: number;
}

export type Confidence = "none" | "low" | "medium" | "high";

export interface SampleVerdict {
  accepted: boolean;
  reason: string;
  /** Estimate after this sample, bits per second, or null when there is none. */
  bps: number | null;
}

/**
 * EWMA throughput estimate with explicit rejection rules.
 *
 * Why an EWMA and not the mean: a link that degrades halfway through a session
 * should be believed now, not averaged with a measurement from ten minutes ago.
 * Why reject small samples: a 4 KiB response measured across a 2 ms timer tick
 * yields 16 Mbit/s on a 3 Mbit/s link, and it will do that every time.
 */
export class ThroughputEstimator {
  private alpha: number;
  private minBytes: number;
  private maxBps: number;
  private staleMs: number;
  private value: number | null = null;
  private count = 0;
  private acceptedBytes = 0;
  private lastAt: number | null = null;

  constructor(opts: EstimatorOptions = {}) {
    this.alpha = clamp(opts.alpha ?? 0.4, 0.01, 1);
    this.minBytes = Math.max(1, opts.minBytes ?? 16 * 1024);
    this.maxBps = (opts.maxPlausibleMbps ?? 10_000) * 1e6;
    this.staleMs = Math.max(1, opts.staleMs ?? 60_000);
  }

  add(sample: TransferSample, at: number): SampleVerdict {
    const { bytes, ms } = sample;
    if (!isFiniteNumber(bytes) || !isFiniteNumber(ms) || bytes <= 0 || ms <= 0) {
      return { accepted: false, reason: "sample must have positive bytes and milliseconds", bps: this.value };
    }
    if (bytes < this.minBytes) {
      return { accepted: false, reason: `sample below the ${this.minBytes}-byte floor`, bps: this.value };
    }
    const raw = (bytes * 8_000) / ms;
    if (!Number.isFinite(raw) || raw > this.maxBps) {
      // A local cache hit or an in-memory fixture: measuring it would inflate every later decision.
      return { accepted: false, reason: "implausibly fast — treated as a cache hit, not link capacity", bps: this.value };
    }
    this.value = this.value === null ? raw : this.value + this.alpha * (raw - this.value);
    this.count += 1;
    this.acceptedBytes += bytes;
    this.lastAt = at;
    return { accepted: true, reason: "accepted", bps: this.value };
  }

  bps(now?: number): number | null {
    if (this.value === null) return null;
    if (now !== undefined && this.lastAt !== null && now - this.lastAt > this.staleMs) return null;
    return this.value;
  }

  get samples(): number { return this.count; }
  get bytes(): number { return this.acceptedBytes; }

  /** Confidence is about the evidence behind the number, never about the number itself. */
  confidence(now?: number): Confidence {
    if (this.value === null) return "none";
    if (now !== undefined && this.lastAt !== null && now - this.lastAt > this.staleMs) return "none";
    if (this.count >= 3 && this.acceptedBytes >= 1_000_000) return "high";
    if (this.count >= 2 || this.acceptedBytes >= 512_000) return "medium";
    return "low";
  }

  reset(): void {
    this.value = null; this.count = 0; this.acceptedBytes = 0; this.lastAt = null;
  }
}

/* ------------------------------------------------------------------ the ladder */

export type Surface = "photoThumb" | "photoPreview" | "video" | "prefetch" | "sync";
export type Tier = 0 | 1 | 2 | 3;
export const TIER_LABEL: Record<Tier, string> = { 0: "minimal", 1: "low", 2: "standard", 3: "high" };

/** Concrete numbers per rung. Deliberately whole values a test can assert on. */
export interface Rung {
  photoThumb: number;
  photoPreview: number;
  videoHeight: number;
  prefetchBytes: number;
  parallelTransfers: number;
}

export const RUNGS: readonly Rung[] = [
  { photoThumb: 96, photoPreview: 640, videoHeight: 360, prefetchBytes: 0, parallelTransfers: 1 },
  { photoThumb: 160, photoPreview: 1024, videoHeight: 480, prefetchBytes: 256 * 1024, parallelTransfers: 1 },
  { photoThumb: 256, photoPreview: 1600, videoHeight: 720, prefetchBytes: 1024 * 1024, parallelTransfers: 2 },
  { photoThumb: 384, photoPreview: 2048, videoHeight: 1080, prefetchBytes: 4 * 1024 * 1024, parallelTransfers: 4 },
] as const;

export type Source = "save-data" | "offline" | "measured" | "browser estimate" | "assumed";

export interface QualityDecision {
  tier: Tier;
  label: string;
  source: Source;
  /** The numbers for this surface at this rung. */
  value: number;
  /** Everything the surface would use at this rung (for a settings read-out). */
  rung: Rung;
  reason: string;
  /** True when the decision is a deliberate downgrade rather than a measurement. */
  cappedByUser: boolean;
}

export interface PlanOptions {
  /** A ceiling the user or the governor set. 3 = no ceiling. */
  maxTier?: Tier;
  /** Confidence needed before the measurement may override the browser estimate. */
  trustMeasurement?: Confidence;
}

const RANK_TO_TIER: Record<number, Tier> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 3 };

/** Measured bits per second → rung. Bands are decimal, not binary, like link rates. */
export function tierForBps(bps: number): Tier {
  if (!isFiniteNumber(bps) || bps <= 0) return 0;
  if (bps < 150_000) return 0;      // below ~150 kbit/s
  if (bps < 1_000_000) return 1;    // up to 1 Mbit/s
  if (bps < 5_000_000) return 2;    // up to 5 Mbit/s
  return 3;
}

export function tierForFacts(f: NetworkFacts): Tier {
  return RANK_TO_TIER[EFFECTIVE_RANK[f.effectiveType]] ?? 2;
}

const SURFACE_VALUE: Record<Surface, (r: Rung) => number> = {
  photoThumb: (r) => r.photoThumb,
  photoPreview: (r) => r.photoPreview,
  video: (r) => r.videoHeight,
  prefetch: (r) => r.prefetchBytes,
  sync: (r) => r.parallelTransfers,
};

/**
 * Decide the rung for one surface.
 *
 * Order of authority, strongest first: offline → Save-Data → measurement (if it
 * is trusted) → browser estimate → an assumed middle rung when the API is
 * missing. The result names which one won.
 */
export function planQuality(
  facts: NetworkFacts,
  measuredBps: number | null,
  confidence: Confidence,
  surface: Surface,
  opts: PlanOptions = {},
): QualityDecision {
  const ceiling = (opts.maxTier ?? 3) as Tier;
  const trust = opts.trustMeasurement ?? "medium";
  const trustRank: Record<Confidence, number> = { none: 0, low: 1, medium: 2, high: 3 };

  const finish = (tier: Tier, source: Source, reason: string, cappedByUser: boolean): QualityDecision => {
    const t = Math.min(tier, ceiling) as Tier;
    const rung = RUNGS[t];
    return {
      tier: t, label: TIER_LABEL[t], source, value: SURFACE_VALUE[surface](rung), rung,
      reason: t !== tier ? `${reason}; capped at ${TIER_LABEL[t]} by the quality ceiling` : reason,
      cappedByUser: cappedByUser || t !== tier,
    };
  };

  if (!facts.online) return finish(0, "offline", "no connection — nothing is requested", true);
  if (facts.saveData) return finish(0, "save-data", "Save-Data is on — the lowest rung is used regardless of speed", true);

  if (measuredBps !== null && trustRank[confidence] >= trustRank[trust]) {
    return finish(tierForBps(measuredBps), "measured",
      `${(measuredBps / 1e6).toFixed(2)} Mbit/s measured (${confidence} confidence)`, false);
  }
  if (facts.reported) {
    const t = tierForFacts(facts);
    const why = facts.effectiveType === "unknown"
      ? "the browser did not classify the connection, so the middle rung is used"
      : `browser reports ${facts.effectiveType}${facts.downlinkMbps !== null ? ` · ${facts.downlinkMbps} Mbit/s (capped estimate)` : ""}`;
    return finish(t, "browser estimate", why, false);
  }
  return finish(2, "assumed", "no network API in this browser — the standard rung is used", false);
}

/** One line a settings pane can print without turning into a paragraph. */
export function describeDecision(d: QualityDecision, surface: Surface): string {
  const unit = surface === "photoThumb" || surface === "photoPreview" ? " px"
    : surface === "video" ? "p"
    : surface === "prefetch" ? " B" : "";
  return `${d.label} (${d.value}${unit}) — ${d.reason}`;
}

/**
 * Asymmetric hysteresis.
 *
 * Down moves take effect on the first sample that asks for them: reacting slowly
 * to a dying link is how a player freezes. Up moves need `upAfter` consecutive
 * suggestions plus `minDwellMs` since the last move, so a briefly idle moment
 * cannot promote a 360p stream into a 1080p one that immediately stalls.
 */
export class TierStabilizer {
  private tier: Tier;
  private pending: Tier | null = null;
  private pendingCount = 0;
  private lastMoveAt: number | null = null;

  private opts: { upAfter?: number; minDwellMs?: number };

  constructor(initial: Tier = 2, opts: { upAfter?: number; minDwellMs?: number } = {}) {
    this.tier = initial;
    this.opts = opts;
  }

  get current(): Tier { return this.tier; }

  update(suggested: Tier, at: number): { tier: Tier; moved: boolean; reason: string } {
    const upAfter = Math.max(1, this.opts.upAfter ?? 3);
    const minDwell = Math.max(0, this.opts.minDwellMs ?? 5_000);
    if (suggested === this.tier) {
      this.pending = null; this.pendingCount = 0;
      return { tier: this.tier, moved: false, reason: "unchanged" };
    }
    if (suggested < this.tier) {
      this.tier = suggested; this.pending = null; this.pendingCount = 0; this.lastMoveAt = at;
      return { tier: this.tier, moved: true, reason: `stepped down to ${TIER_LABEL[suggested]} immediately` };
    }
    // Upward: evidence must accumulate, and a recent move blocks it.
    if (this.lastMoveAt !== null && at - this.lastMoveAt < minDwell) {
      return { tier: this.tier, moved: false, reason: `holding ${TIER_LABEL[this.tier]} for ${minDwell} ms after the last change` };
    }
    this.pendingCount = this.pending === suggested ? this.pendingCount + 1 : 1;
    this.pending = suggested;
    if (this.pendingCount < upAfter) {
      return { tier: this.tier, moved: false, reason: `upgrade needs ${upAfter} consistent samples (${this.pendingCount} so far)` };
    }
    this.tier = suggested; this.pending = null; this.pendingCount = 0; this.lastMoveAt = at;
    return { tier: this.tier, moved: true, reason: `stepped up to ${TIER_LABEL[suggested]} after ${upAfter} samples` };
  }
}
