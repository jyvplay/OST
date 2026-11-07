/**
 * TT139 (SC-06) — what a screen-share guard can and cannot do on the web.
 *
 * There is no `FLAG_SECURE`. A page cannot stop the OS, a screen recorder or a
 * second device from seeing its pixels. Anything that claims otherwise is a
 * lie, so this module does the three things that *are* possible and labels each
 * with its strength:
 *
 *   - **cover** (strong, local): a private window hides its own pixels when the
 *     tab loses visibility or when a capture track is believed active. The
 *     window re-locks and its contents are blurred with a "hidden while sharing"
 *     panel. This works against a casual over-the-shoulder capture, not against
 *     a root-level compositor.
 *   - **deter** (weak): a watermark carrying the session id and time makes an
 *     exfiltrated frame attributable. It is a deterrent, not a control.
 *   - **detect** (weak, remote): `getDisplayMedia` exposes the shared surface's
 *     label and whether audio/video tracks are live *to the sharer only*. A page
 *     being captured by someone else learns nothing.
 *
 * The threat model is written down: adversary = another user on the same screen,
 * or a recorder inside the same browser. Adversary the guard does NOT stop = OS
 * screen recorder, kernel-level capture, camera pointed at the display.
 */

export type GuardLevel = "off" | "cover" | "cover+watermark";

export interface CaptureContext {
  /** document.visibilityState !== "visible" */
  tabHidden: boolean;
  /** the *local* user is sharing a screen (from their own getDisplayMedia) */
  selfSharing: boolean;
  /** a shared track reported it is still live */
  shareTrackLive: boolean;
  /** the window lost focus for longer than the grace period */
  unfocusedMs: number;
  /** recent clipboard-level indicator that a capture tool is co-resident (best effort) */
  captureToolSuspected: boolean;
}

export interface GuardDecision {
  hide: boolean;
  level: GuardLevel;
  watermark: string | null;
  /** one sentence, shown in the window's own status strip */
  reason: string;
}

export const UNFOCUS_GRACE_MS = 1500;

export function guardDecision(level: GuardLevel, ctx: CaptureContext, session: { id: string; now: number }): GuardDecision {
  if (level === "off") return { hide: false, level, watermark: null, reason: "" };
  const triggers: string[] = [];
  if (ctx.tabHidden) triggers.push("the tab is not visible");
  if (ctx.selfSharing && ctx.shareTrackLive) triggers.push("you are sharing a screen");
  if (ctx.unfocusedMs >= UNFOCUS_GRACE_MS) triggers.push(`the window has been unfocused for ${(ctx.unfocusedMs / 1000).toFixed(1)} s`);
  if (ctx.captureToolSuspected) triggers.push("a capture tool looks present");
  const hide = triggers.length > 0;
  const watermark = level === "cover+watermark" || hide
    ? `${session.id.slice(0, 8)} · ${new Date(session.now).toISOString().replace("T", " ").slice(0, 19)}Z`
    : null;
  return { hide, level, watermark, reason: hide ? `Contents hidden because ${triggers.join(" and ")}.` : "" };
}

/** The only sentence that may be used to describe the guarantee. */
export const GUARD_DISCLOSURE = "Hiding prevents someone glancing at your screen. It cannot stop an operating-system screen recorder or a camera.";

/** What a page learns about another party's capture: nothing. Stated as data. */
export function captureKnowledge(): { canSeeRemoteCapture: false; canSeeOwnCapture: true; note: string } {
  return { canSeeRemoteCapture: false, canSeeOwnCapture: true, note: "getDisplayMedia only reports the sharer's own tracks; a page cannot detect that it is being recorded by another application." };
}

/**
 * A watermark tile pattern for the overlay: repeated text at low opacity, placed
 * so that cropping one corner still leaves readable marks. Pure geometry so the
 * canvas draw and the test agree.
 */
export function watermarkTiles(width: number, height: number, step = 220): { x: number; y: number; rotate: number }[] {
  if (width <= 0 || height <= 0) return [];
  const tiles: { x: number; y: number; rotate: number }[] = [];
  const maxTiles = 96;
  for (let y = step / 2; y < height && tiles.length < maxTiles; y += step) {
    for (let x = step / 2; x < width && tiles.length < maxTiles; x += step) tiles.push({ x: Math.round(x), y: Math.round(y), rotate: -20 });
  }
  return tiles;
}
