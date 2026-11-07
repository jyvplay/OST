/**
 * TT139 (HW-11 second half) — keeping the screen awake, and letting go of it.
 *
 * `navigator.wakeLock.request("screen")` is a *request*: the browser releases the
 * lock whenever the page stops being visible, and the page must re-acquire on
 * `visibilitychange`. Two failure modes dominate real use:
 *
 *   1. a lock held after the presentation ended, draining the battery — the lock
 *      is therefore tied to a lease with a maximum age and renewed explicitly;
 *   2. a lock that silently did not happen (low battery mode, unsupported
 *      browser, denial) while the UI still says "screen kept awake".
 *
 * So this module returns an *observable* state, not a boolean hope: `granted`,
 * `denied` with a reason, `released`, or `expired`. The UI prints the state.
 *
 * Limits: no API can keep the screen on after the tab is hidden, and no API can
 * prevent a system-level sleep policy. Both are stated.
 */

export type WakeState = "idle" | "requesting" | "granted" | "denied" | "released" | "expired";

export interface WakeSession { state: WakeState; reason: string; acquiredAt: number | null; leaseMs: number; renewals: number }

export const MAX_LEASE_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;

export function beginWake(opts: { hasApi: boolean; secureContext: boolean; visible: boolean; batteryLow?: boolean; leaseMs?: number; now: number }): WakeSession {
  const leaseMs = Math.min(Math.max(60_000, opts.leaseMs ?? DEFAULT_LEASE_MS), MAX_LEASE_MS);
  if (!opts.hasApi) return { state: "denied", reason: "this browser has no Screen Wake Lock API", acquiredAt: null, leaseMs, renewals: 0 };
  if (!opts.secureContext) return { state: "denied", reason: "screen wake lock needs a secure context", acquiredAt: null, leaseMs, renewals: 0 };
  if (!opts.visible) return { state: "denied", reason: "the page is not visible, so the screen may sleep", acquiredAt: null, leaseMs, renewals: 0 };
  if (opts.batteryLow) return { state: "denied", reason: "the device reports a low battery; keeping the screen on is refused", acquiredAt: null, leaseMs, renewals: 0 };
  return { state: "granted", reason: "screen kept awake for this session", acquiredAt: opts.now, leaseMs, renewals: 0 };
}

/** Called on visibilitychange / lease tick. Returns the session to display. */
export function tickWake(session: WakeSession, opts: { visible: boolean; now: number; stillNeeded: boolean }): WakeSession & { action: "none" | "reacquire" | "release" } {
  if (session.state === "granted") {
    if (!opts.stillNeeded) return { ...session, state: "released", reason: "the presentation ended; the lock was released", action: "release" };
    if (!opts.visible) return { ...session, state: "released", reason: "the tab was hidden and the browser dropped the lock", action: "none" };
    if (session.acquiredAt !== null && opts.now - session.acquiredAt > session.leaseMs) return { ...session, state: "expired", reason: "the lease ran out; renew to keep the screen on", action: "none" };
    return { ...session, action: "none" };
  }
  if (opts.visible && opts.stillNeeded && (session.state === "released" || session.state === "expired")) return { ...session, state: "requesting", reason: "re-acquiring the lock", action: "reacquire" };
  return { ...session, action: "none" };
}

/** Short, truthful status text for a status strip. */
export function wakeSentence(session: WakeSession): string {
  switch (session.state) {
    case "granted": return `Screen stays on (${Math.round(session.leaseMs / 60000)} min lease)`;
    case "denied": return `Screen may sleep — ${session.reason}`;
    case "expired": return "Screen may sleep — the lease expired";
    case "released": return "Screen may sleep — nothing is holding a lock";
    case "requesting": return "Asking the browser to keep the screen on…";
    default: return "No wake lock requested";
  }
}

/** Which system sleep policies defeat this, stated as data so the UI can list them. */
export const WAKE_LIMITS = [
  "A closed lid or a manual sleep always wins.",
  "A hidden tab loses the lock; it is re-acquired when the tab is visible again.",
  "Low-power mode on some platforms refuses the request outright.",
  "Some browsers require a user gesture for the first request.",
];
