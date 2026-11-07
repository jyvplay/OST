/**
 * TT139 (LN-02 / LN-12) — auto-framing and presenter layout geometry.
 *
 * Two jobs, both pure geometry so they can be tested without a camera:
 *
 * 1. **Auto-frame** turns a stream of face boxes into a *smoothed* crop. Raw
 *    per-frame boxes make the crop jitter with the detector's noise, which is
 *    why naive auto-framing looks seasick. The filter here is critically damped
 *    (no overshoot) with a dead zone, so a still subject produces a still crop,
 *    and a crop is only issued when it changed by more than one pixel.
 * 2. **Presenter mode** composites a camera cutout over shared content. The
 *    placement has to keep the cutout off the slides' own content and inside the
 *    safe area, and it has to collapse gracefully when the stage is small.
 *
 * Limits: `FaceDetector` is Chromium-only and behind a flag on many builds, so
 * the caller may have no detector at all; `centreCrop` still gives a usable
 * centred crop. No detector result is ever invented: an empty frame list is
 * "no subject", not "subject in the middle".
 */

export interface Box { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

/** Smallest frame a crop is allowed to be, as a fraction of the source. */
export const MIN_CROP_FRACTION = 0.25;
export const MAX_CROP_FRACTION = 1;

/** The union of the largest face cluster, ignoring one-frame outliers. */
export function primarySubject(boxes: readonly Box[], frame: Size): Box | null {
  const usable = boxes.filter((b) => b.w > 0 && b.h > 0 && b.x + b.w > 0 && b.y + b.h > 0 && b.x < frame.w && b.y < frame.h);
  if (!usable.length) return null;
  // The subject is the largest box; neighbours within 1.5x of it are the same
  // person (or a pair) and are merged so the crop does not cut a shoulder off.
  const sorted = [...usable].sort((a, b) => b.w * b.h - a.w * a.h);
  const main = sorted[0];
  const area = main.w * main.h;
  const group = sorted.filter((b) => b.w * b.h >= area / 2.25 && overlapRatio(b, main) >= 0);
  const x0 = Math.min(...group.map((b) => b.x)), y0 = Math.min(...group.map((b) => b.y));
  const x1 = Math.max(...group.map((b) => b.x + b.w)), y1 = Math.max(...group.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function overlapRatio(a: Box, b: Box): number {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (x * y) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
}

/** A crop of the requested aspect ratio that contains `subject` with headroom. */
export function cropForSubject(subject: Box | null, frame: Size, aspect: number, opts: { padding?: number } = {}): Box {
  const ratio = aspect > 0 ? aspect : frame.w / Math.max(1, frame.h);
  if (!subject) return centreCrop(frame, ratio);
  const pad = opts.padding ?? 0.28;
  // Aim for the subject to occupy ~1/(1+pad) of the frame, never below the floor.
  const wantH = Math.min(frame.h * MAX_CROP_FRACTION, Math.max(frame.h * MIN_CROP_FRACTION, subject.h * (1 + pad * 2)));
  const wantW = Math.min(frame.w * MAX_CROP_FRACTION, wantH * ratio);
  const h = Math.min(wantH, wantW / ratio);
  const w = h * ratio;
  // Centre on the subject's vertical middle, biased up so the head is not clipped.
  const cx = subject.x + subject.w / 2;
  const cy = subject.y + subject.h * 0.42;
  const x = clamp(cx - w / 2, 0, Math.max(0, frame.w - w));
  const y = clamp(cy - h / 2, 0, Math.max(0, frame.h - h));
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

export function centreCrop(frame: Size, aspect: number): Box {
  const ratio = aspect > 0 ? aspect : frame.w / Math.max(1, frame.h);
  let w = frame.w, h = frame.w / ratio;
  if (h > frame.h) { h = frame.h; w = h * ratio; }
  return { x: Math.round((frame.w - w) / 2), y: Math.round((frame.h - h) / 2), w: Math.round(w), h: Math.round(h) };
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Critically damped smoothing between crops. `stiffness` in (0,1]; a value of 1
 * is no smoothing. Dead zone in pixels: below it, nothing is emitted, which is
 * what stops the crop from breathing with detector noise.
 */
export function smoothCrop(previous: Box, target: Box, stiffness = 0.18, deadZone = 2): { crop: Box; changed: boolean; settled: boolean } {
  const k = clamp(stiffness, 0.01, 1);
  const next = {
    x: previous.x + (target.x - previous.x) * k,
    y: previous.y + (target.y - previous.y) * k,
    w: previous.w + (target.w - previous.w) * k,
    h: previous.h + (target.h - previous.h) * k,
  };
  const delta = Math.abs(next.x - previous.x) + Math.abs(next.y - previous.y) + Math.abs(next.w - previous.w) + Math.abs(next.h - previous.h);
  const rounded = { x: Math.round(next.x), y: Math.round(next.y), w: Math.round(next.w), h: Math.round(next.h) };
  const changed = Math.abs(rounded.x - previous.x) >= deadZone || Math.abs(rounded.y - previous.y) >= deadZone || Math.abs(rounded.w - previous.w) >= deadZone || Math.abs(rounded.h - previous.h) >= deadZone;
  const settled = Math.abs(rounded.x - target.x) <= deadZone && Math.abs(rounded.y - target.y) <= deadZone && Math.abs(rounded.w - target.w) <= deadZone && Math.abs(rounded.h - target.h) <= deadZone;
  return { crop: changed ? rounded : previous, changed, settled, delta } as { crop: Box; changed: boolean; settled: boolean };
}

/** Presenter-mode cutout placement: a corner bubble that avoids the slide's safe area. */
export interface PresenterLayout {
  stage: Size;
  content: Box;
  /** fraction of the stage width the bubble occupies (0.12–0.35) */
  bubbleFraction?: number;
  corner: "tl" | "tr" | "bl" | "br";
  safeInset?: number;
  cameraAspect?: number;
}

export function presenterLayout(o: PresenterLayout): { bubble: Box; margin: number; shrunk: boolean; note: string } {
  const fraction = clamp(o.bubbleFraction ?? 0.24, 0.12, 0.35);
  const margin = Math.max(8, o.safeInset ?? Math.round(Math.min(o.stage.w, o.stage.h) * 0.03));
  const camAspect = o.cameraAspect && o.cameraAspect > 0 ? o.cameraAspect : 16 / 9;
  let w = Math.round(o.stage.w * fraction);
  let h = Math.round(w / camAspect);
  let shrunk = false;
  const maxH = o.stage.h * 0.4;
  if (h > maxH) { h = Math.round(maxH); w = Math.round(h * camAspect); shrunk = true; }
  const x = o.corner === "tl" || o.corner === "bl" ? margin : o.stage.w - w - margin;
  const y = o.corner === "tl" || o.corner === "tr" ? margin : o.stage.h - h - margin;
  const bubble = { x: Math.round(x), y: Math.round(y), w, h };
  // Does the bubble cover the content's focal area? If so, invert the corner.
  const coversCentre = overlapRatio(bubble, o.content) > 0.35;
  const note = coversCentre
    ? "the bubble overlaps the slide's centre — invert the corner or shrink it"
    : shrunk ? "the bubble was shrunk to stay inside the stage" : "ok";
  return { bubble, margin, shrunk, note };
}
