/**
 * TT140 (SC-06) — Screen-capture exclusion for sensitive windows.
 *
 * THE HONEST FACT FIRST: the web platform has no FLAG_SECURE. A page cannot
 * mark itself "do not capture". Anything that claims otherwise is either using
 * a native shell (we are not), or is wrong. So this module implements what is
 * actually available, and states the gap in the same breath as the feature:
 *
 *   1. DETECT. `getDisplayMedia` returns a track whose `getSettings().displaySurface`
 *      and `contentHint` say something about what is being shared, and the
 *      track's `onended` fires when capture stops from the sharing side. We can
 *      also detect that OUR window is being captured when a share we started
 *      includes a surface whose aspect matches a screen, but we cannot detect a
 *      *different application* capturing us at all.
 *   2. REACT. When a capture is detected while a sensitive window is open, the
 *      vault auto-locks and the window blanks. This is mitigation: the frames
 *      already sent are gone.
 *   3. ORDER THE SURFACES. When we are the ones capturing, windows marked
 *      `private` are excluded from the composited surface by not drawing them,
 *      which IS reliable — it is our own canvas.
 *
 * What is guaranteed and what is not, in the language the UI must use:
 *   GUARANTEED  our own outgoing capture never includes a private window
 *   GUARANTEED  a sensitive window locks when a capture session we know about
 *               starts or stops
 *   NOT         that another app's screen recorder cannot see this window
 *   NOT         that frames already transmitted can be recalled
 *   NOT         that a hardware capture card in the display chain is detectable
 *
 * The type system makes the second column impossible to express as a promise:
 * `protectionFor` returns a `CaptureProtection` whose `prevents` list is closed
 * and contains only what is enforced.
 */

export type WindowSensitivity = "public" | "private" | "secret";

/** What a sensitivity level actually gets, per the lists below. */
export interface CaptureProtection {
  level: WindowSensitivity;
  /** Excluded from captures WE make. Enforced by the compositor. */
  excludedFromOurCapture: boolean;
  /** Locks when a capture starts. Enforced by the vault state machine. */
  locksOnCapture: boolean;
  /** Blanks its rendered content while any capture is active. */
  blanksWhileCaptured: boolean;
  /** What this does NOT protect against. Never empty for private or secret. */
  doesNotProtectAgainst: string[];
  /** Text the UI can show verbatim. */
  statement: string;
}

const NOT_PROTECTED_COMMON = [
  "Another application's screen recorder, camera pointed at the display, or a capture card",
  "Frames already transmitted before the capture was detected",
  "A browser extension with page access while the window is unlocked",
];

export function protectionFor(level: WindowSensitivity): CaptureProtection {
  if (level === "public") {
    return {
      level,
      excludedFromOurCapture: false,
      locksOnCapture: false,
      blanksWhileCaptured: false,
      doesNotProtectAgainst: [],
      statement: "Public window: it is included in your own screen shares, like any other window.",
    };
  }
  if (level === "private") {
    return {
      level,
      excludedFromOurCapture: true,
      locksOnCapture: true,
      blanksWhileCaptured: false,
      doesNotProtectAgainst: NOT_PROTECTED_COMMON,
      statement:
        "Private window: excluded from screen shares you start here, and it locks when a capture starts. " +
        "It is NOT hidden from a recorder outside this app — the web platform has no way to mark a window uncapturable.",
    };
  }
  return {
    level,
    excludedFromOurCapture: true,
    locksOnCapture: true,
    blanksWhileCaptured: true,
    doesNotProtectAgainst: [...NOT_PROTECTED_COMMON, "Timing side channels: the window's existence and title are still observable in this app"],
    statement:
      "Secret window: excluded from your captures, locks, and blanks its content while any capture session is active. " +
      "This is the strongest the web platform allows and it is still mitigation, not prevention.",
  };
}

/** A capture session as this app knows about it. */
export interface CaptureSession {
  id: string;
  /** Who started it: this app, or a track we were handed. */
  source: "self" | "incoming-track";
  /** What the surface reports being shared. */
  surface: "monitor" | "window" | "browser" | "unknown";
  /** Whether the track is still live. */
  live: boolean;
  startedAt: number;
}

export interface CaptureWatch {
  sessions: Map<string, CaptureSession>;
  /** Sequence for ids, so a caller does not have to invent one. */
  nextId: number;
}

