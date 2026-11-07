/**
 * TT147 (WM-16) — cursor confinement to the active display.
 *
 * What a web page can actually do here is narrow, and saying so is most of the
 * feature:
 *
 *   • Pointer Lock confines the *cursor* to one element in one document and
 *     reports unbounded relative movement. That is enough for a game or a
 *     drawing surface. It is not multi-display confinement: the browser has no
 *     way to know how many displays exist (Window Management and Multi-Screen
 *     Window Placement are behind flags and permissions), let alone which one
 *     holds the window.
 *   • `unadjustedMovement` asks the OS for raw input. Chromium grants it on
 *     some platforms and rejects the request with `NotSupportedError` on others,
 *     so it must be requested as an option and the failure handled — not assumed.
 *   • Exit is asynchronous: `pointerlockchange` may arrive after the caller has
 *     moved on, so the state machine records a pending request rather than
 *     believing it succeeded.
 *
 * This module is the state machine and the plan; the DOM calls live in the
 * component that owns the element.
 */

export type ConfineAction = "lock" | "unlock" | "wait" | "refuse";

export interface ConfinementPlan {
  action: ConfineAction;
  /** Options to pass to `requestPointerLock`. */
  options: { unadjustedMovement?: boolean } | null;
  reason: string;
}

export interface ConfinementState {
  /** A request was made and its outcome has not arrived. */
  pending: boolean;
  locked: boolean;
  /** The browser refused raw input, so the lock (if any) is adjusted. */
  rawRefused: boolean;
}

export const initialConfinement: ConfinementState = { pending: false, locked: false, rawRefused: false };

/**
 * What to do next.
 *
 * The order of the checks matters: a pending request blocks a second one
 * (Chromium ignores a re-entrant request and the caller would believe it had
 * failed), and the absence of the API is a refusal with a reason rather than an
 * exception thrown into a render.
 */
export function planConfinement(
  state: ConfinementState,
  opts: { apiAvailable: boolean; userGesture: boolean; wantLocked: boolean },
): ConfinementPlan {
  if (!opts.apiAvailable) {
    return { action: "refuse", options: null, reason: "this browser has no Pointer Lock; the cursor cannot be confined" };
  }
  if (state.pending) {
    return { action: "wait", options: null, reason: "a lock request is still unanswered" };
  }
  if (opts.wantLocked) {
    if (state.locked) return { action: "unlock", options: null, reason: "releasing the cursor" };
    if (!opts.userGesture) {
      return { action: "refuse", options: null, reason: "the browser only locks the pointer from a real click or key press" };
    }
    // Ask for raw input unless the browser already told us it will not give it.
    return {
      action: "lock",
      options: state.rawRefused ? {} : { unadjustedMovement: true },
      reason: state.rawRefused
        ? "locking with adjusted movement — this engine refused raw input earlier"
        : "locking and asking for raw input",
    };
  }
  return state.locked
    ? { action: "unlock", options: null, reason: "the caller no longer wants confinement" }
    : { action: "wait", options: null, reason: "not confined, and nobody asked for it" };
}

/** Fold an outcome into the state. A refusal of raw input still leaves a lock. */
export function applyOutcome(
  state: ConfinementState,
  outcome: { kind: "locked" | "rejected" | "unlocked"; error?: string },
): { state: ConfinementState; note: string } {
  if (outcome.kind === "unlocked") {
    return { state: { ...state, pending: false, locked: false }, note: "the pointer is free" };
  }
  if (outcome.kind === "rejected") {
    const raw = /notsupported|unadjusted/i.test(outcome.error ?? "");
    return {
      state: { ...state, pending: false, locked: false, rawRefused: state.rawRefused || raw },
      note: raw
        ? "this engine refused raw input; the next attempt will ask for adjusted movement"
        : `the lock was refused: ${outcome.error ?? "no reason given"}`,
    };
  }
  return { state: { ...state, pending: false, locked: true }, note: "the cursor is confined to this element" };
}

/**
 * The honest summary for a settings row.
 *
 * `displays` is passed in by the caller because the page can only count what
 * `screen.isExtended` and `getScreenDetails` tell it — and both are optional.
 * When the count is unknown the sentence says so instead of claiming one screen.
 */
export function describeConfinement(state: ConfinementState, displays: number | null): string {
  const where = displays === null
    ? "this browser does not report the display layout"
    : displays === 1 ? "one display is reported" : `${displays} displays are reported`;
  if (state.locked) return `confined to this window (${where}); the cursor cannot leave it while locked`;
  if (state.pending) return `waiting for the browser to answer a lock request (${where})`;
  return `the cursor is free (${where}); a lock covers this window only, never a chosen display`;
}
