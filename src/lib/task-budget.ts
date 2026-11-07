/**
 * TT145 (RG-02) — scheduling hints, applied as a budget rather than probed.
 *
 * TT136's `scheduler-hints.ts` answers *which* priority to use. It is a good module
 * and this one does not replace it: this one answers the question that comes next,
 * and the one that is actually hard — **how much work may one slice do before it
 * must yield**, and what happens when a slice overruns it.
 *
 * The model is a frame budget:
 *
 *   · a *slice* declares its priority and its expected cost;
 *   · the budget for a frame is 16.7 ms at 60 Hz, minus a reserve the app keeps for
 *     input and paint (the reserve is a parameter, not a magic number);
 *   · slices are admitted in priority order while the remaining budget covers them;
 *     the first slice that does not fit is *deferred*, and its deferral is reported
 *     with the number that caused it;
 *   · an *overrun* (a slice that took longer than it declared) is recorded and the
 *     next slice of the same kind gets the measured cost instead of the declared one,
 *     which is how a scheduler recovers from a bad estimate without being told.
 *
 * The engine never touches `scheduler` itself: it decides, and the caller runs. That
 * keeps the whole thing testable in Node, and it keeps the fallback (`setTimeout`)
 * a property of the caller where it belongs — a fallback that is hidden inside a
 * scheduler is a fallback nobody tests.
 */

export type Priority = "user-blocking" | "user-visible" | "background";
export const PRIORITY_ORDER: Priority[] = ["user-blocking", "user-visible", "background"];
export const FRAME_MS = 1000 / 60;
/** Reserve kept for input handling and paint in every frame. */
export const RESERVE_MS = 5;

export interface Slice {
  id: string;
  priority: Priority;
  /** Declared cost; the scheduler replaces this with a measured cost when it learns one. */
  expectedMs: number;
  /** True when a partial run is safe (the slice can be resumed next frame). */
  resumable: boolean;
}

/**
 * A slice that ran in this frame. `grantedMs` is less than its cost only for a
 * resumable slice that was cut short, and `partial` says so explicitly — the first
 * version of this API listed a partially-run slice in BOTH `admitted` and
 * `deferred`, which is incoherent: a caller cannot be told the same slice both ran
 * and did not run. The remainder is carried in `grantedMs` instead.
 */
export interface Granted { slice: Slice; grantedMs: number; partial: boolean }

export interface Admit {
  admitted: Granted[];
  /** Slices that did not run at all in this frame, each with the number that stopped it. */
  deferred: { slice: Slice; why: string }[];
  /** The frame's own accounting, in ms. */
  usedMs: number;
  budgetMs: number;
  sentence: string;
}

export interface Model {
  /** Measured cost per slice kind, learned from overruns. */
  measured: Map<string, number>;
  /** Number of overruns seen, by kind. */
  overruns: Map<string, number>;
}

export const emptyModel = (): Model => ({ measured: new Map(), overruns: new Map() });

/** Cost the scheduler will use: the worst of declared and measured, never the better of the two. */
export function costOf(m: Model, s: Slice): number {
  const measured = m.measured.get(s.id);
  return measured === undefined ? s.expectedMs : Math.max(s.expectedMs, measured);
}

/**
 * Admits slices for one frame. A non-resumable slice that does not fit is deferred
 * whole; a resumable one is admitted if *any* of its budget fits, because running a
 * third of the work now is still progress and the rest waits.
 */