export function createCaptureWatch(): CaptureWatch {
  return { sessions: new Map(), nextId: 1 };
}

export function beginCapture(
  w: CaptureWatch,
  opts: { source: CaptureSession["source"]; surface: CaptureSession["surface"]; startedAt?: number },
): { watch: CaptureWatch; session: CaptureSession } {
  const id = `cap-${w.nextId}`;
  const session: CaptureSession = {
    id,
    source: opts.source,
    surface: opts.surface,
    live: true,
    startedAt: opts.startedAt ?? 0,
  };
  const sessions = new Map(w.sessions);
  sessions.set(id, session);
  return { watch: { sessions, nextId: w.nextId + 1 }, session };
}

export function endCapture(w: CaptureWatch, id: string): CaptureWatch {
  const existing = w.sessions.get(id);
  if (!existing) return w;
  const sessions = new Map(w.sessions);
  sessions.set(id, { ...existing, live: false });
  return { ...w, sessions };
}

export function anyLiveCapture(w: CaptureWatch): CaptureSession | null {
  for (const s of w.sessions.values()) if (s.live) return s;
  return null;
}

/** Every window that must react to the current state. */
export function windowsToLock(w: CaptureWatch, windows: Array<{ id: string; sensitivity: WindowSensitivity }>): string[] {
  if (!anyLiveCapture(w)) return [];
  return windows.filter((x) => protectionFor(x.sensitivity).locksOnCapture).map((x) => x.id);
}

/** Every window that must blank while a capture is live. */
export function windowsToBlank(w: CaptureWatch, windows: Array<{ id: string; sensitivity: WindowSensitivity }>): string[] {
  if (!anyLiveCapture(w)) return [];
  return windows.filter((x) => protectionFor(x.sensitivity).blanksWhileCaptured).map((x) => x.id);
}

/**
 * Is it safe to draw this window into our outgoing composited capture?
 * This is the one guarantee that is a real guarantee, because the compositor is
 * ours. It returns false for private and secret regardless of session state —
 * a private window must never appear in any capture we produce.
 */
export function mayAppearInCapture(level: WindowSensitivity): boolean {
  return protectionFor(level).excludedFromOurCapture === false;
}

/**
 * The list to draw, given everything open. Callers composite exactly this.
 * Kept separate from `mayAppearInCapture` so the compositor cannot re-derive
 * the rule differently in two places.
 */
export function captureSources(windows: Array<{ id: string; sensitivity: WindowSensitivity }>): string[] {
  return windows.filter((x) => mayAppearInCapture(x.sensitivity)).map((x) => x.id);
}

/**
 * Parse what a `MediaStreamTrack` tells us. Every field is optional because no
 * engine implements all of them, and a missing field is UNKNOWN, not "safe".
 */
export function readTrackSettings(settings: {
  displaySurface?: string;
  contentHint?: string;
  width?: number;
  height?: number;
}): { surface: CaptureSession["surface"]; confident: boolean; note: string } {
  const s = settings.displaySurface;
  if (s === "monitor" || s === "window" || s === "browser") {
    return { surface: s, confident: true, note: `Track reports a ${s} surface` };
  }
  return {
    surface: "unknown",
    confident: false,
    note: "The track did not report displaySurface; treat the surface as unknown rather than assuming it is safe.",
  };
}

/**
 * The sentence the privacy dashboard shows. Deliberately not reassuring: a
 * protection statement that cannot name its own limit is marketing.
 */
export function captureStatement(w: CaptureWatch, windows: Array<{ id: string; sensitivity: WindowSensitivity }>): string {
  const live = anyLiveCapture(w);
  const secret = windows.filter((x) => x.sensitivity === "secret").length;
  const priv = windows.filter((x) => x.sensitivity === "private").length;
  const head = live
    ? `Capture active (${live.source}, ${live.surface})`
    : "No capture session detected";
  if (!secret && !priv) return `${head}. No private windows are open.`;
  const parts = [head];
  if (priv) parts.push(`${priv} private window(s) excluded from your captures and locked while capturing`);
  if (secret) parts.push(`${secret} secret window(s) also blanked`);
  parts.push("not hidden from recorders outside this app");
  return `${parts.join("; ")}.`;
}
