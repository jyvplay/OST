/**
 * TT136 (RG-02) — scheduling hints, actually applied.
 *
 * Before this module the app only *probed* `scheduler.postTask`,
 * `requestIdleCallback` and `isInputPending` and printed the answer. Here the
 * decision is a pure function so background daemons (ShellDaemons) can route
 * their work through the highest priority the browser really offers, split long
 * loops into slices, and yield before the next input event.
 *
 * Honest limits: `isInputPending` is a hint that only exists on some engines; a
 * browser without `scheduler.postTask` falls back to `setTimeout(0)`, which is
 * not the same guarantee and is labelled as a downgrade, not as parity.
 */

export type TaskPriority = "user-blocking" | "user-visible" | "background";
export type TaskKind = "input" | "paint" | "status" | "index" | "maintenance" | "probe";

export interface Capabilities {
  /** `typeof scheduler?.postTask === "function"` */
  postTask: boolean;
  /** `typeof requestIdleCallback === "function"` */
  idle: boolean;
  /** `typeof navigator?.scheduling?.isInputPending === "function"` */
  isInputPending: boolean;
}

export interface Plan {
  priority: TaskPriority;
  /** Use requestIdleCallback (with the given timeout) instead of an immediate task. */
  idle: boolean;
  idleTimeoutMs: number | null;
  /** Longest uninterrupted slice of work, in milliseconds. */
  sliceMs: number;
  /** Check for pending input after this much work inside a slice. */
  yieldCheckMs: number;
  /** True when the requested priority could not be expressed natively. */
  downgraded: boolean;
  reason: string;
}

export const SLICE_MIN = 4;
export const SLICE_MAX = 50;
export const SLICE_DEFAULT = 12;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Decide how to schedule one unit of work.
 * `visible` is the document visibility, used only to move non-input work to idle.
 */
export function planTask(kind: TaskKind, caps: Capabilities, visible: boolean): Plan {
  const base = { idle: false, idleTimeoutMs: null as number | null, sliceMs: SLICE_DEFAULT, yieldCheckMs: 4, downgraded: false };
  if (kind === "input" || kind === "paint") {
    return { ...base, priority: "user-blocking", sliceMs: SLICE_MIN, yieldCheckMs: 2, reason: "keeps the current frame responsive" };
  }
  if (kind === "status" || kind === "probe") {
    return caps.postTask
      ? { ...base, priority: "user-visible", sliceMs: 8, reason: "state shown in the shell" }
      : { ...base, priority: "user-visible", downgraded: true, sliceMs: 8, reason: "postTask unavailable; same-origin task queue" };
  }
  // index / maintenance: background work that must not compete with input.
  const idle = caps.idle && !visible;
  const sliceMs = clamp(Math.round(SLICE_DEFAULT * (visible ? 1 : 2)), SLICE_MIN, SLICE_MAX);
  if (!visible && caps.postTask) return { ...base, priority: "background", idle, idleTimeoutMs: idle ? 2_000 : null, sliceMs, reason: "hidden document, background priority" };
  if (!visible) return { ...base, priority: "background", idle, idleTimeoutMs: idle ? 2_000 : null, sliceMs, downgraded: !caps.postTask, reason: "hidden document, idle callback" };
  return { ...base, priority: "background", idle: false, sliceMs, downgraded: !caps.postTask, reason: "visible document, background priority" };
}

/** Split `units` of work into time-boxed chunks; always at least one chunk. */
export function chunks(units: number, sliceMs: number, costPerUnitMs: number): { from: number; to: number }[] {
  if (!Number.isInteger(units) || units < 0 || units > 1_000_000) throw new Error("units must be an integer 0…1,000,000");
  if (!(sliceMs >= SLICE_MIN && sliceMs <= SLICE_MAX)) throw new Error(`slice must be ${SLICE_MIN}…${SLICE_MAX} ms`);
  if (!(costPerUnitMs > 0 && costPerUnitMs <= 1_000)) throw new Error("cost per unit must be 0…1,000 ms");
  if (units === 0) return [];
  const per = Math.max(1, Math.round(sliceMs / costPerUnitMs));
  const out: { from: number; to: number }[] = [];
  for (let from = 0; from < units; from += per) out.push({ from, to: Math.min(units, from + per) });
  return out;
}

/**
 * Cooperative slice controller: elapsed time and pending input, not a timer.
 * `budgetMs` is the total work budget for one scheduling turn.
 */
export function shouldYield(elapsedMs: number, sliceMs: number, inputPending: boolean): boolean {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("elapsed must be finite and non-negative");
  if (!(sliceMs >= SLICE_MIN && sliceMs <= SLICE_MAX)) throw new Error(`slice must be ${SLICE_MIN}…${SLICE_MAX} ms`);
  return inputPending || elapsedMs >= sliceMs;
}

/** Priority ranking used only for reporting; never for ordering real browser tasks. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { "user-blocking": 0, "user-visible": 1, background: 2 };

/** A short, honest capability line for the Monitor pane. */
export function describeCapabilities(caps: Capabilities): string {
  const parts = [
    caps.postTask ? "postTask priorities" : "setTimeout fallback",
    caps.idle ? "idle callbacks" : "no idle callbacks",
    caps.isInputPending ? "input-pending checks" : "no input-pending checks",
  ];
  return parts.join(" · ");
}