export function admit(slices: readonly Slice[], m: Model, opts: { frameMs?: number; reserveMs?: number } = {}): Admit {
  const frameMs = opts.frameMs ?? FRAME_MS;
  const budgetMs = Math.max(0, frameMs - (opts.reserveMs ?? RESERVE_MS));
  const ordered = [...slices].sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
  const admitted: Granted[] = [];
  const deferred: { slice: Slice; why: string }[] = [];
  let used = 0;
  for (const s of ordered) {
    const cost = costOf(m, s);
    const left = budgetMs - used;
    if (cost <= left) { admitted.push({ slice: s, grantedMs: cost, partial: false }); used += cost; continue; }
    if (s.resumable && left > 0) { admitted.push({ slice: s, grantedMs: left, partial: true }); used = budgetMs; continue; }
    deferred.push({ slice: s, why: `${cost.toFixed(1)} ms does not fit in the ${left.toFixed(1)} ms left${m.measured.has(s.id) ? " (measured, not declared)" : ""}${s.resumable ? "; the frame is already full" : " and it cannot be resumed mid-way"}` });
  }
  return {
    admitted, deferred, usedMs: used, budgetMs,
    sentence: admitted.length
      ? `${admitted.length} of ${slices.length} slices in ${used.toFixed(1)} of ${budgetMs} ms${deferred.length ? `; ${deferred.length} deferred` : ""}`
      : `nothing admitted: the first slice needs ${costOf(m, ordered[0]).toFixed(1)} ms of a ${budgetMs} ms budget`,
  };
}

/**
 * Records what a slice actually cost. An overrun is the only thing that teaches the
 * model, and it is recorded per slice id — a slice that overruns once is not
 * demoted forever, but it is not trusted at its declared cost again either.
 */
export function observe(m: Model, s: Slice, actualMs: number): { model: Model; overrun: boolean; sentence: string } {
  if (!(actualMs >= 0)) throw new Error("a slice cannot cost negative time");
  const measured = new Map(m.measured), overruns = new Map(m.overruns);
  const prev = measured.get(s.id) ?? s.expectedMs;
  // An exponential average, weighted towards the newer sample so a one-off stall
  // does not permanently inflate the estimate.
  measured.set(s.id, prev * 0.3 + actualMs * 0.7);
  const overrun = actualMs > s.expectedMs;
  if (overrun) overruns.set(s.id, (overruns.get(s.id) ?? 0) + 1);
  return {
    model: { measured, overruns }, overrun,
    sentence: overrun
      ? `${s.id} took ${actualMs.toFixed(1)} ms against a declared ${s.expectedMs.toFixed(1)} ms; the next admission uses the measured cost`
      : `${s.id} took ${actualMs.toFixed(1)} ms, inside its ${s.expectedMs.toFixed(1)} ms estimate`,
  };
}

/**
 * Whether to yield *right now*, given how long the current slice has run and whether
 * the platform can tell us input is pending. The priority inversion this prevents: a
 * background index that hogs the main thread makes a keystroke feel lost, and the
 * `isInputPending` hint (where it exists) is the only way to know before the next
 * frame. Where it does not exist the answer is "yield at the frame boundary",
 * labelled as a downgrade.
 */
export function shouldYield(input: { elapsedMs: number; budgetMs: number; priority: Priority; inputPending: boolean | null }): { yield: boolean; why: string } {
  if (input.inputPending === true && input.priority !== "user-blocking") return { yield: true, why: "isInputPending reported input: the slice yields so the keystroke is not queued behind it" };
  if (input.elapsedMs >= input.budgetMs) return { yield: true, why: `${input.elapsedMs.toFixed(1)} ms reached the ${input.budgetMs} ms slice budget` };
  if (input.inputPending === null) return { yield: false, why: `no isInputPending in this browser; yielding at the ${input.budgetMs} ms boundary only, which is a downgrade, not parity` };
  return { yield: false, why: `${input.elapsedMs.toFixed(1)} of ${input.budgetMs} ms used, no input pending` };
}

/**
 * The split for a long loop that must not block: how many iterations may run before
 * a yield, from a measured per-iteration cost. Always at least one, because a slice
 * that admits zero iterations never finishes.
 */
export function iterationsPerSlice(perIterationMs: number, budgetMs: number): number {
  if (!(perIterationMs > 0)) return 1000;
  return Math.max(1, Math.floor(budgetMs / perIterationMs));
}

export const LIMITS = [
  "this engine decides; the caller runs. The fallback timer is the caller's, so it is visible and testable",
  "isInputPending is a hint that exists on some engines only; without it a slice yields at the frame boundary",
  "a slice's cost is an estimate until it has been measured once",
  "the frame budget is 60 Hz; a 120 Hz display gets the same budget, deliberately, because the reserve exists for input, not for refresh",
] as const;
