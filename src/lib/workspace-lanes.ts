/**
 * TT145 (WM-06) — the external-app broker, decided as four lanes.
 *
 * The row (WM-06, tier B) is about getting a *third-party* application into this
 * desktop's window model. A page cannot embed another application it does not
 * control, so the broker's real job is to pick the honest lane and refuse to
 * pretend a weaker one is a stronger one:
 *
 *   S1 **embed**   — an iframe of a *cooperative* origin. Requires the target to
 *                    send no `X-Frame-Options` denial and no CSP `frame-ancestors`
 *                    that excludes us. A page cannot detect either before the
 *                    frame loads; it can only detect the *failure* afterwards, so
 *                    the lane is "try, then verify within a budget, then fall
 *                    through" — and the fallthrough is part of the plan.
 *   S2 **split**   — side-by-side: our window and *the user's own* browser window,
 *                    positioned by the user. The app cannot place another
 *                    application's window; it can only make its own narrow.
 *   S3 **handoff** — a deep link the OS opens in the real application. This is the
 *                    only lane where the other app genuinely runs, and the app
 *                    loses all visibility of it.
 *   S4 **PiP**     — this app's own window in a picture-in-picture frame. It does
 *                    not bring any other app in; it is listed because users ask
 *                    for it in the same breath.
 *
 * The mechanism that makes this an engine rather than a menu: the *probe budget*.
 * An embed attempt that has not painted within its budget is treated as blocked,
 * and the same origin is remembered as blocked for the session so the next attempt
 * starts at lane S2 instead of paying the timeout again.
 */

export type Lane = "S1" | "S2" | "S3" | "S4";
export const LANES: Lane[] = ["S1", "S2", "S3", "S4"];

export interface Attempt {
  origin: string;
  lane: Lane;
  /** Epoch ms the attempt started. */
  at: number;
  /** Observed outcome; null while the attempt is in flight. */
  outcome: "painted" | "blocked" | "timeout" | null;
}

export interface Broker { blocked: Set<string>; attempts: Attempt[] }

export const emptyBroker = (): Broker => ({ blocked: new Set(), attempts: [] });

/** Probe budget by lane; S3 and S4 need no probe because they do not load a foreign frame. */
export function probeBudgetMs(lane: Lane): number {
  return lane === "S1" ? 4000 : 0;
}

export interface Decision {
  lane: Lane;
  why: string;
  /** True when this lane costs a probe before it can be trusted. */
  needsProbe: boolean;
  fallback: Lane | null;
}

/**
 * Picks the lane. A blocked origin is remembered and never probed twice in one
 * session, which is the difference between a desktop that stalls for four seconds
 * per launch and one that does not.
 */
export function decide(b: Broker, request: { origin: string; userHasApp: boolean; preferSplit: boolean }): Decision {
  let origin = "";
  try { origin = new URL(request.origin).origin; } catch { return { lane: "S3", why: "the origin is unparseable, so the only honest lane is a deep link", needsProbe: false, fallback: null }; }
  // A framing refusal falls through to a deep link whether or not the application is
  // already running: splitting our own window does not make a refused frame load.
  if (b.blocked.has(origin)) return { lane: "S3", why: `${origin} refused framing earlier in this session, so it is not probed again and the OS opens it instead`, needsProbe: false, fallback: null };
  if (request.preferSplit) return { lane: "S2", why: "side-by-side was requested: our window narrows, and the other application keeps its own frame", needsProbe: false, fallback: "S3" };
  if (!request.userHasApp) return { lane: "S1", why: `try an embed of ${origin}: a cooperative origin paints, and the probe budget bounds the attempt`, needsProbe: true, fallback: "S3" };
  return { lane: "S4", why: "the application is already running outside this desktop, so the useful lane is this app's own window in picture-in-picture", needsProbe: false, fallback: null };
}

/**
 * Records the probe's outcome. A timeout is remembered as blocked *and* reported
 * differently from an explicit denial: one is a refusal, the other is silence, and
 * the user's next step is different in each case.
 */
export function observe(b: Broker, a: Attempt, outcome: "painted" | "blocked" | "timeout"): { broker: Broker; lane: Lane; sentence: string } {
  const blocked = new Set<string>(b.blocked);
  const wasBlocked = blocked.has(a.origin);
  if (outcome !== "painted") blocked.add(a.origin);
  const attempts = [...b.attempts, { ...a, outcome }];
  // A late "painted" for an origin already refused this session does not un-block it:
  // the refusal is a fact about the origin, and the memory exists so the desktop does
  // not pay the probe budget again.
  const accepted = outcome === "painted" && !wasBlocked;
  return {
    broker: { blocked, attempts },
    lane: accepted ? a.lane : "S3",
    sentence: outcome === "painted"
      ? wasBlocked
        ? `${a.origin} painted late, but it refused framing earlier in this session; the refusal stands for the session`
        : `${a.origin} painted inside the embed; the frame is cooperative`
      : outcome === "blocked"
        ? `${a.origin} refused framing (X-Frame-Options or CSP frame-ancestors); the desktop falls back to a deep link and will not retry this session`
        : `${a.origin} did not paint within ${probeBudgetMs(a.lane)} ms; silence is not consent, so it is treated as blocked`,
  };
}

/**
 * What lane S2 may honestly do: narrow *our* window. It cannot move the other
 * application's window, and the returned instruction says so rather than yielding a
 * fake coordinates object.
 */
export function splitInstruction(ourWidth: number, screenWidth: number): { width: number; instruction: string } {
  const width = Math.max(320, Math.min(ourWidth, Math.round(screenWidth / 2)));
  return {
    width,
    instruction: `this window narrows to ${width} px; the other application is placed by you, because a page cannot move another window`,
  };
}

/** The four-lane matrix, as rows the UI prints without extra prose. */
export function matrix(): { lane: Lane; name: string; bringsOtherApp: boolean; honest: string }[] {
  return [
    { lane: "S1", name: "embed", bringsOtherApp: true, honest: "works only for origins that allow framing; verified after the fact" },
    { lane: "S2", name: "split", bringsOtherApp: true, honest: "the other app stays in its own window; we only make room" },
    { lane: "S3", name: "handoff", bringsOtherApp: true, honest: "the OS opens it; this desktop loses all visibility" },
    { lane: "S4", name: "picture-in-picture", bringsOtherApp: false, honest: "our own window floats; nothing foreign is brought in" },
  ];
}

export const LIMITS = [
  "a page cannot embed an origin that denies framing, and cannot know that before trying",
  "a page cannot enumerate or move another application's windows",
  "a handoff gives up all visibility: no state comes back",
  "picture-in-picture brings nothing foreign into the desktop",
] as const;
