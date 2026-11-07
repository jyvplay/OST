/**
 * TT145 (WM-11) — always-on-top mini window: placement for a window the page
 * does not own.
 *
 * `documentPictureInPicture.requestWindow()` gives a *separate browser window* that
 * sits above the tab (on platforms that implement it). The page can size it once,
 * at creation, and cannot move it afterwards, cannot read back where the user moved
 * it, and cannot force it above other *applications* — only above its own tab. Every
 * one of those is a real constraint that turns "always on top" into a placement
 * problem rather than a flag:
 *
 *   · **size is chosen once.** `requestWindow({width, height})` is the only sizing
 *     call. A later resize is a user action the page is told about, never one it
 *     initiates.
 *   · **position is unknown.** There is no `screenX` on the PiP window that is
 *     trustworthy across platforms, so the engine never reasons about position; it
 *     reasons about the *aspect* it asked for and the *safe area* it must not exceed.
 *   · **styles must be adopted.** A new document has no styles; the engine computes
 *     the byte budget for the stylesheet clone so the caller can refuse a clone that
 *     would exceed the frame budget, which is the step the demos skip.
 *   · **the fallback is in-page.** Where the API is absent, the "mini window" is a
 *     floating panel, which is *not* always on top of anything. The engine returns
 *     that distinction as a field, not as prose, so a test can assert it.
 */

export const MIN_W = 240;
export const MIN_H = 160;
export const MAX_W = 1200;
export const MAX_H = 900;
export const STYLE_BYTE_BUDGET = 640 * 1024;

export type Surface = "pip" | "floating";

export interface Placement {
  width: number;
  height: number;
  /** CSS to clone into the new document; the caller measures it, this budgets it. */
  styleBytes: number;
  ok: boolean;
  surface: Surface;
  /** True only for a real PiP window; a floating panel is never above another app. */
  aboveOtherApps: false;
  sentence: string;
}

/**
 * Clamps a requested size to the usable range *and* to the aspect the content
 * wants. A mini player is 16:9 or 4:3; asking for a 240×900 strip produces a
 * window whose controls overlap the video.
 */
export function place(request: { w: number; h: number }, opts: { pip: boolean; styleBytes: number; aspect?: number }): Placement {
  const aspect = opts.aspect ?? 16 / 9;
  let w = Math.round(Math.min(MAX_W, Math.max(MIN_W, request.w)));
  let h = Math.round(Math.min(MAX_H, Math.max(MIN_H, request.h)));
  // Preserve the content aspect by fitting inside the clamped box.
  if (w / h > aspect) w = Math.round(h * aspect);
  else h = Math.round(w / aspect);
  w = Math.round(Math.min(MAX_W, Math.max(MIN_W, w)));
  h = Math.round(Math.min(MAX_H, Math.max(MIN_H, h)));
  const overweight = opts.styleBytes > STYLE_BYTE_BUDGET;
  return {
    width: w, height: h, styleBytes: opts.styleBytes, ok: !overweight,
    surface: opts.pip ? "pip" : "floating",
    aboveOtherApps: false,
    sentence: overweight
      ? `refused: ${(opts.styleBytes / 1024).toFixed(0)} KB of styles exceeds the ${STYLE_BYTE_BUDGET / 1024} KB clone budget; the window would paint unstyled and then reflow`
      : opts.pip
        ? `${w}×${h} (${aspect.toFixed(2)}:1) in a document picture-in-picture window; it floats above this tab, not above other applications`
        : `${w}×${h} as an in-page panel: this browser has no document picture-in-picture, so the panel is not always on top of anything, including other tabs`,
  };
}

/**
 * What must travel with the content. A PiP document starts empty, so a renderer
 * that portals a component into it must also carry the stylesheets; this returns
 * the ordered list and why each one matters, and refuses an empty list because an
 * unstyled clone is the failure this whole function exists to prevent.
 */
export function adoptionPlan(input: { sheets: { href: string | null; bytes: number }[]; inline: { bytes: number }[] }): { totalBytes: number; order: string[]; ok: boolean; sentence: string } {
  const totalBytes = input.sheets.reduce((n, s) => n + s.bytes, 0) + input.inline.reduce((n, s) => n + s.bytes, 0);
  if (!input.sheets.length && !input.inline.length) return { totalBytes: 0, order: [], ok: false, sentence: "nothing to adopt: a new document with no styles renders unstyled content" };
  return {
    totalBytes,
    order: ["inline layers first (they have no network cost)", ...input.sheets.map((s) => s.href ?? "(inline sheet with no href)")],
    ok: totalBytes <= STYLE_BYTE_BUDGET,
    sentence: totalBytes <= STYLE_BYTE_BUDGET
      ? `${(totalBytes / 1024).toFixed(0)} KB of CSS adopted in ${input.sheets.length + input.inline.length} documents`
      : `${(totalBytes / 1024).toFixed(0)} KB exceeds the ${STYLE_BYTE_BUDGET / 1024} KB budget: adopting it would stall the new window's first paint`,
  };
}

/**
 * When the mini window must close itself. Every branch is a condition the page is
 * actually told about — the page is never told that the *user* closed it except
 * through the `pagehide` event, and that is the one that matters.
 */
export type CloseReason = "user-closed" | "content-moved-back" | "tab-hidden" | "api-lost" | "still-open";

export function closeBehaviour(reason: CloseReason): { returnsToDesktop: boolean; sentence: string } {
  switch (reason) {
    case "user-closed": return { returnsToDesktop: true, sentence: "the window was closed: the content returns to the desktop, it is not destroyed" };
    case "content-moved-back": return { returnsToDesktop: true, sentence: "the content was moved back to the tab; the window closes" };
    case "tab-hidden": return { returnsToDesktop: false, sentence: "the tab was hidden: a picture-in-picture window outlives its tab on some platforms and is closed deliberately instead" };
    case "api-lost": return { returnsToDesktop: true, sentence: "the document picture-in-picture API became unavailable; the content returns to an in-page panel" };
    case "still-open": return { returnsToDesktop: false, sentence: "open" };
  }
}

export const LIMITS = [
  "a page cannot raise its own window above other applications, only above its own tab",
  "size is chosen at creation; later resizing is the user's, and there is no programmatic move",
  "the platform does not report the window's screen position, so no layout may depend on it",
  "a PiP document is empty: every stylesheet and font must be adopted explicitly",
  "without the API the fallback is an in-page floating panel, which is not always on top",
] as const;
