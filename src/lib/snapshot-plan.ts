/**
 * TT145 (WM-19) — an out-of-process render snapshot, planned around the three
 * things that can be true when you ask for one.
 *
 * The row wants a window's pixels captured without the page's own renderer
 * being the thing that draws them. A page has exactly one way to do that
 * (getDisplayMedia with `preferCurrentTab` or a chosen surface), and it has
 * **four** refusals that must be modelled instead of discovered:
 *
 *   1. **no gesture** — getDisplayMedia requires a user gesture; a background
 *      call rejects with NotAllowedError and there is no way around it.
 *   2. **the tab is hidden** — a background tab's capturer is throttled to
 *      ~1 Hz on some platforms and produces a still, not a stream.
 *   3. **the surface is not self-capturable** — moving a window off-screen,
 *      minifying it, or covering it produces black frames on several
 *      compositors, and the app cannot detect which compositor it is on.
 *   4. **DRM** — a protected surface is replaced by a placeholder frame, which is
 *      a legitimate refusal, not a bug to work around.
 *
 * So the plan answers: capture or refuse, at what size, at what frame budget, and
 * what the fallback is. The fallback is `html2canvas`-shaped work in the DOM,
 * which the engine explicitly labels as *not* out-of-process — that distinction is
 * the whole row, and blurring it is the negative-space shape "a snapshot is a
 * screenshot".
 */

export const MAX_CAPTURE_FPS = 30;
export const MAX_CAPTURE_PX = 3840 * 2160;
export const MIN_CAPTURE_PX = 64 * 64;

export type Mode = "current-tab" | "window" | "screen";

export interface Request {
  mode: Mode;
  /** True when the call happens inside a user gesture handler. */
  gesture: boolean;
  /** True when the tab is visible (not hidden, not minimised). */
  visible: boolean;
  /** True when the surface is DRM-protected, as reported by the media pipeline. */
  protected: boolean;
  /** CSS pixels of the window being captured. */
  css: { w: number; h: number };
  devicePixelRatio: number;
  /** Frames per second the caller wants; a still is 0. */
  fps: number;
}

export interface Plan {
  action: "capture" | "still" | "refuse";
  mode: Mode | null;
  /** Encoded pixels the capturer will produce. */
  px: number;
  /** Negotiated frames per second after the budget clamp. */
  fps: number;
  /** True only for a real out-of-process capture; false for the DOM fallback. */
  outOfProcess: boolean;
  sentence: string;
  fallback: string;
}

/**
 * Order of refusals: gesture, then hidden, then DRM, then geometry. A protected
 * surface with no gesture is a gesture problem first, because that is the one the
 * user can fix.
 */
export function planCapture(r: Request): Plan {
  const px = Math.round(r.css.w * r.devicePixelRatio) * Math.round(r.css.h * r.devicePixelRatio);
  if (!r.gesture) return { action: "refuse", mode: null, px, fps: 0, outOfProcess: false, sentence: "capture needs a click: a background getDisplayMedia call rejects with NotAllowedError, and there is no workaround", fallback: "ask the user for a gesture before offering capture at all" };
  if (!r.visible) return { action: "refuse", mode: null, px, fps: 0, outOfProcess: false, sentence: "the tab is hidden; a hidden capturer is throttled to roughly one frame a second, which is a still with extra steps", fallback: "capture while visible, or take a DOM snapshot of the saved state" };
  if (r.protected) return { action: "refuse", mode: null, px, fps: 0, outOfProcess: false, sentence: "this surface is DRM-protected; the compositor substitutes a placeholder frame and no page can prevent it", fallback: "exclude the surface and capture the rest of the window" };
  if (px < MIN_CAPTURE_PX) return { action: "refuse", mode: null, px, fps: 0, outOfProcess: false, sentence: `the window is ${px} px; below ${MIN_CAPTURE_PX} the capture has no usable content`, fallback: "grow the window first" };
  const shrink = px > MAX_CAPTURE_PX ? Math.sqrt(MAX_CAPTURE_PX / px) : 1;
  const fps = Math.max(0, Math.min(r.fps, MAX_CAPTURE_FPS));
  const clampedPx = Math.round(px * shrink * shrink);
  const sentence = r.fps === 0
    ? (shrink < 1 ? `a still at ${Math.round(r.css.w * r.devicePixelRatio * shrink)}×${Math.round(r.css.h * r.devicePixelRatio * shrink)} (downscaled from ${px} px to stay under the 8 MP budget)` : `a still at ${px} px`)
    : `${fps} fps at ${clampedPx} px${shrink < 1 ? ` (downscaled from ${px} px)` : ""}`;
  return { action: r.fps === 0 ? "still" : "capture", mode: r.mode, px: clampedPx, fps, outOfProcess: true, sentence, fallback: "if the compositor returns black frames, fall back to a DOM snapshot and label it as such" };
}

/**
 * Asking whether a frame is actually a picture. Several compositors hand back an
 * all-black frame instead of an error; a page cannot tell black from a dark app
 * by eye, but it can by sampling. `sample` takes the luma of a grid of pixels and
 * reports the fraction that is non-black — a capture of a dark theme is not the
 * same as a failed capture.
 */
export function frameQuality(samples: readonly number[]): { ok: boolean; blackFraction: number; sentence: string } {
  if (!samples.length) throw new Error("frameQuality needs at least one sample");
  const black = samples.filter((v) => v < 8).length / samples.length;
  const ok = black < 0.995;
  return { ok, blackFraction: black, sentence: ok ? `${Math.round((1 - black) * 100)} % of sampled pixels are not black` : "the frame is entirely black: this is the placeholder some compositors return, not a dark window" };
}

/**
 * The DOM fallback, described honestly. It re-renders the tree into a canvas, so
 * it cannot include a cross-origin iframe, a video's current frame in some
 * browsers, or anything outside the document — and it *is* in-process, which is
 * the one claim the row must not make.
 */
export const DOM_FALLBACK_LIMITS = [
  "in-process: the page draws its own pixels, which is what the row explicitly excludes",
  "cross-origin iframes and some media surfaces render blank",
  "web fonts must be embedded or the text reflows",
  "shadows, filters and backdrop blur are approximations, not the compositor's output",
] as const;

/** What the UI may say about the capture path it took. */
export function provenance(p: Plan, usedFallback: boolean): string {
  if (p.action === "refuse") return "not captured";
  return usedFallback ? "DOM snapshot (in-process; not an out-of-process capture)" : `out-of-process ${p.mode} capture, ${p.sentence}`;
}
